import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import {
  composeApplication,
  MAX_ACTIVE_SESSIONS,
  ManagedRelay,
  resolveApprovedServiceEndpoint,
  resolvePalabraWebSocketEndpoint,
} from "../src/composition.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import {
  canonicalJsonSha256,
  type ApprovedSessionProcessingProfile,
  type ContractEvidenceReference,
  type ProcessingService,
} from "../src/core/processing-profile.js";
import type {
  EventCursor,
  GuardedDuplexRelay,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
  TranslationMode,
  TranslationProviderId,
} from "../src/core/types.js";
import { RelaySessionError } from "../src/core/relay.js";
import { operatorStartupUrl } from "../src/server/main.js";

const rootKey = Buffer.alloc(32, 9).toString("base64");
const policyReference: ContractEvidenceReference = {
  id: "policy-001",
  revision: "2026-08-09",
  sha256: "a".repeat(64),
  approvedBy: "compliance@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
};
const unverified = {
  status: "unverified" as const,
  reason: "POC external assurance has not been independently verified.",
  acceptanceImpact: "NOT_RUN" as const,
};

function temporaryDirectory(name: string): string {
  return resolve(process.cwd(), "work", "tmp", "composition-tests", name + "-" + randomUUID());
}

function operatorHeaders(token: string): Readonly<{ authorization: string }> {
  return { authorization: "Bearer " + token };
}

function serviceDataCategories(
  role: ProcessingService["role"],
  provider: ProcessingService["provider"],
): ProcessingService["dataCategories"] {
  switch (role) {
    case "speech_to_speech":
      return provider === "palabra"
        ? ["canonical_audio", "source_language", "target_language"]
        : ["canonical_audio", "target_language"];
    case "transcription":
      return ["canonical_audio", "source_language", "source_terms", "aliases"];
    case "text_translation":
      return ["source_transcript", "source_language", "target_language", "opaque_placeholders"];
    case "tts":
      return ["authorized_target_text"];
  }
}

function service(
  id: string,
  role: ProcessingService["role"],
  provider: ProcessingService["provider"],
  category: ProcessingService["category"],
  origin: string,
  pathTemplate: string,
  model: ProcessingService["model"],
  voice: ProcessingService["voice"],
): ProcessingService {
  return {
    id,
    role,
    provider,
    category,
    dataCategories: serviceDataCategories(role, provider),
    endpoint: { origin, pathTemplate },
    model,
    voice,
    region: unverified,
    trainingUse: unverified,
    serviceRetention: unverified,
    dpa: unverified,
  };
}

function approvedProfile(
  provider: TranslationProviderId,
  allowedModes: readonly TranslationMode[],
  defaultMode: TranslationMode,
  fallbackKind: ApprovedSessionProcessingProfile["fallback"]["kind"] = "same_route_fail_open",
): ApprovedSessionProcessingProfile {
  const services: readonly ProcessingService[] = provider === "openai_controlled"
    ? [
      service(
        "openai-transcription", "transcription", "openai", "managed_transcription",
        "https://api.openai.example", "/v1/realtime", { kind: "named", value: "gpt-live-transcribe" },
        { kind: "not_applicable" },
      ),
      service(
        "openai-text", "text_translation", "openai", "managed_text_translation",
        "https://api.openai.example", "/v1/responses", { kind: "named", value: "gpt-4.1-mini" },
        { kind: "not_applicable" },
      ),
      service(
        "openai-tts", "tts", "openai", "managed_tts",
        "https://api.openai.example", "/v1/audio/speech", { kind: "named", value: "gpt-4o-mini-tts" },
        { kind: "named", value: "alloy" },
      ),
    ]
    : provider === "openai_native"
      ? [service(
        "openai-native", "speech_to_speech", "openai", "managed_realtime_speech_translation",
        "https://api.openai.com", "/v1/realtime/translations", { kind: "named", value: "gpt-realtime-translate" },
        { kind: "provider_managed", reason: "OpenAI selects the translation voice." },
      )]
      : [service(
        "palabra-speech", "speech_to_speech", "palabra", "managed_realtime_speech_translation",
        "https://streaming.palabra.example", "/streaming-api/{hash}/v1/speech-to-speech/stream", { kind: "vendor_managed", reason: "Palabra owns model selection." },
        { kind: "provider_managed", reason: "Palabra owns voice selection." },
      )];
  const body = {
    schemaVersion: 1 as const,
    kind: "approved_session_processing_profile" as const,
    id: "manufacturing-poc",
    version: "2026-08-09",
    operationScope: "poc" as const,
    translation: {
      provider,
      allowedModes,
      defaultMode,
      behaviorVersion: 1 as const,
    },
    services,
    glossaryEgress: provider === "openai_controlled"
      ? {
        harnessPinnedGlossary: "local_pinned" as const,
        stages: [
          { role: "transcription" as const, fields: ["source_terms", "aliases"] as const },
          { role: "text_translation" as const, fields: ["opaque_placeholders"] as const },
          { role: "tts" as const, fields: ["authorized_target_text"] as const },
        ],
        providerAccountGlossary: unverified,
      }
      : {
        harnessPinnedGlossary: "disallowed" as const,
        stages: [],
        providerAccountGlossary: unverified,
      },
    fallback: { kind: fallbackKind, approval: policyReference },
    evidence: {
      storage: "local_encrypted_file" as const,
      encryption: "aes_256_gcm" as const,
      tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const,
      providerEvents: "final_only" as const,
      provisionalEvents: "live_only" as const,
      browserEvidenceRefs: "redacted" as const,
      plaintextExport: "explicit_owner_acknowledgement" as const,
      minimumFreeBytes: "1",
    },
    retentionPolicy: {
      policyRef: policyReference,
      mode: "scheduled_delete" as const,
      defaultDays: 14 as const,
      maximumDays: 30 as const,
      verificationMaximumHours: 24 as const,
    },
    consentPolicy: {
      ...policyReference,
      id: "consent-policy-001",
      noticeVersion: "manufacturing-notice-v1",
      recordingRequired: true as const,
      processingRequired: true as const,
      withdrawalTerminatesSession: true as const,
    },
    approval: {
      approvalId: "approval-001",
      approvedBy: "compliance@example.test",
      approvedAtUtc: "2026-08-09T00:00:00.000Z",
    },
  } satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;
  return { ...body, sha256: canonicalJsonSha256(body) };
}

interface DeploymentFixture {
  readonly config: AppConfig;
  readonly root: string;
  cleanup(): Promise<void>;
}

async function deploymentFixture(
  profile: ApprovedSessionProcessingProfile,
  environment: NodeJS.ProcessEnv = {},
): Promise<DeploymentFixture> {
  const root = temporaryDirectory("profile");
  const profilePath = resolve(root, "approved-processing-profile.json");
  await mkdir(root, { recursive: true });
  await writeFile(profilePath, JSON.stringify(profile, null, 2), "utf8");
  const config = loadConfig({
    HOST: "127.0.0.1",
    PUBLIC_BASE_URL: "http://localhost:4207",
    ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY: "true",
    PROCESSING_PROFILE_PATH: profilePath,
    PROCESSING_PROFILE_SHA256: profile.sha256,
    DEPLOYMENT_BUILD_SHA256: "c".repeat(64),
    OPERATOR_TOKEN: "operator-" + "o".repeat(32),
    RETENTION_OWNER_ID: "retention-owner",
    RETENTION_OWNER_TOKEN: "owner-" + "a".repeat(32),
    EVIDENCE_REVIEWER_ID: "evidence-reviewer",
    EVIDENCE_REVIEWER_TOKEN: "reviewer-" + "b".repeat(32),
    EVIDENCE_ARCHIVE_DIRECTORY: "data/evidence/archive",
    EVIDENCE_KEY_DIRECTORY: "data/evidence/keys",
    EVIDENCE_EXPORT_DIRECTORY: "data/evidence/exports",
    EVIDENCE_RECEIPT_DIRECTORY: "data/evidence/receipts",
    EVIDENCE_ROOT_KEY_BASE64: rootKey,
    GLOSSARY_DIRECTORY: "data/glossaries",
    LOG_LEVEL: "silent",
    ...environment,
  }, root);
  return { config, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

class IdleSubscriberRelay implements GuardedDuplexRelay {
  readonly #subscribers = new Set<() => void>();
  #markSubscriptionStarted!: () => void;
  readonly subscriptionStarted = new Promise<void>((resolveSubscription) => {
    this.#markSubscriptionStarted = resolveSubscription;
  });
  receivedSignal: AbortSignal | undefined;

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  async open(_spec: SessionSpec): Promise<SessionSnapshot> {
    throw new Error("IdleSubscriberRelay does not open sessions");
  }

  snapshot(_sessionId: string): SessionSnapshot {
    throw new Error("IdleSubscriberRelay does not expose snapshots");
  }

  async command(_sessionId: string, _command: RelayCommand): Promise<void> {
    throw new Error("IdleSubscriberRelay does not accept commands");
  }

  events(
    _sessionId: string,
    _after: EventCursor = 0,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    this.receivedSignal = signal;
    return this.#idleEvents(signal);
  }

  releaseIdleSubscribers(): void {
    for (const subscriber of this.#subscribers) subscriber();
  }

  async *#idleEvents(signal?: AbortSignal): AsyncIterable<SessionEvent> {
    let wake!: () => void;
    const idle = new Promise<void>((resolveIdle) => { wake = resolveIdle; });
    const onAbort = (): void => wake();
    this.#subscribers.add(onAbort);
    this.#markSubscriptionStarted();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      await idle;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#subscribers.delete(onAbort);
    }
  }
}

interface TerminalLifecycleSession {
  readonly sessionId: string;
  readonly events: SessionEvent[];
  readonly subscribers: Set<TerminalLifecycleSubscriber>;
  status: SessionStatus;
  cursor: EventCursor;
}

interface TerminalLifecycleSubscriber {
  wake(): void;
}

class TerminalLifecycleRelay implements GuardedDuplexRelay {
  readonly endSessionIds: string[] = [];
  readonly terminalObserverSessionIds: string[] = [];
  #sessions = new Map<string, TerminalLifecycleSession>();
  #nextSessionId = 0;
  #openFailures = 0;
  readonly #endFailures = new Map<string, number>();
  #endCommandsHeld = false;
  #endCommandGate: Promise<void> = Promise.resolve();
  #releaseEndCommandGate: (() => void) | undefined;
  #markEndCommandStarted: (() => void) | undefined;
  endCommandStarted: Promise<void> = Promise.resolve();

  get subscriberCount(): number {
    let count = 0;
    for (const session of this.#sessions.values()) count += session.subscribers.size;
    return count;
  }

  holdEndCommands(): void {
    this.#endCommandsHeld = true;
    this.endCommandStarted = new Promise<void>((resolveStart) => {
      this.#markEndCommandStarted = resolveStart;
    });
    this.#endCommandGate = new Promise<void>((release) => {
      this.#releaseEndCommandGate = release;
    });
  }

  releaseEndCommands(): void {
    this.#releaseEndCommandGate?.();
    this.#releaseEndCommandGate = undefined;
  }

  rejectNextEnd(sessionId: string): void {
    this.#endFailures.set(sessionId, (this.#endFailures.get(sessionId) ?? 0) + 1);
  }

  rejectNextOpen(): void {
    this.#openFailures += 1;
  }

  async open(_spec: SessionSpec): Promise<SessionSnapshot> {
    if (this.#openFailures > 0) {
      this.#openFailures -= 1;
      throw new Error("Delegate open failed");
    }
    const sessionId = "terminal-session-" + (++this.#nextSessionId);
    const session: TerminalLifecycleSession = {
      sessionId,
      events: [],
      subscribers: new Set(),
      status: "waiting",
      cursor: 0,
    };
    this.#sessions.set(sessionId, session);
    return this.#snapshot(session);
  }

  snapshot(sessionId: string): SessionSnapshot {
    return this.#snapshot(this.#session(sessionId));
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    const session = this.#session(sessionId);
    if (command.type === "participant_consent_withdrawal") {
      this.#closeFromWithdrawal(session);
      return;
    }
    if (command.type !== "end") return;
    this.endSessionIds.push(sessionId);
    const failures = this.#endFailures.get(sessionId) ?? 0;
    if (failures > 0) {
      this.#endFailures.set(sessionId, failures - 1);
      throw new Error("Delegate end failed for " + sessionId);
    }
    if (!this.#endCommandsHeld) return;
    this.#markEndCommandStarted?.();
    this.#markEndCommandStarted = undefined;
    await this.#endCommandGate;
  }

  events(
    sessionId: string,
    after: EventCursor = 0,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    this.terminalObserverSessionIds.push(sessionId);
    return this.#eventStream(this.#session(sessionId), after, signal);
  }

  closeInternally(sessionId: string): void {
    const session = this.#session(sessionId);
    if (session.status === "closed") return;
    session.status = "closed";
    this.#publish(session, {
      type: "session_closed",
      cursor: session.cursor + 1,
      sessionId,
      timestampMonoMs: session.cursor + 1,
      lane: null,
      generation: null,
      reason: "translation_prepare_failed",
      finalization: {
        status: "FINALIZATION_FAILED",
        sessionId,
        processingManifestSha256: "f".repeat(64),
        failureCode: "seal_write_failed",
        recovery: "quarantine_delete_rerun",
      },
    });
  }

  #closeFromWithdrawal(session: TerminalLifecycleSession): void {
    if (session.status === "closed") return;
    const sessionId = session.sessionId;
    this.#publish(session, {
      type: "participant_consent_withdrawal",
      cursor: session.cursor + 1,
      sessionId,
      timestampMonoMs: session.cursor + 1,
      lane: null,
      generation: null,
      side: "A",
      consentId: "consent-" + sessionId,
      withdrawalId: "withdrawal-" + sessionId,
      withdrawnAtMonoMs: session.cursor + 1,
      terminal: true,
    });
    session.status = "closed";
    this.#publish(session, {
      type: "session_state",
      cursor: session.cursor + 1,
      sessionId,
      timestampMonoMs: session.cursor + 1,
      lane: null,
      generation: null,
      previousStatus: "waiting",
      status: "closed",
    });
  }

  #publish(session: TerminalLifecycleSession, event: SessionEvent): void {
    session.cursor = event.cursor;
    session.events.push(event);
    for (const subscriber of session.subscribers) subscriber.wake();
  }

  async *#eventStream(
    session: TerminalLifecycleSession,
    after: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    let wakePending: (() => void) | undefined;
    const subscriber: TerminalLifecycleSubscriber = {
      wake: () => wakePending?.(),
    };
    const onAbort = (): void => subscriber.wake();
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });
    session.subscribers.add(subscriber);
    let cursor = after;
    try {
      while (!signal?.aborted) {
        const event = session.events.find((candidate) => candidate.cursor > cursor);
        if (event !== undefined) {
          cursor = event.cursor;
          yield event;
          continue;
        }
        if (session.status === "closed") return;
        await new Promise<void>((resolveWake) => {
          wakePending = resolveWake;
        });
        wakePending = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      session.subscribers.delete(subscriber);
    }
  }

  #session(sessionId: string): TerminalLifecycleSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error("Unknown terminal test session " + sessionId);
    return session;
  }

  #snapshot(session: TerminalLifecycleSession): SessionSnapshot {
    return {
      sessionId: session.sessionId,
      status: session.status,
      eventCursor: session.cursor,
    } as SessionSnapshot;
  }
}

class DelayedOpenRelay extends TerminalLifecycleRelay {
  readonly openStarted: Promise<void>;
  #markOpenStarted!: () => void;
  #openGate: Promise<void>;
  #releaseOpenGate!: () => void;

  constructor() {
    super();
    this.openStarted = new Promise<void>((resolveStarted) => {
      this.#markOpenStarted = resolveStarted;
    });
    this.#openGate = new Promise<void>((resolveOpen) => {
      this.#releaseOpenGate = resolveOpen;
    });
  }

  override async open(spec: SessionSpec): Promise<SessionSnapshot> {
    this.#markOpenStarted();
    await this.#openGate;
    return super.open(spec);
  }

  releaseOpen(): void {
    this.#releaseOpenGate();
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
}

async function resolvesPromptly<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Idle event iterator did not resolve after abort")), 250);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("production composition", () => {
  it("cancels idle managed event subscriptions without a later session event", async () => {
    const delegate = new IdleSubscriberRelay();
    const relay = new ManagedRelay(delegate);
    const controller = new AbortController();
    const iterator = relay.events("idle-session", 0, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    try {
      await delegate.subscriptionStarted;
      assert.equal(delegate.receivedSignal, controller.signal);
      assert.equal(delegate.subscriberCount, 1);
      controller.abort();
      assert.equal((await resolvesPromptly(next)).done, true);
      assert.equal(delegate.subscriberCount, 0);
    } finally {
      delegate.releaseIdleSubscribers();
      await next.catch(() => undefined);
      await iterator.return?.();
    }
  });

  it("does not leak an active-session slot when the delegate open fails", async () => {
    const delegate = new TerminalLifecycleRelay();
    delegate.rejectNextOpen();
    const relay = new ManagedRelay(delegate);

    await assert.rejects(
      () => relay.open({} as SessionSpec),
      /Delegate open failed/u,
    );
    for (let index = 0; index < MAX_ACTIVE_SESSIONS; index += 1) {
      await relay.open({} as SessionSpec);
    }
    await assert.rejects(
      () => relay.open({} as SessionSpec),
      (error: unknown) =>
        error instanceof RelaySessionError &&
        error.code === "invalid_command" &&
        error.message === `Managed relay active session limit (${MAX_ACTIVE_SESSIONS}) reached`,
    );
    await relay.close();
  });

  it("ends a delayed open that completes after shutdown starts", async () => {
    const delegate = new DelayedOpenRelay();
    const relay = new ManagedRelay(delegate);
    const opening = relay.open({} as SessionSpec);
    await delegate.openStarted;

    const closing = relay.close();
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    const openingDuringClose = relay.open({} as SessionSpec);
    let openingDuringCloseSettled = false;
    void openingDuringClose.then(() => { openingDuringCloseSettled = true; });
    await nextTurn();
    assert.equal(closeSettled, false);
    assert.equal(openingDuringCloseSettled, false);
    delegate.releaseOpen();
    const snapshot = await opening;
    await closing;

    assert.deepEqual(delegate.endSessionIds, [snapshot.sessionId]);
    const reopenedSnapshot = await openingDuringClose;
    assert.notEqual(reopenedSnapshot.sessionId, snapshot.sessionId);
    await relay.close();
    assert.deepEqual(delegate.endSessionIds, [snapshot.sessionId, reopenedSnapshot.sessionId]);
  });

  it("frees active-session slots after end, withdrawal, and shutdown", async () => {
    const delegate = new TerminalLifecycleRelay();
    const relay = new ManagedRelay(delegate);
    const sessions: SessionSnapshot[] = [];
    for (let index = 0; index < MAX_ACTIVE_SESSIONS; index += 1) {
      sessions.push(await relay.open({} as SessionSpec));
    }
    await assert.rejects(() => relay.open({} as SessionSpec), /active session limit/u);

    await relay.command(sessions[0]!.sessionId, {
      type: "end",
      commandId: "end-frees-slot",
      reason: "operator_end",
    });
    await relay.open({} as SessionSpec);

    await relay.command(sessions[1]!.sessionId, {
      type: "participant_consent_withdrawal",
      commandId: "withdrawal-frees-slot",
      side: "A",
      consentId: "consent-" + sessions[1]!.sessionId,
      withdrawalId: "withdrawal-" + sessions[1]!.sessionId,
      withdrawnAtMonoMs: 1,
    });
    await nextTurn();
    await relay.open({} as SessionSpec);

    await relay.close();
    await relay.open({} as SessionSpec);
    await relay.close();
  });

  it("does not revisit sessions already terminated by delegate lifecycle paths during shutdown", async () => {
    const delegate = new TerminalLifecycleRelay();
    const relay = new ManagedRelay(delegate);
    const sessionIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const snapshot = await relay.open({} as SessionSpec);
      sessionIds.push(snapshot.sessionId);
      await nextTurn();
      if (index % 2 === 0) {
        await relay.command(snapshot.sessionId, {
          type: "participant_consent_withdrawal",
          commandId: "withdraw-" + index,
          side: "A",
          consentId: "consent-" + snapshot.sessionId,
          withdrawalId: "withdrawal-" + snapshot.sessionId,
          withdrawnAtMonoMs: index,
        });
      } else {
        delegate.closeInternally(snapshot.sessionId);
      }
      await nextTurn();
    }

    await relay.close();

    assert.deepEqual(delegate.endSessionIds, []);
    assert.deepEqual(delegate.terminalObserverSessionIds, sessionIds);
    assert.equal(delegate.subscriberCount, 0);
  });

  it("shares an explicit end with shutdown and releases its idle terminal observer", async () => {
    const delegate = new TerminalLifecycleRelay();
    delegate.holdEndCommands();
    const relay = new ManagedRelay(delegate);
    const snapshot = await relay.open({} as SessionSpec);
    await nextTurn();

    const ending = relay.command(snapshot.sessionId, {
      type: "end",
      commandId: "explicit-end",
      reason: "operator_end",
    });
    await delegate.endCommandStarted;
    const closing = relay.close();
    delegate.releaseEndCommands();
    await Promise.all([ending, closing]);
    await nextTurn();

    assert.deepEqual(delegate.endSessionIds, [snapshot.sessionId]);
    assert.equal(delegate.subscriberCount, 0);
  });

  it("waits for an explicit end that a terminal event has already retired", async () => {
    const delegate = new TerminalLifecycleRelay();
    delegate.holdEndCommands();
    const relay = new ManagedRelay(delegate);
    const snapshot = await relay.open({} as SessionSpec);
    await nextTurn();

    const ending = relay.command(snapshot.sessionId, {
      type: "end",
      commandId: "explicit-end-with-terminal-event",
      reason: "operator_end",
    });
    await delegate.endCommandStarted;
    delegate.closeInternally(snapshot.sessionId);
    await nextTurn();

    const closing = relay.close();
    let closeSettled = false;
    void closing.then(() => { closeSettled = true; });
    try {
      await nextTurn();
      assert.equal(closeSettled, false);
    } finally {
      delegate.releaseEndCommands();
      await Promise.all([ending, closing]);
    }
  });

  it("surfaces failed shutdown ends after settling all sessions and retries only the failure", async () => {
    const delegate = new TerminalLifecycleRelay();
    const relay = new ManagedRelay(delegate);
    const failed = await relay.open({} as SessionSpec);
    const completed = await relay.open({} as SessionSpec);
    await nextTurn();
    delegate.rejectNextEnd(failed.sessionId);

    await assert.rejects(
      () => relay.close(),
      /Delegate end failed for terminal-session-1/u,
    );
    assert.deepEqual(delegate.endSessionIds, [failed.sessionId, completed.sessionId]);

    await relay.close();

    assert.deepEqual(delegate.endSessionIds, [
      failed.sessionId,
      completed.sessionId,
      failed.sessionId,
    ]);
    assert.equal(delegate.subscriberCount, 0);
  });

  it("removes the operator bearer token from the startup log URL", () => {
    const token = "operator-test-token-0123456789abcdef";
    const publicUrl = operatorStartupUrl("https://relay.example.test/#access=" + token);
    assert.equal(publicUrl, "https://relay.example.test/");
    assert.equal(publicUrl.includes(token), false);
  });

  it("preserves the canonical Palabra hash route template and rejects encoded placeholders", () => {
    const profile = approvedProfile("palabra", ["balanced"], "balanced");
    const palabra = profile.services[0];
    assert.ok(palabra);
    assert.equal(
      resolvePalabraWebSocketEndpoint(palabra),
      "wss://streaming.palabra.example/streaming-api/{hash}/v1/speech-to-speech/stream",
    );
    assert.throws(
      () => resolvePalabraWebSocketEndpoint({
        ...palabra,
        endpoint: {
          ...palabra.endpoint,
          pathTemplate: "/streaming-api/%7Bhash%7D/v1/speech-to-speech/stream",
        },
      }),
      /exactly one literal \{hash\} placeholder/u,
    );
    assert.throws(
      () => resolvePalabraWebSocketEndpoint({
        ...palabra,
        endpoint: {
          ...palabra.endpoint,
          pathTemplate: "/streaming-api/prefixed-{hash}/v1/speech-to-speech/stream",
        },
      }),
      /\{hash\} path segment/u,
    );
    assert.throws(
      () => resolveApprovedServiceEndpoint({ ...palabra, role: "transcription" }, "wss"),
      /only supports the speech_to_speech service/u,
    );
  });

  it("keeps resolved provider service routes on their declared origin", () => {
    const profile = approvedProfile("openai_native", ["balanced"], "balanced");
    const service = profile.services[0];
    assert.ok(service);
    for (const pathTemplate of [
      "//attacker.example/v1/realtime",
      "/v1/" + "\\" + "attacker",
      "https://attacker.example/v1/realtime",
      "/v1/realtime?redirect=attacker",
      "/v1/realtime#fragment",
    ]) {
      assert.throws(
        () => resolveApprovedServiceEndpoint({
          ...service,
          endpoint: { ...service.endpoint, pathTemplate },
        }, "wss"),
        /must remain on its declared origin/u,
      );
    }
  });

  it("uses a pinned no-substitution controlled profile to constrain public modes and provider routing", async () => {
    const fixture = await deploymentFixture(
      approvedProfile("openai_controlled", ["fast", "balanced"], "balanced", "none"),
      { OPENAI_API_KEY: "openai-test-key" },
    );
    const composition = await composeApplication(fixture.config);
    await composition.app.ready();
    try {
      const operatorUrl = new URL(composition.operatorUrl);
      assert.equal(operatorUrl.origin, "http://localhost:4207");
      assert.equal(new URLSearchParams(operatorUrl.hash.slice(1)).get("access"), fixture.config.operatorToken);

      const response = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: operatorHeaders(fixture.config.operatorToken),
      });
      assert.equal(response.statusCode, 200);
      const translation = response.json().translation;
      assert.equal(translation.provider, "openai_controlled");
      assert.equal(translation.defaultMode, "balanced");
      assert.deepEqual(
        translation.modes.map((mode: { mode: string; state: string }) => ({ mode: mode.mode, state: mode.state })),
        [
          { mode: "fast", state: "locally_controlled" },
          { mode: "balanced", state: "locally_controlled" },
          { mode: "accurate", state: "unsupported" },
        ],
      );
      assert.equal(JSON.stringify(response.json()).includes("openai-test-key"), false);

      const unavailable = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: operatorHeaders(fixture.config.operatorToken),
        payload: { languages: { A: "en-US", B: "zh-TW" }, translationMode: "accurate" },
      });
      assert.equal(unavailable.statusCode, 422);
    } finally {
      await composition.app.close();
      await fixture.cleanup();
    }
  });

  it("rejects an approved-artifact service route that does not match the controlled runtime", async () => {
    const profile = approvedProfile("openai_controlled", ["balanced"], "balanced");
    const { sha256: _sha256, ...mismatchedBody } = {
      ...profile,
      services: profile.services.map((candidate) => candidate.role === "tts"
        ? { ...candidate, voice: { kind: "not_applicable" as const } }
        : candidate),
    };
    const mismatched: ApprovedSessionProcessingProfile = {
      ...mismatchedBody,
      sha256: canonicalJsonSha256(mismatchedBody),
    };
    const fixture = await deploymentFixture(mismatched);
    try {
      await assert.rejects(
        () => composeApplication(fixture.config),
        /does not match the openai_controlled runtime route/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects noncanonical native translation endpoint, model, or voice profiles", async () => {
    const canonical = approvedProfile("openai_native", ["balanced"], "balanced");
    for (const mutate of [
      (service: ProcessingService) => ({
        ...service,
        endpoint: { ...service.endpoint, pathTemplate: "/v1/realtime" },
      }),
      (service: ProcessingService) => ({
        ...service,
        endpoint: { ...service.endpoint, origin: "https://proxy.openai.example" },
      }),
      (service: ProcessingService) => ({
        ...service,
        model: { kind: "named" as const, value: "gpt-realtime" },
      }),
      (service: ProcessingService) => ({
        ...service,
        voice: { kind: "named" as const, value: "marin" },
      }),
    ]) {
      const body = {
        ...canonical,
        services: canonical.services.map((service) =>
          service.role === "speech_to_speech" ? mutate(service) : service,
        ),
      };
      const { sha256: _sha256, ...withoutHash } = body;
      const profile: ApprovedSessionProcessingProfile = {
        ...withoutHash,
        sha256: canonicalJsonSha256(withoutHash),
      };
      const fixture = await deploymentFixture(profile);
      try {
        await assert.rejects(
          () => composeApplication(fixture.config),
          /does not match the openai_native runtime route/u,
        );
      } finally {
        await fixture.cleanup();
      }
    }
  });

  it("rejects a profile that tries to make an experimental native capability selectable", async () => {
    const fixture = await deploymentFixture(
      approvedProfile("openai_native", ["accurate"], "accurate"),
      { OPENAI_API_KEY: "openai-test-key" },
    );
    try {
      await assert.rejects(
        () => composeApplication(fixture.config),
        /experimental and unavailable until benchmark parity is established/u,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps Palabra and fake-telephony media independently selectable through the profile and media seam", async () => {
    const fixture = await deploymentFixture(
      approvedProfile("palabra", ["fast", "balanced", "accurate"], "accurate"),
      { PALABRA_API_KEY: "palabra-test-key", MEDIA_PROFILE: "fake_telephony", PUBLIC_BASE_URL: "http://localhost:4207" },
    );
    const composition = await composeApplication(fixture.config);
    await composition.app.ready();
    try {
      const response = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: operatorHeaders(fixture.config.operatorToken),
      });
      const capabilities = response.json();
      assert.equal(capabilities.translation.provider, "palabra");
      assert.equal(capabilities.translation.defaultMode, "accurate");
      assert.deepEqual(capabilities.mediaProfiles, ["fake_telephony"]);
      assert.equal(JSON.stringify(capabilities).includes("palabra-test-key"), false);
      assert.ok(composition.telephonyTestDriver);
    } finally {
      await composition.app.close();
      await fixture.cleanup();
    }
  });
});

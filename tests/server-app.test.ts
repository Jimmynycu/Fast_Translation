import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createAudioFrame } from "../src/core/audio.js";
import { compileGlossary, type GlossarySpec } from "../src/core/glossary.js";
import type {
  ArtifactRecoveryResult,
  EvidenceRootLeaseRole,
  EvidenceRootProcessLease,
  EvidenceDeletionResult,
  ManagedEvidenceExportLease,
  ManagedEvidenceExportLeaseCompletion,
  ManagedEvidenceExportLeaseRequest,
  ManagedEvidenceExportLeaseResult,
  RetentionExtensionResult,
  RetentionSweepHealth,
  RetentionSweepResult,
} from "../src/adapters/evidence/session-artifact-store.js";
import type {
  EvidenceReview,
  EvidenceReviewRequest,
  EvidenceReviewResult,
} from "../src/adapters/evidence/review.js";
import type {
  EvidenceFinalization,
  EventCursor,
  GuardedDuplexRelay,
  ParticipantConsentState,
  RelayCommand,
  RecorderPreflightResult,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  Side,
} from "../src/core/types.js";
import {
  createSessionProcessingManifest,
  type ApprovedSessionProcessingProfile,
} from "../src/core/processing-profile.js";
import { RelaySessionError } from "../src/core/relay.js";
import { createSyntheticPocProcessingProfile } from "../src/local-eval/synthetic-poc-processing-manifest.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import {
  createServerApp,
  MAX_EVENT_SOCKET_BUFFERED_BYTES,
  MAX_EVENT_SUBSCRIPTIONS_PER_SESSION,
  sendBoundedEventSocketMessage,
  streamEventSocket,
  type BrowserMediaGateway,
  type ConfiguredTranslation,
  type GlossaryDeletionCommand,
  type GlossaryDeletionResult,
  type GlossaryImportResult,
  type GlossaryLease,
  type GlossaryRootLease,
  type GlossaryRegistry,
  type ServerArtifactGovernancePort,
} from "../src/server/app.js";
import {
  createServerAccessControl,
  type ServerAccessControl,
} from "../src/server/access.js";
import type { ImportGlossaryRequest } from "../src/server/protocol.js";
import { createTestOnlyVerifiedHumanSessionProcessingProfile } from "./support/acceptance.js";

const glossary: GlossarySpec = {
  id: "factory",
  version: "factory-v1",
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  entries: [
    { id: "term-1", source: "spindle", aliases: ["main spindle"], targetExact: "main shaft" },
  ],
};

const OPERATOR_TOKEN = "operator-test-token-0123456789abcdef";
const OPERATOR_HEADERS = { authorization: "Bearer " + OPERATOR_TOKEN } as const;
const RETENTION_OWNER_TOKEN = "retention-owner-test-token-0123456789";
const RETENTION_OWNER_HEADERS = { authorization: "Bearer " + RETENTION_OWNER_TOKEN } as const;
const EVIDENCE_REVIEWER_TOKEN = "evidence-reviewer-test-token-0123456789";
const EVIDENCE_REVIEWER_HEADERS = { authorization: "Bearer " + EVIDENCE_REVIEWER_TOKEN } as const;
const PARTICIPANT_SIGNING_KEY = Buffer.alloc(32, 19);
const DEPLOYMENT_BUILD_SHA256 = "b".repeat(64);

const TEST_PROCESSING_PROFILE: ApprovedSessionProcessingProfile =
  createTestOnlyVerifiedHumanSessionProcessingProfile();
const TEST_EVIDENCE_REVIEW_GRANT = Object.freeze({
  dataOwnerId: "retention-owner",
  bilingualReviewerId: "evidence-reviewer",
});

const unavailableEvidenceReview = Object.freeze({
  async review(_request: EvidenceReviewRequest): Promise<EvidenceReviewResult> {
    return Object.freeze({ status: "not_found" as const });
  },
} satisfies Pick<EvidenceReview, "review">);

function processingManifest(mode: SessionSpec["mode"]) {
  return createSessionProcessingManifest({
    profile: TEST_PROCESSING_PROFILE,
    mode,
  });
}

function disclosedProcessingServices() {
  return TEST_PROCESSING_PROFILE.services.map((service) => ({
    id: service.id,
    provider: service.provider,
    role: service.role,
    category: service.category,
    dataCategories: [...service.dataCategories],
  }));
}

function readyRecorderPreflight(spec: SessionSpec): RecorderPreflightResult {
  return {
    status: "ready",
    sessionId: "session-1",
    processingManifestSha256: spec.processingManifest.manifestSha256,
    preflightId: "preflight-1",
    checkedAtMonoMs: 140,
    requiredFreeBytes: "67108864",
    availableFreeBytes: "134217728",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    manifestSha256: "c".repeat(64),
    encryptedSpoolSha256: "d".repeat(64),
    sealedRecordCount: 1,
    sealSha256: "e".repeat(64),
  };
}

function sealedEvidenceFinalization(): Extract<EvidenceFinalization, { status: "sealed" }> {
  return {
    status: "sealed",
    sessionId: "session-1",
    processingManifestSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    encryptedLedgerSha256: "c".repeat(64),
    finalChainSha256: "d".repeat(64),
    recordCount: 42,
    finalizedAtUtc: "2026-08-09T12:00:00.000Z",
    retentionDeadlineAt: "2026-08-23T12:00:00.000Z",
    tracks: {
      source_a: { sha256: "e".repeat(64), frameCount: 1, byteCount: 960 },
      source_b: { sha256: "f".repeat(64), frameCount: 2, byteCount: 1920 },
      playout_to_a: { sha256: "0".repeat(64), frameCount: 3, byteCount: 2880 },
      playout_to_b: { sha256: "1".repeat(64), frameCount: 4, byteCount: 3840 },
    },
  };
}

const translation: ConfiguredTranslation = {
  providerId: "openai_controlled",
  modes: [
    {
      mode: "fast",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
    },
    {
      mode: "balanced",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
    },
    {
      mode: "accurate",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: true,
    },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
  defaultMode: "balanced",
};

function testAccess(): ServerAccessControl {
  return createServerAccessControl({
    operatorToken: OPERATOR_TOKEN,
    retentionOwner: {
      id: "retention-owner",
      token: RETENTION_OWNER_TOKEN,
    },
    evidenceReviewer: {
      id: "evidence-reviewer",
      token: EVIDENCE_REVIEWER_TOKEN,
    },
    participantSigningKey: PARTICIPANT_SIGNING_KEY,
  });
}


function snapshot(sessionId: string, spec: SessionSpec): SessionSnapshot {
  return {
    sessionId,
    status: "waiting",
    spec,
    participants: {
      A: {
        kind: "browser_link",
        side: "A",
        url: `http://relay.test/?role=participant&sessionId=${sessionId}&side=A`,
        qrDataUrl: "data:image/png;base64,QQ==",
      },
      B: {
        kind: "browser_link",
        side: "B",
        url: `http://relay.test/?role=participant&sessionId=${sessionId}&side=B`,
        qrDataUrl: "data:image/png;base64,Qg==",
      },
    },
    participantConsent: {
      A: { consented: false, recording: false, processing: false },
      B: { consented: false, recording: false, processing: false },
    },
    recorderArmState: "awaiting_consents",
    recordingArmed: false,
    participantReadiness: { A: undefined, B: undefined },
    providerReadiness: { A_TO_B: undefined, B_TO_A: undefined },
    generations: { A_TO_B: 0, B_TO_A: 0 },
    behavior: resolveTranslationBehavior(spec.mode),
    ...(spec.glossary === undefined
      ? {}
      : { glossary: { id: spec.glossary.id, version: spec.glossary.version, hash: "hash-v1" } }),
    eventCursor: 1,
    openedAtMs: 100,
  };
}


class FakeRelay implements GuardedDuplexRelay {
  readonly opened: SessionSpec[] = [];
  readonly commanded: Array<{ sessionId: string; command: RelayCommand }> = [];
  openError: Error | undefined;
  eventsForSession: readonly SessionEvent[] = [];
  snapshotStatus: SessionSnapshot["status"] = "waiting";
  behaviorModeOverride: SessionSpec["mode"] | undefined;
  eventCursorOverride: number | undefined;
  participantConsent: Record<Side, ParticipantConsentState> = {
    A: { consented: false, recording: false, processing: false },
    B: { consented: false, recording: false, processing: false },
  };
  recorderArmState: SessionSnapshot["recorderArmState"] = "awaiting_consents";
  recorderPreflight: RecorderPreflightResult | undefined;
  evidenceFinalization: EvidenceFinalization | undefined;
  participantReadiness: SessionSnapshot["participantReadiness"] = { A: undefined, B: undefined };
  providerReadiness: SessionSnapshot["providerReadiness"] = {
    A_TO_B: undefined,
    B_TO_A: undefined,
  };

  async open(spec: SessionSpec): Promise<SessionSnapshot> {
    this.opened.push(spec);
    if (this.openError !== undefined) throw this.openError;
    const opened = snapshot("session-1", spec);
    return {
      ...opened,
      ...(this.behaviorModeOverride === undefined
        ? {}
        : { behavior: resolveTranslationBehavior(this.behaviorModeOverride) }),
      ...(this.eventCursorOverride === undefined ? {} : { eventCursor: this.eventCursorOverride }),
    };
  }

  snapshot(sessionId: string): SessionSnapshot {
    const latest = this.opened.at(-1);
    if (latest === undefined) throw new Error("Unknown fake session");
    const current = {
      ...snapshot(sessionId, latest),
      status: this.snapshotStatus,
      participantConsent: this.participantConsent,
      recorderArmState: this.recorderArmState,
      recordingArmed: this.recorderArmState === "armed",
      participantReadiness: this.participantReadiness,
      providerReadiness: this.providerReadiness,
      ...(this.recorderPreflight === undefined
        ? {}
        : { recorderPreflight: this.recorderPreflight }),
      ...(this.evidenceFinalization === undefined
        ? {}
        : { evidenceFinalization: this.evidenceFinalization }),
    };
    return {
      ...current,
      ...(this.behaviorModeOverride === undefined
        ? {}
        : { behavior: resolveTranslationBehavior(this.behaviorModeOverride) }),
      ...(this.eventCursorOverride === undefined ? {} : { eventCursor: this.eventCursorOverride }),
    };
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    this.commanded.push({ sessionId, command });
    if (command.type === "participant_consent") {
      this.participantConsent = {
        ...this.participantConsent,
        [command.side]: {
          consented: true,
          consentId: command.consentId,
          consentPolicyRef: command.consentPolicyRef,
          recording: command.recording,
          processing: command.processing,
        },
      };
      if (this.participantConsent.A.consented && this.participantConsent.B.consented) {
        this.recorderArmState = "unarmed";
      }
    }
    if (command.type === "participant_consent_withdrawal") {
      this.participantConsent = {
        ...this.participantConsent,
        [command.side]: {
          ...this.participantConsent[command.side],
          consented: false,
          recording: false,
          processing: false,
          withdrawalId: command.withdrawalId,
          withdrawnAtMonoMs: command.withdrawnAtMonoMs,
        },
      };
    }
    if (command.type === "arm_recorder") this.recorderArmState = "armed";
  }

  events(_sessionId: string, after: EventCursor = 0): AsyncIterable<SessionEvent> {
    const events = this.eventsForSession.filter((event) => event.cursor > after);
    return (async function* (): AsyncIterable<SessionEvent> {
      yield* events;
    })();
  }
}

class DeferredWithdrawalRelay extends FakeRelay {
  readonly withdrawalReserved: Promise<void>;
  readonly retrySnapshotRead: Promise<void>;
  #resolveWithdrawalReserved!: () => void;
  #resolveRetrySnapshotRead!: () => void;
  #releasePersistence!: () => void;
  readonly #persistence = new Promise<void>((resolve) => {
    this.#releasePersistence = resolve;
  });
  #postWithdrawalSnapshotReads = 0;
  withdrawalCommandCount = 0;

  constructor() {
    super();
    this.withdrawalReserved = new Promise<void>((resolve) => {
      this.#resolveWithdrawalReserved = resolve;
    });
    this.retrySnapshotRead = new Promise<void>((resolve) => {
      this.#resolveRetrySnapshotRead = resolve;
    });
  }

  override snapshot(sessionId: string): SessionSnapshot {
    const result = super.snapshot(sessionId);
    if (result.participantConsent.A.withdrawalId !== undefined) {
      this.#postWithdrawalSnapshotReads += 1;
      if (this.#postWithdrawalSnapshotReads === 1) this.#resolveRetrySnapshotRead();
    }
    return result;
  }

  override async command(sessionId: string, command: RelayCommand): Promise<void> {
    await super.command(sessionId, command);
    if (command.type !== "participant_consent_withdrawal") return;
    this.withdrawalCommandCount += 1;
    if (this.withdrawalCommandCount === 1) this.#resolveWithdrawalReserved();
    await this.#persistence;
  }

  completeWithdrawalPersistence(): void {
    this.#releasePersistence();
  }
}

interface TrackingEventStream {
  returned: boolean;
  resolve?: (result: IteratorResult<SessionEvent>) => void;
}

class TrackingRelay extends FakeRelay {
  readonly streams: TrackingEventStream[] = [];

  override events(
    _sessionId: string,
    _after: EventCursor = 0,
    _signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const stream: TrackingEventStream = { returned: false };
    this.streams.push(stream);
    const iterator: AsyncIterator<SessionEvent> = {
      next: () => new Promise<IteratorResult<SessionEvent>>((resolve) => {
        stream.resolve = resolve;
      }),
      return: async () => {
        stream.returned = true;
        stream.resolve?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}

type EventSocketListener = (...args: readonly unknown[]) => void;

class BackpressuredEventSocket {
  readonly OPEN = 1;
  readonly sent: string[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  closeThrows = false;
  terminateCalls = 0;
  readonly #listeners = new Map<string, Set<EventSocketListener>>();
  readyState = this.OPEN;
  bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES + 1;

  once(event: string, listener: EventSocketListener): void {
    const onceListener: EventSocketListener = (...args) => {
      this.off(event, onceListener);
      listener(...args);
    };
    const listeners = this.#listeners.get(event) ?? new Set<EventSocketListener>();
    listeners.add(onceListener);
    this.#listeners.set(event, listeners);
  }

  off(event: string, listener: EventSocketListener): void {
    this.#listeners.get(event)?.delete(listener);
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.closeThrows) throw new Error("close failed");
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) listener();
  }

  terminate(): void {
    this.terminateCalls += 1;
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) listener();
  }
}

class InspectableEventSubscription implements AsyncIterable<SessionEvent> {
  readonly events: readonly SessionEvent[];
  nextCalls = 0;
  returned = false;

  constructor(events: readonly SessionEvent[]) {
    this.events = events;
  }

  [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
    let nextIndex = 0;
    return {
      next: async (): Promise<IteratorResult<SessionEvent>> => {
        this.nextCalls += 1;
        const event = this.events[nextIndex];
        nextIndex += 1;
        return event === undefined
          ? { done: true, value: undefined }
          : { done: false, value: event };
      },
      return: async (): Promise<IteratorResult<SessionEvent>> => {
        this.returned = true;
        return { done: true, value: undefined };
      },
    };
  }
}

async function openFakeSession(relay: FakeRelay): Promise<void> {

  await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode: "balanced",
    processingManifest: processingManifest("balanced"),
    evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
  });
}

class FakeGlossaryRegistry implements GlossaryRegistry {
  readonly imports: ImportGlossaryRequest[] = [];
  readonly acquiredVersions: string[] = [];
  readonly releaseAttempts: string[] = [];
  readonly releasedVersions: string[] = [];
  readonly deletionCommands: Array<{
    version: string;
    commandId: string;
    ownerId: string;
    reason: string;
    requestedAtMs: number;
  }> = [];
  deletionResult: GlossaryDeletionResult = {
    status: "completed",
    deletionReceiptId: "a".repeat(64),
    requestedAtMs: 1_723_168_000_000,
    deletedAtMs: 1_723_168_001_000,
  };
  importError: Error | undefined;
  releaseError: Error | undefined;
  releaseFailuresRemaining = 0;

  async acquireRootLease(): Promise<GlossaryRootLease> {
    return {
      async release(): Promise<void> {},
    };
  }

  async importFile(request: ImportGlossaryRequest): Promise<GlossaryImportResult> {
    this.imports.push(request);
    if (this.importError !== undefined) throw this.importError;
    return { version: glossary.version, hash: "hash-v1", spec: glossary };
  }

  async acquire(version: string): Promise<GlossaryLease | undefined> {
    if (version !== glossary.version) return undefined;
    this.acquiredVersions.push(version);
    let released = false;
    return {
      spec: glossary,
      release: async (): Promise<void> => {
        this.releaseAttempts.push(version);
        if (this.releaseFailuresRemaining > 0) {
          this.releaseFailuresRemaining -= 1;
          throw this.releaseError ?? new Error("Fake glossary lease release failed");
        }
        if (released) return;
        released = true;
        this.releasedVersions.push(version);
      },
    };
  }

  async deleteVersion(command: GlossaryDeletionCommand): Promise<GlossaryDeletionResult> {
    this.deletionCommands.push(structuredClone(command));
    return this.deletionResult;
  }
}

class FakeArtifactManagement implements ServerArtifactGovernancePort {
  retentionHealth: RetentionSweepHealth = { health: "healthy" };

  async extendRetention(): Promise<RetentionExtensionResult> {
    return { status: "rejected" };
  }

  async deleteEvidence(): Promise<EvidenceDeletionResult> {
    return { status: "not_found" };
  }

  getRetentionSweepHealth(): RetentionSweepHealth {
    return this.retentionHealth;
  }

  async recover(): Promise<ArtifactRecoveryResult> {
    return {
      status: "completed",
      health: "healthy",
      recoveredDeletions: 0,
      sealedArtifacts: 0,
      finalizationFailures: 0,
      orphanedActiveArtifacts: 0,
    };
  }

  async sweepExpired(): Promise<RetentionSweepResult> {
    return {
      status: "completed",
      health: "healthy",
      expiredArtifactsDeleted: 0,
    };
  }

  async acquireEvidenceRootLease(role: EvidenceRootLeaseRole): Promise<EvidenceRootProcessLease> {
    return {
      role,
      async release(): Promise<void> {},
    };
  }

  async withManagedExportLease<T>(
    _request: ManagedEvidenceExportLeaseRequest,
    _transaction: (
      _lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>> {
    return { status: "conflict" };
  }

}

class FakeBrowserMedia implements BrowserMediaGateway {
  readonly attached: Array<{ sessionId: string; side: Side; socket: unknown }> = [];
  readonly detached: Array<{ sessionId: string; side: Side; socket: unknown }> = [];
  attachError: Error | undefined;

  attach(sessionId: string, side: Side, socket: unknown): void {
    if (this.attachError !== undefined) throw this.attachError;
    this.attached.push({ sessionId, side, socket });
  }

  detach(sessionId: string, side: Side, socket: unknown): void {
    this.detached.push({ sessionId, side, socket });
  }
}

async function fixture(
  evidenceHealth: "healthy" | "degraded" = "healthy",
): Promise<Readonly<{
  app: Awaited<ReturnType<typeof createServerApp>>;
  relay: FakeRelay;
  glossaries: FakeGlossaryRegistry;
  media: FakeBrowserMedia;
  access: ServerAccessControl;
  artifacts: FakeArtifactManagement;
}>> {
  const relay = new FakeRelay();
  const glossaries = new FakeGlossaryRegistry();
  const media = new FakeBrowserMedia();
  const access = testAccess();
  const artifacts = new FakeArtifactManagement();
  const app = await createServerApp({
    relay,
    glossaries,
    browserMedia: media,
    access,
    translation,
    processingProfile: TEST_PROCESSING_PROFILE,
    deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    artifacts,
    evidenceReview: unavailableEvidenceReview,
    evidenceHealth: () => evidenceHealth,
  });
  await app.ready();
  return { app, relay, glossaries, media, access, artifacts };
}
async function openAndCollect(
  app: Awaited<ReturnType<typeof createServerApp>>,
  path: string,
  count: number,
) {
  let resolveMessages!: (messages: readonly string[]) => void;
  let rejectMessages!: (error: unknown) => void;
  const messages = new Promise<readonly string[]>((resolve, reject) => {
    resolveMessages = resolve;
    rejectMessages = reject;
  });
  const received: string[] = [];
  const socket = await app.injectWS(path, {}, {
    onInit(created) {
      created.on("message", (data) => {
        received.push(data.toString());
        if (received.length === count) resolveMessages(received);
      });
      created.on("error", rejectMessages);
    },
  });
  return { socket, messages: await messages };
}

async function openAndCollectUntilClose(
  app: Awaited<ReturnType<typeof createServerApp>>,
  path: string,
): Promise<readonly string[]> {
  let resolveMessages!: (messages: readonly string[]) => void;
  let rejectMessages!: (error: unknown) => void;
  const completed = new Promise<readonly string[]>((resolve, reject) => {
    resolveMessages = resolve;
    rejectMessages = reject;
  });
  const received: string[] = [];
  await app.injectWS(path, {}, {
    onInit(socket) {
      socket.on("message", (data) => received.push(data.toString()));
      socket.once("close", () => resolveMessages(received));
      socket.on("error", rejectMessages);
    },
  });
  return completed;
}

async function websocketCloseCode(
  app: Awaited<ReturnType<typeof createServerApp>>,
  path: string,
): Promise<number> {
  let resolveClose!: (code: number) => void;
  const closed = new Promise<number>((resolve) => {
    resolveClose = resolve;
  });
  await app.injectWS(path, {}, {
    onInit(socket) {
      socket.once("close", (code) => resolveClose(code));
    },
  });
  return closed;
}


describe("server application", () => {
  it("requires the operator bearer before protected HTTP work", async () => {
    const { app, relay, glossaries } = await fixture();
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/api/capabilities" }),
        app.inject({ method: "GET", url: "/api/sessions/session-1" }),
        app.inject({ method: "POST", url: "/api/glossaries", payload: {} }),
        app.inject({ method: "POST", url: "/api/sessions", payload: {} }),
        app.inject({
          method: "POST",
          url: "/api/sessions/session-1/commands",
          payload: {},
        }),
      ]);
      for (const response of responses) {
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, "unauthorized");
        assert.equal(response.headers["www-authenticate"], "Bearer");
      }

      const invalid = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: { authorization: "Bearer invalid" },
      });
      assert.equal(invalid.statusCode, 401);
      assert.equal(relay.opened.length, 0);
      assert.equal(relay.commanded.length, 0);
      assert.equal(glossaries.imports.length, 0);
    } finally {
      await app.close();
    }
  });

  it("imports glossary files and returns a version reference", async () => {
    const { app, glossaries } = await fixture();
    try {
      const csv = "id,source,target_exact\n1,spindle,main shaft";
      const response = await app.inject({
        method: "POST",
        url: "/api/glossaries",
        headers: OPERATOR_HEADERS,
        payload: {
          name: "Factory terms",
          fileName: "factory-terms.csv",
          contentsBase64: Buffer.from(csv).toString("base64"),
          sourceLanguage: "en-US",
          targetLanguage: "zh-TW",
          approvedBy: "Glossary owner",
        },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        glossaryVersion: "factory-v1",
        hash: "hash-v1",
        id: "factory",
      });
      assert.equal(glossaries.imports[0]?.name, "Factory terms");
      assert.equal(glossaries.imports[0]?.fileName, "factory-terms.csv");
      assert.equal(glossaries.imports[0]?.contentsBase64, Buffer.from(csv).toString("base64"));
    } finally {
      await app.close();
    }
  });

  it("rejects an authenticated glossary payload over the protocol limit before import", async () => {
    const { app, glossaries } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/glossaries",
        headers: { ...OPERATOR_HEADERS, "content-type": "application/json" },
        payload: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
      });
      assert.equal(response.statusCode, 413);
      assert.deepEqual(response.json(), {
        error: {
          code: "payload_too_large",
          message: "Request payload is too large",
        },
      });
      assert.equal(glossaries.imports.length, 0);
    } finally {
      await app.close();
    }
  });

  it("redacts unexpected glossary repository failures", async () => {
    const { app, glossaries } = await fixture();
    glossaries.importError = new Error(
      "EACCES D:/Fast_Translation/work/tmp/glossaries/factory-v1.secret token=super-secret",
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/glossaries",
        headers: OPERATOR_HEADERS,
        payload: {
          name: "Factory terms",
          fileName: "factory-terms.csv",
          contentsBase64: Buffer.from("id,source,target_exact\n1,spindle,main shaft").toString("base64"),
          sourceLanguage: "en-US",
          targetLanguage: "zh-TW",
          approvedBy: "Glossary owner",
        },
      });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), {
        error: {
          code: "invalid_glossary",
          message: "The glossary could not be imported",
        },
      });
      assert.doesNotMatch(response.body, /D:\/Fast_Translation|secret|EACCES|factory-v1/u);
    } finally {
      await app.close();
    }
  });

  it("creates a manifest-backed unconsented room and returns its participant disclosure", async () => {
    const { app, relay } = await fixture();
    try {
      const obsoleteConsent = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          recordingConsent: true,
        },
      });
      assert.equal(obsoleteConsent.statusCode, 400);
      assert.equal(relay.opened.length, 0);

      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "factory-v1",
        },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        provider: "openai_controlled",
        translationMode: "accurate",
        behaviorVersion: 1,
        translationState: "locally_controlled",
        deterministicGlossary: true,
        sessionId: "session-1",
        languages: { A: "en-US", B: "zh-TW" },
        eventCursor: 1,
        state: "waiting",
        participantConsent: {
          A: { consented: false, recording: false, processing: false },
          B: { consented: false, recording: false, processing: false },
        },
        recorderArmState: "awaiting_consents",
        recordingArmed: false,
        processingDisclosure: {
          noticeVersion: TEST_PROCESSING_PROFILE.consentPolicy.noticeVersion,
          recording: true,
          processing: true,
          withdrawalTerminatesSession: true,
          provider: "openai_controlled",
          services: disclosedProcessingServices(),
        },
        endpointGrants: [
          {
            kind: "browser_link",
            side: "A",
            url: "http://relay.test/?role=participant&sessionId=session-1&side=A",
            qrDataUrl: "data:image/png;base64,QQ==",
          },
          {
            kind: "browser_link",
            side: "B",
            url: "http://relay.test/?role=participant&sessionId=session-1&side=B",
            qrDataUrl: "data:image/png;base64,Qg==",
          },
        ],
        glossaryVersion: "factory-v1",
        glossaryHash: "hash-v1",
        evidenceHealth: "healthy",
        evidenceIdentity: {
          deploymentBuildSha256: "b".repeat(64),
          processingProfile: {
            id: TEST_PROCESSING_PROFILE.id,
            version: TEST_PROCESSING_PROFILE.version,
            sha256: TEST_PROCESSING_PROFILE.sha256,
          },
          processingManifestSha256: createSessionProcessingManifest({
            profile: TEST_PROCESSING_PROFILE,
            mode: "accurate",
            glossary: { id: "factory", version: "factory-v1", hash: compileGlossary(glossary).hash },
          }).manifestSha256,
          servicesSha256: processingManifest("accurate").selectedTranslation.servicesSha256,
        },
        participantReadiness: {},
        providerReadiness: {},
      });
      assert.equal(relay.opened[0]?.glossary, glossary);
      assert.equal(relay.opened[0]?.sideA.language, "en-US");
      assert.equal(relay.opened[0]?.sideB.language, "zh-TW");
      assert.equal(relay.opened[0]?.provider, "openai_controlled");
      assert.equal(relay.opened[0]?.mode, "accurate");
      assert.deepEqual(relay.opened[0]?.processingManifest, createSessionProcessingManifest({
        profile: TEST_PROCESSING_PROFILE,
        mode: "accurate",
        glossary: { id: "factory", version: "factory-v1", hash: compileGlossary(glossary).hash },
      }));
      assert.deepEqual(Object.keys(relay.opened[0] ?? {}).sort(), [
        "evidenceReviewGrant",
        "glossary",
        "mode",
        "processingManifest",
        "provider",
        "sideA",
        "sideB",
      ]);
      const recovered = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(recovered.statusCode, 200);
      assert.deepEqual(recovered.json(), response.json());
    } finally {
      await app.close();
    }
  });

  it("returns authoritative languages and glossary identity on reversed-direction recovery", async () => {
    const { app, relay } = await fixture();
    relay.eventCursorOverride = 37;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "zh-TW", B: "en-US" },
          translationMode: "accurate",
          glossaryVersion: "factory-v1",
        },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json().languages, { A: "zh-TW", B: "en-US" });
      assert.equal(response.json().eventCursor, 37);
      assert.equal(response.json().glossaryVersion, "factory-v1");
      assert.equal(response.json().glossaryHash, "hash-v1");

      const recovered = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(recovered.statusCode, 200);
      assert.deepEqual(recovered.json().languages, { A: "zh-TW", B: "en-US" });
      assert.equal(recovered.json().eventCursor, 37);
      assert.equal(recovered.json().glossaryVersion, "factory-v1");
      assert.equal(recovered.json().glossaryHash, "hash-v1");
    } finally {
      await app.close();
    }
  });

  it("rejects a relay snapshot whose behavior mode differs from the pinned session mode", async () => {
    const { app, relay, glossaries } = await fixture();
    relay.behaviorModeOverride = "fast";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "factory-v1",
        },
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), {
        error: {
          code: "internal_error",
          message: "The server could not complete the request",
        },
      });
      assert.doesNotMatch(response.body, /balanced|accurate|private|behavior/u);
    } finally {
      await app.close();
    }
    const cleanupCommands = relay.commanded.filter((entry) => entry.command.type === "end");
    assert.equal(cleanupCommands.length, 1);
    const cleanup = cleanupCommands[0]?.command;
    if (cleanup?.type !== "end") throw new Error("payload validation did not issue an end command");
    assert.match(cleanup.commandId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    assert.equal(cleanup.reason, "session_payload_invalid");
    assert.deepEqual(glossaries.releaseAttempts, ["factory-v1"]);
    assert.deepEqual(glossaries.releasedVersions, ["factory-v1"]);
  });

  it("injects the configured review grant server-side without exposing either identity", async () => {
    const { app, relay, access } = await fixture();
    try {
      const requestSuppliedGrant = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
          evidenceReviewGrant: {
            dataOwnerId: "request-owner-id",
            bilingualReviewerId: "request-reviewer-id",
          },
        },
      });
      assert.equal(requestSuppliedGrant.statusCode, 400);
      assert.equal(relay.opened.length, 0);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
        },
      });
      assert.equal(created.statusCode, 201);
      const opened = relay.opened[0];
      assert.notEqual(opened, undefined);
      if (opened === undefined) throw new Error("session was not opened");
      assert.deepEqual(opened.evidenceReviewGrant, access.evidenceReviewGrant());

      const persistedEvent: SessionEvent = {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 100,
        lane: null,
        generation: null,
        type: "session_opened",
        snapshot: snapshot("session-1", opened),
      };
      relay.eventsForSession = [persistedEvent];
      const recovered = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(recovered.statusCode, 200);
      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          1,
        ),
        openAndCollect(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
          1,
        ),
      ]);
      for (const payload of [
        requestSuppliedGrant.body,
        created.body,
        recovered.body,
        ...operator.messages,
        ...participant.messages,
      ]) {
        assert.doesNotMatch(
          payload,
          /dataOwnerId|bilingualReviewerId|retention-owner|evidence-reviewer|request-owner-id|request-reviewer-id/u,
        );
      }
      operator.socket.terminate();
      participant.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("holds a selected glossary lease until an operator ends the session", async () => {
    const { app, glossaries } = await fixture();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: glossary.version,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(glossaries.acquiredVersions, [glossary.version]);
      assert.deepEqual(glossaries.releasedVersions, []);

      const ended = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/commands",
        headers: OPERATOR_HEADERS,
        payload: {
          kind: "end",
          commandId: "7b7b66c9-8a57-4d4f-a594-491952019f6a",
        },
      });
      assert.equal(ended.statusCode, 202);
      assert.deepEqual(glossaries.releasedVersions, [glossary.version]);
    } finally {
      await app.close();
    }
  });

  it("releases a selected glossary lease for withdrawal and server shutdown", async () => {
    const withdrawalFixture = await fixture();
    try {
      const created = await withdrawalFixture.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: glossary.version,
        },
      });
      assert.equal(created.statusCode, 201);
      const participantAuthorization = {
        authorization: "Bearer " + withdrawalFixture.access.issueParticipantAccess("session-1", "A"),
      };
      const consent = await withdrawalFixture.app.inject({
        method: "POST",
        url: "/api/sessions/session-1/participants/A/recording-processing-consent",
        headers: participantAuthorization,
        payload: {
          accepted: true,
          consentId: "7c9fbe15-21a6-4e96-a99e-a8e606c9b11e",
        },
      });
      assert.equal(consent.statusCode, 202);
      const withdrawn = await withdrawalFixture.app.inject({
        method: "POST",
        url: "/api/sessions/session-1/participants/A/recording-processing-withdrawal",
        headers: participantAuthorization,
        payload: { withdrawalId: "caa52dd4-b3f1-49cc-ac4a-ff9c9ac2e1ca" },
      });
      assert.equal(withdrawn.statusCode, 202);
      assert.deepEqual(withdrawalFixture.glossaries.releasedVersions, [glossary.version]);
    } finally {
      await withdrawalFixture.app.close();
    }

    const shutdownFixture = await fixture();
    const created = await shutdownFixture.app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: OPERATOR_HEADERS,
      payload: {
        languages: { A: "en-US", B: "zh-TW" },
        translationMode: "accurate",
        glossaryVersion: glossary.version,
      },
    });
    assert.equal(created.statusCode, 201);
    await shutdownFixture.app.close();
    assert.deepEqual(shutdownFixture.glossaries.releasedVersions, [glossary.version]);
  });

  it("releases a selected glossary lease when relay admission fails", async () => {
    const { app, relay, glossaries } = await fixture();
    relay.openError = new Error("relay admission failed");
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: glossary.version,
        },
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(glossaries.acquiredVersions, [glossary.version]);
      assert.deepEqual(glossaries.releasedVersions, [glossary.version]);
    } finally {
      await app.close();
    }
  });

  it("releases a selected glossary lease when an internal terminal event closes the session", async () => {
    const relay = new TrackingRelay();
    const glossaries = new FakeGlossaryRegistry();
    const app = await createServerApp({
      relay,
      glossaries,
      browserMedia: new FakeBrowserMedia(),
      access: testAccess(),
      translation,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    try {
      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: glossary.version,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.equal(relay.streams.length, 1);
      relay.streams[0]?.resolve?.({
        done: false,
        value: {
          cursor: 2,
          sessionId: "session-1",
          timestampMonoMs: 200,
          lane: null,
          generation: null,
          type: "session_closed",
          reason: "evidence_failure",
          finalization: sealedEvidenceFinalization(),
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(glossaries.releasedVersions, [glossary.version]);
    } finally {
      await app.close();
    }
  });

  it("allows only the data owner to delete an inactive glossary with a safe idempotent receipt", async () => {
    const { app, glossaries, artifacts } = await fixture();
    artifacts.retentionHealth = { health: "degraded" };
    const deletionPath = "/api/glossaries/" + glossary.version;
    const ownerPayload = {
      commandId: "02d6f096-feb9-4316-a62b-52294c5fbbec",
      reason: "Data owner requested glossary deletion",
    };
    try {
      const reviewer = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: EVIDENCE_REVIEWER_HEADERS,
        payload: ownerPayload,
      });
      assert.equal(reviewer.statusCode, 401);

      const clientControlledOwner = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: RETENTION_OWNER_HEADERS,
        payload: { ...ownerPayload, ownerId: "client-controlled-owner" },
      });
      assert.equal(clientControlledOwner.statusCode, 400);

      const completed = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: RETENTION_OWNER_HEADERS,
        payload: ownerPayload,
      });
      assert.equal(completed.statusCode, 200);
      assert.deepEqual(completed.json(), {
        status: "completed",
        deletionReceiptId: "a".repeat(64),
        requestedAtMs: 1_723_168_000_000,
        deletedAtMs: 1_723_168_001_000,
      });
      assert.deepEqual(glossaries.deletionCommands.map(({ requestedAtMs: _requestedAtMs, ...command }) => command), [{
        version: glossary.version,
        commandId: ownerPayload.commandId,
        ownerId: "retention-owner",
        reason: ownerPayload.reason,
      }]);
      assert.equal(typeof glossaries.deletionCommands[0]?.requestedAtMs, "number");
      assert.doesNotMatch(
        completed.body,
        /factory-v1|retention-owner|Data owner requested|path|actor|reason/u,
      );

      glossaries.deletionResult = { status: "active" };
      const active = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: RETENTION_OWNER_HEADERS,
        payload: {
          commandId: "c9c12b5f-4c4f-45a1-a115-a50975d7e6f4",
          reason: "Retry after active session ends",
        },
      });
      assert.equal(active.statusCode, 409);
      assert.equal(active.json().error.code, "glossary_active");

      glossaries.deletionResult = { status: "not_found" };
      const missing = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: RETENTION_OWNER_HEADERS,
        payload: {
          commandId: "2be471c6-b35d-4417-970f-b3641f285b1d",
          reason: "Retry after missing version",
        },
      });
      assert.equal(missing.statusCode, 404);
      assert.equal(missing.json().error.code, "glossary_not_found");

      glossaries.deletionResult = { status: "conflict" };
      const conflict = await app.inject({
        method: "DELETE",
        url: deletionPath,
        headers: RETENTION_OWNER_HEADERS,
        payload: {
          commandId: "80d03410-2c80-41a9-bf8b-33909f3147eb",
          reason: "Retry with a conflicting command",
        },
      });
      assert.equal(conflict.statusCode, 409);
      assert.equal(conflict.json().error.code, "idempotency_conflict");
    } finally {
      await app.close();
    }
  });

  it("rejects the synthetic POC profile before relay open or participant grants", async () => {
    const relay = new FakeRelay();
    const app = await createServerApp({
      relay,
      glossaries: new FakeGlossaryRegistry(),
      browserMedia: new FakeBrowserMedia(),
      access: testAccess(),
      translation,
      processingProfile: createSyntheticPocProcessingProfile(),
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(capabilities.statusCode, 200);
      assert.equal(capabilities.json().dataAdmission, "synthetic_only");

      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
        },
      });
      assert.equal(response.statusCode, 422);
      assert.deepEqual(response.json(), {
        error: {
          code: "synthetic_only_profile",
          message: "The configured processing profile permits synthetic benchmark data only",
          dataAdmission: "synthetic_only",
        },
      });
      assert.equal(relay.opened.length, 0);
      assert.doesNotMatch(response.body, /trainingUse|serviceRetention|unverified|api\.openai/u);
    } finally {
      await app.close();
    }
  });

  it("keeps immutable evidence identity operator-only in session snapshots and events", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 100,
      lane: null,
      generation: null,
      type: "session_opened",
      snapshot: snapshot("session-1", spec),
    }];
    try {
      await relay.open(spec);
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 200);
      const expectedIdentity = {
        deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
        processingProfile: {
          id: TEST_PROCESSING_PROFILE.id,
          version: TEST_PROCESSING_PROFILE.version,
          sha256: TEST_PROCESSING_PROFILE.sha256,
        },
        processingManifestSha256: spec.processingManifest.manifestSha256,
        servicesSha256: spec.processingManifest.selectedTranslation.servicesSha256,
      };
      assert.deepEqual(response.json().evidenceIdentity, expectedIdentity);

      const operator = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        1,
      );
      const participant = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
        1,
      );
      const operatorEvent = JSON.parse(operator.messages[0] ?? "") as { data: Record<string, unknown> };
      const participantEvent = JSON.parse(participant.messages[0] ?? "") as { data: Record<string, unknown> };
      assert.deepEqual(operatorEvent.data.evidenceIdentity, expectedIdentity);
      assert.equal("evidenceIdentity" in participantEvent.data, false);
      assert.doesNotMatch(JSON.stringify(operatorEvent), /api\.openai\.example|evidenceRef|token|manifestSha256.*services/u);
      operator.socket.terminate();
      participant.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("projects only sanitized sealed finalization to the operator close event and reconnect snapshot", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    const sealed = sealedEvidenceFinalization();
    const finalization = {
      ...sealed,
      tracks: {
        ...sealed.tracks,
        source_a: {
          ...sealed.tracks.source_a,
          evidenceRef: "track-evidence-reference",
          archivePath: "D:/evidence/archive/source-a",
        },
      },
      archivePath: "D:/evidence/archive/session-1",
      evidenceRef: "opaque-evidence-reference",
      rawManifest: { token: "secret-token" },
    } as unknown as EvidenceFinalization;
    const expected = {
      status: "sealed",
      manifestSha256: "b".repeat(64),
      encryptedLedgerSha256: "c".repeat(64),
      finalChainSha256: "d".repeat(64),
      retentionDeadlineAt: "2026-08-23T12:00:00.000Z",
      tracks: {
        source_a: { sha256: "e".repeat(64), frameCount: 1, byteCount: 960 },
        source_b: { sha256: "f".repeat(64), frameCount: 2, byteCount: 1920 },
        playout_to_a: { sha256: "0".repeat(64), frameCount: 3, byteCount: 2880 },
        playout_to_b: { sha256: "1".repeat(64), frameCount: 4, byteCount: 3840 },
      },
    };
    relay.evidenceFinalization = finalization;
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 100,
        lane: null,
        generation: null,
        type: "session_opened",
        snapshot: { ...snapshot("session-1", spec), evidenceFinalization: finalization },
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 200,
        lane: null,
        generation: null,
        type: "session_closed",
        reason: "operator_end",
        finalization,
      },
    ];
    try {
      await relay.open(spec);
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().evidenceFinalization, expected);

      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          2,
        ),
        openAndCollect(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
          2,
        ),
      ]);
      const operatorEvents = operator.messages.map((message) => JSON.parse(message) as {
        data: Record<string, unknown>;
      });
      const participantEvents = participant.messages.map((message) => JSON.parse(message) as {
        data: Record<string, unknown>;
      });
      assert.deepEqual(operatorEvents[0]?.data.evidenceFinalization, expected);
      assert.deepEqual(operatorEvents[1]?.data.evidenceFinalization, expected);
      for (const event of participantEvents) {
        assert.equal("evidenceFinalization" in event.data, false);
      }
      assert.doesNotMatch(
        JSON.stringify(operatorEvents.map((event) => event.data.evidenceFinalization)),
        /D:\/evidence|opaque-evidence-reference|track-evidence-reference|secret-token|rawManifest|sessionId|processingManifestSha256/u,
      );
      operator.socket.terminate();
      participant.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("exposes only failure code and recovery when evidence finalization fails", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    const finalization: EvidenceFinalization = {
      status: "FINALIZATION_FAILED",
      sessionId: "session-1",
      processingManifestSha256: "a".repeat(64),
      failureCode: "integrity_verification_failed",
      recovery: "quarantine_delete_rerun",
    };
    const expected = {
      status: "FINALIZATION_FAILED",
      failureCode: "integrity_verification_failed",
      recovery: "quarantine_delete_rerun",
    };
    relay.evidenceFinalization = finalization;
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 100,
        lane: null,
        generation: null,
        type: "session_opened",
        snapshot: { ...snapshot("session-1", spec), evidenceFinalization: finalization },
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 200,
        lane: null,
        generation: null,
        type: "session_closed",
        reason: "operator_end",
        finalization,
      },
    ];
    try {
      await relay.open(spec);
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().evidenceFinalization, expected);

      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          2,
        ),
        openAndCollect(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
          2,
        ),
      ]);
      const operatorEvents = operator.messages.map((message) => JSON.parse(message) as {
        data: Record<string, unknown>;
      });
      const participantEvents = participant.messages.map((message) => JSON.parse(message) as {
        data: Record<string, unknown>;
      });
      assert.deepEqual(operatorEvents[0]?.data.evidenceFinalization, expected);
      assert.deepEqual(operatorEvents[1]?.data.evidenceFinalization, expected);
      for (const event of participantEvents) {
        assert.equal("evidenceFinalization" in event.data, false);
      }
      for (const data of operatorEvents.map((event) => event.data)) {
        const summary = data.evidenceFinalization as Record<string, unknown> | undefined;
        assert.equal(summary?.status, "FINALIZATION_FAILED");
        assert.equal("finalChainSha256" in (summary ?? {}), false);
        assert.equal("verdict" in (summary ?? {}), false);
      }
      operator.socket.terminate();
      participant.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("projects verified recorder preflight only to the operator snapshot and replay", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    const preflight = readyRecorderPreflight(spec);
    relay.recorderPreflight = preflight;
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 150,
      lane: null,
      generation: null,
      type: "session_opened",
      snapshot: { ...snapshot("session-1", spec), recorderPreflight: preflight },
    }];
    const expected = {
      status: "ready",
      checkedAtMonoMs: 140,
      requiredFreeBytes: "67108864",
      availableFreeBytes: "134217728",
      tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
      manifestSha256: "c".repeat(64),
      encryptedSpoolSha256: "d".repeat(64),
      sealedRecordCount: 1,
      sealSha256: "e".repeat(64),
    };
    try {
      await relay.open(spec);
      const response = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().recorderPreflight, expected);
      assert.equal("preflightId" in response.json().recorderPreflight, false);
      assert.equal("processingManifestSha256" in response.json().recorderPreflight, false);

      const operator = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        1,
      );
      const participant = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
        1,
      );
      const operatorData = (JSON.parse(operator.messages[0] ?? "") as { data: Record<string, unknown> }).data;
      const participantData = (JSON.parse(participant.messages[0] ?? "") as { data: Record<string, unknown> }).data;
      assert.deepEqual(operatorData.recorderPreflight, expected);
      assert.equal("recorderPreflight" in participantData, false);
      operator.socket.terminate();
      participant.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("maps glossary gate transitions for the operator without changing participant protocol", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 101,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_bound",
        turnId: "turn-a",
        segmentId: "segment-a",
        revision: 0,
        final: false,
        glossaryHash: "hash-a",
        entryIds: ["term-1"],
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 102,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_authorized",
        turnId: "turn-a",
        segmentId: "segment-a",
        revision: 1,
        final: true,
        glossaryHash: "hash-a",
        entryIds: ["term-1"],
        text: "main shaft",
        guaranteedTargetExact: ["main shaft"],
      } as unknown as SessionEvent,
      {
        cursor: 3,
        sessionId: "session-1",
        timestampMonoMs: 103,
        lane: "A_TO_B",
        generation: 1,
        type: "alert",
        alert: {
          type: "glossary_control_bypassed",
          code: "placeholder_missing",
          message: "required placeholder is missing",
          termId: "term-1",
          glossaryId: "factory",
          glossaryVersion: "factory-v1",
          glossaryHash: "hash-a",
          expectedPlaceholders: ["⟦GLOSSARY_0001⟧"],
          observedPlaceholders: [],
        },
        evidenceRef: "opaque-provider-reference",
      },
    ];
    try {
      const [operator, participantA, participantB] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          3,
        ),
        openAndCollect(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
          1,
        ),
        openAndCollect(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "B")),
          2,
        ),
      ]);
      const operatorEvents = operator.messages.map((message) => JSON.parse(message) as {
        type: string;
        data: Record<string, unknown>;
      });
      assert.deepEqual(operatorEvents.map((event) => ({ type: event.type, status: event.data.status })), [
        { type: "terminology_gate", status: "bound" },
        { type: "terminology_gate", status: "authorized" },
        { type: "terminology_gate", status: "bypassed" },
      ]);
      assert.equal(operatorEvents[2]?.data.termId, "term-1");
      assert.equal(operatorEvents[2]?.data.code, "placeholder_missing");
      assert.equal("evidenceRef" in (operatorEvents[2]?.data ?? {}), false);
      assert.equal("text" in (operatorEvents[1]?.data ?? {}), false);
      assert.equal("guaranteedTargetExact" in (operatorEvents[1]?.data ?? {}), false);
      assert.doesNotMatch(JSON.stringify(operatorEvents[1]), /main shaft/u);
      assert.deepEqual(
        participantA.messages.map((message) => (JSON.parse(message) as { type: string }).type),
        ["glossary_bound"],
      );
      assert.deepEqual(
        participantB.messages.map((message) => (JSON.parse(message) as { type: string }).type),
        ["target_validated", "terminology_alert"],
      );
      operator.socket.terminate();
      participantA.socket.terminate();
      participantB.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("projects operational evidence telemetry only to the operator and restores it from the snapshot", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    const preflight = readyRecorderPreflight(spec);
    relay.recorderPreflight = preflight;
    relay.participantReadiness = {
      A: {
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      },
      B: undefined,
    };
    relay.providerReadiness = {
      A_TO_B: {
        readiness: "local_route_validated",
        remoteConnection: "deferred_until_first_turn",
      },
      B_TO_A: undefined,
    };
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 140,
        lane: null,
        generation: null,
        type: "recorder_preflight",
        preflight,
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 145,
        lane: null,
        generation: null,
        type: "participant_readiness",
        side: "A",
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      },
      {
        cursor: 3,
        sessionId: "session-1",
        timestampMonoMs: 150,
        lane: "A_TO_B",
        generation: 1,
        type: "provider_readiness",
        readiness: {
          readiness: "local_route_validated",
          remoteConnection: "deferred_until_first_turn",
        },
      },
      {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 155,
        lane: "A_TO_B",
        generation: 1,
        type: "queue_sample",
        scope: "relay_input",
        side: "A",
        depthFrames: 2,
        capacityFrames: 64,
        oldestQueuedAgeMs: 40,
      },
      {
        cursor: 5,
        sessionId: "session-1",
        timestampMonoMs: 160,
        lane: "A_TO_B",
        generation: 1,
        type: "playout_lag",
        scope: "server_to_audible_ack",
        side: "B",
        sequence: 7,
        audibleStartLagMs: 57,
      },
      {
        cursor: 6,
        sessionId: "session-1",
        timestampMonoMs: 165,
        lane: "A_TO_B",
        generation: 2,
        type: "barge_lifecycle",
        stage: "playout_clear_acknowledged",
        bargeId: "barge-1",
        clearId: "clear-1",
        sourceSide: "A",
        destinationSide: "B",
        message: "Bearer secret-token at D:/evidence/archive/session-1",
      },
      {
        cursor: 7,
        sessionId: "session-1",
        timestampMonoMs: 170,
        lane: "A_TO_B",
        generation: 2,
        type: "glossary_bypassed",
        turnId: "turn-a",
        segmentId: "target-a",
        revision: 2,
        final: true,
        glossaryHash: "hash-a",
        entryIds: ["term-1"],
        text: "unverified translation",
        guaranteedTargetExact: [],
      } as unknown as SessionEvent,
    ];
    try {
      await relay.open(spec);
      const snapshotResponse = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(snapshotResponse.statusCode, 200);
      assert.deepEqual(snapshotResponse.json().participantReadiness, {
        A: {
          microphone: "browser_capture_active",
          headphones: "self_attested",
          source: "participant_browser_self_report",
        },
      });
      assert.deepEqual(snapshotResponse.json().providerReadiness, {
        A_TO_B: {
          readiness: "local_route_validated",
          remoteConnection: "deferred_until_first_turn",
        },
      });

      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          7,
        ),
        openAndCollectUntilClose(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
        ),
      ]);
      const operatorEvents = operator.messages.map((message) => JSON.parse(message) as {
        type: string;
        data: Record<string, unknown>;
      });
      assert.deepEqual(operatorEvents.map((event) => event.type), [
        "recorder_preflight",
        "participant_readiness",
        "provider_readiness",
        "queue_sample",
        "playout_lag",
        "barge_lifecycle",
        "terminology_gate",
      ]);
      assert.deepEqual(operatorEvents[1]?.data, {
        side: "A",
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
      assert.deepEqual(operatorEvents[2]?.data, {
        readiness: "local_route_validated",
        remoteConnection: "deferred_until_first_turn",
      });
      assert.equal(operatorEvents[3]?.data.scope, "relay_input");
      assert.equal(operatorEvents[4]?.data.audibleStartLagMs, 57);
      assert.deepEqual(operatorEvents[5]?.data, {
        stage: "playout_clear_acknowledged",
        bargeId: "barge-1",
        clearId: "clear-1",
        sourceSide: "A",
        destinationSide: "B",
      });
      assert.equal(operatorEvents[6]?.data.status, "bypassed");
      assert.equal("text" in (operatorEvents[6]?.data ?? {}), false);
      assert.equal("guaranteedTargetExact" in (operatorEvents[6]?.data ?? {}), false);
      assert.doesNotMatch(JSON.stringify(operatorEvents[6]), /unverified translation/u);
      assert.deepEqual(participant, []);
      operator.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("whitelists alert fields before they cross the operator event boundary", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 200,
      lane: null,
      generation: null,
      type: "alert",
      alert: {
        code: "Bearer secret-token D:/evidence/archive/session-1",
        message: "Bearer secret-token at D:/evidence/archive/session-1 processingManifest={raw}",
        retryable: false,
        evidenceRef: "inner-evidence-reference",
        path: "D:/evidence/archive/session-1",
        token: "secret-token",
        authorization: "Bearer secret-token",
        processingManifest: { raw: true },
        processingProfile: { raw: true },
      },
      evidenceRef: "outer-evidence-reference",
    } as unknown as SessionEvent];
    try {
      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          1,
        ),
        openAndCollectUntilClose(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
        ),
      ]);
      const event = JSON.parse(operator.messages[0] ?? "") as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(event.type, "error");
      assert.deepEqual(event.data, {
        code: "unclassified_relay_alert",
        message: "An operational relay error occurred.",
        retryable: false,
      });
      assert.doesNotMatch(JSON.stringify(event), /evidence-reference|D:\/evidence|secret-token|processingManifest|processingProfile/u);
      assert.deepEqual(participant, []);
      operator.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("preserves known controlled-adapter alert codes after redaction", async () => {
    const { app, relay } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 200,
      lane: "A_TO_B",
      generation: 0,
      type: "alert",
      alert: {
        code: "GLOSSARY_PLACEHOLDER_MISSING",
        message: "missing placeholder at D:/evidence/archive/session-1",
        retryable: false,
      },
    }];
    try {
      const { messages } = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        1,
      );
      const event = JSON.parse(messages[0] ?? "") as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(event.type, "terminology_alert");
      assert.deepEqual(event.data, {
        code: "GLOSSARY_PLACEHOLDER_MISSING",
        message: "An operational relay error occurred.",
        retryable: false,
        sourceSide: "A",
        targetSide: "B",
      });
      assert.doesNotMatch(JSON.stringify(event), /D:\/evidence/u);
    } finally {
      await app.close();
    }
  });

  it("preserves confirmed operational alert codes after redaction", async () => {
    const { app, relay } = await fixture();
    await openFakeSession(relay);
    const codes = ["source_queue_overflow", "playout_clear_failed", "provider_cancel_failed"] as const;
    relay.eventsForSession = codes.map((code, index) => ({
      cursor: index + 1,
      sessionId: "session-1",
      timestampMonoMs: 200 + index,
      lane: "A_TO_B" as const,
      generation: index,
      type: "alert" as const,
      alert: {
        code,
        message: "internal failure details must not cross the boundary",
        retryable: false,
      },
    }));
    try {
      const { messages } = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        codes.length,
      );
      const events = messages.map((message) => JSON.parse(message) as {
        type: string;
        data: Record<string, unknown>;
      });
      assert.deepEqual(events.map((event) => event.data.code), codes);
      assert.ok(events.every((event) => event.type === "error"));
    } finally {
      await app.close();
    }
  });

  it("preserves invalid participant state as a bounded alert without its raw message", async () => {
    const { app, relay } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 200,
      lane: null,
      generation: null,
      type: "alert",
      alert: {
        code: "invalid_participant_state",
        message: "participant timestamp Bearer secret-token at D:/evidence/archive/session-1",
        retryable: false,
      },
    }];
    try {
      const { messages } = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        1,
      );
      const event = JSON.parse(messages[0] ?? "") as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(event.type, "error");
      assert.deepEqual(event.data, {
        code: "invalid_participant_state",
        message: "An operational relay error occurred.",
        retryable: false,
      });
      assert.doesNotMatch(JSON.stringify(event), /secret-token|D:\/evidence/u);
    } finally {
      await app.close();
    }
  });

  it("preserves the bounded prepare failure code without provider error text", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 200,
      lane: null,
      generation: null,
      type: "alert",
      alert: {
        code: "translation_prepare_failed",
        message: "provider token secret-token at https://provider.example/internal",
        retryable: false,
      },
    }];
    try {
      const [operator, participant] = await Promise.all([
        openAndCollect(
          app,
          "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
          1,
        ),
        openAndCollectUntilClose(
          app,
          "/ws/events/session-1?access=" +
            encodeURIComponent(access.issueParticipantAccess("session-1", "A")),
        ),
      ]);
      const event = JSON.parse(operator.messages[0] ?? "") as {
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(event.type, "error");
      assert.deepEqual(event.data, {
        code: "translation_prepare_failed",
        message: "An operational relay error occurred.",
        retryable: false,
      });
      assert.doesNotMatch(JSON.stringify(event), /secret-token|provider\.example|internal/u);
      assert.deepEqual(participant, []);
      operator.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("rejects a pinned glossary when the selected mode cannot guarantee it", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
          glossaryVersion: "factory-v1",
        },
      });
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, "glossary_unsupported");
      assert.deepEqual(response.json().error.selectableModes, ["accurate"]);
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown glossary without opening a relay session", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "missing",
        },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, "glossary_not_found");
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });

  it("returns a safe failure and retries an unattached glossary lease on close", async () => {
    const { app, relay, glossaries } = await fixture();
    const openError = new Error("provider token secret-token at https://provider.example/internal");
    const releaseError = new Error("glossary cleanup secret-token at D:/glossaries/factory-v1");
    relay.openError = openError;
    glossaries.releaseError = releaseError;
    glossaries.releaseFailuresRemaining = 1;
    let closed = false;
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "factory-v1",
        },
      });

      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json().error, {
        code: "session_open_cleanup_failed",
        message: "The session could not be opened; glossary cleanup will be retried during shutdown",
      });
      assert.doesNotMatch(response.body, /secret-token|provider\.example|D:\/glossaries/u);
      assert.deepEqual(glossaries.releaseAttempts, ["factory-v1"]);
      assert.deepEqual(glossaries.releasedVersions, []);

      await app.close();
      closed = true;

      assert.deepEqual(glossaries.releaseAttempts, ["factory-v1", "factory-v1"]);
      assert.deepEqual(glossaries.releasedVersions, ["factory-v1"]);
    } finally {
      if (!closed) await app.close();
    }
  });

  it("propagates a retained unattached glossary cleanup failure from app close", async () => {
    const { app, relay, glossaries } = await fixture();
    const releaseError = new Error("glossary cleanup failed during shutdown");
    relay.openError = new Error("provider open failed");
    glossaries.releaseError = releaseError;
    glossaries.releaseFailuresRemaining = 2;
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: OPERATOR_HEADERS,
      payload: {
        languages: { A: "en-US", B: "zh-TW" },
        translationMode: "accurate",
        glossaryVersion: "factory-v1",
      },
    });

    assert.equal(response.statusCode, 500);
    await assert.rejects(app.close(), releaseError);
    assert.deepEqual(glossaries.releaseAttempts, ["factory-v1", "factory-v1"]);
    assert.deepEqual(glossaries.releasedVersions, []);
  });


  it("maps HTTP command kinds to relay command types", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/commands",
        payload: { kind: "pause", commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7" },
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 202);
      const armed = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/commands",
        payload: { kind: "arm_recorder", commandId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2" },
        headers: OPERATOR_HEADERS,
      });
      assert.equal(armed.statusCode, 202);
      assert.deepEqual(relay.commanded, [{
        sessionId: "session-1",
        command: { type: "pause", commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7" },
      }, {
        sessionId: "session-1",
        command: { type: "arm_recorder", commandId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2" },
      }]);
    } finally {
      await app.close();
    }
  });

  it("binds exact-side recording-processing consent to the frozen manifest before media attaches", async () => {
    const { app, relay, media, access } = await fixture();
    await openFakeSession(relay);
    const consentId = "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7";
    const consentPath = "/api/sessions/session-1/participants/A/recording-processing-consent";
    const sideA = access.issueParticipantAccess("session-1", "A");
    const sideB = access.issueParticipantAccess("session-1", "B");
    const mediaPath = "/ws/media/session-1/A?access=" + encodeURIComponent(sideA);
    const consentPolicyRef = relay.snapshot("session-1").spec.processingManifest.consentPolicyRef;
    try {
      assert.equal(await websocketCloseCode(app, mediaPath), 1008);
      assert.equal(media.attached.length, 0);

      const [operatorRejected, oppositeRejected] = await Promise.all([
        app.inject({
          method: "POST",
          url: consentPath,
          headers: OPERATOR_HEADERS,
          payload: { accepted: true, consentId },
        }),
        app.inject({
          method: "POST",
          url: consentPath,
          headers: { authorization: "Bearer " + sideB },
          payload: { accepted: true, consentId },
        }),
      ]);
      assert.equal(operatorRejected.statusCode, 401);
      assert.equal(oppositeRejected.statusCode, 401);
      assert.equal(relay.commanded.length, 0);

      const accepted = await app.inject({
        method: "POST",
        url: consentPath,
        headers: { authorization: "Bearer " + sideA },
        payload: { accepted: true, consentId },
      });
      assert.equal(accepted.statusCode, 202);
      assert.deepEqual(accepted.json(), { accepted: true, consentId });
      const operatorSnapshot = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(operatorSnapshot.statusCode, 200);
      assert.deepEqual(operatorSnapshot.json().participantConsent.A, {
        consented: true,
        recording: true,
        processing: true,
      });
      assert.doesNotMatch(operatorSnapshot.body, /consentPolicyRef|consentId|withdrawalId/u);
      const command = relay.commanded[0]?.command;
      assert.deepEqual(
        command === undefined
          ? undefined
          : {
              type: command.type,
              commandId: command.commandId,
              side: command.type === "participant_consent" ? command.side : undefined,
              consentId: command.type === "participant_consent" ? command.consentId : undefined,
              consentPolicyRef: command.type === "participant_consent" ? command.consentPolicyRef : undefined,
              recording: command.type === "participant_consent" ? command.recording : undefined,
              processing: command.type === "participant_consent" ? command.processing : undefined,
            },
        {
          type: "participant_consent",
          commandId: consentId,
          side: "A",
          consentId,
          consentPolicyRef,
          recording: true,
          processing: true,
        },
      );

      const mediaSocket = await app.injectWS(mediaPath);
      assert.equal(media.attached.length, 1);
      mediaSocket.terminate();
    } finally {
      await app.close();
    }
  });

  it("accepts a withdrawal only from the consenting participant and derives its consent receipt", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    const consentId = "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7";
    const withdrawalId = "78db594d-f8ac-4e08-bb36-2c0d8184f4a2";
    const differentWithdrawalId = "f6f7a2c2-a65b-4f83-8997-93a0dc77bcae";
    const consentPath = "/api/sessions/session-1/participants/A/recording-processing-consent";
    const withdrawalPath = "/api/sessions/session-1/participants/A/recording-processing-withdrawal";
    const sideA = access.issueParticipantAccess("session-1", "A");
    const sideB = access.issueParticipantAccess("session-1", "B");
    try {
      const consent = await app.inject({
        method: "POST",
        url: consentPath,
        headers: { authorization: "Bearer " + sideA },
        payload: { accepted: true, consentId },
      });
      assert.equal(consent.statusCode, 202);

      const [operatorRejected, oppositeRejected] = await Promise.all([
        app.inject({
          method: "POST",
          url: withdrawalPath,
          headers: OPERATOR_HEADERS,
          payload: { withdrawalId },
        }),
        app.inject({
          method: "POST",
          url: withdrawalPath,
          headers: { authorization: "Bearer " + sideB },
          payload: { withdrawalId },
        }),
      ]);
      assert.equal(operatorRejected.statusCode, 401);
      assert.equal(oppositeRejected.statusCode, 401);
      assert.equal(relay.commanded.length, 1);

      const accepted = await app.inject({
        method: "POST",
        url: withdrawalPath,
        headers: { authorization: "Bearer " + sideA },
        payload: { withdrawalId },
      });
      assert.equal(accepted.statusCode, 202);
      assert.deepEqual(accepted.json(), { accepted: true, withdrawalId });
      const command = relay.commanded[1]?.command;
      assert.deepEqual(
        command === undefined
          ? undefined
          : {
              type: command.type,
              commandId: command.commandId,
              side: command.type === "participant_consent_withdrawal" ? command.side : undefined,
              consentId: command.type === "participant_consent_withdrawal" ? command.consentId : undefined,
              withdrawalId: command.type === "participant_consent_withdrawal" ? command.withdrawalId : undefined,
              withdrawnAtMonoMsIsFinite:
                command.type === "participant_consent_withdrawal" && Number.isFinite(command.withdrawnAtMonoMs),
            },
        {
          type: "participant_consent_withdrawal",
          commandId: withdrawalId,
          side: "A",
          consentId,
          withdrawalId,
          withdrawnAtMonoMsIsFinite: true,
        },
      );

      const retried = await app.inject({
        method: "POST",
        url: withdrawalPath,
        headers: { authorization: "Bearer " + sideA },
        payload: { withdrawalId },
      });
      assert.equal(retried.statusCode, 202);
      assert.deepEqual(retried.json(), { accepted: true, withdrawalId });
      assert.equal(relay.commanded[2]?.command.commandId, withdrawalId);

      const conflictingRetry = await app.inject({
        method: "POST",
        url: withdrawalPath,
        headers: { authorization: "Bearer " + sideA },
        payload: { withdrawalId: differentWithdrawalId },
      });
      assert.equal(conflictingRetry.statusCode, 409);
      assert.equal(conflictingRetry.json().error.code, "consent_not_active");
    } finally {
      await app.close();
    }
  });

  it("waits for concurrent matching withdrawal retries to join Relay persistence", async () => {
    const relay = new DeferredWithdrawalRelay();
    const access = testAccess();
    const app = await createServerApp({
      relay,
      glossaries: new FakeGlossaryRegistry(),
      browserMedia: new FakeBrowserMedia(),
      access,
      translation,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    await openFakeSession(relay);
    const consentId = "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7";
    const withdrawalId = "78db594d-f8ac-4e08-bb36-2c0d8184f4a2";
    const differentWithdrawalId = "f6f7a2c2-a65b-4f83-8997-93a0dc77bcae";
    const participantHeaders = {
      authorization: "Bearer " + access.issueParticipantAccess("session-1", "A"),
    };
    const withdrawalPath = "/api/sessions/session-1/participants/A/recording-processing-withdrawal";
    const withdraw = (requestedWithdrawalId: string) => app.inject({
      method: "POST",
      url: withdrawalPath,
      headers: participantHeaders,
      payload: { withdrawalId: requestedWithdrawalId },
    });
    try {
      const consent = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/participants/A/recording-processing-consent",
        headers: participantHeaders,
        payload: { accepted: true, consentId },
      });
      assert.equal(consent.statusCode, 202);

      let firstResolved = false;
      const first = withdraw(withdrawalId).then((response) => {
        firstResolved = true;
        return response;
      });
      await relay.withdrawalReserved;
      assert.equal(firstResolved, false);

      let retryResolved = false;
      const retry = withdraw(withdrawalId).then((response) => {
        retryResolved = true;
        return response;
      });
      await relay.retrySnapshotRead;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      assert.equal(relay.withdrawalCommandCount, 2);
      assert.equal(firstResolved, false);
      assert.equal(retryResolved, false);
      const withdrawalCommands = relay.commanded.filter(
        (entry): entry is { sessionId: string; command: Extract<RelayCommand, {
          type: "participant_consent_withdrawal";
        }> } => entry.command.type === "participant_consent_withdrawal",
      );
      assert.deepEqual(
        withdrawalCommands.map(({ command }) => ({
          consentId: command.consentId,
          withdrawalId: command.withdrawalId,
        })),
        [
          { consentId, withdrawalId },
          { consentId, withdrawalId },
        ],
      );

      relay.completeWithdrawalPersistence();
      const [firstResponse, retryResponse] = await Promise.all([first, retry]);
      assert.equal(firstResponse.statusCode, 202);
      assert.equal(retryResponse.statusCode, 202);
      assert.deepEqual(firstResponse.json(), { accepted: true, withdrawalId });
      assert.deepEqual(retryResponse.json(), { accepted: true, withdrawalId });

      const conflictingRetry = await withdraw(differentWithdrawalId);
      assert.equal(conflictingRetry.statusCode, 409);
      assert.equal(conflictingRetry.json().error.code, "consent_not_active");
    } finally {
      relay.completeWithdrawalPersistence();
      await app.close();
    }
  });

  it("publishes health and stable capabilities", async () => {
    const { app } = await fixture();
    try {
      const home = await app.inject({ method: "GET", url: "/" });
      assert.equal(home.statusCode, 200);
      assert.match(home.body, /Live translation room/);
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), {
        status: "ok",
        evidenceHealth: "healthy",
        retention: { health: "healthy" },
      });
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().translation, {
        provider: "openai_controlled",
        modes: [
          {
            mode: "fast",
            behavior: { version: 1 },
            state: "locally_controlled",
            deterministicGlossary: false,
          },
          {
            mode: "balanced",
            behavior: { version: 1 },
            state: "locally_controlled",
            deterministicGlossary: false,
          },
          {
            mode: "accurate",
            behavior: { version: 1 },
            state: "locally_controlled",
            deterministicGlossary: true,
          },
        ],
        defaultMode: "balanced",
      });
      assert.deepEqual(capabilities.json().glossaryImportFormats, ["csv", "xlsx"]);
      assert.deepEqual(capabilities.json().audio, {
        encoding: "pcm_s16le",
        sampleRateHz: 24000,
        channels: 1,
        frameDurationMs: 20,
      });
    } finally {
      await app.close();
    }
  });

  it("exposes fake telephony capability without a browser media route", async () => {
    const app = await createServerApp({
      relay: new FakeRelay(),
      glossaries: new FakeGlossaryRegistry(),
      mediaProfile: "fake_telephony",
      access: testAccess(),
      translation,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().mediaProfiles, ["fake_telephony"]);
      assert.equal(
        app.hasRoute({
          method: "GET",
          url: "/ws/media/:sessionId/:side",
        }),
        false,
      );
    } finally {
      await app.close();
    }

    await assert.rejects(
      createServerApp({
        relay: new FakeRelay(),
        glossaries: new FakeGlossaryRegistry(),
        mediaProfile: "fake_telephony",
        browserMedia: new FakeBrowserMedia(),
        access: testAccess(),
        translation,
        processingProfile: TEST_PROCESSING_PROFILE,
        deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
        artifacts: new FakeArtifactManagement(),
        evidenceReview: unavailableEvidenceReview,
      }),
      /must not expose the browser media gateway/u,
    );
  });

  it("reports degraded status when evidence recording is degraded", async () => {
    const { app } = await fixture("degraded");
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), {
        status: "degraded",
        evidenceHealth: "degraded",
        retention: { health: "healthy" },
      });
    } finally {
      await app.close();
    }
  });

  it("retains nonselectable capability rows and rejects a direct experimental mode request", async () => {
    const relay = new FakeRelay();
    const glossaries = new FakeGlossaryRegistry();
    const media = new FakeBrowserMedia();
    const experimentalAccurate: ConfiguredTranslation = {
      ...translation,
      modes: translation.modes.map((capability) =>
        capability.mode === "accurate"
          ? {
              ...capability,
              state: "experimental",
              reason: "Accurate behavior is pending provider parity validation.",
            }
          : capability,
      ),
    };
    const app = await createServerApp({
      relay,
      glossaries,
      browserMedia: media,
      access: testAccess(),
      translation: experimentalAccurate,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().translation, {
        provider: "openai_controlled",
        modes: [
          {
            mode: "fast",
            behavior: { version: 1 },
            state: "locally_controlled",
            deterministicGlossary: false,
          },
          {
            mode: "balanced",
            behavior: { version: 1 },
            state: "locally_controlled",
            deterministicGlossary: false,
          },
          {
            mode: "accurate",
            behavior: { version: 1 },
            state: "experimental",
            deterministicGlossary: true,
            reason: "Accurate behavior is pending provider parity validation.",
          },
        ],
        defaultMode: "balanced",
      });

      const rejected = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
        },
      });
      assert.equal(rejected.statusCode, 422);
      assert.equal(rejected.json().error.code, "translation_mode_unavailable");
      assert.equal(rejected.json().error.state, "experimental");
      assert.equal(
        rejected.json().error.reason,
        "Accurate behavior is pending provider parity validation.",
      );
      assert.deepEqual(rejected.json().error.selectableModes, ["fast", "balanced"]);
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });

  it("scopes participant event streams to their lane and side", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 101,
        lane: null,
        generation: null,
        type: "session_state",
        previousStatus: "waiting",
        status: "ready",
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 102,
        lane: null,
        generation: null,
        type: "participant_state",
        side: "A",
        connected: true,
      },
      {
        cursor: 3,
        sessionId: "session-1",
        timestampMonoMs: 103,
        lane: null,
        generation: null,
        type: "participant_state",
        side: "B",
        connected: true,
      },
      {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 104,
        lane: "A_TO_B",
        generation: 1,
        type: "source_transcript",
        turnId: "turn-a",
        segmentId: "source-a",
        revision: 0,
        text: "from A",
        final: true,
        evidenceRef: "provider-source-a",
      },
      {
        cursor: 5,
        sessionId: "session-1",
        timestampMonoMs: 105,
        lane: "B_TO_A",
        generation: 1,
        type: "source_transcript",
        turnId: "turn-b",
        segmentId: "source-b",
        revision: 0,
        text: "from B",
        final: true,
      },
      {
        cursor: 6,
        sessionId: "session-1",
        timestampMonoMs: 106,
        lane: "A_TO_B",
        generation: 1,
        type: "target_transcript",
        turnId: "turn-a",
        segmentId: "target-a",
        revision: 0,
        text: "to B",
        final: true,
      },
      {
        cursor: 7,
        sessionId: "session-1",
        timestampMonoMs: 107,
        lane: "B_TO_A",
        generation: 1,
        type: "target_transcript",
        turnId: "turn-b",
        segmentId: "target-b",
        revision: 0,
        text: "to A",
        final: true,
      },
      {
        cursor: 8,
        sessionId: "session-1",
        timestampMonoMs: 108,
        lane: "A_TO_B",
        generation: 1,
        type: "generation_cut",
        previousGeneration: 0,
        reason: "barge_in",
        clearId: "clear-a",
        bargeId: "barge-a",
      },
      {
        cursor: 9,
        sessionId: "session-1",
        timestampMonoMs: 109,
        lane: "B_TO_A",
        generation: 1,
        type: "generation_cut",
        previousGeneration: 0,
        reason: "barge_in",
        clearId: "clear-b",
        bargeId: "barge-b",
      },
      {
        cursor: 10,
        sessionId: "session-1",
        timestampMonoMs: 110,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_bound",
        turnId: "turn-a",
        segmentId: "source-a",
        revision: 0,
        final: true,
        glossaryHash: "hash-a",
        entryIds: ["a"],
      },
      {
        cursor: 11,
        sessionId: "session-1",
        timestampMonoMs: 111,
        lane: "B_TO_A",
        generation: 1,
        type: "glossary_bound",
        turnId: "turn-b",
        segmentId: "source-b",
        revision: 0,
        final: true,
        glossaryHash: "hash-b",
        entryIds: ["b"],
      },
      {
        cursor: 12,
        sessionId: "session-1",
        timestampMonoMs: 112,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_authorized",
        turnId: "turn-a",
        segmentId: "target-a",
        revision: 0,
        final: true,
        glossaryHash: "hash-a",
        entryIds: ["a"],
      },
      {
        cursor: 13,
        sessionId: "session-1",
        timestampMonoMs: 113,
        lane: "B_TO_A",
        generation: 1,
        type: "glossary_authorized",
        turnId: "turn-b",
        segmentId: "target-b",
        revision: 0,
        final: true,
        glossaryHash: "hash-b",
        entryIds: ["b"],
      },
      {
        cursor: 14,
        sessionId: "session-1",
        timestampMonoMs: 114,
        lane: "A_TO_B",
        generation: 1,
        type: "alert",
        alert: { code: "lane-a", message: "lane A", retryable: false },
      },
      {
        cursor: 15,
        sessionId: "session-1",
        timestampMonoMs: 115,
        lane: "B_TO_A",
        generation: 1,
        type: "alert",
        alert: {
          code: "TRANSCRIPTION_LOW_CONFIDENCE",
          message: "review transcript",
          retryable: false,
        },
        evidenceRef: "provider-alert-b",
      },
      {
        cursor: 16,
        sessionId: "session-1",
        timestampMonoMs: 116,
        lane: null,
        generation: null,
        type: "alert",
        alert: { code: "operator-only", message: "operator", retryable: true },
      },
      {
        cursor: 17,
        sessionId: "session-1",
        timestampMonoMs: 117,
        lane: "A_TO_B",
        generation: 1,
        type: "audio_playout",
        turnId: "turn-a",
        segmentId: "target-a",
        playoutSequence: 0,
        frame: createAudioFrame({
          sessionId: "session-1",
          lane: "A_TO_B",
          generation: 1,
          sequence: 0,
          capturedAtMs: 117,
          pcm16le: new Uint8Array(960),
        }),
        latencyMs: 42,
      },
    ];
    try {
      const tokenA = access.issueParticipantAccess("session-1", "A");
      const tokenB = access.issueParticipantAccess("session-1", "B");
      const a = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(tokenA),
        8,
      );
      const b = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(tokenB),
        8,
      );
      const cursors = (messages: readonly string[]) =>
        messages.map((message) => (JSON.parse(message) as { cursor: number }).cursor);
      assert.deepEqual(cursors(a.messages), [1, 2, 4, 7, 9, 10, 13, 15]);
      assert.deepEqual(cursors(b.messages), [1, 3, 5, 6, 8, 11, 12, 14]);
      const aEvents = a.messages.map((message) => JSON.parse(message) as {
        cursor: number;
        type: string;
        data: Record<string, unknown>;
      });
      const bEvents = b.messages.map((message) => JSON.parse(message) as {
        cursor: number;
        type: string;
        data: Record<string, unknown>;
      });
      assert.deepEqual(aEvents.find((event) => event.cursor === 4), {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 104,
        lane: "A_TO_B",
        generation: 1,
        type: "source_segment",
        data: {
          text: "from A",
          turnId: "turn-a",
          segmentId: "source-a",
          revision: 0,
          final: true,
          sourceSide: "A",
          targetSide: "B",
        },
      });
      const lowConfidence = aEvents.find((event) => event.cursor === 15);
      assert.equal(lowConfidence?.type, "terminology_alert");
      assert.equal(lowConfidence?.data.message, "An operational relay error occurred.");
      for (const event of [...aEvents, ...bEvents]) {
        if (event.type !== "generation_cut") continue;
        assert.equal("bargeId" in event.data, false);
      }
      assert.equal("evidenceRef" in (lowConfidence?.data ?? {}), false);
      for (const message of [...a.messages, ...b.messages]) {
        const envelope = JSON.parse(message) as { type: string; data: Record<string, unknown> };
        assert.notEqual(envelope.type, "latency");
        assert.equal("evidenceRef" in envelope.data, false);
      }
      a.socket.terminate();
      b.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("streams mapped events and delegates exact-side media sockets", async () => {
    const { app, relay, media, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 110,
      lane: null,
      generation: null,
      type: "participant_state",
      side: "A",
      connected: true,
    }];
    try {
      const eventPath = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
      const { socket: eventSocket, messages } = await openAndCollect(app, eventPath, 1);
      assert.deepEqual(JSON.parse(messages[0] ?? ""), {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 110,
        type: "participant_joined",
        data: { side: "A" },
      });
      if (eventSocket.readyState !== eventSocket.CLOSED) {
        const eventClosed = once(eventSocket, "close");
        eventSocket.terminate();
        await eventClosed;
      }

      const participantAccess = access.issueParticipantAccess("session-1", "A");
      const consent = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/participants/A/recording-processing-consent",
        headers: { authorization: "Bearer " + participantAccess },
        payload: {
          accepted: true,
          consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
        },
      });
      assert.equal(consent.statusCode, 202);
      const mediaSocket = await app.injectWS(
        "/ws/media/session-1/A?access=" + encodeURIComponent(participantAccess),
      );
      assert.equal(media.attached[0]?.sessionId, "session-1");
      assert.equal(media.attached[0]?.side, "A");
      const closed = once(mediaSocket, "close");
      mediaSocket.terminate();
      await closed;
      assert.equal(media.detached.length, 1);
    } finally {
      await app.close();
    }
  });

  it("streams authoritative consent and recorder state without synthetic recording state", async () => {
    const { app, relay } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
      processingManifest: processingManifest("balanced"),
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    };
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 100,
        lane: null,
        generation: null,
        type: "session_opened",
        snapshot: snapshot("session-1", spec),
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 110,
        lane: null,
        generation: null,
        type: "participant_consent",
        side: "A",
        consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
        consentPolicyRef: TEST_PROCESSING_PROFILE.consentPolicy,
        recording: true,
        processing: true,
        acceptedAtMonoMs: 110,
      },
      {
        cursor: 3,
        sessionId: "session-1",
        timestampMonoMs: 120,
        lane: null,
        generation: null,
        type: "participant_consent",
        side: "B",
        consentId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
        consentPolicyRef: TEST_PROCESSING_PROFILE.consentPolicy,
        recording: true,
        processing: true,
        acceptedAtMonoMs: 120,
      },
      {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 130,
        lane: null,
        generation: null,
        type: "recorder_state",
        previousState: "unarmed",
        state: "arming",
        armedTracks: [],
      },
      {
        cursor: 5,
        sessionId: "session-1",
        timestampMonoMs: 140,
        lane: null,
        generation: null,
        type: "recorder_state",
        previousState: "arming",
        state: "armed",
        armedTracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
      },
      {
        cursor: 6,
        sessionId: "session-1",
        timestampMonoMs: 150,
        lane: null,
        generation: null,
        type: "session_state",
        previousStatus: "waiting",
        status: "ready",
      },
    ];
    try {
      const path = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
      const { messages } = await openAndCollect(app, path, 6);
      const parsed = messages.map((message) => JSON.parse(message));
      assert.deepEqual(parsed.map((event) => event.type), [
        "session_state",
        "participant_consent",
        "participant_consent",
        "recorder_state",
        "recorder_state",
        "session_state",
      ]);
      assert.equal("recording" in parsed[0].data, false);
      assert.deepEqual(parsed[0].data, {
        state: "waiting",
        status: "waiting",
        processingDisclosure: {
          noticeVersion: TEST_PROCESSING_PROFILE.consentPolicy.noticeVersion,
          recording: true,
          processing: true,
          withdrawalTerminatesSession: true,
          provider: "openai_controlled",
          services: disclosedProcessingServices(),
        },
        evidenceIdentity: {
          deploymentBuildSha256: "b".repeat(64),
          processingProfile: {
            id: TEST_PROCESSING_PROFILE.id,
            version: TEST_PROCESSING_PROFILE.version,
            sha256: TEST_PROCESSING_PROFILE.sha256,
          },
          processingManifestSha256: processingManifest("balanced").manifestSha256,
          servicesSha256: processingManifest("balanced").selectedTranslation.servicesSha256,
        },
        participantReadiness: {},
        providerReadiness: {},
      });
      assert.deepEqual(parsed.slice(1, 3).map((event) => event.data), [
        {
          side: "A",
          accepted: true,
          recording: true,
          processing: true,
          noticeVersion: TEST_PROCESSING_PROFILE.consentPolicy.noticeVersion,
          acceptedAtMonoMs: 110,
        },
        {
          side: "B",
          accepted: true,
          recording: true,
          processing: true,
          noticeVersion: TEST_PROCESSING_PROFILE.consentPolicy.noticeVersion,
          acceptedAtMonoMs: 120,
        },
      ]);
      assert.deepEqual(parsed[3].data, {
        previousState: "unarmed",
        state: "arming",
        recordingArmed: false,
        armedTracks: [],
      });
      assert.deepEqual(parsed[4].data, {
        previousState: "arming",
        state: "armed",
        recordingArmed: true,
        armedTracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
      });
      assert.equal(parsed.some((event) => event.type === "recording_state"), false);
    } finally {
      await app.close();
    }
  });

  it("projects a withdrawal only to its participant and the operator without the consent receipt", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 175,
      lane: null,
      generation: null,
      type: "participant_consent_withdrawal",
      side: "A",
      consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
      withdrawalId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
      withdrawnAtMonoMs: 174,
      terminal: true,
    }];
    try {
      const operatorPath = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
      const participantAPath = "/ws/events/session-1?access=" +
        encodeURIComponent(access.issueParticipantAccess("session-1", "A"));
      const participantBPath = "/ws/events/session-1?access=" +
        encodeURIComponent(access.issueParticipantAccess("session-1", "B"));
      const [operator, participantA, participantB] = await Promise.all([
        openAndCollect(app, operatorPath, 1),
        openAndCollect(app, participantAPath, 1),
        openAndCollectUntilClose(app, participantBPath),
      ]);
      const expected = {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 175,
        type: "participant_consent_withdrawal",
        data: {
          side: "A",
          withdrawalId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
          withdrawnAtMonoMs: 174,
          terminal: true,
        },
      };
      assert.deepEqual(JSON.parse(operator.messages[0] ?? ""), expected);
      assert.deepEqual(JSON.parse(participantA.messages[0] ?? ""), expected);
      assert.deepEqual(participantB, []);
      assert.equal("consentId" in expected.data, false);
    } finally {
      await app.close();
    }
  });

  it("cancels event iterators on participant close and reconnect", async () => {
    const relay = new TrackingRelay();
    const glossaries = new FakeGlossaryRegistry();
    const media = new FakeBrowserMedia();
    const access = testAccess();
    const app = await createServerApp({
      relay,
      glossaries,
      mediaProfile: "browser_pair",
      browserMedia: media,
      access,
      translation,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    await openFakeSession(relay);
    try {
      const path = "/ws/events/session-1?access=" +
        encodeURIComponent(access.issueParticipantAccess("session-1", "A"));
      const first = await app.injectWS(path);
      const firstClosed = once(first, "close");
      first.terminate();
      await firstClosed;
      assert.equal(relay.streams.length, 1);
      assert.equal(relay.streams[0]?.returned, true);

      const second = await app.injectWS(path);
      const secondClosed = once(second, "close");
      second.terminate();
      await secondClosed;
      assert.equal(relay.streams.length, 2);
      assert.equal(relay.streams.every((stream) => stream.returned), true);
    } finally {
      await app.close();
    }
  });

  it("caps event subscriptions, releases capacity for reuse, and removes close listeners", async () => {
    const relay = new TrackingRelay();
    const glossaries = new FakeGlossaryRegistry();
    const media = new FakeBrowserMedia();
    const access = testAccess();
    const app = await createServerApp({
      relay,
      glossaries,
      mediaProfile: "browser_pair",
      browserMedia: media,
      access,
      translation,
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      artifacts: new FakeArtifactManagement(),
      evidenceReview: unavailableEvidenceReview,
    });
    await app.ready();
    await openFakeSession(relay);
    const path = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
    const sockets = await Promise.all(
      Array.from({ length: MAX_EVENT_SUBSCRIPTIONS_PER_SESSION }, () => app.injectWS(path)),
    );
    try {
      assert.equal(relay.streams.length, MAX_EVENT_SUBSCRIPTIONS_PER_SESSION);
      assert.equal(await websocketCloseCode(app, path), 1013);
      assert.equal(relay.streams.length, MAX_EVENT_SUBSCRIPTIONS_PER_SESSION);

      const firstSocket = sockets[0];
      assert.ok(firstSocket);
      const firstClosed = once(firstSocket, "close");
      firstSocket.terminate();
      await firstClosed;
      const replacement = await app.injectWS(path);
      assert.equal(relay.streams.length, MAX_EVENT_SUBSCRIPTIONS_PER_SESSION + 1);

      const replacementClosed = once(replacement, "close");
      replacement.terminate();
      await replacementClosed;
      for (const socket of sockets.slice(1)) {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
      assert.equal(relay.streams.every((stream) => stream.returned), true);
    } finally {
      await app.close();
    }

    const socket = new BackpressuredEventSocket();
    socket.bufferedAmount = 0;
    const pendingRelay = new TrackingRelay();
    let releases = 0;
    const streaming = streamEventSocket({
      socket,
      events: pendingRelay.events("session-1"),
      eventAccess: { kind: "operator" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      releaseSubscription: () => { releases += 1; },
    });
    socket.terminate();
    await streaming;
    assert.equal(releases, 1);
    assert.equal(socket.listenerCount("close"), 0);
  });

  it("bounds event WebSocket sends and cancels slow operator and participant subscriptions", async () => {
    const participantState = (cursor: number, side: Side): SessionEvent => ({
      cursor,
      sessionId: "session-1",
      timestampMonoMs: 100 + cursor,
      lane: null,
      generation: null,
      type: "participant_state",
      side,
      connected: true,
    });
    const operatorSocket = new BackpressuredEventSocket();
    const operatorEvents = new InspectableEventSubscription([
      participantState(1, "A"),
      participantState(2, "B"),
    ]);

    await streamEventSocket({
      socket: operatorSocket,
      events: operatorEvents,
      eventAccess: { kind: "operator" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    });

    assert.deepEqual(operatorSocket.closeCalls, [[1008, "Event stream backpressure"]]);
    assert.deepEqual(operatorSocket.sent, []);
    assert.equal(operatorEvents.nextCalls, 1);
    assert.equal(operatorEvents.returned, true);

    const participantSocket = new BackpressuredEventSocket();
    const participantEvents = new InspectableEventSubscription([
      participantState(1, "B"),
      participantState(2, "A"),
      participantState(3, "A"),
    ]);

    await streamEventSocket({
      socket: participantSocket,
      events: participantEvents,
      eventAccess: { kind: "participant", side: "A" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    });

    assert.deepEqual(participantSocket.closeCalls, [[1008, "Event stream backpressure"]]);
    assert.deepEqual(participantSocket.sent, []);
    assert.equal(
      participantEvents.nextCalls,
      2,
      "the invisible side-B event must not trigger a participant send or close",
    );
    assert.equal(participantEvents.returned, true);
  });

  it("redacts synchronous relay and iterator failures on event sockets", async () => {
    const unknownSessionSocket = new BackpressuredEventSocket();
    unknownSessionSocket.bufferedAmount = 0;
    await streamEventSocket({
      socket: unknownSessionSocket,
      events: () => {
        throw new RelaySessionError("invalid_session", "Unknown session private-id");
      },
      eventAccess: { kind: "operator" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    });
    const unknownSessionError = JSON.parse(unknownSessionSocket.sent[0] ?? "") as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(unknownSessionError.data, {
      code: "invalid_session",
      message: "The requested session was not found",
    });
    assert.doesNotMatch(unknownSessionSocket.sent[0] ?? "", /private-id/u);

    const throwingIteratorSocket = new BackpressuredEventSocket();
    throwingIteratorSocket.bufferedAmount = 0;
    const throwingIterator: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SessionEvent>> => {
          throw new Error("private iterator path");
        },
        return: async (): Promise<IteratorResult<SessionEvent>> => ({
          done: true,
          value: undefined,
        }),
      }),
    };
    await streamEventSocket({
      socket: throwingIteratorSocket,
      events: throwingIterator,
      eventAccess: { kind: "operator" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    });
    const iteratorError = JSON.parse(throwingIteratorSocket.sent[0] ?? "") as {
      data: Record<string, unknown>;
    };
    assert.deepEqual(iteratorError.data, {
      code: "event_stream_failed",
      message: "The event stream failed",
    });
    assert.doesNotMatch(throwingIteratorSocket.sent[0] ?? "", /private iterator path/u);

    const throwingCloseSocket = new BackpressuredEventSocket();
    throwingCloseSocket.bufferedAmount = 0;
    throwingCloseSocket.closeThrows = true;
    await streamEventSocket({
      socket: throwingCloseSocket,
      events: throwingIterator,
      eventAccess: { kind: "operator" },
      processingProfile: TEST_PROCESSING_PROFILE,
      deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    });
    assert.equal(throwingCloseSocket.terminateCalls, 1);
    assert.doesNotMatch(throwingCloseSocket.sent[0] ?? "", /private iterator path/u);
  });

  it("surfaces stale event cursors and subscriber overflow as session-scoped resync errors", async () => {
    for (const [code, message] of [
      ["event_cursor_gap", "Event history is unavailable for the requested cursor; resync is required"],
      ["event_stream_overflow", "Event stream fell behind; resync is required"],
    ] as const) {
      const socket = new BackpressuredEventSocket();
      socket.bufferedAmount = 0;
      await streamEventSocket({
        socket,
        sessionId: "session-1",
        events: () => {
          throw new RelaySessionError(
            code as unknown as RelaySessionError["code"],
            "private relay details",
          );
        },
        eventAccess: { kind: "operator" },
        processingProfile: TEST_PROCESSING_PROFILE,
        deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
      });
      const payload = JSON.parse(socket.sent[0] ?? "") as {
        cursor: number;
        sessionId: string;
        timestampMonoMs: number;
        type: string;
        data: Record<string, unknown>;
      };
      assert.equal(payload.cursor, 0);
      assert.equal(payload.sessionId, "session-1");
      assert.equal(payload.type, "error");
      assert.equal(Number.isFinite(payload.timestampMonoMs), true);
      assert.deepEqual(payload.data, { code, message });
      assert.doesNotMatch(socket.sent[0] ?? "", /private relay details/u);
    }
  });

  it("projects sequence-gap telemetry through the event socket contract", async () => {
    const { app, relay } = await fixture();
    relay.eventsForSession = [{
      cursor: 4,
      sessionId: "session-1",
      timestampMonoMs: 120,
      lane: "A_TO_B",
      generation: 2,
      type: "sequence_gap",
      stream: "source",
      expectedSequence: 4,
      actualSequence: 6,
      missingCount: 2,
      timelineAtMonoMs: 119,
    }];
    try {
      const eventPath = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
      const { socket, messages } = await openAndCollect(app, eventPath, 1);
      assert.deepEqual(JSON.parse(messages[0] ?? ""), {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 120,
        lane: "A_TO_B",
        generation: 2,
        type: "sequence_gap",
        data: {
          stream: "source",
          expectedSequence: 4,
          actualSequence: 6,
          missingCount: 2,
          timelineAtMonoMs: 119,
        },
      });
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("preserves playout segment identity for distinct segments in one generation", async () => {
    const { app, relay } = await fixture();
    relay.eventsForSession = [
      {
        cursor: 10,
        sessionId: "session-1",
        timestampMonoMs: 220,
        lane: "A_TO_B",
        generation: 4,
        type: "playout_lag",
        turnId: "turn-1",
        segmentId: "target:segment-1",
        revision: 0,
        scope: "server_to_audible_ack",
        side: "B",
        sequence: 20,
        audibleStartLagMs: 18,
      },
      {
        cursor: 11,
        sessionId: "session-1",
        timestampMonoMs: 221,
        lane: "A_TO_B",
        generation: 4,
        type: "playout_lag",
        turnId: "turn-2",
        segmentId: "target:segment-2",
        revision: 1,
        scope: "server_to_audible_ack",
        side: "B",
        sequence: 21,
        audibleStartLagMs: 19,
      },
    ];
    try {
      const { socket, messages } = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN),
        2,
      );
      assert.deepEqual(messages.map((message) => JSON.parse(message)), [
        {
          cursor: 10,
          sessionId: "session-1",
          timestampMonoMs: 220,
          lane: "A_TO_B",
          generation: 4,
          type: "playout_lag",
          data: {
            scope: "server_to_audible_ack",
            side: "B",
            sequence: 20,
            audibleStartLagMs: 18,
            turnId: "turn-1",
            segmentId: "target:segment-1",
            revision: 0,
            sourceSide: "A",
            targetSide: "B",
          },
        },
        {
          cursor: 11,
          sessionId: "session-1",
          timestampMonoMs: 221,
          lane: "A_TO_B",
          generation: 4,
          type: "playout_lag",
          data: {
            scope: "server_to_audible_ack",
            side: "B",
            sequence: 21,
            audibleStartLagMs: 19,
            turnId: "turn-2",
            segmentId: "target:segment-2",
            revision: 1,
            sourceSide: "A",
            targetSide: "B",
          },
        },
      ]);
      socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("counts UTF-8 event payload bytes against the WebSocket budget", () => {
    const serialize = (payload: string, counter: { calls: number }): (() => string) => () => {
      counter.calls += 1;
      return payload;
    };
    const atCapacity = new BackpressuredEventSocket();
    atCapacity.bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES;
    const atCapacitySerializations = { calls: 0 };

    assert.equal(sendBoundedEventSocketMessage(
      atCapacity,
      serialize("x", atCapacitySerializations),
    ), false);
    assert.equal(atCapacitySerializations.calls, 1);
    assert.deepEqual(atCapacity.sent, []);
    assert.deepEqual(atCapacity.closeCalls, [[1008, "Event stream backpressure"]]);

    const unicodePayload = "😀";
    assert.equal(Buffer.byteLength(unicodePayload, "utf8"), 4);
    const exactFit = new BackpressuredEventSocket();
    exactFit.bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES - 4;
    const exactFitSerializations = { calls: 0 };

    assert.equal(sendBoundedEventSocketMessage(
      exactFit,
      serialize(unicodePayload, exactFitSerializations),
    ), true);
    assert.equal(exactFitSerializations.calls, 1);
    assert.deepEqual(exactFit.sent, [unicodePayload]);
    assert.deepEqual(exactFit.closeCalls, []);

    const unicodeOverflow = new BackpressuredEventSocket();
    unicodeOverflow.bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES - 3;
    const unicodeOverflowSerializations = { calls: 0 };

    assert.equal(sendBoundedEventSocketMessage(
      unicodeOverflow,
      serialize(unicodePayload, unicodeOverflowSerializations),
    ), false);
    assert.equal(unicodeOverflowSerializations.calls, 1);
    assert.deepEqual(unicodeOverflow.sent, []);
    assert.deepEqual(unicodeOverflow.closeCalls, [[1008, "Event stream backpressure"]]);

    const afterOverflow = new BackpressuredEventSocket();
    afterOverflow.bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES - 1;
    const afterOverflowSerializations = { calls: 0 };

    assert.equal(sendBoundedEventSocketMessage(
      afterOverflow,
      serialize("x", afterOverflowSerializations),
    ), true);
    afterOverflow.bufferedAmount = MAX_EVENT_SOCKET_BUFFERED_BYTES;
    assert.equal(sendBoundedEventSocketMessage(
      afterOverflow,
      serialize("x", afterOverflowSerializations),
    ), false);
    assert.equal(afterOverflowSerializations.calls, 2);
    assert.deepEqual(afterOverflow.sent, ["x"]);
    assert.deepEqual(afterOverflow.closeCalls, [[1008, "Event stream backpressure"]]);
  });

  it("terminates when a backpressure close rejects", () => {
    const socket = new BackpressuredEventSocket();
    socket.closeThrows = true;
    assert.equal(sendBoundedEventSocketMessage(socket, () => "x"), false);
    assert.deepEqual(socket.closeCalls, [[1008, "Event stream backpressure"]]);
    assert.equal(socket.terminateCalls, 1);
  });

  it("closes missing or incorrectly scoped WebSocket access with policy violation", async () => {
    const { app, media, access } = await fixture();
    try {
      assert.equal(await websocketCloseCode(app, "/ws/events/session-1"), 1008);
      const otherSessionAccess = access.issueParticipantAccess("session-2", "A");
      const wrongSessionPath = "/ws/events/session-1?access=" +
        encodeURIComponent(otherSessionAccess);
      assert.equal(await websocketCloseCode(app, wrongSessionPath), 1008);
      const operatorMediaPath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(OPERATOR_TOKEN);
      assert.equal(await websocketCloseCode(app, operatorMediaPath), 1008);
      const sideBAccess = access.issueParticipantAccess("session-1", "B");
      const wrongSidePath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(sideBAccess);
      assert.equal(await websocketCloseCode(app, wrongSidePath), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });

  it("rejects old participant grants for unknown and terminal relay sessions", async () => {
    const { app, relay, media, access } = await fixture();
    try {
      const unknownAccess = access.issueParticipantAccess("evicted-session", "A");
      const unknownPath = "/ws/media/evicted-session/A?access=" +
        encodeURIComponent(unknownAccess);
      assert.equal(await websocketCloseCode(app, unknownPath), 1008);
      await openFakeSession(relay);
      relay.snapshotStatus = "closed";
      const closedAccess = access.issueParticipantAccess("session-1", "A");
      const closedPath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(closedAccess);
      assert.equal(await websocketCloseCode(app, closedPath), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });

  it("closes a rejected participant attachment with a policy violation", async () => {
    const { app, relay, media, access } = await fixture();
    await openFakeSession(relay);
    media.attachError = new Error("side already attached");
    try {
      const participantAccess = access.issueParticipantAccess("session-1", "A");
      const path = "/ws/media/session-1/A?access=" +
        encodeURIComponent(participantAccess);
      assert.equal(await websocketCloseCode(app, path), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });

});

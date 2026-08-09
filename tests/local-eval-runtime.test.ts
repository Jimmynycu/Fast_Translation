import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import WebSocket, { type RawData } from "ws";
import { FileGlossaryRepository } from "../src/adapters/glossary/file-repository.js";
import { createLocalEvalTranslationAdapter } from "../src/adapters/translation/local-eval.js";
import type { EvidenceReview } from "../src/adapters/evidence/review.js";
import { FileGlossaryRegistry } from "../src/composition.js";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import { deriveOpaqueTermId } from "../src/core/glossary.js";
import { ModularGuardedDuplexRelay } from "../src/core/relay.js";
import { createMediaRuntime } from "../src/media-runtime.js";
import { createServerAccessControl } from "../src/server/access.js";
import { createServerApp } from "../src/server/app.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";
import {
  AcceptanceEvidence,
  createTestOnlyVerifiedHumanSessionProcessingProfile,
  KeylessArtifactManagement,
  SYNTHETIC_DEPLOYMENT_BUILD_SHA256,
} from "./support/acceptance.js";

const WAIT_MS = 5_000;
const POKA_YOKE_OPAQUE_ID = deriveOpaqueTermId({
  source: "poka-yoke",
  aliases: ["mistake proofing"],
  targetExact: "防呆",
});
const keylessEvidenceReview: Pick<EvidenceReview, "review"> = Object.freeze({
  async review(_request) {
    return Object.freeze({ status: "not_found" as const });
  },
});
type JsonObject = Record<string, unknown>;

interface RunningHarness {
  readonly app: Awaited<ReturnType<typeof createServerApp>>;
  readonly events: JsonEventJournal;
  readonly relay: ModularGuardedDuplexRelay;
  readonly directory: string;
  readonly origin: string;
  readonly operatorToken: string;
  readonly sessionId: string;
  readonly eventSocket: WebSocket;
  readonly socketA: WebSocket;
  readonly socketB: WebSocket;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(message: JsonObject): JsonObject {
  return isObject(message.data) ? message.data : {};
}

function hasEntryId(data: JsonObject, entryId: string): boolean {
  return Array.isArray(data.entryIds) && data.entryIds.includes(entryId);
}

function hasText(data: JsonObject, expected: string): boolean {
  return typeof data.text === "string" && data.text.includes(expected);
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const output = new Uint8Array(data.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of data) {
      output.set(part, offset);
      offset += part.byteLength;
    }
    return output;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return address.port;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket connect timeout")), WAIT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await waitForSocketOpen(socket);
  return socket;
}

interface EventWaiter {
  readonly predicate: (message: JsonObject) => boolean;
  readonly resolve: (message: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Event replay is asynchronous after the WebSocket handshake. Retain it from
 * connection onward so a fast local-eval turn cannot pass between one-shot
 * test listeners.
 */
class JsonEventJournal {
  readonly #messages: JsonObject[] = [];
  readonly #waiters = new Set<EventWaiter>();
  #failure: Error | undefined;

  constructor(socket: WebSocket) {
    socket.on("message", this.#onMessage);
    socket.on("error", this.#onError);
  }

  waitFor(
    predicate: (message: JsonObject) => boolean,
    label: string,
  ): Promise<JsonObject> {
    const existing = this.#messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    if (this.#failure !== undefined) return Promise.reject(this.#failure);

    let waiter!: EventWaiter;
    return new Promise<JsonObject>((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error("Timed out waiting for " + label));
      }, WAIT_MS);
      waiter = { predicate, resolve: resolvePromise, reject, timer };
      this.#waiters.add(waiter);
    });
  }

  #onMessage = (raw: RawData, binary: boolean): void => {
    if (binary) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(rawBytes(raw)));
    } catch {
      return;
    }
    if (!isObject(parsed)) return;
    this.#messages.push(parsed);
    for (const waiter of [...this.#waiters]) {
      if (!waiter.predicate(parsed)) continue;
      clearTimeout(waiter.timer);
      this.#waiters.delete(waiter);
      waiter.resolve(parsed);
    }
  };

  #onError = (error: Error): void => {
    this.#failure = error;
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  };
}

function waitBinary(socket: WebSocket, label: string): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for " + label));
    }, WAIT_MS);
    const onMessage = (raw: RawData, binary: boolean): void => {
      if (!binary) return;
      cleanup();
      resolvePromise(Uint8Array.from(rawBytes(raw)));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
  });
}

async function postJson(
  origin: string,
  path: string,
  token: string,
  payload: unknown,
  status: number,
): Promise<JsonObject> {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.ok(isObject(body));
  return body;
}

function participantAccessToken(
  created: JsonObject,
  sessionId: string,
  side: "A" | "B",
): string {
  assert.ok(Array.isArray(created.endpointGrants));
  const grant = created.endpointGrants.find(
    (candidate) => isObject(candidate) && candidate.side === side,
  );
  assert.ok(isObject(grant) && typeof grant.url === "string");
  if (!isObject(grant) || typeof grant.url !== "string") throw new Error("missing grant");
  const participant = new URL(grant.url);
  assert.equal(participant.searchParams.get("sessionId"), sessionId);
  assert.equal(participant.searchParams.get("side"), side);
  const access = new URLSearchParams(participant.hash.slice(1)).get("access");
  assert.ok(access);
  if (access === null || access.length === 0) throw new Error("missing participant access token");
  return access;
}

function mediaUrl(
  created: JsonObject,
  origin: string,
  sessionId: string,
  side: "A" | "B",
): string {
  const access = participantAccessToken(created, sessionId, side);
  const url = new URL(`/ws/media/${encodeURIComponent(sessionId)}/${side}`, origin);
  url.protocol = "ws:";
  url.searchParams.set("access", access);
  return url.toString();
}

async function startHarness(
  translationMode: "preserve" | "drop_placeholders",
): Promise<RunningHarness> {
  const directory = resolve(process.cwd(), "work", "tmp", "local-eval-runtime", randomUUID());
  const port = await availablePort();
  const operatorToken = "local-eval-operator-0123456789abcdef";
  const origin = `http://127.0.0.1:${port}`;
  const access = createServerAccessControl({
    operatorToken,
    retentionOwner: {
      id: "test-data-owner",
      token: "local-eval-retention-owner-token-0123456789abcdef",
    },
    evidenceReviewer: {
      id: "test-bilingual-reviewer",
      token: "local-eval-evidence-reviewer-token-0123456789abcdef",
    },
  });
  const media = createMediaRuntime({
    profile: "browser_pair",
    publicBaseUrl: new URL(origin),
    access,
  });
  if (media.browserGateway === undefined) {
    throw new Error("The local evaluation runtime requires browser media");
  }
  const translation = createLocalEvalTranslationAdapter({
    transcriptByLane: {
      A_TO_B: "Verify the mistake proofing fixture.",
      B_TO_A: "請確認防呆治具。",
    },
    translationMode,
  });
  const processingProfile = createTestOnlyVerifiedHumanSessionProcessingProfile();
  const relay = new ModularGuardedDuplexRelay({
    media: media.port,
    translation,
    evidence: new AcceptanceEvidence(),
    processingProfile,
    endpointGrant: media.endpointGrant,
  });
  const app = await createServerApp({
    relay,
    glossaries: new FileGlossaryRegistry(new FileGlossaryRepository({
      directory,
      securityBoundaryDirectory: dirname(directory),
      strictAncestors: false,
      rootKey: Buffer.alloc(32, 19),
    })),
    mediaProfile: media.profile,
    browserMedia: media.browserGateway,
    access,
    translation: { ...translation.capabilities, defaultMode: "accurate" },
    processingProfile,
    deploymentBuildSha256: SYNTHETIC_DEPLOYMENT_BUILD_SHA256,
    artifacts: new KeylessArtifactManagement(),
    evidenceReview: keylessEvidenceReview,
    logger: false,
  });
  await app.listen({ host: "127.0.0.1", port });
  const csv = [
    "id,source,aliases,target_exact",
    "poka-yoke,poka-yoke,mistake proofing,防呆",
  ].join("\n");
  const imported = await postJson(origin, "/api/glossaries", operatorToken, {
    name: "Local Eval Terms",
    fileName: "local-eval.csv",
    contentsBase64: Buffer.from(csv).toString("base64"),
    sourceLanguage: "en-US",
    targetLanguage: "zh-TW",
    approvedBy: "Glossary Owner",
  }, 201);
  assert.equal(typeof imported.glossaryVersion, "string");
  const created = await postJson(origin, "/api/sessions", operatorToken, {
    languages: { A: "en-US", B: "zh-TW" },
    translationMode: "accurate",
    glossaryVersion: imported.glossaryVersion,
  }, 201);
  assert.equal(typeof created.sessionId, "string");
  if (typeof created.sessionId !== "string") throw new Error("missing session id");
  const sessionId = created.sessionId;
  const eventUrl = new URL(`/ws/events/${encodeURIComponent(sessionId)}`, origin);
  eventUrl.protocol = "ws:";
  eventUrl.searchParams.set("access", operatorToken);
  const eventSocket = new WebSocket(eventUrl.toString());
  const events = new JsonEventJournal(eventSocket);
  await waitForSocketOpen(eventSocket);
  await events.waitFor(
    (message) => message.type === "session_state" && dataOf(message).status === "waiting",
    "event stream subscription",
  );
  const participantAccessA = participantAccessToken(created, sessionId, "A");
  const participantAccessB = participantAccessToken(created, sessionId, "B");
  const consentA = events.waitFor(
    (message) => message.type === "participant_consent" &&
      dataOf(message).side === "A" &&
      dataOf(message).recording === true &&
      dataOf(message).processing === true,
    "participant A recording and processing consent",
  );
  const consentB = events.waitFor(
    (message) => message.type === "participant_consent" &&
      dataOf(message).side === "B" &&
      dataOf(message).recording === true &&
      dataOf(message).processing === true,
    "participant B recording and processing consent",
  );
  await Promise.all([
    postJson(
      origin,
      `/api/sessions/${sessionId}/participants/A/recording-processing-consent`,
      participantAccessA,
      { accepted: true, consentId: randomUUID() },
      202,
    ),
    postJson(
      origin,
      `/api/sessions/${sessionId}/participants/B/recording-processing-consent`,
      participantAccessB,
      { accepted: true, consentId: randomUUID() },
      202,
    ),
  ]);
  await Promise.all([consentA, consentB]);
  const joinedA = events.waitFor(
    (message) => message.type === "participant_joined" && dataOf(message).side === "A",
    "participant A joined",
  );
  const joinedB = events.waitFor(
    (message) => message.type === "participant_joined" && dataOf(message).side === "B",
    "participant B joined",
  );
  const [socketA, socketB] = await Promise.all([
    connect(mediaUrl(created, origin, sessionId, "A")),
    connect(mediaUrl(created, origin, sessionId, "B")),
  ]);
  await Promise.all([joinedA, joinedB]);
  const readinessA = events.waitFor(
    (message) => message.type === "participant_readiness" &&
      dataOf(message).side === "A" &&
      dataOf(message).source === "participant_browser_self_report" &&
      dataOf(message).microphone === "browser_capture_active" &&
      dataOf(message).headphones === "self_attested",
    "participant A readiness",
  );
  const readinessB = events.waitFor(
    (message) => message.type === "participant_readiness" &&
      dataOf(message).side === "B" &&
      dataOf(message).source === "participant_browser_self_report" &&
      dataOf(message).microphone === "browser_capture_active" &&
      dataOf(message).headphones === "self_attested",
    "participant B readiness",
  );
  await Promise.all([
    sendSocketMessage(socketA, JSON.stringify({
      type: "participant_readiness",
      source: "participant_browser_self_report",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false),
    sendSocketMessage(socketB, JSON.stringify({
      type: "participant_readiness",
      source: "participant_browser_self_report",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false),
  ]);
  await Promise.all([readinessA, readinessB]);
  const recorderArmed = events.waitFor(
    (message) => message.type === "recorder_state" &&
      dataOf(message).state === "armed" &&
      dataOf(message).recordingArmed === true,
    "armed recorder",
  );
  const ready = events.waitFor(
    (message) => message.type === "session_state" && dataOf(message).status === "ready",
    "ready",
  );
  const providerA = events.waitFor(
    (message) => message.type === "provider_readiness" &&
      message.lane === "A_TO_B" &&
      dataOf(message).readiness === "fixture_local" &&
      dataOf(message).remoteConnection === "not_applicable",
    "A_TO_B provider prewarm",
  );
  const providerB = events.waitFor(
    (message) => message.type === "provider_readiness" &&
      message.lane === "B_TO_A" &&
      dataOf(message).readiness === "fixture_local" &&
      dataOf(message).remoteConnection === "not_applicable",
    "B_TO_A provider prewarm",
  );
  await postJson(origin, `/api/sessions/${sessionId}/commands`, operatorToken, {
    kind: "arm_recorder",
    commandId: randomUUID(),
  }, 202);
  await Promise.all([recorderArmed, providerA, providerB, ready]);
  const active = events.waitFor(
    (message) => message.type === "session_state" && dataOf(message).status === "active",
    "active",
  );
  await postJson(origin, `/api/sessions/${sessionId}/commands`, operatorToken, {
    kind: "start",
    commandId: randomUUID(),
  }, 202);
  await active;
  return { app, events, relay, directory, origin, operatorToken, sessionId, eventSocket, socketA, socketB };
}

async function stopHarness(harness: RunningHarness): Promise<void> {
  await Promise.allSettled([
    closeSocket(harness.socketA),
    closeSocket(harness.socketB),
    closeSocket(harness.eventSocket),
  ]);
  await harness.relay.command(harness.sessionId, {
    type: "end",
    commandId: randomUUID(),
    reason: "local_evaluation_test_cleanup",
  }).catch(() => undefined);
  await harness.app.close();
  await rm(harness.directory, { recursive: true, force: true });
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolvePromise();
    }, 500);
    socket.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    socket.close();
  });
}

function sendSocketMessage(
  socket: WebSocket,
  message: string | Uint8Array,
  binary: boolean,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.send(message, { binary }, (error) => {
      if (error == null) {
        resolvePromise();
        return;
      }
      reject(error);
    });
  });
}

async function sendTurn(socket: WebSocket, fill: number): Promise<void> {
  await sendSocketMessage(socket, JSON.stringify({ type: "speech_start" }), false);
  await sendSocketMessage(
    socket,
    new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(fill),
    true,
  );
  await sendSocketMessage(socket, JSON.stringify({ type: "speech_end" }), false);
}

test("local_eval authorizes alias and reverse glossary through real HTTP and WebSockets", {
  timeout: 20_000,
}, async () => {
  const harness = await startHarness("preserve");
  try {
    const authorizedA = harness.events.waitFor(
      (message) => message.type === "terminology_gate" &&
        dataOf(message).status === "authorized" &&
        message.lane === "A_TO_B" && hasEntryId(dataOf(message), POKA_YOKE_OPAQUE_ID),
      "A_TO_B glossary authorization",
    );
    const targetA = harness.events.waitFor(
      (message) => message.type === "target_segment" &&
        message.lane === "A_TO_B" && hasText(dataOf(message), "防呆"),
      "A_TO_B target exact text",
    );
    const audioToB = waitBinary(harness.socketB, "A_TO_B canonical audio");
    await sendTurn(harness.socketA, 4);
    const [authorizationA, targetAEvent, packetB] = await Promise.all([authorizedA, targetA, audioToB]);
    assert.deepEqual(dataOf(authorizationA).entryIds, [POKA_YOKE_OPAQUE_ID]);
    assert.equal(hasText(dataOf(targetAEvent), "防呆"), true);
    const playoutB = unpackPlayoutAudio(packetB);
    assert.equal(playoutB.pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
    await sendSocketMessage(harness.socketB, JSON.stringify({
      type: "playout_started",
      generation: playoutB.generation,
      sequence: playoutB.sequence,
    }), false);

    const authorizedB = harness.events.waitFor(
      (message) => message.type === "terminology_gate" &&
        dataOf(message).status === "authorized" &&
        message.lane === "B_TO_A" && hasEntryId(dataOf(message), POKA_YOKE_OPAQUE_ID),
      "B_TO_A glossary authorization",
    );
    const targetB = harness.events.waitFor(
      (message) => message.type === "target_segment" &&
        message.lane === "B_TO_A" && hasText(dataOf(message), "poka-yoke"),
      "B_TO_A reverse target exact text",
    );
    const audioToA = waitBinary(harness.socketA, "B_TO_A canonical audio");
    await sendTurn(harness.socketB, 7);
    const [authorizationB, targetBEvent, packetA] = await Promise.all([authorizedB, targetB, audioToA]);
    assert.deepEqual(dataOf(authorizationB).entryIds, [POKA_YOKE_OPAQUE_ID]);
    assert.equal(hasText(dataOf(targetBEvent), "poka-yoke"), true);
    assert.equal(unpackPlayoutAudio(packetA).pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
  } finally {
    await stopHarness(harness);
  }
});

test("local_eval runtime fails open with alert and uninterrupted canonical audio", {
  timeout: 20_000,
}, async () => {
  const harness = await startHarness("drop_placeholders");
  try {
    const alert = harness.events.waitFor(
      (message) => message.type === "terminology_alert" &&
        dataOf(message).code === "GLOSSARY_PLACEHOLDER_MISSING",
      "placeholder fail-open alert",
    );
    const target = harness.events.waitFor(
      (message) => message.type === "target_segment" && message.lane === "A_TO_B",
      "fail-open target text",
    );
    const audio = waitBinary(harness.socketB, "fail-open canonical audio");
    await sendTurn(harness.socketA, 9);
    const [alertEvent, targetEvent, packet] = await Promise.all([alert, target, audio]);
    assert.equal(dataOf(alertEvent).code, "GLOSSARY_PLACEHOLDER_MISSING");
    assert.equal(dataOf(alertEvent).retryable, true);
    assert.equal(typeof dataOf(targetEvent).text, "string");
    assert.equal(unpackPlayoutAudio(packet).pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
  } finally {
    await stopHarness(harness);
  }
});

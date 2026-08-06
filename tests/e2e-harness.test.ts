import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import WebSocket, { type RawData } from "ws";
import { composeApplication } from "../src/composition.js";
import {
  EncryptedFileEvidenceStore,
  readEncryptedEvidence,
} from "../src/adapters/evidence/encrypted-file.js";
import { loadConfig } from "../src/config.js";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";
import type { EvidenceRecord } from "../src/core/types.js";

const WAIT_MS = 5_000;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolvePromise();
    });
  });

  const address = server.address();
  if (
    address === null ||
    typeof address === "string"
  ) {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error("Could not allocate an E2E server port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
  return address.port;
}

function messageData(message: JsonObject): JsonObject {
  return isObject(message.data) ? message.data : {};
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const length = data.reduce((total, part) => total + part.byteLength, 0);
    const joined = new Uint8Array(length);
    let offset = 0;
    for (const part of data) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function waitForJson(
  socket: WebSocket,
  predicate: (message: JsonObject) => boolean,
  label: string,
): Promise<JsonObject> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for " + label));
    }, WAIT_MS);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(rawBytes(data)));
      } catch {
        return;
      }
      if (!isObject(parsed) || !predicate(parsed)) return;
      cleanup();
      resolvePromise(parsed);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed while waiting for " + label));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function waitForBinary(socket: WebSocket, label: string): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for " + label));
    }, WAIT_MS);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (!isBinary) return;
      cleanup();
      resolvePromise(Uint8Array.from(rawBytes(data)));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed while waiting for " + label));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function expectNoBinary(
  socket: WebSocket,
  label: string,
  durationMs = 200,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, durationMs);
    const onMessage = (_data: RawData, isBinary: boolean): void => {
      if (!isBinary) return;
      cleanup();
      reject(new Error("Unexpected binary message: " + label));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed while checking " + label));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function expectNoJson(
  socket: WebSocket,
  predicate: (message: JsonObject) => boolean,
  label: string,
  durationMs = 200,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise();
    }, durationMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(rawBytes(data)));
      } catch {
        return;
      }
      if (!isObject(parsed) || !predicate(parsed)) return;
      cleanup();
      reject(new Error("Unexpected JSON message: " + label));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed while checking " + label));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

function collectBinary(
  socket: WebSocket,
  label: string,
  durationMs = 300,
): Promise<readonly Uint8Array[]> {
  return new Promise((resolvePromise, reject) => {
    const packets: Uint8Array[] = [];
    const timer = setTimeout(() => {
      cleanup();
      resolvePromise(Object.freeze(packets));
    }, durationMs);
    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (isBinary) packets.push(Uint8Array.from(rawBytes(data)));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Socket closed while collecting " + label));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}
async function connectWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error("Timed out connecting WebSocket " + url));
    }, WAIT_MS);
    const onOpen = (): void => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
  return socket;
}

async function closeWebSocket(socket: WebSocket | undefined): Promise<void> {
  if (socket === undefined || socket.readyState === WebSocket.CLOSED) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.terminate();
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolvePromise();
    }, 1_000);
    socket.once("close", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    socket.close(1000, "Test complete");
  });
}

async function postJson(
  origin: string,
  path: string,
  payload: unknown,
  expectedStatus: number,
  operatorToken: string,
): Promise<JsonObject> {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + operatorToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  assert.equal(
    response.status,
    expectedStatus,
    "Unexpected response from " + path + ": " + JSON.stringify(body),
  );
  assert.ok(isObject(body));
  return body;
}

function mediaUrlFromGrant(
  response: JsonObject,
  origin: string,
  sessionId: string,
  side: "A" | "B",
): string {
  const grants = response.endpointGrants;
  assert.ok(Array.isArray(grants));
  const grant = grants.find(
    (candidate) => isObject(candidate) && candidate.side === side,
  );
  assert.ok(isObject(grant));
  assert.equal(grant.kind, "browser_link");
  assert.equal(typeof grant.url, "string");
  if (typeof grant.url !== "string") throw new Error("Missing participant grant URL");

  const participantUrl = new URL(grant.url);
  assert.equal(participantUrl.origin, origin);
  assert.equal(participantUrl.searchParams.get("role"), "participant");
  assert.equal(participantUrl.searchParams.get("sessionId"), sessionId);
  assert.equal(participantUrl.searchParams.get("side"), side);
  const access = new URLSearchParams(participantUrl.hash.slice(1)).get("access");
  assert.ok(access);

  const mediaUrl = new URL(
    "/ws/media/" + encodeURIComponent(sessionId) + "/" + side,
    origin,
  );
  mediaUrl.protocol = mediaUrl.protocol === "https:" ? "wss:" : "ws:";
  mediaUrl.searchParams.set("access", access);
  return mediaUrl.toString();
}

test("production composition relays deterministic duplex audio over real HTTP and WebSockets", {
  timeout: 20_000,
}, async () => {
  const taskDirectory = resolve(process.cwd(), "work", "tmp", "e2e-harness", randomUUID());
  const evidenceDirectory = resolve(taskDirectory, "evidence");
  const evidenceKey = Buffer.alloc(32, 0x5a);
  const port = await getAvailablePort();
  const operatorToken = "e2e-operator-token-0123456789abcdef";
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://127.0.0.1:" + port,
    OPERATOR_TOKEN: operatorToken,
    TRANSLATION_PROFILE: "deterministic_test",
    EVIDENCE_PROFILE: "encrypted_local",
    EVIDENCE_DIRECTORY: evidenceDirectory,
    EVIDENCE_KEY_BASE64: evidenceKey.toString("base64"),
    GLOSSARY_DIRECTORY: resolve(taskDirectory, "glossaries"),
    LOG_LEVEL: "silent",
  });
  const composition = await composeApplication(config);
  let socketA: WebSocket | undefined;
  let socketB: WebSocket | undefined;
  let eventSocket: WebSocket | undefined;

  try {
    const origin = await composition.app.listen({
      host: "127.0.0.1",
      port,
    });
    const wsOrigin = origin.replace(/^http/u, "ws");
    const operatorLaunch = new URL(composition.operatorUrl);
    assert.equal(operatorLaunch.origin, origin);
    assert.equal(
      new URLSearchParams(operatorLaunch.hash.slice(1)).get("access"),
      operatorToken,
    );
    const created = await postJson(origin, "/api/sessions", {
      languages: { A: "en-US", B: "zh-TW" },
      translationProfileId: "deterministic_test",
      recordingConsent: true,
    }, 201, operatorToken);
    const sessionId = created.sessionId;
    assert.equal(typeof sessionId, "string");
    if (typeof sessionId !== "string") throw new Error("Missing sessionId");

    eventSocket = await connectWebSocket(
      wsOrigin + "/ws/events/" + encodeURIComponent(sessionId) +
        "?access=" + encodeURIComponent(operatorToken),
    );
    const readyEvent = waitForJson(
      eventSocket,
      (message) =>
        message.type === "session_state" &&
        messageData(message).status === "ready",
      "ready session event",
    );
    [socketA, socketB] = await Promise.all([
      connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "A")),
      connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "B")),
    ]);
    await readyEvent;

    const activeEvent = waitForJson(
      eventSocket,
      (message) =>
        message.type === "session_state" &&
        messageData(message).status === "active",
      "active session event",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "start",
      commandId: randomUUID(),
    }, 202, operatorToken);
    await activeEvent;

    const generationCut = waitForJson(
      eventSocket,
      (message) =>
        message.type === "generation_cut" &&
        message.lane === "A_TO_B" &&
        message.generation === 1,
      "first A_TO_B generation cut",
    );
    const sourceTranscript = waitForJson(
      eventSocket,
      (message) =>
        message.type === "source_partial" &&
        message.lane === "A_TO_B",
      "source transcript",
    );
    const targetTranscript = waitForJson(
      eventSocket,
      (message) =>
        message.type === "target_committed" &&
        message.lane === "A_TO_B",
      "target transcript",
    );
    const latencyEvent = waitForJson(
      eventSocket,
      (message) =>
        message.type === "latency" &&
        message.lane === "A_TO_B",
      "latency event",
    );
    const playout = waitForBinary(socketB, "B playout audio");

    const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x2a);
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(pcm, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));

    const [cut, source, target, packet] = await Promise.all([
      generationCut,
      sourceTranscript,
      targetTranscript,
      playout,
    ]);
    assert.equal(messageData(cut).reason, "operator");
    assert.equal(messageData(source).text, "[deterministic A_TO_B]");
    assert.equal(messageData(target).text, "[deterministic A_TO_B]");

    const unpacked = unpackPlayoutAudio(packet);
    assert.equal(unpacked.generation, 1);
    assert.equal(unpacked.sequence, 0);
    assert.deepEqual(unpacked.pcm16le, pcm);
    socketB.send(JSON.stringify({
      type: "playout_started",
      generation: unpacked.generation,
      sequence: unpacked.sequence,
    }));

    const latency = await latencyEvent;
    const latencyMs = messageData(latency).latencyMs;
    assert.equal(typeof latencyMs, "number");
    assert.ok(
      typeof latencyMs === "number" &&
        Number.isFinite(latencyMs) &&
        latencyMs >= 0 &&
        latencyMs < WAIT_MS,
      "Latency must use one monotonic clock domain, got " + String(latencyMs),
    );

    const bargeInCut = waitForJson(
      eventSocket,
      (message) =>
        message.type === "generation_cut" &&
        message.lane === "A_TO_B" &&
        messageData(message).reason === "barge_in",
      "A_TO_B barge-in generation cut",
    );
    const clearOnB = waitForJson(
      socketB,
      (message) =>
        message.type === "clear" &&
        message.generation === 2,
      "generation-aware clear on B",
    );
    socketB.send(JSON.stringify({ type: "speech_start" }));
    const [barge, clear] = await Promise.all([bargeInCut, clearOnB]);
    assert.equal(barge.generation, 2);
    assert.equal(clear.generation, 2);
    socketB.send(JSON.stringify({ type: "speech_end" }));

    const pcmA = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x31);
    const pcmB = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x52);
    const packetsToA = collectBinary(socketA, "simultaneous playout to A");
    const packetsToB = collectBinary(socketB, "simultaneous playout to B");
    const sourceA = waitForJson(
      eventSocket,
      (message) => message.type === "source_partial" && message.lane === "A_TO_B",
      "simultaneous A source transcript",
    );
    const sourceB = waitForJson(
      eventSocket,
      (message) => message.type === "source_partial" && message.lane === "B_TO_A",
      "simultaneous B source transcript",
    );
    const latencyA = waitForJson(
      eventSocket,
      (message) => message.type === "latency" && message.lane === "A_TO_B",
      "simultaneous A_TO_B latency",
    );
    const latencyB = waitForJson(
      eventSocket,
      (message) => message.type === "latency" && message.lane === "B_TO_A",
      "simultaneous B_TO_A latency",
    );

    const aStartFence = waitForJson(
      eventSocket,
      (message) =>
        message.type === "generation_cut" &&
        message.lane === "B_TO_A" &&
        messageData(message).reason === "barge_in",
      "A speech-start fence",
    );
    const bStartFence = waitForJson(
      eventSocket,
      (message) =>
        message.type === "generation_cut" &&
        message.lane === "A_TO_B" &&
        messageData(message).reason === "barge_in",
      "B speech-start fence",
    );
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketB.send(JSON.stringify({ type: "speech_start" }));
    await Promise.all([aStartFence, bStartFence]);
    socketA.send(pcmA, { binary: true });
    socketB.send(pcmB, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));
    socketB.send(JSON.stringify({ type: "speech_end" }));

    const [toA, toB] = await Promise.all([packetsToA, packetsToB]);
    assert.equal(toA.length, 1, "A must receive only B_TO_A playout");
    assert.equal(toB.length, 1, "B must receive only A_TO_B playout");
    const simultaneousToA = unpackPlayoutAudio(toA[0] ?? new Uint8Array());
    const simultaneousToB = unpackPlayoutAudio(toB[0] ?? new Uint8Array());
    assert.deepEqual(simultaneousToA.pcm16le, pcmB, "A received its own source audio");
    assert.deepEqual(simultaneousToB.pcm16le, pcmA, "B received its own source audio");
    assert.equal(messageData(await sourceA).text, "[deterministic A_TO_B]");
    assert.equal(messageData(await sourceB).text, "[deterministic B_TO_A]");

    socketA.send(JSON.stringify({
      type: "playout_started",
      generation: simultaneousToA.generation,
      sequence: simultaneousToA.sequence,
    }));
    socketB.send(JSON.stringify({
      type: "playout_started",
      generation: simultaneousToB.generation,
      sequence: simultaneousToB.sequence,
    }));
    await Promise.all([latencyA, latencyB]);

    const stalePcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x73);
    const stalePlayout = waitForBinary(socketB, "unacknowledged pre-pause playout");
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(stalePcm, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));
    const stalePacket = unpackPlayoutAudio(await stalePlayout);

    const pausedState = waitForJson(
      eventSocket,
      (message) =>
        message.type === "session_state" && messageData(message).status === "paused",
      "paused session event",
    );
    const pauseClear = waitForJson(
      socketB,
      (message) =>
        message.type === "clear" &&
        typeof message.generation === "number" &&
        message.generation > stalePacket.generation,
      "pause generation clear",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "pause",
      commandId: randomUUID(),
    }, 202, operatorToken);
    const [, cleared] = await Promise.all([pausedState, pauseClear]);
    assert.ok(
      typeof cleared.generation === "number" && cleared.generation > stalePacket.generation,
    );

    const staleAckIgnored = expectNoJson(
      eventSocket,
      (message) =>
        message.type === "latency" &&
        message.lane === "A_TO_B" &&
        message.generation === stalePacket.generation,
      "latency from stale generation ACK",
    );
    socketB.send(JSON.stringify({
      type: "playout_started",
      generation: stalePacket.generation,
      sequence: stalePacket.sequence,
    }));
    await staleAckIgnored;

    const noPausedPlayout = expectNoBinary(socketB, "audio sent while paused");
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x19), { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));
    await noPausedPlayout;

    const resumedState = waitForJson(
      eventSocket,
      (message) =>
        message.type === "session_state" && messageData(message).status === "active",
      "resumed session event",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "resume",
      commandId: randomUUID(),
    }, 202, operatorToken);
    await resumedState;

    const resumedPcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x24);
    const resumedPlayout = waitForBinary(socketB, "post-resume playout");
    const resumedLatency = waitForJson(
      eventSocket,
      (message) => message.type === "latency" && message.lane === "A_TO_B",
      "post-resume latency",
    );
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(resumedPcm, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));
    const resumedPacket = unpackPlayoutAudio(await resumedPlayout);
    assert.deepEqual(resumedPacket.pcm16le, resumedPcm);
    socketB.send(JSON.stringify({
      type: "playout_started",
      generation: resumedPacket.generation,
      sequence: resumedPacket.sequence,
    }));
    await resumedLatency;

    const participantLeft = waitForJson(
      eventSocket,
      (message) => message.type === "participant_left" && messageData(message).side === "A",
      "participant A disconnect",
    );
    await closeWebSocket(socketA);
    socketA = undefined;
    await participantLeft;
    const participantRejoined = waitForJson(
      eventSocket,
      (message) => message.type === "participant_joined" && messageData(message).side === "A",
      "participant A rejoin",
    );
    socketA = await connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "A"));
    await participantRejoined;

    const rejoinPcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x66);
    const rejoinPlayout = waitForBinary(socketA, "B_TO_A playout after A rejoins");
    const rejoinLatency = waitForJson(
      eventSocket,
      (message) => message.type === "latency" && message.lane === "B_TO_A",
      "B_TO_A latency after A rejoins",
    );
    socketB.send(JSON.stringify({ type: "speech_start" }));
    socketB.send(rejoinPcm, { binary: true });
    socketB.send(JSON.stringify({ type: "speech_end" }));
    const rejoinPacket = unpackPlayoutAudio(await rejoinPlayout);
    assert.deepEqual(rejoinPacket.pcm16le, rejoinPcm);
    socketA.send(JSON.stringify({
      type: "playout_started",
      generation: rejoinPacket.generation,
      sequence: rejoinPacket.sequence,
    }));
    await rejoinLatency;

    const closedEvent = waitForJson(
      eventSocket,
      (message) =>
        message.type === "session_state" &&
        messageData(message).status === "closed",
      "closed session event",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "end",
      commandId: randomUUID(),
    }, 202, operatorToken);
    await closedEvent;

    const evidencePath = new EncryptedFileEvidenceStore<EvidenceRecord>({
      directory: evidenceDirectory,
      key: evidenceKey,
    }).filePath(sessionId);
    const records = await readEncryptedEvidence<EvidenceRecord>(
      evidencePath,
      evidenceKey,
    );
    const audioRecords = records.filter((record): record is Extract<
      EvidenceRecord,
      { type: "audio" }
    > => record.type === "audio");
    assert.deepEqual(
      [...new Set(audioRecords.map((record) => record.track))].sort(),
      ["playout_to_a", "playout_to_b", "source_a", "source_b"],
      "recording evidence must contain all four duplex tracks",
    );
    const hasAudio = (
      track: Extract<EvidenceRecord, { type: "audio" }>["track"],
      expected: Uint8Array,
    ): boolean => audioRecords.some((record) =>
      record.track === track &&
      Buffer.from(record.frame.pcm16le).equals(Buffer.from(expected))
    );
    assert.equal(hasAudio("source_a", pcmA), true);
    assert.equal(hasAudio("playout_to_b", pcmA), true);
    assert.equal(hasAudio("source_b", pcmB), true);
    assert.equal(hasAudio("playout_to_a", pcmB), true);
    assert.equal(
      hasAudio("playout_to_b", stalePcm),
      false,
      "late ACK from a cut generation must not become playout evidence",
    );
    assert.ok(records.some((record) =>
      record.type === "session_event" && record.event.type === "session_closed"
    ));
  } finally {
    await Promise.all([
      closeWebSocket(socketA),
      closeWebSocket(socketB),
      closeWebSocket(eventSocket),
    ]);
    await composition.app.close();
    await rm(taskDirectory, { recursive: true, force: true });
  }
});

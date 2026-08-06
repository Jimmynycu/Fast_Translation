import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import WebSocket, { type RawData } from "ws";
import { composeApplication } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";

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
  const glossaryDirectory = resolve(
    process.cwd(),
    "work",
    "tmp",
    "e2e-harness",
    randomUUID(),
  );
  const port = await getAvailablePort();
  const operatorToken = "e2e-operator-token-0123456789abcdef";
  const config = loadConfig({
    PUBLIC_BASE_URL: "http://127.0.0.1:" + port,
    OPERATOR_TOKEN: operatorToken,
    TRANSLATION_PROFILE: "deterministic_test",
    EVIDENCE_PROFILE: "in_memory",
    GLOSSARY_DIRECTORY: glossaryDirectory,
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
  } finally {
    await Promise.all([
      closeWebSocket(socketA),
      closeWebSocket(socketB),
      closeWebSocket(eventSocket),
    ]);
    await composition.app.close();
    await rm(glossaryDirectory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import WebSocket, { type RawData } from "ws";
import { composeApplication, type ApplicationComposition } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";

const WAIT_MS = 5_000;
type JsonObject = Record<string, unknown>;

interface RunningHarness {
  readonly composition: ApplicationComposition;
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

async function connect(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
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
  return socket;
}

function waitJson(
  socket: WebSocket,
  predicate: (message: JsonObject) => boolean,
  label: string,
): Promise<JsonObject> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for " + label));
    }, WAIT_MS);
    const onMessage = (raw: RawData, binary: boolean): void => {
      if (binary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(rawBytes(raw)));
      } catch {
        return;
      }
      if (!isObject(parsed) || !predicate(parsed)) return;
      cleanup();
      resolvePromise(parsed);
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

function mediaUrl(
  created: JsonObject,
  origin: string,
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
  const access = new URLSearchParams(participant.hash.slice(1)).get("access");
  assert.ok(access);
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
  const config = loadConfig({
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    OPERATOR_TOKEN: operatorToken,
    TRANSLATION_PROFILE: "local_eval",
    LOCAL_EVAL_TRANSCRIPT_A_TO_B: "Verify the mistake proofing fixture.",
    LOCAL_EVAL_TRANSCRIPT_B_TO_A: "請確認防呆治具。",
    LOCAL_EVAL_TRANSLATION_MODE: translationMode,
    EVIDENCE_PROFILE: "in_memory",
    GLOSSARY_DIRECTORY: directory,
    LOG_LEVEL: "silent",
  });
  const composition = await composeApplication(config);
  const origin = await composition.app.listen({ host: "127.0.0.1", port });
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
    translationProfileId: "local_eval",
    glossaryVersion: imported.glossaryVersion,
    recordingConsent: true,
  }, 201);
  assert.equal(typeof created.sessionId, "string");
  if (typeof created.sessionId !== "string") throw new Error("missing session id");
  const sessionId = created.sessionId;
  const eventUrl = new URL(`/ws/events/${encodeURIComponent(sessionId)}`, origin);
  eventUrl.protocol = "ws:";
  eventUrl.searchParams.set("access", operatorToken);
  const eventSocket = await connect(eventUrl.toString());
  const ready = waitJson(
    eventSocket,
    (message) => message.type === "session_state" && dataOf(message).status === "ready",
    "ready",
  );
  const [socketA, socketB] = await Promise.all([
    connect(mediaUrl(created, origin, sessionId, "A")),
    connect(mediaUrl(created, origin, sessionId, "B")),
  ]);
  await ready;
  const active = waitJson(
    eventSocket,
    (message) => message.type === "session_state" && dataOf(message).status === "active",
    "active",
  );
  await postJson(origin, `/api/sessions/${sessionId}/commands`, operatorToken, {
    kind: "start",
    commandId: randomUUID(),
  }, 202);
  await active;
  return { composition, directory, origin, operatorToken, sessionId, eventSocket, socketA, socketB };
}

async function stopHarness(harness: RunningHarness): Promise<void> {
  await Promise.allSettled([
    closeSocket(harness.socketA),
    closeSocket(harness.socketB),
    closeSocket(harness.eventSocket),
  ]);
  await harness.composition.app.close();
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

function sendTurn(socket: WebSocket, fill: number): void {
  socket.send(JSON.stringify({ type: "speech_start" }));
  socket.send(new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(fill), { binary: true });
  socket.send(JSON.stringify({ type: "speech_end" }));
}

test("local_eval authorizes alias and reverse glossary through real HTTP and WebSockets", {
  timeout: 20_000,
}, async () => {
  const harness = await startHarness("preserve");
  try {
    const validatedA = waitJson(
      harness.eventSocket,
      (message) => message.type === "target_validated" &&
        message.lane === "A_TO_B" && dataOf(message).text?.toString().includes("防呆") === true,
      "A_TO_B target_exact",
    );
    const audioToB = waitBinary(harness.socketB, "A_TO_B canonical audio");
    sendTurn(harness.socketA, 4);
    const [resultA, packetB] = await Promise.all([validatedA, audioToB]);
    assert.deepEqual(dataOf(resultA).guaranteedTargetExact, ["防呆"]);
    const playoutB = unpackPlayoutAudio(packetB);
    assert.equal(playoutB.pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
    harness.socketB.send(JSON.stringify({
      type: "playout_started",
      generation: playoutB.generation,
      sequence: playoutB.sequence,
    }));

    const validatedB = waitJson(
      harness.eventSocket,
      (message) => message.type === "target_validated" &&
        message.lane === "B_TO_A" && dataOf(message).text?.toString().includes("poka-yoke") === true,
      "B_TO_A reverse target_exact",
    );
    const audioToA = waitBinary(harness.socketA, "B_TO_A canonical audio");
    sendTurn(harness.socketB, 7);
    const [resultB, packetA] = await Promise.all([validatedB, audioToA]);
    assert.deepEqual(dataOf(resultB).guaranteedTargetExact, ["poka-yoke"]);
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
    const alert = waitJson(
      harness.eventSocket,
      (message) => message.type === "terminology_alert" &&
        dataOf(message).code === "GLOSSARY_PLACEHOLDER_MISSING",
      "placeholder fail-open alert",
    );
    const target = waitJson(
      harness.eventSocket,
      (message) => message.type === "target_committed" && message.lane === "A_TO_B",
      "fail-open target text",
    );
    const audio = waitBinary(harness.socketB, "fail-open canonical audio");
    sendTurn(harness.socketA, 9);
    const [alertEvent, targetEvent, packet] = await Promise.all([alert, target, audio]);
    assert.equal(dataOf(alertEvent).code, "GLOSSARY_PLACEHOLDER_MISSING");
    assert.equal(typeof dataOf(targetEvent).text, "string");
    assert.equal(unpackPlayoutAudio(packet).pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
  } finally {
    await stopHarness(harness);
  }
});

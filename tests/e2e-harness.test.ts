import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { test } from "node:test";
import WebSocket, { type RawData } from "ws";
import { createPcmuSilenceFrame } from "../src/adapters/media/telephony-codec.js";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import type { GuardedDuplexRelay, SessionEvent } from "../src/core/types.js";
import { replayLocalEvalCorpus } from "../src/local-eval/corpus-replay.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";
import {
  ACCEPTANCE_MODES,
  acceptanceTemporaryDirectory,
  canonicalWav,
  createKeylessBrowserAcceptanceApplication,
  createKeylessTelephonyAcceptanceFixture,
  localEvalManifest,
  type AcceptanceMode,
  waitUntil,
} from "./support/acceptance.js";

const WAIT_MS = 5_000;

type JsonObject = Record<string, unknown>;

interface RelayEventCollector {
  readonly events: SessionEvent[];
  stop(): Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error("Could not allocate an E2E server port");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  return address.port;
}

function collectRelayEvents(relay: GuardedDuplexRelay, sessionId: string): RelayEventCollector {
  const controller = new AbortController();
  const events: SessionEvent[] = [];
  const complete = (async () => {
    try {
      for await (const event of relay.events(sessionId, 0, controller.signal)) {
        events.push(event);
      }
    } catch (error: unknown) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    events,
    async stop(): Promise<void> {
      controller.abort();
      await complete;
    },
  };
}

async function openActiveTelephonySession(
  fixture: ReturnType<typeof createKeylessTelephonyAcceptanceFixture>,
  mode: AcceptanceMode,
  maxQueueFrames = 3,
): Promise<Readonly<{ sessionId: string; collector: RelayEventCollector }>> {
  const snapshot = await fixture.relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode,
    maxQueueFrames,
  });
  const collector = collectRelayEvents(fixture.relay, snapshot.sessionId);
  fixture.media.connect(snapshot.sessionId, "A");
  fixture.media.connect(snapshot.sessionId, "B");
  await waitUntil(
    () => fixture.relay.snapshot(snapshot.sessionId).status === "ready",
    "Timed out waiting for fake telephony participants",
  );
  await fixture.relay.command(snapshot.sessionId, {
    type: "start",
    commandId: "start-" + randomUUID(),
  });
  assert.equal(fixture.relay.snapshot(snapshot.sessionId).status, "active");
  return Object.freeze({ sessionId: snapshot.sessionId, collector });
}

async function closeTelephonySession(
  fixture: ReturnType<typeof createKeylessTelephonyAcceptanceFixture>,
  sessionId: string,
  collector: RelayEventCollector,
): Promise<void> {
  try {
    await fixture.relay.command(sessionId, {
      type: "end",
      commandId: "end-" + randomUUID(),
    });
  } finally {
    await collector.stop();
  }
}

function transcriptEvents(
  events: readonly SessionEvent[],
  type: "source_transcript" | "target_transcript",
  lane: "A_TO_B" | "B_TO_A",
): Extract<SessionEvent, { type: "source_transcript" | "target_transcript" }>[] {
  return events.filter((event): event is Extract<SessionEvent, {
    type: "source_transcript" | "target_transcript";
  }> => event.type === type && event.lane === lane);
}

function audioEventsFor(
  events: readonly SessionEvent[],
  lane: "A_TO_B" | "B_TO_A",
): Extract<SessionEvent, { type: "audio_playout" }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: "audio_playout" }> =>
    event.type === "audio_playout" && event.lane === lane
  );
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

function expectNoJson(
  socket: WebSocket,
  predicate: (message: JsonObject) => boolean,
  label: string,
  durationMs = 250,
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
  assert.equal(response.status, expectedStatus, "Unexpected response from " + path);
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
  const grant = grants.find((candidate) => isObject(candidate) && candidate.side === side);
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

test("keyless deterministic acceptance exercises Fast, Balanced, and Accurate modes", {
  timeout: 20_000,
}, async () => {
  for (const mode of ACCEPTANCE_MODES) {
    const fixture = createKeylessTelephonyAcceptanceFixture();
    const { sessionId, collector } = await openActiveTelephonySession(fixture, mode);
    try {
      fixture.media.speechStarted(sessionId, "A");
      fixture.media.speechStarted(sessionId, "B");
      fixture.media.ingestMulaw(sessionId, "A", 0, createPcmuSilenceFrame());
      fixture.media.ingestMulaw(sessionId, "B", 0, createPcmuSilenceFrame());
      fixture.media.speechEnded(sessionId, "A");
      fixture.media.speechEnded(sessionId, "B");

      await waitUntil(
        () => fixture.media.outbound(sessionId, "A").some((event) => event.type === "audio") &&
          fixture.media.outbound(sessionId, "B").some((event) => event.type === "audio"),
        "Timed out waiting for both deterministic translated lanes in " + mode,
      );

      assert.equal(fixture.translation.prepared.length, 2);
      assert.equal(fixture.translation.requests.length, 2);
      for (const context of fixture.translation.requests) {
        assert.equal(context.behavior.mode, mode);
        assert.equal(
          context.behavior.inputCommit,
          mode === "accurate" ? "speech_end" : "continuous",
        );
        assert.equal(
          context.behavior.transcriptPolicy,
          mode === "fast" ? "provisional_revisions" : "final_only",
        );
      }

      const source = transcriptEvents(collector.events, "source_transcript", "A_TO_B");
      const target = transcriptEvents(collector.events, "target_transcript", "A_TO_B");
      if (mode === "fast") {
        assert.deepEqual(
          source.map((event) => [event.revision, event.final, event.text]),
          [
            [0, false, "[fast source A_TO_B 0] draft"],
            [1, true, "[fast source A_TO_B 0] replacement"],
          ],
          "Fast must surface one replaceable segment followed by its terminal revision",
        );
        assert.deepEqual(
          target.map((event) => [event.revision, event.final, event.text]),
          [
            [0, false, "[fast target A_TO_B 0] draft"],
            [1, true, "[fast target A_TO_B 0] replacement"],
          ],
        );
        assert.equal(
          source.some((event) => event.text.includes("rejected-after-final")),
          false,
          "A terminal segment must reject a later provider revision",
        );
      } else {
        assert.deepEqual(source.map((event) => [event.revision, event.final]), [[0, true]]);
        assert.deepEqual(target.map((event) => [event.revision, event.final]), [[0, true]]);
      }

      assert.deepEqual(
        fixture.evidence.audioTracks(sessionId),
        ["playout_to_a", "playout_to_b", "source_a", "source_b"],
        "each deterministic mode must retain independent source and destination tracks",
      );
    } finally {
      await closeTelephonySession(fixture, sessionId, collector);
    }
  }
});

test("keyless relay acceptance fences stale audio, keeps capture lanes independent, bounds queues, and reconnects", {
  timeout: 20_000,
}, async () => {
  const fixture = createKeylessTelephonyAcceptanceFixture();
  const { sessionId, collector } = await openActiveTelephonySession(fixture, "fast", 1);
  try {
    fixture.media.ingestDtmf(sessionId, "A", "5");
    fixture.media.emitAlert(sessionId, "B", "carrier_notice", "Deterministic carrier notice", true);
    await waitUntil(
      () => collector.events.filter((event) =>
        event.type === "alert" &&
        (event.alert.code === "telephony_dtmf_received" || event.alert.code === "carrier_notice")
      ).length === 2,
      "Telephony alerts did not become relay events",
    );
    assert.equal(
      fixture.evidence.records.filter((record) =>
        record.type === "session_event" &&
        record.event.type === "alert" &&
        (record.event.alert.code === "telephony_dtmf_received" || record.event.alert.code === "carrier_notice")
      ).length,
      2,
      "telephony alerts must be retained in session evidence without synthetic audio",
    );

    fixture.translation.holdNextFrame("A_TO_B");
    fixture.media.speechStarted(sessionId, "A");
    fixture.media.ingestMulaw(sessionId, "A", 0, createPcmuSilenceFrame());
    await fixture.translation.waitForHeldFrame("A_TO_B");

    fixture.media.ingestMulaw(sessionId, "A", 1, createPcmuSilenceFrame());
    fixture.media.ingestMulaw(sessionId, "A", 2, createPcmuSilenceFrame());
    fixture.media.ingestMulaw(sessionId, "A", 3, createPcmuSilenceFrame());
    await waitUntil(
      () => collector.events.some((event) =>
        event.type === "alert" && event.alert.code === "source_queue_trimmed"
      ),
      "A bounded source queue did not report trimming",
    );

    const outboundAStart = fixture.media.outbound(sessionId, "A").length;
    const outboundBStart = fixture.media.outbound(sessionId, "B").length;
    fixture.media.speechStarted(sessionId, "B");
    await waitUntil(
      () => collector.events.some((event) =>
        event.type === "generation_cut" &&
        event.lane === "A_TO_B" &&
        event.generation === 1 &&
        event.reason === "barge_in"
      ),
      "B speech did not cut the A-to-B destination lane",
    );
    await waitUntil(
      () => fixture.media.outbound(sessionId, "B").slice(outboundBStart).some((event) =>
        event.type === "clear" && event.generation === 1
      ),
      "B did not receive the generation-aware interruption clear",
    );
    assert.equal(
      fixture.media.outbound(sessionId, "A").slice(outboundAStart).some((event) => event.type === "clear"),
      false,
      "B barge-in must not clear the unrelated destination A",
    );

    fixture.translation.releaseHeldFrame("A_TO_B");
    await waitUntil(
      () => fixture.translation.cancelled.some((generation) =>
        generation.lane === "A_TO_B" && generation.generation === 0
      ),
      "The stale A-to-B generation was not cancelled",
    );
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    assert.equal(
      fixture.media.outbound(sessionId, "B").slice(outboundBStart).some((event) =>
        event.type === "audio" && event.generation === 0
      ),
      false,
      "A late provider event must never revive a cut destination generation",
    );
    assert.equal(
      audioEventsFor(collector.events, "A_TO_B").some((event) => event.generation === 0),
      false,
      "No stale A-to-B playout event may escape the generation fence",
    );

    fixture.media.ingestMulaw(sessionId, "A", 4, createPcmuSilenceFrame());
    fixture.media.ingestMulaw(sessionId, "B", 0, createPcmuSilenceFrame());
    fixture.media.speechEnded(sessionId, "A");
    fixture.media.speechEnded(sessionId, "B");
    await waitUntil(
      () => fixture.media.outbound(sessionId, "A").some((event) =>
        event.type === "audio" && event.generation === 1
      ) && fixture.media.outbound(sessionId, "B").some((event) =>
        event.type === "audio" && event.generation === 1
      ),
      "Both capture paths did not remain available after the targeted barge-in",
    );
    assert.deepEqual(fixture.evidence.audioTracks(sessionId), [
      "playout_to_a",
      "playout_to_b",
      "source_a",
      "source_b",
    ]);

    const audioToABeforeReconnect = fixture.media.outbound(sessionId, "A")
      .filter((event) => event.type === "audio").length;
    fixture.media.reconnect(sessionId, "A");
    await waitUntil(
      () => collector.events.some((event) =>
        event.type === "participant_state" && event.side === "A" && !event.connected
      ) && collector.events.some((event) =>
        event.type === "participant_state" && event.side === "A" && event.connected
      ),
      "A reconnection did not retain its participant state transitions",
    );
    const bToACutsBeforeReconnectTurn = collector.events.filter((event) =>
      event.type === "generation_cut" && event.lane === "B_TO_A"
    ).length;
    // Force a new B-to-A generation after the reconnect. Besides modelling a
    // normal resumed turn, this makes the assertion independent of the prior
    // turn's asynchronous iterator finishing first.
    fixture.media.speechStarted(sessionId, "A");
    fixture.media.speechEnded(sessionId, "A");
    await waitUntil(
      () => collector.events.filter((event) =>
        event.type === "generation_cut" && event.lane === "B_TO_A" &&
        event.reason === "barge_in"
      ).length > bToACutsBeforeReconnectTurn,
      "A reconnect turn did not open a fresh B-to-A generation",
    );
    fixture.media.speechStarted(sessionId, "B");
    fixture.media.ingestMulaw(sessionId, "B", 1, createPcmuSilenceFrame());
    fixture.media.speechEnded(sessionId, "B");
    await waitUntil(
      () => fixture.media.outbound(sessionId, "A").filter((event) => event.type === "audio").length >
        audioToABeforeReconnect,
      "B-to-A media did not resume after A reconnected",
    );
  } finally {
    await closeTelephonySession(fixture, sessionId, collector);
  }
});

test("keyless local evaluation reports mechanism PASS while live provider remains NOT_RUN", {
  timeout: 20_000,
}, async () => {
  const directory = acceptanceTemporaryDirectory("local-eval-verification");
  const manifestPath = resolve(directory, "manifest.json");
  const wav = canonicalWav();
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "acceptance.wav"), wav),
    writeFile(manifestPath, JSON.stringify(localEvalManifest(wav)), "utf8"),
  ]);
  try {
    const report = await replayLocalEvalCorpus({
      manifestPath,
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
    });
    assert.equal(report.claims.providerCalls, 0);
    assert.deepEqual(report.verification, {
      mechanism: "PASS",
      liveProvider: "NOT_RUN",
      overall: "NOT_RUN",
      liveProviderRequiredServerKey: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real HTTP and WebSocket acceptance stays keyless while carrying duplex revisions and four tracks", {
  timeout: 25_000,
}, async () => {
  const port = await getAvailablePort();
  const origin = "http://127.0.0.1:" + port;
  const fixture = await createKeylessBrowserAcceptanceApplication(origin, "fast");
  let socketA: WebSocket | undefined;
  let socketB: WebSocket | undefined;
  let eventSocket: WebSocket | undefined;

  try {
    const listenedOrigin = await fixture.app.listen({ host: "127.0.0.1", port });
    assert.equal(listenedOrigin, origin);
    const capabilitiesResponse = await fetch(origin + "/api/capabilities", {
      headers: { authorization: "Bearer " + fixture.operatorToken },
    });
    assert.equal(capabilitiesResponse.status, 200);
    const capabilities: unknown = await capabilitiesResponse.json();
    assert.ok(isObject(capabilities));
    assert.ok(isObject(capabilities.translation));
    assert.equal(capabilities.translation.provider, "openai_controlled");
    assert.deepEqual(
      (capabilities.translation.supportedModes as Array<{ mode?: unknown }>).map((mode) => mode.mode),
      ["fast", "balanced", "accurate"],
    );

    const created = await postJson(origin, "/api/sessions", {
      languages: { A: "en-US", B: "zh-TW" },
      translationMode: "fast",
      recordingConsent: true,
    }, 201, fixture.operatorToken);
    const sessionId = created.sessionId;
    assert.equal(typeof sessionId, "string");
    if (typeof sessionId !== "string") throw new Error("Missing sessionId");
    assert.equal(created.provider, "openai_controlled");
    assert.equal(created.translationMode, "fast");

    const wsOrigin = origin.replace(/^http/u, "ws");
    eventSocket = await connectWebSocket(
      wsOrigin + "/ws/events/" + encodeURIComponent(sessionId) +
        "?access=" + encodeURIComponent(fixture.operatorToken),
    );
    const readyEvent = waitForJson(
      eventSocket,
      (message) => message.type === "session_state" && messageData(message).status === "ready",
      "ready session event",
    );
    [socketA, socketB] = await Promise.all([
      connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "A")),
      connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "B")),
    ]);
    await readyEvent;

    const activeEvent = waitForJson(
      eventSocket,
      (message) => message.type === "session_state" && messageData(message).status === "active",
      "active session event",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "start",
      commandId: randomUUID(),
    }, 202, fixture.operatorToken);
    await activeEvent;

    const sourceDraft = waitForJson(
      eventSocket,
      (message) => message.type === "source_segment" && message.lane === "A_TO_B" &&
        messageData(message).revision === 0 && messageData(message).final === false,
      "provisional source segment",
    );
    const sourceFinal = waitForJson(
      eventSocket,
      (message) => message.type === "source_segment" && message.lane === "A_TO_B" &&
        messageData(message).revision === 1 && messageData(message).final === true,
      "terminal replacement source segment",
    );
    const targetFinal = waitForJson(
      eventSocket,
      (message) => message.type === "target_segment" && message.lane === "A_TO_B" &&
        messageData(message).revision === 1 && messageData(message).final === true,
      "terminal replacement target segment",
    );
    const firstPlayout = waitForBinary(socketB, "A-to-B playout");
    const firstLatency = waitForJson(
      eventSocket,
      (message) => message.type === "latency" && message.lane === "A_TO_B",
      "A-to-B latency",
    );
    const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x2a);
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(pcm, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));

    const [draft, replacement, target, firstPacket] = await Promise.all([
      sourceDraft,
      sourceFinal,
      targetFinal,
      firstPlayout,
    ]);
    assert.equal(messageData(draft).text, "[fast source A_TO_B 0] draft");
    assert.equal(messageData(replacement).text, "[fast source A_TO_B 0] replacement");
    assert.equal(messageData(target).text, "[fast target A_TO_B 0] replacement");
    assert.equal(messageData(draft).segmentId, messageData(replacement).segmentId);
    const unpacked = unpackPlayoutAudio(firstPacket);
    assert.deepEqual(unpacked.pcm16le, pcm);
    socketB.send(JSON.stringify({
      type: "playout_started",
      generation: unpacked.generation,
      sequence: unpacked.sequence,
    }));
    await firstLatency;

    const bargeCut = waitForJson(
      eventSocket,
      (message) => message.type === "generation_cut" && message.lane === "A_TO_B" &&
        messageData(message).reason === "barge_in",
      "A-to-B barge-in cut",
    );
    const clearB = waitForJson(
      socketB,
      (message) => message.type === "clear" && typeof message.generation === "number",
      "targeted clear to B",
    );
    const noClearA = expectNoJson(
      socketA,
      (message) => message.type === "clear",
      "clear sent to unaffected destination A",
    );
    socketB.send(JSON.stringify({ type: "speech_start" }));
    const [barge, clear] = await Promise.all([bargeCut, clearB]);
    assert.equal(barge.generation, clear.generation);
    await noClearA;
    socketB.send(JSON.stringify({ type: "speech_end" }));

    const packetsToA = collectBinary(socketA, "simultaneous playout to A");
    const packetsToB = collectBinary(socketB, "simultaneous playout to B");
    const pcmA = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x31);
    const pcmB = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x52);
    socketA.send(JSON.stringify({ type: "speech_start" }));
    socketB.send(JSON.stringify({ type: "speech_start" }));
    socketA.send(pcmA, { binary: true });
    socketB.send(pcmB, { binary: true });
    socketA.send(JSON.stringify({ type: "speech_end" }));
    socketB.send(JSON.stringify({ type: "speech_end" }));
    const [toA, toB] = await Promise.all([packetsToA, packetsToB]);
    assert.equal(toA.length, 1, "A must receive only B-to-A playout");
    assert.equal(toB.length, 1, "B must receive only A-to-B playout");
    const simultaneousToA = unpackPlayoutAudio(toA[0] ?? new Uint8Array());
    const simultaneousToB = unpackPlayoutAudio(toB[0] ?? new Uint8Array());
    assert.deepEqual(simultaneousToA.pcm16le, pcmB);
    assert.deepEqual(simultaneousToB.pcm16le, pcmA);
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

    const participantLeft = waitForJson(
      eventSocket,
      (message) => message.type === "participant_left" && messageData(message).side === "A",
      "participant A disconnect",
    );
    await closeWebSocket(socketA);
    socketA = undefined;
    await participantLeft;
    const participantJoined = waitForJson(
      eventSocket,
      (message) => message.type === "participant_joined" && messageData(message).side === "A",
      "participant A reconnect",
    );
    socketA = await connectWebSocket(mediaUrlFromGrant(created, origin, sessionId, "A"));
    await participantJoined;

    const reconnectPacket = waitForBinary(socketA, "B-to-A playout after reconnect");
    const reconnectPcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(0x66);
    socketB.send(JSON.stringify({ type: "speech_start" }));
    socketB.send(reconnectPcm, { binary: true });
    socketB.send(JSON.stringify({ type: "speech_end" }));
    const rejoinedAudio = unpackPlayoutAudio(await reconnectPacket);
    assert.deepEqual(rejoinedAudio.pcm16le, reconnectPcm);
    socketA.send(JSON.stringify({
      type: "playout_started",
      generation: rejoinedAudio.generation,
      sequence: rejoinedAudio.sequence,
    }));

    await waitUntil(
      () => fixture.evidence.audioTracks(sessionId).length === 4,
      "WebSocket path did not retain all four audio evidence tracks",
    );
    const closedEvent = waitForJson(
      eventSocket,
      (message) => message.type === "session_state" && messageData(message).status === "closed",
      "closed session event",
    );
    await postJson(origin, "/api/sessions/" + sessionId + "/commands", {
      kind: "end",
      commandId: randomUUID(),
    }, 202, fixture.operatorToken);
    await closedEvent;
    assert.deepEqual(fixture.evidence.audioTracks(sessionId), [
      "playout_to_a",
      "playout_to_b",
      "source_a",
      "source_b",
    ]);
  } finally {
    await Promise.all([
      closeWebSocket(socketA),
      closeWebSocket(socketB),
      closeWebSocket(eventSocket),
    ]);
    await fixture.app.close();
  }
});

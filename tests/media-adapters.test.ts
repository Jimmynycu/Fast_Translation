import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createPcmuSilenceFrame,
  encodeMulawSample,
} from "../src/adapters/media/telephony-codec.js";
import {
  BrowserMediaProtocolError,
  BrowserWebSocketMediaPort,
  type BrowserSocketLike,
} from "../src/adapters/media/browser-websocket.js";
import {
  FakeTelephonyMediaPort,
  TelephonyConnectionError,
  TelephonySequenceError,
} from "../src/adapters/media/fake-telephony.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { unpackPlayoutAudio } from "../src/server/protocol.js";

type Listener = (...args: readonly unknown[]) => void;

class FakeSocket implements BrowserSocketLike {
  readonly sent: Array<string | Uint8Array> = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readyState = 1;

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : Uint8Array.from(data));
  }

  message(data: string | Uint8Array, isBinary: boolean): void {
    this.#emit("message", data, isBinary);
  }

  close(): void {
    this.readyState = 3;
    this.#emit("close");
  }

  #emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

function frame(sessionId: string, generation = 2, sequence = 9) {
  return createAudioFrame({
    sessionId,
    lane: "A_TO_B",
    generation,
    sequence,
    capturedAtMs: 100,
    pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(7),
  });
}

describe("BrowserWebSocketMediaPort", () => {
  it("turns browser controls and exact canonical packets into bounded ingress events", async () => {
    const errors: Error[] = [];
    const media = new BrowserWebSocketMediaPort({
      now: () => 123.5,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "session-1", signal: controller.signal })[Symbol.asyncIterator]();

    const connected = events.next();
    media.attach("session-1", "A", socket);
    assert.deepEqual(await connected, {
      done: false,
      value: {
        type: "participant_state",
        sessionId: "session-1",
        side: "A",
        timestampMonoMs: 123.5,
        connected: true,
      },
    });

    const speech = events.next();
    socket.message(JSON.stringify({ type: "speech_start" }), false);
    assert.equal((await speech).value?.type, "speech_started");

    const audio = events.next();
    socket.message(new Uint8Array(960).fill(4), true);
    const audioEvent = (await audio).value;
    assert.equal(audioEvent?.type, "audio");
    if (audioEvent?.type === "audio") {
      assert.equal(audioEvent.frame.lane, "A_TO_B");
      assert.equal(audioEvent.frame.generation, 0);
      assert.equal(audioEvent.frame.sequence, 0);
      assert.equal(audioEvent.frame.capturedAtMs, 123.5);
      assert.equal(audioEvent.frame.pcm16le.byteLength, 960);
    }

    socket.message(new Uint8Array(959), true);
    socket.message("not-json", false);
    assert.equal(errors.length, 2);
    assert.match(errors[0]?.message ?? "", /960/);
    controller.abort();
    await events.return?.();
  });

  it("drops overflow without advancing the accepted media sequence", async () => {
    const errors: Error[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    media.attach("bounded", "A", socket);
    socket.message(new Uint8Array(960), true);
    assert.equal(errors[0]?.name, "BrowserMediaProtocolError");
    assert.match(errors[0]?.message ?? "", /full/);

    const controller = new AbortController();
    const events = media.frames({ sessionId: "bounded", signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(new Uint8Array(960), true);
    const accepted = (await events.next()).value;
    assert.equal(accepted?.type, "audio");
    if (accepted?.type === "audio") assert.equal(accepted.frame.sequence, 0);
    controller.abort();
    await events.return?.();
  });

  it("packs translated audio and sends generation-aware clear messages", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      now: () => 200,
      onProtocolError: (error) => errors.push(error),
    });
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    media.attach("session-2", "A", socketA);
    media.attach("session-2", "B", socketB);

    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started: Array<{ sequence: number; at: number }> = [];
    const play = media.play({
      sessionId: "session-2",
      side: "B",
      frames: (async function* () {
        yield frame("session-2");
        await hold;
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: (accepted, at) => {
        started.push({ sequence: accepted.sequence, at });
      },
    });
    while (socketB.sent.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(socketB.sent.length, 1);
    const packet = socketB.sent[0];
    assert.ok(packet instanceof Uint8Array);
    const unpacked = unpackPlayoutAudio(packet);
    assert.equal(unpacked.generation, 2);
    assert.equal(unpacked.sequence, 9);
    assert.deepEqual(unpacked.pcm16le, frame("session-2").pcm16le);
    socketB.message(
      JSON.stringify({ type: "playout_started", generation: 2, sequence: 9 }),
      false,
    );
    assert.deepEqual(started, [{ sequence: 9, at: 200 }]);
    socketB.message(
      JSON.stringify({ type: "playout_dropped", generation: 2, sequence: 9 }),
      false,
    );
    assert.equal(errors.at(-1)?.code, "playout_overflow");
    finish();
    await play;

    await media.clear({
      sessionId: "session-2",
      side: "B",
      lane: "A_TO_B",
      generation: 3,
    });
    assert.equal(socketB.sent[1], JSON.stringify({ type: "clear", generation: 3 }));

    const controller = new AbortController();
    const events = media.frames({ sessionId: "session-2", signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_state");
    const dropped = (await events.next()).value;
    assert.equal(dropped?.type, "alert");
    if (dropped?.type === "alert") assert.equal(dropped.code, "playout_overflow");
    socketA.message(new Uint8Array(960), true);
    const event = (await events.next()).value;
    assert.equal(event?.type, "audio");
    if (event?.type === "audio") assert.equal(event.frame.generation, 3);
    controller.abort();
    await events.return?.();
  });

  it("expires a lost playout ACK so later audio can continue", async () => {
    let now = 0;
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      playoutAckTimeoutMs: 20,
      now: () => now,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    media.attach("ack-timeout", "B", socket);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const play = media.play({
      sessionId: "ack-timeout",
      side: "B",
      frames: (async function* () {
        yield frame("ack-timeout", 1, 0);
        await hold;
        yield frame("ack-timeout", 1, 1);
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    while (socket.sent.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    now = 21;
    release();
    await play;
    assert.equal(socket.sent.length, 2);
    assert.equal(errors.at(-1)?.code, "playout_overflow");
  });

  it("rejects side hijacking and permits attach after a clean disconnect", async () => {
    const media = new BrowserWebSocketMediaPort();
    const original = new FakeSocket();
    const replacement = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "session-3", signal: controller.signal })[Symbol.asyncIterator]();

    media.attach("session-3", "A", original);
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.throws(
      () => media.attach("session-3", "A", replacement),
      (error: unknown) =>
        error instanceof BrowserMediaProtocolError && error.code === "side_in_use",
    );

    original.close();
    const disconnected = (await events.next()).value;
    assert.equal(disconnected?.type, "participant_state");
    if (disconnected?.type === "participant_state") assert.equal(disconnected.connected, false);

    media.attach("session-3", "A", replacement);
    const reconnected = (await events.next()).value;
    if (reconnected?.type === "participant_state") assert.equal(reconnected.connected, true);
    replacement.message(new Uint8Array(960), true);
    assert.equal((await events.next()).value?.type, "audio");
    controller.abort();
    await events.return?.();
  });

  it("tombstones a closed session so an old participant grant cannot reopen it", () => {
    const media = new BrowserWebSocketMediaPort();
    const socket = new FakeSocket();
    media.attach("closed-session", "A", socket);
    media.closeSession("closed-session");
    assert.throws(
      () => media.attach("closed-session", "A", new FakeSocket()),
      /Cannot reopen a closed media session/u,
    );
  });
});

describe("FakeTelephonyMediaPort", () => {
  it("decodes connected PCMU ingress in sequence through a bounded jitter window", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 88, jitterBufferFrames: 1 });
    const controller = new AbortController();
    const events = media.frames({ sessionId: "phone-1", signal: controller.signal })[Symbol.asyncIterator]();

    media.connect("phone-1", "B");
    const connected = (await events.next()).value;
    assert.equal(connected?.type, "participant_state");

    const mulaw = new Uint8Array(160).fill(encodeMulawSample(5_000));
    media.ingestMulaw("phone-1", "B", 40, mulaw);
    const audio = (await events.next()).value;
    assert.equal(audio?.type, "audio");
    if (audio?.type === "audio") {
      assert.equal(audio.frame.lane, "B_TO_A");
      assert.equal(audio.frame.sequence, 40);
      assert.equal(audio.frame.pcm16le.byteLength, 960);
    }

    media.ingestMulaw("phone-1", "B", 42, mulaw, 128);
    media.ingestMulaw("phone-1", "B", 41, mulaw, 108);
    const reordered = [await events.next(), await events.next()]
      .map((event) => event.value)
      .filter((event): event is Extract<typeof event, { type: "audio" }> => event?.type === "audio");
    assert.deepEqual(
      reordered.map((event) => [event.frame.sequence, event.timestampMonoMs]),
      [[41, 108], [42, 128]],
    );

    assert.throws(
      () => media.ingestMulaw("phone-1", "B", 42, mulaw),
      (error: unknown) => error instanceof TelephonySequenceError && error.expected === 43,
    );

    media.ingestMulaw("phone-1", "B", 45, mulaw);
    const overflow = (await events.next()).value;
    assert.deepEqual(overflow, {
      type: "alert",
      sessionId: "phone-1",
      side: "B",
      timestampMonoMs: 88,
      code: "telephony_jitter_overflow",
      message: "Dropped PCMU frame sequence 45; it exceeds the 1-frame jitter window while waiting for sequence 43",
      retryable: true,
    });
    controller.abort();
    await events.return?.();
  });

  it("encodes both directions, records generation clears, and resets ingress on reconnect", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 99 });
    media.connect("phone-2", "A");
    media.connect("phone-2", "B");
    await media.play({
      sessionId: "phone-2",
      side: "A",
      frames: (async function* () {
        yield createAudioFrame({
          ...frame("phone-2", 4, 12),
          lane: "B_TO_A",
        });
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    await media.play({
      sessionId: "phone-2",
      side: "B",
      frames: (async function* () {
        yield createAudioFrame({
          ...frame("phone-2", 6, 14),
          lane: "A_TO_B",
        });
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    await media.clear({
      sessionId: "phone-2",
      side: "A",
      lane: "B_TO_A",
      generation: 5,
    });
    await media.clear({
      sessionId: "phone-2",
      side: "B",
      lane: "A_TO_B",
      generation: 7,
    });

    const outboundA = media.outbound("phone-2", "A");
    assert.equal(outboundA[0]?.type, "audio");
    if (outboundA[0]?.type === "audio") {
      assert.equal(outboundA[0].mulaw8k.byteLength, 160);
      assert.equal(outboundA[0].generation, 4);
      assert.equal(outboundA[0].sequence, 0);
    }
    assert.deepEqual(outboundA[1], { type: "clear", generation: 5 });

    const outboundB = media.outbound("phone-2", "B");
    assert.equal(outboundB[0]?.type, "audio");
    if (outboundB[0]?.type === "audio") {
      assert.equal(outboundB[0].mulaw8k.byteLength, 160);
      assert.equal(outboundB[0].generation, 6);
      assert.equal(outboundB[0].sequence, 0);
    }
    assert.deepEqual(outboundB[1], { type: "clear", generation: 7 });

    media.hangup("phone-2", "A");
    media.reconnect("phone-2", "A");
    const mulaw = createPcmuSilenceFrame();
    assert.doesNotThrow(() => media.ingestMulaw("phone-2", "A", 1, mulaw));
  });

  it("maps DTMF and transport alerts to observability events without synthesizing audio", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 144 });
    const controller = new AbortController();
    const events = media.frames({ sessionId: "phone-controls", signal: controller.signal })[Symbol.asyncIterator]();
    media.connect("phone-controls", "A");
    await events.next();

    media.ingestDtmf("phone-controls", "A", "#", 160);
    assert.deepEqual((await events.next()).value, {
      type: "alert",
      sessionId: "phone-controls",
      side: "A",
      timestampMonoMs: 160,
      code: "telephony_dtmf_received",
      message: "Received DTMF # from participant A",
      retryable: false,
    });

    media.emitAlert("phone-controls", "A", "telephony_fixture_notice", "fixture only", true, 180);
    assert.deepEqual((await events.next()).value, {
      type: "alert",
      sessionId: "phone-controls",
      side: "A",
      timestampMonoMs: 180,
      code: "telephony_fixture_notice",
      message: "fixture only",
      retryable: true,
    });
    assert.deepEqual(media.outbound("phone-controls", "A"), []);
    assert.throws(
      () => media.ingestDtmf("phone-controls", "A", "Z" as never),
      /DTMF digit/u,
    );
    controller.abort();
    await events.return?.();
  });

  it("tombstones closed sessions so stale fixtures cannot reconnect or emit controls", () => {
    const media = new FakeTelephonyMediaPort();
    media.connect("closed-phone", "A");
    media.closeSession("closed-phone");

    for (const action of [
      () => media.connect("closed-phone", "A"),
      () => media.reconnect("closed-phone", "A"),
      () => media.ingestDtmf("closed-phone", "A", "1"),
      () => media.emitAlert("closed-phone", "A", "stale", "stale fixture", false),
    ]) {
      assert.throws(
        action,
        (error: unknown) => error instanceof TelephonyConnectionError &&
          error.message === "Cannot reopen a closed media session",
      );
    }
    assert.deepEqual(media.outbound("closed-phone", "A"), []);
  });
});

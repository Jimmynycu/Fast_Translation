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
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  readonly #listeners = new Map<string, Set<Listener>>();
  readyState = 1;
  bufferedAmount = 0;
  closeError: Error | undefined;
  offError: Error | undefined;
  sendError: Error | undefined;

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    if (this.offError !== undefined) throw this.offError;
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  send(data: string | Uint8Array): void {
    if (this.sendError !== undefined) throw this.sendError;
    this.sent.push(typeof data === "string" ? data : Uint8Array.from(data));
  }

  message(data: string | Uint8Array, isBinary: boolean): void {
    this.#emit("message", data, isBinary);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.closeError !== undefined) throw this.closeError;
    this.readyState = 3;
    this.#emit("close");
  }

  #emit(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...args);
  }
}

async function nextWithin<T>(
  iterator: AsyncIterator<T>,
  description: string,
): Promise<IteratorResult<T>> {
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for " + description));
    }, 100);
    void iterator.next().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForSent(socket: FakeSocket, count: number): Promise<void> {
  while (socket.sent.length < count) {
    await new Promise<void>((resolve) => setImmediate(resolve));
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

  it("rejects oversized aggregate browser controls and audio before concatenating them", () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    media.attach("message-bounds", "A", socket);
    socket.message(
      [new Uint8Array(4 * 1024), new Uint8Array(1)] as unknown as Uint8Array,
      false,
    );
    socket.message(
      [new Uint8Array(960), new Uint8Array(1)] as unknown as Uint8Array,
      true,
    );
    assert.deepEqual(errors.map((error) => error.code), ["invalid_control", "invalid_audio"]);
  });

  it("accepts a control exactly at the aggregate byte cap", () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    media.attach("message-cap-exact", "A", socket);
    const prefix = '{"type":"speech_start","padding":"';
    const suffix = '"}';
    const paddingBytes = 4 * 1024 - prefix.length - suffix.length;
    const exact = prefix + "x".repeat(paddingBytes) + suffix;
    assert.equal(new TextEncoder().encode(exact).byteLength, 4 * 1024);
    socket.message(Uint8Array.from(new TextEncoder().encode(exact)), false);
    assert.equal(errors.length, 0);
    socket.message(Uint8Array.from(new TextEncoder().encode(exact + "x")), false);
    assert.deepEqual(errors.map((error) => error.code), ["invalid_control"]);
  });

  it("retains browser teardown state over queued audio when the ingress queue is full", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 2, now: () => 42 });
    const socket = new FakeSocket();
    media.attach("priority-browser", "A", socket);
    socket.message(new Uint8Array(960), true);
    socket.close();

    const events = media.frames({
      sessionId: "priority-browser",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "audio");
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-browser",
      side: "A",
      timestampMonoMs: 42,
      connected: false,
    });
    await events.return?.();
  });

  it("retains terminal browser detach state over saturated controls", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 2, now: () => 43 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-terminal-detach", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-terminal-detach", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(JSON.stringify({ type: "speech_end" }), false);
    socket.close();

    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "priority-terminal-detach",
      side: "A",
      timestampMonoMs: 43,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-terminal-detach",
      side: "A",
      timestampMonoMs: 43,
      connected: false,
    });
    controller.abort();
    await events.return?.();
  });

  it("retains both terminal browser lifecycle events at capacity one", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 1, now: () => 43.5 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-terminal-cap-one", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-terminal-cap-one", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    socket.close();

    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "priority-terminal-cap-one",
      side: "A",
      timestampMonoMs: 43.5,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    assert.deepEqual((await nextWithin(events, "capacity-one terminal disconnect")).value, {
      type: "participant_state",
      sessionId: "priority-terminal-cap-one",
      side: "A",
      timestampMonoMs: 43.5,
      connected: false,
    });
    controller.abort();
    await events.return?.();
  });

  it("retains both sides terminal state at capacity one with mixed readiness", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 1, now: () => 43.75 });
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-terminal-both", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-terminal-both", "A", socketA);
    assert.equal((await events.next()).value?.type, "participant_state");
    media.attach("priority-terminal-both", "B", socketB);
    assert.equal((await events.next()).value?.type, "participant_state");
    socketA.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    socketA.close();
    socketB.close();

    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "priority-terminal-both",
      side: "A",
      timestampMonoMs: 43.75,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-terminal-both",
      side: "A",
      timestampMonoMs: 43.75,
      connected: false,
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-terminal-both",
      side: "B",
      timestampMonoMs: 43.75,
      connected: false,
    });
    controller.abort();
    await events.return?.();
  });

  it("retains terminal browser close state over saturated controls", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 2, now: () => 44 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-terminal-close", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-terminal-close", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");
    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(JSON.stringify({ type: "speech_end" }), false);

    media.closeSession("priority-terminal-close");

    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "priority-terminal-close",
      side: "A",
      timestampMonoMs: 44,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-terminal-close",
      side: "A",
      timestampMonoMs: 44,
      connected: false,
    });
    assert.equal((await events.next()).done, true);
    controller.abort();
    await events.return?.();
  });

  it("coalesces stale terminal readiness on an immediate browser reconnect", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 2, now: () => 45 });
    const original = new FakeSocket();
    const replacement = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-reconnect", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-reconnect", "A", original);
    assert.equal((await events.next()).value?.type, "participant_state");
    original.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    original.close();
    media.attach("priority-reconnect", "A", replacement);

    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-reconnect",
      side: "A",
      timestampMonoMs: 45,
      connected: false,
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-reconnect",
      side: "A",
      timestampMonoMs: 45,
      connected: true,
    });
    assert.equal(replacement.closeCalls.length, 0);
    controller.abort();
    await events.return?.();
  });

  it("coalesces stale terminal readiness on a capacity-one reconnect", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 1, now: () => 45.25 });
    const original = new FakeSocket();
    const replacement = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "priority-reconnect-cap-one", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("priority-reconnect-cap-one", "A", original);
    assert.equal((await events.next()).value?.type, "participant_state");
    original.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    original.close();
    media.attach("priority-reconnect-cap-one", "A", replacement);

    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-reconnect-cap-one",
      side: "A",
      timestampMonoMs: 45.25,
      connected: false,
    });
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "priority-reconnect-cap-one",
      side: "A",
      timestampMonoMs: 45.25,
      connected: true,
    });
    assert.equal(replacement.closeCalls.length, 0);
    controller.abort();
    await events.return?.();
  });

  it("retains a browser protocol alert over queued audio at capacity one", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const events = media.frames({
      sessionId: "priority-alert",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    media.attach("priority-alert", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(new Uint8Array(960), true);
    socket.message("not-json", false);
    assert.equal(errors.at(-1)?.code, "invalid_control");
    assert.equal((await events.next()).value?.type, "alert");
    await events.return?.();
  });

  it("does not evict critical browser controls when a protocol alert arrives at capacity one", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const events = media.frames({
      sessionId: "priority-critical-alert",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    media.attach("priority-critical-alert", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");

    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message("not-json", false);
    assert.deepEqual(errors.map((error) => error.code), ["invalid_control"]);
    assert.equal((await events.next()).value?.type, "speech_started");

    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    socket.message("not-json", false);
    assert.deepEqual(errors.map((error) => error.code), ["invalid_control", "invalid_control"]);
    assert.equal((await events.next()).value?.type, "participant_readiness");

    await media.clear({
      sessionId: "priority-critical-alert",
      side: "A",
      lane: "B_TO_A",
      generation: 1,
      clearId: "priority-critical-alert-1",
    });
    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(JSON.stringify({
      type: "clear_applied",
      lane: "B_TO_A",
      generation: 1,
      clearId: "priority-critical-alert-1",
    }), false);
    socket.message("not-json", false);
    assert.deepEqual(errors.map((error) => error.code), [
      "invalid_control",
      "invalid_control",
      "invalid_control",
    ]);
    assert.equal((await events.next()).value?.type, "playout_cleared");
    await events.return?.();
  });

  it("drops overflow without advancing the accepted media sequence", async () => {
    const errors: Error[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "bounded", signal: controller.signal })[Symbol.asyncIterator]();
    media.attach("bounded", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(new Uint8Array(960), true);
    assert.equal(errors[0]?.name, "BrowserMediaProtocolError");
    assert.match(errors[0]?.message ?? "", /full/);

    assert.equal((await events.next()).value?.type, "speech_started");
    socket.message(new Uint8Array(960), true);
    const accepted = (await events.next()).value;
    assert.equal(accepted?.type, "audio");
    if (accepted?.type === "audio") assert.equal(accepted.frame.sequence, 0);
    controller.abort();
    await events.return?.();
  });

  it("records browser capture and headphone self-attestation, then clears it on disconnect", async () => {
    const media = new BrowserWebSocketMediaPort({ now: () => 130 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "readiness", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("readiness", "A", socket);
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);

    assert.equal((await events.next()).value?.type, "participant_state");
    assert.deepEqual((await nextWithin(events, "browser readiness")).value, {
      type: "participant_readiness",
      sessionId: "readiness",
      side: "A",
      timestampMonoMs: 130,
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });

    socket.close();
    assert.deepEqual((await nextWithin(events, "browser readiness clearing")).value, {
      type: "participant_readiness",
      sessionId: "readiness",
      side: "A",
      timestampMonoMs: 130,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    const disconnected = (await events.next()).value;
    assert.equal(disconnected?.type, "participant_state");
    if (disconnected?.type === "participant_state") assert.equal(disconnected.connected, false);
    controller.abort();
    await events.return?.();
  });

  it("accepts an explicit browser readiness loss report", async () => {
    const media = new BrowserWebSocketMediaPort({ now: () => 131 });
    const socket = new FakeSocket();
    const events = media.frames({
      sessionId: "readiness-loss",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    media.attach("readiness-loss", "A", socket);
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_readiness");
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "stopped",
      headphones: "not_attested",
    }), false);
    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "readiness-loss",
      side: "A",
      timestampMonoMs: 131,
      microphone: "stopped",
      headphones: "not_attested",
      source: "participant_browser_self_report",
    });
    await events.return?.();
  });

  it("retains an active browser readiness event over transient controls at capacity one", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 1, now: () => 132 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "readiness-priority", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("readiness-priority", "A", socket);
    assert.equal((await events.next()).value?.type, "participant_state");

    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(JSON.stringify({
      type: "participant_readiness",
      microphone: "browser_capture_active",
      headphones: "self_attested",
    }), false);

    assert.deepEqual((await events.next()).value, {
      type: "participant_readiness",
      sessionId: "readiness-priority",
      side: "A",
      timestampMonoMs: 132,
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    assert.equal(socket.closeCalls.length, 0);
    controller.abort();
    await events.return?.();
  });

  it("retains a browser clear acknowledgement over transient controls at capacity one", async () => {
    const media = new BrowserWebSocketMediaPort({ queueCapacity: 1, now: () => 133 });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "clear-priority", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("clear-priority", "B", socket);
    assert.equal((await events.next()).value?.type, "participant_state");
    await media.clear({
      sessionId: "clear-priority",
      side: "B",
      lane: "A_TO_B",
      generation: 1,
      clearId: "clear-priority-1",
    });

    socket.message(JSON.stringify({ type: "speech_start" }), false);
    socket.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 1,
      clearId: "clear-priority-1",
    }), false);

    assert.deepEqual((await events.next()).value, {
      type: "playout_cleared",
      sessionId: "clear-priority",
      side: "B",
      timestampMonoMs: 133,
      lane: "A_TO_B",
      generation: 1,
      clearId: "clear-priority-1",
    });
    assert.equal(socket.closeCalls.length, 0);
    controller.abort();
    await events.return?.();
  });

  it("records bounded browser playout queue telemetry for its destination lane", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      now: () => 140,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "queue-telemetry", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("queue-telemetry", "B", socket);
    socket.message(JSON.stringify({
      type: "queue_sample",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 3,
      capacityFrames: 60,
      bufferedAudioMs: 60,
      oldestQueuedAgeMs: 40,
    }), false);

    assert.equal((await events.next()).value?.type, "participant_state");
    assert.deepEqual((await events.next()).value, {
      type: "queue_sample",
      sessionId: "queue-telemetry",
      side: "B",
      timestampMonoMs: 140,
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 3,
      capacityFrames: 60,
      bufferedAudioMs: 60,
      oldestQueuedAgeMs: 40,
    });

    socket.message(JSON.stringify({
      type: "queue_sample",
      lane: "B_TO_A",
      generation: 0,
      depthFrames: 3,
      capacityFrames: 60,
      bufferedAudioMs: 60,
    }), false);
    assert.equal(errors.at(-1)?.code, "invalid_control");
    controller.abort();
    await events.return?.();
  });

  it("packs translated audio and acknowledges only a matching applied clear", async () => {
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
    await waitForSent(socketB, 1);
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
      clearId: "clear-session-2-b-3",
    });
    assert.equal(socketB.sent[1], JSON.stringify({
      type: "clear",
      lane: "A_TO_B",
      generation: 3,
      clearId: "clear-session-2-b-3",
    }));

    const controller = new AbortController();
    const events = media.frames({ sessionId: "session-2", signal: controller.signal })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_state");
    const dropped = (await events.next()).value;
    assert.equal(dropped?.type, "alert");
    if (dropped?.type === "alert") assert.equal(dropped.code, "playout_overflow");
    const clearApplied = events.next();
    socketB.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 3,
      clearId: "clear-session-2-b-3",
    }), false);
    assert.deepEqual(await clearApplied, {
      done: false,
      value: {
        type: "playout_cleared",
        sessionId: "session-2",
        side: "B",
        timestampMonoMs: 200,
        lane: "A_TO_B",
        generation: 3,
        clearId: "clear-session-2-b-3",
      },
    });
    socketA.message(new Uint8Array(960), true);
    const event = (await events.next()).value;
    assert.equal(event?.type, "audio");
    if (event?.type === "audio") assert.equal(event.frame.generation, 3);
    controller.abort();
    await events.return?.();
  });

  it("retains a clear for reconnect after browser delivery throws", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error) => errors.push(error),
    });
    const throwing = new FakeSocket();
    throwing.sendError = new Error("raw send failure");
    media.attach("clear-send-error", "B", throwing);

    await assert.rejects(
      media.clear({
        sessionId: "clear-send-error",
        side: "B",
        lane: "A_TO_B",
        generation: 2,
        clearId: "clear-send-error-2",
      }),
      (error: unknown) =>
        error instanceof BrowserMediaProtocolError &&
        error.code === "socket_error" &&
        error.message === "Browser clear delivery failed",
    );
    assert.deepEqual(errors.map((error) => [error.code, error.message]), [[
      "socket_error",
      "Browser clear delivery failed",
    ]]);

    const replacement = new FakeSocket();
    media.attach("clear-send-error", "B", replacement);
    assert.deepEqual(replacement.sent, [JSON.stringify({
      type: "clear",
      lane: "A_TO_B",
      generation: 2,
      clearId: "clear-send-error-2",
    })]);
  });

  it("fails an undeliverable clear replay and retains it for the next socket", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error) => errors.push(error),
    });
    await media.clear({
      sessionId: "clear-replay-send-error",
      side: "B",
      lane: "A_TO_B",
      generation: 2,
      clearId: "clear-replay-send-error-2",
    });

    const throwing = new FakeSocket();
    throwing.sendError = new Error("replay send failure");
    assert.throws(
      () => media.attach("clear-replay-send-error", "B", throwing),
      (error: unknown) =>
        error instanceof BrowserMediaProtocolError &&
        error.code === "socket_error" &&
        error.message === "Browser clear replay failed",
    );
    assert.equal(throwing.readyState, 3);

    const replacement = new FakeSocket();
    media.attach("clear-replay-send-error", "B", replacement);
    assert.deepEqual(replacement.sent, [JSON.stringify({
      type: "clear",
      lane: "A_TO_B",
      generation: 2,
      clearId: "clear-replay-send-error-2",
    })]);
    assert.deepEqual(errors.map((error) => error.code), ["socket_error"]);
  });

  it("rejects unknown clear lanes before destination routing", async () => {
    const media = new BrowserWebSocketMediaPort();
    await assert.rejects(
      media.clear({
        sessionId: "invalid-browser-lane",
        side: "A",
        lane: "invalid" as never,
        generation: 1,
        clearId: "invalid-browser-lane-1",
      }),
      /lane must be A_TO_B or B_TO_A/u,
    );
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
    await waitForSent(socket, 1);
    now = 21;
    release();
    await play;
    assert.equal(socket.sent.length, 2);
    assert.equal(errors.at(-1)?.code, "playout_overflow");
  });

  it("waits for browser playout ACK capacity instead of dropping a burst", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 2,
      playoutAckTimeoutMs: 1_000,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    media.attach("ack-capacity", "B", socket);
    const play = media.play({
      sessionId: "ack-capacity",
      side: "B",
      frames: (async function* () {
        for (let sequence = 0; sequence < 4; sequence += 1) {
          yield frame("ack-capacity", 1, sequence);
        }
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    await waitForSent(socket, 2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(socket.sent.length, 2);

    socket.message(JSON.stringify({ type: "playout_started", generation: 1, sequence: 0 }), false);
    await waitForSent(socket, 3);
    socket.message(JSON.stringify({ type: "playout_started", generation: 1, sequence: 1 }), false);
    await waitForSent(socket, 4);
    socket.message(JSON.stringify({ type: "playout_started", generation: 1, sequence: 2 }), false);
    socket.message(JSON.stringify({ type: "playout_started", generation: 1, sequence: 3 }), false);
    await play;
    assert.deepEqual(errors, []);
  });

  it("wakes a capped playout producer when its request is aborted", async () => {
    const media = new BrowserWebSocketMediaPort({
      queueCapacity: 1,
      playoutAckTimeoutMs: 1_000,
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    media.attach("ack-capacity-abort", "B", socket);
    const play = media.play({
      sessionId: "ack-capacity-abort",
      side: "B",
      frames: (async function* () {
        yield frame("ack-capacity-abort", 1, 0);
        yield frame("ack-capacity-abort", 1, 1);
      })(),
      signal: controller.signal,
      onPlayoutStarted: () => undefined,
    });
    await waitForSent(socket, 1);
    controller.abort();
    await play;
    assert.equal(socket.sent.length, 1);
  });

  it("expires the final playout ACK after the frame stream ends", async () => {
    let now = 0;
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      playoutAckTimeoutMs: 20,
      now: () => now,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "final-ack-timeout", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("final-ack-timeout", "B", socket);

    await media.play({
      sessionId: "final-ack-timeout",
      side: "B",
      frames: (async function* () {
        yield frame("final-ack-timeout", 1, 0);
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    assert.equal(socket.sent.length, 1);
    now = 21;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(errors.map((error) => error.code), ["playout_overflow"]);
    assert.equal((await events.next()).value?.type, "participant_state");
    const expired = (await events.next()).value;
    assert.equal(expired?.type, "alert");
    if (expired?.type === "alert") assert.equal(expired.code, "playout_overflow");
    controller.abort();
    await events.return?.();
  });

  it("accepts a final playout ACK after the frame stream ends and cancels its timer", async () => {
    let now = 0;
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      playoutAckTimeoutMs: 20,
      now: () => now,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const started: number[] = [];
    media.attach("final-ack", "B", socket);

    await media.play({
      sessionId: "final-ack",
      side: "B",
      frames: (async function* () {
        yield frame("final-ack", 1, 0);
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: (accepted) => started.push(accepted.sequence),
    });
    socket.message(JSON.stringify({
      type: "playout_started",
      generation: 1,
      sequence: 0,
    }), false);
    assert.deepEqual(started, [0]);
    now = 21;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(errors, []);
  });

  it("clears a final playout timeout when the browser detaches or session closes", async () => {
    let now = 0;
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      playoutAckTimeoutMs: 20,
      now: () => now,
      onProtocolError: (error) => errors.push(error),
    });
    const detached = new FakeSocket();
    media.attach("final-detach", "B", detached);
    await media.play({
      sessionId: "final-detach",
      side: "B",
      frames: (async function* () {
        yield frame("final-detach", 1, 0);
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    media.detach("final-detach", "B", detached);

    const closed = new FakeSocket();
    media.attach("final-close", "B", closed);
    await media.play({
      sessionId: "final-close",
      side: "B",
      frames: (async function* () {
        yield frame("final-close", 1, 0);
      })(),
      signal: new AbortController().signal,
      onPlayoutStarted: () => undefined,
    });
    media.closeSession("final-close");
    now = 21;
    await new Promise<void>((resolve) => setTimeout(resolve, 35));
    assert.deepEqual(errors, []);
  });

  it("rejects stale, foreign, and duplicate clear acknowledgements", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      now: () => 300,
      onProtocolError: (error) => errors.push(error),
    });
    const socket = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "clear-correlation", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("clear-correlation", "B", socket);
    await media.clear({
      sessionId: "clear-correlation",
      side: "B",
      lane: "A_TO_B",
      generation: 3,
      clearId: "clear-3",
    });
    socket.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 3,
      clearId: "clear-3",
    }), false);
    await media.clear({
      sessionId: "clear-correlation",
      side: "B",
      lane: "A_TO_B",
      generation: 4,
      clearId: "clear-4",
    });

    for (const acknowledgement of [
      { lane: "A_TO_B", generation: 3, clearId: "clear-3" },
      { lane: "A_TO_B", generation: 4, clearId: "foreign-clear" },
      { lane: "B_TO_A", generation: 4, clearId: "clear-4" },
    ]) {
      socket.message(JSON.stringify({ type: "clear_applied", ...acknowledgement }), false);
    }

    assert.equal((await events.next()).value?.type, "participant_state");
    const applied = (await events.next()).value;
    assert.equal(applied?.type, "playout_cleared");
    assert.equal((await events.next()).value?.type, "alert");
    assert.equal((await events.next()).value?.type, "alert");
    assert.equal((await events.next()).value?.type, "alert");
    assert.deepEqual(errors.map((error) => error.code), [
      "invalid_control",
      "invalid_control",
      "invalid_control",
    ]);
    controller.abort();
    await events.return?.();
  });

  it("replays an unacknowledged clear to a replacement browser socket", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      now: () => 333,
      onProtocolError: (error) => errors.push(error),
    });
    const original = new FakeSocket();
    const replacement = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "clear-replay", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.attach("clear-replay", "B", original);
    original.close();
    await media.clear({
      sessionId: "clear-replay",
      side: "B",
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-replay-5",
    });
    assert.deepEqual(original.sent, []);

    media.attach("clear-replay", "B", replacement);
    assert.deepEqual(replacement.sent, [JSON.stringify({
      type: "clear",
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-replay-5",
    })]);

    replacement.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 5,
      clearId: "wrong-clear-id",
    }), false);
    replacement.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-replay-5",
    }), false);
    replacement.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-replay-5",
    }), false);

    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "alert");
    assert.deepEqual((await events.next()).value, {
      type: "playout_cleared",
      sessionId: "clear-replay",
      side: "B",
      timestampMonoMs: 333,
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-replay-5",
    });
    assert.equal((await events.next()).value?.type, "alert");
    assert.deepEqual(errors.map((error) => error.code), ["invalid_control", "invalid_control"]);
    controller.abort();
    await events.return?.();
  });

  it("fails closed on a backpressured clear and replays only its latest pending clear", async () => {
    const errors: BrowserMediaProtocolError[] = [];
    const media = new BrowserWebSocketMediaPort({
      maximumBufferedBytes: 960,
      now: () => 350,
      onProtocolError: (error) => errors.push(error),
    });
    const stalled = new FakeSocket();
    stalled.bufferedAmount = 961;
    const replacement = new FakeSocket();
    const controller = new AbortController();
    const events = media.frames({ sessionId: "clear-backpressure", signal: controller.signal })[
      Symbol.asyncIterator
    ]();

    media.attach("clear-backpressure", "B", stalled);
    await assert.rejects(
      media.clear({
        sessionId: "clear-backpressure",
        side: "B",
        lane: "A_TO_B",
        generation: 4,
        clearId: "clear-backpressure-4",
      }),
      (error: unknown) =>
        error instanceof BrowserMediaProtocolError && error.code === "playout_overflow",
    );
    await media.clear({
      sessionId: "clear-backpressure",
      side: "B",
      lane: "A_TO_B",
      generation: 5,
      clearId: "clear-backpressure-5",
    });
    await media.clear({
      sessionId: "clear-backpressure",
      side: "B",
      lane: "A_TO_B",
      generation: 6,
      clearId: "clear-backpressure-6",
    });

    assert.deepEqual(stalled.sent, []);
    assert.equal(stalled.readyState, 3);
    assert.equal(stalled.closeCalls.length, 1);
    assert.deepEqual(errors.map((error) => error.code), ["playout_overflow"]);
    assert.equal((await events.next()).value?.type, "participant_state");
    const overflow = (await events.next()).value;
    assert.equal(overflow?.type, "alert");
    if (overflow?.type === "alert") assert.equal(overflow.code, "playout_overflow");
    const disconnected = (await events.next()).value;
    assert.equal(disconnected?.type, "participant_state");
    if (disconnected?.type === "participant_state") assert.equal(disconnected.connected, false);

    stalled.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 6,
      clearId: "clear-backpressure-6",
    }), false);

    media.attach("clear-backpressure", "B", replacement);
    assert.deepEqual(replacement.sent, [JSON.stringify({
      type: "clear",
      lane: "A_TO_B",
      generation: 6,
      clearId: "clear-backpressure-6",
    })]);
    const connected = (await events.next()).value;
    assert.equal(connected?.type, "participant_state");
    if (connected?.type === "participant_state") assert.equal(connected.connected, true);

    const applied = events.next();
    replacement.message(JSON.stringify({
      type: "clear_applied",
      lane: "A_TO_B",
      generation: 6,
      clearId: "clear-backpressure-6",
    }), false);
    assert.deepEqual(await applied, {
      done: false,
      value: {
        type: "playout_cleared",
        sessionId: "clear-backpressure",
        side: "B",
        timestampMonoMs: 350,
        lane: "A_TO_B",
        generation: 6,
        clearId: "clear-backpressure-6",
      },
    });
    controller.abort();
    await events.return?.();
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

  it("completes teardown and tombstones a session when one browser socket close throws", () => {
    const errors: BrowserMediaProtocolError[] = [];
    const errorSides: string[] = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error, context) => {
        errors.push(error);
        errorSides.push(context.side);
      },
    });
    const throwing = new FakeSocket();
    throwing.closeError = new Error("close failed");
    const other = new FakeSocket();
    media.attach("close-error", "A", throwing);
    media.attach("close-error", "B", other);

    assert.doesNotThrow(() => media.closeSession("close-error"));
    assert.deepEqual(throwing.closeCalls, [[1000, "Session closed"]]);
    assert.deepEqual(other.closeCalls, [[1000, "Session closed"]]);
    assert.equal(other.readyState, 3);
    assert.deepEqual(errors.map((error) => error.code), ["socket_error"]);
    assert.deepEqual(errorSides, ["A"]);
    assert.doesNotThrow(() => throwing.message(new Uint8Array(960), true));
    assert.doesNotThrow(() => other.message(new Uint8Array(960), true));
    for (const side of ["A", "B"] as const) {
      assert.throws(
        () => media.attach("close-error", side, new FakeSocket()),
        /Cannot reopen a closed media session/u,
      );
    }
  });

  it("continues both browser teardown sides when listener removal and close throw", () => {
    const errors: Array<{ readonly code: string; readonly message: string; readonly side: string }> = [];
    const media = new BrowserWebSocketMediaPort({
      onProtocolError: (error, context) => {
        errors.push({ code: error.code, message: error.message, side: context.side });
      },
    });
    const sideA = new FakeSocket();
    sideA.offError = new Error("off failed");
    const sideB = new FakeSocket();
    sideB.closeError = new Error("close failed");
    media.attach("close-both-errors", "A", sideA);
    media.attach("close-both-errors", "B", sideB);

    assert.doesNotThrow(() => media.closeSession("close-both-errors"));
    assert.deepEqual(sideA.closeCalls, [[1000, "Session closed"]]);
    assert.deepEqual(sideB.closeCalls, [[1000, "Session closed"]]);
    assert.deepEqual(errors, [
      { code: "socket_error", message: "Browser media session teardown failed", side: "A" },
      { code: "socket_error", message: "Browser media session teardown failed", side: "B" },
    ]);
    assert.throws(
      () => media.attach("close-both-errors", "A", new FakeSocket()),
      /Cannot reopen a closed media session/u,
    );
    assert.throws(
      () => media.attach("close-both-errors", "B", new FakeSocket()),
      /Cannot reopen a closed media session/u,
    );
  });
});

describe("FakeTelephonyMediaPort", () => {
  it("keeps connect atomic when its bounded ingress queue has no room", async () => {
    const media = new FakeTelephonyMediaPort({ queueCapacity: 1, now: () => 70 });
    assert.throws(
      () => media.connect("phone-connect-capacity", "A"),
      (error: unknown) =>
        error instanceof TelephonyConnectionError &&
        error.message === "Telephony ingress queue is closed or full",
    );

    const events = media.frames({
      sessionId: "phone-connect-capacity",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    const connected = events.next();
    media.connect("phone-connect-capacity", "A");
    assert.equal((await connected).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_readiness");
    await events.return?.();
  });

  it("admits exactly one disconnected event when hangup follows unconsumed connect controls", async () => {
    const media = new FakeTelephonyMediaPort({ queueCapacity: 2, now: () => 73 });
    media.connect("phone-hangup-capacity", "A");
    media.hangup("phone-hangup-capacity", "A");

    const events = media.frames({
      sessionId: "phone-hangup-capacity",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "participant_readiness");
    const disconnected = (await events.next()).value;
    assert.deepEqual(disconnected, {
      type: "participant_state",
      sessionId: "phone-hangup-capacity",
      side: "A",
      timestampMonoMs: 73,
      connected: false,
    });
    await events.return?.();
  });

  it("closeSession tombstones after admitting one disconnected event from an unconsumed connect", async () => {
    const media = new FakeTelephonyMediaPort({ queueCapacity: 2, now: () => 74 });
    const events = media.frames({
      sessionId: "phone-close-capacity",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    media.connect("phone-close-capacity", "A");
    media.closeSession("phone-close-capacity");

    assert.equal((await events.next()).value?.type, "participant_readiness");
    assert.equal((await events.next()).value?.type, "participant_state");
    await events.return?.();
    assert.throws(
      () => media.connect("phone-close-capacity", "A"),
      /Cannot reopen a closed media session/u,
    );
  });

  it("keeps a saturated clear retryable without an orphan outbound command", async () => {
    const media = new FakeTelephonyMediaPort({ queueCapacity: 2, now: () => 71 });
    media.connect("phone-clear-capacity", "B");
    await assert.rejects(
      media.clear({
        sessionId: "phone-clear-capacity",
        side: "B",
        lane: "A_TO_B",
        generation: 3,
        clearId: "phone-clear-capacity-3",
      }),
      (error: unknown) =>
        error instanceof TelephonyConnectionError &&
        error.message === "Telephony ingress queue is closed or full",
    );
    assert.deepEqual(media.outbound("phone-clear-capacity", "B"), []);

    const events = media.frames({
      sessionId: "phone-clear-capacity",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    assert.equal((await events.next()).value?.type, "participant_state");
    assert.equal((await events.next()).value?.type, "participant_readiness");
    await media.clear({
      sessionId: "phone-clear-capacity",
      side: "B",
      lane: "A_TO_B",
      generation: 3,
      clearId: "phone-clear-capacity-3",
    });
    assert.deepEqual(media.outbound("phone-clear-capacity", "B"), [{
      type: "clear",
      lane: "A_TO_B",
      generation: 3,
      clearId: "phone-clear-capacity-3",
    }]);
    assert.equal((await events.next()).value?.type, "playout_cleared");
    await events.return?.();
  });

  it("retains fake-telephony teardown controls over queued audio", async () => {
    const media = new FakeTelephonyMediaPort({ queueCapacity: 2, now: () => 72 });
    const events = media.frames({
      sessionId: "phone-priority",
      signal: new AbortController().signal,
    })[Symbol.asyncIterator]();
    media.connect("phone-priority", "A");
    assert.equal((await events.next()).value?.type, "participant_state");
    media.ingestMulaw("phone-priority", "A", 0, createPcmuSilenceFrame());
    media.hangup("phone-priority", "A");
    assert.equal((await events.next()).value?.type, "participant_readiness");
    assert.deepEqual((await events.next()).value, {
      type: "participant_state",
      sessionId: "phone-priority",
      side: "A",
      timestampMonoMs: 72,
      connected: false,
    });
    await events.return?.();
  });

  it("rejects unknown fake-telephony clear lanes before destination routing", async () => {
    const media = new FakeTelephonyMediaPort();
    await assert.rejects(
      media.clear({
        sessionId: "invalid-phone-lane",
        side: "A",
        lane: "invalid" as never,
        generation: 1,
        clearId: "invalid-phone-lane-1",
      }),
      /lane must be A_TO_B or B_TO_A/u,
    );
  });

  it("decodes connected PCMU ingress in sequence through a bounded jitter window", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 88, jitterBufferFrames: 1 });
    const controller = new AbortController();
    const events = media.frames({ sessionId: "phone-1", signal: controller.signal })[Symbol.asyncIterator]();

    media.connect("phone-1", "B");
    const connected = (await events.next()).value;
    assert.equal(connected?.type, "participant_state");
    assert.deepEqual((await nextWithin(events, "fixture readiness")).value, {
      type: "participant_readiness",
      sessionId: "phone-1",
      side: "B",
      timestampMonoMs: 88,
      microphone: "not_applicable",
      headphones: "not_applicable",
      source: "fake_telephony_fixture",
    });

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
      clearId: "clear-phone-2-a-5",
    });
    await media.clear({
      sessionId: "phone-2",
      side: "B",
      lane: "A_TO_B",
      generation: 7,
      clearId: "clear-phone-2-b-7",
    });

    const outboundA = media.outbound("phone-2", "A");
    assert.equal(outboundA[0]?.type, "audio");
    if (outboundA[0]?.type === "audio") {
      assert.equal(outboundA[0].mulaw8k.byteLength, 160);
      assert.equal(outboundA[0].generation, 4);
      assert.equal(outboundA[0].sequence, 0);
    }
    assert.deepEqual(outboundA[1], {
      type: "clear",
      lane: "B_TO_A",
      generation: 5,
      clearId: "clear-phone-2-a-5",
    });

    const outboundB = media.outbound("phone-2", "B");
    assert.equal(outboundB[0]?.type, "audio");
    if (outboundB[0]?.type === "audio") {
      assert.equal(outboundB[0].mulaw8k.byteLength, 160);
      assert.equal(outboundB[0].generation, 6);
      assert.equal(outboundB[0].sequence, 0);
    }
    assert.deepEqual(outboundB[1], {
      type: "clear",
      lane: "A_TO_B",
      generation: 7,
      clearId: "clear-phone-2-b-7",
    });

    media.hangup("phone-2", "A");
    media.reconnect("phone-2", "A");
    const mulaw = createPcmuSilenceFrame();
    assert.doesNotThrow(() => media.ingestMulaw("phone-2", "A", 1, mulaw));
  });

  it("acknowledges a fixture clear only once after its local queue is cleared", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 123 });
    const controller = new AbortController();
    const events = media.frames({ sessionId: "phone-clear", signal: controller.signal })[
      Symbol.asyncIterator
    ]();
    media.connect("phone-clear", "B");
    await nextWithin(events, "fixture readiness");
    await nextWithin(events, "fixture readiness");

    await media.clear({
      sessionId: "phone-clear",
      side: "B",
      lane: "A_TO_B",
      generation: 4,
      clearId: "phone-clear-4",
    });
    assert.deepEqual(media.outbound("phone-clear", "B"), [{
      type: "clear",
      lane: "A_TO_B",
      generation: 4,
      clearId: "phone-clear-4",
    }]);
    assert.deepEqual((await events.next()).value, {
      type: "playout_cleared",
      sessionId: "phone-clear",
      side: "B",
      timestampMonoMs: 123,
      lane: "A_TO_B",
      generation: 4,
      clearId: "phone-clear-4",
    });

    await media.clear({
      sessionId: "phone-clear",
      side: "B",
      lane: "A_TO_B",
      generation: 4,
      clearId: "phone-clear-4",
    });
    assert.equal(media.outbound("phone-clear", "B").length, 1);
    await assert.rejects(
      media.clear({
        sessionId: "phone-clear",
        side: "B",
        lane: "A_TO_B",
        generation: 4,
        clearId: "different-clear-id",
      }),
      /clearId/u,
    );
    controller.abort();
    await events.return?.();
  });

  it("maps DTMF and transport alerts to observability events without synthesizing audio", async () => {
    const media = new FakeTelephonyMediaPort({ now: () => 144 });
    const controller = new AbortController();
    const events = media.frames({ sessionId: "phone-controls", signal: controller.signal })[Symbol.asyncIterator]();
    media.connect("phone-controls", "A");
    await nextWithin(events, "fixture readiness");
    await nextWithin(events, "fixture readiness");

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

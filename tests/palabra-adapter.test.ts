import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import type { LaneContext } from "../src/core/types.js";
import { PalabraTranslationAdapter, type PalabraWebSocketLike } from "../src/adapters/palabra/index.js";

class FakeSocket implements PalabraWebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Array<(value?: unknown) => void>>();
  readonly #sentWaiters: Array<{ messageType: string; count: number; resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  readyState = 1;
  closed = false;
  failFlush = false;
  respondTask = true;
  on(event: "open" | "message" | "close" | "error", listener: (value?: unknown) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }
  send(value: string): void {
    const message = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(message);
    for (const waiter of this.#sentWaiters.splice(0)) {
      if (this.sent.filter((item) => item.message_type === waiter.messageType).length >= waiter.count) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        this.#sentWaiters.push(waiter);
      }
    }
    if (message.message_type === "flush_task" && this.failFlush) throw new Error("flush failed");
    if (message.message_type === "get_task" && this.respondTask) this.emit("message", { message_type: "current_task", data: { task_status: "running" } });
  }
  waitForSent(messageType: string, count: number): Promise<void> {
    if (this.sent.filter((item) => item.message_type === messageType).length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} ${messageType} messages.`)), 5000);
      this.#sentWaiters.push({ messageType, count, resolve, timer });
    });
  }
  close(): void { this.closed = true; this.readyState = 3; this.emit("close"); }
  emit(event: "open" | "message" | "close" | "error", value?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      if (event === "message") listener(value);
      else listener();
    }
  }
}
function context(generation = 0, sourceLanguage = "en", targetLanguage = "es"): LaneContext {
  return { sessionId: "sess", lane: "A_TO_B", generation, sourceLanguage, targetLanguage, profile: "native_live_baseline" };
}
function frame(ref: LaneContext, value = 1) {
  return createAudioFrame({ ...ref, sequence: value, capturedAtMs: value * 20, pcm16le: Uint8Array.from({ length: CANONICAL_AUDIO.bytesPerFrame }, () => value) });
}
async function* frames(ref: LaneContext, count = 1): AsyncIterable<ReturnType<typeof frame>> {
  for (let i = 0; i < count; i++) yield frame(ref, i);
}
async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
async function tick(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("auth endpoint, readiness and task configuration", async () => {
  const secret = "palabra-secret";
  const socket = new FakeSocket();
  let url = "";
  let headers: Readonly<Record<string, string>> | undefined;
  const adapter = new PalabraTranslationAdapter({ apiKey: secret, randomHash: "a".repeat(32), webSocketFactory: (value, options) => { url = value; headers = options.headers; return socket; }, pollIntervalMs: 1, readinessTimeoutMs: 100 });
  await adapter.prepare(context());
  assert.equal(url, "wss://streaming.palabra.ai/streaming-api/" + "a".repeat(32) + "/v1/speech-to-speech/stream");
  assert.deepEqual(headers, { Authorization: "Bearer " + secret });
  assert.equal(url.includes(secret), false);
  const set = socket.sent.find((item) => item.message_type === "set_task") as { data: Record<string, unknown> };
  assert.ok(set);
  const pipeline = set.data.pipeline as Record<string, unknown>;
  assert.deepEqual(pipeline.allowed_message_types, ["validated_transcription", "translated_transcription", "output_audio_data"]);
  assert.equal((pipeline.allowed_message_types as string[]).some((item) => item.includes("partial")), false);
});

test("maps adapter-boundary language tags for set_task", async () => {
  const cases = [
    ["en-US", "zh-TW", "en-us", "zh-hant"],
    ["zh-CN", "ja-JP", "zh-hans", "ja"],
    ["ko-KR", "es", "ko", "es"],
    ["en", "zh-hant", "en", "zh-hant"],
  ] as const;
  for (const [source, target, expectedSource, expectedTarget] of cases) {
    const socket = new FakeSocket();
    const adapter = new PalabraTranslationAdapter({ apiKey: "key", randomHash: "m".repeat(32), webSocketFactory: () => socket, pollIntervalMs: 1, readinessTimeoutMs: 100 });
    await adapter.prepare(context(0, source, target));
    const set = socket.sent.find((item) => item.message_type === "set_task") as { data: { pipeline: { transcription: { source_language: string }; translations: Array<{ target_language: string }> } } };
    assert.equal(set.data.pipeline.transcription.source_language, expectedSource);
    assert.equal(set.data.pipeline.translations[0]?.target_language, expectedTarget);
  }
});

test("320ms aggregation, trailing silence, normalized audio and completion", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", randomHash: "b".repeat(32), webSocketFactory: () => socket, pollIntervalMs: 1, readinessTimeoutMs: 100, settleWindowMs: 1, turnTimeoutMs: 500, closeTimeoutMs: 1, sleep: async () => undefined });
  const ref = context();
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 2);
  const inputs = socket.sent.filter((item) => item.message_type === "input_audio_data") as Array<{ data: { data: string } }>;
  assert.ok(inputs.length >= 2);
  const pcm = inputs.map((item) => Uint8Array.from(Buffer.from(item.data.data, "base64")));
  assert.equal(pcm[0]?.byteLength, 320 * 48);
  assert.ok(pcm.slice(1).reduce((sum, chunk) => sum + chunk.byteLength, 0) >= 300 * 48);
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "1", text: "hello" } } });
  socket.emit("message", { message_type: "translated_transcription", data: JSON.stringify({ transcription: { transcription_id: "1", translation_part_id: 0, text: "hola" } }) });
  socket.emit("message", { message_type: "output_audio_data", data: { last_chunk: true, data: Buffer.from(new Uint8Array(960 + 480)).toString("base64") } });
  const events = await pending;
  const audio = events.filter((event) => (event as { type: string }).type === "audio") as Array<{ frame: { sequence: number; pcm16le: Uint8Array } }>;
  assert.deepEqual(audio.map((event) => event.frame.sequence), [0, 1]);
  assert.equal(events.filter((event) => (event as { type: string }).type === "source_transcript_delta").length, 1);
  assert.equal(events.some((event) => (event as { type: string }).type === "completed"), true);
});

test("cancel during deferred pacing sleep does not send the delayed chunk", async () => {
  const socket = new FakeSocket();
  let releaseSleep: () => void = () => undefined;
  let sleepStarted = false;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "p".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    now: () => 0,
    turnTimeoutMs: 500,
    sleep: async () => {
      sleepStarted = true;
      await new Promise<void>((resolve) => { releaseSleep = resolve; });
    },
  });
  const ref = context();
  const controller = new AbortController();
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 32), signal: controller.signal }));
  for (let i = 0; i < 100 && !sleepStarted; i++) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.equal(sleepStarted, true);
  controller.abort();
  releaseSleep();
  await pending;
  assert.equal(socket.sent.filter((item) => item.message_type === "input_audio_data").length, 1);
});

test("abort during readiness force-closes and removes the preparing lane", async () => {
  const sockets: FakeSocket[] = [];
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "r".repeat(32),
    webSocketFactory: () => {
      const socket = new FakeSocket();
      socket.respondTask = sockets.length > 0;
      sockets.push(socket);
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 5000,
    closeTimeoutMs: 1,
  });
  const ref = context();
  const controller = new AbortController();
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref), signal: controller.signal }));
  for (let i = 0; i < 100 && !sockets[0]?.sent.some((item) => item.message_type === "get_task"); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.ok(sockets[0]);
  assert.equal(sockets[0]?.sent.some((item) => item.message_type === "get_task"), true);
  controller.abort();
  assert.deepEqual(await pending, []);
  assert.equal(sockets[0]?.closed, true);
  await adapter.prepare(ref);
  assert.equal(sockets.length, 2);
});

test("startup provider errors preserve sanitized code, description, and parameter", async () => {
  const socket = new FakeSocket();
  socket.respondTask = false;
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", randomHash: "e".repeat(32), webSocketFactory: () => socket, pollIntervalMs: 1, readinessTimeoutMs: 1000 });
  const ref = context();
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref), signal: new AbortController().signal }));
  for (let i = 0; i < 100 && !socket.sent.some((item) => item.message_type === "get_task"); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.equal(socket.sent.some((item) => item.message_type === "get_task"), true);
  socket.emit("message", { message_type: "error", data: { code: "bad-code", desc: "unsupported language", param: "source_language" } });
  const events = await pending;
  assert.equal(events.length, 1);
  const error = events[0] as { type: string; error: { code: string; message: string } };
  assert.equal(error.type, "error");
  assert.equal(error.error.code, "PALABRA_PROVIDER_BAD_CODE");
  assert.equal(error.error.message, "Provider error bad-code: unsupported language [param: source_language]");
});

test("cancel flush reuses the persistent socket, suppresses late events, and closeSession ends it", async () => {
  const sockets: FakeSocket[] = [];
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", randomHash: () => "c".repeat(32), webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, pollIntervalMs: 1, readinessTimeoutMs: 100, closeTimeoutMs: 1, turnTimeoutMs: 500, sleep: async () => undefined });
  const ref = context();
  const iterator = adapter.translate({ context: ref, frames: frames(ref, 100000), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void iterator.next();
  await tick();
  await adapter.cancel(ref);
  assert.equal(sockets[0]?.sent.some((item) => item.message_type === "flush_task"), true);
  assert.equal(sockets[0]?.closed, false);
  sockets[0]?.emit("message", { message_type: "translated_transcription", data: { transcription: { text: "late" } } });
  await iterator.return?.();
  const ref2 = context(1);
  const second = adapter.translate({ context: ref2, frames: frames(ref2), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void second.next();
  await tick();
  assert.equal(sockets.length, 1);
  await adapter.cancel(ref2);
  await second.return?.();
  await adapter.closeSession(ref.sessionId);
  assert.equal(sockets[0]?.sent.some((item) => item.message_type === "end_task"), true);
  assert.equal(sockets[0]?.closed, true);
});

test("successful flush retires old provider IDs before the next turn", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", randomHash: "s".repeat(32), webSocketFactory: () => socket, pollIntervalMs: 1, readinessTimeoutMs: 100, turnTimeoutMs: 500, settleWindowMs: 1, closeTimeoutMs: 1, sleep: async () => undefined });
  const ref = context();
  const first = adapter.translate({ context: ref, frames: frames(ref, 100000), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void first.next();
  for (let i = 0; i < 100 && !socket.sent.some((item) => item.message_type === "input_audio_data"); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "old", text: "old source" } } });
  await adapter.cancel(ref);
  await first.return?.();
  const inputCountBeforeSecond = socket.sent.filter((item) => item.message_type === "input_audio_data").length;
  const ref2 = context(1);
  const secondEvents = collect(adapter.translate({ context: ref2, frames: frames(ref2, 16), signal: new AbortController().signal }));
  for (let i = 0; i < 100 && socket.sent.filter((item) => item.message_type === "input_audio_data").length <= inputCountBeforeSecond; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "old", translation_part_id: 0, text: "stale target" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "old", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "new", text: "new source" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "new", translation_part_id: 0, text: "new target" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "new", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  const events = await secondEvents;
  const targetDeltas = events.filter((event) => (event as { type: string }).type === "target_transcript_delta").map((event) => (event as { delta: string }).delta);
  assert.deepEqual(targetDeltas, ["new target"]);
  assert.equal(events.some((event) => (event as { delta?: string }).delta === "stale target"), false);
  assert.equal(events.filter((event) => (event as { type: string }).type === "audio").length, 1);
  assert.equal(events.some((event) => (event as { type: string }).type === "completed"), true);
  await adapter.closeSession(ref.sessionId);
});

test("failed flush force-closes and removes the lane", async () => {
  const sockets: FakeSocket[] = [];
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", webSocketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, pollIntervalMs: 1, readinessTimeoutMs: 100, closeTimeoutMs: 1000, turnTimeoutMs: 500, sleep: async () => undefined });
  const ref = context();
  const iterator = adapter.translate({ context: ref, frames: frames(ref, 100000), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void iterator.next();
  await tick();
  sockets[0]!.failFlush = true;
  await adapter.cancel(ref);
  assert.equal(sockets[0]?.closed, true);
  assert.equal(sockets[0]?.sent.some((item) => item.message_type === "end_task"), false);
  await iterator.return?.();
  const ref2 = context(1);
  const second = adapter.translate({ context: ref2, frames: frames(ref2), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void second.next();
  await tick();
  assert.equal(sockets.length, 2);
  await adapter.cancel(ref2);
  await second.return?.();
});

test("glossary rejection and abort before start", async () => {
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", webSocketFactory: () => new FakeSocket() });
  const aborted = new AbortController();
  aborted.abort();
  assert.deepEqual(await collect(adapter.translate({ context: context(), frames: frames(context()), signal: aborted.signal })), []);
  const glossary = { ...context(), glossary: {} as never };
  const events = await collect(adapter.translate({ context: glossary, frames: frames(glossary), signal: new AbortController().signal }));
  assert.equal((events[0] as { type: string }).type, "error");
  assert.equal((events[0] as { error: { code: string } }).error.code, "PALABRA_GLOSSARY_UNSUPPORTED");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  LaneContext,
  TranslationAudioEvent,
  TranslationCompletedEvent,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationMode,
  TranslationTranscriptEvent,
} from "../src/core/types.js";
import {
  PALABRA_TRANSLATION_CAPABILITIES,
  PalabraTranslationAdapter,
  type PalabraWebSocketLike,
} from "../src/adapters/palabra/index.js";

class FakeSocket implements PalabraWebSocketLike {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly #listeners = new Map<string, Array<(value?: unknown) => void>>();
  readonly #sentWaiters: Array<{
    messageType: string;
    count: number;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
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
    if (message.message_type === "get_task" && this.respondTask) {
      this.emit("message", { message_type: "current_task", data: { task_status: "running" } });
    }
  }

  waitForSent(messageType: string, count: number): Promise<void> {
    if (this.sent.filter((item) => item.message_type === messageType).length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} ${messageType} messages.`)), 5000);
      this.#sentWaiters.push({ messageType, count, resolve, timer });
    });
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close");
  }

  emit(event: "open" | "message" | "close" | "error", value?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      if (event === "message") listener(value);
      else listener();
    }
  }
}

function context(
  generation = 0,
  sourceLanguage = "en",
  targetLanguage = "es",
  mode: TranslationMode = "balanced",
  lane: LaneContext["lane"] = "A_TO_B",
  turnId = "turn-" + generation,
): LaneContext {
  return {
    sessionId: "sess",
    lane,
    generation,
    turnId,
    sourceLanguage,
    targetLanguage,
    behavior: resolveTranslationBehavior(mode),
  };
}

function frame(ref: LaneContext, value = 1) {
  return createAudioFrame({
    ...ref,
    sequence: value,
    capturedAtMs: value * 20,
    pcm16le: Uint8Array.from({ length: CANONICAL_AUDIO.bytesPerFrame }, () => value),
  });
}

async function* frames(ref: LaneContext, count = 1): AsyncIterable<ReturnType<typeof frame>> {
  for (let i = 0; i < count; i++) yield frame(ref, i);
}

async function collect(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
  const values: TranslationEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function eventsOf(events: readonly TranslationEvent[], kind: "audio"): TranslationAudioEvent[];
function eventsOf(events: readonly TranslationEvent[], kind: "source_transcript" | "target_transcript"): TranslationTranscriptEvent[];
function eventsOf(events: readonly TranslationEvent[], kind: "completed"): TranslationCompletedEvent[];
function eventsOf(events: readonly TranslationEvent[], kind: "error"): TranslationErrorEvent[];
function eventsOf(events: readonly TranslationEvent[], kind: TranslationEvent["kind"]): TranslationEvent[] {
  return events.filter((event) => event.kind === kind);
}

function pipeline(socket: FakeSocket, index = 0): Record<string, unknown> {
  const setTasks = socket.sent.filter((message) => message.message_type === "set_task") as Array<{
    data: { pipeline: Record<string, unknown> };
  }>;
  const task = setTasks[index];
  assert.ok(task);
  return task.data.pipeline;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("advertises complete Palabra modes and pins each lane task to its resolved behavior", async () => {
  const secret = "palabra-secret";
  const socket = new FakeSocket();
  let url = "";
  let headers: Readonly<Record<string, string>> | undefined;
  const adapter = new PalabraTranslationAdapter({
    apiKey: secret,
    randomHash: "a".repeat(32),
    webSocketFactory: (value, options) => {
      url = value;
      headers = options.headers;
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });

  assert.equal(adapter.capabilities, PALABRA_TRANSLATION_CAPABILITIES);
  assert.deepEqual(PALABRA_TRANSLATION_CAPABILITIES.supportedModes.map((entry) => entry.mode), ["fast", "balanced", "accurate"]);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsProvisionalRevisions, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsFinality, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsCancellation, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsDeterministicGlossary, false);

  await adapter.prepare(context(0, "en-US", "zh-TW", "fast"));
  await adapter.prepare(context(0, "en-US", "zh-TW", "balanced"));
  await adapter.prepare(context(0, "en-US", "zh-TW", "accurate"));

  assert.equal(url, "wss://streaming.palabra.ai/streaming-api/" + "a".repeat(32) + "/v1/speech-to-speech/stream");
  assert.deepEqual(headers, { Authorization: "Bearer " + secret });
  assert.equal(url.includes(secret), false);
  assert.equal(socket.sent.filter((message) => message.message_type === "set_task").length, 3);

  const fast = pipeline(socket, 0);
  const fastTranscription = fast.transcription as Record<string, unknown>;
  assert.equal(fastTranscription.source_language, "en-us");
  assert.equal(fastTranscription.segment_confirmation_silence_threshold, 0.4);
  assert.deepEqual(fastTranscription.sentence_splitter, { enabled: true });
  assert.equal((fast.translations as Array<Record<string, unknown>>)[0]?.target_language, "zh-hant");
  assert.equal((fast.translations as Array<Record<string, unknown>>)[0]?.translate_partial_transcriptions, true);
  assert.deepEqual(fast.allowed_message_types, ["partial_transcription", "partial_translated_transcription", "validated_transcription", "translated_transcription", "output_audio_data"]);
  assert.deepEqual(fast.translation_queue_configs, {
    global: { desired_queue_level_ms: 2000, max_queue_level_ms: 5000, auto_tempo: true, min_tempo: 1.15, max_tempo: 1.45 },
  });

  const balanced = pipeline(socket, 1);
  assert.equal((balanced.transcription as Record<string, unknown>).segment_confirmation_silence_threshold, 0.7);
  assert.equal(((balanced.translations as Array<Record<string, unknown>>)[0])?.translate_partial_transcriptions, false);
  assert.deepEqual((balanced.transcription as Record<string, unknown>).sentence_splitter, { enabled: true });
  assert.deepEqual(balanced.translation_queue_configs, {
    global: { desired_queue_level_ms: 5000, max_queue_level_ms: 20000, auto_tempo: true, min_tempo: 1.15, max_tempo: 1.45 },
  });

  const accurate = pipeline(socket, 2);
  assert.equal((accurate.transcription as Record<string, unknown>).segment_confirmation_silence_threshold, 1.2);
  assert.deepEqual((accurate.transcription as Record<string, unknown>).sentence_splitter, { enabled: false });
  assert.equal(((accurate.translations as Array<Record<string, unknown>>)[0])?.translate_partial_transcriptions, false);
  assert.deepEqual(accurate.translation_queue_configs, {
    global: { desired_queue_level_ms: 10000, max_queue_level_ms: 30000, auto_tempo: true, min_tempo: 1.15, max_tempo: 1.45 },
  });
  assert.equal(socket.closed, false);
});

test("maps Palabra language tags at the adapter seam", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "m".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });
  await adapter.prepare(context(0, "zh-CN", "ja-JP"));
  const config = pipeline(socket);
  assert.equal((config.transcription as Record<string, unknown>).source_language, "zh-hans");
  assert.equal((config.translations as Array<Record<string, unknown>>)[0]?.target_language, "ja");
});

test("paces 320ms input, emits canonical audio, and fails closed for ID-less audio", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "b".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    closeTimeoutMs: 1,
    sleep: async () => undefined,
  });
  const ref = context();
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 2);
  const inputs = socket.sent.filter((item) => item.message_type === "input_audio_data") as Array<{ data: { data: string } }>;
  const pcm = inputs.map((item) => Uint8Array.from(Buffer.from(item.data.data, "base64")));
  assert.equal(pcm[0]?.byteLength, 320 * 48);
  assert.ok(pcm.slice(1).reduce((sum, chunk) => sum + chunk.byteLength, 0) >= 320 * 48);

  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "1", text: "hello" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "1", translation_part_id: 0, text: "hola" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "1", last_chunk: true, data: Buffer.from(new Uint8Array(960 + 480)).toString("base64") } });

  const events = await pending;
  const audio = eventsOf(events, "audio");
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
  assert.deepEqual(audio.map((event) => event.frame.sequence), [0, 1]);
  assert.deepEqual(audio.map((event) => event.finality), ["provisional", "final"]);
  assert.equal(audio.every((event) => event.turnId === ref.turnId), true);
  assert.equal(eventsOf(events, "source_transcript")[0]?.text, "hello");
  assert.equal(eventsOf(events, "target_transcript")[0]?.text, "hola");
  assert.equal(eventsOf(events, "completed").length, 1);
});

test("Fast retains at most its 800ms local audio budget when the consumer stalls", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "q".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "fast", "A_TO_B", "queue-turn");
  const iterator = adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal })[Symbol.asyncIterator]();
  const first = iterator.next();
  await socket.waitForSent("input_audio_data", 1);
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "queue-id", text: "source" } } });
  assert.equal((await first).value?.kind, "source_transcript");
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "queue-id", translation_part_id: 0, text: "target" } } });
  for (let index = 0; index < 46; index++) {
    socket.emit("message", {
      message_type: "output_audio_data",
      data: {
        transcription_id: "queue-id",
        last_chunk: index === 45,
        data: Buffer.from(new Uint8Array(960)).toString("base64"),
      },
    });
  }
  const drained: TranslationEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    drained.push(next.value);
  }
  const audio = eventsOf(drained, "audio");
  assert.equal(audio.length, 40);
  assert.equal(audio[0]?.playoutSequence, 6);
  assert.equal(audio.at(-1)?.playoutSequence, 45);
  const trims = eventsOf(drained, "error").filter((event) => event.error.code === "PALABRA_LOCAL_AUDIO_QUEUE_TRIMMED");
  assert.ok(trims.length >= 1);
  assert.equal(trims.at(-1)?.revision, 6);
  assert.equal(trims.at(-1)?.finality, "final");
  assert.equal(trims.at(-1)?.evidenceRef, "palabra:local-audio-queue");
  assert.match(trims.at(-1)?.error.message ?? "", /Dropped 6 queued audio frame/u);
});

test("Fast exposes stable opaque revision replacements without provider envelopes", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "f".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "fast", "A_TO_B", "fast-turn");
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 1);

  socket.emit("message", { message_type: "partial_transcription", data: { transcription: { transcription_id: "provider-42", text: "hel" } } });
  socket.emit("message", { message_type: "partial_transcription", data: { transcription: { transcription_id: "provider-42", text: "hello" } } });
  socket.emit("message", { message_type: "partial_translated_transcription", data: { transcription: { transcription_id: "provider-42", translation_part_id: "0", text: "ho" } } });
  socket.emit("message", { message_type: "partial_translated_transcription", data: { transcription: { transcription_id: "provider-42", translation_part_id: "0", text: "hola" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "provider-42", translation_part_id: "0", text: "hola" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "provider-42", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });

  const events = await pending;
  const source = eventsOf(events, "source_transcript");
  assert.deepEqual(source.map((event) => event.text), ["hel", "hello"]);
  assert.deepEqual(source.map((event) => event.revision), [0, 1]);
  assert.equal(source[0]?.segmentId, source[1]?.segmentId);
  assert.deepEqual(source.map((event) => event.finality), ["provisional", "provisional"]);

  const target = eventsOf(events, "target_transcript");
  assert.deepEqual(target.map((event) => event.text), ["ho", "hola", "hola"]);
  assert.deepEqual(target.map((event) => event.revision), [0, 1, 2]);
  assert.equal(target[0]?.segmentId, target[2]?.segmentId);
  assert.deepEqual(target.map((event) => event.finality), ["provisional", "provisional", "final"]);
  assert.equal(JSON.stringify(events).includes("provider-42"), false);
  assert.equal(eventsOf(events, "completed").length, 1);
});

test("flush keeps the lane task alive, tombstones late IDs, and never replays stale audio", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "s".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    closeTimeoutMs: 1,
    sleep: async () => undefined,
  });
  const firstRef = context(0, "en", "es", "balanced", "A_TO_B", "first-turn");
  const first = adapter.translate({ context: firstRef, frames: frames(firstRef, 100000), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void first.next();
  await socket.waitForSent("input_audio_data", 1);
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "old-id", text: "old source" } } });
  await adapter.cancel(firstRef);
  const flush = socket.sent.find((message) => message.message_type === "flush_task") as { data: unknown } | undefined;
  assert.deepEqual(flush?.data, { languages: ["global"], pause_task: false });
  assert.equal(socket.closed, false);
  await first.return?.();

  const inputCount = socket.sent.filter((message) => message.message_type === "input_audio_data").length;
  const secondRef = context(1, "en", "es", "balanced", "A_TO_B", "second-turn");
  const second = collect(adapter.translate({ context: secondRef, frames: frames(secondRef, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", inputCount + 1);
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "old-id", translation_part_id: 0, text: "stale target" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "old-id", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "new-id", text: "new source" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "new-id", translation_part_id: 0, text: "new target" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "new-id", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });

  const events = await second;
  assert.deepEqual(eventsOf(events, "target_transcript").map((event) => event.text), ["new target"]);
  assert.equal(eventsOf(events, "audio").length, 1);
  assert.equal(JSON.stringify(events).includes("old-id"), false);
  assert.equal(socket.sent.filter((message) => message.message_type === "set_task").length, 1);
});

test("one lane recovers independently when the other lane transport fails", async () => {
  const sockets: FakeSocket[] = [];
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: () => "r".repeat(32),
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const aToB = context(0, "en", "es", "balanced", "A_TO_B", "a-turn");
  const bToA = context(0, "es", "en", "balanced", "B_TO_A", "b-turn");
  await adapter.prepare(aToB);
  await adapter.prepare(bToA);
  assert.equal(sockets.length, 2);
  sockets[0]?.emit("error");

  const pending = collect(adapter.translate({ context: bToA, frames: frames(bToA, 16), signal: new AbortController().signal }));
  await sockets[1]!.waitForSent("input_audio_data", 1);
  sockets[1]?.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: "b-id", text: "hola" } } });
  sockets[1]?.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "b-id", translation_part_id: 0, text: "hello" } } });
  sockets[1]?.emit("message", { message_type: "output_audio_data", data: { transcription_id: "b-id", last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  const events = await pending;
  assert.equal(eventsOf(events, "target_transcript")[0]?.text, "hello");
  assert.equal(eventsOf(events, "audio").length, 1);
  assert.equal(sockets.length, 2);
});

test("failed flush closes only its lane and the next turn reconnects", async () => {
  const sockets: FakeSocket[] = [];
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    closeTimeoutMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const firstRef = context(0, "en", "es", "balanced", "A_TO_B", "first");
  const first = adapter.translate({ context: firstRef, frames: frames(firstRef, 100000), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void first.next();
  await tick();
  sockets[0]!.failFlush = true;
  await adapter.cancel(firstRef);
  assert.equal(sockets[0]?.closed, true);
  await first.return?.();

  const nextRef = context(1, "en", "es", "balanced", "A_TO_B", "second");
  const next = adapter.translate({ context: nextRef, frames: frames(nextRef), signal: new AbortController().signal })[Symbol.asyncIterator]();
  void next.next();
  await tick();
  assert.equal(sockets.length, 2);
  await adapter.cancel(nextRef);
  await next.return?.();
});

test("keyless test mechanics retain honest credential and pinned-glossary rejection", async () => {
  assert.throws(
    () => new PalabraTranslationAdapter({ apiKey: "", webSocketFactory: () => new FakeSocket() }),
    /credentials are not configured/u,
  );
  const adapter = new PalabraTranslationAdapter({ apiKey: "key", webSocketFactory: () => new FakeSocket() });
  const ref = { ...context(), glossary: {} as never };
  const events = await collect(adapter.translate({ context: ref, frames: frames(ref), signal: new AbortController().signal }));
  const error = eventsOf(events, "error")[0];
  assert.equal(error?.error.code, "PALABRA_GLOSSARY_UNSUPPORTED");
});

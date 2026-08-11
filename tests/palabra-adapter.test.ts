import assert from "node:assert/strict";
import { test } from "node:test";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  LaneContext,
  TranslationAudioEvent,
  TranslationCompletedEvent,
  TranslationDiagnosticEvent,
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
  readonly closeCalls: Array<{ readonly code: number | undefined; readonly reason: string | undefined }> = [];
  onSend: ((message: Record<string, unknown>) => void) | undefined;
  readonly #listeners = new Map<string, Array<(value?: unknown) => void>>();
  readonly #sentWaiters: Array<{
    messageType: string;
    count: number;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  readyState = 1;
  bufferedAmount = 0;
  closed = false;
  failFlush = false;
  respondTask = true;
  taskConfig: Record<string, unknown> | undefined;
  sendError: Error | undefined;
  sendErrorMessageType: string | undefined;

  on(event: "open" | "message" | "close" | "error", listener: (value?: unknown) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  send(value: string): void {
    const message = JSON.parse(value) as Record<string, unknown>;
    this.sent.push(message);
    if (message.message_type === "set_task") {
      this.taskConfig = message.data as Record<string, unknown>;
    }
    this.onSend?.(message);
    for (const waiter of this.#sentWaiters.splice(0)) {
      if (this.sent.filter((item) => item.message_type === waiter.messageType).length >= waiter.count) {
        clearTimeout(waiter.timer);
        waiter.resolve();
      } else {
        this.#sentWaiters.push(waiter);
      }
    }
    if (message.message_type === "flush_task" && this.failFlush) throw new Error("flush failed");
    if (this.sendError && (this.sendErrorMessageType === undefined || this.sendErrorMessageType === message.message_type)) throw this.sendError;
    if (message.message_type === "get_task" && this.respondTask) {
      this.emit("message", { message_type: "current_task", data: { ...this.taskConfig, task_status: "running" } });
    }
  }

  currentTask(taskConfig = this.taskConfig, taskStatus = "running"): Record<string, unknown> {
    return { message_type: "current_task", data: { ...taskConfig, task_status: taskStatus } };
  }

  waitForSent(messageType: string, count: number): Promise<void> {
    if (this.sent.filter((item) => item.message_type === messageType).length >= count) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${count} ${messageType} messages.`)), 5000);
      this.#sentWaiters.push({ messageType, count, resolve, timer });
    });
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
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

async function* openFrames(ref: LaneContext, count: number): AsyncIterable<ReturnType<typeof frame>> {
  yield* frames(ref, count);
  await new Promise<never>(() => undefined);
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
function eventsOf(events: readonly TranslationEvent[], kind: "diagnostic"): TranslationDiagnosticEvent[];
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

function accurateAdapter(socket: FakeSocket): PalabraTranslationAdapter {
  return new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "a".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
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
  assert.deepEqual(PALABRA_TRANSLATION_CAPABILITIES.modes.map((entry) => ({
    mode: entry.mode,
    behaviorVersion: entry.behaviorVersion,
    state: entry.state,
    deterministicGlossary: entry.deterministicGlossary,
  })), [
    { mode: "fast", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    { mode: "accurate", behaviorVersion: 1, state: "native", deterministicGlossary: false },
  ]);
  assert.match(PALABRA_TRANSLATION_CAPABILITIES.modes[2]?.reason ?? "", /cannot provide a deterministic pinned glossary/u);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsProvisionalRevisions, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsFinality, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsCancellation, true);
  assert.equal(PALABRA_TRANSLATION_CAPABILITIES.supportsDeterministicGlossary, false);

  const preparations = [
    await adapter.prepare(context(0, "en-US", "zh-TW", "fast")),
    await adapter.prepare(context(0, "en-US", "zh-TW", "balanced")),
    await adapter.prepare(context(0, "en-US", "zh-TW", "accurate")),
  ];
  assert.deepEqual(preparations, [
    { readiness: "remote_task_ready", remoteConnection: "connected" },
    { readiness: "remote_task_ready", remoteConnection: "connected" },
    { readiness: "remote_task_ready", remoteConnection: "connected" },
  ]);

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

test("substitutes only a canonical literal Palabra route placeholder", async () => {
  const socket = new FakeSocket();
  let url = "";
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    endpoint: "wss://streaming.palabra.example/streaming-api/{hash}/v1/speech-to-speech/stream",
    randomHash: "b".repeat(32),
    webSocketFactory: (value) => {
      url = value;
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });

  await adapter.prepare(context());
  assert.equal(
    url,
    "wss://streaming.palabra.example/streaming-api/" + "b".repeat(32) + "/v1/speech-to-speech/stream",
  );
  assert.throws(
    () => new PalabraTranslationAdapter({
      apiKey: "key",
      endpoint: "wss://streaming.palabra.example/streaming-api/%7Bhash%7D/v1/speech-to-speech/stream",
    }),
    /exactly one literal \{hash\} placeholder/u,
  );
});

test("bounds Palabra wire payloads before JSON parsing", async () => {
  const socket = new FakeSocket();
  let connectionOptions: unknown;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "l".repeat(32),
    webSocketFactory: (_url, options) => {
      connectionOptions = options;
      return socket;
    },
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "payload-limit-turn");
  const pending = collect(adapter.translate({
    context: ref,
    frames: openFrames(ref, 16),
    signal: new AbortController().signal,
  }));

  await socket.waitForSent("input_audio_data", 1);
  assert.deepEqual(connectionOptions, {
    headers: { Authorization: "Bearer key" },
    maxPayload: 512 * 1024,
    perMessageDeflate: false,
  });
  socket.emit("message", JSON.stringify({
    message_type: "error",
    data: { code: "provider-code-" + "x".repeat(512 * 1024) },
  }));

  const errors = eventsOf(await pending, "error");
  assert.deepEqual(errors.map((event) => event.error), [{
    code: "PALABRA_PAYLOAD_TOO_LARGE",
    message: "The translation service returned an oversized message.",
    retryable: false,
  }]);
  assert.deepEqual(socket.closeCalls, [{ code: 1009, reason: "payload too large" }]);
});

test("fails closed before queueing Palabra input on a saturated outbound transport", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "o".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 100,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "outbound-limit-turn");
  await adapter.prepare(ref);
  socket.bufferedAmount = 512 * 1024;

  const events = await collect(adapter.translate({
    context: ref,
    frames: openFrames(ref, 16),
    signal: new AbortController().signal,
  }));

  assert.deepEqual(eventsOf(events, "error").map((event) => event.error), [{
    code: "PALABRA_OUTBOUND_BACKPRESSURE",
    message: "The Palabra outbound buffer limit was exceeded.",
    retryable: true,
  }]);
  assert.equal(socket.sent.some((message) => message.message_type === "input_audio_data"), false);
  assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "outbound buffer limit" }]);
});

test("coalesces Fast provisional revisions and fails closed on a provider-event flood", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "f".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "fast", "A_TO_B", "event-flood-turn");
  const controller = new AbortController();
  const iterator = adapter.translate({
    context: ref,
    frames: openFrames(ref, 16),
    signal: controller.signal,
  })[Symbol.asyncIterator]();
  const first = iterator.next();
  await socket.waitForSent("input_audio_data", 1);
  socket.emit("message", {
    message_type: "partial_transcription",
    data: { transcription: { transcription_id: "same-segment", text: "revision-0" } },
  });
  const initial = await first;
  assert.equal(initial.value?.kind, "source_transcript");
  assert.equal(initial.value?.kind === "source_transcript" ? initial.value.text : undefined, "revision-0");

  for (let revision = 1; revision <= 300; revision += 1) {
    socket.emit("message", {
      message_type: "partial_transcription",
      data: { transcription: { transcription_id: "same-segment", text: "revision-" + revision } },
    });
  }
  const coalesced = await iterator.next();
  assert.equal(coalesced.value?.kind, "source_transcript");
  assert.equal(coalesced.value?.kind === "source_transcript" ? coalesced.value.text : undefined, "revision-300");

  const firstDiagnostic = iterator.next();
  const idlessAudio = Buffer.from(new Uint8Array(960)).toString("base64");
  socket.emit("message", { message_type: "output_audio_data", data: { data: idlessAudio } });
  assert.equal((await firstDiagnostic).value?.kind, "diagnostic");
  for (let index = 0; index <= 256; index += 1) {
    socket.emit("message", { message_type: "output_audio_data", data: { data: idlessAudio } });
  }
  controller.abort();
  const remaining: TranslationEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }

  assert.deepEqual(eventsOf(remaining, "error").map((event) => event.error), [{
    code: "PALABRA_EVENT_QUEUE_LIMIT",
    message: "The Palabra provider event queue limit was exceeded.",
    retryable: true,
  }]);
  assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "event queue limit" }]);
});

test("bounds stalled Palabra provisional queues by aggregate UTF-8 bytes", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "j".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "fast", "A_TO_B", "stalled-byte-queue-turn");
  const iterator = adapter.translate({
    context: ref,
    frames: openFrames(ref, 16),
    signal: new AbortController().signal,
  })[Symbol.asyncIterator]();
  const first = iterator.next();
  await socket.waitForSent("input_audio_data", 1);
  socket.emit("message", {
    message_type: "partial_transcription",
    data: { transcription: { transcription_id: "stalled-bootstrap", text: "seed" } },
  });
  const initial = await first;
  assert.equal(initial.value?.kind, "source_transcript");
  const text = "x".repeat(60 * 1024);
  for (let index = 0; index < 5; index += 1) {
    socket.emit("message", {
      message_type: "partial_transcription",
      data: { transcription: { transcription_id: "stalled-id-" + index, text } },
    });
  }
  const remaining: TranslationEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  const errors = eventsOf(remaining, "error");
  assert.deepEqual(errors.map((event) => event.error.code), ["PALABRA_EVENT_QUEUE_LIMIT"]);
  assert.ok(remaining.length <= 5);
  assert.ok(remaining.reduce((total, event) => total + Buffer.byteLength(JSON.stringify(event), "utf8"), 0) <= 256 * 1024);
  assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "event queue limit" }]);
});

test("bounds Palabra provider nesting, text/ID sizes, and turn cardinality", async () => {
  {
    const socket = new FakeSocket();
    const adapter = new PalabraTranslationAdapter({
      apiKey: "key",
      randomHash: "f".repeat(32),
      webSocketFactory: () => socket,
      pollIntervalMs: 1,
      readinessTimeoutMs: 100,
      turnTimeoutMs: 500,
      sleep: async () => undefined,
    });
    const ref = context(0, "en", "es", "fast", "A_TO_B", "fast-turn");
    const pending = collect(adapter.translate({ context: ref, frames: openFrames(ref, 16), signal: new AbortController().signal }));
    await socket.waitForSent("input_audio_data", 1);
    let nested: unknown = { transcription: { transcription_id: "deep-id", text: "hello" } };
    for (let depth = 0; depth < 9; depth += 1) nested = { data: nested };
    socket.emit("message", { message_type: "partial_transcription", data: nested });
    const errors = eventsOf(await pending, "error");
    assert.deepEqual(errors.map((event) => event.error.code), ["PALABRA_INVALID_PAYLOAD"]);
    assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "invalid message" }]);
  }

  const expectLimit = async (hash: string, data: Record<string, unknown>): Promise<void> => {
    const socket = new FakeSocket();
    const adapter = new PalabraTranslationAdapter({
      apiKey: "key",
      randomHash: hash,
      webSocketFactory: () => socket,
      pollIntervalMs: 1,
      readinessTimeoutMs: 100,
      turnTimeoutMs: 500,
      sleep: async () => undefined,
    });
    const ref = context(0, "en", "es", "fast", "A_TO_B", "size-limit-" + hash[0]);
    const pending = collect(adapter.translate({ context: ref, frames: openFrames(ref, 16), signal: new AbortController().signal }));
    await socket.waitForSent("input_audio_data", 1);
    socket.emit("message", { message_type: "partial_transcription", data });
    const errors = eventsOf(await pending, "error");
    assert.deepEqual(errors.map((event) => event.error.code), ["PALABRA_EVENT_QUEUE_LIMIT"]);
    assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "event queue limit" }]);
  };
  await expectLimit("t".repeat(32), {
    transcription: { transcription_id: "text-limit", text: "x".repeat(64 * 1024 + 1) },
  });
  await expectLimit("i".repeat(32), {
    transcription: { transcription_id: "i".repeat(257), text: "hello" },
  });

  const expectCardinality = async (hash: string, translated: boolean): Promise<void> => {
    const socket = new FakeSocket();
    const adapter = new PalabraTranslationAdapter({
      apiKey: "key",
      randomHash: hash,
      webSocketFactory: () => socket,
      pollIntervalMs: 1,
      readinessTimeoutMs: 100,
      turnTimeoutMs: 5000,
      sleep: async () => undefined,
    });
    const ref = context(0, "en", "es", "fast", "A_TO_B", "cardinality-" + hash[0]);
    const pending = collect(adapter.translate({ context: ref, frames: openFrames(ref, 16), signal: new AbortController().signal }));
    await socket.waitForSent("input_audio_data", 1);
    for (let index = 0; index < 257; index += 1) {
      socket.emit("message", translated
        ? { message_type: "partial_translated_transcription", data: { transcription: { transcription_id: "one-id", translation_part_id: index, text: "target" } } }
        : { message_type: "partial_transcription", data: { transcription: { transcription_id: "id-" + index, text: "source" } } });
    }
    const events = await pending;
    assert.equal(eventsOf(events, "error").at(-1)?.error.code, "PALABRA_EVENT_QUEUE_LIMIT");
    assert.deepEqual(socket.closeCalls, [{ code: 1008, reason: "event queue limit" }]);
  };
  await expectCardinality("p".repeat(32), false);
  await expectCardinality("s".repeat(32), true);
});

test("emits only fixed codes and opaque references for provider warnings and errors", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "w".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "provider-redaction-turn");
  const pending = collect(adapter.translate({
    context: ref,
    frames: frames(ref, 16),
    signal: new AbortController().signal,
  }));
  await socket.waitForSent("input_audio_data", 1);
  const sensitiveBodies = {
    message: "provider-message-sensitive-sentinel",
    description: "provider-description-sensitive-sentinel",
    desc: "provider-desc-sensitive-sentinel",
    parameter: "provider-parameter-sensitive-sentinel",
    param: "provider-param-sensitive-sentinel",
  };
  const sensitiveCodes = {
    warning: "warning-code-sensitive-sentinel",
    error: "error-code-sensitive-sentinel",
  };
  socket.emit("message", {
    message_type: "warning",
    data: { code: sensitiveCodes.warning, ...sensitiveBodies },
  });
  socket.emit("message", {
    message_type: "error",
    data: { code: sensitiveCodes.error, ...sensitiveBodies },
  });

  const errors = eventsOf(await pending, "error");
  assert.deepEqual(errors.map((event) => ({
    code: event.error.code,
    message: event.error.message,
    retryable: event.error.retryable,
  })), [
    { code: "PALABRA_PROVIDER_WARNING", message: "Palabra provider warning.", retryable: true },
    { code: "PALABRA_PROVIDER_ERROR", message: "Palabra provider error.", retryable: true },
  ]);
  assert.equal(
    errors.every((event) => /^palabra:provider:v1:sha256:[a-f0-9]{64}$/u.test(event.evidenceRef)),
    true,
  );
  const translationEventPayload = JSON.stringify(errors);
  const relayFacingAlerts = JSON.stringify(errors.map((event) => ({
    kind: event.kind,
    segmentId: event.segmentId,
    error: event.error,
  })));
  const evidenceFacingOutput = JSON.stringify(errors.map((event) => event.evidenceRef));
  for (const sensitiveValue of [
    ...Object.values(sensitiveBodies),
    ...Object.values(sensitiveCodes),
    "WARNING_CODE_SENSITIVE_SENTINEL",
    "ERROR_CODE_SENSITIVE_SENTINEL",
  ]) {
    assert.equal(translationEventPayload.includes(sensitiveValue), false);
    assert.equal(relayFacingAlerts.includes(sensitiveValue), false);
    assert.equal(evidenceFacingOutput.includes(sensitiveValue), false);
  }
});

test("reports Palabra remote readiness only after the socket task is running", async () => {
  const socket = new FakeSocket();
  socket.respondTask = false;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "r".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });
  let settled = false;
  const preparation = adapter.prepare(context()).then((value) => {
    settled = true;
    return value;
  });

  await socket.waitForSent("get_task", 1);
  assert.deepEqual(socket.sent.find((message) => message.message_type === "get_task")?.data, { exclude_hidden: false });
  await tick();
  assert.equal(settled, false);
  socket.emit("message", socket.currentTask());
  assert.deepEqual(await preparation, {
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  });
});

test("fences readiness to the task configuration applied by the latest set_task", async () => {
  const socket = new FakeSocket();
  socket.respondTask = false;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "fence".padEnd(32, "f"),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });
  const balanced = context(0, "en", "es", "balanced", "A_TO_B", "readiness-balanced");
  const accurate = context(0, "en", "es", "accurate", "A_TO_B", "readiness-accurate");
  const first = adapter.prepare(balanced);
  await socket.waitForSent("get_task", 1);
  const balancedTask = socket.taskConfig;
  socket.emit("message", socket.currentTask(balancedTask));
  await first;

  const second = adapter.prepare(accurate);
  await socket.waitForSent("set_task", 2);
  await socket.waitForSent("get_task", 2);
  let settled = false;
  void second.then(() => { settled = true; });
  socket.emit("message", socket.currentTask(balancedTask));
  await tick();
  assert.equal(settled, false);
  await socket.waitForSent("get_task", 3);
  socket.emit("message", socket.currentTask(socket.taskConfig));
  assert.deepEqual(await second, {
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  });
});

test("invalidates lane readiness when the socket closes", async () => {
  const sockets = [new FakeSocket(), new FakeSocket()];
  let factoryCalls = 0;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "close".padEnd(32, "c"),
    webSocketFactory: () => sockets[factoryCalls++] ?? new FakeSocket(),
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "readiness-close");
  await adapter.prepare(ref);
  sockets[0]?.emit("close");
  assert.deepEqual(await adapter.prepare(ref), {
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  });
  assert.equal(factoryCalls, 2);
});

test("retires timed-out sockets before a retry and fences late lifecycle events", async () => {
  const first = new FakeSocket();
  first.readyState = 0;
  const second = new FakeSocket();
  let factoryCalls = 0;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "x".repeat(32),
    webSocketFactory: () => factoryCalls++ === 0 ? first : second,
    connectTimeoutMs: 5,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "lifecycle-fence-turn");
  await assert.rejects(adapter.prepare(ref), (error: unknown) =>
    error instanceof Error && (error as { readonly code?: unknown }).code === "PALABRA_CONNECT_TIMEOUT",
  );
  assert.deepEqual(first.closeCalls, [{ code: 1000, reason: "connect timeout" }]);

  assert.deepEqual(await adapter.prepare(ref), { readiness: "remote_task_ready", remoteConnection: "connected" });
  first.emit("open");
  first.emit("message", { message_type: "error", data: { code: "stale-provider-error" } });
  first.emit("error");
  first.emit("close");
  assert.deepEqual(second.closeCalls, []);

  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await second.waitForSent("input_audio_data", 1);
  const providerId = "lifecycle-provider-id";
  second.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
  second.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
  second.emit("message", { message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  const events = await pending;
  assert.equal(eventsOf(events, "source_transcript")[0]?.text, "hello");
  assert.equal(eventsOf(events, "target_transcript")[0]?.text, "hola");
  assert.equal(eventsOf(events, "error").length, 0);
});

test("accepts Node ws Buffer payloads for readiness and provider events", async () => {
  const socket = new FakeSocket();
  socket.respondTask = false;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "v".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "buffer-wire-turn");
  const preparation = adapter.prepare(ref);
  await socket.waitForSent("get_task", 1);
  socket.emit("message", Buffer.from(JSON.stringify(socket.currentTask())));
  assert.deepEqual(await preparation, {
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  });

  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 1);
  const providerId = "buffer-provider-id";
  const emitWire = (message: Record<string, unknown>): void => {
    socket.emit("message", Buffer.from(JSON.stringify(message)));
  };
  emitWire({ message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
  emitWire({ message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
  emitWire({ message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });

  const events = await pending;
  assert.equal(eventsOf(events, "source_transcript")[0]?.text, "hello");
  assert.equal(eventsOf(events, "target_transcript")[0]?.text, "hola");
  assert.equal(eventsOf(events, "audio").length, 1);
  assert.equal(eventsOf(events, "completed").length, 1);
  assert.equal(eventsOf(events, "error").length, 0);
});

test("joins bounded fragmented Node ws RawData and closes on aggregate overflow", async () => {
  const socket = new FakeSocket();
  socket.respondTask = false;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "y".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "fragmented-wire-turn");
  const wire = (message: Record<string, unknown>, fragmented: boolean): Buffer[] => {
    const payload = Buffer.from(JSON.stringify(message));
    if (!fragmented) return [payload];
    const midpoint = Math.floor(payload.byteLength / 2);
    return [payload.subarray(0, midpoint), payload.subarray(midpoint)];
  };
  const preparation = adapter.prepare(ref);
  await socket.waitForSent("get_task", 1);
  socket.emit("message", wire(socket.currentTask(), true));
  assert.deepEqual(await preparation, { readiness: "remote_task_ready", remoteConnection: "connected" });

  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 1);
  const providerId = "fragmented-provider-id";
  socket.emit("message", wire({ message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } }, false));
  socket.emit("message", wire({ message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } }, false));
  socket.emit("message", wire({ message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } }, false));
  const events = await pending;
  assert.equal(eventsOf(events, "source_transcript")[0]?.text, "hello");
  assert.equal(eventsOf(events, "target_transcript")[0]?.text, "hola");
  assert.equal(eventsOf(events, "audio").length, 1);

  const overSocket = new FakeSocket();
  const overAdapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "z".repeat(32),
    webSocketFactory: () => overSocket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const overRef = context(0, "en", "es", "balanced", "A_TO_B", "fragmented-overflow-turn");
  const overPending = collect(overAdapter.translate({ context: overRef, frames: frames(overRef, 16), signal: new AbortController().signal }));
  await overSocket.waitForSent("input_audio_data", 1);
  overSocket.emit("message", [Buffer.alloc(512 * 1024), Buffer.from([0])]);
  assert.deepEqual(eventsOf(await overPending, "error").map((event) => event.error.code), ["PALABRA_PAYLOAD_TOO_LARGE"]);
  assert.deepEqual(overSocket.closeCalls, [{ code: 1009, reason: "payload too large" }]);

  const wrappedSocket = new FakeSocket();
  const wrappedAdapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "q".repeat(32),
    webSocketFactory: () => wrappedSocket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const wrappedRef = context(0, "en", "es", "balanced", "A_TO_B", "wrapped-overflow-turn");
  const wrappedPending = collect(wrappedAdapter.translate({ context: wrappedRef, frames: frames(wrappedRef, 16), signal: new AbortController().signal }));
  await wrappedSocket.waitForSent("input_audio_data", 1);
  wrappedSocket.emit("message", { data: Buffer.alloc(512 * 1024 + 1) });
  assert.deepEqual(eventsOf(await wrappedPending, "error").map((event) => event.error.code), ["PALABRA_PAYLOAD_TOO_LARGE"]);
  assert.deepEqual(wrappedSocket.closeCalls, [{ code: 1009, reason: "payload too large" }]);
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
  const providerId = "opaque-provider-id:7";
  const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 17), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 3);
  const inputs = socket.sent.filter((item) => item.message_type === "input_audio_data") as Array<{ data: { data: string } }>;
  const pcm = inputs.map((item) => Uint8Array.from(Buffer.from(item.data.data, "base64")));
  assert.deepEqual(pcm.map((chunk) => chunk.byteLength), [320 * 48, 320 * 48, 320 * 48]);
  assert.equal(pcm[1]?.subarray(0, CANONICAL_AUDIO.bytesPerFrame).every((sample) => sample === 16), true);
  assert.equal(pcm[1]?.subarray(CANONICAL_AUDIO.bytesPerFrame).every((sample) => sample === 0), true);
  assert.equal(pcm[2]?.every((sample) => sample === 0), true);

  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960 + 480)).toString("base64") } });

  const events = await pending;
  const audio = eventsOf(events, "audio");
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
  assert.deepEqual(audio.map((event) => event.frame.sequence), [0, 1]);
  assert.deepEqual(audio.map((event) => event.finality), ["provisional", "final"]);
  assert.equal(audio.every((event) => event.turnId === ref.turnId), true);
  const source = eventsOf(events, "source_transcript")[0];
  const target = eventsOf(events, "target_transcript")[0];
  assert.ok(target !== undefined);
  assert.ok(audio.every((event) => event.targetSegmentId === target?.segmentId));
  assert.ok(audio.every((event) => event.revision === target?.revision));
  const completed = eventsOf(events, "completed")[0];
  assert.equal(source?.text, "hello");
  assert.equal(target?.text, "hola");
  assert.equal(completed !== undefined, true);
  assert.equal(events.every((event) => typeof event.evidenceRef === "string" && event.evidenceRef.trim().length > 0), true);
  const providerEvidenceRefs = [source?.evidenceRef, target?.evidenceRef, ...audio.map((event) => event.evidenceRef)]
    .filter((value): value is string => value !== undefined);
  const encodedProviderId = Buffer.from(providerId).toString("base64url");
  assert.ok(providerEvidenceRefs.length > 0);
  assert.ok(providerEvidenceRefs.every((value) => /^palabra:provider:v1:sha256:[a-f0-9]{64}$/u.test(value)));
  assert.equal(providerEvidenceRefs.some((value) => value.includes(providerId)), false);
  assert.equal(providerEvidenceRefs.some((value) => value.includes(encodedProviderId)), false);
  assert.match(completed?.evidenceRef ?? "", /^palabra:adapter:v1:sha256:[a-f0-9]{64}$/u);
});

test("paces fixed 320ms Palabra input while the source remains open", async () => {
  const socket = new FakeSocket();
  let clockMs = 0;
  const inputSentAtMs: number[] = [];
  const sleepCalls: number[] = [];
  socket.onSend = (message) => {
    if (message.message_type === "input_audio_data") inputSentAtMs.push(clockMs);
  };
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "p".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    now: () => clockMs,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      clockMs += ms;
    },
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "paced-open-turn");
  const controller = new AbortController();
  const pending = collect(adapter.translate({
    context: ref,
    frames: openFrames(ref, 32),
    signal: controller.signal,
  }));

  await socket.waitForSent("input_audio_data", 2);
  await tick();
  const inputs = socket.sent.filter((message) => message.message_type === "input_audio_data") as Array<{
    data: { data: string };
  }>;
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map((message) => Buffer.from(message.data.data, "base64").byteLength), [320 * 48, 320 * 48]);
  assert.deepEqual(inputSentAtMs, [0, 320]);
  assert.deepEqual(sleepCalls, [320]);

  controller.abort();
  await pending;
});

test("Accurate withholds target and audio until an open input iterator finishes", async () => {
  const socket = new FakeSocket();
  const adapter = accurateAdapter(socket);
  const ref = context(0, "en", "es", "accurate", "A_TO_B", "accurate-open-turn");
  const controller = new AbortController();
  const iterator = adapter.translate({ context: ref, frames: openFrames(ref, 16), signal: controller.signal })[Symbol.asyncIterator]();
  const first = iterator.next();
  await socket.waitForSent("input_audio_data", 1);
  const providerId = "accurate-open-provider";
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });

  const observed: TranslationEvent[] = [];
  const firstResult = await first;
  if (!firstResult.done) observed.push(firstResult.value);
  await tick();
  assert.equal(eventsOf(observed, "target_transcript").length, 0);
  assert.equal(eventsOf(observed, "audio").length, 0);
  controller.abort();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    observed.push(next.value);
  }
  assert.equal(eventsOf(observed, "target_transcript").length, 0);
  assert.equal(eventsOf(observed, "audio").length, 0);
});

test("Accurate releases only final target and audio after input completion", async () => {
  const socket = new FakeSocket();
  let releaseInput!: () => void;
  const inputReleased = new Promise<void>((resolve) => { releaseInput = resolve; });
  async function* gatedFrames(ref: LaneContext): AsyncIterable<ReturnType<typeof frame>> {
    yield* frames(ref, 16);
    await inputReleased;
  }
  const adapter = accurateAdapter(socket);
  const ref = context(0, "en", "es", "accurate", "A_TO_B", "accurate-final-turn");
  const pending = collect(adapter.translate({ context: ref, frames: gatedFrames(ref), signal: new AbortController().signal }));
  await socket.waitForSent("input_audio_data", 1);
  const providerId = "accurate-final-provider";
  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
  await tick();
  releaseInput();
  const events = await pending;
  assert.deepEqual(eventsOf(events, "target_transcript").map((event) => event.finality), ["final"]);
  assert.deepEqual(eventsOf(events, "audio").map((event) => event.finality), ["final"]);
  assert.equal(eventsOf(events, "completed").length, 1);
});

test("evicts superseded Palabra generations while retaining same-generation playout order", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "g".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const playOne = async (ref: LaneContext, providerId: string): Promise<number[]> => {
    const inputCount = socket.sent.filter((message) => message.message_type === "input_audio_data").length;
    const pending = collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
    await socket.waitForSent("input_audio_data", inputCount + 1);
    socket.emit("message", { message_type: "validated_transcription", data: { transcription: { transcription_id: providerId, text: "hello" } } });
    socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: providerId, translation_part_id: 0, text: "hola" } } });
    socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: providerId, last_chunk: true, data: Buffer.from(new Uint8Array(960)).toString("base64") } });
    return eventsOf(await pending, "audio").map((event) => event.playoutSequence);
  };

  assert.deepEqual(await playOne(context(0, "en", "es", "balanced", "A_TO_B", "generation-0-first"), "generation-0-first-id"), [0]);
  assert.deepEqual(await playOne(context(0, "en", "es", "balanced", "A_TO_B", "generation-0-retry"), "generation-0-retry-id"), [1]);
  assert.deepEqual(await playOne(context(5, "en", "es", "balanced", "A_TO_B", "generation-5-first"), "generation-5-first-id"), [0]);
  assert.deepEqual(await playOne(context(5, "en", "es", "balanced", "A_TO_B", "generation-5-retry"), "generation-5-retry-id"), [1]);
  assert.deepEqual(await playOne(context(0, "en", "es", "balanced", "A_TO_B", "generation-0-stale"), "generation-0-stale-id"), [0]);
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
  assert.match(trims.at(-1)?.evidenceRef ?? "", /^palabra:adapter:v1:sha256:[a-f0-9]{64}$/u);
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
  assert.deepEqual(target.map((event) => event.text), ["hola", "hola"]);
  assert.deepEqual(target.map((event) => event.revision), [1, 2]);
  assert.equal(target[0]?.segmentId, target[1]?.segmentId);
  assert.deepEqual(target.map((event) => event.finality), ["provisional", "final"]);
  const audio = eventsOf(events, "audio");
  assert.equal(audio.length, 1);
  assert.equal(audio[0]?.targetSegmentId, target.at(-1)?.segmentId);
  assert.equal(audio[0]?.revision, target.at(-1)?.revision);
  assert.equal(JSON.stringify(events).includes("provider-42"), false);
  assert.equal(eventsOf(events, "completed").length, 1);
});

test("records id-less and unvalidated provider packets as evidence-only unknown-identity diagnostics", async () => {
  const socket = new FakeSocket();
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    randomHash: "u".repeat(32),
    webSocketFactory: () => socket,
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "unknown-identity-turn");
  const controller = new AbortController();
  const iterator = adapter.translate({ context: ref, frames: frames(ref, 16), signal: controller.signal })[Symbol.asyncIterator]();
  const first = iterator.next();
  await socket.waitForSent("input_audio_data", 1);
  const idlessAudio = Buffer.from(new Uint8Array(960)).toString("base64");

  socket.emit("message", { message_type: "validated_transcription", data: { transcription: { text: "id-less source" } } });
  socket.emit("message", { message_type: "translated_transcription", data: { transcription: { transcription_id: "unvalidated-id", translation_part_id: 0, text: "unvalidated target" } } });
  socket.emit("message", { message_type: "output_audio_data", data: { data: idlessAudio } });
  socket.emit("message", { message_type: "output_audio_data", data: { data: idlessAudio } });
  socket.emit("message", { message_type: "output_audio_data", data: { transcription_id: "unvalidated-id", data: idlessAudio } });

  const observed: TranslationEvent[] = [];
  const firstResult = await first;
  if (!firstResult.done) observed.push(firstResult.value);
  await tick();
  controller.abort();
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    observed.push(next.value);
  }

  const diagnostics = eventsOf(observed, "diagnostic");
  assert.deepEqual(diagnostics.map((event) => event.reason), [
    "unknown_identity",
    "unknown_identity",
    "unknown_identity",
    "unknown_identity",
    "unknown_identity",
  ]);
  assert.deepEqual(diagnostics.map((event) => event.evidenceRef.startsWith("palabra:adapter:")), [true, false, true, true, false]);
  assert.equal(diagnostics[2]?.evidenceRef, diagnostics[3]?.evidenceRef);
  assert.equal(eventsOf(observed, "source_transcript").length, 0);
  assert.equal(eventsOf(observed, "target_transcript").length, 0);
  assert.equal(eventsOf(observed, "audio").length, 0);
  assert.equal(eventsOf(observed, "error").length, 0);
  assert.equal(JSON.stringify(observed).includes("unvalidated-id"), false);
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
  const diagnostics = eventsOf(events, "diagnostic");
  assert.deepEqual(diagnostics.map((event) => event.reason), ["adapter_tombstone", "adapter_tombstone"]);
  assert.equal(
    diagnostics.every((event) => /^palabra:provider:v1:sha256:[a-f0-9]{64}$/u.test(event.evidenceRef)),
    true,
  );
  assert.equal(eventsOf(events, "error").length, 0);
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
  const firstEvent = first.next();
  await tick();
  sockets[0]!.failFlush = true;
  await assert.rejects(adapter.cancel(firstRef), (error: unknown) =>
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === "PALABRA_CONNECTION",
  );
  const surfaced = await firstEvent;
  assert.equal(surfaced.value?.kind, "error");
  assert.equal(surfaced.value?.kind === "error" ? surfaced.value.error.code : undefined, "PALABRA_CONNECTION");
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

test("retires a lane when native set_task send throws and the next prepare reconnects", async () => {
  const first = new FakeSocket();
  first.sendError = new Error("native set_task secret");
  first.sendErrorMessageType = "set_task";
  const second = new FakeSocket();
  const sockets = [first, second];
  let factoryCalls = 0;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    webSocketFactory: () => sockets[factoryCalls++] ?? new FakeSocket(),
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "native-set-task-throw");

  await assert.rejects(adapter.prepare(ref), (error: unknown) =>
    error instanceof Error &&
    (error as { readonly code?: unknown }).code === "PALABRA_CONNECTION" &&
    error.message === "The translation service connection failed." &&
    !error.message.includes("native set_task secret"),
  );
  assert.equal(first.closed, true);
  assert.deepEqual(first.closeCalls, [{ code: 1011, reason: "connection error" }]);

  assert.deepEqual(await adapter.prepare(ref), { readiness: "remote_task_ready", remoteConnection: "connected" });
  assert.equal(factoryCalls, 2);
  assert.equal(second.sent.filter((message) => message.message_type === "set_task").length, 1);
});

test("retires a lane when native input send throws and the next prepare reconnects", async () => {
  const first = new FakeSocket();
  const second = new FakeSocket();
  const sockets = [first, second];
  let factoryCalls = 0;
  const adapter = new PalabraTranslationAdapter({
    apiKey: "key",
    webSocketFactory: () => sockets[factoryCalls++] ?? new FakeSocket(),
    pollIntervalMs: 1,
    readinessTimeoutMs: 100,
    settleWindowMs: 1,
    turnTimeoutMs: 500,
    sleep: async () => undefined,
  });
  const ref = context(0, "en", "es", "balanced", "A_TO_B", "native-input-throw");
  await adapter.prepare(ref);
  first.sendError = new Error("native input secret");
  first.sendErrorMessageType = "input_audio_data";

  const events = await collect(adapter.translate({ context: ref, frames: frames(ref, 16), signal: new AbortController().signal }));
  const errors = eventsOf(events, "error");
  assert.deepEqual(errors.map((event) => event.error.code), ["PALABRA_CONNECTION"]);
  assert.equal(errors[0]?.error.message, "The translation service connection failed.");
  assert.equal(JSON.stringify(errors).includes("native input secret"), false);
  assert.equal(first.closed, true);
  assert.deepEqual(first.closeCalls, [{ code: 1011, reason: "connection error" }]);

  assert.deepEqual(await adapter.prepare(ref), { readiness: "remote_task_ready", remoteConnection: "connected" });
  assert.equal(factoryCalls, 2);
  assert.equal(second.sent.filter((message) => message.message_type === "set_task").length, 1);
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
  assert.match(error?.evidenceRef ?? "", /^palabra:adapter:v1:sha256:[a-f0-9]{64}$/u);
});

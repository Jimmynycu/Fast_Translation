import assert from "node:assert/strict";
import { test } from "node:test";

import { CANONICAL_AUDIO, createAudioFrame, type AudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationEvent,
} from "../src/core/types.js";
import {
  type ControlledTranscriptionPort,
  type ControlledTtsPort,
  type ControlledTranscriptionRequest,
} from "../src/adapters/translation/glossary-controlled.js";
import {
  LocalPlayoutQueue,
  OpenAIAdapterError,
  type WebSocketConnectOptions,
  type WebSocketLike,
} from "../src/adapters/openai/common.js";
import {
  createOpenAITranslationAdapter,
  NativeRealtimeTranslateAdapter,
  OpenAIControlledTranslationAdapter,
  OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES,
  OPENAI_NATIVE_TRANSLATION_CAPABILITIES,
} from "../src/adapters/openai/native-realtime-translate.js";

type SocketEvent = "open" | "message" | "close" | "error";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #listeners: Record<SocketEvent, Array<(data: unknown) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: unknown) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: () => void): this;
  on(
    event: SocketEvent,
    listener: (() => void) | ((data: unknown) => void),
  ): this {
    if (event === "message") {
      this.#listeners.message.push(listener as (data: unknown) => void);
    } else {
      this.#listeners[event].push(() => (listener as () => void)());
    }
    return this;
  }

  emitOpen(): void {
    this.readyState = 1;
    for (const listener of this.#listeners.open) listener(undefined);
  }

  emitMessage(event: unknown): void {
    for (const listener of this.#listeners.message) {
      listener(JSON.stringify(event));
    }
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.#listeners.close) listener(undefined);
  }
}

function frame(generation = 1, sequence = 0): AudioFrame {
  const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  pcm16le[0] = sequence + 1;
  return createAudioFrame({
    sessionId: "session-1",
    lane: "A_TO_B",
    generation,
    sequence,
    capturedAtMs: sequence * CANONICAL_AUDIO.frameDurationMs,
    pcm16le,
  });
}

async function* frames(
  count: number,
  generation = 1,
): AsyncIterable<AudioFrame> {
  for (let sequence = 0; sequence < count; sequence += 1) {
    yield frame(generation, sequence);
  }
}

function heldFrames(
  count: number,
  generation = 1,
): Readonly<{
  readonly frames: AsyncIterable<AudioFrame>;
  readonly ended: () => boolean;
  readonly release: () => void;
}> {
  let resolveHold: (() => void) | undefined;
  let released = false;
  let iteratorEnded = false;
  async function* stream(): AsyncIterable<AudioFrame> {
    try {
      for (let sequence = 0; sequence < count; sequence += 1) {
        yield frame(generation, sequence);
      }
      await new Promise<void>((resolve) => {
        resolveHold = resolve;
        if (released) resolve();
      });
    } finally {
      iteratorEnded = true;
    }
  }
  return {
    frames: stream(),
    ended: () => iteratorEnded,
    release: () => {
      released = true;
      resolveHold?.();
    },
  };
}

function returnableFrames(
  count: number,
  generation = 1,
): Readonly<{ readonly frames: AsyncIterable<AudioFrame>; readonly ended: () => boolean }> {
  let sequence = 0;
  let ended = false;
  let resolvePending: ((result: IteratorResult<AudioFrame>) => void) | undefined;
  const iterator: AsyncIterator<AudioFrame> = {
    next: async (): Promise<IteratorResult<AudioFrame>> => {
      if (ended) return { done: true, value: undefined };
      if (sequence < count) {
        const value = frame(generation, sequence);
        sequence += 1;
        return { done: false, value };
      }
      return await new Promise<IteratorResult<AudioFrame>>((resolve) => {
        resolvePending = resolve;
      });
    },
    return: async (): Promise<IteratorResult<AudioFrame>> => {
      if (!ended) {
        ended = true;
        resolvePending?.({ done: true, value: undefined });
        resolvePending = undefined;
      }
      return { done: true, value: undefined };
    },
  };
  return {
    frames: {
      [Symbol.asyncIterator]: () => iterator,
    },
    ended: () => ended,
  };
}

function burstFrames(
  count: number,
  generation = 1,
): Readonly<{ readonly frames: AsyncIterable<AudioFrame>; readonly ended: () => boolean }> {
  let sourceEnded = false;
  async function* stream(): AsyncIterable<AudioFrame> {
    try {
      for (let sequence = 0; sequence < count; sequence += 1) {
        const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
        pcm16le[0] = sequence + 1;
        yield createAudioFrame({
          sessionId: "session-1",
          lane: "A_TO_B",
          generation,
          sequence,
          capturedAtMs: 0,
          pcm16le,
        });
      }
    } finally {
      sourceEnded = true;
    }
  }
  return { frames: stream(), ended: () => sourceEnded };
}

function context(mode: "fast" | "balanced" | "accurate", generation = 1): LaneContext {
  return {
    sessionId: "session-1",
    lane: "A_TO_B",
    generation,
    turnId: "turn-" + generation.toString(10),
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    behavior: resolveTranslationBehavior(mode),
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function sentEvents(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

test("OpenAI capability metadata is honest and unavailable credentials do not create a live adapter", async () => {
  assert.deepEqual(
    OPENAI_NATIVE_TRANSLATION_CAPABILITIES.supportedModes.map((mode) => mode.mode),
    ["fast", "balanced"],
  );
  assert.equal(
    OPENAI_NATIVE_TRANSLATION_CAPABILITIES.supportedModes[1]?.degradation,
    "Balanced uses adapter-local holdback; it is not a model-quality claim.",
  );
  assert.deepEqual(
    OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES.supportedModes.map((mode) => mode.mode),
    ["fast", "balanced", "accurate"],
  );
  assert.equal(
    OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES.supportsDeterministicGlossary,
    true,
  );

  assert.throws(
    () =>
      createOpenAITranslationAdapter({
        provider: "openai_native",
        apiKey: " ",
      }),
    (error: unknown) =>
      error instanceof OpenAIAdapterError && error.code === "configuration_error",
  );

  const adapter = new NativeRealtimeTranslateAdapter({ apiKey: "test-key" });
  await assert.rejects(
    adapter.prepare(context("accurate")),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.message.includes("experimental and unavailable"),
  );
});

test("native Realtime uses 200 ms appends and emits normalized revisions and playout sequence", async () => {
  const socket = new FakeWebSocket();
  let openedUrl = "";
  let connectOptions: WebSocketConnectOptions | undefined;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    now: () => 500,
    webSocketFactory: (url, options) => {
      openedUrl = url;
      connectOptions = options;
      return socket;
    },
  });
  const outputPromise = collect(
    adapter.translate({
      frames: frames(10),
      context: context("fast"),
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => openedUrl.length > 0);
  assert.equal(openedUrl, "wss://api.openai.com/v1/realtime?model=gpt-realtime");
  assert.equal(connectOptions?.headers.Authorization, "Bearer test-key");
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "response.create"),
  );

  const outgoing = sentEvents(socket);
  const appends = outgoing.filter(
    (event) => event.type === "input_audio_buffer.append",
  );
  assert.equal(appends.length, 1);
  assert.equal(
    Buffer.from(String(appends[0]?.audio), "base64").byteLength,
    CANONICAL_AUDIO.bytesPerFrame * 10,
  );
  assert.equal(outgoing.some((event) => event.type === "input_audio_buffer.commit"), true);

  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "source-1",
    delta: "hello",
  });
  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "source-1",
    transcript: "hello",
  });
  socket.emitMessage({
    type: "response.output_audio_transcript.delta",
    response_id: "response-1",
    delta: "\u4f60",
  });
  socket.emitMessage({
    type: "response.output_audio_transcript.done",
    response_id: "response-1",
    transcript: "\u4f60\u597d",
  });
  const providerAudio = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * 2);
  providerAudio[0] = 9;
  providerAudio[CANONICAL_AUDIO.bytesPerFrame] = 8;
  socket.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.from(providerAudio).toString("base64"),
  });
  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });

  const output = await outputPromise;
  assert.deepEqual(
    output.map((event) => event.kind),
    [
      "source_transcript",
      "source_transcript",
      "target_transcript",
      "target_transcript",
      "audio",
      "audio",
      "completed",
    ],
  );
  const source = output.filter(
    (event): event is Extract<
      TranslationEvent,
      { kind: "source_transcript" | "target_transcript" }
    > =>
      event.kind === "source_transcript",
  );
  assert.deepEqual(source.map((event) => [event.revision, event.finality, event.text]), [
    [1, "provisional", "hello"],
    [2, "final", "hello"],
  ]);
  const target = output.filter(
    (event): event is Extract<
      TranslationEvent,
      { kind: "source_transcript" | "target_transcript" }
    > =>
      event.kind === "target_transcript",
  );
  assert.deepEqual(target.map((event) => [event.revision, event.finality, event.text]), [
    [1, "provisional", "\u4f60"],
    [2, "final", "\u4f60\u597d"],
  ]);
  const audio = output.filter(
    (event): event is Extract<TranslationEvent, { kind: "audio" }> =>
      event.kind === "audio",
  );
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
  assert.deepEqual(audio.map((event) => event.frame.pcm16le[0]), [9, 8]);
  assert.ok(output.every((event) => event.turnId === "turn-1"));
});

test("native Fast creates a bounded rolling response before its source iterator closes", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const source = heldFrames(80, 11);
  const generation = context("fast", 11);
  const outputPromise = collect(
    adapter.translate({
      frames: source.frames,
      context: generation,
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "response.create"),
  );
  await waitUntil(() =>
    sentEvents(socket).filter((event) => event.type === "input_audio_buffer.append").length === 4,
  );

  assert.equal(source.ended(), false);
  const outgoing = sentEvents(socket);
  assert.equal(
    outgoing.filter((event) => event.type === "input_audio_buffer.append").length,
    4,
  );
  assert.equal(
    outgoing.filter((event) => event.type === "input_audio_buffer.commit").length,
    1,
  );
  assert.equal(
    outgoing.filter((event) => event.type === "response.create").length,
    1,
  );

  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });
  await waitUntil(() =>
    sentEvents(socket).filter((event) => event.type === "response.create").length === 2,
  );
  assert.equal(
    sentEvents(socket).filter((event) => event.type === "input_audio_buffer.append").length,
    8,
  );

  await adapter.cancel(generation);
  source.release();
  assert.deepEqual(await outputPromise, []);
});

test("native Fast bounds delayed continuous ingress, surfaces trims, and resumes with the newest window", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const source = burstFrames(160, 16);
  const outputPromise = collect(
    adapter.translate({
      frames: source.frames,
      context: context("fast", 16),
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).filter((event) => event.type === "response.create").length === 1,
  );
  await waitUntil(source.ended);
  assert.equal(
    sentEvents(socket).filter((event) => event.type === "input_audio_buffer.append").length,
    4,
  );
  assert.deepEqual(
    sentEvents(socket)
      .filter((event) => event.type === "input_audio_buffer.append")
      .map((event) => Buffer.from(String(event.audio), "base64")[0]),
    [1, 11, 21, 31],
  );

  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });
  await waitUntil(() =>
    sentEvents(socket).filter((event) => event.type === "response.create").length === 2,
  );
  assert.deepEqual(
    sentEvents(socket)
      .filter((event) => event.type === "input_audio_buffer.append")
      .map((event) => Buffer.from(String(event.audio), "base64")[0]),
    [1, 11, 21, 31, 121, 131, 141, 151],
  );

  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });
  const output = await outputPromise;
  assert.equal(output.at(-1)?.kind, "completed");
  assert.deepEqual(
    output
      .filter((event): event is Extract<TranslationEvent, { kind: "error" }> =>
        event.kind === "error",
      )
      .map((event) => event.error.code),
    [
      "OPENAI_REALTIME_INPUT_QUEUE_TRIMMED",
      "OPENAI_REALTIME_INPUT_QUEUE_TRIMMED",
    ],
  );
});

test("native playout sequence continues across completed turns in one generation", async () => {
  const sockets = [new FakeWebSocket(), new FakeWebSocket()];
  let socketIndex = 0;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      const socket = sockets[socketIndex];
      socketIndex += 1;
      if (socket === undefined) throw new Error("unexpected connection");
      return socket;
    },
  });
  const firstContext = context("fast", 13);
  const secondContext: LaneContext = {
    ...context("fast", 13),
    turnId: "turn-13-second",
  };

  const firstOutput = collect(
    adapter.translate({
      frames: frames(1, 13),
      context: firstContext,
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => socketIndex === 1);
  sockets[0]?.emitOpen();
  await waitUntil(() =>
    sentEvents(sockets[0]!).some((event) => event.type === "response.create"),
  );
  sockets[0]?.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 1).toString("base64"),
  });
  sockets[0]?.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });

  const secondOutput = collect(
    adapter.translate({
      frames: frames(1, 13),
      context: secondContext,
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => socketIndex === 2);
  sockets[1]?.emitOpen();
  await waitUntil(() =>
    sentEvents(sockets[1]!).some((event) => event.type === "response.create"),
  );
  sockets[1]?.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 2).toString("base64"),
  });
  sockets[1]?.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });

  const audioSequences = (await Promise.all([firstOutput, secondOutput]))
    .flatMap((output) => output)
    .filter((event): event is Extract<TranslationEvent, { kind: "audio" }> =>
      event.kind === "audio",
    )
    .map((event) => [event.playoutSequence, event.frame.sequence]);
  assert.deepEqual(audioSequences, [[0, 0], [1, 1]]);
});

test("native Balanced locally holds output and suppresses provisional transcript revisions", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const iterator = adapter.translate({
    frames: frames(10, 2),
    context: context("balanced", 2),
    signal: new AbortController().signal,
  })[Symbol.asyncIterator]();
  const firstEvent = iterator.next();
  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "response.create"),
  );
  const startedAtMs = Date.now();
  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "source-2",
    delta: "delayed",
  });
  socket.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 7).toString("base64"),
  });
  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });

  const early = await Promise.race([
    firstEvent.then(() => "event" as const),
    delay(80).then(() => "waiting" as const),
  ]);
  assert.equal(early, "waiting");
  const first = await firstEvent;
  assert.equal(first.done, false);
  assert.ok(Date.now() - startedAtMs >= 200);
  const output: TranslationEvent[] = [first.value];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    output.push(next.value);
  }
  assert.equal(output.some((event) => event.finality === "provisional"), false);
  assert.equal(output.some((event) => event.kind === "source_transcript"), true);
  assert.equal(output.some((event) => event.kind === "audio"), true);
});

test("adapter-local playout queue is bounded and retains the newest audio before terminal completion", async () => {
  const queue = new LocalPlayoutQueue<string>(1);
  assert.equal(queue.offer("old", { audio: true, holdbackMs: 20 }), "accepted");
  assert.equal(queue.offer("new", { audio: true, holdbackMs: 20 }), "dropped_oldest");
  queue.closeAfterDrain("completed");
  assert.deepEqual(await collect(queue), ["new", "completed"]);
});

test("native cancellation fences delayed and late provider output", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const generation = context("balanced", 3);
  const outputPromise = collect(
    adapter.translate({
      frames: frames(10, 3),
      context: generation,
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "response.create"),
  );
  socket.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 3).toString("base64"),
  });
  await adapter.cancel(generation);
  socket.emitMessage({
    type: "response.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 4).toString("base64"),
  });
  socket.emitMessage({
    type: "response.done",
    response: { status: "completed" },
  });

  assert.deepEqual(await outputPromise, []);
  await delay(280);
  assert.deepEqual(await outputPromise, []);
  assert.equal(
    sentEvents(socket).some((event) => event.type === "response.cancel"),
    true,
  );
});

test("native Realtime rejects a glossary in prepare and translate because it cannot authorize it", async () => {
  const glossary = compileGlossary({
    id: "product-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [
      {
        id: "codex",
        source: "Codex",
        aliases: [],
        targetExact: "Codex",
      },
    ],
  });
  const adapter = new NativeRealtimeTranslateAdapter({ apiKey: "test-key" });
  const glossaryContext: LaneContext = {
    ...context("fast", 12),
    glossary,
  };

  await assert.rejects(
    adapter.prepare(glossaryContext),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.message.includes("cannot authorize a deterministic glossary"),
  );
  await assert.rejects(
    collect(
      adapter.translate({
        frames: frames(1, 12),
        context: glossaryContext,
        signal: new AbortController().signal,
      }),
    ),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.message.includes("cannot authorize a deterministic glossary"),
  );
});

test("controlled OpenAI path supports all modes and preserves the pinned turn across local continuous windows", async () => {
  const transcriber = new StubTranscriber();
  const adapter = new OpenAIControlledTranslationAdapter({
    apiKey: "test-key",
    transcriber,
    translator: { translate: async ({ text }) => text + "-translated" },
    tts: new StubTts(),
  });
  await adapter.prepare(context("fast", 4));
  await adapter.prepare(context("balanced", 4));
  await adapter.prepare(context("accurate", 4));

  const fastOutput = await collect(
    adapter.translate({
      frames: frames(2, 4),
      context: context("fast", 4),
      signal: new AbortController().signal,
    }),
  );
  const balancedOutput = await collect(
    adapter.translate({
      frames: frames(2, 5),
      context: context("balanced", 5),
      signal: new AbortController().signal,
    }),
  );
  assert.deepEqual(transcriber.turnIds, [
    "turn-4\u0000openai-window-0",
    "turn-5\u0000openai-window-0",
  ]);
  assert.equal(
    fastOutput.every((event) => event.turnId === "turn-4"),
    true,
  );
  assert.equal(
    balancedOutput.every((event) => event.turnId === "turn-5"),
    true,
  );
  assert.equal(
    fastOutput.some((event) => event.kind === "target_transcript"),
    true,
  );
  assert.equal(fastOutput.some((event) => event.kind === "audio"), true);
  assert.equal(fastOutput.at(-1)?.kind, "completed");
  assert.equal(
    balancedOutput.some((event) => event.kind === "target_transcript"),
    true,
  );
  assert.equal(balancedOutput.some((event) => event.kind === "audio"), true);
  assert.equal(balancedOutput.at(-1)?.kind, "completed");
});

test("controlled playout sequence continues across completed turns in one generation", async () => {
  const adapter = new OpenAIControlledTranslationAdapter({
    apiKey: "test-key",
    transcriber: new StubTranscriber(),
    translator: { translate: async ({ text }) => text + "-translated" },
    tts: new StubTts(),
  });
  const firstOutput = await collect(
    adapter.translate({
      frames: frames(1, 14),
      context: context("fast", 14),
      signal: new AbortController().signal,
    }),
  );
  const secondOutput = await collect(
    adapter.translate({
      frames: frames(1, 14),
      context: { ...context("fast", 14), turnId: "turn-14-second" },
      signal: new AbortController().signal,
    }),
  );
  const audioSequences = [firstOutput, secondOutput]
    .flatMap((output) => output)
    .filter((event): event is Extract<TranslationEvent, { kind: "audio" }> =>
      event.kind === "audio",
    )
    .map((event) => [event.playoutSequence, event.frame.sequence]);
  assert.deepEqual(audioSequences, [[0, 0], [1, 1]]);
});

test("controlled continuous capture drains a second window while the first window is blocked", async () => {
  const transcriber = new BlockingTranscriber();
  const adapter = new OpenAIControlledTranslationAdapter({
    apiKey: "test-key",
    transcriber,
    translator: { translate: async ({ text }) => text + "-translated" },
    tts: new StubTts(),
  });
  const source = burstFrames(80, 15);
  const requestContext = context("fast", 15);
  const outputPromise = collect(
    adapter.translate({
      frames: source.frames,
      context: requestContext,
      signal: new AbortController().signal,
    }),
  );

  await transcriber.waitForFirstWindow();
  await waitUntil(source.ended);
  assert.deepEqual(transcriber.windowSequences, [Array.from({ length: 40 }, (_, index) => index)]);

  transcriber.releaseFirstWindow();
  const output = await outputPromise;
  assert.deepEqual(transcriber.windowSequences, [
    Array.from({ length: 40 }, (_, index) => index),
    Array.from({ length: 40 }, (_, index) => index + 40),
  ]);
  assert.equal(output.every((event) => event.turnId === requestContext.turnId), true);
  const targetSegments = output
    .filter((event) => event.kind === "target_transcript")
    .map((event) => event.segmentId);
  assert.deepEqual(targetSegments, [
    "segment-0:target:item-turn-15",
    "segment-1:target:item-turn-15",
  ]);
});

test("controlled cancellation wakes blocked continuous ingress and its source iterator", async () => {
  const transcriber = new BlockingTranscriber();
  const adapter = new OpenAIControlledTranslationAdapter({
    apiKey: "test-key",
    transcriber,
    translator: { translate: async ({ text }) => text + "-translated" },
    tts: new StubTts(),
  });
  const source = returnableFrames(40, 17);
  const requestContext = context("fast", 17);
  const outputPromise = collect(
    adapter.translate({
      frames: source.frames,
      context: requestContext,
      signal: new AbortController().signal,
    }),
  );

  await transcriber.waitForFirstWindow();
  await adapter.cancel(requestContext);
  await waitUntil(source.ended);
  assert.deepEqual(await outputPromise, []);
});

class BlockingTranscriber implements ControlledTranscriptionPort {
  readonly windowSequences: number[][] = [];
  readonly #firstWindowReached: Promise<void>;
  readonly #firstWindowRelease: Promise<void>;
  #resolveFirstWindow!: () => void;
  #resolveFirstRelease!: () => void;

  constructor() {
    this.#firstWindowReached = new Promise<void>((resolve) => {
      this.#resolveFirstWindow = resolve;
    });
    this.#firstWindowRelease = new Promise<void>((resolve) => {
      this.#resolveFirstRelease = resolve;
    });
  }

  async waitForFirstWindow(): Promise<void> {
    await this.#firstWindowReached;
  }

  releaseFirstWindow(): void {
    this.#resolveFirstRelease();
  }

  async *transcribe(
    request: ControlledTranscriptionRequest,
  ): AsyncIterable<import("../src/adapters/translation/glossary-controlled.js").ControlledTranscriptionEvent> {
    const sequences: number[] = [];
    for await (const event of request.events) {
      if (event.type === "audio") {
        sequences.push(event.frame.sequence);
        continue;
      }
      this.windowSequences.push(sequences);
      if (this.windowSequences.length === 1) {
        this.#resolveFirstWindow();
        await this.#firstWindowRelease;
      }
      yield {
        type: "transcript_completed",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: 1,
        itemId: "item-" + request.context.turnId,
        turnId: request.context.turnId,
        transcript: "hello",
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {
    this.releaseFirstWindow();
  }
}

class StubTranscriber implements ControlledTranscriptionPort {
  readonly turnIds: string[] = [];

  async *transcribe(
    request: ControlledTranscriptionRequest,
  ): AsyncIterable<import("../src/adapters/translation/glossary-controlled.js").ControlledTranscriptionEvent> {
    for await (const event of request.events) {
      if (event.type !== "speech_end") continue;
      this.turnIds.push(event.turnId);
      yield {
        type: "transcript_delta",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: 1,
        itemId: "item-" + event.turnId,
        turnId: event.turnId,
        delta: "hello",
      };
      yield {
        type: "transcript_completed",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: 2,
        itemId: "item-" + event.turnId,
        turnId: event.turnId,
        transcript: "hello",
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
}

class StubTts implements ControlledTtsPort {
  readonly outputFormat = CANONICAL_AUDIO;

  async *synthesize(): AsyncIterable<Uint8Array> {
    yield new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  }
}

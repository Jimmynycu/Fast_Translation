import assert from "node:assert/strict";
import { test } from "node:test";

import { CANONICAL_AUDIO, createAudioFrame, type AudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import { isSelectableTranslationMode } from "../src/core/translation-capabilities.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationFallbackPolicy,
  TranslationEvent,
} from "../src/core/types.js";
import {
  type ControlledTranscriptionPort,
  type ControlledTtsPort,
  type ControlledTranscriptionRequest,
} from "../src/adapters/translation/glossary-controlled.js";
import {
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

const NO_SOURCE_SUBSTITUTION: TranslationFallbackPolicy = Object.freeze({ kind: "none" });

type SocketEvent = "open" | "message" | "close" | "error";

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
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

  emitRaw(data: string): void {
    for (const listener of this.#listeners.message) listener(data);
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.#listeners.close) listener(undefined);
  }

  emitError(): void {
    for (const listener of this.#listeners.error) listener(undefined);
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

function assertEvidenceRefs(events: readonly TranslationEvent[]): void {
  assert.equal(
    events.every((event) => event.evidenceRef.trim().length > 0),
    true,
  );
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

function sentEvents(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

test("OpenAI capability metadata is honest and unavailable credentials do not create a live adapter", async () => {
  assert.deepEqual(
    OPENAI_NATIVE_TRANSLATION_CAPABILITIES.modes.map(
      (mode) => [mode.mode, mode.state],
    ),
    [
      ["fast", "native"],
      ["balanced", "locally_controlled"],
      ["accurate", "experimental"],
    ],
  );
  assert.equal(
    isSelectableTranslationMode(OPENAI_NATIVE_TRANSLATION_CAPABILITIES.modes[2]!),
    false,
  );
  assert.equal(
    OPENAI_NATIVE_TRANSLATION_CAPABILITIES.modes[2]?.reason?.trim().length !== 0,
    true,
  );
  assert.deepEqual(
    OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES.modes.map(
      (mode) => [mode.mode, mode.state],
    ),
    [
      ["fast", "locally_controlled"],
      ["balanced", "locally_controlled"],
      ["accurate", "locally_controlled"],
    ],
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
  assert.throws(
    () =>
      new NativeRealtimeTranslateAdapter({
        apiKey: "test-key",
        endpoint: "wss://api.openai.com/v1/realtime",
        model: "gpt-realtime",
      }),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.code === "configuration_error" &&
      error.message.includes("dedicated /v1/realtime/translations"),
  );
  assert.throws(
    () =>
      new NativeRealtimeTranslateAdapter({
        apiKey: "test-key",
        endpoint: "wss://proxy.example/v1/realtime/translations",
      }),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.code === "configuration_error" &&
      error.message.includes("dedicated /v1/realtime/translations"),
  );

  let nativeConnects = 0;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      nativeConnects += 1;
      return new FakeWebSocket();
    },
  });
  assert.deepEqual(
    await adapter.prepare(context("fast")),
    {
      readiness: "local_route_validated",
      remoteConnection: "deferred_until_first_turn",
    },
  );
  assert.equal(nativeConnects, 0);
  await assert.rejects(
    adapter.prepare(context("accurate")),
    (error: unknown) =>
      error instanceof OpenAIAdapterError &&
      error.message.includes("experimental and unavailable"),
  );
});

test("native translation uses the dedicated wire and drains on session.closed", async () => {
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
  assert.equal(
    openedUrl,
    "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
  );
  assert.equal(connectOptions?.headers.Authorization, "Bearer test-key");
  assert.equal(connectOptions?.maxPayload, 512 * 1024);
  assert.equal(connectOptions?.perMessageDeflate, false);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some(
      (event) => event.type === "session.input_audio_buffer.append",
    ),
  );

  const outgoing = sentEvents(socket);
  const types = outgoing.map((event) => event.type);
  assert.equal(types.includes("response.create"), false);
  assert.equal(types.includes("response.cancel"), false);
  assert.equal(types.includes("input_audio_buffer.commit"), false);
  assert.equal(types.includes("input_audio_buffer.clear"), false);
  assert.deepEqual(
    outgoing.find((event) => event.type === "session.update"),
    {
      type: "session.update",
      session: {
        audio: {
          input: {
            transcription: { model: "gpt-realtime-whisper" },
            noise_reduction: null,
          },
          output: { language: "zh" },
        },
      },
    },
  );
  const appends = outgoing.filter(
    (event) => event.type === "session.input_audio_buffer.append",
  );
  assert.equal(appends.length, 1);
  assert.equal(
    Buffer.from(String(appends[0]?.audio), "base64").byteLength,
    CANONICAL_AUDIO.bytesPerFrame * 10,
  );
  assert.equal(
    outgoing.some((event) => event.type === "session.close"),
    true,
  );

  socket.emitMessage({
    type: "session.input_transcript.delta",
    event_id: "input-delta-1",
    delta: "hello",
  });
  socket.emitMessage({
    type: "session.input_transcript.done",
    event_id: "input-final-1",
    transcript: "hello",
  });
  socket.emitMessage({
    type: "session.output_transcript.delta",
    event_id: "output-delta-1",
    delta: "\u4f60",
  });
  socket.emitMessage({
    type: "session.output_transcript.final",
    event_id: "output-final-1",
    transcript: "\u4f60\u597d",
  });
  const providerAudio = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * 2);
  providerAudio[0] = 9;
  providerAudio[CANONICAL_AUDIO.bytesPerFrame] = 8;
  socket.emitMessage({
    type: "session.output_audio.delta",
    event_id: "audio-1",
    delta: Buffer.from(providerAudio).toString("base64"),
  });
  socket.emitMessage({ type: "session.closed", event_id: "closed-1" });

  const output = await outputPromise;
  assertEvidenceRefs(output);
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
  assert.ok(target[0] !== undefined);
  assert.ok(audio.every((event) => event.targetSegmentId === target[0]?.segmentId));
  assert.ok(audio.every((event) => event.revision === target.at(-1)?.revision));
  assert.equal(target.at(-1)?.revision, 2);
  assert.equal(output.at(-1)?.kind, "completed");
});

test("native translation appends continuously without a response lifecycle", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const source = heldFrames(40, 11);
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
    sentEvents(socket).filter(
      (event) => event.type === "session.input_audio_buffer.append",
    ).length === 4,
  );
  assert.equal(
    sentEvents(socket).some((event) => event.type === "response.create"),
    false,
  );
  assert.equal(
    sentEvents(socket).some((event) => event.type === "input_audio_buffer.commit"),
    false,
  );
  assert.equal(source.ended(), false);

  await adapter.cancel(generation);
  source.release();
  assert.deepEqual(await outputPromise, []);
  assert.equal(
    sentEvents(socket).filter((event) => event.type === "session.close").length,
    1,
  );
});

test("native translation drops audio until an emitted target transcript identifies its segment", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const outputPromise = collect(
    adapter.translate({
      frames: frames(2, 34),
      context: context("fast", 34),
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() => sentEvents(socket).some((event) => event.type === "session.update"));
  socket.emitMessage({
    type: "session.output_audio.delta",
    event_id: "audio-before-target",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 7).toString("base64"),
  });
  socket.emitMessage({ type: "session.closed", event_id: "closed-before-target" });

  const output = await outputPromise;
  assert.equal(output.some((event) => event.kind === "audio"), false);
  assert.deepEqual(
    output.filter((event): event is Extract<TranslationEvent, { kind: "error" }> => event.kind === "error")
      .map((event) => event.error.code),
    ["OPENAI_REALTIME_AUDIO_TARGET_UNKNOWN"],
  );
});

test("native cancellation uses the translation close primitive and fences late output", async () => {
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
    sentEvents(socket).some(
      (event) => event.type === "session.input_audio_buffer.append",
    ),
  );
  await adapter.cancel(generation);
  socket.emitMessage({
    type: "session.output_audio.delta",
    event_id: "late-audio",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 4).toString("base64"),
  });
  socket.emitMessage({ type: "session.closed", event_id: "late-close" });

  assert.deepEqual(await outputPromise, []);
  const types = sentEvents(socket).map((event) => event.type);
  assert.equal(types.includes("session.close"), true);
  assert.equal(types.includes("response.cancel"), false);
  assert.equal(types.includes("input_audio_buffer.clear"), false);
});

test("native translation bounds provider payloads, nesting, and outbound buffering", async () => {
  const cases: Array<{
    readonly name: string;
    readonly emit: (socket: FakeWebSocket) => void;
    readonly expectedCode: string;
  }> = [
    {
      name: "oversized payload",
      emit: (socket) => socket.emitRaw("x".repeat(512 * 1024 + 1)),
      expectedCode: "OPENAI_REALTIME_PAYLOAD_TOO_LARGE",
    },
    {
      name: "nested payload",
      emit: (socket) => {
        let nested = JSON.stringify({ type: "session.closed" });
        for (let index = 0; index < 10; index += 1) {
          nested = JSON.stringify({ data: nested });
        }
        socket.emitRaw(nested);
      },
      expectedCode: "OPENAI_REALTIME_INVALID_PAYLOAD",
    },
    {
      name: "malformed JSON",
      emit: (socket) => socket.emitRaw("{"),
      expectedCode: "OPENAI_REALTIME_INVALID_PAYLOAD",
    },
    {
      name: "oversized provider id",
      emit: (socket) => socket.emitMessage({
        type: "session.output_transcript.delta",
        event_id: "e".repeat(300),
        delta: "hello",
      }),
      expectedCode: "OPENAI_REALTIME_INVALID_PAYLOAD",
    },
  ];
  for (const testCase of cases) {
    const socket = new FakeWebSocket();
    let connected = false;
    const adapter = new NativeRealtimeTranslateAdapter({
      apiKey: "test-key",
      webSocketFactory: () => {
        connected = true;
        return socket;
      },
    });
    const source = heldFrames(1, 30);
    const outputPromise = collect(
      adapter.translate({
        frames: source.frames,
        context: context("fast", 30),
        signal: new AbortController().signal,
      }),
    );
    await waitUntil(() => connected);
    socket.emitOpen();
    await waitUntil(() => sentEvents(socket).some((event) => event.type === "session.update"));
    socket.emitRaw(JSON.stringify({ type: "session.input_transcript.delta", delta: "warmup" }));
    testCase.emit(socket);
    source.release();
    const output = await outputPromise;
    const errors = output.filter(
      (event): event is Extract<TranslationEvent, { kind: "error" }> =>
        event.kind === "error",
    );
    assert.equal(errors.length, 1, testCase.name);
    assert.equal(errors[0]?.error.code, testCase.expectedCode, testCase.name);
    assert.equal(errors[0]?.error.message.includes("provider"), false);
  }

  const socket = new FakeWebSocket();
  socket.bufferedAmount = 512 * 1024;
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const outputPromise = collect(
    adapter.translate({
      frames: frames(1, 31),
      context: context("fast", 31),
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => connected);
  socket.emitOpen();
  const output = await outputPromise;
  const errors = output.filter(
    (event): event is Extract<TranslationEvent, { kind: "error" }> =>
      event.kind === "error",
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.error.code, "OPENAI_REALTIME_CONNECTION");
});

test("native provider and socket failures are static, lane-local terminal errors", async () => {
  for (const failure of ["provider", "socket"] as const) {
    const socket = new FakeWebSocket();
    let connected = false;
    const adapter = new NativeRealtimeTranslateAdapter({
      apiKey: "test-key",
      webSocketFactory: () => {
        connected = true;
        return socket;
      },
    });
    const outputPromise = collect(
      adapter.translate({
        frames: frames(1, failure === "provider" ? 32 : 33),
        context: context("fast", failure === "provider" ? 32 : 33),
        signal: new AbortController().signal,
      }),
    );
    await waitUntil(() => connected);
    socket.emitOpen();
    await waitUntil(() => sentEvents(socket).some((event) => event.type === "session.update"));
    if (failure === "provider") {
      socket.emitMessage({
        type: "error",
        error: { message: "provider secret /internal/provider/path" },
      });
    } else {
      socket.emitError();
    }
    const output = await outputPromise;
    const errors = output.filter(
      (event): event is Extract<TranslationEvent, { kind: "error" }> =>
        event.kind === "error",
    );
    assert.equal(errors.length, 1);
    assert.equal(
      errors[0]?.error.code,
      failure === "provider"
        ? "OPENAI_REALTIME_PROVIDER"
        : "OPENAI_REALTIME_CONNECTION",
    );
    assert.equal(errors[0]?.error.message.includes("secret"), false);
    assert.equal(errors[0]?.error.message.includes("/internal"), false);
  }
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
    fallback: NO_SOURCE_SUBSTITUTION,
    transcriber,
    translator: { translate: async ({ text }) => text + "-translated" },
    tts: new StubTts(),
  });
  const preparations = [
    await adapter.prepare(context("fast", 4)),
    await adapter.prepare(context("balanced", 4)),
    await adapter.prepare(context("accurate", 4)),
  ];
  assert.deepEqual(preparations, [
    { readiness: "local_route_validated", remoteConnection: "deferred_until_first_turn" },
    { readiness: "local_route_validated", remoteConnection: "deferred_until_first_turn" },
    { readiness: "local_route_validated", remoteConnection: "deferred_until_first_turn" },
  ]);

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
  const accurateOutput = await collect(
    adapter.translate({
      frames: frames(2, 6),
      context: context("accurate", 6),
      signal: new AbortController().signal,
    }),
  );
  assertEvidenceRefs(fastOutput);
  assertEvidenceRefs(balancedOutput);
  assertEvidenceRefs(accurateOutput);
  assert.deepEqual(transcriber.turnIds, [
    "turn-4\u0000openai-window-0",
    "turn-5\u0000openai-window-0",
    "turn-6",
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
  assert.equal(
    accurateOutput.every((event) => event.turnId === "turn-6"),
    true,
  );
  assert.equal(accurateOutput.some((event) => event.kind === "audio"), true);
  assert.equal(accurateOutput.at(-1)?.kind, "completed");
});

test("controlled OpenAI wrapper fails closed on translator errors with a bound glossary", async () => {
  const glossary = compileGlossary({
    id: "product-terms",
    version: "1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [
      {
        id: "hello",
        source: "hello",
        aliases: [],
        targetExact: "\u4f60\u597d",
      },
    ],
  });
  for (const fallback of ["none", "same_route_fail_open"] as const) {
    const tts = new TrackingTts();
    const adapter = new OpenAIControlledTranslationAdapter({
      apiKey: "test-key",
      fallback: { kind: fallback },
      transcriber: new StubTranscriber(),
      translator: {
        translate: async () => {
          throw new Error("provider secret and /internal/path");
        },
      },
      tts,
    });
    const requestContext: LaneContext = {
      ...context("accurate", fallback === "none" ? 21 : 22),
      glossary,
    };
    const output = await collect(
      adapter.translate({
        frames: frames(1, requestContext.generation),
        context: requestContext,
        signal: new AbortController().signal,
      }),
    );
    assertEvidenceRefs(output);
    assert.equal(output.some((event) => event.kind === "source_transcript"), true);
    assert.equal(output.some((event) => event.kind === "target_transcript"), false);
    assert.equal(output.some((event) => event.kind === "audio"), false);
    assert.equal(tts.calls, 0);
    const errors = output.filter(
      (event): event is Extract<TranslationEvent, { kind: "error" }> =>
        event.kind === "error",
    );
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.message.includes("provider secret"), false);
    assert.equal(errors[0]?.error.message.includes("/internal/path"), false);
    assert.equal(output.every((event) => event.turnId === requestContext.turnId), true);
    assert.equal(output.at(-1)?.kind, "completed");
  }
});

test("controlled playout sequence continues across completed turns in one generation", async () => {
  const adapter = new OpenAIControlledTranslationAdapter({
    apiKey: "test-key",
    fallback: NO_SOURCE_SUBSTITUTION,
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
    fallback: NO_SOURCE_SUBSTITUTION,
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
    fallback: NO_SOURCE_SUBSTITUTION,
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

class TrackingTts implements ControlledTtsPort {
  readonly outputFormat = CANONICAL_AUDIO;
  calls = 0;

  async *synthesize(): AsyncIterable<Uint8Array> {
    this.calls += 1;
    yield new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  }
}

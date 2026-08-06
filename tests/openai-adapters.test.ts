import assert from "node:assert/strict";
import { test } from "node:test";

import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import type { GenerationRef, TranslationEvent } from "../src/core/types.js";
import {
  OpenAIAdapterError,
  type WebSocketConnectOptions,
  type WebSocketLike,
} from "../src/adapters/openai/common.js";
import {
  OpenAILiveTranscribeAdapter,
  type LiveTranscriptionEvent,
  type LiveTranscriptionInput,
} from "../src/adapters/openai/live-transcribe.js";
import { NativeRealtimeTranslateAdapter } from "../src/adapters/openai/native-realtime-translate.js";
import {
  extractOutputText,
  OpenAITextTranslator,
} from "../src/adapters/openai/text-translator.js";
import { OpenAITtsAdapter } from "../src/adapters/openai/tts.js";

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

  emitError(): void {
    for (const listener of this.#listeners.error) listener(undefined);
  }

  emitClose(): void {
    this.readyState = 3;
    for (const listener of this.#listeners.close) listener(undefined);
  }
}

function frame(generation = 1, sequence = 0) {
  const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  pcm16le[0] = sequence + 1;
  return createAudioFrame({
    sessionId: "session-1",
    lane: "A_TO_B",
    generation,
    sequence,
    capturedAtMs: sequence * 20,
    pcm16le,
  });
}

async function* oneFrame(generation = 1) {
  yield frame(generation);
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

function sentEvents(socket: FakeWebSocket): Array<Record<string, unknown>> {
  return socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
}

test("native realtime adapter uses the translation contract and canonicalizes output", async () => {
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
  const controller = new AbortController();
  const outputPromise = collect(
    adapter.translate({
      frames: oneFrame(),
      context: {
        sessionId: "session-1",
        lane: "A_TO_B",
        generation: 1,
        sourceLanguage: "en",
        targetLanguage: "zh-TW",
        profile: "native_live_baseline",
      },
      signal: controller.signal,
    }),
  );

  await waitUntil(() => openedUrl.length > 0);
  assert.equal(
    openedUrl,
    "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
  );
  assert.equal(connectOptions?.headers.Authorization, "Bearer test-key");
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "session.close"),
  );

  const outgoing = sentEvents(socket);
  assert.deepEqual(outgoing[0], {
    type: "session.update",
    session: {
      audio: {
        input: {
          transcription: { model: "gpt-realtime-whisper" },
          noise_reduction: null,
        },
        output: { language: "zh-TW" },
      },
    },
  });
  assert.equal(outgoing[1]?.type, "session.input_audio_buffer.append");
  assert.equal(
    Buffer.from(String(outgoing[1]?.audio), "base64").byteLength,
    CANONICAL_AUDIO.bytesPerFrame,
  );

  socket.emitMessage({
    type: "session.input_transcript.delta",
    event_id: "evt-source",
    delta: "hello",
    elapsed_ms: 200,
  });
  socket.emitMessage({
    type: "session.output_transcript.delta",
    event_id: "evt-target",
    delta: "\u4f60\u597d",
    elapsed_ms: 200,
  });
  const providerPcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * 2);
  providerPcm[0] = 9;
  providerPcm[CANONICAL_AUDIO.bytesPerFrame] = 8;
  const providerChunks = [
    providerPcm.subarray(0, 317),
    providerPcm.subarray(317, 1_301),
    providerPcm.subarray(1_301),
  ];
  providerChunks.forEach((chunk, index) => {
    socket.emitMessage({
      type: "session.output_audio.delta",
      event_id: "evt-audio-" + index,
      delta: Buffer.from(chunk).toString("base64"),
      sample_rate: 24_000,
      channels: 1,
      format: "pcm16",
    });
  });
  socket.emitMessage({ type: "session.closed", event_id: "evt-closed" });

  const output = await outputPromise;
  assert.deepEqual(
    output.map((event) => event.type),
    [
      "source_transcript_delta",
      "target_transcript_delta",
      "audio",
      "audio",
      "completed",
    ],
  );
  const audio = output.filter(
    (event): event is Extract<TranslationEvent, { type: "audio" }> =>
      event.type === "audio",
  );
  assert.deepEqual(
    audio.map((event) => event.frame.sequence),
    [0, 1],
  );
  assert.equal(audio[0]?.frame.pcm16le[0], 9);
  assert.equal(audio[1]?.frame.pcm16le[0], 8);
  assert.ok(output.every((event) => event.generation === 1));
});

test("native realtime pads a complete-sample final remainder without changing provider bytes", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    now: () => 700,
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const outputPromise = collect(
    adapter.translate({
      frames: oneFrame(2),
      context: {
        sessionId: "session-1",
        lane: "A_TO_B",
        generation: 2,
        sourceLanguage: "en",
        targetLanguage: "zh-TW",
        profile: "native_live_baseline",
      },
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "session.close"),
  );

  const providerPcm = Uint8Array.from(
    { length: CANONICAL_AUDIO.bytesPerFrame + 10 },
    (_value, index) => index % 251,
  );
  for (const chunk of [
    providerPcm.subarray(0, 13),
    providerPcm.subarray(13, 703),
    providerPcm.subarray(703),
  ]) {
    socket.emitMessage({
      type: "session.output_audio.delta",
      delta: Buffer.from(chunk).toString("base64"),
    });
  }
  socket.emitMessage({ type: "session.closed" });

  const output = await outputPromise;
  const audio = output.filter(
    (event): event is Extract<TranslationEvent, { type: "audio" }> =>
      event.type === "audio",
  );
  assert.equal(audio.length, 2);
  assert.equal(
    Buffer.compare(
      Buffer.from(audio[0]?.frame.pcm16le ?? []),
      Buffer.from(providerPcm.subarray(0, CANONICAL_AUDIO.bytesPerFrame)),
    ),
    0,
  );
  const expectedTail = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  expectedTail.set(providerPcm.subarray(CANONICAL_AUDIO.bytesPerFrame));
  assert.equal(
    Buffer.compare(
      Buffer.from(audio[1]?.frame.pcm16le ?? []),
      Buffer.from(expectedTail),
    ),
    0,
  );
  assert.equal(output.some((event) => event.type === "error"), false);
  assert.equal(output.at(-1)?.type, "completed");
});

test("native realtime reports a dangling final PCM16 byte without dropping complete samples", async () => {
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
      frames: oneFrame(4),
      context: {
        sessionId: "session-1",
        lane: "A_TO_B",
        generation: 4,
        sourceLanguage: "en",
        targetLanguage: "zh-TW",
        profile: "native_live_baseline",
      },
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some((event) => event.type === "session.close"),
  );
  const completeRemainder = Buffer.alloc(100, 7);
  socket.emitMessage({
    type: "session.output_audio.delta",
    delta: Buffer.concat([
      Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame, 3),
      completeRemainder,
      Buffer.of(255),
    ]).toString("base64"),
  });
  socket.emitMessage({ type: "session.closed" });

  const output = await outputPromise;
  const audio = output.filter(
    (event): event is Extract<TranslationEvent, { type: "audio" }> =>
      event.type === "audio",
  );
  assert.equal(audio.length, 2);
  const expectedTail = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  expectedTail.set(completeRemainder);
  assert.equal(
    Buffer.compare(
      Buffer.from(audio[1]?.frame.pcm16le ?? []),
      Buffer.from(expectedTail),
    ),
    0,
  );
  const error = output.find(
    (event): event is Extract<TranslationEvent, { type: "error" }> =>
      event.type === "error",
  );
  assert.equal(error?.error.code, "OPENAI_REALTIME_INVALID_AUDIO");
  assert.equal(output.at(-1)?.type, "completed");
});

test("native realtime reports unexpected socket close and error", async () => {
  for (const terminalEvent of ["close", "error"] as const) {
    const socket = new FakeWebSocket();
    let releaseInput: (() => void) | undefined;
    let connected = false;
    async function* heldFrames() {
      yield frame(6);
      await new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
    }
    const adapter = new NativeRealtimeTranslateAdapter({
      apiKey: "test-key",
      webSocketFactory: () => {
        connected = true;
        return socket;
      },
    });
    const outputPromise = collect(
      adapter.translate({
        frames: heldFrames(),
        context: {
          sessionId: "session-1",
          lane: "A_TO_B",
          generation: 6,
          sourceLanguage: "en",
          targetLanguage: "zh-TW",
          profile: "native_live_baseline",
        },
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
    if (terminalEvent === "close") socket.emitClose();
    else socket.emitError();
    releaseInput?.();

    const output = await outputPromise;
    assert.deepEqual(output.map((event) => event.type), ["error"]);
    const error = output[0];
    assert.equal(error?.type, "error");
    if (error?.type === "error") {
      assert.equal(error.error.code, "OPENAI_REALTIME_CONNECTION");
    }
  }
});

test("native cancellation closes its generation without reporting provider failure", async () => {
  const socket = new FakeWebSocket();
  let releaseInput: (() => void) | undefined;
  let connected = false;
  async function* heldFrames() {
    yield frame(7);
    await new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
  }
  const adapter = new NativeRealtimeTranslateAdapter({
    apiKey: "test-key",
    now: () => 900,
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const ref: GenerationRef = {
    sessionId: "session-1",
    lane: "A_TO_B",
    generation: 7,
  };
  const outputPromise = collect(
    adapter.translate({
      frames: heldFrames(),
      context: {
        ...ref,
        sourceLanguage: "en",
        targetLanguage: "ja",
        profile: "native_live_baseline",
      },
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
  await adapter.cancel(ref);
  assert.equal(socket.closes.length, 1);

  socket.emitMessage({
    type: "session.output_audio.delta",
    delta: Buffer.alloc(CANONICAL_AUDIO.bytesPerFrame).toString("base64"),
  });
  socket.emitClose();
  releaseInput?.();

  const output = await outputPromise;
  assert.deepEqual(output, []);
});

test("live transcription sends configured hints, commits speech ends, and reconciles item IDs", async () => {
  const socket = new FakeWebSocket();
  let connected = false;
  const adapter = new OpenAILiveTranscribeAdapter({
    apiKey: "test-key",
    prompt: "Factory support call",
    keywords: ["AC-42", "servo motor"],
    languages: ["en", "zh-tw"],
    delay: "low",
    now: () => 1_000,
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const ref: GenerationRef = {
    sessionId: "session-1",
    lane: "A_TO_B",
    generation: 3,
  };

  async function* inputs(): AsyncIterable<LiveTranscriptionInput> {
    yield { type: "audio", frame: frame(3, 0) };
    yield { type: "speech_end", ...ref, turnId: "turn-one" };
    yield { type: "audio", frame: frame(3, 1) };
    yield { type: "speech_end", ...ref, turnId: "turn-two" };
  }

  const outputPromise = collect(
    adapter.transcribe({
      events: inputs(),
      context: ref,
      keywords: ["servo motor", "ZX-900", "<skip>"],
      languages: ["zh-tw", "ja"],
      signal: new AbortController().signal,
    }),
  );
  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(
    () =>
      sentEvents(socket).filter(
        (event) => event.type === "input_audio_buffer.commit",
      ).length === 2,
  );

  const outgoing = sentEvents(socket);
  assert.deepEqual(outgoing[0], {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          transcription: {
            model: "gpt-live-transcribe",
            prompt: "Factory support call",
            keywords: ["AC-42", "servo motor", "ZX-900"],
            languages: ["en", "zh-tw", "ja"],
            delay: "low",
          },
          turn_detection: null,
        },
      },
    },
  });
  assert.deepEqual(
    outgoing
      .filter((event) => event.type === "input_audio_buffer.commit")
      .map((event) => event.event_id),
    ["commit_0", "commit_1"],
  );

  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-two",
    content_index: 0,
    delta: "second ",
  });
  socket.emitMessage({
    type: "input_audio_buffer.committed",
    item_id: "item-one",
  });
  socket.emitMessage({
    type: "input_audio_buffer.committed",
    item_id: "item-two",
  });
  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-two",
    content_index: 0,
    transcript: "second final",
  });
  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-one",
    content_index: 0,
    delta: "first ",
  });
  socket.emitMessage({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-one",
    content_index: 0,
    transcript: "first final",
  });

  const output = await outputPromise;
  const transcripts = output.filter(
    (
      event,
    ): event is Exclude<
      LiveTranscriptionEvent,
      { type: "error" }
    > => event.type !== "error",
  );
  assert.deepEqual(
    transcripts.map(({ itemId, turnId, type }) => ({ itemId, turnId, type })),
    [
      {
        itemId: "item-two",
        turnId: "turn-two",
        type: "transcript_delta",
      },
      {
        itemId: "item-two",
        turnId: "turn-two",
        type: "transcript_completed",
      },
      {
        itemId: "item-one",
        turnId: "turn-one",
        type: "transcript_delta",
      },
      {
        itemId: "item-one",
        turnId: "turn-one",
        type: "transcript_completed",
      },
    ],
  );
  assert.equal(output.some((event) => event.type === "error"), false);
});

test("live transcription reports unexpected socket close and error", async () => {
  for (const terminalEvent of ["close", "error"] as const) {
    const socket = new FakeWebSocket();
    let releaseInput: (() => void) | undefined;
    let connected = false;
    async function* heldInputs(): AsyncIterable<LiveTranscriptionInput> {
      yield { type: "audio", frame: frame(8) };
      await new Promise<void>((resolve) => {
        releaseInput = resolve;
      });
    }
    const adapter = new OpenAILiveTranscribeAdapter({
      apiKey: "test-key",
      webSocketFactory: () => {
        connected = true;
        return socket;
      },
    });
    const outputPromise = collect(
      adapter.transcribe({
        events: heldInputs(),
        context: {
          sessionId: "session-1",
          lane: "A_TO_B",
          generation: 8,
        },
        signal: new AbortController().signal,
      }),
    );

    await waitUntil(() => connected);
    socket.emitOpen();
    await waitUntil(() =>
      sentEvents(socket).some(
        (event) => event.type === "input_audio_buffer.append",
      ),
    );
    if (terminalEvent === "close") socket.emitClose();
    else socket.emitError();
    releaseInput?.();

    const output = await outputPromise;
    assert.deepEqual(output.map((event) => event.type), ["error"]);
    const error = output[0];
    assert.equal(error?.type, "error");
    if (error?.type === "error") {
      assert.equal(error.error.code, "OPENAI_TRANSCRIBE_CONNECTION");
    }
  }
});

test("live transcription cancellation closes cleanly", async () => {
  const socket = new FakeWebSocket();
  let releaseInput: (() => void) | undefined;
  let connected = false;
  async function* heldInputs(): AsyncIterable<LiveTranscriptionInput> {
    yield { type: "audio", frame: frame(9) };
    await new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
  }
  const adapter = new OpenAILiveTranscribeAdapter({
    apiKey: "test-key",
    webSocketFactory: () => {
      connected = true;
      return socket;
    },
  });
  const ref: GenerationRef = {
    sessionId: "session-1",
    lane: "A_TO_B",
    generation: 9,
  };
  const outputPromise = collect(
    adapter.transcribe({
      events: heldInputs(),
      context: ref,
      signal: new AbortController().signal,
    }),
  );

  await waitUntil(() => connected);
  socket.emitOpen();
  await waitUntil(() =>
    sentEvents(socket).some(
      (event) => event.type === "input_audio_buffer.append",
    ),
  );
  await adapter.cancel(ref);
  socket.emitClose();
  releaseInput?.();

  assert.equal(socket.closes.length, 1);
  assert.deepEqual(await outputPromise, []);
});

test("text translator uses Responses and parses all output_text fragments", async () => {
  let requestUrl = "";
  let requestInit: RequestInit | undefined;
  const translator = new OpenAITextTranslator({
    apiKey: "text-key",
    model: "translation-model",
    fetch: async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "\u99ac\u9054 " },
                { type: "refusal", refusal: "ignored" },
                { type: "output_text", text: "__TERM_01__" },
              ],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await translator.translate({
    text: "motor __TERM_01__",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    opaqueTokens: ["__TERM_01__"],
    maxOutputTokens: 128,
  });
  assert.equal(result, "\u99ac\u9054 __TERM_01__");
  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.model, "translation-model");
  assert.equal(body.max_output_tokens, 128);
  assert.match(String(body.instructions), /only the translation/i);
  assert.match(String(body.instructions), /byte-for-byte/i);
  assert.match(JSON.stringify(body.input), /__TERM_01__/);
  assert.equal(
    (requestInit?.headers as Record<string, string>).Authorization,
    "Bearer text-key",
  );
  assert.equal(extractOutputText({ output_text: "direct" }), "direct");
});

test("text translator passes changed opaque tokens to the controlled layer", async () => {
  const translator = new OpenAITextTranslator({
    apiKey: "text-key",
    model: "translation-model",
    fetch: async () =>
      new Response(JSON.stringify({ output_text: "translated without token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });

  assert.equal(
    await translator.translate({
      text: "motor __TERM_01__",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      opaqueTokens: ["__TERM_01__"],
    }),
    "translated without token",
  );
});

test("REST adapters never expose provider errors or credentials", async () => {
  const rawProviderError = "provider says key text-key is invalid";
  const translator = new OpenAITextTranslator({
    apiKey: "text-key",
    model: "translation-model",
    fetch: async () =>
      new Response(rawProviderError, {
        status: 401,
        statusText: rawProviderError,
      }),
  });

  await assert.rejects(
    translator.translate({
      text: "hello",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
    }),
    (error: unknown) => {
      assert.ok(error instanceof OpenAIAdapterError);
      assert.equal(error.code, "provider_error");
      assert.doesNotMatch(error.message, /text-key|provider says/i);
      return true;
    },
  );
});

test("TTS requests raw PCM and yields the response body as streaming chunks", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const tts = new OpenAITtsAdapter({
    apiKey: "tts-key",
    voice: "marin",
    fetch: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Uint8Array.of(1, 2));
            controller.enqueue(Uint8Array.of(3, 4));
            controller.close();
          },
        }),
        { status: 200 },
      );
    },
  });

  const chunks = await collect(
    tts.synthesize({
      text: "\u4f60\u597d",
      instructions: "Speak clearly.",
      speed: 1.1,
    }),
  );
  assert.deepEqual(
    chunks.map((chunk) => [...chunk]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.deepEqual(requestBody, {
    model: "gpt-4o-mini-tts",
    input: "\u4f60\u597d",
    voice: "marin",
    response_format: "pcm",
    stream_format: "audio",
    instructions: "Speak clearly.",
    speed: 1.1,
  });
  assert.equal(tts.sampleRateHz, 24_000);
  assert.equal(tts.format, "pcm16");
});

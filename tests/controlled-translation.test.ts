import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlledTranslationAdapter,
  type ControlledTranscriptionEvent,
  type ControlledTranscriptionPort,
  type ControlledTranscriptionRequest,
  type ControlledTtsPort,
  type ControlledTextTranslationPort,
} from "../src/adapters/translation/glossary-controlled.js";
import { DeterministicTranslationAdapter } from "../src/adapters/translation/deterministic.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import type {
  GenerationRef,
  TranslationEvent,
  TranslationRequest,
} from "../src/core/types.js";

const context = {
  sessionId: "session-1",
  lane: "A_TO_B" as const,
  generation: 3,
  sourceLanguage: "en",
  targetLanguage: "zh-TW",
  profile: "glossary_controlled" as const,
  glossary: compileGlossary({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "spindle",
      source: "spindle",
      aliases: ["main spindle"],
      targetExact: "\u4e3b\u8ef8",
    }],
  }),
} as const;

function frame(sequence: number) {
  return createAudioFrame({
    sessionId: context.sessionId,
    lane: context.lane,
    generation: context.generation,
    sequence,
    capturedAtMs: sequence * 20,
    pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(sequence),
  });
}

async function* frames() {
  yield frame(0);
  yield frame(1);
}

function request(): TranslationRequest {
  return {
    frames: frames(),
    context,
    signal: new AbortController().signal,
  };
}

async function collect(iterable: AsyncIterable<TranslationEvent>) {
  const events: TranslationEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

class TranscriptFake implements ControlledTranscriptionPort {
  inputs: string[] = [];
  requests: ControlledTranscriptionRequest[] = [];
  constructor(readonly event: ControlledTranscriptionEvent) {}
  async *transcribe(input: ControlledTranscriptionRequest) {
    this.requests.push(input);
    for await (const event of input.events) this.inputs.push(event.type);
    yield this.event;
  }
  async cancel(_generation: GenerationRef): Promise<void> {}
}

class TextFake implements ControlledTextTranslationPort {
  requests: string[] = [];
  constructor(readonly result: (text: string) => string | Promise<string>) {}
  async translate(input: {
    readonly text: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly opaqueTokens?: readonly string[];
    readonly signal?: AbortSignal;
  }) {
    this.requests.push(input.text);
    return this.result(input.text);
  }
}

class TtsFake implements ControlledTtsPort {
  spoken: string[] = [];
  async *synthesize(input: { readonly text: string; readonly signal?: AbortSignal }) {
    this.spoken.push(input.text);
    yield new Uint8Array(500).fill(7);
    yield new Uint8Array(500).fill(8);
  }
}

function transcript(text: string, confidence?: number): ControlledTranscriptionEvent {
  return {
    type: "transcript_completed",
    sessionId: context.sessionId,
    lane: context.lane,
    generation: context.generation,
    emittedAtMs: 5,
    itemId: "item-1",
    turnId: "turn-1",
    transcript: text,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

test("restores target_exact before streaming canonical audio", async () => {
  const transcriber = new TranscriptFake(transcript("Inspect the spindle today.", 0.99));
  const translator = new TextFake((text) =>
    text.replace("Inspect the ", "\u4eca\u65e5\u6aa2\u67e5").replace(" today.", "\u3002")
  );
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber,
    translator,
    tts,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  assert.match(translator.requests[0] ?? "", /GLOSSARY_0001/u);
  const terminology = events.filter((event) => event.type === "terminology");
  assert.deepEqual(
    terminology.map((event) => event.status),
    ["bound", "authorized"],
  );
  const authorized = terminology.find((event) => event.status === "authorized");
  assert.deepEqual(
    authorized?.guaranteedTargetExact,
    ["\u4e3b\u8ef8"],
  );
  assert.deepEqual(transcriber.inputs, ["audio", "audio", "speech_end"]);
  assert.deepEqual(transcriber.requests[0]?.keywords, ["spindle", "main spindle"]);
  assert.deepEqual(transcriber.requests[0]?.languages, ["en"]);
  assert.deepEqual(tts.spoken, ["\u4eca\u65e5\u6aa2\u67e5\u4e3b\u8ef8\u3002"]);
  const targetTranscript = events.find(
    (event) => event.type === "target_transcript_delta",
  );
  assert.equal(
    targetTranscript?.type === "target_transcript_delta"
      ? targetTranscript.delta
      : undefined,
    "\u4eca\u65e5\u6aa2\u67e5\u4e3b\u8ef8\u3002",
  );
  const audio = events.filter((event) => event.type === "audio");
  assert.equal(audio.length, 2);
  assert.equal(audio[1]?.frame.pcm16le[40], 0);
  assert.equal(events.at(-1)?.type, "completed");
});

test("placeholder miss alerts and still speaks best effort", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => "\u6aa2\u67e5\u96f6\u4ef6\u3002"),
    tts,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  assert.deepEqual(tts.spoken, ["\u6aa2\u67e5\u96f6\u4ef6\u3002"]);
  assert.ok(events.some((event) =>
    event.type === "error" &&
    event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  ));
  assert.ok(events.some((event) => event.type === "audio"));
});

test("low confidence alerts without interrupting audio", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("General sentence.", 0.42)),
    translator: new TextFake(() => "\u4e00\u822c\u53e5\u5b50\u3002"),
    tts,
    minimumConfidence: 0.8,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  assert.ok(events.some((event) =>
    event.type === "error" &&
    event.error.code === "TRANSCRIPTION_LOW_CONFIDENCE"
  ));
  assert.deepEqual(tts.spoken, ["\u4e00\u822c\u53e5\u5b50\u3002"]);
  assert.ok(events.some((event) => event.type === "audio"));
});

test("glossary near-miss heuristic alerts when provider confidence is unavailable", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindel today.")),
    translator: new TextFake(() => "\u6aa2\u67e5\u8a2d\u5099\u3002"),
    tts,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  const alert = events.find((event) =>
    event.type === "error" &&
    event.error.code === "TRANSCRIPTION_LOW_CONFIDENCE"
  );
  assert.equal(alert?.type, "error");
  if (alert?.type === "error") assert.match(alert.error.message, /spindle/u);
  assert.ok(events.some((event) => event.type === "audio"));
});

test("translation failure falls back to speaking source text", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => { throw new Error("provider unavailable"); }),
    tts,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  assert.deepEqual(tts.spoken, ["Inspect the spindle."]);
  assert.ok(events.some((event) =>
    event.type === "error" && event.error.code === "TEXT_TRANSLATION_FAILED"
  ));
  assert.ok(events.some((event) => event.type === "audio"));
});

test("deterministic adapter echoes frames and honors cancel", async () => {
  const adapter = new DeterministicTranslationAdapter({ now: () => 12 });
  const events = await collect(adapter.translate(request()));
  assert.equal(events.filter((event) => event.type === "audio").length, 2);
  await adapter.cancel(context);
  assert.deepEqual(
    (await collect(adapter.translate(request()))).map((event) => event.type),
    ["completed"],
  );
});

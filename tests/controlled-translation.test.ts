import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlledTranslationAdapter,
  type ControlledTranscriptionEvent,
  type ControlledTranscriptionPort,
  type ControlledTranscriptionRequest,
  type ControlledTextTranslationPort,
  type ControlledTtsPort,
} from "../src/adapters/translation/glossary-controlled.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  GenerationRef,
  TranslationEvent,
  TranslationTranscriptEvent,
  TranslationRequest,
} from "../src/core/types.js";

const context = {
  sessionId: "session-1",
  lane: "A_TO_B" as const,
  generation: 3,
  turnId: "controlled-turn-1",
  sourceLanguage: "en",
  targetLanguage: "zh-TW",
  behavior: resolveTranslationBehavior("accurate"),
  glossary: compileGlossary({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "spindle",
      source: "spindle",
      aliases: ["main spindle"],
      targetExact: "主軸",
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

function request(signal = new AbortController().signal): TranslationRequest {
  return { frames: frames(), context, signal };
}

async function collect(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

class TranscriptFake implements ControlledTranscriptionPort {
  readonly inputs: string[] = [];
  readonly requests: ControlledTranscriptionRequest[] = [];

  constructor(readonly event: ControlledTranscriptionEvent) {}

  async *transcribe(input: ControlledTranscriptionRequest): AsyncIterable<ControlledTranscriptionEvent> {
    this.requests.push(input);
    for await (const event of input.events) this.inputs.push(event.type);
    yield this.event;
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
}

class TextFake implements ControlledTextTranslationPort {
  readonly requests: string[] = [];

  constructor(readonly result: (text: string) => string | Promise<string>) {}

  async translate(input: {
    readonly text: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly opaqueTokens?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<string> {
    this.requests.push(input.text);
    return this.result(input.text);
  }
}

class TtsFake implements ControlledTtsPort {
  readonly outputFormat = CANONICAL_AUDIO;
  readonly spoken: string[] = [];

  async *synthesize(input: { readonly text: string; readonly signal?: AbortSignal }): AsyncIterable<Uint8Array> {
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
    turnId: context.turnId,
    transcript: text,
    ...(confidence === undefined ? {} : { confidence }),
  };
}

test("requires canonical TTS and accurate behavior", async () => {
  const tts = new TtsFake();
  Object.defineProperty(tts, "outputFormat", {
    value: { ...CANONICAL_AUDIO, sampleRateHz: 16_000 },
  });
  assert.throws(
    () => new ControlledTranslationAdapter({
      transcriber: new TranscriptFake(transcript("spindle")),
      translator: new TextFake((text) => text),
      tts,
    }),
    /24 kHz mono PCM16LE/u,
  );

  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("spindle")),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
  });
  assert.deepEqual(adapter.capabilities.supportedModes, [{
    mode: "accurate",
    behaviorVersion: 1,
    deterministicGlossary: true,
  }]);
  await assert.rejects(
    adapter.prepare({ ...context, behavior: resolveTranslationBehavior("fast") }),
    /accurate behavior/u,
  );
  await assert.rejects(
    collect(adapter.translate({
      ...request(),
      context: { ...context, behavior: resolveTranslationBehavior("fast") },
    })),
    /accurate behavior/u,
  );

  const { glossary: _ignoredGlossary, ...glossaryFreeContext } = context;
  await adapter.prepare(glossaryFreeContext);
  const glossaryFreeEvents = await collect(adapter.translate({
    frames: frames(),
    context: glossaryFreeContext,
    signal: new AbortController().signal,
  }));
  assert.ok(glossaryFreeEvents.some((event) =>
    event.kind === "target_transcript" && event.text === "spindle"
  ));
});

test("commits target_exact before final target text and canonical audio", async () => {
  const transcriber = new TranscriptFake(transcript("Inspect the spindle today.", 0.99));
  const translator = new TextFake((text) =>
    text.replace("Inspect the ", "今日檢查").replace(" today.", "。")
  );
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({ transcriber, translator, tts, now: () => 10 });
  await adapter.prepare(context);
  const events = await collect(adapter.translate(request()));

  assert.match(translator.requests[0] ?? "", /GLOSSARY_0001/u);
  const terminology = events.filter(
    (event): event is Extract<TranslationEvent, { kind: "terminology" }> => event.kind === "terminology",
  );
  assert.deepEqual(terminology.map((event) => event.status), ["bound", "authorized"]);
  assert.equal(terminology[0]?.finality, "provisional");
  assert.deepEqual(terminology[1]?.guaranteedTargetExact, ["主軸"]);
  assert.equal(terminology[1]?.finality, "final");
  assert.deepEqual(transcriber.inputs, ["audio", "audio", "speech_end"]);
  assert.deepEqual(transcriber.requests[0]?.keywords, ["spindle", "main spindle"]);
  assert.deepEqual(transcriber.requests[0]?.languages, ["en"]);
  assert.deepEqual(tts.spoken, ["今日檢查主軸。"]);

  const targets = events.filter(
    (event): event is TranslationTranscriptEvent => event.kind === "target_transcript",
  );
  assert.deepEqual(targets.map((event) => ({ text: event.text, finality: event.finality })), [{
    text: "今日檢查主軸。",
    finality: "final",
  }]);
  const audio = events.filter(
    (event): event is Extract<TranslationEvent, { kind: "audio" }> => event.kind === "audio",
  );
  assert.equal(audio.length, 2);
  assert.equal(audio[1]?.frame.pcm16le[40], 0);
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
  assert.equal(events.at(-1)?.kind, "completed");
});

test("placeholder loss fails open with an alert and uninterrupted playback", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => "檢查零件。"),
    tts,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));

  assert.deepEqual(tts.spoken, ["檢查零件。"]);
  assert.ok(events.some((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  ));
  assert.ok(events.some((event) => event.kind === "target_transcript"));
  assert.ok(events.some((event) => event.kind === "audio"));
});

test("low-confidence and unknown-or-ambiguous terminology alerts fail open", async () => {
  const lowConfidenceTts = new TtsFake();
  const lowConfidence = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("General sentence.", 0.42)),
    translator: new TextFake(() => "一般句子。"),
    tts: lowConfidenceTts,
    minimumConfidence: 0.8,
    now: () => 10,
  });
  const lowConfidenceEvents = await collect(lowConfidence.translate(request()));
  assert.ok(lowConfidenceEvents.some((event) =>
    event.kind === "error" && event.error.code === "TRANSCRIPTION_LOW_CONFIDENCE"
  ));
  assert.ok(lowConfidenceEvents.some((event) => event.kind === "audio"));

  const uncertaintyTts = new TtsFake();
  const uncertainty = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindel today.")),
    translator: new TextFake(() => "檢查設備。"),
    tts: uncertaintyTts,
    now: () => 10,
  });
  const uncertaintyEvents = await collect(uncertainty.translate(request()));
  const alert = uncertaintyEvents.find((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM"
  );
  assert.equal(alert?.kind, "error");
  if (alert?.kind === "error") assert.match(alert.error.message, /spindle/u);
  assert.ok(uncertaintyEvents.some((event) => event.kind === "audio"));
});

test("exact glossary source suppresses a near alias for the same entry", async () => {
  const abbeGlossary = compileGlossary({
    id: "metrology-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "abbe-offset",
      source: "Abbe offset",
      aliases: ["Abbey offset"],
      targetExact: "阿貝偏移",
    }],
  });
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Verify the Abbe offset before release.")),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
    now: () => 10,
  });
  const events = await collect(adapter.translate({
    frames: frames(),
    context: { ...context, glossary: abbeGlossary },
    signal: new AbortController().signal,
  }));
  const terminology = events.filter(
    (event): event is Extract<TranslationEvent, { kind: "terminology" }> => event.kind === "terminology",
  );

  assert.equal(events.some((event) => event.kind === "error"), false);
  assert.deepEqual(terminology.map((event) => event.status), ["bound", "authorized"]);
  assert.deepEqual(terminology[1]?.guaranteedTargetExact, ["阿貝偏移"]);
});

test("exact glossary match does not suppress a near miss for another entry", async () => {
  const glossary = compileGlossary({
    id: "metrology-and-machining-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "abbe-offset",
      source: "Abbe offset",
      aliases: ["Abbey offset"],
      targetExact: "阿貝偏移",
    }, {
      id: "spindle",
      source: "spindle",
      aliases: [],
      targetExact: "主軸",
    }],
  });
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Verify the Abbe offset and spindel.")),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
    now: () => 10,
  });
  const events = await collect(adapter.translate({
    frames: frames(),
    context: { ...context, glossary },
    signal: new AbortController().signal,
  }));
  const alert = events.find((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM"
  );

  assert.equal(alert?.kind, "error");
  if (alert?.kind === "error") {
    assert.match(alert.error.message, /spindle/u);
    assert.doesNotMatch(alert.error.message, /Abbe offset/u);
  }
});

test("translation failure emits a glossary-bypass fallback alert before source playback", async () => {
  const failureTts = new TtsFake();
  const failedAdapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => { throw new Error("provider unavailable"); }),
    tts: failureTts,
    now: () => 10,
  });
  const failedEvents = await collect(failedAdapter.translate(request()));
  assert.deepEqual(failureTts.spoken, ["Inspect the spindle."]);
  const fallbackAlertIndex = failedEvents.findIndex((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK"
  );
  const fallbackTargetIndex = failedEvents.findIndex((event) =>
    event.kind === "target_transcript" && event.text === "Inspect the spindle."
  );
  const fallbackAudioIndex = failedEvents.findIndex((event) => event.kind === "audio");
  const terminology = failedEvents.filter(
    (event): event is Extract<TranslationEvent, { kind: "terminology" }> => event.kind === "terminology",
  );
  const bypass = terminology.find((event) => event.status === "bypassed");
  assert.deepEqual(terminology.map((event) => event.status), ["bound", "bypassed"]);
  assert.deepEqual(bypass?.guaranteedTargetExact, []);
  assert.equal(terminology.some((event) => event.status === "authorized"), false);
  assert.ok(fallbackAlertIndex >= 0, "fallback alert must be observable");
  assert.ok(fallbackTargetIndex > fallbackAlertIndex, "alert must precede fallback target text");
  assert.ok(fallbackAudioIndex > fallbackTargetIndex, "target text must precede fallback audio");

  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const pendingTranslator: ControlledTextTranslationPort = {
    async translate(input) {
      markStarted?.();
      return new Promise<string>((_resolve, reject) => {
        input.signal?.addEventListener(
          "abort",
          () => reject(input.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    },
  };
  const cancelledTts = new TtsFake();
  const cancelled = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: pendingTranslator,
    tts: cancelledTts,
    now: () => 10,
  });
  const collecting = collect(cancelled.translate(request(controller.signal)));
  await started;
  controller.abort(new Error("barge-in"));
  const cancelledEvents = await collecting;
  assert.deepEqual(cancelledTts.spoken, []);
  assert.equal(cancelledEvents.some((event) => event.kind === "error"), false);
  assert.equal(cancelledEvents.some((event) => event.kind === "target_transcript"), false);
  assert.equal(cancelledEvents.some((event) => event.kind === "audio"), false);
});

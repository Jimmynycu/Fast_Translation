import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ControlledTranslationAdapter,
  type ControlledTranscriptionEvent,
  type ControlledTranscriptionPort,
  type ControlledTranscriptionRequest,
  type ControlledTranslationAdapterOptions,
  type ControlledTextTranslationPort,
  type ControlledTtsPort,
} from "../src/adapters/translation/glossary-controlled.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  GenerationRef,
  TranslationFallbackPolicy,
  TranslationEvent,
  TranslationPreparation,
  TranslationPort,
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
const spindleOpaqueId = context.glossary.entries[0]?.id;

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

  constructor(readonly event: ControlledTranscriptionEvent | readonly ControlledTranscriptionEvent[]) {}

  async *transcribe(input: ControlledTranscriptionRequest): AsyncIterable<ControlledTranscriptionEvent> {
    this.requests.push(input);
    for await (const event of input.events) this.inputs.push(event.type);
    for (const event of Array.isArray(this.event) ? this.event : [this.event]) yield event;
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

const FIXTURE_LOCAL_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "fixture_local",
  remoteConnection: "not_applicable",
});
const NO_SOURCE_SUBSTITUTION: TranslationFallbackPolicy = Object.freeze({ kind: "none" });
const SAME_ROUTE_FAIL_OPEN: TranslationFallbackPolicy = Object.freeze({
  kind: "same_route_fail_open",
});

function fixtureControlled(
  options: Omit<ControlledTranslationAdapterOptions, "preparation" | "fallback"> &
    Readonly<{ readonly fallback?: TranslationFallbackPolicy }>,
): ControlledTranslationAdapter {
  return new ControlledTranslationAdapter({
    ...options,
    preparation: FIXTURE_LOCAL_PREPARATION,
    fallback: options.fallback ?? NO_SOURCE_SUBSTITUTION,
  });
}

function transcript(
  text: string,
  confidence?: number,
): Extract<ControlledTranscriptionEvent, { type: "transcript_completed" }> {
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
    () => fixtureControlled({
      transcriber: new TranscriptFake(transcript("spindle")),
      translator: new TextFake((text) => text),
      tts,
    }),
    /24 kHz mono PCM16LE/u,
  );

  const adapter = fixtureControlled({
    transcriber: new TranscriptFake(transcript("spindle")),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
  });
  assert.deepEqual(
    adapter.capabilities.modes.map((capability) => ({
      mode: capability.mode,
      state: capability.state,
      deterministicGlossary: capability.deterministicGlossary,
    })),
    [
      { mode: "fast", state: "unsupported", deterministicGlossary: false },
      { mode: "balanced", state: "unsupported", deterministicGlossary: false },
      { mode: "accurate", state: "locally_controlled", deterministicGlossary: true },
    ],
  );
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
  assert.deepEqual(
    await adapter.prepare(glossaryFreeContext),
    { readiness: "fixture_local", remoteConnection: "not_applicable" },
  );
  const glossaryFreeEvents = await collect(adapter.translate({
    frames: frames(),
    context: glossaryFreeContext,
    signal: new AbortController().signal,
  }));
  assert.ok(glossaryFreeEvents.some((event) =>
    event.kind === "target_transcript" && event.text === "spindle"
  ));
});

test("controlled TranslationPort preserves its explicitly observed preparation", async () => {
  const observedPreparation: TranslationPreparation = Object.freeze({
    readiness: "local_route_validated",
    remoteConnection: "deferred_until_first_turn",
  });
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("spindle")),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
    preparation: observedPreparation,
    fallback: NO_SOURCE_SUBSTITUTION,
  });

  assert.deepEqual(await adapter.prepare(context), observedPreparation);
});

test("commits target_exact before final target text and canonical audio", async () => {
  const transcriber = new TranscriptFake(transcript("Inspect the spindle today.", 0.99));
  const translator = new TextFake((text) =>
    text.replace("Inspect the ", "今日檢查").replace(" today.", "。")
  );
  const tts = new TtsFake();
  const adapter = fixtureControlled({ transcriber, translator, tts, now: () => 10 });
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
  assert.equal(terminology[0]?.segmentId, "terminology:item-1");
  assert.equal(terminology[0]?.revision, 0);
  assert.equal(terminology[1]?.segmentId, "target:item-1");
  assert.equal(terminology[1]?.revision, 0);
  assert.equal(terminology[1]?.glossaryHash, context.glossary.hash);
  assert.deepEqual(terminology[1]?.entryIds, [spindleOpaqueId]);
  assert.deepEqual(transcriber.inputs, ["audio", "audio", "speech_end"]);
  assert.deepEqual(transcriber.requests[0]?.keywords, ["spindle", "main spindle"]);
  assert.deepEqual(transcriber.requests[0]?.languages, ["en"]);
  assert.deepEqual(tts.spoken, ["今日檢查主軸。"]);

  const targets = events.filter(
    (event): event is TranslationTranscriptEvent => event.kind === "target_transcript",
  );
  assert.deepEqual(targets.map((event) => ({
    segmentId: event.segmentId,
    revision: event.revision,
    text: event.text,
    finality: event.finality,
  })), [{
    segmentId: "target:item-1",
    revision: 0,
    text: "今日檢查主軸。",
    finality: "final",
  }]);
  const authorizedIndex = events.findIndex((event) =>
    event.kind === "terminology" && event.status === "authorized",
  );
  const targetIndex = events.findIndex((event) => event.kind === "target_transcript");
  assert.ok(authorizedIndex >= 0 && authorizedIndex < targetIndex);
  const audio = events.filter(
    (event): event is Extract<TranslationEvent, { kind: "audio" }> => event.kind === "audio",
  );
  assert.equal(audio.length, 2);
  assert.equal(audio[1]?.frame.pcm16le[40], 0);
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
  assert.ok(audio.every((event) => event.targetSegmentId === "target:item-1"));
  assert.ok(audio.every((event) => event.revision === targets[0]?.revision));
  assert.equal(events.at(-1)?.kind, "completed");
});

test("controlled TranslationPort keeps playout sequences monotonic across source items", async () => {
  const { glossary: _ignoredGlossary, ...glossaryFreeContext } = context;
  const adapter: TranslationPort = fixtureControlled({
    transcriber: new TranscriptFake([
      { ...transcript("first item"), itemId: "item-1" },
      { ...transcript("second item"), itemId: "item-2" },
    ]),
    translator: new TextFake((text) => text),
    tts: new TtsFake(),
    now: () => 10,
  });
  const events = await collect(adapter.translate({
    frames: frames(),
    context: glossaryFreeContext,
    signal: new AbortController().signal,
  }));

  const audio = events.filter(
    (event): event is Extract<TranslationEvent, { kind: "audio" }> => event.kind === "audio",
  );
  assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1, 2, 3]);
  assert.deepEqual(
    audio.map((event) => event.targetSegmentId),
    ["target:item-1", "target:item-1", "target:item-2", "target:item-2"],
  );
});

test("placeholder loss fails open with an alert and uninterrupted playback", async () => {
  const tts = new TtsFake();
  const adapter = fixtureControlled({
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

test("controlled TranslationPort errors carry attributable terminology or bounded confidence", async () => {
  const glossaryEvents = await collect(fixtureControlled({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => "檢查零件。"),
    tts: new TtsFake(),
    now: () => 10,
  }).translate(request()));
  const glossaryAlert = glossaryEvents.find((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  );
  assert.equal(glossaryAlert?.kind, "error");
  if (glossaryAlert?.kind === "error") {
    assert.equal(glossaryAlert.error.termId, spindleOpaqueId);
    assert.equal("confidence" in glossaryAlert.error, false);
  }

  const lowConfidenceEvents = await collect(fixtureControlled({
    transcriber: new TranscriptFake(transcript("General sentence.", 0.42)),
    translator: new TextFake(() => "一般句子。"),
    tts: new TtsFake(),
    minimumConfidence: 0.8,
    now: () => 10,
  }).translate(request()));
  const lowConfidenceAlert = lowConfidenceEvents.find((event) =>
    event.kind === "error" && event.error.code === "TRANSCRIPTION_LOW_CONFIDENCE"
  );
  assert.equal(lowConfidenceAlert?.kind, "error");
  if (lowConfidenceAlert?.kind === "error") {
    assert.equal(lowConfidenceAlert.error.confidence, 0.42);
    assert.ok(lowConfidenceAlert.error.confidence >= 0 && lowConfidenceAlert.error.confidence <= 1);
    assert.equal("termId" in lowConfidenceAlert.error, false);
  }
});

test("controlled TranslationPort emits opaque evidence references without blocking glossary fail-open", async () => {
  const createPort = (): TranslationPort => fixtureControlled({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => "檢查零件。"),
    tts: new TtsFake(),
    now: () => 10,
  });
  const first = await collect(createPort().translate(request()));
  const second = await collect(createPort().translate(request()));
  const refs = first.map((event) => event.evidenceRef);

  assert.ok(first.some((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  ));
  assert.ok(first.some((event) => event.kind === "audio"));
  assert.ok(refs.every((ref) => /^controlled:v1:sha256:[a-f0-9]{64}$/u.test(ref)));
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(refs.some((ref) => ref.includes(context.sessionId)), false);
  assert.equal(refs.some((ref) => ref.includes(context.turnId)), false);
  assert.deepEqual(refs, second.map((event) => event.evidenceRef));
});

test("low-confidence and unknown-or-ambiguous terminology alerts fail open", async () => {
  const lowConfidenceTts = new TtsFake();
  const lowConfidence = fixtureControlled({
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
  const uncertainty = fixtureControlled({
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
  if (alert?.kind === "error") {
    assert.equal(alert.error.message, "Possible unknown or ambiguous terminology was detected.");
    assert.equal("termId" in alert.error, false);
    assert.equal("confidence" in alert.error, false);
    assert.match(alert.evidenceRef, /^controlled:v1:sha256:[a-f0-9]{64}$/u);
  }
  assert.ok(uncertaintyEvents.some((event) => event.kind === "audio"));
});

test("controlled TranslationPort redacts glossary details from ambiguous-term alerts", async () => {
  const sourceSentinel = "source-secret-sentinel";
  const targetSentinel = "target-secret-sentinel";
  const aliasSentinel = "alias-secret-sentinel";
  const glossary = compileGlossary({
    id: "redaction-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    entries: [{
      id: "redacted-term",
      source: sourceSentinel,
      aliases: [aliasSentinel],
      targetExact: targetSentinel,
    }],
  });
  const adapter: TranslationPort = fixtureControlled({
    transcriber: new TranscriptFake(transcript("Inspect source secret sentinal.")),
    translator: new TextFake(() => "安全輸出。"),
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
    assert.equal(alert.error.message, "Possible unknown or ambiguous terminology was detected.");
    assert.equal("termId" in alert.error, false);
    assert.equal("confidence" in alert.error, false);
    assert.match(alert.evidenceRef, /^controlled:v1:sha256:[a-f0-9]{64}$/u);
    const alertFields = JSON.stringify(alert);
    for (const sentinel of [sourceSentinel, targetSentinel, aliasSentinel]) {
      assert.equal(alertFields.includes(sentinel), false);
    }
  }
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
  const adapter = fixtureControlled({
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
  const adapter = fixtureControlled({
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
    assert.equal(alert.error.message, "Possible unknown or ambiguous terminology was detected.");
    assert.doesNotMatch(
      JSON.stringify(alert),
      /Abbe offset|Abbey offset|阿貝偏移|spindle|主軸/u,
    );
  }
});

test("controlled TranslationPort blocks same-route source substitution for bound glossary turns", async () => {
  const failureTts = new TtsFake();
  const failedAdapter: TranslationPort = fixtureControlled({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => { throw new Error("provider unavailable"); }),
    tts: failureTts,
    fallback: SAME_ROUTE_FAIL_OPEN,
    now: () => 10,
  });
  const failedEvents = await collect(failedAdapter.translate(request()));
  const fallbackAlertIndex = failedEvents.findIndex((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK"
  );
  const fallbackAlert = failedEvents.find((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK"
  );
  const terminology = failedEvents.filter(
    (event): event is Extract<TranslationEvent, { kind: "terminology" }> => event.kind === "terminology",
  );
  const bypass = terminology.find((event) => event.status === "bypassed");
  assert.deepEqual(terminology.map((event) => event.status), ["bound", "bypassed"]);
  assert.deepEqual(bypass?.entryIds, [spindleOpaqueId]);
  assert.deepEqual(bypass?.guaranteedTargetExact, []);
  assert.equal(bypass?.finality, "final");
  assert.equal(terminology.some((event) => event.status === "authorized"), false);
  assert.ok(fallbackAlertIndex >= 0, "fallback alert must be observable");
  assert.equal(fallbackAlert?.finality, "final");
  assert.match(fallbackAlert?.evidenceRef ?? "", /^controlled:v1:sha256:[0-9a-f]{64}$/u);
  const fallbackErrors = failedEvents.filter(
    (event): event is Extract<TranslationEvent, { kind: "error" }> => event.kind === "error",
  );
  assert.equal(fallbackErrors.length, 1);
  assert.equal(
    fallbackErrors[0]?.error.message,
    "Text translation failed; glossary target_exact authorization could not be completed, so source substitution was blocked.",
  );
  assert.deepEqual(failureTts.spoken, []);
  assert.equal(failedEvents.some((event) => event.kind === "target_transcript"), false);
  assert.equal(failedEvents.some((event) => event.kind === "audio"), false);

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
  const cancelled = fixtureControlled({
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

test("controlled TranslationPort preserves same-route source substitution for glossary-free turns", async () => {
  const { glossary: _ignoredGlossary, ...glossaryFreeContext } = context;
  const tts = new TtsFake();
  const adapter: TranslationPort = fixtureControlled({
    transcriber: new TranscriptFake(transcript("General sentence.")),
    translator: new TextFake(() => { throw new Error("provider unavailable"); }),
    tts,
    fallback: SAME_ROUTE_FAIL_OPEN,
    now: () => 10,
  });
  const events = await collect(adapter.translate({
    frames: frames(),
    context: glossaryFreeContext,
    signal: new AbortController().signal,
  }));
  const fallbackAlertIndex = events.findIndex((event) =>
    event.kind === "error" && event.error.code === "TEXT_TRANSLATION_FALLBACK"
  );
  const fallbackTargetIndex = events.findIndex((event) =>
    event.kind === "target_transcript" && event.text === "General sentence."
  );
  const fallbackAudioIndex = events.findIndex((event) => event.kind === "audio");

  assert.deepEqual(tts.spoken, ["General sentence."]);
  assert.ok(fallbackAlertIndex >= 0, "fallback alert must be observable");
  assert.ok(fallbackTargetIndex > fallbackAlertIndex, "alert must precede fallback target text");
  assert.ok(fallbackAudioIndex > fallbackTargetIndex, "target text must precede fallback audio");
});

test("a no-fallback controlled policy blocks source substitution after translation failure", async () => {
  const tts = new TtsFake();
  const adapter = new ControlledTranslationAdapter({
    transcriber: new TranscriptFake(transcript("Inspect the spindle.")),
    translator: new TextFake(() => { throw new Error("provider unavailable"); }),
    tts,
    preparation: FIXTURE_LOCAL_PREPARATION,
    fallback: NO_SOURCE_SUBSTITUTION,
    now: () => 10,
  });
  const events = await collect(adapter.translate(request()));
  const failure = events.find((event) =>
    event.kind === "error" && event.error.code === "GLOSSARY_TRANSLATION_FAILED"
  );

  assert.equal(failure?.kind, "error");
  assert.equal(failure?.finality, "final");
  assert.match(failure?.evidenceRef ?? "", /^controlled:v1:sha256:[0-9a-f]{64}$/u);
  assert.equal(
    events.filter((event) => event.kind === "error").length,
    1,
  );
  assert.equal(
    failure?.error.message,
    "Text translation failed; the approved fallback policy prohibits source substitution, so glossary target_exact output was not released.",
  );
  assert.deepEqual(tts.spoken, []);
  assert.equal(
    events.some((event) => event.kind === "target_transcript" && event.text === "Inspect the spindle."),
    false,
  );
  assert.equal(events.some((event) => event.kind === "audio"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { DeterministicTranslationAdapter } from "../src/adapters/translation/deterministic.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type {
  AudioFrame,
  LaneContext,
  TranslationEvent,
  TranslationMode,
  TranslationPort,
  TranslationTranscriptEvent,
} from "../src/core/types.js";

function context(mode: TranslationMode, generation = 3): LaneContext {
  return {
    sessionId: "deterministic-session",
    lane: "A_TO_B",
    generation,
    turnId: "turn-" + mode + "-" + generation,
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    behavior: resolveTranslationBehavior(mode),
  };
}

function frame(source: LaneContext, sequence: number): AudioFrame {
  return createAudioFrame({
    sessionId: source.sessionId,
    lane: source.lane,
    generation: source.generation,
    sequence,
    capturedAtMs: sequence * 20,
    pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(sequence),
  });
}

async function* frames(source: LaneContext): AsyncIterable<AudioFrame> {
  yield frame(source, 0);
  yield frame(source, 1);
}

async function collect(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function isTranscript(
  event: TranslationEvent,
): event is TranslationTranscriptEvent {
  return event.kind === "source_transcript" || event.kind === "target_transcript";
}

test("deterministic translation fixture honors every behavior contract", async () => {
  const adapter: TranslationPort = new DeterministicTranslationAdapter({ now: () => 12 });
  assert.deepEqual(
    adapter.capabilities.modes.map((capability) => ({
      mode: capability.mode,
      state: capability.state,
      deterministicGlossary: capability.deterministicGlossary,
    })),
    [
      { mode: "fast", state: "locally_controlled", deterministicGlossary: false },
      { mode: "balanced", state: "locally_controlled", deterministicGlossary: false },
      { mode: "accurate", state: "locally_controlled", deterministicGlossary: false },
    ],
  );
  assert.equal(adapter.capabilities.supportsDeterministicGlossary, false);

  for (const [index, mode] of (["fast", "balanced", "accurate"] as const).entries()) {
    const laneContext = context(mode, index + 3);
    assert.deepEqual(
      await adapter.prepare(laneContext),
      { readiness: "fixture_local", remoteConnection: "not_applicable" },
    );
    const events = await collect(adapter.translate({
      context: laneContext,
      frames: frames(laneContext),
      signal: new AbortController().signal,
    }));
    const source = events.filter(
      (event): event is TranslationTranscriptEvent =>
        isTranscript(event) && event.kind === "source_transcript",
    );
    const target = events.filter(
      (event): event is TranslationTranscriptEvent =>
        isTranscript(event) && event.kind === "target_transcript",
    );
    const audio = events.filter((event) => event.kind === "audio");
    const completed = events.at(-1);

    assert.ok(events.every((event) => event.turnId === laneContext.turnId));
    assert.deepEqual(audio.map((event) => event.playoutSequence), [0, 1]);
    assert.ok(audio.every(
      (event) => event.targetSegmentId === laneContext.turnId + ":target_transcript",
    ));
    assert.ok(audio.every((event) => event.revision === target.at(-1)?.revision));
    assert.ok(audio.every((event) => event.finality === "final"));
    assert.equal(completed?.kind, "completed");
    assert.equal(completed?.segmentId, laneContext.turnId + ":completed");
    assert.equal(completed?.revision, 2);
    assert.equal(completed?.finality, "final");

    if (mode === "fast") {
      for (const transcript of [source, target]) {
        assert.deepEqual(
          transcript.map((event) => [event.revision, event.finality]),
          [[0, "provisional"], [1, "final"]],
        );
        assert.match(transcript[0]?.text ?? "", /draft$/);
        assert.match(transcript[1]?.text ?? "", /replacement$/);
        assert.equal(transcript[0]?.segmentId, transcript[1]?.segmentId);
      }
    } else {
      for (const transcript of [source, target]) {
        assert.deepEqual(
          transcript.map((event) => [event.revision, event.finality]),
          [[0, "final"]],
        );
      }
    }
  }
});

test("deterministic TranslationPort emits stable, opaque, unambiguous evidence references", async () => {
  const laneContext = context("fast", 12);
  const firstAdapter: TranslationPort = new DeterministicTranslationAdapter({ now: () => 12 });
  const secondAdapter: TranslationPort = new DeterministicTranslationAdapter({ now: () => 12 });
  const first = await collect(firstAdapter.translate({
    context: laneContext,
    frames: frames(laneContext),
    signal: new AbortController().signal,
  }));
  const second = await collect(secondAdapter.translate({
    context: laneContext,
    frames: frames(laneContext),
    signal: new AbortController().signal,
  }));
  const refs = first.map((event) => event.evidenceRef);

  assert.ok(refs.length > 0);
  assert.ok(refs.every((ref) => /^deterministic:v1:sha256:[a-f0-9]{64}$/u.test(ref)));
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(refs.some((ref) => ref.includes(laneContext.sessionId)), false);
  assert.equal(refs.some((ref) => ref.includes(laneContext.turnId)), false);
  assert.deepEqual(refs, second.map((event) => event.evidenceRef));
});

test("deterministic playout sequence spans back-to-back turns in one generation", async () => {
  const adapter = new DeterministicTranslationAdapter({ now: () => 12 });
  const firstTurn = context("balanced", 8);
  const secondTurn = { ...firstTurn, turnId: "turn-balanced-8-next" };

  const firstEvents = await collect(adapter.translate({
    context: firstTurn,
    frames: frames(firstTurn),
    signal: new AbortController().signal,
  }));
  const secondEvents = await collect(adapter.translate({
    context: secondTurn,
    frames: frames(secondTurn),
    signal: new AbortController().signal,
  }));

  assert.deepEqual(
    firstEvents.filter((event) => event.kind === "audio").map((event) => event.playoutSequence),
    [0, 1],
  );
  assert.deepEqual(
    secondEvents.filter((event) => event.kind === "audio").map((event) => event.playoutSequence),
    [2, 3],
  );
});

test("deterministic playout state is discarded with its session", async () => {
  const adapter = new DeterministicTranslationAdapter({ now: () => 12 });
  const laneContext = context("balanced", 9);
  await collect(adapter.translate({
    context: laneContext,
    frames: frames(laneContext),
    signal: new AbortController().signal,
  }));
  await adapter.closeSession(laneContext.sessionId);

  const reopenedEvents = await collect(adapter.translate({
    context: laneContext,
    frames: frames(laneContext),
    signal: new AbortController().signal,
  }));
  assert.deepEqual(
    reopenedEvents.filter((event) => event.kind === "audio").map((event) => event.playoutSequence),
    [0, 1],
  );
});

test("deterministic cancellation is generation-scoped", async () => {
  const adapter = new DeterministicTranslationAdapter({ now: () => 12 });
  const stale = context("fast", 3);
  const current = context("fast", 4);
  await adapter.cancel(stale);

  const staleEvents = await collect(adapter.translate({
    context: stale,
    frames: frames(stale),
    signal: new AbortController().signal,
  }));
  assert.deepEqual(staleEvents.map((event) => event.kind), ["completed"]);

  const currentEvents = await collect(adapter.translate({
    context: current,
    frames: frames(current),
    signal: new AbortController().signal,
  }));
  assert.deepEqual(
    currentEvents.filter((event) => event.kind === "audio").map((event) => event.playoutSequence),
    [0, 1],
  );
});

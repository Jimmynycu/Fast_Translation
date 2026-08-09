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
  const adapter = new DeterministicTranslationAdapter({ now: () => 12 });
  assert.deepEqual(
    adapter.capabilities.supportedModes.map((capability) => capability.mode),
    ["fast", "balanced", "accurate"],
  );

  for (const [index, mode] of (["fast", "balanced", "accurate"] as const).entries()) {
    const laneContext = context(mode, index + 3);
    await adapter.prepare(laneContext);
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

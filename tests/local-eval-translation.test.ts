import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalEvalTranslationAdapter } from "../src/adapters/translation/local-eval.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import type { TranslationEvent, TranslationRequest } from "../src/core/types.js";

const context = {
  sessionId: "local-eval-session",
  lane: "A_TO_B" as const,
  generation: 1,
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  profile: "local_eval" as const,
  glossary: compileGlossary({
    id: "factory",
    version: "v1",
    sourceLanguage: "en-US",
    targetLanguage: "zh-TW",
    entries: [{
      id: "poka-yoke",
      source: "poka-yoke",
      aliases: ["mistake proofing"],
      targetExact: "防呆",
    }],
  }),
};

async function* frames() {
  yield createAudioFrame({
    sessionId: context.sessionId,
    lane: context.lane,
    generation: context.generation,
    sequence: 0,
    capturedAtMs: 1,
    pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(4),
  });
}

function request(): TranslationRequest {
  return {
    frames: frames(),
    context,
    signal: new AbortController().signal,
  };
}

async function collect(iterable: AsyncIterable<TranslationEvent>): Promise<TranslationEvent[]> {
  const events: TranslationEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

test("local_eval recognizes a configured alias, restores target_exact, and emits canonical audio", async () => {
  const adapter = createLocalEvalTranslationAdapter({
    transcriptByLane: {
      A_TO_B: "Verify the mistake proofing fixture.",
      B_TO_A: "請確認防呆治具。",
    },
    confidence: 0.99,
    translationMode: "preserve",
    now: () => 10,
  });

  const events = await collect(adapter.translate(request()));
  const authorized = events.find(
    (event) => event.type === "terminology" && event.status === "authorized",
  );
  assert.equal(authorized?.type, "terminology");
  if (authorized?.type !== "terminology") throw new Error("missing terminology event");
  assert.deepEqual(authorized.guaranteedTargetExact, ["防呆"]);
  assert.match(authorized.text, /防呆/u);

  const target = events.find((event) => event.type === "target_transcript_delta");
  assert.equal(target?.type, "target_transcript_delta");
  if (target?.type === "target_transcript_delta") assert.match(target.delta, /防呆/u);

  const audio = events.filter((event) => event.type === "audio");
  assert.ok(audio.length > 0);
  for (const event of audio) {
    if (event.type !== "audio") continue;
    assert.deepEqual(event.frame.format, CANONICAL_AUDIO);
    assert.equal(event.frame.pcm16le.byteLength, CANONICAL_AUDIO.bytesPerFrame);
  }
});

test("local_eval fail-open fixture alerts but continues target text and canonical audio", async () => {
  const adapter = createLocalEvalTranslationAdapter({
    transcriptByLane: {
      A_TO_B: "Verify the mistake proofing fixture.",
      B_TO_A: "請確認防呆治具。",
    },
    confidence: 0.99,
    translationMode: "drop_placeholders",
    now: () => 10,
  });

  const events = await collect(adapter.translate(request()));
  assert.ok(events.some((event) =>
    event.type === "error" && event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  ));
  assert.ok(events.some((event) => event.type === "target_transcript_delta"));
  assert.ok(events.some((event) => event.type === "audio"));
  assert.equal(events.at(-1)?.type, "completed");
});

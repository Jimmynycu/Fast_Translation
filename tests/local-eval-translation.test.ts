import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalEvalTranslationAdapter } from "../src/adapters/translation/local-eval.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import { compileGlossary } from "../src/core/glossary.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type { TranslationEvent, TranslationRequest } from "../src/core/types.js";

const context = {
  sessionId: "local-eval-session",
  lane: "A_TO_B" as const,
  generation: 1,
  turnId: "local-eval-turn-1",
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  behavior: resolveTranslationBehavior("accurate"),
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

  assert.deepEqual(
    await adapter.prepare(context),
    { readiness: "fixture_local", remoteConnection: "not_applicable" },
  );

  const events = await collect(adapter.translate(request()));
  const authorized = events.find(
    (event) => event.kind === "terminology" && event.status === "authorized",
  );
  assert.equal(authorized?.kind, "terminology");
  if (authorized?.kind !== "terminology") throw new Error("missing terminology event");
  assert.deepEqual(authorized.guaranteedTargetExact, ["防呆"]);
  assert.match(authorized.text, /防呆/u);
  assert.equal(authorized.finality, "final");

  const target = events.find((event) => event.kind === "target_transcript");
  assert.equal(target?.kind, "target_transcript");
  if (target?.kind === "target_transcript") {
    assert.match(target.text, /防呆/u);
    assert.equal(target.finality, "final");
  }

  const audio = events.filter((event) => event.kind === "audio");
  assert.ok(audio.length > 0);
  for (const event of audio) {
    if (event.kind !== "audio") continue;
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
    event.kind === "error" && event.error.code === "GLOSSARY_PLACEHOLDER_MISSING"
  ));
  assert.ok(events.some((event) => event.kind === "target_transcript"));
  assert.ok(events.some((event) => event.kind === "audio"));
  assert.equal(events.at(-1)?.kind, "completed");
});

test("local_eval TranslationPort emits stable opaque references for generated fixture events", async () => {
  const options = {
    transcriptByLane: {
      A_TO_B: "Verify the mistake proofing fixture.",
      B_TO_A: "請確認防呆治具。",
    },
    confidence: 0.99,
    translationMode: "preserve" as const,
    now: () => 10,
  };
  const first = await collect(createLocalEvalTranslationAdapter(options).translate(request()));
  const second = await collect(createLocalEvalTranslationAdapter(options).translate(request()));
  const refs = first.map((event) => event.evidenceRef);

  assert.ok(refs.length > 0);
  assert.ok(refs.every((ref) => /^local_eval:v1:sha256:[a-f0-9]{64}$/u.test(ref)));
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(refs.some((ref) => ref.includes(context.sessionId)), false);
  assert.deepEqual(refs, second.map((event) => event.evidenceRef));
});

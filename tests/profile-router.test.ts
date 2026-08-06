import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TranslationProfileRouter, TranslationProfileUnavailableError } from "../src/adapters/translation/profile-router.js";
import type {
  GenerationRef,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../src/core/types.js";

class StubPort implements TranslationPort {
  readonly requests: TranslationRequest[] = [];
  readonly cancellations: GenerationRef[] = [];

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    this.requests.push(request);
    yield {
      type: "completed",
      sessionId: request.context.sessionId,
      lane: request.context.lane,
      generation: request.context.generation,
      emittedAtMs: 1,
    };
  }

  async cancel(generation: GenerationRef): Promise<void> {
    this.cancellations.push(generation);
  }
}

async function* noFrames() {
  return;
}

describe("TranslationProfileRouter", () => {
  it("selects a named immutable profile and reports capabilities", async () => {
    const deterministic = new StubPort();
    const router = new TranslationProfileRouter(new Map([
      ["deterministic_test", deterministic],
    ]));
    const request: TranslationRequest = {
      frames: noFrames(),
      context: {
        sessionId: "s",
        lane: "A_TO_B",
        generation: 0,
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        profile: "deterministic_test",
      },
      signal: new AbortController().signal,
    };
    const events: TranslationEvent[] = [];
    for await (const event of router.translate(request)) events.push(event);
    assert.equal(events[0]?.type, "completed");
    assert.deepEqual(router.available(), ["deterministic_test"]);
  });

  it("rejects unavailable live profiles before provider details leak", () => {
    const router = new TranslationProfileRouter(new Map([
      ["deterministic_test", new StubPort()],
    ]));
    assert.throws(
      () =>
        router.translate({
          frames: noFrames(),
          context: {
            sessionId: "s",
            lane: "A_TO_B",
            generation: 0,
            sourceLanguage: "en-US",
            targetLanguage: "zh-TW",
            profile: "native_live_baseline",
          },
          signal: new AbortController().signal,
        }),
      TranslationProfileUnavailableError,
    );
  });

  it("broadcasts best-effort generation cancellation to configured adapters", async () => {
    const first = new StubPort();
    const second = new StubPort();
    const router = new TranslationProfileRouter(new Map([
      ["deterministic_test", first],
      ["native_live_baseline", second],
    ]));
    const ref = { sessionId: "s", lane: "B_TO_A" as const, generation: 3 };
    await router.cancel(ref);
    assert.deepEqual(first.cancellations, [ref]);
    assert.deepEqual(second.cancellations, [ref]);
  });
});

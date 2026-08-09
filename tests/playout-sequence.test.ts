import assert from "node:assert/strict";
import { test } from "node:test";
import { GenerationPlayoutSequence } from "../src/core/playout-sequence.js";

test("keeps playout sequence monotonic within a lane generation and resets only cleared scopes", () => {
  const sequences = new GenerationPlayoutSequence();
  const firstGeneration = {
    sessionId: "session-1",
    lane: "A_TO_B" as const,
    generation: 4,
  };

  assert.deepEqual([
    sequences.next(firstGeneration),
    sequences.next(firstGeneration),
  ], [0, 1]);
  assert.equal(sequences.next({ ...firstGeneration, lane: "B_TO_A" }), 0);
  assert.equal(sequences.next({ ...firstGeneration, generation: 5 }), 0);

  sequences.clear(firstGeneration);
  assert.equal(sequences.next(firstGeneration), 0);

  sequences.clearSession(firstGeneration.sessionId);
  assert.equal(sequences.next({ ...firstGeneration, lane: "B_TO_A" }), 0);
});

test("clears only superseded generations for one lane and session", () => {
  const sequences = new GenerationPlayoutSequence();
  const generationFour = { sessionId: "session-2", lane: "A_TO_B" as const, generation: 4 };
  const generationSix = { ...generationFour, generation: 6 };
  const otherLane = { ...generationFour, lane: "B_TO_A" as const };
  const otherSession = { ...generationFour, sessionId: "session-3" };

  assert.equal(sequences.next(generationFour), 0);
  assert.equal(sequences.next(generationFour), 1);
  assert.equal(sequences.next({ ...generationFour, generation: 5 }), 0);
  assert.equal(sequences.next(generationSix), 0);
  assert.equal(sequences.next(otherLane), 0);
  assert.equal(sequences.next(otherSession), 0);

  sequences.clearBefore(generationSix);
  assert.equal(sequences.next(generationFour), 0);
  assert.equal(sequences.next(generationSix), 1);
  assert.equal(sequences.next(otherLane), 1);
  assert.equal(sequences.next(otherSession), 1);
});

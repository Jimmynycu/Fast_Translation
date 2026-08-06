import assert from "node:assert/strict";
import { test } from "node:test";

import { GenerationFence } from "../src/core/generation-fence.js";

test("a fence starts at generation zero and accepts only its current generation", () => {
  const fence = new GenerationFence();
  assert.equal(fence.generation, 0);
  assert.equal(fence.accepts(0), true);
  assert.equal(fence.accepts(1), false);
});

test("cut is synchronous, monotonic, and idempotent", () => {
  const fence = new GenerationFence();
  assert.equal(fence.cut(1), true);
  assert.equal(fence.generation, 1);
  assert.equal(fence.accepts(0), false);
  assert.equal(fence.accepts(1), true);
  assert.equal(fence.cut(1), false);
  assert.equal(fence.cut(0), false);
  assert.equal(fence.generation, 1);
});

test("cut can advance directly to a later externally allocated generation", () => {
  const fence = new GenerationFence(3);
  assert.equal(fence.cut(9), true);
  assert.equal(fence.generation, 9);
  assert.equal(fence.accepts(8), false);
  assert.equal(fence.accepts(9), true);
});

test("generation values must be non-negative safe integers", () => {
  assert.throws(() => new GenerationFence(-1), RangeError);
  const fence = new GenerationFence();
  assert.throws(() => fence.cut(1.5), RangeError);
  assert.throws(() => fence.accepts(Number.MAX_SAFE_INTEGER + 1), RangeError);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evaluateTerminology,
  percentile,
  summarizeLatencies,
} from "../src/benchmark/stats.js";

describe("benchmark statistics", () => {
  it("reports observed nearest-rank percentiles", () => {
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    assert.equal(percentile(samples, 0), 1);
    assert.equal(percentile(samples, 0.5), 10);
    assert.equal(percentile(samples, 0.95), 19);
    assert.equal(percentile(samples, 0.99), 20);
    assert.deepEqual(summarizeLatencies(samples), {
      count: 20,
      minimum: 1,
      p50: 10,
      p95: 19,
      p99: 20,
      maximum: 20,
    });
  });

  it("rejects empty, negative, or non-finite latency samples", () => {
    assert.throws(() => summarizeLatencies([]), /At least one/);
    assert.throws(() => summarizeLatencies([1, -1]), /non-negative/);
    assert.throws(() => percentile([1], Number.NaN), /between zero and one/);
  });

  it("requires every positive target_exact and zero confuser replacements", () => {
    const passed = evaluateTerminology([
      {
        caseId: "positive-a",
        direction: "A_TO_B",
        expectedTargetExact: "\u{626d}\u{77e9}\u{63a7}\u{5236}\u{5668}",
        actualTargetText: "\u{8acb}\u{6aa2}\u{67e5}\u{626d}\u{77e9}\u{63a7}\u{5236}\u{5668}",
        isPositive: true,
        alertCodes: [],
      },
      {
        caseId: "confuser-a",
        direction: "A_TO_B",
        expectedTargetExact: "\u{626d}\u{77e9}\u{63a7}\u{5236}\u{5668}",
        actualTargetText: "\u{8acb}\u{6aa2}\u{67e5}\u{4e00}\u{822c}\u{63a7}\u{5236}\u{5668}",
        isPositive: false,
        alertCodes: [],
      },
    ]);
    assert.equal(passed.passed, true);

    const failed = evaluateTerminology([
      {
        caseId: "miss",
        direction: "B_TO_A",
        expectedTargetExact: "torque controller",
        actualTargetText: "controller",
        isPositive: true,
        alertCodes: ["low_confidence"],
      },
      {
        caseId: "false-positive",
        direction: "B_TO_A",
        expectedTargetExact: "torque controller",
        actualTargetText: "torque controller",
        isPositive: false,
        alertCodes: [],
      },
    ]);
    assert.equal(failed.passed, false);
    assert.deepEqual(failed.failures, [
      "miss: target_exact missing",
      "false-positive: false positive replacement",
    ]);
  });
});

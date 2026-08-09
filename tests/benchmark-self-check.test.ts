import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runMechanismSelfCheck } from "../src/benchmark/self-check.js";

describe("terminology mechanism self-check", () => {
  it("proves deterministic target_exact reinsertion without mislabeling it as live acceptance", () => {
    let clock = 0;
    let clockReads = 0;
    const report = runMechanismSelfCheck(() => {
      clockReads += 1;
      clock += 0.25;
      return clock;
    });
    assert.equal(report.verdict, "MECHANISM_PASS");
    assert.equal(report.acceptanceVerdict, "NOT_RUN");
    assert.equal(report.terminology.positiveCount, 20);
    assert.equal(report.terminology.positiveExactCount, 20);
    assert.equal(report.terminology.falsePositiveCount, 0);
    assert.equal(report.glossaryOverheadMs.count, 36);
    assert.equal(clockReads, 72, "all 36 timings must be measured, never recycled");
    assert.equal(report.glossaryOverheadMs.minimum, 0.25);
    assert.equal(report.glossaryOverheadMs.maximum, 0.25);
    assert.equal(report.limitations.some((value) =>
      value === "Provider acceptance remains NOT_RUN: no STT, translation, TTS, or Palabra execution was run."
    ), true);
    assert.equal(report.limitations.some((value) =>
      value === "Product acceptance remains NOT_RUN: no acoustic latency, human review, or product go/no-go validation was run."
    ), true);
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  aggregateEvaluationVerdicts,
  createKeylessLocalEvalVerification,
  recordLiveProviderVerification,
} from "../src/local-eval/verification.js";

test("NOT_RUN never aggregates to PASS for a keyless evaluation", () => {
  assert.equal(aggregateEvaluationVerdicts(["PASS", "NOT_RUN"]), "NOT_RUN");
  assert.equal(aggregateEvaluationVerdicts(["PASS", "FAIL", "NOT_RUN"]), "FAIL");
  assert.deepEqual(createKeylessLocalEvalVerification("PASS"), {
    mechanism: "PASS",
    liveProvider: "NOT_RUN",
    overall: "NOT_RUN",
    liveProviderRequiredServerKey: true,
  });
});

test("live provider evidence requires a server-held API key", () => {
  assert.throws(
    () => recordLiveProviderVerification(" ", true),
    /server API key/u,
  );
  assert.equal(recordLiveProviderVerification("server-only-key", true), "PASS");
  assert.equal(recordLiveProviderVerification("server-only-key", false), "FAIL");
});

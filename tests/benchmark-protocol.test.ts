import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  BENCHMARK_MANIFEST,
  BENCHMARK_WORKLOAD,
  validateBenchmarkWorkload,
} from "../src/benchmark/protocol.js";
import {
  DISCOVERY_CANDIDATES,
  runBudgetedTerminologyDiscovery,
  runTerminologyDiscovery,
} from "../src/benchmark/discovery.js";
import { createExecutableBenchmarkManifest, EXECUTABLE_BENCHMARK_MANIFEST, validateExecutableBenchmarkManifest, type ExecutableBenchmarkManifest } from "../src/benchmark/executable-manifest.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function withManifestHash(
  manifest: Omit<ExecutableBenchmarkManifest, "manifestSha256">,
): ExecutableBenchmarkManifest {
  return { ...manifest, manifestSha256: sha256(manifest) };
}

describe("approved small benchmark workload", () => {
  it("encodes the user-approved one-tenth workload", () => {
    validateBenchmarkWorkload();
    assert.equal(Object.isFrozen(BENCHMARK_WORKLOAD.arms), true);
    assert.equal(BENCHMARK_WORKLOAD.discoveryCandidatesPerDirection, 10);
    assert.equal(BENCHMARK_WORKLOAD.discoveryRendersPerCandidate, 3);
    assert.equal(BENCHMARK_WORKLOAD.formalTerminologyCasesTotal, 24);
    assert.equal(BENCHMARK_WORKLOAD.latencyRunsTotal, 36);
    assert.equal(BENCHMARK_WORKLOAD.interruptionRunsPerArm, 20);
    assert.equal(BENCHMARK_WORKLOAD.continuousDuplexMinutesPerArm, 10);
  });

  it("ships a balanced candidate-only pool so failure mining needs no customer dataset", () => {
    assert.equal(DISCOVERY_CANDIDATES.length, 20);
    assert.equal(DISCOVERY_CANDIDATES.filter((candidate) => candidate.direction === "A_TO_B").length, 10);
    assert.equal(DISCOVERY_CANDIDATES.filter((candidate) => candidate.direction === "B_TO_A").length, 10);
    assert.equal(DISCOVERY_CANDIDATES.every((candidate) => candidate.approvalStatus === "candidate_only"), true);
    assert.equal(DISCOVERY_CANDIDATES.every((candidate) => candidate.dataClass === "open_data"), true);
  });

  it("keeps only terms missed by at least two of three real discovery renders", async () => {
    const [first, second] = DISCOVERY_CANDIDATES;
    assert.ok(first);
    assert.ok(second);
    const calls = new Map<string, number>();
    const discovery = await runTerminologyDiscovery(
      async (candidate) => {
        const call = (calls.get(candidate.id) ?? 0) + 1;
        calls.set(candidate.id, call);
        if (candidate.id === first.id && call <= 2) return "an incorrect generic translation";
        if (candidate.id === second.id && call === 1) return "one unstable miss";
        return candidate.provisionalTargetExact;
      },
      [first, second],
    );
    const { failures } = discovery;
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.id, first.id);
    assert.equal(discovery.totalRenderCount, 6);
    assert.equal(discovery.candidateEvidence.length, 2);
    assert.equal(failures[0]?.reason, "target_exact_missing");
    assert.equal(failures[0]?.wrongRenderCount, 2);
    assert.equal(failures[0]?.renderCount, 3);
    assert.equal(failures[0]?.baselineOutputs.length, 3);
    assert.deepEqual([...calls.values()], [3, 3]);
    assert.equal(discovery.candidateEvidence[0]?.decision, "retained_failure");
    assert.equal(discovery.candidateEvidence[1]?.decision, "rejected");
    assert.equal(
      discovery.candidateEvidence[1]?.reason,
      "target_exact_missing_not_reproducible",
    );
  });

  it("pre-authorizes every paid discovery call and refuses an undersized envelope", async () => {
    const candidate = DISCOVERY_CANDIDATES[0];
    assert.ok(candidate);
    let calls = 0;
    await assert.rejects(
      runBudgetedTerminologyDiscovery(
        async () => {
          calls += 1;
          return { output: "not dispatched", costUsd: 0 };
        },
        [candidate],
        3,
        {
          maxElapsedMs: 1_000,
          perCallTimeoutMs: 100,
          maxCostUsd: 0.2,
          maxCostUsdPerCall: 0.1,
          maxOutputTokens: 64,
        },
      ),
      /cannot pre-authorize all 3 calls/u,
    );
    assert.equal(calls, 0);
  });

  it("aborts a paid discovery call at its per-call deadline", async () => {
    const candidate = DISCOVERY_CANDIDATES[0];
    assert.ok(candidate);
    let aborted = false;
    await assert.rejects(
      runBudgetedTerminologyDiscovery(
        async (_input, _render, grant) => new Promise((_resolve, reject) => {
          grant.signal.addEventListener("abort", () => {
            aborted = true;
            reject(grant.signal.reason);
          }, { once: true });
        }),
        [candidate],
        1,
        {
          maxElapsedMs: 100,
          perCallTimeoutMs: 5,
          maxCostUsd: 0.1,
          maxCostUsdPerCall: 0.1,
          maxOutputTokens: 64,
        },
      ),
      /time budget exhausted/u,
    );
    assert.equal(aborted, true);
  });

  it("publishes a concrete, balanced executable run manifest", () => {
    assert.equal(BENCHMARK_MANIFEST.discoveryRuns.length, 60);
    assert.equal(BENCHMARK_MANIFEST.formalRuns.length, 24);
    assert.equal(BENCHMARK_MANIFEST.latencyRuns.length, 36);
    assert.equal(BENCHMARK_MANIFEST.interruptionRuns.length, 60);
    assert.equal(BENCHMARK_MANIFEST.soakRuns.length, 3);

    for (const arm of BENCHMARK_WORKLOAD.arms) {
      assert.equal(BENCHMARK_MANIFEST.formalRuns.filter((run) => run.arm === arm).length, 8);
      assert.equal(BENCHMARK_MANIFEST.latencyRuns.filter((run) => run.arm === arm).length, 12);
      assert.equal(BENCHMARK_MANIFEST.interruptionRuns.filter((run) => run.arm === arm).length, 20);
      assert.equal(BENCHMARK_MANIFEST.soakRuns.filter((run) => run.arm === arm)[0]?.durationMinutes, 10);
    }

    const runIds = [
      ...BENCHMARK_MANIFEST.discoveryRuns,
      ...BENCHMARK_MANIFEST.formalRuns,
      ...BENCHMARK_MANIFEST.latencyRuns,
      ...BENCHMARK_MANIFEST.interruptionRuns,
      ...BENCHMARK_MANIFEST.soakRuns,
    ].map((run) => run.runId);
    assert.equal(new Set(runIds).size, runIds.length);
  });
});

describe("executable benchmark manifest", () => {
  it("pins fixtures, schedules, explicit providers and behaviors, evidence, timing, and run order", () => {
    validateExecutableBenchmarkManifest();
    const first = createExecutableBenchmarkManifest();
    const second = createExecutableBenchmarkManifest();
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.deepEqual(first, second);
    assert.match(first.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.equal(first.schemaVersion, 3);
    assert.equal(first.runs.length, 183);
    assert.equal(first.runs.filter((run) => run.stage === "discovery").length, 60);
    assert.equal(first.runs.filter((run) => run.stage === "formal_terminology").length, 24);
    assert.equal(first.runs.filter((run) => run.stage === "latency").length, 36);
    assert.equal(first.runs.filter((run) => run.stage === "interruption").length, 60);
    assert.equal(first.runs.filter((run) => run.stage === "continuous_duplex").length, 3);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.fixtures), true);
    assert.equal(Object.isFrozen(first.fixtures[0]), true);
    assert.equal(Object.isFrozen(first.schedules[0]?.events), true);
    assert.equal(Object.isFrozen(first.arms[0]?.config), true);
    assert.equal(Object.isFrozen(first.arms[0]?.behavior), true);
    assert.equal(Object.isFrozen(first.runs[0]?.sourceRun), true);

    const fixtureIds = new Set(first.fixtures.map((fixture) => fixture.fixtureId));
    const scheduleIds = new Set(first.schedules.map((schedule) => schedule.scheduleId));
    for (const run of first.runs) {
      if (run.fixtureId !== undefined) assert.equal(fixtureIds.has(run.fixtureId), true);
      if (run.scheduleId !== undefined) assert.equal(scheduleIds.has(run.scheduleId), true);
      if (run.arm !== undefined) {
        assert.match(run.armConfigSha256 ?? "", /^[a-f0-9]{64}$/u);
        assert.match(run.behaviorSha256 ?? "", /^[a-f0-9]{64}$/u);
      }
    }
    assert.deepEqual(first.arms.map((arm) => [arm.arm, arm.provider, arm.mode]), [
      ["PALABRA_REFERENCE", "palabra", "balanced"],
      ["OPENAI_NATIVE_TRANSLATE", "openai_native", "balanced"],
      ["GLOSSARY_CONTROLLED", "openai_controlled", "accurate"],
    ]);
    assert.deepEqual(first.gates, {
      targetExact: "all_bound_committed_terms",
      zeroOpenRegression: true,
      alertsClear: true,
      latencyEvidence: "all_local_latency_samples",
      normalizedEventEvidence: "revisions_finality_audio_sequence",
      noRuntimeHotSwap: true,
      gatesSha256: first.gates.gatesSha256,
    });

    const latencyPairs = new Map<string, number>();
    for (const run of first.runs.filter((candidate) => candidate.stage === "latency")) {
      const key = run.pairingKey ?? "";
      latencyPairs.set(key, (latencyPairs.get(key) ?? 0) + 1);
    }
    assert.equal(latencyPairs.size, 12);
    assert.equal([...latencyPairs.values()].every((count) => count === 3), true);
    assert.deepEqual(first.runs.map((run) => run.order),
      Array.from({ length: first.runs.length }, (_value, index) => index + 1));

    const tampered = { ...EXECUTABLE_BENCHMARK_MANIFEST, seed: "tampered" } as unknown as ExecutableBenchmarkManifest;
    assert.throws(() => validateExecutableBenchmarkManifest(tampered), /manifest hash mismatch/u);
  });
  it("rejects rehashed component bodies and semantically remapped runs", () => {
    const original = createExecutableBenchmarkManifest();
    const { manifestSha256: _ignoredManifestHash, ...originalBody } = original;
    const changedEvidenceBody = {
      requiredEvents: original.evidence.requiredEvents.slice(1),
      output: original.evidence.output,
      clock: original.evidence.clock,
    };
    const changedEvidence = {
      ...changedEvidenceBody,
      schemaSha256: sha256(changedEvidenceBody),
    };
    const badEvidence = withManifestHash({
      ...originalBody,
      evidence: changedEvidence,
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(badEvidence),
      /Evidence semantics mismatch/u,
    );

    const { scheduleSha256: _ignoredTimingHash, ...canonicalTimingBody } = original.timing;
    const changedTimingBody = {
      ...canonicalTimingBody,
      latencyRunCount: original.timing.latencyRunCount - 1,
    };
    const badTiming = withManifestHash({
      ...originalBody,
      timing: {
        ...changedTimingBody,
        scheduleSha256: sha256(changedTimingBody),
      },
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(badTiming),
      /Timing semantics mismatch/u,
    );

    const { gatesSha256: _ignoredGateHash, ...canonicalGatesBody } = original.gates;
    const changedGatesBody = {
      ...canonicalGatesBody,
      unreviewedOverride: true,
    } as const;
    const badGates = withManifestHash({
      ...originalBody,
      gates: {
        ...changedGatesBody,
        gatesSha256: sha256(changedGatesBody),
      },
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(badGates),
      /Gate semantics mismatch/u,
    );
    const badSuiteIdentity = withManifestHash({
      ...originalBody,
      suiteId: "rehashed-but-not-canonical",
      seed: "rehashed-but-not-canonical",
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(badSuiteIdentity),
      /canonical manifest semantics mismatch/u,
    );

    const firstArm = original.arms[0];
    assert.ok(firstArm);
    const duplicatedArms = [...original.arms, firstArm];
    const badArms = withManifestHash({
      ...originalBody,
      arms: duplicatedArms,
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(badArms),
      /arm allocation or semantics mismatch/u,
    );

    const formalIndex = original.runs.findIndex((run) => run.stage === "formal_terminology");
    assert.notEqual(formalIndex, -1);
    const replacementFixture = original.fixtures.find(
      (fixture) => fixture.scenario === "ordinary" && fixture.direction === "B_TO_A",
    );
    assert.ok(replacementFixture);
    const remappedRuns = original.runs.map((run, index) => index === formalIndex
      ? { ...run, fixtureId: replacementFixture.fixtureId, direction: replacementFixture.direction }
      : run);
    const remapped = withManifestHash({
      ...originalBody,
      runs: remappedRuns,
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(remapped),
      /run semantics mismatch/u,
    );

    const latencyRuns = original.runs.filter((run) => run.stage === "latency");
    const firstLatency = latencyRuns[0];
    const secondLatency = latencyRuns.find(
      (run) => run.pairingKey === firstLatency?.pairingKey && run.arm !== firstLatency?.arm,
    );
    assert.ok(firstLatency);
    assert.ok(secondLatency);
    const duplicatedArm = firstLatency.arm;
    const duplicatedConfigSha256 = firstLatency.armConfigSha256;
    const duplicatedBehaviorSha256 = firstLatency.behaviorSha256;
    if (
      duplicatedArm === undefined ||
      duplicatedConfigSha256 === undefined ||
      duplicatedBehaviorSha256 === undefined
    ) {
      throw new Error("Canonical latency run is missing its arm freeze");
    }
    const duplicateArmRuns = original.runs.map((run) => run.runId === secondLatency.runId
      ? {
          ...run,
          arm: duplicatedArm,
          armConfigSha256: duplicatedConfigSha256,
          behaviorSha256: duplicatedBehaviorSha256,
        }
      : run);
    const duplicateArm = withManifestHash({
      ...originalBody,
      runs: duplicateArmRuns,
    });
    assert.throws(
      () => validateExecutableBenchmarkManifest(duplicateArm),
      /run semantics mismatch|distinct arm/u,
    );
  });
});

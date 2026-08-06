import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXECUTABLE_BENCHMARK_MANIFEST } from "../src/benchmark/executable-manifest.js";
import { runLocalHarnessObservation } from "../src/benchmark/local-harness.js";
import {
  benchmarkArtifactSha256,
  executeKeylessBenchmark,
  createBenchmarkProfileUnderTest,
  scoreBenchmarkResults,
  type BenchmarkRunResult,
  validateBenchmarkRunResult,
} from "../src/benchmark/runner.js";

const taskTemp = join(process.cwd(), "work", "tmp", "benchmark-runner-tests");
const profileUnderTest = createBenchmarkProfileUnderTest({
  approvedProfileArtifactSha256: "a".repeat(64),
  profile: {
    systemPrompt: "Preserve approved manufacturing terms exactly.",
    backgroundHarness: "Run the canonical local Harness regression suite.",
    glossary: [
      { id: "abbe-offset", source: "Abbe offset", aliases: ["Abbey offset"], targetExact: "阿貝偏移" },
      { id: "poka-yoke-pin", source: "poka-yoke pin", aliases: [], targetExact: "防呆銷已損壞" },
      { id: "reverse-abbe-error", source: "Check the Abbe error.", aliases: [], targetExact: "阿貝誤差" },
      { id: "reverse-poka-yoke-fixture", source: "Verify the poka-yoke fixture.", aliases: [], targetExact: "防呆治具" },
    ],
  },
});

async function isolatedDirectory(name: string): Promise<string> {
  const directory = join(taskTemp, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

describe("keyless executable benchmark runner", () => {
  it("persists one marker and result per canonical run without inventing provider acceptance", async () => {
    const outputDirectory = await isolatedDirectory("complete");
    let clock = Date.parse("2026-08-06T12:00:00.000Z");
    const execution = await executeKeylessBenchmark({
      outputDirectory,
      profileUnderTest,
      now: () => clock += 1,
    });

    assert.equal(execution.results.length, 183);
    assert.equal(execution.markers.length, 183);
    assert.equal(execution.results.filter((result) => result.outcome === "PASS").length, 41);
    assert.equal(execution.results.filter((result) => result.outcome === "NOT_RUN").length, 142);
    assert.equal(execution.results.some((result) => result.outcome === "FAIL"), false);

    const local = execution.score.armVerdicts.GLOSSARY_CONTROLLED;
    assert.equal(local.verdict, "PASS");
    assert.equal(local.formal.completed, 8);
    assert.equal(local.latency.completed, 12);
    assert.equal(local.interruption.completed, 20);
    assert.equal(local.soak.completed, 1);
    assert.equal(execution.score.armVerdicts.PALABRA_REFERENCE.verdict, "NOT_RUN");
    assert.equal(execution.score.armVerdicts.OPENAI_NATIVE_TRANSLATE.verdict, "NOT_RUN");
    assert.equal(execution.score.localMechanismVerdict, "PASS");
    assert.equal(execution.score.productAcceptanceVerdict, "NOT_RUN");
    assert.equal(execution.score.providerAcceptanceVerdict, "NOT_RUN");

    const firstLocal = execution.results.find(
      (result) => result.arm === "GLOSSARY_CONTROLLED" && result.outcome === "PASS",
    );
    assert.ok(firstLocal);
    assert.equal(firstLocal.acceptanceScope, "local_mechanism_only");
    assert.equal(firstLocal.providerAcceptanceVerdict, "NOT_RUN");
    validateBenchmarkRunResult(firstLocal);

    const firstExternal = execution.results.find(
      (result) => result.arm === "PALABRA_REFERENCE",
    );
    assert.ok(firstExternal);
    assert.equal(firstExternal.outcome, "NOT_RUN");
    assert.match(firstExternal.reason ?? "", /external adapter is not configured/u);

    const aggregateResults = await readFile(
      join(outputDirectory, "run-results.jsonl"),
      "utf8",
    );
    assert.equal(aggregateResults.trim().split(/\r?\n/u).length, 183);
    assert.doesNotMatch(aggregateResults, /"PALABRA_REFERENCE".*"outcome":"PASS"/u);
    assert.doesNotMatch(aggregateResults, /"OPENAI_NATIVE_TRANSLATE".*"outcome":"PASS"/u);

    const persistedBundle = JSON.parse(
      await readFile(join(outputDirectory, "bundle.json"), "utf8"),
    ) as { bundleSha256?: string; productAcceptanceVerdict?: string };
    assert.match(persistedBundle.bundleSha256 ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(persistedBundle.productAcceptanceVerdict, "NOT_RUN");

    const markerPath = join(
      outputDirectory,
      "runs",
      `${String(firstLocal.order).padStart(3, "0")}-${firstLocal.runId}.marker.json`,
    );
    const persistedMarker = JSON.parse(await readFile(markerPath, "utf8")) as {
      state?: string;
      resultSha256?: string;
    };
    assert.equal(persistedMarker.state, "COMPLETED");
    assert.equal(persistedMarker.resultSha256, firstLocal.resultSha256);
  });

  it("executes actual local formal, latency, interruption, and accelerated soak observations", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("observations"),
      profileUnderTest,
    });
    const localResults = execution.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    const protectedTerms = new Set([
      "Abbe offset",
      "poka-yoke pin",
      "阿貝誤差",
      "防呆治具",
    ]);

    const formal = localResults.filter((result) => result.stage === "formal_terminology");
    assert.equal(formal.every((result) =>
      result.observation?.kind === "formal_terminology" &&
      result.observation.uninterrupted &&
      result.observation.playedFrameCount === 3 &&
      (result.observation.scenario === "protected"
        ? result.observation.targetExactSatisfied &&
          result.observation.authorizationStatus === "authorized" &&
          result.observation.termBound &&
          result.observation.bindingCount === 1 &&
          result.observation.matchedSourceTexts.length === 1 &&
          protectedTerms.has(result.observation.matchedSourceTexts[0] ?? "")
        : result.observation.authorizationStatus === "not_applicable" &&
          !result.observation.termBound &&
          result.observation.bindingCount === 0 &&
          result.observation.matchedSourceTexts.length === 0)
    ), true);

    const latency = localResults.filter((result) => result.stage === "latency");
    assert.equal(latency.every((result) =>
      result.observation?.kind === "latency" &&
      result.observation.measurementScope === "local_processing_not_acoustic" &&
      result.observation.uninterrupted &&
      result.observation.playedFrameCount === 3 &&
      (result.observation.scenario === "protected"
        ? result.observation.targetExactSatisfied &&
          result.observation.authorizationStatus === "authorized" &&
          result.observation.bindingCount === 1 &&
          result.observation.matchedSourceTexts.length === 1 &&
          protectedTerms.has(result.observation.matchedSourceTexts[0] ?? "")
        : result.observation.authorizationStatus === "not_applicable" &&
          result.observation.bindingCount === 0 &&
          result.observation.matchedSourceTexts.length === 0) &&
      Object.values(result.observation.metricsMs).every(
        (sample) => Number.isFinite(sample) && sample >= 0,
      )
    ), true);

    const interruption = localResults.filter((result) => result.stage === "interruption");
    assert.equal(interruption.every((result) =>
      result.observation?.kind === "interruption" &&
      result.observation.generationCut &&
      result.observation.playoutCleared &&
      result.observation.staleOutputRejected &&
      result.observation.validOutputResumed
    ), true);

    const soak = localResults.find((result) => result.stage === "continuous_duplex");
    assert.ok(soak);
    assert.equal(soak.observation?.kind, "continuous_duplex");
    if (soak.observation?.kind !== "continuous_duplex") return;
    assert.equal(soak.observation.executionMode, "accelerated_virtual_time");
    assert.equal(soak.observation.virtualDurationMs, 600_000);
    assert.equal(soak.observation.processedFrames, 60_000);
    assert.equal(soak.observation.queueGrowthDetected, false);
  });

  it("requires testOnly for a custom executor and marks the resulting bundle", async () => {
    await assert.rejects(
      executeKeylessBenchmark({
        outputDirectory: await isolatedDirectory("unmarked-custom-executor"),
        profileUnderTest,
        localHarnessExecutor: async () => {
          throw new Error("custom executor should not run without testOnly");
        },
      }),
      /custom benchmark executors require testOnly=true/u,
    );
  });

  it("fails the local acceptance score when the real MediaPort seam drops playout ACKs", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("broken-media-seam"),
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: (input) => runLocalHarnessObservation({
        ...input,
        mediaMode: "drop_playout_ack",
      }),
    });
    assert.equal(execution.score.localMechanismVerdict, "FAIL");
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.verdict, "FAIL");
    assert.equal(execution.results.some((result) =>
      result.arm === "GLOSSARY_CONTROLLED" && result.outcome === "FAIL"
    ), true);
    assert.equal(execution.bundle.executionMode, "test_only_custom_executor");
  });
  it("detects a tampered run result before scoring or release", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("tamper"),
      profileUnderTest,
    });
    const original = execution.results.find((result) => result.outcome === "PASS");
    assert.ok(original);
    const tampered = {
      ...original,
      outcome: "FAIL",
    } as const;
    assert.throws(
      () => validateBenchmarkRunResult(tampered),
      /result hash mismatch/u,
    );

    const missingObservationCandidate = { ...original, observation: undefined };
    const {
      resultSha256: staleMissingObservationHash,
      ...missingObservationBody
    } = missingObservationCandidate;
    assert.match(staleMissingObservationHash, /^[a-f0-9]{64}$/u);
    const rehashedMissingObservation = {
      ...missingObservationBody,
      resultSha256: benchmarkArtifactSha256(missingObservationBody),
    } as unknown as BenchmarkRunResult;
    assert.throws(
      () => validateBenchmarkRunResult(rehashedMissingObservation),
      /PASS requires a verified observation/u,
    );

    assert.equal(original.observation?.kind, "formal_terminology");
    if (original.observation?.kind !== "formal_terminology") return;
    const remappedCandidate = {
      ...original,
      observation: {
        ...original.observation,
        fixtureId: "formal:a_to_b:slot-99",
      },
    };
    const { resultSha256: staleRemappedHash, ...remappedBody } = remappedCandidate;
    assert.match(staleRemappedHash, /^[a-f0-9]{64}$/u);
    const rehashedRemap = {
      ...remappedBody,
      resultSha256: benchmarkArtifactSha256(remappedBody),
    } as BenchmarkRunResult;
    const remappedResults = execution.results.map((result) =>
      result.runId === original.runId ? rehashedRemap : result
    );
    assert.throws(
      () => scoreBenchmarkResults(EXECUTABLE_BENCHMARK_MANIFEST, remappedResults, profileUnderTest),
      /observation fixture does not match/u,
    );
  });
});

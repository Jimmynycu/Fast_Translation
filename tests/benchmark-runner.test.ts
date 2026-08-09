import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { ModularGuardedDuplexRelay } from "../src/core/relay.js";
import type { RelayCommand, SessionEvent } from "../src/core/types.js";
import { EXECUTABLE_BENCHMARK_MANIFEST } from "../src/benchmark/executable-manifest.js";
import {
  runLocalHarnessObservation,
  TerminalEvidenceIntegrityError,
} from "../src/benchmark/local-harness.js";
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

function runHarnessRegressionInChild(testNamePattern: string): void {
  mkdirSync(taskTemp, { recursive: true });
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    BENCHMARK_HARNESS_CHILD: "1",
    TEMP: taskTemp,
    TMP: taskTemp,
    TMPDIR: taskTemp,
  };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-isolation=none",
      `--test-name-pattern=${testNamePattern}`,
      resolve(process.cwd(), "dist-test", "tests", "benchmark-runner.test.js"),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment,
      timeout: 10_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message ?? "child process failed to spawn");
  assert.equal(result.signal, null, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /BENCHMARK_HARNESS_CHILD_PASS/u, result.stdout);
}

function completeHarnessRegressionChild(): void {
  // The isolated process owns relay timeout fences that may remain pending;
  // terminate only after the public-seam assertions have completed.
  process.stdout.write("BENCHMARK_HARNESS_CHILD_PASS\n");
  process.exit(0);
}

describe("keyless executable benchmark runner", () => {
  it("requires a non-empty reason for FAIL and INVALID_RUN outcomes", () => {
    for (const outcome of ["FAIL", "INVALID_RUN"] as const) {
      for (const reason of [undefined, "", "   "] as const) {
        const body = {
          schemaVersion: 5 as const,
          manifestSha256: "a".repeat(64),
          profileUnderTestSha256: "b".repeat(64),
          profileHash: "c".repeat(64),
          runId: `reason-${outcome}-${reason === undefined ? "missing" : "blank"}`,
          order: 1,
          stage: "formal_terminology" as const,
          arm: "GLOSSARY_CONTROLLED" as const,
          acceptanceScope: "local_mechanism_only" as const,
          providerAcceptanceVerdict: "NOT_RUN" as const,
          outcome,
          startedAt: "2026-08-10T00:00:00.000Z",
          completedAt: "2026-08-10T00:00:00.001Z",
          ...(reason === undefined ? {} : { reason }),
        };
        const result = {
          ...body,
          resultSha256: benchmarkArtifactSha256(body),
        } as BenchmarkRunResult;
        assert.throws(
          () => validateBenchmarkRunResult(result),
          new RegExp(`${outcome} requires a reason`, "u"),
        );
      }
    }
  });

  it("rejects rehashed NOT_RUN and PASS results that violate benchmark scope or gates", () => {
    const base = {
      schemaVersion: 5 as const,
      manifestSha256: "a".repeat(64),
      profileUnderTestSha256: "b".repeat(64),
      profileHash: "c".repeat(64),
      order: 1,
      stage: "formal_terminology" as const,
      providerAcceptanceVerdict: "NOT_RUN" as const,
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:00.001Z",
    };
    const rehashed = (body: Readonly<Record<string, unknown>>): BenchmarkRunResult => ({
      ...body,
      resultSha256: benchmarkArtifactSha256(body),
    } as unknown as BenchmarkRunResult);

    const externalWithObservation = rehashed({
      ...base,
      runId: "external-not-run-observation",
      arm: "PALABRA_REFERENCE",
      acceptanceScope: "external_provider_not_configured",
      outcome: "NOT_RUN",
      reason: "external adapter is not configured",
      observation: {} as never,
    });
    assert.throws(
      () => validateBenchmarkRunResult(externalWithObservation),
      /NOT_RUN requires a reason and no observation/u,
    );

    const externalBlankReason = rehashed({
      ...base,
      runId: "external-not-run-blank-reason",
      arm: "OPENAI_NATIVE_TRANSLATE",
      acceptanceScope: "external_provider_not_configured",
      outcome: "NOT_RUN",
      reason: " ",
    });
    assert.throws(
      () => validateBenchmarkRunResult(externalBlankReason),
      /NOT_RUN requires a reason and no observation/u,
    );

    const externalMissingReason = rehashed({
      ...base,
      runId: "external-not-run-missing-reason",
      arm: "PALABRA_REFERENCE",
      acceptanceScope: "external_provider_not_configured",
      outcome: "NOT_RUN",
    });
    assert.throws(
      () => validateBenchmarkRunResult(externalMissingReason),
      /NOT_RUN requires a reason and no observation/u,
    );

    const controlledNotRun = rehashed({
      ...base,
      runId: "controlled-not-run",
      arm: "GLOSSARY_CONTROLLED",
      acceptanceScope: "local_mechanism_only",
      outcome: "NOT_RUN",
      reason: "intentionally skipped",
    });
    assert.throws(
      () => validateBenchmarkRunResult(controlledNotRun),
      /controlled local execution cannot be NOT_RUN/u,
    );
  });

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
    assert.equal(execution.results.some((result) => result.outcome === "INVALID_RUN"), false);

    const local = execution.score.armVerdicts.GLOSSARY_CONTROLLED;
    assert.equal(local.verdict, "PASS");
    assert.equal(local.formal.completed, 8);
    assert.equal(local.latency.completed, 12);
    assert.equal(local.interruption.completed, 20);
    assert.equal(local.soak.completed, 1);
    assert.equal(execution.score.armVerdicts.PALABRA_REFERENCE.verdict, "NOT_RUN");
    assert.equal(execution.score.armVerdicts.OPENAI_NATIVE_TRANSLATE.verdict, "NOT_RUN");
    assert.equal(execution.score.localMechanismVerdict, "PASS");
    assert.deepEqual(execution.score.localReleaseEvidence, {
      targetExact: "PASS",
      zeroRegression: "PASS",
      alertsClear: "PASS",
      latency: "NOT_RUN",
      bargeIn: "NOT_RUN",
      evidenceComplete: "NOT_RUN",
    });
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

  it("executes local formal, latency, interruption, and sampled virtual duplex observations", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("observations"),
      profileUnderTest,
    });
    const localResults = execution.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    assert.equal(localResults.length, 41);
    assert.equal(localResults.every((result) => result.outcome === "PASS"), true);
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
        result.observation.alerts.length === 0 &&
        result.observation.normalizedEventEvidence.sourceRevision >= 0 &&
        result.observation.normalizedEventEvidence.targetRevision >= 0 &&
        result.observation.normalizedEventEvidence.targetFinal &&
        result.observation.normalizedEventEvidence.playoutSequenceContiguous &&
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
        result.observation.alerts.length === 0 &&
        result.observation.normalizedEventEvidence.sourceRevision >= 0 &&
        result.observation.normalizedEventEvidence.targetRevision >= 0 &&
        result.observation.normalizedEventEvidence.targetFinal &&
        result.observation.normalizedEventEvidence.playoutSequenceContiguous &&
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
      result.observation.validOutputResumed &&
      result.observation.alerts.length === 0
    ), true);

    const soak = localResults.find((result) => result.stage === "continuous_duplex");
    assert.ok(soak);
    assert.equal(soak.observation?.kind, "continuous_duplex");
    if (soak.observation?.kind !== "continuous_duplex") return;
    assert.equal(soak.observation.executionMode, "sampled_virtual_mechanism");
    assert.equal(soak.observation.coverageScope, "virtual_mechanism_only");
    assert.equal(soak.observation.virtualDurationMs, 600_000);
    assert.equal(soak.observation.virtualFramesRepresented, 60_000);
    assert.equal(soak.observation.sampleFramesPerLane, 30);
    assert.equal(soak.observation.processedSampleFrames, 60);
    assert.ok(
      soak.observation.processedSampleFrames < soak.observation.virtualFramesRepresented,
    );
    assert.equal(soak.observation.unacknowledgedSampleFrames, 0);
    assert.equal(soak.observation.queuePressureDetected, false);
    assert.equal(soak.observation.alerts.length, 0);
  });

  it("seals only opaque translation evidence refs into each local benchmark result", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("opaque-evidence-refs"),
      profileUnderTest,
    });
    const localResults = execution.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    assert.equal(localResults.length, 41);
    assert.equal(
      localResults.every((result) =>
        result.schemaVersion === 5 &&
        result.observation !== undefined &&
        result.observation.translationEvidenceRefs.length > 0 &&
        result.observation.evidenceFinalization.status === "sealed" &&
        result.observation.evidenceFinalization.sessionId ===
          result.observation.evidenceFinalizationExpectation.sessionId &&
        result.observation.evidenceFinalization.processingManifestSha256 ===
          result.observation.evidenceFinalizationExpectation.processingManifestSha256
      ),
      true,
    );
    const refs = localResults.flatMap((result) =>
      result.observation?.translationEvidenceRefs ?? []
    );
    assert.equal(
      refs.every((ref) => /^[a-z][a-z0-9_-]*:v1:sha256:[a-f0-9]{64}$/u.test(ref)),
      true,
    );
    for (const rawIdentity of [
      "benchmark-local-session",
      "openai_controlled",
      "turn-",
      "echo-audio-",
      "local-harness:echo:",
    ]) {
      assert.equal(refs.some((ref) => ref.includes(rawIdentity)), false);
    }
  });

  it("marks every affected controlled result INVALID_RUN when benchmark finalization cannot seal", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("finalization-failure"),
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: async (input) => {
        const observation = await runLocalHarnessObservation(input);
        return Object.freeze({
          ...observation,
          evidenceFinalization: Object.freeze({
            status: "FINALIZATION_FAILED" as const,
            sessionId: observation.evidenceFinalizationExpectation.sessionId,
            processingManifestSha256:
              observation.evidenceFinalizationExpectation.processingManifestSha256,
            failureCode: "integrity_verification_failed" as const,
            recovery: "rebuild_from_spool" as const,
          }),
        });
      },
    });

    const localResults = execution.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    assert.equal(localResults.length, 41);
    assert.equal(localResults.every((result) => result.outcome === "INVALID_RUN"), true);
    assert.equal(localResults.some((result) => result.outcome === "FAIL"), false);
    assert.equal(execution.score.localMechanismVerdict, "INVALID_RUN");
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.verdict, "INVALID_RUN");
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.formal.invalidRun, 8);
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.latency.invalidRun, 12);
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.interruption.invalidRun, 20);
    assert.equal(execution.score.armVerdicts.GLOSSARY_CONTROLLED.soak.invalidRun, 1);
    assert.deepEqual(execution.score.localReleaseEvidence, {
      targetExact: "INVALID_RUN",
      zeroRegression: "INVALID_RUN",
      alertsClear: "INVALID_RUN",
      latency: "INVALID_RUN",
      bargeIn: "INVALID_RUN",
      evidenceComplete: "INVALID_RUN",
    });
    const first = localResults[0];
    assert.ok(first);
    const marker = execution.markers.find((candidate) => candidate.runId === first.runId);
    assert.equal(marker?.state, "INVALID_RUN");
    assert.equal(execution.score.providerAcceptanceVerdict, "NOT_RUN");
    assert.equal(execution.score.productAcceptanceVerdict, "NOT_RUN");
  });

  it("maps terminal evidence integrity errors to INVALID_RUN without leaking diagnostics", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("terminal-integrity-error"),
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: async () => {
        throw new TerminalEvidenceIntegrityError("secret finalization diagnostic");
      },
    });
    const localResults = execution.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    assert.equal(localResults.length, 41);
    assert.equal(localResults.every((result) =>
      result.outcome === "INVALID_RUN" &&
      result.observation === undefined &&
      result.reason === "local terminal evidence finalization integrity failed"
    ), true);
    assert.equal(localResults.some((result) =>
      result.reason?.includes("secret finalization diagnostic") === true
    ), false);

    const ordinaryFailure = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("ordinary-execution-error"),
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: async () => {
        throw new Error("ordinary local execution failure");
      },
    });
    const ordinaryResults = ordinaryFailure.results.filter(
      (result) => result.arm === "GLOSSARY_CONTROLLED",
    );
    assert.equal(ordinaryResults.length, 41);
    assert.equal(ordinaryResults.every((result) =>
      result.outcome === "FAIL" && result.reason === "ordinary local execution failure"
    ), true);
  });

  it("completes an accurate interruption after each input reaches speech end", { timeout: 1_000, concurrency: false }, async () => {
    const run = EXECUTABLE_BENCHMARK_MANIFEST.runs.find((candidate) =>
      candidate.stage === "interruption" && candidate.arm === "GLOSSARY_CONTROLLED"
    );
    if (
      run === undefined ||
      run.scheduleId === undefined ||
      run.provider === undefined ||
      run.mode === undefined ||
      run.behavior === undefined
    ) {
      throw new Error("canonical controlled interruption input is missing");
    }
    const schedule = EXECUTABLE_BENCHMARK_MANIFEST.schedules.find(
      (candidate) => candidate.scheduleId === run.scheduleId,
    );
    if (schedule === undefined) throw new Error("canonical interruption schedule is missing");

    assert.equal(run.mode, "accurate");
    const observation = await runLocalHarnessObservation({
      run,
      provider: run.provider,
      mode: run.mode,
      behavior: run.behavior,
      approvedProfile: profileUnderTest.profile,
      approvedProfileHash: profileUnderTest.profileHash,
      schedule,
    });
    assert.equal(observation.kind, "interruption");
    if (observation.kind !== "interruption") return;
    assert.equal(observation.generationCut, true);
    assert.equal(observation.playoutCleared, true);
    assert.equal(observation.staleOutputRejected, true);
    assert.equal(observation.validOutputResumed, true);
    assert.equal(observation.alerts.length, 0);
  });

  it("bounds participant connection waiting and closes an aborted event iterator", { timeout: 20_000, concurrency: false }, async () => {
    if (process.env.BENCHMARK_HARNESS_CHILD !== "1") {
      runHarnessRegressionInChild("bounds participant connection waiting");
      return;
    }
    const run = EXECUTABLE_BENCHMARK_MANIFEST.runs.find((candidate) =>
      candidate.stage === "formal_terminology" && candidate.arm === "GLOSSARY_CONTROLLED"
    );
    if (
      run === undefined ||
      run.fixtureId === undefined ||
      run.provider === undefined ||
      run.mode === undefined ||
      run.behavior === undefined
    ) {
      throw new Error("canonical controlled formal input is missing");
    }
    const fixture = EXECUTABLE_BENCHMARK_MANIFEST.fixtures.find(
      (candidate) => candidate.fixtureId === run.fixtureId,
    );
    if (fixture === undefined) throw new Error("canonical formal fixture is missing");

    const relayPrototype = ModularGuardedDuplexRelay.prototype;
    const originalEvents = relayPrototype.events;
    const originalNow = performance.now;
    let nowCalls = 0;
    let aborted = false;
    let returned = false;
    let createdRelay: ModularGuardedDuplexRelay | undefined;
    relayPrototype.events = function(
      this: ModularGuardedDuplexRelay,
      _sessionId: string,
      _after = 0,
      signal?: AbortSignal,
    ): AsyncIterable<SessionEvent> {
      createdRelay = this;
      let resolveNext: ((result: IteratorResult<SessionEvent>) => void) | undefined;
      signal?.addEventListener("abort", () => {
        aborted = true;
      }, { once: true });
      const iterator: AsyncIterator<SessionEvent> = {
        next: () => new Promise<IteratorResult<SessionEvent>>((resolve) => {
          resolveNext = resolve;
        }),
        return: async () => {
          returned = true;
          resolveNext?.({ done: true, value: undefined as never });
          return { done: true, value: undefined as never };
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    };
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => nowCalls++ < 2 ? 0 : Number.POSITIVE_INFINITY,
    });
    try {
      await assert.rejects(
        runLocalHarnessObservation({
          run,
          provider: run.provider,
          mode: run.mode,
          behavior: run.behavior,
          approvedProfile: profileUnderTest.profile,
          approvedProfileHash: profileUnderTest.profileHash,
          fixture,
        }),
        /participants did not connect/u,
      );
    } finally {
      relayPrototype.events = originalEvents;
      Object.defineProperty(performance, "now", {
        configurable: true,
        value: originalNow,
      });
      if (createdRelay !== undefined) {
        await createdRelay.command(createdRelay.snapshot("benchmark-local-session").sessionId, {
          type: "end",
          commandId: "benchmark-timeout-cleanup",
          reason: "benchmark timeout test cleanup",
        }).catch(() => {});
      }
    }
    assert.equal(aborted, true);
    assert.equal(returned, true);
    completeHarnessRegressionChild();
  });

  it("does not retry a failed end and preserves the primary cleanup error", { timeout: 20_000, concurrency: false }, async () => {
    if (process.env.BENCHMARK_HARNESS_CHILD !== "1") {
      runHarnessRegressionInChild("does not retry a failed end");
      return;
    }
    const run = EXECUTABLE_BENCHMARK_MANIFEST.runs.find((candidate) =>
      candidate.stage === "formal_terminology" && candidate.arm === "GLOSSARY_CONTROLLED"
    );
    if (
      run === undefined ||
      run.fixtureId === undefined ||
      run.provider === undefined ||
      run.mode === undefined ||
      run.behavior === undefined
    ) {
      throw new Error("canonical controlled formal input is missing");
    }
    const fixture = EXECUTABLE_BENCHMARK_MANIFEST.fixtures.find(
      (candidate) => candidate.fixtureId === run.fixtureId,
    );
    if (fixture === undefined) throw new Error("canonical formal fixture is missing");

    const relayPrototype = ModularGuardedDuplexRelay.prototype;
    const originalCommand = relayPrototype.command;
    const endFailure = new Error("synthetic benchmark end failure");
    let endCalls = 0;
    let createdRelay: ModularGuardedDuplexRelay | undefined;
    relayPrototype.command = async function(
      this: ModularGuardedDuplexRelay,
      sessionId: string,
      command: RelayCommand,
    ): Promise<void> {
      createdRelay = this;
      if (command.type === "end" && command.commandId === "benchmark-end") {
        endCalls += 1;
        throw endFailure;
      }
      return originalCommand.call(this, sessionId, command);
    };
    try {
      await assert.rejects(
        runLocalHarnessObservation({
          run,
          provider: run.provider,
          mode: run.mode,
          behavior: run.behavior,
          approvedProfile: profileUnderTest.profile,
          approvedProfileHash: profileUnderTest.profileHash,
          fixture,
        }),
        (error: unknown) => error === endFailure,
      );
    } finally {
      relayPrototype.command = originalCommand;
      if (createdRelay !== undefined) {
        await originalCommand.call(createdRelay, "benchmark-local-session", {
          type: "end",
          commandId: "benchmark-end-cleanup",
          reason: "benchmark end failure test cleanup",
        }).catch(() => {});
      }
    }
    assert.equal(endCalls, 1);
    completeHarnessRegressionChild();
  });

  it("aggregates a primary observation failure with a failed end cleanup", { timeout: 20_000, concurrency: false }, async () => {
    if (process.env.BENCHMARK_HARNESS_CHILD !== "1") {
      runHarnessRegressionInChild("aggregates a primary observation failure");
      return;
    }
    const run = EXECUTABLE_BENCHMARK_MANIFEST.runs.find((candidate) =>
      candidate.stage === "latency" && candidate.arm === "GLOSSARY_CONTROLLED"
    );
    if (
      run === undefined ||
      run.fixtureId === undefined ||
      run.provider === undefined ||
      run.mode === undefined ||
      run.behavior === undefined
    ) {
      throw new Error("canonical controlled latency input is missing");
    }
    const fixture = EXECUTABLE_BENCHMARK_MANIFEST.fixtures.find(
      (candidate) => candidate.fixtureId === run.fixtureId,
    );
    if (fixture === undefined) throw new Error("canonical latency fixture is missing");

    const relayPrototype = ModularGuardedDuplexRelay.prototype;
    const originalCommand = relayPrototype.command;
    const endFailure = new Error("synthetic benchmark cleanup failure");
    let endCalls = 0;
    let createdRelay: ModularGuardedDuplexRelay | undefined;
    relayPrototype.command = async function(
      this: ModularGuardedDuplexRelay,
      sessionId: string,
      command: RelayCommand,
    ): Promise<void> {
      createdRelay = this;
      if (command.type === "end" && command.commandId === "benchmark-end") {
        endCalls += 1;
        throw endFailure;
      }
      return originalCommand.call(this, sessionId, command);
    };
    try {
      await assert.rejects(
        runLocalHarnessObservation({
          run,
          provider: run.provider,
          mode: run.mode,
          behavior: run.behavior,
          approvedProfile: profileUnderTest.profile,
          approvedProfileHash: profileUnderTest.profileHash,
          fixture: { ...fixture, scenario: "confuser" },
        }),
        (error: unknown) => {
          if (!(error instanceof AggregateError)) return false;
          const primary = error.errors[0];
          return primary instanceof Error &&
            /invalid latency scenario/u.test(primary.message) &&
            error.errors[1] === endFailure;
        },
      );
    } finally {
      relayPrototype.command = originalCommand;
      if (createdRelay !== undefined) {
        await originalCommand.call(createdRelay, "benchmark-local-session", {
          type: "end",
          commandId: "benchmark-aggregate-cleanup",
          reason: "benchmark aggregate test cleanup",
        }).catch(() => {});
      }
    }
    assert.equal(endCalls, 1);
    completeHarnessRegressionChild();
  });

  it("rejects a missing terminal finalization as typed evidence integrity", { timeout: 20_000, concurrency: false }, async () => {
    if (process.env.BENCHMARK_HARNESS_CHILD !== "1") {
      runHarnessRegressionInChild("rejects a missing terminal finalization");
      return;
    }
    const run = EXECUTABLE_BENCHMARK_MANIFEST.runs.find((candidate) =>
      candidate.stage === "formal_terminology" && candidate.arm === "GLOSSARY_CONTROLLED"
    );
    if (
      run === undefined ||
      run.fixtureId === undefined ||
      run.provider === undefined ||
      run.mode === undefined ||
      run.behavior === undefined
    ) {
      throw new Error("canonical controlled formal input is missing");
    }
    const fixture = EXECUTABLE_BENCHMARK_MANIFEST.fixtures.find(
      (candidate) => candidate.fixtureId === run.fixtureId,
    );
    if (fixture === undefined) throw new Error("canonical formal fixture is missing");

    const relayPrototype = ModularGuardedDuplexRelay.prototype;
    const originalSnapshot = relayPrototype.snapshot;
    const originalCommand = relayPrototype.command;
    let ending = false;
    relayPrototype.command = async function(
      this: ModularGuardedDuplexRelay,
      sessionId: string,
      command: RelayCommand,
    ): Promise<void> {
      if (command.type === "end") ending = true;
      return originalCommand.call(this, sessionId, command);
    };
    relayPrototype.snapshot = function(
      this: ModularGuardedDuplexRelay,
      sessionId: string,
    ) {
      const snapshot = originalSnapshot.call(this, sessionId);
      return ending && snapshot.status === "closed"
        ? { ...snapshot, evidenceFinalization: undefined } as unknown as ReturnType<typeof originalSnapshot>
        : snapshot;
    };
    try {
      await assert.rejects(
        runLocalHarnessObservation({
          run,
          provider: run.provider,
          mode: run.mode,
          behavior: run.behavior,
          approvedProfile: profileUnderTest.profile,
          approvedProfileHash: profileUnderTest.profileHash,
          fixture,
        }),
        (error: unknown) => error instanceof TerminalEvidenceIntegrityError,
      );
    } finally {
      relayPrototype.snapshot = originalSnapshot;
      relayPrototype.command = originalCommand;
    }
    completeHarnessRegressionChild();
  });

  it("accepts a final normalized transcript at revision zero", async () => {
    const execution = await executeKeylessBenchmark({
      outputDirectory: await isolatedDirectory("revision-zero-finality"),
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: async (input) => {
        const observation = await runLocalHarnessObservation(input);
        if (observation.kind !== "formal_terminology" && observation.kind !== "latency") {
          return observation;
        }
        return Object.freeze({
          ...observation,
          normalizedEventEvidence: Object.freeze({
            ...observation.normalizedEventEvidence,
            sourceRevision: 0,
            targetRevision: 0,
          }),
        });
      },
    });
    const transcriptResults = execution.results.filter((result) =>
      result.arm === "GLOSSARY_CONTROLLED" &&
      (result.stage === "formal_terminology" || result.stage === "latency")
    );
    assert.equal(transcriptResults.length, 20);
    assert.equal(transcriptResults.every((result) => result.outcome === "PASS"), true);
    assert.equal(transcriptResults.every((result) =>
      (result.observation?.kind === "formal_terminology" || result.observation?.kind === "latency") &&
      result.observation.normalizedEventEvidence.sourceRevision === 0 &&
      result.observation.normalizedEventEvidence.targetRevision === 0 &&
      result.observation.normalizedEventEvidence.targetFinal
    ), true);
    assert.equal(execution.score.localMechanismVerdict, "PASS");
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
    const mechanismFailureCandidate = {
      ...original,
      observation: {
        ...original.observation,
        uninterrupted: false,
      },
    };
    const { resultSha256: staleMechanismFailureHash, ...mechanismFailureBody } =
      mechanismFailureCandidate;
    assert.match(staleMechanismFailureHash, /^[a-f0-9]{64}$/u);
    const rehashedMechanismFailure = {
      ...mechanismFailureBody,
      resultSha256: benchmarkArtifactSha256(mechanismFailureBody),
    } as BenchmarkRunResult;
    assert.throws(
      () => validateBenchmarkRunResult(rehashedMechanismFailure),
      /outcome contradicts its observation/u,
    );

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

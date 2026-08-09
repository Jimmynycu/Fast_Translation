import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashHealingProfile, type HealingProfile } from "./healing.js";
import {
  runLocalHarnessObservation,
  TerminalEvidenceIntegrityError,
  type LocalHarnessExecutor,
} from "./local-harness.js";
import {
  EXECUTABLE_BENCHMARK_MANIFEST,
  validateExecutableBenchmarkManifest,
  type ExecutableBenchmarkManifest,
  type ExecutableFixture,
  type ExecutableRun,
  type ExecutableSchedule,
} from "./executable-manifest.js";
import type { BenchmarkArm } from "./protocol.js";
import {
  validateEvidenceFinalization,
  type EvidenceFinalization,
  type EvidenceFinalizationExpectation,
} from "../core/evidence-lifecycle.js";

export type BenchmarkRunOutcome = "PASS" | "FAIL" | "INVALID_RUN" | "NOT_RUN";
export type BenchmarkMarkerState =
  | "STARTED"
  | "COMPLETED"
  | "FAILED"
  | "INVALID_RUN"
  | "NOT_RUN";
const BENCHMARK_ARTIFACT_SCHEMA_VERSION = 5 as const;
export type LocalReleaseEvidenceVerdict = "PASS" | "FAIL" | "INVALID_RUN" | "NOT_RUN";
const TERMINAL_EVIDENCE_INTEGRITY_FAILURE_REASON =
  "local terminal evidence finalization integrity failed";

export interface TranslationEvidenceObservation {
  /** Opaque provider-event references observed at the TranslationPort boundary. */
  readonly translationEvidenceRefs: readonly string[];
  /** Terminal evidence seal for the exact local execution represented by this result. */
  readonly evidenceFinalization: EvidenceFinalization;
  /** Immutable session-manifest binding used to validate the terminal receipt. */
  readonly evidenceFinalizationExpectation: EvidenceFinalizationExpectation;
}

export interface FormalTerminologyObservation extends TranslationEvidenceObservation {
  readonly kind: "formal_terminology";
  readonly fixtureId: string;
  readonly scenario: "protected" | "confuser" | "ordinary";
  readonly actualTargetText: string;
  readonly targetExactSatisfied: boolean;
  readonly termBound: boolean;
  readonly bindingCount: number;
  readonly matchedSourceTexts: readonly string[];
  readonly authorizationStatus: "authorized" | "bypassed" | "not_applicable";
  readonly glossaryHash: string;
  readonly playedFrameCount: number;
  readonly uninterrupted: boolean;
  /** Captured normalized transcript revision/finality and playout-sequence evidence. */
  readonly normalizedEventEvidence: Readonly<{
    readonly sourceRevision: number;
    readonly targetRevision: number;
    readonly targetFinal: boolean;
    readonly playoutSequenceContiguous: boolean;
  }>;
  readonly alerts: readonly string[];
  readonly elapsedMs: number;
}

export interface LocalLatencyObservation extends TranslationEvidenceObservation {
  readonly kind: "latency";
  readonly fixtureId: string;
  readonly scenario: "protected" | "ordinary";
  readonly measurementScope: "local_processing_not_acoustic";
  readonly targetExactSatisfied: boolean;
  readonly bindingCount: number;
  readonly matchedSourceTexts: readonly string[];
  readonly authorizationStatus: "authorized" | "bypassed" | "not_applicable";
  readonly glossaryHash: string;
  readonly playedFrameCount: number;
  readonly uninterrupted: boolean;
  readonly normalizedEventEvidence: Readonly<{
    readonly sourceRevision: number;
    readonly targetRevision: number;
    readonly targetFinal: boolean;
    readonly playoutSequenceContiguous: boolean;
  }>;
  readonly alerts: readonly string[];
  readonly metricsMs: Readonly<{
    readonly speechToAligned: number;
    readonly stableSourceToPlayable: number;
    readonly glossaryOverhead: number;
  }>;
}

export interface LocalInterruptionObservation extends TranslationEvidenceObservation {
  readonly kind: "interruption";
  readonly scheduleId: string;
  readonly measurementScope: "local_state_machine_not_acoustic";
  readonly processedEvents: number;
  readonly generationCut: boolean;
  readonly playoutCleared: boolean;
  readonly staleOutputRejected: boolean;
  readonly validOutputResumed: boolean;
  readonly clearLatencyMs: number;
  readonly alerts: readonly string[];
}

export interface LocalSoakObservation extends TranslationEvidenceObservation {
  readonly kind: "continuous_duplex";
  readonly scheduleId: string;
  /** This is a sparse local mechanism fixture, never a live sustained-soak result. */
  readonly executionMode: "sampled_virtual_mechanism";
  /** The omitted virtual frames are not sent to a provider or retained in a queue. */
  readonly coverageScope: "virtual_mechanism_only";
  /** Span of the virtual timeline represented by the sparse fixture. */
  readonly virtualDurationMs: number;
  /** Virtual 20 ms frame positions covered by the deterministic sparse fixture. */
  readonly virtualFramesRepresented: number;
  /** Actual source PCM frames sent to the local relay, per direction. */
  readonly sampleFramesPerLane: number;
  /** Actual source PCM frames sent to the local relay across both directions. */
  readonly processedSampleFrames: number;
  /** Maximum simultaneous local playout callbacks; this is not a provider queue depth. */
  readonly playbackMaximumConcurrency: number;
  /** Sampled frames that were not acknowledged by the local MediaPort. */
  readonly unacknowledgedSampleFrames: number;
  /** Queue pressure observed within the sparse local fixture only. */
  readonly queuePressureDetected: boolean;
  readonly checksum: number;
  readonly alerts: readonly string[];
}

export type BenchmarkObservation =
  | FormalTerminologyObservation
  | LocalLatencyObservation
  | LocalInterruptionObservation
  | LocalSoakObservation;

export interface BenchmarkProfileUnderTest {
  readonly schemaVersion: 1;
  readonly kind: "benchmark_profile_under_test";
  readonly approvedProfileArtifactSha256: string;
  readonly profileHash: string;
  readonly profile: HealingProfile;
  readonly profileUnderTestSha256: string;
}

export interface BenchmarkRunResult {
  readonly schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  readonly manifestSha256: string;
  readonly profileUnderTestSha256: string;
  readonly profileHash: string;
  readonly runId: string;
  readonly order: number;
  readonly stage: ExecutableRun["stage"];
  readonly arm?: BenchmarkArm;
  readonly outcome: BenchmarkRunOutcome;
  readonly acceptanceScope:
    | "local_mechanism_only"
    | "external_provider_not_configured"
    | "paid_discovery_not_executed";
  readonly providerAcceptanceVerdict: "NOT_RUN";
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observation?: BenchmarkObservation;
  readonly reason?: string;
  readonly resultSha256: string;
}

export interface BenchmarkRunMarker {
  readonly schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  readonly manifestSha256: string;
  readonly profileUnderTestSha256: string;
  readonly profileHash: string;
  readonly runId: string;
  readonly order: number;
  readonly stage: ExecutableRun["stage"];
  readonly arm?: BenchmarkArm;
  readonly state: BenchmarkMarkerState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly resultSha256?: string;
  readonly reason?: string;
  readonly markerSha256: string;
}

export interface BenchmarkStageScore {
  readonly expected: number;
  readonly completed: number;
  readonly passed: number;
  readonly failed: number;
  readonly invalidRun: number;
  readonly notRun: number;
}

export interface BenchmarkArmVerdict {
  readonly verdict: "PASS" | "FAIL" | "INVALID_RUN" | "NOT_RUN";
  readonly scope: "local_mechanism_only" | "external_provider";
  readonly formal: BenchmarkStageScore;
  readonly latency: BenchmarkStageScore;
  readonly interruption: BenchmarkStageScore;
  readonly soak: BenchmarkStageScore;
  readonly failures: readonly string[];
  readonly invalidRuns: readonly string[];
}

export interface BenchmarkAcceptanceScore {
  readonly schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  readonly manifestSha256: string;
  readonly profileUnderTestSha256: string;
  readonly profileHash: string;
  readonly armVerdicts: Readonly<Record<BenchmarkArm, BenchmarkArmVerdict>>;
  readonly discovery: BenchmarkStageScore;
  readonly localMechanismVerdict: "PASS" | "FAIL" | "INVALID_RUN";
  readonly localReleaseEvidence: Readonly<{
    readonly targetExact: LocalReleaseEvidenceVerdict;
    readonly zeroRegression: LocalReleaseEvidenceVerdict;
    readonly alertsClear: LocalReleaseEvidenceVerdict;
    /** Local processing timings are not acoustic latency measurements. */
    readonly latency: LocalReleaseEvidenceVerdict;
    /** Local state-machine clears are not acoustic barge-in measurements. */
    readonly bargeIn: LocalReleaseEvidenceVerdict;
    /** No normalized event export or four-track capture artifact is in the keyless bundle. */
    readonly evidenceComplete: LocalReleaseEvidenceVerdict;
  }>;
  readonly providerAcceptanceVerdict: "NOT_RUN";
  readonly productAcceptanceVerdict: "NOT_RUN";
  readonly limitations: readonly string[];
  readonly scoreSha256: string;
}

export interface KeylessBenchmarkBundle {
  readonly schemaVersion: typeof BENCHMARK_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "keyless_benchmark_bundle";
  readonly executionMode: "default_local_relay" | "test_only_custom_executor";
  readonly manifestSha256: string;
  readonly profileUnderTestSha256: string;
  readonly profileHash: string;
  readonly generatedAt: string;
  readonly markerCount: number;
  readonly resultCount: number;
  readonly markerSetSha256: string;
  readonly resultSetSha256: string;
  readonly scoreSha256: string;
  readonly productAcceptanceVerdict: "NOT_RUN";
  readonly artifactFiles: Readonly<{
    readonly profileUnderTest: "profile-under-test.json";
    readonly manifest: "manifest.json";
    readonly markers: "run-markers.jsonl";
    readonly results: "run-results.jsonl";
    readonly score: "score.json";
    readonly checksums: "checksums.sha256";
  }>;
  readonly bundleSha256: string;
}

export interface KeylessBenchmarkExecution {
  readonly profileUnderTest: BenchmarkProfileUnderTest;
  readonly markers: readonly BenchmarkRunMarker[];
  readonly results: readonly BenchmarkRunResult[];
  readonly score: BenchmarkAcceptanceScore;
  readonly bundle: KeylessBenchmarkBundle;
}

export interface KeylessBenchmarkOptions {
  readonly outputDirectory: string;
  readonly profileUnderTest: BenchmarkProfileUnderTest;
  /**
   * A custom executor is a fault-injection seam for tests only. Callers must
   * opt into testOnly, and resulting bundles are rejected by the release gate.
   */
  readonly localHarnessExecutor?: LocalHarnessExecutor;
  readonly testOnly?: boolean;
  readonly manifest?: ExecutableBenchmarkManifest;
  readonly now?: () => number;
}

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

export function benchmarkArtifactSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

export function createBenchmarkProfileUnderTest(input: Readonly<{
  readonly approvedProfileArtifactSha256: string;
  readonly profile: HealingProfile;
}>): BenchmarkProfileUnderTest {
  const profileHash = hashHealingProfile(input.profile);
  const body = {
    schemaVersion: 1 as const,
    kind: "benchmark_profile_under_test" as const,
    approvedProfileArtifactSha256: input.approvedProfileArtifactSha256,
    profileHash,
    profile: input.profile,
  };
  const artifact = deepFreeze({
    ...body,
    profileUnderTestSha256: benchmarkArtifactSha256(body),
  });
  validateBenchmarkProfileUnderTest(artifact);
  return artifact;
}

export function validateBenchmarkProfileUnderTest(
  artifact: BenchmarkProfileUnderTest,
): void {
  const { profileUnderTestSha256, ...body } = artifact;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.kind !== "benchmark_profile_under_test" ||
    !/^[a-f0-9]{64}$/u.test(artifact.approvedProfileArtifactSha256) ||
    !/^[a-f0-9]{64}$/u.test(profileUnderTestSha256) ||
    profileUnderTestSha256 !== benchmarkArtifactSha256(body) ||
    hashHealingProfile(artifact.profile) !== artifact.profileHash
  ) {
    throw new Error("benchmark profile-under-test artifact mismatch");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isoTimestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new RangeError("benchmark clock must be finite");
  return new Date(value).toISOString();
}

function artifactResult(
  body: Omit<BenchmarkRunResult, "resultSha256">,
): BenchmarkRunResult {
  return deepFreeze({ ...body, resultSha256: benchmarkArtifactSha256(body) });
}

function artifactMarker(
  body: Omit<BenchmarkRunMarker, "markerSha256">,
): BenchmarkRunMarker {
  return deepFreeze({ ...body, markerSha256: benchmarkArtifactSha256(body) });
}

function observationMatchesStage(
  stage: ExecutableRun["stage"],
  observation: BenchmarkObservation,
): boolean {
  switch (stage) {
    case "formal_terminology":
      return observation.kind === "formal_terminology";
    case "latency":
      return observation.kind === "latency";
    case "interruption":
      return observation.kind === "interruption";
    case "continuous_duplex":
      return observation.kind === "continuous_duplex";
    case "discovery":
      return false;
  }
}

export function validateBenchmarkRunResult(result: BenchmarkRunResult): void {
  const { resultSha256, ...body } = result;
  if (
    !/^[a-f0-9]{64}$/u.test(resultSha256) ||
    resultSha256 !== benchmarkArtifactSha256(body)
  ) {
    throw new Error(`${result.runId} result hash mismatch`);
  }
  if (result.providerAcceptanceVerdict !== "NOT_RUN") {
    throw new Error(`${result.runId} must not claim provider acceptance`);
  }
  if (
    result.acceptanceScope !== "local_mechanism_only" &&
    result.outcome !== "NOT_RUN"
  ) {
    throw new Error(`${result.runId} cannot pass outside local mechanism scope`);
  }
  if (
    result.schemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION ||
    !/^[a-f0-9]{64}$/u.test(result.profileUnderTestSha256) ||
    !/^[a-f0-9]{64}$/u.test(result.profileHash) ||
    result.runId.trim().length === 0 ||
    !Number.isSafeInteger(result.order) ||
    result.order < 1 ||
    !Number.isFinite(Date.parse(result.startedAt)) ||
    !Number.isFinite(Date.parse(result.completedAt))
  ) {
    throw new Error(`${result.runId} has invalid result metadata`);
  }
  if (
    result.acceptanceScope === "local_mechanism_only" &&
    result.arm !== "GLOSSARY_CONTROLLED"
  ) {
    throw new Error(`${result.runId} local scope requires GLOSSARY_CONTROLLED`);
  }
  if (
    result.acceptanceScope === "external_provider_not_configured" &&
    result.arm !== "PALABRA_REFERENCE" &&
    result.arm !== "OPENAI_NATIVE_TRANSLATE"
  ) {
    throw new Error(`${result.runId} external scope requires an external arm`);
  }
  if (
    result.acceptanceScope === "paid_discovery_not_executed" &&
    (result.stage !== "discovery" || result.arm !== undefined)
  ) {
    throw new Error(`${result.runId} discovery scope has invalid semantics`);
  }
  if (
    result.acceptanceScope !== "local_mechanism_only" &&
    result.acceptanceScope !== "external_provider_not_configured" &&
    result.acceptanceScope !== "paid_discovery_not_executed"
  ) {
    throw new Error(`${result.runId} has an invalid acceptance scope`);
  }
  if (result.outcome === "NOT_RUN") {
    if (
      result.acceptanceScope === "local_mechanism_only" ||
      result.arm === "GLOSSARY_CONTROLLED"
    ) {
      throw new Error(`${result.runId} controlled local execution cannot be NOT_RUN`);
    }
    if (
      result.observation !== undefined ||
      result.reason === undefined ||
      result.reason.trim().length === 0
    ) {
      throw new Error(`${result.runId} NOT_RUN requires a reason and no observation`);
    }
    return;
  }
  if (
    (result.outcome === "FAIL" || result.outcome === "INVALID_RUN") &&
    (result.reason === undefined || result.reason.trim().length === 0)
  ) {
    throw new Error(`${result.runId} ${result.outcome} requires a reason`);
  }
  if (result.observation === undefined) {
    if (
      result.outcome === "PASS" ||
      (result.outcome === "INVALID_RUN" &&
        result.reason !== TERMINAL_EVIDENCE_INTEGRITY_FAILURE_REASON)
    ) {
      throw new Error(`${result.runId} ${result.outcome} requires a verified observation`);
    }
    return;
  }
  if (!observationMatchesStage(result.stage, result.observation)) {
    throw new Error(`${result.runId} observation does not match its stage`);
  }
  const evidenceIntegrityPassed = observationEvidenceIntegrityPassed(result.observation);
  if (result.outcome === "INVALID_RUN") {
    if (evidenceIntegrityPassed) {
      throw new Error(`${result.runId} INVALID_RUN requires failed evidence integrity`);
    }
    return;
  }
  if (!evidenceIntegrityPassed) {
    throw new Error(`${result.runId} evidence integrity failure requires INVALID_RUN`);
  }
  const passed = observationMechanismPassed(result.observation);
  if (
    (result.outcome === "PASS" && !passed) ||
    (result.outcome === "FAIL" && passed)
  ) {
    throw new Error(`${result.runId} outcome contradicts its observation`);
  }
}

function validateMarker(marker: BenchmarkRunMarker): void {
  const { markerSha256, ...body } = marker;
  if (
    !/^[a-f0-9]{64}$/u.test(markerSha256) ||
    markerSha256 !== benchmarkArtifactSha256(body) ||
    marker.schemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION ||
    !/^[a-f0-9]{64}$/u.test(marker.profileUnderTestSha256) ||
    !/^[a-f0-9]{64}$/u.test(marker.profileHash)
  ) {
    throw new Error(`${marker.runId} marker hash mismatch`);
  }
}

function safeRunFileStem(run: ExecutableRun): string {
  if (!/^[A-Za-z0-9:_-]+$/u.test(run.runId)) {
    throw new TypeError(`Unsafe benchmark runId: ${run.runId}`);
  }
  return `${String(run.order).padStart(3, "0")}-${run.runId}`;
}

function requiredFixture(
  run: ExecutableRun,
  fixtures: ReadonlyMap<string, ExecutableFixture>,
): ExecutableFixture {
  if (run.fixtureId === undefined) throw new Error(`${run.runId} has no fixture`);
  const fixture = fixtures.get(run.fixtureId);
  if (fixture === undefined) throw new Error(`${run.runId} fixture is missing`);
  return fixture;
}

function requiredSchedule(
  run: ExecutableRun,
  schedules: ReadonlyMap<string, ExecutableSchedule>,
): ExecutableSchedule {
  if (run.scheduleId === undefined) throw new Error(`${run.runId} has no schedule`);
  const schedule = schedules.get(run.scheduleId);
  if (schedule === undefined) throw new Error(`${run.runId} schedule is missing`);
  return schedule;
}

function hasWellFormedTranslationEvidenceRefs(observation: BenchmarkObservation): boolean {
  return observation.translationEvidenceRefs.every((ref) =>
    /^[a-z][a-z0-9_-]*:v1:sha256:[a-f0-9]{64}$/u.test(ref)
  );
}

function hasRequiredOpaqueTranslationEvidenceRefs(observation: BenchmarkObservation): boolean {
  return observation.translationEvidenceRefs.length > 0 &&
    hasWellFormedTranslationEvidenceRefs(observation);
}

function hasSealedEvidenceFinalization(observation: BenchmarkObservation): boolean {
  if (observation.evidenceFinalization.status !== "sealed") return false;
  try {
    validateEvidenceFinalization(
      observation.evidenceFinalization,
      observation.evidenceFinalizationExpectation,
    );
    return true;
  } catch {
    return false;
  }
}

function observationEvidenceIntegrityPassed(observation: BenchmarkObservation): boolean {
  // A functional fixture failure can end before the provider produces an event.
  // Empty refs therefore fail the mechanism gate below, not integrity itself.
  return hasWellFormedTranslationEvidenceRefs(observation) &&
    hasSealedEvidenceFinalization(observation);
}

function observationMechanismPassed(observation: BenchmarkObservation): boolean {
  switch (observation.kind) {
    case "formal_terminology":
      return observation.uninterrupted &&
        hasRequiredOpaqueTranslationEvidenceRefs(observation) &&
        observation.alerts.length === 0 &&
        observation.normalizedEventEvidence.sourceRevision >= 0 &&
        observation.normalizedEventEvidence.targetRevision >= 0 &&
        observation.normalizedEventEvidence.targetFinal &&
        observation.normalizedEventEvidence.playoutSequenceContiguous &&
        observation.playedFrameCount === 3 &&
        (observation.scenario === "protected"
          ? observation.targetExactSatisfied &&
            observation.authorizationStatus === "authorized" &&
            observation.termBound &&
            observation.bindingCount === 1 &&
            observation.matchedSourceTexts.length === 1
          : observation.authorizationStatus === "not_applicable" &&
            !observation.termBound &&
            observation.bindingCount === 0 &&
            observation.matchedSourceTexts.length === 0);
    case "latency":
      return observation.uninterrupted &&
        hasRequiredOpaqueTranslationEvidenceRefs(observation) &&
        observation.alerts.length === 0 &&
        observation.normalizedEventEvidence.sourceRevision >= 0 &&
        observation.normalizedEventEvidence.targetRevision >= 0 &&
        observation.normalizedEventEvidence.targetFinal &&
        observation.normalizedEventEvidence.playoutSequenceContiguous &&
        observation.playedFrameCount === 3 &&
        (observation.scenario === "protected"
          ? observation.targetExactSatisfied &&
            observation.authorizationStatus === "authorized" &&
            observation.bindingCount === 1 &&
            observation.matchedSourceTexts.length === 1
          : observation.authorizationStatus === "not_applicable" &&
            observation.bindingCount === 0 &&
            observation.matchedSourceTexts.length === 0) &&
        Object.values(observation.metricsMs).every(
          (sample) => Number.isFinite(sample) && sample >= 0,
        );
    case "interruption":
      return observation.generationCut &&
        hasRequiredOpaqueTranslationEvidenceRefs(observation) &&
        observation.alerts.length === 0 &&
        observation.playoutCleared &&
        observation.staleOutputRejected &&
        observation.validOutputResumed &&
        Number.isFinite(observation.clearLatencyMs);
    case "continuous_duplex":
      return observation.virtualDurationMs === 600_000 &&
        hasRequiredOpaqueTranslationEvidenceRefs(observation) &&
        observation.coverageScope === "virtual_mechanism_only" &&
        observation.alerts.length === 0 &&
        observation.virtualFramesRepresented === 60_000 &&
        observation.sampleFramesPerLane === 30 &&
        observation.processedSampleFrames === 60 &&
        observation.processedSampleFrames < observation.virtualFramesRepresented &&
        observation.unacknowledgedSampleFrames === 0 &&
        observation.checksum > 0 &&
        !observation.queuePressureDetected;
  }
}

function observationAlerts(observation: BenchmarkObservation | undefined): readonly string[] | undefined {
  return observation?.alerts;
}

function releaseEvidence(results: readonly BenchmarkRunResult[]): BenchmarkAcceptanceScore["localReleaseEvidence"] {
  const local = results.filter((result) => result.arm === "GLOSSARY_CONTROLLED");
  if (local.some((result) => result.outcome === "INVALID_RUN")) {
    return deepFreeze({
      targetExact: "INVALID_RUN" as const,
      zeroRegression: "INVALID_RUN" as const,
      alertsClear: "INVALID_RUN" as const,
      latency: "INVALID_RUN" as const,
      bargeIn: "INVALID_RUN" as const,
      evidenceComplete: "INVALID_RUN" as const,
    });
  }
  const formal = local.filter((result) => result.stage === "formal_terminology");
  const targetExact = formal.filter((result) =>
    result.observation?.kind === "formal_terminology" && result.observation.scenario === "protected"
  ).length === 4 && formal.every((result) =>
    result.observation?.kind !== "formal_terminology" ||
    result.observation.scenario !== "protected" ||
    (result.outcome === "PASS" && result.observation.targetExactSatisfied)
  );
  const zeroRegression = formal.length === 8 && formal.every((result) => result.outcome === "PASS");
  const alertsClear = local.length > 0 && local.every((result) =>
    observationAlerts(result.observation)?.length === 0
  );
  return deepFreeze({
    targetExact: targetExact ? "PASS" as const : "FAIL" as const,
    zeroRegression: zeroRegression ? "PASS" as const : "FAIL" as const,
    alertsClear: alertsClear ? "PASS" as const : "FAIL" as const,
    latency: "NOT_RUN" as const,
    bargeIn: "NOT_RUN" as const,
    evidenceComplete: "NOT_RUN" as const,
  });
}

function stageScore(
  results: readonly BenchmarkRunResult[],
  expected: number,
): BenchmarkStageScore {
  return deepFreeze({
    expected,
    completed: results.filter((result) => result.outcome !== "NOT_RUN").length,
    passed: results.filter((result) => result.outcome === "PASS").length,
    failed: results.filter((result) => result.outcome === "FAIL").length,
    invalidRun: results.filter((result) => result.outcome === "INVALID_RUN").length,
    notRun: results.filter((result) => result.outcome === "NOT_RUN").length,
  });
}

function armVerdict(
  arm: BenchmarkArm,
  results: readonly BenchmarkRunResult[],
): BenchmarkArmVerdict {
  const armResults = results.filter((result) => result.arm === arm);
  const formalResults = armResults.filter((result) => result.stage === "formal_terminology");
  const latencyResults = armResults.filter((result) => result.stage === "latency");
  const interruptionResults = armResults.filter((result) => result.stage === "interruption");
  const soakResults = armResults.filter((result) => result.stage === "continuous_duplex");
  const failures = armResults
    .filter((result) => result.outcome === "FAIL")
    .map((result) => `${result.runId}: ${result.reason ?? "local observation failed"}`);
  const invalidRuns = armResults
    .filter((result) => result.outcome === "INVALID_RUN")
    .map((result) => `${result.runId}: ${result.reason ?? "evidence integrity failed"}`);
  const allNotRun = armResults.every((result) => result.outcome === "NOT_RUN");
  const complete =
    formalResults.filter((result) => result.outcome === "PASS").length === 8 &&
    latencyResults.filter((result) => result.outcome === "PASS").length === 12 &&
    interruptionResults.filter((result) => result.outcome === "PASS").length === 20 &&
    soakResults.filter((result) => result.outcome === "PASS").length === 1;
  const verdict = allNotRun
    ? "NOT_RUN"
    : invalidRuns.length > 0
      ? "INVALID_RUN"
      : complete && failures.length === 0
        ? "PASS"
        : "FAIL";
  return deepFreeze({
    verdict,
    scope: arm === "GLOSSARY_CONTROLLED"
      ? "local_mechanism_only"
      : "external_provider",
    formal: stageScore(formalResults, 8),
    latency: stageScore(latencyResults, 12),
    interruption: stageScore(interruptionResults, 20),
    soak: stageScore(soakResults, 1),
    failures: Object.freeze(failures),
    invalidRuns: Object.freeze(invalidRuns),
  });
}

export function scoreBenchmarkResults(
  manifest: ExecutableBenchmarkManifest,
  results: readonly BenchmarkRunResult[],
  profileUnderTest: BenchmarkProfileUnderTest,
): BenchmarkAcceptanceScore {
  validateExecutableBenchmarkManifest(manifest);
  validateBenchmarkProfileUnderTest(profileUnderTest);
  if (results.length !== manifest.runs.length) {
    throw new Error("Benchmark result count does not match the canonical manifest");
  }
  const resultsByRun = new Map<string, BenchmarkRunResult>();
  for (const result of results) {
    validateBenchmarkRunResult(result);
    if (resultsByRun.has(result.runId)) throw new Error(`Duplicate result ${result.runId}`);
    resultsByRun.set(result.runId, result);
  }
  for (const run of manifest.runs) {
    const result = resultsByRun.get(run.runId);
    if (
      result === undefined ||
      result.manifestSha256 !== manifest.manifestSha256 ||
      result.profileUnderTestSha256 !== profileUnderTest.profileUnderTestSha256 ||
      result.profileHash !== profileUnderTest.profileHash ||
      result.order !== run.order ||
      result.stage !== run.stage ||
      result.arm !== run.arm
    ) {
      throw new Error(`${run.runId} result does not match its manifest run`);
    }
    if (run.arm === "GLOSSARY_CONTROLLED" && result.outcome === "NOT_RUN") {
      throw new Error(`${run.runId} controlled local execution cannot be NOT_RUN`);
    }
    const observation = result.observation;
    if (
      observation?.kind === "formal_terminology" ||
      observation?.kind === "latency"
    ) {
      if (observation.fixtureId !== run.fixtureId) {
        throw new Error(`${run.runId} observation fixture does not match its manifest run`);
      }
    }
    if (
      observation?.kind === "interruption" ||
      observation?.kind === "continuous_duplex"
    ) {
      if (observation.scheduleId !== run.scheduleId) {
        throw new Error(`${run.runId} observation schedule does not match its manifest run`);
      }
    }
  }

  const armVerdicts = deepFreeze({
    PALABRA_REFERENCE: armVerdict("PALABRA_REFERENCE", results),
    OPENAI_NATIVE_TRANSLATE: armVerdict("OPENAI_NATIVE_TRANSLATE", results),
    GLOSSARY_CONTROLLED: armVerdict("GLOSSARY_CONTROLLED", results),
  });
  const localMechanismVerdict = armVerdicts.GLOSSARY_CONTROLLED.verdict === "PASS"
    ? "PASS" as const
    : armVerdicts.GLOSSARY_CONTROLLED.verdict === "INVALID_RUN"
      ? "INVALID_RUN" as const
      : "FAIL" as const;
  const discoveryResults = results.filter((result) => result.stage === "discovery");
  const localReleaseEvidence = releaseEvidence(results);
  const body = {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    manifestSha256: manifest.manifestSha256,
    profileUnderTestSha256: profileUnderTest.profileUnderTestSha256,
    profileHash: profileUnderTest.profileHash,
    armVerdicts,
    discovery: stageScore(discoveryResults, 60),
    localMechanismVerdict,
    localReleaseEvidence,
    providerAcceptanceVerdict: "NOT_RUN" as const,
    productAcceptanceVerdict: "NOT_RUN" as const,
    limitations: Object.freeze([
      "The local arm measures deterministic mechanism behavior, not live acoustic latency.",
      "Local latency and barge-in fixture gates remain NOT_RUN until an acoustic capture benchmark is executed.",
      "Keyless receipt digests are content-bound virtual evidence; normalized event export and four-track audio coverage remain NOT_RUN.",
      "Continuous duplex PASS covers only 60 sampled virtual frames (30 per lane); a sustained provider or queue soak remains NOT_RUN.",
      "OpenAI and Palabra adapters were not configured and remain NOT_RUN.",
      "Discovery requires the separately budgeted paid command and remains NOT_RUN.",
    ]),
  };
  return deepFreeze({ ...body, scoreSha256: benchmarkArtifactSha256(body) });
}

async function writeJson(path: string, value: unknown): Promise<string> {
  const text = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return text;
}

async function writeJsonLines(path: string, values: readonly unknown[]): Promise<string> {
  const text = values.map((value) => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return text;
}

function checksumLine(path: string, content: string): string {
  const digest = createHash("sha256").update(content, "utf8").digest("hex");
  return `${digest}  ${path}`;
}

export async function executeKeylessBenchmark(
  options: KeylessBenchmarkOptions,
): Promise<KeylessBenchmarkExecution> {
  if (options.outputDirectory.trim().length === 0) {
    throw new RangeError("Benchmark outputDirectory is required");
  }
  const manifest = options.manifest ?? EXECUTABLE_BENCHMARK_MANIFEST;
  validateExecutableBenchmarkManifest(manifest);
  validateBenchmarkProfileUnderTest(options.profileUnderTest);
  const hasCustomExecutor = options.localHarnessExecutor !== undefined;
  if (hasCustomExecutor !== (options.testOnly === true)) {
    throw new Error(
      hasCustomExecutor
        ? "custom benchmark executors require testOnly=true"
        : "testOnly=true requires a custom benchmark executor",
    );
  }
  const localHarnessExecutor = options.localHarnessExecutor ??
    runLocalHarnessObservation;
  const executionMode = hasCustomExecutor
    ? "test_only_custom_executor" as const
    : "default_local_relay" as const;
  const profileBinding = Object.freeze({
    profileUnderTestSha256: options.profileUnderTest.profileUnderTestSha256,
    profileHash: options.profileUnderTest.profileHash,
  });
  const now = options.now ?? (() => Date.now());
  const fixtures = new Map(manifest.fixtures.map((fixture) => [fixture.fixtureId, fixture]));
  const schedules = new Map(manifest.schedules.map((schedule) => [schedule.scheduleId, schedule]));
  const runsDirectory = join(options.outputDirectory, "runs");
  await mkdir(runsDirectory, { recursive: true });

  const markers: BenchmarkRunMarker[] = [];
  const results: BenchmarkRunResult[] = [];
  for (const run of manifest.runs) {
    const startedAt = isoTimestamp(now);
    const markerPath = join(runsDirectory, `${safeRunFileStem(run)}.marker.json`);
    const startedMarker = artifactMarker({
      schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
      manifestSha256: manifest.manifestSha256,
      ...profileBinding,
      runId: run.runId,
      order: run.order,
      stage: run.stage,
      ...(run.arm === undefined ? {} : { arm: run.arm }),
      state: "STARTED",
      startedAt,
    });
    await writeJson(markerPath, startedMarker);

    let result: BenchmarkRunResult;
    if (run.stage === "discovery") {
      result = artifactResult({
        schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
        manifestSha256: manifest.manifestSha256,
        ...profileBinding,
        runId: run.runId,
        order: run.order,
        stage: run.stage,
        acceptanceScope: "paid_discovery_not_executed",
        providerAcceptanceVerdict: "NOT_RUN",
        outcome: "NOT_RUN",
        startedAt,
        completedAt: isoTimestamp(now),
        reason: "paid discovery is available only through the separately budgeted discover command",
      });
    } else if (run.arm !== "GLOSSARY_CONTROLLED") {
      if (run.arm === undefined) throw new Error(`${run.runId} is missing its arm`);
      result = artifactResult({
        schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
        manifestSha256: manifest.manifestSha256,
        ...profileBinding,
        runId: run.runId,
        order: run.order,
        stage: run.stage,
        arm: run.arm,
        acceptanceScope: "external_provider_not_configured",
        providerAcceptanceVerdict: "NOT_RUN",
        outcome: "NOT_RUN",
        startedAt,
        completedAt: isoTimestamp(now),
        reason: `${run.arm} external adapter is not configured for keyless execution`,
      });
    } else {
      try {
        const fixture = run.fixtureId === undefined
          ? undefined
          : requiredFixture(run, fixtures);
        const schedule = run.scheduleId === undefined
          ? undefined
          : requiredSchedule(run, schedules);
        if (
          run.provider === undefined ||
          run.mode === undefined ||
          run.behavior === undefined
        ) {
          throw new Error(`${run.runId} is missing its explicit execution behavior`);
        }
        const observation = await localHarnessExecutor({
          run,
          provider: run.provider,
          mode: run.mode,
          behavior: run.behavior,
          approvedProfile: options.profileUnderTest.profile,
          approvedProfileHash: options.profileUnderTest.profileHash,
          ...(fixture === undefined ? {} : { fixture }),
          ...(schedule === undefined ? {} : { schedule }),
        });
        const evidenceIntegrityPassed = observationEvidenceIntegrityPassed(observation);
        const mechanismPassed = observationMechanismPassed(observation);
        const outcome = !evidenceIntegrityPassed
          ? "INVALID_RUN" as const
          : mechanismPassed
            ? "PASS" as const
            : "FAIL" as const;
        result = artifactResult({
          schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
          manifestSha256: manifest.manifestSha256,
          ...profileBinding,
          runId: run.runId,
          order: run.order,
          stage: run.stage,
          arm: run.arm,
          acceptanceScope: "local_mechanism_only",
          providerAcceptanceVerdict: "NOT_RUN",
          outcome,
          startedAt,
          completedAt: isoTimestamp(now),
          observation,
          ...(outcome === "PASS"
            ? {}
            : {
                reason: outcome === "INVALID_RUN"
                  ? "local evidence integrity validation failed"
                  : "local deterministic observation failed its gate",
              }),
        });
      } catch (error: unknown) {
        const terminalEvidenceIntegrityFailure = error instanceof TerminalEvidenceIntegrityError;
        result = artifactResult({
          schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
          manifestSha256: manifest.manifestSha256,
          ...profileBinding,
          runId: run.runId,
          order: run.order,
          stage: run.stage,
          arm: run.arm,
          acceptanceScope: "local_mechanism_only",
          providerAcceptanceVerdict: "NOT_RUN",
          outcome: terminalEvidenceIntegrityFailure ? "INVALID_RUN" : "FAIL",
          startedAt,
          completedAt: isoTimestamp(now),
          reason: terminalEvidenceIntegrityFailure
            ? TERMINAL_EVIDENCE_INTEGRITY_FAILURE_REASON
            : error instanceof Error
              ? error.message
              : "local deterministic execution failed",
        });
      }
    }
    validateBenchmarkRunResult(result);
    const resultPath = join(runsDirectory, `${safeRunFileStem(run)}.result.json`);
    await writeJson(resultPath, result);

    const marker = artifactMarker({
      schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
      manifestSha256: manifest.manifestSha256,
      ...profileBinding,
      runId: run.runId,
      order: run.order,
      stage: run.stage,
      ...(run.arm === undefined ? {} : { arm: run.arm }),
      state: result.outcome === "PASS"
        ? "COMPLETED"
        : result.outcome === "FAIL"
          ? "FAILED"
          : result.outcome === "INVALID_RUN"
            ? "INVALID_RUN"
            : "NOT_RUN",
      startedAt,
      completedAt: result.completedAt,
      resultSha256: result.resultSha256,
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    });
    validateMarker(marker);
    await writeJson(markerPath, marker);
    markers.push(marker);
    results.push(result);
  }

  const frozenMarkers = deepFreeze([...markers]);
  const frozenResults = deepFreeze([...results]);
  const score = scoreBenchmarkResults(manifest, frozenResults, options.profileUnderTest);
  const profileText = await writeJson(
    join(options.outputDirectory, "profile-under-test.json"),
    options.profileUnderTest,
  );
  const manifestText = await writeJson(
    join(options.outputDirectory, "manifest.json"),
    manifest,
  );
  const markersText = await writeJsonLines(
    join(options.outputDirectory, "run-markers.jsonl"),
    frozenMarkers,
  );
  const resultsText = await writeJsonLines(
    join(options.outputDirectory, "run-results.jsonl"),
    frozenResults,
  );
  const scoreText = await writeJson(join(options.outputDirectory, "score.json"), score);
  const generatedAt = isoTimestamp(now);
  const bundleBody = {
    schemaVersion: BENCHMARK_ARTIFACT_SCHEMA_VERSION,
    kind: "keyless_benchmark_bundle" as const,
    executionMode,
    manifestSha256: manifest.manifestSha256,
    ...profileBinding,
    generatedAt,
    markerCount: frozenMarkers.length,
    resultCount: frozenResults.length,
    markerSetSha256: benchmarkArtifactSha256(frozenMarkers),
    resultSetSha256: benchmarkArtifactSha256(frozenResults),
    scoreSha256: score.scoreSha256,
    productAcceptanceVerdict: "NOT_RUN" as const,
    artifactFiles: deepFreeze({
      profileUnderTest: "profile-under-test.json" as const,
      manifest: "manifest.json" as const,
      markers: "run-markers.jsonl" as const,
      results: "run-results.jsonl" as const,
      score: "score.json" as const,
      checksums: "checksums.sha256" as const,
    }),
  };
  const bundle = deepFreeze({
    ...bundleBody,
    bundleSha256: benchmarkArtifactSha256(bundleBody),
  });
  const bundleText = await writeJson(join(options.outputDirectory, "bundle.json"), bundle);
  const checksums = [
    checksumLine("profile-under-test.json", profileText),
    checksumLine("manifest.json", manifestText),
    checksumLine("run-markers.jsonl", markersText),
    checksumLine("run-results.jsonl", resultsText),
    checksumLine("score.json", scoreText),
    checksumLine("bundle.json", bundleText),
  ].join("\n") + "\n";
  await writeFile(join(options.outputDirectory, "checksums.sha256"), checksums, {
    encoding: "utf8",
    mode: 0o600,
  });

  return deepFreeze({
    profileUnderTest: options.profileUnderTest,
    markers: frozenMarkers,
    results: frozenResults,
    score,
    bundle,
  });
}


function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(label + " is not valid JSON");
  }
}

function parseJsonLines<T>(text: string, label: string): readonly T[] {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  return Object.freeze(lines.map((line, index) =>
    parseJson<T>(line, label + " line " + String(index + 1))
  ));
}

function validateBundle(bundle: KeylessBenchmarkBundle): void {
  const { bundleSha256, ...body } = bundle;
  if (
    bundle.schemaVersion !== BENCHMARK_ARTIFACT_SCHEMA_VERSION ||
    bundle.kind !== "keyless_benchmark_bundle" ||
    (bundle.executionMode !== "default_local_relay" &&
      bundle.executionMode !== "test_only_custom_executor") ||
    bundle.productAcceptanceVerdict !== "NOT_RUN" ||
    !/^[a-f0-9]{64}$/u.test(bundleSha256) ||
    bundleSha256 !== benchmarkArtifactSha256(body) ||
    bundle.artifactFiles.profileUnderTest !== "profile-under-test.json" ||
    bundle.artifactFiles.manifest !== "manifest.json" ||
    bundle.artifactFiles.markers !== "run-markers.jsonl" ||
    bundle.artifactFiles.results !== "run-results.jsonl" ||
    bundle.artifactFiles.score !== "score.json" ||
    bundle.artifactFiles.checksums !== "checksums.sha256"
  ) {
    throw new Error("benchmark bundle artifact mismatch");
  }
}

const CHECKSUM_FILES = Object.freeze([
  "profile-under-test.json",
  "manifest.json",
  "run-markers.jsonl",
  "run-results.jsonl",
  "score.json",
  "bundle.json",
] as const);

function validateChecksums(
  checksumText: string,
  contents: Readonly<Record<(typeof CHECKSUM_FILES)[number], string>>,
): void {
  const entries = checksumText.split(/\r?\n/u).filter((line) => line.length > 0);
  if (entries.length !== CHECKSUM_FILES.length) {
    throw new Error("benchmark checksum set has missing or extra entries");
  }
  const seen = new Set<string>();
  for (const line of entries) {
    const match = /^(?<hash>[a-f0-9]{64})  (?<path>[^\\/]+)$/u.exec(line);
    const path = match?.groups?.path;
    const hash = match?.groups?.hash;
    if (path === undefined || hash === undefined ||
        !CHECKSUM_FILES.includes(path as (typeof CHECKSUM_FILES)[number]) ||
        seen.has(path)) {
      throw new Error("benchmark checksum set contains an invalid entry");
    }
    seen.add(path);
    const actual = createHash("sha256")
      .update(contents[path as (typeof CHECKSUM_FILES)[number]], "utf8")
      .digest("hex");
    if (actual !== hash) throw new Error(path + " checksum mismatch");
  }
  if (CHECKSUM_FILES.some((path) => !seen.has(path))) {
    throw new Error("benchmark checksum set is incomplete");
  }
}

export async function readAndValidateKeylessBenchmark(
  directory: string,
): Promise<KeylessBenchmarkExecution> {
  if (directory.trim().length === 0) {
    throw new RangeError("benchmark directory is required");
  }
  const [profileText, manifestText, markersText, resultsText, scoreText,
    bundleText, checksumsText] = await Promise.all([
    readFile(join(directory, "profile-under-test.json"), "utf8"),
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "run-markers.jsonl"), "utf8"),
    readFile(join(directory, "run-results.jsonl"), "utf8"),
    readFile(join(directory, "score.json"), "utf8"),
    readFile(join(directory, "bundle.json"), "utf8"),
    readFile(join(directory, "checksums.sha256"), "utf8"),
  ]);
  validateChecksums(checksumsText, {
    "profile-under-test.json": profileText,
    "manifest.json": manifestText,
    "run-markers.jsonl": markersText,
    "run-results.jsonl": resultsText,
    "score.json": scoreText,
    "bundle.json": bundleText,
  });

  const profileUnderTest = parseJson<BenchmarkProfileUnderTest>(
    profileText,
    "profile-under-test.json",
  );
  const manifest = parseJson<ExecutableBenchmarkManifest>(
    manifestText,
    "manifest.json",
  );
  const markers = parseJsonLines<BenchmarkRunMarker>(
    markersText,
    "run-markers.jsonl",
  );
  const results = parseJsonLines<BenchmarkRunResult>(
    resultsText,
    "run-results.jsonl",
  );
  const score = parseJson<BenchmarkAcceptanceScore>(scoreText, "score.json");
  const bundle = parseJson<KeylessBenchmarkBundle>(bundleText, "bundle.json");

  validateBenchmarkProfileUnderTest(profileUnderTest);
  validateExecutableBenchmarkManifest(manifest);
  const recomputedScore = scoreBenchmarkResults(manifest, results, profileUnderTest);
  if (benchmarkArtifactSha256(score) !== benchmarkArtifactSha256(recomputedScore)) {
    throw new Error("persisted benchmark score does not match canonical results");
  }
  if (markers.length !== manifest.runs.length) {
    throw new Error("benchmark marker count does not match canonical manifest");
  }
  const markersByRun = new Map<string, BenchmarkRunMarker>();
  const resultsByRun = new Map(results.map((result) => [result.runId, result]));
  for (const marker of markers) {
    validateMarker(marker);
    if (markersByRun.has(marker.runId)) {
      throw new Error("duplicate benchmark marker " + marker.runId);
    }
    markersByRun.set(marker.runId, marker);
  }
  for (const run of manifest.runs) {
    const marker = markersByRun.get(run.runId);
    const result = resultsByRun.get(run.runId);
    if (marker === undefined || result === undefined) {
      throw new Error(run.runId + " is missing a terminal marker or result");
    }
    const expectedState: BenchmarkMarkerState = result.outcome === "PASS"
      ? "COMPLETED"
      : result.outcome === "FAIL"
        ? "FAILED"
        : result.outcome === "INVALID_RUN"
          ? "INVALID_RUN"
          : "NOT_RUN";
    if (
      marker.manifestSha256 !== manifest.manifestSha256 ||
      marker.profileUnderTestSha256 !== profileUnderTest.profileUnderTestSha256 ||
      marker.profileHash !== profileUnderTest.profileHash ||
      marker.order !== run.order ||
      marker.stage !== run.stage ||
      marker.arm !== run.arm ||
      marker.state !== expectedState ||
      marker.resultSha256 !== result.resultSha256 ||
      marker.completedAt !== result.completedAt
    ) {
      throw new Error(run.runId + " marker does not match its canonical result");
    }
  }

  validateBundle(bundle);
  if (
    bundle.manifestSha256 !== manifest.manifestSha256 ||
    bundle.profileUnderTestSha256 !== profileUnderTest.profileUnderTestSha256 ||
    bundle.profileHash !== profileUnderTest.profileHash ||
    bundle.markerCount !== markers.length ||
    bundle.resultCount !== results.length ||
    bundle.markerSetSha256 !== benchmarkArtifactSha256(markers) ||
    bundle.resultSetSha256 !== benchmarkArtifactSha256(results) ||
    bundle.scoreSha256 !== score.scoreSha256
  ) {
    throw new Error("benchmark bundle does not bind its canonical artifacts");
  }
  return deepFreeze({ profileUnderTest, markers, results, score, bundle });
}

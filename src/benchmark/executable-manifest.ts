import { createHash } from "node:crypto";
import { DISCOVERY_CANDIDATES } from "./discovery.js";
import {
  BENCHMARK_MANIFEST,
  BENCHMARK_WORKLOAD,
  type BenchmarkArm,
  type BenchmarkDirection,
} from "./protocol.js";
import {
  resolveTranslationBehavior,
  type TranslationBehavior,
  type TranslationMode,
  type TranslationProviderId,
} from "../core/translation-behavior.js";

export interface ExecutableFixture {
  readonly fixtureId: string;
  readonly direction: BenchmarkDirection;
  readonly scenario: "discovery" | "protected" | "confuser" | "ordinary";
  readonly inputMode: "openai_text_api" | "operator_read_aloud";
  readonly sourceText: string;
  readonly expectedTargetExact: string;
  readonly sourceSha256: string;
  readonly expectedSha256: string;
  readonly fixtureSha256: string;
}

export interface ExecutableSchedule {
  readonly scheduleId: string;
  readonly kind: "interruption" | "continuous_duplex";
  readonly durationMs: number;
  readonly events: readonly Readonly<{
    readonly atMs: number;
    readonly action: "speech_start" | "speech_stop" | "checkpoint";
    readonly side: "A" | "B" | "BOTH";
  }>[];
  readonly scheduleSha256: string;
}

export interface ArmFreeze {
  readonly arm: BenchmarkArm;
  readonly adapterId: string;
  readonly adapterVersion: string;
  /** The concrete provider selected for this arm; never inferred from a profile. */
  readonly provider: TranslationProviderId;
  /** The concrete behavior mode selected for this arm. */
  readonly mode: TranslationMode;
  /** Immutable normalized behavior contract used by the executed session. */
  readonly behavior: TranslationBehavior;
  readonly behaviorSha256: string;
  readonly config: Readonly<Record<string, string>>;
  readonly configSha256: string;
}

export interface ExecutableRun {
  readonly runId: string;
  readonly stage: "discovery" | "formal_terminology" | "latency" | "interruption" | "continuous_duplex";
  readonly order: number;
  readonly fixtureId?: string;
  readonly scheduleId?: string;
  readonly arm?: BenchmarkArm;
  readonly armConfigSha256?: string;
  readonly provider?: TranslationProviderId;
  readonly mode?: TranslationMode;
  readonly behavior?: TranslationBehavior;
  readonly behaviorSha256?: string;
  readonly pairingKey?: string;
  readonly direction?: BenchmarkDirection;
  readonly repeat?: number;
  readonly sourceRun: Readonly<Record<string, unknown>>;
}

export interface ExecutableBenchmarkManifest {
  readonly schemaVersion: 7;
  readonly suiteId: string;
  readonly seed: string;
  readonly fixtures: readonly ExecutableFixture[];
  readonly schedules: readonly ExecutableSchedule[];
  readonly arms: readonly ArmFreeze[];
  readonly evidence: Readonly<{
    readonly requiredEvents: readonly string[];
    /** Keyless runs retain only summary JSONL, never exported raw events or audio. */
    readonly output: "run_results_jsonl_without_event_or_audio_export";
    readonly clock: "harness_monotonic";
    readonly schemaSha256: string;
  }>;
  readonly timing: Readonly<{
    readonly metrics: readonly Readonly<{
      readonly metricId: string;
      readonly startEvent: string;
      readonly endEvent: string;
    }>[];
    readonly latencyRunCount: number;
    readonly glossaryOperationMeasurements: number;
    readonly interruptionRunsPerArm: number;
    readonly soakMinutesPerArm: number;
    readonly scheduleSha256: string;
  }>;
  readonly gates: Readonly<{
    readonly targetExact: "all_bound_committed_terms";
    readonly zeroOpenRegression: true;
    readonly alertsClear: true;
    readonly latencyEvidence: "not_run_without_acoustic_capture";
    readonly bargeInEvidence: "not_run_without_acoustic_capture";
    readonly normalizedEventEvidence: "not_run_without_exported_events_and_four_track_audio";
    readonly noRuntimeHotSwap: true;
    readonly gatesSha256: string;
  }>;
  readonly runs: readonly ExecutableRun[];
  readonly manifestSha256: string;
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

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}
function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function fixture(input: Readonly<{
  fixtureId: string;
  direction: BenchmarkDirection;
  scenario: ExecutableFixture["scenario"];
  sourceText: string;
  inputMode: ExecutableFixture["inputMode"];
  expectedTargetExact: string;
}>): ExecutableFixture {
  const body = {
    ...input,
    sourceSha256: sha256Text(input.sourceText),
    expectedSha256: sha256Text(input.expectedTargetExact),
  };
  return deepFreeze({ ...body, fixtureSha256: sha256(body) });
}

const FORMAL_INPUTS = [
  ["A_TO_B", "protected", "Verify the Abbe offset before release.", "\u{963f}\u{8c9d}\u{504f}\u{79fb}"],
  ["A_TO_B", "protected", "The poka-yoke pin is damaged.", "\u{9632}\u{5446}\u{92b7}\u{5df2}\u{640d}\u{58de}"],
  ["A_TO_B", "confuser", "Do not poke the fixture.", "\u{4e0d}\u{8981}\u{6233}\u{6cbb}\u{5177}"],
  ["A_TO_B", "ordinary", "The machine is ready.", "\u{6a5f}\u{53f0}\u{5df2}\u{5c31}\u{7dd2}"],
  ["B_TO_A", "protected", "\u{8acb}\u{6aa2}\u{67e5}\u{963f}\u{8c9d}\u{8aa4}\u{5dee}\u{3002}", "Check the Abbe error."],
  ["B_TO_A", "protected", "\u{8acb}\u{78ba}\u{8a8d}\u{9632}\u{5446}\u{6cbb}\u{5177}\u{3002}", "Verify the poka-yoke fixture."],
  ["B_TO_A", "confuser", "\u{4e0d}\u{8981}\u{6233}\u{5230}\u{6cbb}\u{5177}\u{3002}", "Do not poke the fixture."],
  ["B_TO_A", "ordinary", "\u{6a5f}\u{53f0}\u{5df2}\u{5c31}\u{7dd2}\u{3002}", "The machine is ready."],
] as const;

const discoveryFixtures = DISCOVERY_CANDIDATES.map((candidate) => fixture({
  fixtureId: `discovery:${candidate.id}`,
  direction: candidate.direction,
  scenario: "discovery",
  inputMode: "openai_text_api",
  sourceText: candidate.sourceSentence,
  expectedTargetExact: candidate.provisionalTargetExact,
}));

const formalFixtures = FORMAL_INPUTS.map((entry, index) => fixture({
  fixtureId: `formal:${entry[0].toLocaleLowerCase("en-US")}:slot-${(index % 4) + 1}`,
  direction: entry[0],
  scenario: entry[1],
  inputMode: "operator_read_aloud",
  sourceText: entry[2],
  expectedTargetExact: entry[3],
}));

const latencyFixtures = (["A_TO_B", "B_TO_A"] as const).flatMap((direction) =>
  (["protected", "ordinary"] as const).map((scenario) => {
    const formal = formalFixtures.find(
      (candidate) => candidate.direction === direction && candidate.scenario === scenario,
    );
    if (formal === undefined) throw new Error(`Missing ${direction} ${scenario} latency fixture`);
    return fixture({
      fixtureId: `latency:${direction.toLocaleLowerCase("en-US")}:${scenario}`,
      direction,
      scenario,
      inputMode: "operator_read_aloud",
      sourceText: formal.sourceText,
      expectedTargetExact: formal.expectedTargetExact,
    });
  }),
);

function schedule(
  scheduleId: string,
  kind: ExecutableSchedule["kind"],
  durationMs: number,
  events: ExecutableSchedule["events"],
): ExecutableSchedule {
  const body = { scheduleId, kind, durationMs, events: deepFreeze([...events]) };
  return deepFreeze({ ...body, scheduleSha256: sha256(body) });
}

const interruptionSchedules = [
  schedule("A_INTERRUPTS_B", "interruption", 4_000, [
    { atMs: 0, action: "speech_start", side: "B" },
    { atMs: 1_500, action: "speech_start", side: "A" },
    { atMs: 2_500, action: "speech_stop", side: "B" },
    { atMs: 3_500, action: "speech_stop", side: "A" },
  ]),
  schedule("B_INTERRUPTS_A", "interruption", 4_000, [
    { atMs: 0, action: "speech_start", side: "A" },
    { atMs: 1_500, action: "speech_start", side: "B" },
    { atMs: 2_500, action: "speech_stop", side: "A" },
    { atMs: 3_500, action: "speech_stop", side: "B" },
  ]),
  schedule("A_TO_B_OVERLAP_2S", "interruption", 4_000, [
    { atMs: 0, action: "speech_start", side: "A" },
    { atMs: 1_000, action: "speech_start", side: "B" },
    { atMs: 3_000, action: "speech_stop", side: "A" },
    { atMs: 4_000, action: "speech_stop", side: "B" },
  ]),
  schedule("B_TO_A_OVERLAP_2S", "interruption", 4_000, [
    { atMs: 0, action: "speech_start", side: "B" },
    { atMs: 1_000, action: "speech_start", side: "A" },
    { atMs: 3_000, action: "speech_stop", side: "B" },
    { atMs: 4_000, action: "speech_stop", side: "A" },
  ]),
];

const soakSchedule = schedule("FULL_DUPLEX_10M", "continuous_duplex", 600_000, [
  { atMs: 0, action: "speech_start", side: "BOTH" },
  { atMs: 300_000, action: "checkpoint", side: "BOTH" },
  { atMs: 600_000, action: "speech_stop", side: "BOTH" },
]);

const ARM_INPUTS: Readonly<Record<BenchmarkArm, Readonly<{
  adapterId: string;
  adapterVersion: string;
  provider: TranslationProviderId;
  mode: TranslationMode;
  config: Readonly<Record<string, string>>;
}>>> = {
  PALABRA_REFERENCE: {
    adapterId: "palabra-reference",
    adapterVersion: "streaming-api-contract-v1",
    provider: "palabra",
    mode: "balanced",
    config: { transport: "webrtc", glossarySnapshot: "required-per-block" },
  },
  OPENAI_NATIVE_TRANSLATE: {
    adapterId: "openai-realtime-translate",
    adapterVersion: "gpt-realtime-translate-contract-v1",
    provider: "openai_native",
    mode: "balanced",
    config: { transport: "dedicated_websocket", model: "gpt-realtime-translate" },
  },
  GLOSSARY_CONTROLLED: {
    adapterId: "central-harness-controlled",
    adapterVersion: "controlled-behavior-contract-v1",
    provider: "openai_controlled",
    mode: "accurate",
    config: { transport: "central-harness", glossaryBinding: "session-start" },
  },
};

const arms = BENCHMARK_WORKLOAD.arms.map((arm): ArmFreeze => {
  const input = ARM_INPUTS[arm];
  return deepFreeze({
    arm,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    provider: input.provider,
    mode: input.mode,
    behavior: resolveTranslationBehavior(input.mode),
    behaviorSha256: sha256(resolveTranslationBehavior(input.mode)),
    config: deepFreeze({ ...input.config }),
    configSha256: sha256(input.config),
  });
});

const evidenceBody = {
  requiredEvents: [
    "speech_onset",
    "source_text_stable",
    "translation_ready",
    "term_bound",
    "target_committed",
    "target_validated",
    "playout_first_sample",
    "aligned_target_audio_onset",
    "queue_sample",
    "barge_in_speech_onset",
    "valid_output_resumed",
    "provider_error",
    "generation_cut",
    "playout_clear",
    "recording_closed",
  ],
  output: "run_results_jsonl_without_event_or_audio_export" as const,
  clock: "harness_monotonic" as const,
};
const evidence = deepFreeze({ ...evidenceBody, schemaSha256: sha256(evidenceBody) });

const timingBody = {
  latencyRunCount: BENCHMARK_WORKLOAD.latencyRunsTotal,
  metrics: [
    { metricId: "speech_to_aligned_ms", startEvent: "speech_onset", endEvent: "aligned_target_audio_onset" },
    { metricId: "stable_source_to_playable_ms", startEvent: "source_text_stable", endEvent: "playout_first_sample" },
    { metricId: "glossary_overhead_ms", startEvent: "translation_ready", endEvent: "target_validated" },
    { metricId: "barge_in_clear_ms", startEvent: "barge_in_speech_onset", endEvent: "playout_clear" },
  ],
  glossaryOperationMeasurements: BENCHMARK_WORKLOAD.latencyRunsTotal,
  interruptionRunsPerArm: BENCHMARK_WORKLOAD.interruptionRunsPerArm,
  soakMinutesPerArm: BENCHMARK_WORKLOAD.continuousDuplexMinutesPerArm,
};
const timing = deepFreeze({ ...timingBody, scheduleSha256: sha256(timingBody) });

const gatesBody = {
  targetExact: "all_bound_committed_terms" as const,
  zeroOpenRegression: true as const,
  alertsClear: true as const,
  latencyEvidence: "not_run_without_acoustic_capture" as const,
  bargeInEvidence: "not_run_without_acoustic_capture" as const,
  normalizedEventEvidence: "not_run_without_exported_events_and_four_track_audio" as const,
  noRuntimeHotSwap: true as const,
};
const gates = deepFreeze({ ...gatesBody, gatesSha256: sha256(gatesBody) });

function armFreeze(arm: BenchmarkArm): ArmFreeze {
  const value = arms.find((candidate) => candidate.arm === arm);
  if (value === undefined) throw new Error(`Missing arm freeze for ${arm}`);
  return value;
}

function runMode(arm: ArmFreeze, stage: ExecutableRun["stage"]): TranslationMode {
  // A ten-minute full-duplex schedule must use the continuous-commit behavior.
  // Formal terminology remains on the arm's accurate final-turn behavior.
  return arm.arm === "GLOSSARY_CONTROLLED" && stage === "continuous_duplex"
    ? "fast"
    : arm.mode;
}

function runBehavior(arm: ArmFreeze, stage: ExecutableRun["stage"]): Readonly<{
  readonly provider: TranslationProviderId;
  readonly mode: TranslationMode;
  readonly behavior: TranslationBehavior;
  readonly behaviorSha256: string;
}> {
  const mode = runMode(arm, stage);
  const behavior = resolveTranslationBehavior(mode);
  return deepFreeze({
    provider: arm.provider,
    mode,
    behavior,
    behaviorSha256: sha256(behavior),
  });
}

function formalFixtureId(direction: BenchmarkDirection, fixtureSlot: number): string {
  return `formal:${direction.toLocaleLowerCase("en-US")}:slot-${fixtureSlot}`;
}

function executableRuns(): readonly ExecutableRun[] {
  const runs: ExecutableRun[] = [];
  let order = 0;
  for (const run of BENCHMARK_MANIFEST.discoveryRuns) {
    const candidates = DISCOVERY_CANDIDATES.filter((candidate) => candidate.direction === run.direction);
    const candidate = candidates[run.candidateSlot - 1];
    if (candidate === undefined) throw new Error(`Missing discovery candidate for ${run.runId}`);
    runs.push(deepFreeze({
      runId: run.runId,
      stage: run.stage,
      order: order += 1,
      fixtureId: `discovery:${candidate.id}`,
      direction: run.direction,
      repeat: run.render,
      pairingKey: `discovery:${candidate.id}:r${run.render}`,
      sourceRun: deepFreeze({ ...run }),
    }));
  }
  for (const run of BENCHMARK_MANIFEST.formalRuns) {
    const arm = armFreeze(run.arm);
    const execution = runBehavior(arm, run.stage);
    runs.push(deepFreeze({
      runId: run.runId,
      stage: run.stage,
      order: order += 1,
      fixtureId: formalFixtureId(run.direction, run.fixtureSlot),
      arm: run.arm,
      armConfigSha256: arm.configSha256,
      ...execution,
      direction: run.direction,
      pairingKey: `formal:${run.direction}:${run.fixtureSlot}`,
      sourceRun: deepFreeze({ ...run }),
    }));
  }
  for (const run of BENCHMARK_MANIFEST.latencyRuns) {
    const arm = armFreeze(run.arm);
    const execution = runBehavior(arm, run.stage);
    runs.push(deepFreeze({
      runId: run.runId,
      stage: run.stage,
      order: order += 1,
      fixtureId: `latency:${run.direction.toLocaleLowerCase("en-US")}:${run.scenario}`,
      arm: run.arm,
      armConfigSha256: arm.configSha256,
      ...execution,
      direction: run.direction,
      repeat: run.repeat,
      pairingKey: `latency:${run.direction}:${run.scenario}:r${run.repeat}`,
      sourceRun: deepFreeze({ ...run }),
    }));
  }
  for (const run of BENCHMARK_MANIFEST.interruptionRuns) {
    const arm = armFreeze(run.arm);
    const execution = runBehavior(arm, run.stage);
    runs.push(deepFreeze({
      runId: run.runId,
      stage: run.stage,
      order: order += 1,
      scheduleId: run.scenario,
      arm: run.arm,
      armConfigSha256: arm.configSha256,
      ...execution,
      repeat: run.repeat,
      pairingKey: `interruption:${run.scenario}:r${run.repeat}`,
      sourceRun: deepFreeze({ ...run }),
    }));
  }
  for (const run of BENCHMARK_MANIFEST.soakRuns) {
    const arm = armFreeze(run.arm);
    const execution = runBehavior(arm, run.stage);
    runs.push(deepFreeze({
      runId: run.runId,
      stage: run.stage,
      order: order += 1,
      scheduleId: soakSchedule.scheduleId,
      arm: run.arm,
      armConfigSha256: arm.configSha256,
      ...execution,
      pairingKey: "soak:full-duplex-10m",
      sourceRun: deepFreeze({ ...run }),
    }));
  }
  return deepFreeze(runs);
}

export function createExecutableBenchmarkManifest(): ExecutableBenchmarkManifest {
  const body = {
    schemaVersion: 7 as const,
    suiteId: "fast-translation-normalized-contract-v7",
    seed: "fast-translation-fixed-seed-v7",
    fixtures: deepFreeze([...discoveryFixtures, ...formalFixtures, ...latencyFixtures]),
    schedules: deepFreeze([...interruptionSchedules, soakSchedule]),
    arms: deepFreeze([...arms]),
    evidence,
    timing,
    gates,
    runs: executableRuns(),
  };
  return deepFreeze({ ...body, manifestSha256: sha256(body) });
}

export const EXECUTABLE_BENCHMARK_MANIFEST = createExecutableBenchmarkManifest();

function requireHash(actual: string, expected: string, label: string): void {
  if (actual !== expected || !/^[a-f0-9]{64}$/u.test(actual)) {
    throw new Error(`${label} hash mismatch`);
  }
}

export function validateExecutableBenchmarkManifest(
  manifest: ExecutableBenchmarkManifest = EXECUTABLE_BENCHMARK_MANIFEST,
): void {
  const { manifestSha256, ...body } = manifest;
  if (manifest.schemaVersion !== 7) {
    throw new Error("Unsupported executable benchmark manifest schema version");
  }
  requireHash(manifestSha256, sha256(body), "manifest");
  const canonicalFixtureById = new Map(
    [...discoveryFixtures, ...formalFixtures, ...latencyFixtures].map(
      (candidate) => [candidate.fixtureId, candidate] as const,
    ),
  );
  if (manifest.fixtures.length !== canonicalFixtureById.size) {
    throw new Error("Executable fixture allocation mismatch");
  }
  const fixtureIds = new Set<string>();
  for (const candidate of manifest.fixtures) {
    if (fixtureIds.has(candidate.fixtureId)) throw new Error(`Duplicate fixture ${candidate.fixtureId}`);
    fixtureIds.add(candidate.fixtureId);
    requireHash(candidate.sourceSha256, sha256Text(candidate.sourceText), candidate.fixtureId);
    requireHash(candidate.expectedSha256, sha256Text(candidate.expectedTargetExact), candidate.fixtureId);
    const { fixtureSha256, ...fixtureBody } = candidate;
    requireHash(fixtureSha256, sha256(fixtureBody), candidate.fixtureId);
    const canonicalFixture = canonicalFixtureById.get(candidate.fixtureId);
    if (canonicalFixture === undefined || sha256(candidate) !== sha256(canonicalFixture)) {
      throw new Error(`Fixture semantics mismatch: ${candidate.fixtureId}`);
    }
  }
  const canonicalScheduleById = new Map(
    [...interruptionSchedules, soakSchedule].map(
      (candidate) => [candidate.scheduleId, candidate] as const,
    ),
  );
  if (manifest.schedules.length !== canonicalScheduleById.size) {
    throw new Error("Executable schedule allocation mismatch");
  }
  const scheduleIds = new Set<string>();
  for (const candidate of manifest.schedules) {
    if (scheduleIds.has(candidate.scheduleId)) throw new Error(`Duplicate schedule ${candidate.scheduleId}`);
    scheduleIds.add(candidate.scheduleId);
    const { scheduleSha256, ...scheduleBody } = candidate;
    requireHash(scheduleSha256, sha256(scheduleBody), candidate.scheduleId);
    const canonicalSchedule = canonicalScheduleById.get(candidate.scheduleId);
    if (canonicalSchedule === undefined || sha256(candidate) !== sha256(canonicalSchedule)) {
      throw new Error(`Schedule semantics mismatch: ${candidate.scheduleId}`);
    }
    if (!Number.isSafeInteger(candidate.durationMs) || candidate.durationMs <= 0) {
      throw new Error(`Invalid schedule duration ${candidate.scheduleId}`);
    }
    let previousAtMs = -1;
    for (const event of candidate.events) {
      if (!Number.isSafeInteger(event.atMs) || event.atMs < previousAtMs || event.atMs > candidate.durationMs) {
        throw new Error(`Invalid schedule event order ${candidate.scheduleId}`);
      }
      previousAtMs = event.atMs;
    }
  }
  const armById = new Map(manifest.arms.map((arm) => [arm.arm, arm]));
  if (
    manifest.arms.length !== arms.length ||
    armById.size !== arms.length ||
    sha256(manifest.arms) !== sha256(arms)
  ) {
    throw new Error("Executable arm allocation or semantics mismatch");
  }
  for (const arm of manifest.arms) {
    requireHash(arm.configSha256, sha256(arm.config), `${arm.arm} config`);
    requireHash(arm.behaviorSha256, sha256(arm.behavior), `${arm.arm} behavior`);
    if (
      arm.behavior.mode !== arm.mode ||
      sha256(arm.behavior) !== sha256(resolveTranslationBehavior(arm.mode))
    ) {
      throw new Error(`${arm.arm} behavior does not match its selected mode`);
    }
    const canonicalArm = arms.find((candidate) => candidate.arm === arm.arm);
    if (canonicalArm === undefined || sha256(arm) !== sha256(canonicalArm)) {
      throw new Error(`Arm semantics mismatch: ${arm.arm}`);
    }
  }
  const { schemaSha256, ...suppliedEvidenceBody } = manifest.evidence;
  requireHash(schemaSha256, sha256(suppliedEvidenceBody), "evidence schema");
  if (sha256(manifest.evidence) !== sha256(evidence)) {
    throw new Error("Evidence semantics mismatch");
  }
  const { scheduleSha256, ...suppliedTimingBody } = manifest.timing;
  requireHash(scheduleSha256, sha256(suppliedTimingBody), "timing schedule");
  if (sha256(manifest.timing) !== sha256(timing)) {
    throw new Error("Timing semantics mismatch");
  }
  const { gatesSha256, ...suppliedGatesBody } = manifest.gates;
  requireHash(gatesSha256, sha256(suppliedGatesBody), "gates");
  if (sha256(manifest.gates) !== sha256(gates)) {
    throw new Error("Gate semantics mismatch");
  }
  const canonicalRuns = executableRuns();
  if (manifest.runs.length !== canonicalRuns.length) {
    throw new Error("Executable run count mismatch");
  }
  const runIds = new Set<string>();
  for (const [index, run] of manifest.runs.entries()) {
    const canonicalRun = canonicalRuns[index];
    if (canonicalRun === undefined || sha256(run) !== sha256(canonicalRun)) {
      throw new Error(`run semantics mismatch: ${run.runId}`);
    }
    if (run.order !== index + 1) throw new Error("Run order must be contiguous and deterministic");
    if (runIds.has(run.runId)) throw new Error(`Duplicate run ${run.runId}`);
    runIds.add(run.runId);
    if (run.fixtureId !== undefined && !fixtureIds.has(run.fixtureId)) {
      throw new Error(`Unknown fixture ${run.fixtureId}`);
    }
    if (run.scheduleId !== undefined && !scheduleIds.has(run.scheduleId)) {
      throw new Error(`Unknown schedule ${run.scheduleId}`);
    }
    if (run.arm !== undefined) {
      const arm = armById.get(run.arm);
      if (arm === undefined) throw new Error(`Unknown arm ${run.arm}`);
      requireHash(run.armConfigSha256 ?? "", arm.configSha256, `${run.runId} config`);
      const execution = runBehavior(arm, run.stage);
      if (
        run.provider !== execution.provider ||
        run.mode !== execution.mode ||
        sha256(run.behavior) !== sha256(execution.behavior)
      ) {
        throw new Error(`${run.runId} execution behavior does not match its case`);
      }
      requireHash(run.behaviorSha256 ?? "", execution.behaviorSha256, `${run.runId} behavior`);
    }
  }
  const expectedRuns =
    BENCHMARK_MANIFEST.discoveryRuns.length +
    BENCHMARK_MANIFEST.formalRuns.length +
    BENCHMARK_MANIFEST.latencyRuns.length +
    BENCHMARK_MANIFEST.interruptionRuns.length +
    BENCHMARK_MANIFEST.soakRuns.length;
  if (manifest.runs.length !== expectedRuns) throw new Error("Executable run count mismatch");
  const stageCounts = new Map<ExecutableRun["stage"], number>();
  for (const run of manifest.runs) stageCounts.set(run.stage, (stageCounts.get(run.stage) ?? 0) + 1);
  const expectedStageCounts: readonly (readonly [ExecutableRun["stage"], number])[] = [
    ["discovery", BENCHMARK_MANIFEST.discoveryRuns.length],
    ["formal_terminology", BENCHMARK_MANIFEST.formalRuns.length],
    ["latency", BENCHMARK_MANIFEST.latencyRuns.length],
    ["interruption", BENCHMARK_MANIFEST.interruptionRuns.length],
    ["continuous_duplex", BENCHMARK_MANIFEST.soakRuns.length],
  ];
  for (const [stage, expected] of expectedStageCounts) {
    if (stageCounts.get(stage) !== expected) throw new Error(`${stage} run count mismatch`);
  }
  const latencyPairArms = new Map<string, Set<BenchmarkArm>>();
  for (const run of manifest.runs.filter((candidate) => candidate.stage === "latency")) {
    const key = run.pairingKey ?? "";
    if (run.arm === undefined) throw new Error("Every latency run must identify an arm");
    const pairedArms = latencyPairArms.get(key) ?? new Set<BenchmarkArm>();
    if (pairedArms.has(run.arm)) {
      throw new Error("Every latency pairing key must contain one distinct run per arm");
    }
    pairedArms.add(run.arm);
    latencyPairArms.set(key, pairedArms);
  }
  if ([...latencyPairArms.values()].some((pairedArms) =>
    pairedArms.size !== BENCHMARK_WORKLOAD.arms.length
  )) {
    throw new Error("Every latency pairing key must include all three distinct arms");
  }
  const { manifestSha256: _canonicalManifestHash, ...canonicalBody } =
    EXECUTABLE_BENCHMARK_MANIFEST;
  if (sha256(body) !== sha256(canonicalBody)) {
    throw new Error("canonical manifest semantics mismatch");
  }
}

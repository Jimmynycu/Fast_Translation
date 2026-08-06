const BENCHMARK_ARMS = Object.freeze([
  "PALABRA_REFERENCE",
  "OPENAI_NATIVE_TRANSLATE",
  "GLOSSARY_CONTROLLED",
] as const);

export const BENCHMARK_WORKLOAD = Object.freeze({
  arms: BENCHMARK_ARMS,
  discoveryCandidatesPerDirection: 10,
  discoveryRendersPerCandidate: 3,
  formalTerminologyCasesTotal: 24,
  latencyRunsTotal: 36,
  interruptionRunsPerArm: 20,
  continuousDuplexMinutesPerArm: 10,
});

export type BenchmarkArm = (typeof BENCHMARK_WORKLOAD.arms)[number];
export type BenchmarkDirection = "A_TO_B" | "B_TO_A";

export interface DiscoveryRun {
  readonly runId: string;
  readonly stage: "discovery";
  readonly direction: BenchmarkDirection;
  readonly candidateSlot: number;
  readonly render: number;
}

export interface FormalRun {
  readonly runId: string;
  readonly stage: "formal_terminology";
  readonly arm: BenchmarkArm;
  readonly direction: BenchmarkDirection;
  readonly scenario:
    | "protected_positive"
    | "confuser_negative"
    | "ordinary_smoke";
  readonly fixtureSlot: number;
}

export interface LatencyRun {
  readonly runId: string;
  readonly stage: "latency";
  readonly arm: BenchmarkArm;
  readonly direction: BenchmarkDirection;
  readonly scenario: "protected" | "ordinary";
  readonly repeat: number;
}

export interface InterruptionRun {
  readonly runId: string;
  readonly stage: "interruption";
  readonly arm: BenchmarkArm;
  readonly scenario:
    | "A_INTERRUPTS_B"
    | "B_INTERRUPTS_A"
    | "A_TO_B_OVERLAP_2S"
    | "B_TO_A_OVERLAP_2S";
  readonly repeat: number;
}

export interface SoakRun {
  readonly runId: string;
  readonly stage: "continuous_duplex";
  readonly arm: BenchmarkArm;
  readonly durationMinutes: number;
}

export interface BenchmarkManifest {
  readonly schemaVersion: 1;
  readonly discoveryRuns: readonly DiscoveryRun[];
  readonly formalRuns: readonly FormalRun[];
  readonly latencyRuns: readonly LatencyRun[];
  readonly interruptionRuns: readonly InterruptionRun[];
  readonly soakRuns: readonly SoakRun[];
}

const DIRECTIONS = ["A_TO_B", "B_TO_A"] as const;
const FORMAL_SCENARIOS = [
  "protected_positive",
  "protected_positive",
  "confuser_negative",
  "ordinary_smoke",
] as const;
const LATENCY_SCENARIOS = ["protected", "ordinary"] as const;
const INTERRUPTION_SCENARIOS = [
  "A_INTERRUPTS_B",
  "B_INTERRUPTS_A",
  "A_TO_B_OVERLAP_2S",
  "B_TO_A_OVERLAP_2S",
] as const;

function armId(arm: BenchmarkArm): string {
  return arm.toLocaleLowerCase("en-US").replaceAll("_", "-");
}

function createBenchmarkManifest(): BenchmarkManifest {
  const discoveryRuns: DiscoveryRun[] = [];
  for (const direction of DIRECTIONS) {
    for (
      let candidateSlot = 1;
      candidateSlot <= BENCHMARK_WORKLOAD.discoveryCandidatesPerDirection;
      candidateSlot += 1
    ) {
      for (
        let render = 1;
        render <= BENCHMARK_WORKLOAD.discoveryRendersPerCandidate;
        render += 1
      ) {
        discoveryRuns.push(Object.freeze({
          runId: `discovery-${direction.toLocaleLowerCase("en-US")}-c${candidateSlot}-r${render}`,
          stage: "discovery",
          direction,
          candidateSlot,
          render,
        }));
      }
    }
  }

  const formalRuns: FormalRun[] = [];
  for (const arm of BENCHMARK_WORKLOAD.arms) {
    for (const direction of DIRECTIONS) {
      for (let fixtureSlot = 1; fixtureSlot <= FORMAL_SCENARIOS.length; fixtureSlot += 1) {
        const scenario = FORMAL_SCENARIOS[fixtureSlot - 1];
        if (scenario === undefined) throw new Error("Formal scenario allocation is incomplete");
        formalRuns.push(Object.freeze({
          runId:
            `formal-${armId(arm)}-${direction.toLocaleLowerCase("en-US")}-` +
            `${scenario}-${fixtureSlot}`,
          stage: "formal_terminology",
          arm,
          direction,
          scenario,
          fixtureSlot,
        }));
      }
    }
  }

  const latencyRuns: LatencyRun[] = [];
  for (const arm of BENCHMARK_WORKLOAD.arms) {
    for (const direction of DIRECTIONS) {
      for (const scenario of LATENCY_SCENARIOS) {
        for (let repeat = 1; repeat <= 3; repeat += 1) {
          latencyRuns.push(Object.freeze({
            runId:
              `latency-${armId(arm)}-${direction.toLocaleLowerCase("en-US")}-` +
              `${scenario}-r${repeat}`,
            stage: "latency",
            arm,
            direction,
            scenario,
            repeat,
          }));
        }
      }
    }
  }

  const interruptionRuns: InterruptionRun[] = [];
  for (const arm of BENCHMARK_WORKLOAD.arms) {
    for (const scenario of INTERRUPTION_SCENARIOS) {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        interruptionRuns.push(Object.freeze({
          runId: `interruption-${armId(arm)}-${scenario.toLocaleLowerCase("en-US")}-r${repeat}`,
          stage: "interruption",
          arm,
          scenario,
          repeat,
        }));
      }
    }
  }

  const soakRuns = BENCHMARK_WORKLOAD.arms.map((arm): SoakRun =>
    Object.freeze({
      runId: `soak-${armId(arm)}-${BENCHMARK_WORKLOAD.continuousDuplexMinutesPerArm}m`,
      stage: "continuous_duplex",
      arm,
      durationMinutes: BENCHMARK_WORKLOAD.continuousDuplexMinutesPerArm,
    })
  );

  return Object.freeze({
    schemaVersion: 1,
    discoveryRuns: Object.freeze(discoveryRuns),
    formalRuns: Object.freeze(formalRuns),
    latencyRuns: Object.freeze(latencyRuns),
    interruptionRuns: Object.freeze(interruptionRuns),
    soakRuns: Object.freeze(soakRuns),
  });
}

export const BENCHMARK_MANIFEST = createBenchmarkManifest();

function requireCount(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} allocation is ${actual}; expected ${expected}`);
  }
}

export function validateBenchmarkWorkload(): void {
  requireCount(
    BENCHMARK_MANIFEST.discoveryRuns.length,
    BENCHMARK_WORKLOAD.discoveryCandidatesPerDirection *
      BENCHMARK_WORKLOAD.discoveryRendersPerCandidate *
      DIRECTIONS.length,
    "Discovery",
  );
  requireCount(
    BENCHMARK_MANIFEST.formalRuns.length,
    BENCHMARK_WORKLOAD.formalTerminologyCasesTotal,
    "Formal terminology",
  );
  requireCount(
    BENCHMARK_MANIFEST.latencyRuns.length,
    BENCHMARK_WORKLOAD.latencyRunsTotal,
    "Latency",
  );
  requireCount(
    BENCHMARK_MANIFEST.interruptionRuns.length,
    BENCHMARK_WORKLOAD.interruptionRunsPerArm * BENCHMARK_WORKLOAD.arms.length,
    "Interruption",
  );
  requireCount(BENCHMARK_MANIFEST.soakRuns.length, BENCHMARK_WORKLOAD.arms.length, "Soak");

  for (const arm of BENCHMARK_WORKLOAD.arms) {
    requireCount(
      BENCHMARK_MANIFEST.formalRuns.filter((run) => run.arm === arm).length,
      BENCHMARK_WORKLOAD.formalTerminologyCasesTotal / BENCHMARK_WORKLOAD.arms.length,
      `${arm} formal`,
    );
    requireCount(
      BENCHMARK_MANIFEST.latencyRuns.filter((run) => run.arm === arm).length,
      BENCHMARK_WORKLOAD.latencyRunsTotal / BENCHMARK_WORKLOAD.arms.length,
      `${arm} latency`,
    );
    requireCount(
      BENCHMARK_MANIFEST.interruptionRuns.filter((run) => run.arm === arm).length,
      BENCHMARK_WORKLOAD.interruptionRunsPerArm,
      `${arm} interruption`,
    );
  }

  const allRuns = [
    ...BENCHMARK_MANIFEST.discoveryRuns,
    ...BENCHMARK_MANIFEST.formalRuns,
    ...BENCHMARK_MANIFEST.latencyRuns,
    ...BENCHMARK_MANIFEST.interruptionRuns,
    ...BENCHMARK_MANIFEST.soakRuns,
  ];
  if (new Set(allRuns.map((run) => run.runId)).size !== allRuns.length) {
    throw new Error("Benchmark run IDs must be globally unique");
  }
}

export type PercentileSummary = Readonly<{
  count: number;
  minimum: number;
  p50: number;
  p95: number;
  p99: number;
  maximum: number;
}>;

function requireFiniteSamples(samples: readonly number[]): readonly number[] {
  if (samples.length === 0) {
    throw new RangeError("At least one sample is required");
  }
  if (samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new RangeError("Latency samples must be finite, non-negative numbers");
  }
  return [...samples].sort((left, right) => left - right);
}

/** Nearest-rank percentile, chosen because every reported value is observed. */
export function percentile(samples: readonly number[], probability: number): number {
  const sorted = requireFiniteSamples(samples);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError("Percentile probability must be between zero and one");
  }
  if (probability === 0) return sorted[0] ?? 0;
  const rank = Math.ceil(probability * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}

export function summarizeLatencies(samples: readonly number[]): PercentileSummary {
  const sorted = requireFiniteSamples(samples);
  return Object.freeze({
    count: sorted.length,
    minimum: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    maximum: sorted.at(-1) ?? 0,
  });
}

export type TerminologyObservation = Readonly<{
  caseId: string;
  direction: "A_TO_B" | "B_TO_A";
  expectedTargetExact: string;
  actualTargetText: string;
  isPositive: boolean;
  alertCodes: readonly string[];
}>;

export type TerminologyVerdict = Readonly<{
  passed: boolean;
  positiveCount: number;
  positiveExactCount: number;
  falsePositiveCount: number;
  failures: readonly string[];
}>;

export function evaluateTerminology(observations: readonly TerminologyObservation[]): TerminologyVerdict {
  const positive = observations.filter((observation) => observation.isPositive);
  const positiveExact = positive.filter(
    (observation) => observation.actualTargetText.includes(observation.expectedTargetExact),
  );
  const falsePositive = observations.filter(
    (observation) =>
      !observation.isPositive &&
      observation.expectedTargetExact.length > 0 &&
      observation.actualTargetText.includes(observation.expectedTargetExact),
  );

  const failures = [
    ...positive
      .filter((observation) => !observation.actualTargetText.includes(observation.expectedTargetExact))
      .map((observation) => `${observation.caseId}: target_exact missing`),
    ...falsePositive.map((observation) => `${observation.caseId}: false positive replacement`),
  ];

  return Object.freeze({
    passed: failures.length === 0 && positive.length > 0,
    positiveCount: positive.length,
    positiveExactCount: positiveExact.length,
    falsePositiveCount: falsePositive.length,
    failures: Object.freeze(failures),
  });
}

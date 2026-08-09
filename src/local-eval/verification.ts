export const EVALUATION_VERDICTS = ["PASS", "FAIL", "NOT_RUN"] as const;
export type EvaluationVerdict = (typeof EVALUATION_VERDICTS)[number];

export interface LocalEvalVerification {
  readonly mechanism: EvaluationVerdict;
  readonly liveProvider: EvaluationVerdict;
  readonly overall: EvaluationVerdict;
  readonly liveProviderRequiredServerKey: true;
}

function validVerdict(value: string): value is EvaluationVerdict {
  return EVALUATION_VERDICTS.some((candidate) => candidate === value);
}

/**
 * FAIL has priority; PASS is possible only when every required verdict is
 * PASS. A missing or deliberately unrun live-provider evaluation therefore
 * remains NOT_RUN rather than being promoted by a keyless mechanism check.
 */
export function aggregateEvaluationVerdicts(
  verdicts: readonly EvaluationVerdict[],
): EvaluationVerdict {
  if (verdicts.length === 0) return "NOT_RUN";
  if (verdicts.some((verdict) => verdict === "FAIL")) return "FAIL";
  if (verdicts.every((verdict) => verdict === "PASS")) return "PASS";
  return "NOT_RUN";
}

export function createKeylessLocalEvalVerification(
  mechanism: EvaluationVerdict,
): LocalEvalVerification {
  if (!validVerdict(mechanism)) throw new TypeError("mechanism verdict is invalid");
  const liveProvider = "NOT_RUN" as const;
  return Object.freeze({
    mechanism,
    liveProvider,
    overall: aggregateEvaluationVerdicts([mechanism, liveProvider]),
    liveProviderRequiredServerKey: true,
  });
}

/**
 * A live-provider outcome can only be recorded by a server process that has
 * supplied a non-empty provider credential. The credential is intentionally
 * not retained in the result or any evidence artifact.
 */
export function recordLiveProviderVerification(
  serverApiKey: string,
  passed: boolean,
): EvaluationVerdict {
  if (serverApiKey.trim().length === 0) {
    throw new TypeError("A server API key is required for live provider verification");
  }
  return passed ? "PASS" : "FAIL";
}

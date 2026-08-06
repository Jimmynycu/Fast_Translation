import {
  authorizedOperationCost,
  dispatchBudgetedOperation,
  type BudgetOperationGrant,
} from "./operation-budget.js";
import { BENCHMARK_WORKLOAD } from "./protocol.js";

export interface DiscoveryCandidate {
  readonly id: string;
  readonly direction: "A_TO_B" | "B_TO_A";
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly sourceTerm: string;
  readonly provisionalTargetExact: string;
  readonly sourceSentence: string;
  readonly approvalStatus: "candidate_only";
  readonly dataClass: "open_data";
}

const englishToChinese = [
  ["abbe-error", "Abbe error", "\u{963f}\u{8c9d}\u{8aa4}\u{5dee}", "Compensate for Abbe error before releasing the measurement report."],
  ["poka-yoke", "poka-yoke", "\u{9632}\u{5446}", "Verify the poka-yoke fixture before the next lot."],
  ["jidoka", "jidoka", "\u{81ea}\u{50cd}\u{5316}", "The jidoka stop must trigger before the defect leaves this station."],
  ["gage-rr", "gage repeatability and reproducibility", "\u{91cf}\u{5177}\u{91cd}\u{8907}\u{6027}\u{8207}\u{518d}\u{73fe}\u{6027}", "Repeat the gage repeatability and reproducibility study with three operators."],
  ["gdt", "geometric dimensioning and tolerancing", "\u{5e7e}\u{4f55}\u{5c3a}\u{5bf8}\u{8207}\u{516c}\u{5dee}", "Review the geometric dimensioning and tolerancing callout on datum B."],
  ["tir", "total indicated runout", "\u{7e3d}\u{6307}\u{793a}\u{8df3}\u{52d5}", "Record the total indicated runout at maximum spindle speed."],
  ["torque-angle-yield", "torque-angle yield control", "\u{626d}\u{77e9}\u{8f49}\u{89d2}\u{5c48}\u{670d}\u{63a7}\u{5236}", "Enable torque-angle yield control for the critical fastener."],
  ["oee", "overall equipment effectiveness", "\u{6574}\u{9ad4}\u{8a2d}\u{5099}\u{6548}\u{7387}", "The overall equipment effectiveness loss came from micro-stops."],
  ["fai", "first article inspection", "\u{9996}\u{4ef6}\u{6aa2}\u{9a57}", "Hold production until the first article inspection is approved."],
  ["ncmr", "non-conforming material report", "\u{4e0d}\u{5408}\u{683c}\u{6750}\u{6599}\u{5831}\u{544a}", "Attach the lot genealogy to the non-conforming material report."],
] as const;

export const DISCOVERY_CANDIDATES: readonly DiscoveryCandidate[] = Object.freeze([
  ...englishToChinese.map(([id, sourceTerm, target, sentence]) =>
    Object.freeze({
      id: `en-zh-${id}`,
      direction: "A_TO_B" as const,
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
      sourceTerm,
      provisionalTargetExact: target,
      sourceSentence: sentence,
      dataClass: "open_data" as const,
      approvalStatus: "candidate_only" as const,
    }),
  ),
  ...englishToChinese.map(([id, english, chinese]) =>
    Object.freeze({
      id: `zh-en-${id}`,
      direction: "B_TO_A" as const,
      sourceLanguage: "zh-TW",
      targetLanguage: "en-US",
      sourceTerm: chinese,
      provisionalTargetExact: english,
      sourceSentence: `\u{8acb}\u{78ba}\u{8a8d}\u{300c}${chinese}\u{300d}\u{9019}\u{500b}\u{88fd}\u{9020}\u{8853}\u{8a9e}\u{ff0c}\u{4e26}\u{628a}\u{7d50}\u{679c}\u{8a18}\u{9304}\u{5728}\u{672c}\u{6279}\u{6b21}\u{5831}\u{544a}\u{3002}`,
      dataClass: "open_data" as const,
      approvalStatus: "candidate_only" as const,
    }),
  ),
]);

export interface DiscoveryFailure extends DiscoveryCandidate {
  readonly baselineOutputs: readonly string[];
  readonly wrongRenderCount: number;
  readonly renderCount: number;
  readonly reason: "target_exact_missing";
}

export interface DiscoveryProvenance {
  readonly sourceSet: string;
  readonly provider: string;
  readonly model: string;
  readonly configuration: Readonly<Record<string, string>>;
}

export interface DiscoveryCandidateEvidence extends DiscoveryCandidate {
  readonly baselineOutputs: readonly string[];
  readonly wrongRenderCount: number;
  readonly renderCount: number;
  readonly decision: "retained_failure" | "rejected";
  readonly reason:
    | "target_exact_missing_majority"
    | "target_exact_missing_not_reproducible"
    | "target_exact_present_all_renders";
}

export interface DiscoveryReport {
  readonly dataClass: "open_data";
  readonly provenance: DiscoveryProvenance;
  readonly rendersPerCandidate: number;
  readonly requiredWrongRenders: number;
  readonly totalRenderCount: number;
  readonly candidateEvidence: readonly DiscoveryCandidateEvidence[];
  readonly failures: readonly DiscoveryFailure[];
}

const DEFAULT_PROVENANCE: DiscoveryProvenance = Object.freeze({
  sourceSet: "builtin-manufacturing-candidates-v1",
  provider: "injected-baseline",
  model: "unspecified",
  configuration: Object.freeze({}),
});

export type BaselineTranslator = (
  candidate: DiscoveryCandidate,
  render: number,
) => Promise<string>;

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}

export async function runTerminologyDiscovery(
  translate: BaselineTranslator,
  candidates: readonly DiscoveryCandidate[] = DISCOVERY_CANDIDATES,
  rendersPerCandidate: number = BENCHMARK_WORKLOAD.discoveryRendersPerCandidate,
  provenance: DiscoveryProvenance = DEFAULT_PROVENANCE,
): Promise<DiscoveryReport> {
  if (!Number.isSafeInteger(rendersPerCandidate) || rendersPerCandidate < 1) {
    throw new RangeError("rendersPerCandidate must be a positive safe integer");
  }
  const requiredWrongRenders = Math.floor(rendersPerCandidate / 2) + 1;
  const failures: DiscoveryFailure[] = [];
  const candidateEvidence: DiscoveryCandidateEvidence[] = [];
  for (const candidate of candidates) {
    if (candidate.dataClass !== "open_data") {
      throw new TypeError("Discovery failure mining accepts open_data candidates only");
    }
    const baselineOutputs: string[] = [];
    let wrongRenderCount = 0;
    for (let render = 1; render <= rendersPerCandidate; render += 1) {
      const baselineOutput = await translate(candidate, render);
      baselineOutputs.push(baselineOutput);
      if (!normalized(baselineOutput).includes(normalized(candidate.provisionalTargetExact))) {
        wrongRenderCount += 1;
      }
    }
    const decision = wrongRenderCount >= requiredWrongRenders
      ? "retained_failure" as const
      : "rejected" as const;
    const reason = wrongRenderCount >= requiredWrongRenders
      ? "target_exact_missing_majority" as const
      : wrongRenderCount > 0
        ? "target_exact_missing_not_reproducible" as const
        : "target_exact_present_all_renders" as const;
    candidateEvidence.push(Object.freeze({
      ...candidate,
      baselineOutputs: Object.freeze([...baselineOutputs]),
      wrongRenderCount,
      renderCount: rendersPerCandidate,
      decision,
      reason,
    }));
    if (wrongRenderCount >= requiredWrongRenders) {
      failures.push(Object.freeze({
        ...candidate,
        baselineOutputs: Object.freeze(baselineOutputs),
        wrongRenderCount,
        renderCount: rendersPerCandidate,
        reason: "target_exact_missing",
      }));
    }
  }
  return Object.freeze({
    dataClass: "open_data",
    provenance: Object.freeze({
      ...provenance,
      configuration: Object.freeze({ ...provenance.configuration }),
    }),
    rendersPerCandidate,
    requiredWrongRenders,
    totalRenderCount: candidates.length * rendersPerCandidate,
    candidateEvidence: Object.freeze(candidateEvidence),
    failures: Object.freeze(failures),
  });
}
export interface DiscoveryExecutionBudget {
  readonly maxElapsedMs: number;
  readonly perCallTimeoutMs: number;
  readonly maxCostUsd: number;
  readonly maxCostUsdPerCall: number;
  readonly maxOutputTokens: number;
}

export const DEFAULT_DISCOVERY_EXECUTION_BUDGET: DiscoveryExecutionBudget = Object.freeze({
  maxElapsedMs: 5 * 60 * 1_000,
  perCallTimeoutMs: 15_000,
  maxCostUsd: 3,
  maxCostUsdPerCall: 0.05,
  maxOutputTokens: 128,
});

export interface DiscoveryTranslationGrant extends BudgetOperationGrant {
  readonly maxOutputTokens: number;
}

export interface BudgetedDiscoveryTranslation {
  readonly output: string;
  readonly costUsd: number;
}

export type BudgetedBaselineTranslator = (
  candidate: DiscoveryCandidate,
  render: number,
  grant: DiscoveryTranslationGrant,
) => Promise<BudgetedDiscoveryTranslation>;

export interface BudgetedDiscoveryReport {
  readonly discovery: DiscoveryReport;
  readonly executionBudget: DiscoveryExecutionBudget;
  readonly operationCount: number;
  readonly spentUsd: number;
}

function requirePositiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be finite and positive`);
  }
  return value;
}

function freezeDiscoveryBudget(input: DiscoveryExecutionBudget): DiscoveryExecutionBudget {
  const maxElapsedMs = requirePositiveFinite(input.maxElapsedMs, "maxElapsedMs");
  const perCallTimeoutMs = requirePositiveFinite(input.perCallTimeoutMs, "perCallTimeoutMs");
  const maxCostUsd = requirePositiveFinite(input.maxCostUsd, "maxCostUsd");
  const maxCostUsdPerCall = requirePositiveFinite(
    input.maxCostUsdPerCall,
    "maxCostUsdPerCall",
  );
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) {
    throw new RangeError("maxOutputTokens must be a positive safe integer");
  }
  return Object.freeze({
    maxElapsedMs,
    perCallTimeoutMs,
    maxCostUsd,
    maxCostUsdPerCall,
    maxOutputTokens: input.maxOutputTokens,
  });
}

function elapsedSince(now: () => number, startedAtMs: number): number {
  const elapsedMs = now() - startedAtMs;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new RangeError("discovery clock must be finite and monotonic");
  }
  return elapsedMs;
}

export async function runBudgetedTerminologyDiscovery(
  translate: BudgetedBaselineTranslator,
  candidates: readonly DiscoveryCandidate[] = DISCOVERY_CANDIDATES,
  rendersPerCandidate: number = BENCHMARK_WORKLOAD.discoveryRendersPerCandidate,
  budgetInput: DiscoveryExecutionBudget = DEFAULT_DISCOVERY_EXECUTION_BUDGET,
  provenance: DiscoveryProvenance = DEFAULT_PROVENANCE,
  now: () => number = () => performance.now(),
): Promise<BudgetedDiscoveryReport> {
  if (!Number.isSafeInteger(rendersPerCandidate) || rendersPerCandidate < 1) {
    throw new RangeError("rendersPerCandidate must be a positive safe integer");
  }
  const budget = freezeDiscoveryBudget(budgetInput);
  const operationCount = candidates.length * rendersPerCandidate;
  const requiredMaximumCostUsd = operationCount * budget.maxCostUsdPerCall;
  const costTolerance = Number.EPSILON * Math.max(1, requiredMaximumCostUsd);
  if (requiredMaximumCostUsd - budget.maxCostUsd > costTolerance) {
    throw new RangeError(
      `Discovery budget cannot pre-authorize all ${operationCount} calls at ` +
        `US$${budget.maxCostUsdPerCall.toFixed(2)} each`,
    );
  }

  const startedAtMs = now();
  let spentUsd = 0;
  let completedOperations = 0;
  const discovery = await runTerminologyDiscovery(
    async (candidate, render) => {
      const elapsedBeforeMs = elapsedSince(now, startedAtMs);
      const remainingOverallMs = budget.maxElapsedMs - elapsedBeforeMs;
      if (remainingOverallMs <= 0) {
        throw new Error("Discovery time budget exhausted before provider dispatch");
      }
      const callStartedAtMs = now();
      const callTimeoutMs = Math.min(budget.perCallTimeoutMs, remainingOverallMs);
      const dispatch = await dispatchBudgetedOperation({
        label: `discovery:${candidate.id}:render-${render}`,
        budget: Object.freeze({
          maxElapsedMs: callTimeoutMs,
          maxCostUsd: budget.maxCostUsd - spentUsd,
        }),
        startedAtMs: callStartedAtMs,
        spentUsd: 0,
        maximumCostUsd: budget.maxCostUsdPerCall,
        now,
        run: (grant) => translate(
          candidate,
          render,
          Object.freeze({ ...grant, maxOutputTokens: budget.maxOutputTokens }),
        ),
      });
      if (dispatch.status === "blocked") {
        const reason = dispatch.reason === "time_budget_exhausted"
          ? "time budget exhausted"
          : "cost budget exhausted";
        throw new Error(`Discovery ${reason} during ${candidate.id} render ${render}`);
      }
      spentUsd += authorizedOperationCost(
        dispatch.value.costUsd,
        budget.maxCostUsdPerCall,
        "discovery",
      );
      completedOperations += 1;
      return dispatch.value.output;
    },
    candidates,
    rendersPerCandidate,
    provenance,
  );

  return Object.freeze({
    discovery,
    executionBudget: budget,
    operationCount: completedOperations,
    spentUsd,
  });
}

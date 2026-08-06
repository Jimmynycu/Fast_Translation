import { createHash } from "node:crypto";
import type { DiscoveryFailure } from "./discovery.js";
import type { BenchmarkDirection } from "./protocol.js";
import { authorizedOperationCost, dispatchBudgetedOperation, freezeCostCeilings } from "./operation-budget.js";

export interface HealingGlossaryEntry {
  readonly id: string;
  readonly source: string;
  readonly aliases: readonly string[];
  readonly targetExact: string;
}

export interface HealingProfile {
  readonly systemPrompt: string;
  readonly backgroundHarness: string;
  readonly glossary: readonly HealingGlossaryEntry[];
}

export interface OpenDataFailure {
  readonly caseId: string;
  readonly familyId: string;
  readonly dataClass: "open_data";
  readonly direction: BenchmarkDirection;
  readonly sourceTerm: string;
  readonly sourceText: string;
  readonly expectedTargetExact: string;
  readonly baselineOutputs: readonly string[];
  readonly wrongRenderCount: number;
  readonly renderCount: number;
}

export type RegressionAssertion =
  | Readonly<{ readonly kind: "contains"; readonly text: string }>
  | Readonly<{ readonly kind: "excludes"; readonly text: string }>;

export interface OpenRegressionCase {
  readonly caseId: string;
  readonly familyId: string;
  readonly dataClass: "open_data";
  readonly direction: BenchmarkDirection;
  readonly sourceText: string;
  readonly assertion: RegressionAssertion;
}

export interface HealingBudget {
  readonly maxIterationsPerFamily: number;
  readonly maxElapsedMsPerFamily: number;
  readonly maxCostUsdPerFamily: number;
}

export const DEFAULT_HEALING_BUDGET: HealingBudget = Object.freeze({
  maxIterationsPerFamily: 3,
  maxElapsedMsPerFamily: 30 * 60 * 1_000,
  maxCostUsdPerFamily: 25,
});

export interface RemainingHealingBudget {
  readonly iterations: number;
  readonly elapsedMs: number;
  readonly costUsd: number;
}
export interface HealingCostCeilings {
  readonly minimizationUsd: number;
  readonly reproductionUsd: number;
  readonly proposalUsd: number;
  readonly evaluationUsd: number;
}

export interface HealingOperationGrant {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly maximumCostUsd: number;
}

export interface FailureReproduction {
  readonly reproduced: boolean;
  readonly costUsd: number;
}

export type FailureReproducer = (
  failure: OpenDataFailure,
  minimizedSourceText: string,
  remaining: RemainingHealingBudget,
  grant: HealingOperationGrant,
) => Promise<FailureReproduction>;


export interface FailureMinimization {
  readonly regressionCase: OpenRegressionCase;
  readonly costUsd: number;
}
export const DEFAULT_HEALING_COST_CEILINGS: HealingCostCeilings = Object.freeze({
  minimizationUsd: 1,
  reproductionUsd: 1,
  proposalUsd: 3,
  evaluationUsd: 3,
});


export type FailureMinimizer = (
  failure: OpenDataFailure,
  remaining: RemainingHealingBudget,
  grant: HealingOperationGrant,
) => Promise<FailureMinimization>;

export interface ProposedProfilePatch {
  readonly rationale: string;
  readonly systemPrompt?: string;
  readonly backgroundHarness?: string;
  readonly glossary?: readonly HealingGlossaryEntry[];
}

export interface ProfileFieldDiff<T> {
  readonly before: T;
  readonly after: T;
}

export interface ExactProfileDiff {
  readonly systemPrompt?: ProfileFieldDiff<string>;
  readonly backgroundHarness?: ProfileFieldDiff<string>;
  readonly glossary?: ProfileFieldDiff<readonly HealingGlossaryEntry[]>;
}

export interface HealingAttempt {
  readonly iteration: number;
  readonly proposedDiff: ExactProfileDiff;
  readonly failedCaseIds: readonly string[];
  readonly costUsd: number;
  readonly elapsedMs: number;
}

export interface FamilyHealingResult {
  readonly familyId: string;
  readonly status: "healed" | "blocked";
  readonly reason?:
    | "cost_budget_exhausted"
    | "time_budget_exhausted"
    | "max_iterations";
  readonly iterations: number;
  readonly spentUsd: number;
  readonly elapsedMs: number;
  readonly attempts: readonly HealingAttempt[];
}

export interface HealingProposalContext {
  readonly familyId: string;
  readonly iteration: number;
  readonly profile: HealingProfile;
  readonly regressions: readonly OpenRegressionCase[];
  readonly previousAttempts: readonly HealingAttempt[];
  readonly remainingBudget: RemainingHealingBudget;
  readonly grant: HealingOperationGrant;
}

export interface HealingPatchProposal {
  readonly patch: ProposedProfilePatch;
  readonly costUsd: number;
}

export type HealingProposer = (
  context: HealingProposalContext,
) => Promise<HealingPatchProposal>;

export interface HealingEvaluationOutput {
  readonly caseId: string;
  readonly actualTargetText: string;
}

export interface HealingEvaluation {
  readonly outputs: readonly HealingEvaluationOutput[];
  readonly costUsd: number;
}

export interface HealingEvaluationContext {
  readonly familyId: string;
  readonly iteration: number;
  readonly remainingBudget: RemainingHealingBudget;
  readonly grant: HealingOperationGrant;
}

export type HealingEvaluator = (
  profile: HealingProfile,
  regressions: readonly OpenRegressionCase[],
  context: HealingEvaluationContext,
) => Promise<HealingEvaluation>;

export interface BoundedHealingRequest {
  readonly baseProfile: HealingProfile;
  readonly failures: readonly OpenDataFailure[];
  readonly openRegressions: readonly OpenRegressionCase[];
  readonly minimizeFailure: FailureMinimizer;
  readonly reproduceFailure: FailureReproducer;
  readonly costCeilings: HealingCostCeilings;
  readonly propose: HealingProposer;
  readonly evaluate: HealingEvaluator;
  readonly budget?: Partial<HealingBudget>;
  readonly now?: () => number;
}

export interface AwaitingOwnerApproval {
  readonly status: "awaiting_owner_approval";
  readonly baseProfile: HealingProfile;
  readonly baseProfileHash: string;
  readonly proposedProfile: HealingProfile;
  readonly proposedDiff: ExactProfileDiff;
  readonly proposedDiffHash: string;
  readonly zeroRegressionPassed: true;
  readonly regressions: readonly OpenRegressionCase[];
  readonly familyResults: readonly FamilyHealingResult[];
}

export interface BlockedHealingRun {
  readonly status: "blocked";
  readonly reason:
    | "cost_budget_exhausted"
    | "time_budget_exhausted"
    | "max_iterations";
  readonly baseProfileHash: string;
  readonly regressions: readonly OpenRegressionCase[];
  readonly familyResults: readonly FamilyHealingResult[];
}

export type BoundedHealingRun = AwaitingOwnerApproval | BlockedHealingRun;

export interface OwnerApproval {
  readonly owner: string;
  readonly approvedAt: string;
  readonly baseProfileHash: string;
  readonly proposedDiffHash: string;
}

export interface ApprovedHealingProfile {
  readonly status: "approved_frozen";
  readonly baseProfileHash: string;
  readonly proposedDiffHash: string;
  readonly profileHash: string;
  readonly profile: HealingProfile;
  readonly approval: Readonly<{
    readonly owner: string;
    readonly approvedAt: string;
  }>;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value;
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/\s+/gu, " ").trim();
}
function isDeletionOnlyTokenSubsequence(candidate: string, original: string): boolean {
  const candidateTokens = normalized(candidate).split(" ");
  const originalTokens = normalized(original).split(" ");
  let originalIndex = 0;
  for (const candidateToken of candidateTokens) {
    while (
      originalIndex < originalTokens.length &&
      originalTokens[originalIndex] !== candidateToken
    ) {
      originalIndex += 1;
    }
    if (originalIndex >= originalTokens.length) return false;
    originalIndex += 1;
  }
  return true;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function freezeGlossaryEntry(entry: HealingGlossaryEntry): HealingGlossaryEntry {
  const id = requiredText(entry.id, "glossary entry id");
  const source = requiredText(entry.source, `glossary ${id} source`);
  const targetExact = requiredText(entry.targetExact, `glossary ${id} targetExact`);
  const aliases = [...new Set(
    entry.aliases.map((alias) => requiredText(alias, `glossary ${id} alias`)),
  )].sort((left, right) => compareText(normalized(left), normalized(right)));
  return Object.freeze({
    id,
    source,
    aliases: Object.freeze(aliases),
    targetExact,
  });
}

function freezeProfile(profile: HealingProfile): HealingProfile {
  const entries = profile.glossary
    .map(freezeGlossaryEntry)
    .sort((left, right) => compareText(left.id, right.id));
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new TypeError(`duplicate healing glossary entry: ${entry.id}`);
    ids.add(entry.id);
  }
  return Object.freeze({
    systemPrompt: requiredText(profile.systemPrompt, "systemPrompt"),
    backgroundHarness: requiredText(profile.backgroundHarness, "backgroundHarness"),
    glossary: Object.freeze(entries),
  });
}

export function hashHealingProfile(profile: HealingProfile): string {
  return sha256(freezeProfile(profile));
}

function freezeAssertion(assertion: RegressionAssertion): RegressionAssertion {
  if (assertion.kind !== "contains" && assertion.kind !== "excludes") {
    throw new TypeError("regression assertion kind must be contains or excludes");
  }
  return Object.freeze({
    kind: assertion.kind,
    text: requiredText(assertion.text, "regression assertion text"),
  });
}

function freezeRegression(regression: OpenRegressionCase): OpenRegressionCase {
  if (regression.dataClass !== "open_data") {
    throw new TypeError("Pre-release healing accepts open_data regressions only");
  }
  if (regression.direction !== "A_TO_B" && regression.direction !== "B_TO_A") {
    throw new TypeError("regression direction must be A_TO_B or B_TO_A");
  }
  return Object.freeze({
    caseId: requiredText(regression.caseId, "regression caseId"),
    familyId: requiredText(regression.familyId, "regression familyId"),
    dataClass: "open_data",
    direction: regression.direction,
    sourceText: requiredText(regression.sourceText, "regression sourceText"),
    assertion: freezeAssertion(regression.assertion),
  });
}

function validateFailure(failure: OpenDataFailure): void {
  if (failure.dataClass !== "open_data") {
    throw new TypeError("Pre-release healing accepts open_data failures only");
  }
  requiredText(failure.caseId, "failure caseId");
  requiredText(failure.familyId, "failure familyId");
  requiredText(failure.sourceTerm, "failure sourceTerm");
  requiredText(failure.sourceText, "failure sourceText");
  requiredText(failure.expectedTargetExact, "failure expectedTargetExact");
  if (failure.direction !== "A_TO_B" && failure.direction !== "B_TO_A") {
    throw new TypeError("failure direction must be A_TO_B or B_TO_A");
  }
  if (
    !Number.isSafeInteger(failure.renderCount) ||
    failure.renderCount < 1 ||
    failure.baselineOutputs.length !== failure.renderCount
  ) {
    throw new TypeError("failure renderCount must match baselineOutputs");
  }
  const computedWrong = failure.baselineOutputs.filter(
    (output) => !normalized(output).includes(normalized(failure.expectedTargetExact)),
  ).length;
  if (
    failure.wrongRenderCount !== computedWrong ||
    computedWrong < Math.floor(failure.renderCount / 2) + 1
  ) {
    throw new TypeError("failure must reproduce in a majority of open-data renders");
  }
  if (!normalized(failure.sourceText).includes(normalized(failure.sourceTerm))) {
    throw new TypeError("failure sourceText must contain sourceTerm");
  }
}

export function openFailureFromDiscovery(
  failure: DiscoveryFailure,
): OpenDataFailure {
  const converted = Object.freeze({
    caseId: failure.id,
    familyId: failure.id,
    dataClass: "open_data" as const,
    direction: failure.direction,
    sourceTerm: failure.sourceTerm,
    sourceText: failure.sourceSentence,
    expectedTargetExact: failure.provisionalTargetExact,
    baselineOutputs: Object.freeze([...failure.baselineOutputs]),
    wrongRenderCount: failure.wrongRenderCount,
    renderCount: failure.renderCount,
  });
  validateFailure(converted);
  return converted;
}

export async function minimizeRegressionCase(
  failure: OpenDataFailure,
  stillFails: (sourceText: string) => Promise<boolean>,
): Promise<OpenRegressionCase> {
  validateFailure(failure);
  let best = failure.sourceText.trim();
  if (!(await stillFails(best))) {
    throw new TypeError("failure sourceText no longer reproduces the failure");
  }

  const term = failure.sourceTerm.trim();
  if (await stillFails(term)) {
    best = term;
  } else {
    let tokens = best.split(/\s+/u);
    let changed = true;
    while (changed && tokens.length > 1) {
      changed = false;
      for (let index = 0; index < tokens.length; index += 1) {
        const candidateTokens = tokens.filter((_token, tokenIndex) => tokenIndex !== index);
        const candidate = candidateTokens.join(" ").trim();
        if (
          candidate.length === 0 ||
          !normalized(candidate).includes(normalized(term))
        ) {
          continue;
        }
        if (await stillFails(candidate)) {
          tokens = candidateTokens;
          best = candidate;
          changed = true;
          break;
        }
      }
    }
  }

  return freezeRegression({
    caseId: `regression:${failure.caseId}`,
    familyId: failure.familyId,
    dataClass: "open_data",
    direction: failure.direction,
    sourceText: best,
    assertion: { kind: "contains", text: failure.expectedTargetExact },
  });
}

function resolveBudget(candidate: Partial<HealingBudget> | undefined): HealingBudget {
  const budget = {
    maxIterationsPerFamily:
      candidate?.maxIterationsPerFamily ?? DEFAULT_HEALING_BUDGET.maxIterationsPerFamily,
    maxElapsedMsPerFamily:
      candidate?.maxElapsedMsPerFamily ?? DEFAULT_HEALING_BUDGET.maxElapsedMsPerFamily,
    maxCostUsdPerFamily:
      candidate?.maxCostUsdPerFamily ?? DEFAULT_HEALING_BUDGET.maxCostUsdPerFamily,
  };
  if (
    !Number.isSafeInteger(budget.maxIterationsPerFamily) ||
    budget.maxIterationsPerFamily < 1 ||
    budget.maxIterationsPerFamily > DEFAULT_HEALING_BUDGET.maxIterationsPerFamily
  ) {
    throw new RangeError("maxIterationsPerFamily must be between 1 and 3");
  }
  if (
    !Number.isFinite(budget.maxElapsedMsPerFamily) ||
    budget.maxElapsedMsPerFamily <= 0 ||
    budget.maxElapsedMsPerFamily > DEFAULT_HEALING_BUDGET.maxElapsedMsPerFamily
  ) {
    throw new RangeError("maxElapsedMsPerFamily must be at most 30 minutes");
  }
  if (
    !Number.isFinite(budget.maxCostUsdPerFamily) ||
    budget.maxCostUsdPerFamily <= 0 ||
    budget.maxCostUsdPerFamily > DEFAULT_HEALING_BUDGET.maxCostUsdPerFamily
  ) {
    throw new RangeError("maxCostUsdPerFamily must be at most US$25");
  }
  return Object.freeze(budget);
}

function remainingBudget(
  budget: HealingBudget,
  iterations: number,
  elapsedMs: number,
  spentUsd: number,
): RemainingHealingBudget {
  return Object.freeze({
    iterations: Math.max(0, budget.maxIterationsPerFamily - iterations),
    elapsedMs: Math.max(0, budget.maxElapsedMsPerFamily - elapsedMs),
    costUsd: Math.max(0, budget.maxCostUsdPerFamily - spentUsd),
  });
}

function applyPatch(
  profile: HealingProfile,
  patch: ProposedProfilePatch,
): HealingProfile {
  requiredText(patch.rationale, "proposal rationale");
  return freezeProfile({
    systemPrompt: patch.systemPrompt ?? profile.systemPrompt,
    backgroundHarness: patch.backgroundHarness ?? profile.backgroundHarness,
    glossary: patch.glossary ?? profile.glossary,
  });
}

function same(valueA: unknown, valueB: unknown): boolean {
  return JSON.stringify(valueA) === JSON.stringify(valueB);
}

function exactProfileDiff(
  before: HealingProfile,
  after: HealingProfile,
): ExactProfileDiff {
  const diff: {
    systemPrompt?: ProfileFieldDiff<string>;
    backgroundHarness?: ProfileFieldDiff<string>;
    glossary?: ProfileFieldDiff<readonly HealingGlossaryEntry[]>;
  } = {};
  if (before.systemPrompt !== after.systemPrompt) {
    diff.systemPrompt = Object.freeze({
      before: before.systemPrompt,
      after: after.systemPrompt,
    });
  }
  if (before.backgroundHarness !== after.backgroundHarness) {
    diff.backgroundHarness = Object.freeze({
      before: before.backgroundHarness,
      after: after.backgroundHarness,
    });
  }
  if (!same(before.glossary, after.glossary)) {
    diff.glossary = Object.freeze({
      before: before.glossary,
      after: after.glossary,
    });
  }
  if (Object.keys(diff).length === 0) {
    throw new TypeError("healing proposal must contain an exact profile change");
  }
  return Object.freeze(diff);
}

function requireThreeSurfaceDiff(diff: ExactProfileDiff): void {
  if (
    diff.systemPrompt === undefined ||
    diff.backgroundHarness === undefined ||
    diff.glossary === undefined
  ) {
    throw new TypeError(
      "healing proposal must explicitly change systemPrompt, backgroundHarness, and glossary",
    );
  }
}
function sortedRegressions(
  regressions: readonly OpenRegressionCase[],
): readonly OpenRegressionCase[] {
  return Object.freeze(
    [...regressions].sort((left, right) => compareText(left.caseId, right.caseId)),
  );
}

function addRegression(
  regressions: OpenRegressionCase[],
  regression: OpenRegressionCase,
): void {
  const existing = regressions.find((candidate) => candidate.caseId === regression.caseId);
  if (existing !== undefined) {
    if (!same(existing, regression)) {
      throw new TypeError(`conflicting regression caseId: ${regression.caseId}`);
    }
    return;
  }
  regressions.push(regression);
}

function failedRegressionIds(
  regressions: readonly OpenRegressionCase[],
  evaluation: HealingEvaluation,
): readonly string[] {
  const known = new Set(regressions.map((regression) => regression.caseId));
  const outputs = new Map<string, HealingEvaluationOutput>();
  for (const output of evaluation.outputs) {
    if (!known.has(output.caseId)) {
      throw new TypeError(`evaluation returned unknown caseId: ${output.caseId}`);
    }
    if (outputs.has(output.caseId)) {
      throw new TypeError(`evaluation returned duplicate caseId: ${output.caseId}`);
    }
    outputs.set(output.caseId, Object.freeze({
      caseId: output.caseId,
      actualTargetText: output.actualTargetText,
    }));
  }

  const failures: string[] = [];
  for (const regression of regressions) {
    const output = outputs.get(regression.caseId);
    if (output === undefined) {
      failures.push(regression.caseId);
      continue;
    }
    const passes = regression.assertion.kind === "contains"
      ? output.actualTargetText.includes(regression.assertion.text)
      : !output.actualTargetText.includes(regression.assertion.text);
    if (!passes) failures.push(regression.caseId);
  }
  return Object.freeze(failures);
}

function familyResult(input: {
  readonly familyId: string;
  readonly status: "healed" | "blocked";
  readonly reason?:
    | "cost_budget_exhausted"
    | "time_budget_exhausted"
    | "max_iterations";
  readonly iterations: number;
  readonly spentUsd: number;
  readonly elapsedMs: number;
  readonly attempts: readonly HealingAttempt[];
}): FamilyHealingResult {
  return Object.freeze({
    familyId: input.familyId,
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    iterations: input.iterations,
    spentUsd: input.spentUsd,
    elapsedMs: input.elapsedMs,
    attempts: Object.freeze([...input.attempts]),
  });
}

function blockedRun(
  reason: BlockedHealingRun["reason"],
  baseProfileHash: string,
  regressions: readonly OpenRegressionCase[],
  familyResults: readonly FamilyHealingResult[],
): BlockedHealingRun {
  return Object.freeze({
    status: "blocked",
    reason,
    baseProfileHash,
    regressions: sortedRegressions(regressions),
    familyResults: Object.freeze([...familyResults]),
  });
}

export async function runBoundedPreReleaseHealing(
  request: BoundedHealingRequest,
): Promise<BoundedHealingRun> {
  if (request.failures.length === 0) {
    throw new TypeError("At least one open-data failure is required");
  }
  const budget = resolveBudget(request.budget);
  const costCeilings = freezeCostCeilings(request.costCeilings);
  const operationBudget = Object.freeze({
    maxElapsedMs: budget.maxElapsedMsPerFamily,
    maxCostUsd: budget.maxCostUsdPerFamily,
  });
  const now = request.now ?? (() => performance.now());
  const baseProfile = freezeProfile(request.baseProfile);
  const baseProfileHash = hashHealingProfile(baseProfile);
  const failures = [...request.failures].sort(
    (left, right) =>
      compareText(left.familyId, right.familyId) ||
      compareText(left.caseId, right.caseId),
  );
  for (const failure of failures) validateFailure(failure);

  const regressions: OpenRegressionCase[] = [];
  for (const regression of request.openRegressions) {
    addRegression(regressions, freezeRegression(regression));
  }

  const familyIds = [...new Set(failures.map((failure) => failure.familyId))];
  const familyResults: FamilyHealingResult[] = [];
  let workingProfile = baseProfile;

  for (const familyId of familyIds) {
    const startedAtMs = now();
    let spentUsd = 0;
    let iterations = 0;
    let elapsedMs = 0;
    const attempts: HealingAttempt[] = [];
    const familyFailures = failures.filter((failure) => failure.familyId === familyId);
    const stop = (reason: BlockedHealingRun["reason"]): BlockedHealingRun => {
      familyResults.push(familyResult({
        familyId,
        status: "blocked",
        reason,
        iterations,
        spentUsd,
        elapsedMs,
        attempts,
      }));
      return blockedRun(
        reason,
        baseProfileHash,
        regressions,
        familyResults,
      );
    };


    for (const failure of familyFailures) {
      const minimizationDispatch = await dispatchBudgetedOperation({
        label: "minimization",
        budget: operationBudget,
        startedAtMs,
        spentUsd,
        maximumCostUsd: costCeilings.minimizationUsd,
        now,
        run: (grant) => request.minimizeFailure(
          failure,
          remainingBudget(budget, iterations, elapsedMs, spentUsd),
          grant,
        ),
      });
      if (minimizationDispatch.status === "blocked") {
        elapsedMs = minimizationDispatch.elapsedMs;
        return stop(minimizationDispatch.reason);
      }
      const minimized = minimizationDispatch.value;
      elapsedMs = minimizationDispatch.elapsedMs;
      spentUsd += authorizedOperationCost(
        minimized.costUsd,
        costCeilings.minimizationUsd,
        "minimization",
      );

      const regression = freezeRegression(minimized.regressionCase);
      if (
        regression.caseId !== `regression:${failure.caseId}` ||
        regression.familyId !== failure.familyId ||
        regression.direction !== failure.direction ||
        regression.assertion.kind !== "contains" ||
        regression.assertion.text !== failure.expectedTargetExact ||
        regression.sourceText.length >= failure.sourceText.trim().length ||
        !normalized(regression.sourceText).includes(normalized(failure.sourceTerm))
      ) {
        throw new TypeError("minimized regression must be strictly smaller and remain tied to its open-data failure");
      }
      if (!isDeletionOnlyTokenSubsequence(regression.sourceText, failure.sourceText)) {
        throw new TypeError(
          "minimized regression must be a deletion-only subsequence of the original source tokens",
        );
      }
      const reproductionDispatch = await dispatchBudgetedOperation({
        label: "failure reproduction",
        budget: operationBudget,
        startedAtMs,
        spentUsd,
        maximumCostUsd: costCeilings.reproductionUsd,
        now,
        run: (grant) => request.reproduceFailure(
          failure,
          regression.sourceText,
          remainingBudget(budget, iterations, elapsedMs, spentUsd),
          grant,
        ),
      });
      if (reproductionDispatch.status === "blocked") {
        elapsedMs = reproductionDispatch.elapsedMs;
        return stop(reproductionDispatch.reason);
      }
      const reproduction = reproductionDispatch.value;
      elapsedMs = reproductionDispatch.elapsedMs;
      spentUsd += authorizedOperationCost(
        reproduction.costUsd,
        costCeilings.reproductionUsd,
        "failure reproduction",
      );
      if (!reproduction.reproduced) {
        throw new TypeError("minimized regression no longer reproduces its open-data failure");
      }
      addRegression(regressions, regression);
    }

    let healed = false;
    while (iterations < budget.maxIterationsPerFamily) {

      const nextIteration = iterations + 1;
      const regressionSuite = sortedRegressions(regressions);
      const proposalDispatch = await dispatchBudgetedOperation({
        label: "proposal",
        budget: operationBudget,
        startedAtMs,
        spentUsd,
        maximumCostUsd: costCeilings.proposalUsd,
        now,
        run: (grant) => request.propose(Object.freeze({
          familyId,
          iteration: nextIteration,
          profile: workingProfile,
          regressions: regressionSuite,
          previousAttempts: Object.freeze([...attempts]),
          remainingBudget: remainingBudget(
            budget,
            iterations,
            elapsedMs,
            spentUsd,
          ),
          grant,
        })),
      });
      if (proposalDispatch.status === "blocked") {
        elapsedMs = proposalDispatch.elapsedMs;
        return stop(proposalDispatch.reason);
      }
      iterations = nextIteration;
      const proposal = proposalDispatch.value;
      const proposalCost = authorizedOperationCost(
        proposal.costUsd,
        costCeilings.proposalUsd,
        "proposal",
      );
      spentUsd += proposalCost;
      elapsedMs = proposalDispatch.elapsedMs;

      const candidateProfile = applyPatch(workingProfile, proposal.patch);
      const proposedDiff = exactProfileDiff(workingProfile, candidateProfile);
      requireThreeSurfaceDiff(proposedDiff);
      const evaluationDispatch = await dispatchBudgetedOperation({
        label: "evaluation",
        budget: operationBudget,
        startedAtMs,
        spentUsd,
        maximumCostUsd: costCeilings.evaluationUsd,
        now,
        run: (grant) => request.evaluate(
          candidateProfile,
          regressionSuite,
          Object.freeze({
            familyId,
            iteration: iterations,
            remainingBudget: remainingBudget(
              budget,
              iterations,
              elapsedMs,
              spentUsd,
            ),
            grant,
          }),
        ),
      });
      if (evaluationDispatch.status === "blocked") {
        elapsedMs = evaluationDispatch.elapsedMs;
        return stop(evaluationDispatch.reason);
      }
      const evaluation = evaluationDispatch.value;
      const evaluationCost = authorizedOperationCost(
        evaluation.costUsd,
        costCeilings.evaluationUsd,
        "evaluation",
      );
      spentUsd += evaluationCost;
      elapsedMs = evaluationDispatch.elapsedMs;

      const failedCaseIds = failedRegressionIds(regressionSuite, evaluation);
      attempts.push(Object.freeze({
        iteration: iterations,
        proposedDiff,
        failedCaseIds,
        costUsd: proposalCost + evaluationCost,
        elapsedMs,
      }));
      if (failedCaseIds.length === 0) {
        workingProfile = candidateProfile;
        healed = true;
        break;
      }
    }

    if (!healed) {
      familyResults.push(familyResult({
        familyId,
        status: "blocked",
        reason: "max_iterations",
        iterations,
        spentUsd,
        elapsedMs,
        attempts,
      }));
      return blockedRun(
        "max_iterations",
        baseProfileHash,
        regressions,
        familyResults,
      );
    }
    familyResults.push(familyResult({
      familyId,
      status: "healed",
      iterations,
      spentUsd,
      elapsedMs,
      attempts,
    }));
  }

  const proposedDiff = exactProfileDiff(baseProfile, workingProfile);
  return Object.freeze({
    status: "awaiting_owner_approval",
    baseProfile,
    baseProfileHash,
    proposedProfile: workingProfile,
    proposedDiff,
    proposedDiffHash: sha256(proposedDiff),
    zeroRegressionPassed: true,
    regressions: sortedRegressions(regressions),
    familyResults: Object.freeze(familyResults),
  });
}

export function approveHealingProposal(
  proposal: AwaitingOwnerApproval,
  approval: OwnerApproval,
): ApprovedHealingProfile {
  const owner = requiredText(approval.owner, "approval owner").trim();
  const approvedAtMs = Date.parse(approval.approvedAt);
  if (!Number.isFinite(approvedAtMs)) {
    throw new TypeError("approval approvedAt must be an ISO timestamp");
  }
  const baseProfile = freezeProfile(proposal.baseProfile);
  const proposedProfile = freezeProfile(proposal.proposedProfile);
  if (
    hashHealingProfile(baseProfile) !== proposal.baseProfileHash ||
    approval.baseProfileHash !== proposal.baseProfileHash
  ) {
    throw new TypeError("Owner approval does not match the exact base profile hash");
  }
  const recomputedDiff = exactProfileDiff(baseProfile, proposedProfile);
  const recomputedDiffHash = sha256(recomputedDiff);
  if (
    !same(recomputedDiff, proposal.proposedDiff) ||
    recomputedDiffHash !== proposal.proposedDiffHash ||
    approval.proposedDiffHash !== proposal.proposedDiffHash
  ) {
    throw new TypeError("Owner approval does not match the exact proposed diff");
  }
  if (!proposal.zeroRegressionPassed) {
    throw new TypeError("Owner approval cannot bypass the zero-regression gate");
  }

  const profileHash = hashHealingProfile(proposedProfile);
  if (profileHash === proposal.baseProfileHash) {
    throw new TypeError("Approved profile must differ from its immutable base");
  }
  return Object.freeze({
    status: "approved_frozen",
    baseProfileHash: proposal.baseProfileHash,
    proposedDiffHash: proposal.proposedDiffHash,
    profileHash,
    profile: proposedProfile,
    approval: Object.freeze({
      owner,
      approvedAt: new Date(approvedAtMs).toISOString(),
    }),
  });
}

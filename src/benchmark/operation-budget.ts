export interface OperationBudgetEnvelope {
  readonly maxElapsedMs: number;
  readonly maxCostUsd: number;
}

export interface BudgetOperationGrant {
  readonly signal: AbortSignal;
  readonly deadlineAtMs: number;
  readonly maximumCostUsd: number;
}

export type BudgetExhaustionReason =
  | "cost_budget_exhausted"
  | "time_budget_exhausted";

export type BudgetedOperationResult<T> =
  | Readonly<{
      readonly status: "completed";
      readonly value: T;
      readonly elapsedMs: number;
    }>
  | Readonly<{
      readonly status: "blocked";
      readonly reason: BudgetExhaustionReason;
      readonly elapsedMs: number;
    }>;

export interface BudgetedOperationRequest<T> {
  readonly label: string;
  readonly budget: OperationBudgetEnvelope;
  readonly startedAtMs: number;
  readonly spentUsd: number;
  readonly maximumCostUsd: number;
  readonly now: () => number;
  readonly run: (grant: BudgetOperationGrant) => Promise<T>;
}

const DEADLINE_EXCEEDED = Symbol("deadline_exceeded");

function finiteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and non-negative`);
  }
  return value;
}

function measuredElapsed(now: () => number, startedAtMs: number): number {
  const value = now() - startedAtMs;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("operation clock must be finite and monotonic");
  }
  return value;
}

export function freezeCostCeilings<T extends object>(candidate: T): Readonly<T> {
  for (const [name, value] of Object.entries(candidate)) {
    finiteNonNegative(value as number, `${name} ceiling`);
  }
  return Object.freeze({ ...candidate });
}

export function authorizedOperationCost(
  actualCostUsd: number,
  maximumCostUsd: number,
  label: string,
): number {
  const actual = finiteNonNegative(actualCostUsd, `${label} costUsd`);
  const maximum = finiteNonNegative(maximumCostUsd, `${label} maximumCostUsd`);
  if (actual > maximum) {
    throw new RangeError(
      `${label} costUsd exceeded its pre-authorized per-call ceiling`,
    );
  }
  return actual;
}

export async function dispatchBudgetedOperation<T>(
  request: BudgetedOperationRequest<T>,
): Promise<BudgetedOperationResult<T>> {
  const maximumCostUsd = finiteNonNegative(
    request.maximumCostUsd,
    `${request.label} maximumCostUsd`,
  );
  const elapsedBeforeMs = measuredElapsed(request.now, request.startedAtMs);
  if (elapsedBeforeMs >= request.budget.maxElapsedMs) {
    return Object.freeze({
      status: "blocked",
      reason: "time_budget_exhausted",
      elapsedMs: elapsedBeforeMs,
    });
  }

  const remainingCostUsd = request.budget.maxCostUsd - request.spentUsd;
  if (remainingCostUsd <= 0 || maximumCostUsd > remainingCostUsd) {
    return Object.freeze({
      status: "blocked",
      reason: "cost_budget_exhausted",
      elapsedMs: elapsedBeforeMs,
    });
  }

  const controller = new AbortController();
  const deadlineAtMs = request.startedAtMs + request.budget.maxElapsedMs;
  const grant = Object.freeze({
    signal: controller.signal,
    deadlineAtMs,
    maximumCostUsd,
  });
  const operation = Promise.resolve().then(() => request.run(grant));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${request.label} deadline exceeded`));
      resolve(DEADLINE_EXCEEDED);
    }, request.budget.maxElapsedMs - elapsedBeforeMs);
  });

  let outcome: T | typeof DEADLINE_EXCEEDED;
  try {
    outcome = await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const elapsedAfterMs = measuredElapsed(request.now, request.startedAtMs);
  if (outcome === DEADLINE_EXCEEDED || elapsedAfterMs > request.budget.maxElapsedMs) {
    controller.abort(new Error(`${request.label} deadline exceeded`));
    if (outcome === DEADLINE_EXCEEDED) void operation.catch(() => undefined);
    return Object.freeze({
      status: "blocked",
      reason: "time_budget_exhausted",
      elapsedMs: elapsedAfterMs,
    });
  }

  return Object.freeze({
    status: "completed",
    value: outcome,
    elapsedMs: elapsedAfterMs,
  });
}

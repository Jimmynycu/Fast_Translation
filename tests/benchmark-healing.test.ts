import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approveHealingProposal,
  DEFAULT_HEALING_BUDGET,
  hashHealingProfile,
  minimizeRegressionCase,
  runBoundedPreReleaseHealing,
  type HealingEvaluation,
  type FailureReproducer,
  type HealingCostCeilings,
  type HealingProfile,
  type OpenDataFailure,
  type OpenRegressionCase,
  type OwnerApproval,
  type ProposedProfilePatch,
} from "../src/benchmark/healing.js";

const baseProfile: HealingProfile = {
  systemPrompt: "Translate accurately.",
  backgroundHarness: "Run the approved open regression suite.",
  glossary: [],
};

const failure: OpenDataFailure = {
  caseId: "failure-abbe",
  familyId: "abbe-error",
  dataClass: "open_data",
  direction: "A_TO_B",
  sourceTerm: "Abbe error",
  sourceText: "Please inspect the Abbe error before release.",
  expectedTargetExact: "ABBE_ERROR_TARGET",
  baselineOutputs: ["generic error", "generic error", "ABBE_ERROR_TARGET"],
  wrongRenderCount: 2,
  renderCount: 3,
};

const ordinaryRegression: OpenRegressionCase = {
  caseId: "ordinary-regression",
  familyId: "ordinary",
  dataClass: "open_data",
  direction: "A_TO_B",
  sourceText: "The machine is ready.",
  assertion: { kind: "contains", text: "MACHINE_READY_TARGET" },
};

function healedPatch(): ProposedProfilePatch {
  return {
    rationale: "Add the mined family to every pre-release control surface.",
    systemPrompt: "Translate accurately. Preserve approved manufacturing terminology exactly.",
    backgroundHarness: "Run the approved open regression suite, including regression:failure-abbe.",
    glossary: [
      {
        id: "abbe-error",
        source: "Abbe error",
        aliases: ["Abbey error"],
        targetExact: "ABBE_ERROR_TARGET",
      },
    ],
  };
}

async function deterministicMinimizer(input: OpenDataFailure) {
  return {
    regressionCase: await minimizeRegressionCase(
      input,
      async (text) => text.toLocaleLowerCase("en-US").includes("abbe error"),
    ),
    costUsd: 0,
  };
}


const costCeilings: HealingCostCeilings = Object.freeze({
  minimizationUsd: 0,
  reproductionUsd: 0,
  proposalUsd: 2,
  evaluationUsd: 2,
});

const reproduceFailure: FailureReproducer = async (_failure, sourceText) => ({
  reproduced: sourceText.toLocaleLowerCase("en-US").includes("abbe error"),
  costUsd: 0,
});

const operationControls = Object.freeze({ costCeilings, reproduceFailure });
function passingEvaluation(caseIds: readonly string[]): HealingEvaluation {
  return {
    costUsd: 0.5,
    outputs: caseIds.map((caseId) => ({
      caseId,
      actualTargetText:
        caseId === ordinaryRegression.caseId ? "MACHINE_READY_TARGET" : "ABBE_ERROR_TARGET",
    })),
  };
}

describe("bounded pre-release healing", () => {
  it("minimizes an open-data failure into a deterministic regression case", async () => {
    const minimized = await minimizeRegressionCase(
      failure,
      async (text) => text.toLocaleLowerCase("en-US").includes("abbe error"),
    );
    assert.equal(minimized.caseId, "regression:failure-abbe");
    assert.equal(minimized.sourceText, "Abbe error");
    assert.deepEqual(minimized.assertion, { kind: "contains", text: "ABBE_ERROR_TARGET" });
    assert.equal(minimized.dataClass, "open_data");
  });

  it("requires a strictly smaller regression that independently reproduces", async () => {
    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [failure],
        openRegressions: [],
        minimizeFailure: async () => ({
          regressionCase: {
            caseId: "regression:failure-abbe",
            familyId: failure.familyId,
            dataClass: "open_data",
            direction: failure.direction,
            sourceText: failure.sourceText,
            assertion: { kind: "contains", text: failure.expectedTargetExact },
          },
          costUsd: 0,
        }),
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async () => ({ costUsd: 0, outputs: [] }),
      }),
      /strictly smaller/u,
    );

    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        reproduceFailure: async () => ({ reproduced: false, costUsd: 0 }),
        baseProfile,
        failures: [failure],
        openRegressions: [],
        minimizeFailure: deterministicMinimizer,
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async () => ({ costUsd: 0, outputs: [] }),
      }),
      /no longer reproduces/u,
    );

    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [failure],
        openRegressions: [],
        minimizeFailure: async () => ({
          regressionCase: {
            caseId: "regression:failure-abbe",
            familyId: failure.familyId,
            dataClass: "open_data",
            direction: failure.direction,
            sourceText: "invented Abbe error",
            assertion: { kind: "contains", text: failure.expectedTargetExact },
          },
          costUsd: 0,
        }),
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async () => ({ costUsd: 0, outputs: [] }),
      }),
      /deletion-only subsequence/u,
    );
  });

  it("proposes an exact three-surface diff, passes zero regression, and waits for Owner approval", async () => {
    const run = await runBoundedPreReleaseHealing({
      ...operationControls,
      baseProfile,
      failures: [failure],
      openRegressions: [ordinaryRegression],
      minimizeFailure: deterministicMinimizer,
      propose: async () => ({ patch: healedPatch(), costUsd: 1.25 }),
      evaluate: async (_profile, cases) => passingEvaluation(cases.map((item) => item.caseId)),
    });

    assert.equal(run.status, "awaiting_owner_approval");
    if (run.status !== "awaiting_owner_approval") return;
    assert.equal(run.zeroRegressionPassed, true);
    assert.equal(run.familyResults[0]?.iterations, 1);
    assert.equal(run.familyResults[0]?.spentUsd, 1.75);
    assert.ok(run.proposedDiff.systemPrompt);
    assert.ok(run.proposedDiff.backgroundHarness);
    assert.ok(run.proposedDiff.glossary);
    assert.equal("profileHash" in run, false, "a candidate must not receive a release hash before approval");
    assert.equal(Object.isFrozen(run.baseProfile), true);
    assert.equal(Object.isFrozen(run.proposedProfile), true);
    assert.equal(Object.isFrozen(run.proposedProfile.glossary[0]?.aliases), true);

    const wrongApproval: OwnerApproval = {
      owner: "Customer Glossary Owner",
      approvedAt: "2026-08-06T08:00:00.000Z",
      baseProfileHash: run.baseProfileHash,
      proposedDiffHash: "0".repeat(64),
    };
    assert.throws(() => approveHealingProposal(run, wrongApproval), /exact proposed diff/u);

    const approval = {
      ...wrongApproval,
      proposedDiffHash: run.proposedDiffHash,
    };
    const tamperedProposal = {
      ...run,
      proposedDiff: {
        ...run.proposedDiff,
        systemPrompt: {
          before: run.baseProfile.systemPrompt,
          after: "tampered after Owner review",
        },
      },
    };
    assert.throws(
      () => approveHealingProposal(tamperedProposal, approval),
      /exact proposed diff/u,
    );
    const approved = approveHealingProposal(run, approval);
    assert.equal(approved.status, "approved_frozen");
    assert.equal(approved.baseProfileHash, hashHealingProfile(baseProfile));
    assert.notEqual(approved.profileHash, approved.baseProfileHash);
    assert.equal(Object.isFrozen(approved.profile), true);
    assert.equal(Object.isFrozen(approved.profile.glossary), true);
  });

  it("produces deterministic diff and immutable profile hashes", async () => {
    async function execute() {
      return runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [failure],
        openRegressions: [ordinaryRegression],
        minimizeFailure: deterministicMinimizer,
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async (_profile, cases) => passingEvaluation(cases.map((item) => item.caseId)),
      });
    }
    const first = await execute();
    const second = await execute();
    assert.equal(first.status, "awaiting_owner_approval");
    assert.equal(second.status, "awaiting_owner_approval");
    if (first.status !== "awaiting_owner_approval" || second.status !== "awaiting_owner_approval") return;
    assert.equal(first.baseProfileHash, second.baseProfileHash);
    assert.equal(first.proposedDiffHash, second.proposedDiffHash);
    assert.deepEqual(first.proposedDiff, second.proposedDiff);

    const approval: OwnerApproval = {
      owner: "Owner",
      approvedAt: "2026-08-06T08:00:00.000Z",
      baseProfileHash: first.baseProfileHash,
      proposedDiffHash: first.proposedDiffHash,
    };
    assert.equal(
      approveHealingProposal(first, approval).profileHash,
      approveHealingProposal(second, approval).profileHash,
    );
  });

  it("blocks after three failed iterations and never auto-approves", async () => {
    let proposals = 0;
    const run = await runBoundedPreReleaseHealing({
      ...operationControls,
      baseProfile,
      failures: [failure],
      openRegressions: [ordinaryRegression],
      minimizeFailure: deterministicMinimizer,
      propose: async () => {
        proposals += 1;
        return { patch: healedPatch(), costUsd: 1 };
      },
      evaluate: async (_profile, cases) => ({
        costUsd: 1,
        outputs: cases.map((item) => ({ caseId: item.caseId, actualTargetText: "still wrong" })),
      }),
    });
    assert.equal(run.status, "blocked");
    if (run.status !== "blocked") return;
    assert.equal(run.reason, "max_iterations");
    assert.equal(run.familyResults[0]?.iterations, 3);
    assert.equal(proposals, 3);
    assert.equal("profileHash" in run, false);
  });

  it("enforces the per-family USD and elapsed-time budgets before release", async () => {
    assert.deepEqual(DEFAULT_HEALING_BUDGET, {
      maxIterationsPerFamily: 3,
      maxElapsedMsPerFamily: 30 * 60 * 1_000,
      maxCostUsdPerFamily: 25,
    });
    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [failure],
        openRegressions: [],
        budget: { maxIterationsPerFamily: 4 },
        minimizeFailure: deterministicMinimizer,
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async () => ({ costUsd: 0, outputs: [] }),
      }),
      /between 1 and 3/u,
    );


    let evaluations = 0;
    let proposalCalls = 0;
    const overCost = await runBoundedPreReleaseHealing({
      ...operationControls,
      costCeilings: { ...costCeilings, proposalUsd: 25.01 },
      baseProfile,
      failures: [failure],
      openRegressions: [],
      minimizeFailure: deterministicMinimizer,
      propose: async () => {
        proposalCalls += 1;
        return { patch: healedPatch(), costUsd: 0 };
      },
      evaluate: async () => {
        evaluations += 1;
        return { costUsd: 0, outputs: [] };
      },
    });
    assert.equal(overCost.status, "blocked");
    if (overCost.status === "blocked") assert.equal(overCost.reason, "cost_budget_exhausted");
    assert.equal(evaluations, 0);

    assert.equal(proposalCalls, 0, "work above the remaining cost ceiling is never dispatched");
    let elapsed = 0;
    const overTime = await runBoundedPreReleaseHealing({
      ...operationControls,
      baseProfile,
      failures: [failure],
      openRegressions: [],
      minimizeFailure: deterministicMinimizer,
      now: () => elapsed,
      propose: async () => {
        elapsed = 30 * 60 * 1_000 + 1;
        return { patch: healedPatch(), costUsd: 0 };
      },
      evaluate: async () => ({ costUsd: 0, outputs: [] }),
    });
    assert.equal(overTime.status, "blocked");
    if (overTime.status === "blocked") assert.equal(overTime.reason, "time_budget_exhausted");

    let deadlineAborted = false;
    const cancellableDeadline = await runBoundedPreReleaseHealing({
      ...operationControls,
      baseProfile,
      failures: [failure],
      openRegressions: [],
      budget: { maxElapsedMsPerFamily: 25 },
      minimizeFailure: deterministicMinimizer,
      propose: async (context) => {
        await new Promise<void>((resolve) => {
          context.grant.signal.addEventListener("abort", () => {
            deadlineAborted = true;
            resolve();
          }, { once: true });
        });
        return { patch: healedPatch(), costUsd: 0 };
      },
      evaluate: async () => ({ costUsd: 0, outputs: [] }),
    });
    assert.equal(cancellableDeadline.status, "blocked");
    if (cancellableDeadline.status === "blocked") {
      assert.equal(cancellableDeadline.reason, "time_budget_exhausted");
    }
    assert.equal(deadlineAborted, true);
  });

  it("requires every open regression to pass and rejects non-open healing input", async () => {
    const run = await runBoundedPreReleaseHealing({
      ...operationControls,
      baseProfile,
      failures: [failure],
      openRegressions: [ordinaryRegression],
      minimizeFailure: deterministicMinimizer,
      propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
      evaluate: async (_profile, cases) => ({
        costUsd: 0,
        outputs: cases.map((item) => ({
          caseId: item.caseId,
          actualTargetText: item.caseId === ordinaryRegression.caseId ? "regressed" : "ABBE_ERROR_TARGET",
        })),
      }),
    });
    assert.equal(run.status, "blocked");
    if (run.status === "blocked") assert.equal(run.reason, "max_iterations");

    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [failure],
        openRegressions: [],
        minimizeFailure: deterministicMinimizer,
        propose: async () => ({
          patch: { rationale: "incomplete", systemPrompt: "prompt-only change" },
          costUsd: 0,
        }),
        evaluate: async () => passingEvaluation(["regression:failure-abbe"]),
      }),
      /explicitly change systemPrompt, backgroundHarness, and glossary/u,
    );

    const sealedFailure = { ...failure, dataClass: "sealed_proof" } as unknown as OpenDataFailure;
    await assert.rejects(
      runBoundedPreReleaseHealing({
        ...operationControls,
        baseProfile,
        failures: [sealedFailure],
        openRegressions: [],
        minimizeFailure: deterministicMinimizer,
        propose: async () => ({ patch: healedPatch(), costUsd: 0 }),
        evaluate: async () => ({ costUsd: 0, outputs: [] }),
      }),
      /open_data/u,
    );
  });
});

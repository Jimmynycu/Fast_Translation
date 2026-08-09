import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createBenchmarkProfileUnderTest,
  executeKeylessBenchmark,
} from "../src/benchmark/runner.js";
import {
  approveDeterministicHealingProposal,
  createDeterministicHealingProposal,
  evaluateLocalReleaseGate,
  validateApprovedProfileArtifact,
  validateDeterministicHealingProposal,
} from "../src/benchmark/release.js";

const taskTemp = join(process.cwd(), "work", "tmp", "benchmark-release-tests");
const ownerKeys = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

async function isolatedDirectory(name: string): Promise<string> {
  const directory = join(taskTemp, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

async function approvedProfile(approvedAt = "2026-08-06T12:00:00.000Z") {
  const proposal = await createDeterministicHealingProposal();
  return {
    proposal,
    approved: approveDeterministicHealingProposal(proposal, {
      owner: "Customer Glossary Owner",
      approvedAt,
      baseProfileHash: proposal.proposal.baseProfileHash,
      proposedDiffHash: proposal.proposal.proposedDiffHash,
    }, ownerKeys.privateKey),
  };
}

describe("keyless deterministic healing and signed release gate", () => {
  it("runs bounded healing without auto-approval", async () => {
    const artifact = await createDeterministicHealingProposal();
    validateDeterministicHealingProposal(artifact);

    assert.equal(artifact.kind, "deterministic_healing_proposal");
    assert.equal(artifact.dataClass, "open_data");
    assert.equal(artifact.providerAcceptanceVerdict, "NOT_RUN");
    assert.equal(artifact.proposal.status, "awaiting_owner_approval");
    assert.equal(artifact.proposal.zeroRegressionPassed, true);
    assert.equal(artifact.proposal.familyResults[0]?.status, "healed");
    assert.equal(artifact.proposal.regressions.some(
      (regression) => regression.caseId === "regression:keyless-abbe-offset",
    ), true);
    assert.equal(artifact.proposal.proposedProfile.glossary.length, 4);
    assert.equal("profileHash" in artifact.proposal, false);
  });

  it("requires exact hashes and a verifiable pinned Ed25519 owner signature", async () => {
    const artifact = await createDeterministicHealingProposal();
    assert.throws(
      () => approveDeterministicHealingProposal(artifact, {
        owner: "Customer Glossary Owner",
        approvedAt: "2026-08-06T12:00:00.000Z",
        baseProfileHash: artifact.proposal.baseProfileHash,
        proposedDiffHash: "0".repeat(64),
      }, ownerKeys.privateKey),
      /exact proposed diff/u,
    );

    const { approved } = await approvedProfile();
    validateApprovedProfileArtifact(approved, ownerKeys.publicKey);
    assert.equal(approved.kind, "owner_signed_approved_healing_profile");
    assert.equal(approved.approvalAssurance, "local_ed25519_owner_signature");
    assert.equal(approved.trustAnchorSource, "operator_supplied_test_key");
    assert.equal(approved.customerOwnerAcceptanceVerdict, "NOT_RUN");
    assert.match(approved.ownerSignature.keyIdSha256, /^[a-f0-9]{64}$/u);
    const unrelatedKeys = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    assert.throws(
      () => validateApprovedProfileArtifact(approved, unrelatedKeys.publicKey),
      /owner signature mismatch/u,
    );
  });

  it("binds canonical benchmark files to the exact signed approved profile", async () => {
    const benchmarkDirectory = await isolatedDirectory("benchmark");
    const { proposal, approved } = await approvedProfile();
    const profileUnderTest = createBenchmarkProfileUnderTest({
      approvedProfileArtifactSha256: approved.artifactSha256,
      profile: approved.approvedProfile.profile,
    });
    await executeKeylessBenchmark({
      outputDirectory: benchmarkDirectory,
      profileUnderTest,
    });

    const gate = await evaluateLocalReleaseGate({
      benchmarkDirectory,
      approvedProfile: approved,
      trustedOwnerPublicKey: ownerKeys.publicKey,
    });
    assert.equal(gate.localPocReleaseVerdict, "PASS");
    assert.equal(gate.trustAnchorSource, "operator_supplied_test_key");
    assert.equal(gate.customerOwnerAcceptanceVerdict, "NOT_RUN");
    assert.equal(gate.productAcceptanceVerdict, "NOT_RUN");
    assert.equal(gate.providerAcceptanceVerdict, "NOT_RUN");
    assert.deepEqual(gate.localReleaseEvidence, {
      targetExact: true,
      zeroRegression: true,
      alertsClear: true,
      latency: true,
      evidenceComplete: true,
    });
    assert.equal(gate.approvedProfileHash, approved.approvedProfile.profileHash);
    assert.equal(gate.reasons.length, 0);

    const unrelated = approveDeterministicHealingProposal(proposal, {
      owner: "Customer Glossary Owner",
      approvedAt: "2026-08-06T12:01:00.000Z",
      baseProfileHash: proposal.proposal.baseProfileHash,
      proposedDiffHash: proposal.proposal.proposedDiffHash,
    }, ownerKeys.privateKey);
    await assert.rejects(
      evaluateLocalReleaseGate({
        benchmarkDirectory,
        approvedProfile: unrelated,
        trustedOwnerPublicKey: ownerKeys.publicKey,
      }),
      /exact signed approved profile/u,
    );

    const resultPath = join(benchmarkDirectory, "run-results.jsonl");
    await writeFile(resultPath, (await readFile(resultPath, "utf8")) + " ", "utf8");
    await assert.rejects(
      evaluateLocalReleaseGate({
        benchmarkDirectory,
        approvedProfile: approved,
        trustedOwnerPublicKey: ownerKeys.publicKey,
      }),
      /checksum mismatch/u,
    );
  });

  it("rejects test-only custom-executor bundles before release", async () => {
    const benchmarkDirectory = await isolatedDirectory("test-only-benchmark");
    const { approved } = await approvedProfile();
    const profileUnderTest = createBenchmarkProfileUnderTest({
      approvedProfileArtifactSha256: approved.artifactSha256,
      profile: approved.approvedProfile.profile,
    });
    await executeKeylessBenchmark({
      outputDirectory: benchmarkDirectory,
      profileUnderTest,
      testOnly: true,
      localHarnessExecutor: async () => {
        throw new Error("intentional test-only executor failure");
      },
    });
    await assert.rejects(
      evaluateLocalReleaseGate({
        benchmarkDirectory,
        approvedProfile: approved,
        trustedOwnerPublicKey: ownerKeys.publicKey,
      }),
      /test-only benchmark bundles/u,
    );
  });
});

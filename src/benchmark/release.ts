import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  approveHealingProposal,
  hashHealingProfile,
  minimizeRegressionCase,
  runBoundedPreReleaseHealing,
  type ApprovedHealingProfile,
  type AwaitingOwnerApproval,
  type HealingProfile,
  type OpenDataFailure,
  type OpenRegressionCase,
  type OwnerApproval,
} from "./healing.js";
import {
  benchmarkArtifactSha256,
  readAndValidateKeylessBenchmark,
  type BenchmarkAcceptanceScore,
} from "./runner.js";

export interface DeterministicHealingProposalArtifact {
  readonly schemaVersion: 1;
  readonly kind: "deterministic_healing_proposal";
  readonly dataClass: "open_data";
  readonly baselineMode: "synthetic_deterministic_failure_fixture";
  readonly providerAcceptanceVerdict: "NOT_RUN";
  readonly proposal: AwaitingOwnerApproval;
  readonly artifactSha256: string;
}

export interface ApprovedProfileArtifact {
  readonly schemaVersion: 1;
  readonly kind: "owner_signed_approved_healing_profile";
  readonly approvalAssurance: "local_ed25519_owner_signature";
  readonly trustAnchorSource: "operator_supplied_test_key";
  readonly customerOwnerAcceptanceVerdict: "NOT_RUN";
  readonly proposalArtifactSha256: string;
  readonly providerAcceptanceVerdict: "NOT_RUN";
  readonly approvedProfile: ApprovedHealingProfile;
  readonly artifactSha256: string;
  readonly ownerSignature: Readonly<{
    readonly algorithm: "Ed25519";
    readonly keyIdSha256: string;
    readonly signedArtifactSha256: string;
    readonly signatureBase64: string;
  }>;
}

export interface LocalReleaseGateArtifact {
  readonly schemaVersion: 1;
  readonly kind: "local_poc_release_gate";
  readonly benchmarkBundleSha256: string;
  readonly benchmarkScoreSha256: string;
  readonly approvedProfileArtifactSha256: string;
  readonly approvedProfileHash: string;
  readonly benchmarkProfileUnderTestSha256: string;
  readonly ownerKeyIdSha256: string;
  readonly trustAnchorSource: "operator_supplied_test_key";
  readonly customerOwnerAcceptanceVerdict: "NOT_RUN";
  readonly localPocReleaseVerdict: "PASS" | "FAIL";
  readonly localReleaseEvidence: BenchmarkAcceptanceScore["localReleaseEvidence"];
  readonly providerAcceptanceVerdict: "NOT_RUN";
  readonly productAcceptanceVerdict: "NOT_RUN";
  readonly reasons: readonly string[];
  readonly gateSha256: string;
}

const BASE_PROFILE: HealingProfile = Object.freeze({
  systemPrompt: "Translate accurately.",
  backgroundHarness: "Run every approved open-data regression.",
  glossary: Object.freeze([]),
});

const FAILURE: OpenDataFailure = Object.freeze({
  caseId: "keyless-abbe-offset",
  familyId: "abbe-offset",
  dataClass: "open_data",
  direction: "A_TO_B",
  sourceTerm: "Abbe offset",
  sourceText: "Verify the Abbe offset before release.",
  expectedTargetExact: "阿貝偏移",
  baselineOutputs: Object.freeze([
    "generic measurement offset",
    "generic measurement offset",
    "阿貝偏移",
  ]),
  wrongRenderCount: 2,
  renderCount: 3,
});

const ORDINARY_REGRESSION: OpenRegressionCase = Object.freeze({
  caseId: "ordinary-machine-ready",
  familyId: "ordinary",
  dataClass: "open_data",
  direction: "A_TO_B",
  sourceText: "The machine is ready.",
  assertion: Object.freeze({ kind: "contains", text: "MACHINE_READY_TARGET" }),
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function proposalArtifact(
  proposal: AwaitingOwnerApproval,
): DeterministicHealingProposalArtifact {
  const body = {
    schemaVersion: 1 as const,
    kind: "deterministic_healing_proposal" as const,
    dataClass: "open_data" as const,
    baselineMode: "synthetic_deterministic_failure_fixture" as const,
    providerAcceptanceVerdict: "NOT_RUN" as const,
    proposal,
  };
  return deepFreeze({ ...body, artifactSha256: benchmarkArtifactSha256(body) });
}

export function validateDeterministicHealingProposal(
  artifact: DeterministicHealingProposalArtifact,
): void {
  const { artifactSha256, ...body } = artifact;
  if (
    !/^[a-f0-9]{64}$/u.test(artifactSha256) ||
    artifactSha256 !== benchmarkArtifactSha256(body)
  ) {
    throw new Error("deterministic healing proposal artifact hash mismatch");
  }
  if (
    artifact.schemaVersion !== 1 ||
    artifact.kind !== "deterministic_healing_proposal" ||
    artifact.dataClass !== "open_data" ||
    artifact.baselineMode !== "synthetic_deterministic_failure_fixture" ||
    artifact.providerAcceptanceVerdict !== "NOT_RUN" ||
    artifact.proposal.status !== "awaiting_owner_approval" ||
    !artifact.proposal.zeroRegressionPassed
  ) {
    throw new Error("deterministic healing proposal semantics mismatch");
  }
}

export async function createDeterministicHealingProposal(): Promise<DeterministicHealingProposalArtifact> {
  const run = await runBoundedPreReleaseHealing({
    baseProfile: BASE_PROFILE,
    failures: [FAILURE],
    openRegressions: [ORDINARY_REGRESSION],
    costCeilings: {
      minimizationUsd: 0,
      reproductionUsd: 0,
      proposalUsd: 0,
      evaluationUsd: 0,
    },
    minimizeFailure: async (failure) => ({
      regressionCase: await minimizeRegressionCase(
        failure,
        async (sourceText) => sourceText
          .normalize("NFKC")
          .toLocaleLowerCase("en-US")
          .includes(failure.sourceTerm.toLocaleLowerCase("en-US")),
      ),
      costUsd: 0,
    }),
    reproduceFailure: async (failure, minimizedSourceText) => ({
      reproduced: minimizedSourceText
        .normalize("NFKC")
        .toLocaleLowerCase("en-US")
        .includes(failure.sourceTerm.toLocaleLowerCase("en-US")),
      costUsd: 0,
    }),
    propose: async () => ({
      patch: {
        rationale: "Apply the reproduced open-data term family across all release surfaces.",
        systemPrompt:
          "Translate accurately. Preserve owner-approved manufacturing terminology exactly.",
        backgroundHarness:
          "Run every approved open-data regression, including regression:keyless-abbe-offset.",
        glossary: [
          {
            id: "abbe-offset",
            source: "Abbe offset",
            aliases: ["Abbey offset"],
            targetExact: "阿貝偏移",
          },
          {
            id: "poka-yoke-pin",
            source: "poka-yoke pin",
            aliases: [],
            targetExact: "防呆銷已損壞",
          },
          {
            id: "reverse-abbe-error",
            source: "Check the Abbe error.",
            aliases: [],
            targetExact: "阿貝誤差",
          },
          {
            id: "reverse-poka-yoke-fixture",
            source: "Verify the poka-yoke fixture.",
            aliases: [],
            targetExact: "防呆治具",
          },
        ],
      },
      costUsd: 0,
    }),
    evaluate: async (_profile, regressions) => ({
      outputs: regressions.map((regression) => ({
        caseId: regression.caseId,
        actualTargetText: regression.assertion.kind === "contains"
          ? regression.assertion.text
          : "deterministic output without excluded text",
      })),
      costUsd: 0,
    }),
  });
  if (run.status !== "awaiting_owner_approval") {
    throw new Error(`Deterministic healing unexpectedly blocked: ${run.reason}`);
  }
  return proposalArtifact(run);
}

function ownerKeyId(publicKey: ReturnType<typeof createPublicKey>): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function approvedArtifact(
  proposalArtifactSha256: string,
  approvedProfile: ApprovedHealingProfile,
  ownerPrivateKey: string | Buffer,
): ApprovedProfileArtifact {
  const privateKey = createPrivateKey(ownerPrivateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("owner signing key must be Ed25519");
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "owner_signed_approved_healing_profile" as const,
    approvalAssurance: "local_ed25519_owner_signature" as const,
    trustAnchorSource: "operator_supplied_test_key" as const,
    customerOwnerAcceptanceVerdict: "NOT_RUN" as const,
    proposalArtifactSha256,
    providerAcceptanceVerdict: "NOT_RUN" as const,
    approvedProfile,
  };
  const artifactSha256 = benchmarkArtifactSha256(body);
  const publicKey = createPublicKey(privateKey);
  return deepFreeze({
    ...body,
    artifactSha256,
    ownerSignature: {
      algorithm: "Ed25519" as const,
      keyIdSha256: ownerKeyId(publicKey),
      signedArtifactSha256: artifactSha256,
      signatureBase64: sign(
        null,
        Buffer.from(artifactSha256, "hex"),
        privateKey,
      ).toString("base64"),
    },
  });
}

export function validateApprovedProfileArtifact(
  artifact: ApprovedProfileArtifact,
  trustedOwnerPublicKey: string | Buffer,
): void {
  const { artifactSha256, ownerSignature, ...body } = artifact;
  if (
    !/^[a-f0-9]{64}$/u.test(artifactSha256) ||
    artifactSha256 !== benchmarkArtifactSha256(body)
  ) {
    throw new Error("approved profile artifact hash mismatch");
  }
  if (
    artifact.schemaVersion !== 1 ||
    artifact.kind !== "owner_signed_approved_healing_profile" ||
    artifact.approvalAssurance !== "local_ed25519_owner_signature" ||
    artifact.trustAnchorSource !== "operator_supplied_test_key" ||
    artifact.customerOwnerAcceptanceVerdict !== "NOT_RUN" ||
    artifact.providerAcceptanceVerdict !== "NOT_RUN" ||
    artifact.approvedProfile.status !== "approved_frozen" ||
    hashHealingProfile(artifact.approvedProfile.profile) !==
      artifact.approvedProfile.profileHash ||
    ownerSignature.algorithm !== "Ed25519" ||
    ownerSignature.signedArtifactSha256 !== artifactSha256
  ) {
    throw new Error("approved profile artifact semantics mismatch");
  }
  const publicKey = createPublicKey(trustedOwnerPublicKey);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("trusted owner public key must be Ed25519");
  }
  const signature = Buffer.from(ownerSignature.signatureBase64, "base64");
  if (
    signature.toString("base64") !== ownerSignature.signatureBase64 ||
    ownerSignature.keyIdSha256 !== ownerKeyId(publicKey) ||
    !verify(null, Buffer.from(artifactSha256, "hex"), publicKey, signature)
  ) {
    throw new Error("approved profile owner signature mismatch");
  }
}

export function approveDeterministicHealingProposal(
  artifact: DeterministicHealingProposalArtifact,
  approval: OwnerApproval,
  ownerPrivateKey: string | Buffer,
): ApprovedProfileArtifact {
  validateDeterministicHealingProposal(artifact);
  return approvedArtifact(
    artifact.artifactSha256,
    approveHealingProposal(artifact.proposal, approval),
    ownerPrivateKey,
  );
}

export async function evaluateLocalReleaseGate(input: Readonly<{
  readonly benchmarkDirectory: string;
  readonly approvedProfile: ApprovedProfileArtifact;
  readonly trustedOwnerPublicKey: string | Buffer;
}>): Promise<LocalReleaseGateArtifact> {
  validateApprovedProfileArtifact(
    input.approvedProfile,
    input.trustedOwnerPublicKey,
  );
  const benchmark = await readAndValidateKeylessBenchmark(
    input.benchmarkDirectory,
  );
  if (benchmark.bundle.executionMode !== "default_local_relay") {
    throw new Error("release gate rejects test-only benchmark bundles");
  }
  const profileUnderTest = benchmark.profileUnderTest;
  if (
    profileUnderTest.approvedProfileArtifactSha256 !==
      input.approvedProfile.artifactSha256 ||
    profileUnderTest.profileHash !== input.approvedProfile.approvedProfile.profileHash ||
    benchmarkArtifactSha256(profileUnderTest.profile) !==
      benchmarkArtifactSha256(input.approvedProfile.approvedProfile.profile)
  ) {
    throw new Error("benchmark did not execute the exact signed approved profile");
  }

  const reasons: string[] = [];
  if (benchmark.score.localMechanismVerdict !== "PASS") {
    reasons.push("local Harness mechanism score did not pass");
  }
  if (benchmark.score.armVerdicts.GLOSSARY_CONTROLLED.verdict !== "PASS") {
    reasons.push("GLOSSARY_CONTROLLED local arm did not complete every gate");
  }
  const evidence = benchmark.score.localReleaseEvidence;
  if (!evidence.targetExact) reasons.push("target_exact gate did not pass");
  if (!evidence.zeroRegression) reasons.push("zero-regression gate did not pass");
  if (!evidence.alertsClear) reasons.push("runtime alert gate did not pass");
  if (!evidence.latency) reasons.push("latency evidence gate did not pass");
  if (!evidence.evidenceComplete) reasons.push("normalized event evidence gate did not pass");
  const body = {
    schemaVersion: 1 as const,
    kind: "local_poc_release_gate" as const,
    benchmarkBundleSha256: benchmark.bundle.bundleSha256,
    benchmarkScoreSha256: benchmark.score.scoreSha256,
    approvedProfileArtifactSha256: input.approvedProfile.artifactSha256,
    approvedProfileHash: input.approvedProfile.approvedProfile.profileHash,
    benchmarkProfileUnderTestSha256: profileUnderTest.profileUnderTestSha256,
    ownerKeyIdSha256: input.approvedProfile.ownerSignature.keyIdSha256,
    trustAnchorSource: input.approvedProfile.trustAnchorSource,
    customerOwnerAcceptanceVerdict: input.approvedProfile.customerOwnerAcceptanceVerdict,
    localPocReleaseVerdict: reasons.length === 0 ? "PASS" as const : "FAIL" as const,
    localReleaseEvidence: evidence,
    providerAcceptanceVerdict: "NOT_RUN" as const,
    productAcceptanceVerdict: "NOT_RUN" as const,
    reasons: Object.freeze(reasons),
  };
  return deepFreeze({ ...body, gateSha256: benchmarkArtifactSha256(body) });
}

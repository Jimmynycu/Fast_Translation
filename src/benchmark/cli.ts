import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAITextTranslator } from "../adapters/openai/text-translator.js";
import {
  DEFAULT_DISCOVERY_EXECUTION_BUDGET,
  DISCOVERY_CANDIDATES,
  runBudgetedTerminologyDiscovery,
} from "./discovery.js";
import { DEFAULT_HEALING_BUDGET, DEFAULT_HEALING_COST_CEILINGS, openFailureFromDiscovery } from "./healing.js";
import { EXECUTABLE_BENCHMARK_MANIFEST, validateExecutableBenchmarkManifest } from "./executable-manifest.js";
import { BENCHMARK_WORKLOAD } from "./protocol.js";
import { runMechanismSelfCheck } from "./self-check.js";
import {
  approveDeterministicHealingProposal,
  createDeterministicHealingProposal,
  evaluateLocalReleaseGate,
  validateApprovedProfileArtifact,
  type ApprovedProfileArtifact,
  type DeterministicHealingProposalArtifact,
} from "./release.js";
import {
  createBenchmarkProfileUnderTest,
  executeKeylessBenchmark,
} from "./runner.js";
import { generateOperatorTestOwnerKeyFiles } from "./owner-key.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function output(value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2) + "\n";
  const path = argument("--output");
  if (path === undefined) process.stdout.write(json);
  else await writeFile(path, json, "utf8");
}
function requiredArgument(name: string): string {
  const value = argument(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeArtifact(
  directory: string,
  fileName: string,
  value: unknown,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, fileName);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

async function ownerKeygen(): Promise<void> {
  const generated = await generateOperatorTestOwnerKeyFiles(requiredArgument("--output-directory"));
  await output({
    ...generated.summary,
    outputDirectory: generated.outputDirectory,
    privateKeyPath: generated.privateKeyPath,
    publicKeyPath: generated.publicKeyPath,
    summaryPath: generated.summaryPath,
  });
}

async function runLocal(): Promise<void> {
  const artifactDirectory = requiredArgument("--artifact-dir");
  const approvedProfile = await readJson<ApprovedProfileArtifact>(
    requiredArgument("--approved-profile"),
  );
  const trustedOwnerPublicKey = await readFile(
    requiredArgument("--owner-public-key"),
  );
  validateApprovedProfileArtifact(approvedProfile, trustedOwnerPublicKey);
  const profileUnderTest = createBenchmarkProfileUnderTest({
    approvedProfileArtifactSha256: approvedProfile.artifactSha256,
    profile: approvedProfile.approvedProfile.profile,
  });
  const execution = await executeKeylessBenchmark({
    outputDirectory: artifactDirectory,
    profileUnderTest,
  });
  await output({
    kind: "keyless_benchmark_complete",
    artifactDirectory,
    profileUnderTestSha256: profileUnderTest.profileUnderTestSha256,
    profileHash: profileUnderTest.profileHash,
    bundleSha256: execution.bundle.bundleSha256,
    scoreSha256: execution.score.scoreSha256,
    localMechanismVerdict: execution.score.localMechanismVerdict,
    providerAcceptanceVerdict: execution.score.providerAcceptanceVerdict,
    productAcceptanceVerdict: execution.score.productAcceptanceVerdict,
    passCount: execution.results.filter((result) => result.outcome === "PASS").length,
    notRunCount: execution.results.filter((result) => result.outcome === "NOT_RUN").length,
    failCount: execution.results.filter((result) => result.outcome === "FAIL").length,
  });
}

async function proposeHealing(): Promise<void> {
  const artifactDirectory = requiredArgument("--artifact-dir");
  const artifact = await createDeterministicHealingProposal();
  const artifactPath = await writeArtifact(
    artifactDirectory,
    "healing-proposal.json",
    artifact,
  );
  await output({
    kind: artifact.kind,
    artifactPath,
    artifactSha256: artifact.artifactSha256,
    status: artifact.proposal.status,
    baseProfileHash: artifact.proposal.baseProfileHash,
    proposedDiffHash: artifact.proposal.proposedDiffHash,
    providerAcceptanceVerdict: artifact.providerAcceptanceVerdict,
  });
}

async function approveHealing(): Promise<void> {
  const artifactDirectory = requiredArgument("--artifact-dir");
  const proposalPath = requiredArgument("--proposal");
  const proposal = await readJson<DeterministicHealingProposalArtifact>(proposalPath);
  const ownerPrivateKey = await readFile(
    requiredArgument("--owner-private-key"),
  );
  const approved = approveDeterministicHealingProposal(proposal, {
    owner: requiredArgument("--owner"),
    approvedAt: requiredArgument("--approved-at"),
    baseProfileHash: requiredArgument("--base-profile-hash"),
    proposedDiffHash: requiredArgument("--proposed-diff-hash"),
  }, ownerPrivateKey);
  const artifactPath = await writeArtifact(
    artifactDirectory,
    "approved-profile.json",
    approved,
  );
  await output({
    kind: approved.kind,
    artifactPath,
    artifactSha256: approved.artifactSha256,
    profileHash: approved.approvedProfile.profileHash,
    trustAnchorSource: approved.trustAnchorSource,
    customerOwnerAcceptanceVerdict: approved.customerOwnerAcceptanceVerdict,
    providerAcceptanceVerdict: approved.providerAcceptanceVerdict,
  });
}

async function releaseGate(): Promise<void> {
  const artifactDirectory = requiredArgument("--artifact-dir");
  const approvedProfile = await readJson<ApprovedProfileArtifact>(
    requiredArgument("--approved-profile"),
  );
  const trustedOwnerPublicKey = await readFile(
    requiredArgument("--owner-public-key"),
  );
  const gate = await evaluateLocalReleaseGate({
    benchmarkDirectory: requiredArgument("--benchmark-dir"),
    approvedProfile,
    trustedOwnerPublicKey,
  });
  const artifactPath = await writeArtifact(
    artifactDirectory,
    "release-gate.json",
    gate,
  );
  await output({
    kind: gate.kind,
    artifactPath,
    gateSha256: gate.gateSha256,
    localPocReleaseVerdict: gate.localPocReleaseVerdict,
    trustAnchorSource: gate.trustAnchorSource,
    customerOwnerAcceptanceVerdict: gate.customerOwnerAcceptanceVerdict,
    providerAcceptanceVerdict: gate.providerAcceptanceVerdict,
    productAcceptanceVerdict: gate.productAcceptanceVerdict,
    reasons: gate.reasons,
  });
}


async function discover(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error("OPENAI_API_KEY is required for live baseline discovery");
  }
  const model = process.env.OPENAI_TEXT_MODEL ?? "gpt-5.4-mini";
  const translator = new OpenAITextTranslator({
    apiKey,
    model,
  });
  const budgetedDiscovery = await runBudgetedTerminologyDiscovery(
    async (candidate, _render, grant) => ({
      output: await translator.translate({
        text: candidate.sourceSentence,
        sourceLanguage: candidate.sourceLanguage,
        targetLanguage: candidate.targetLanguage,
        signal: grant.signal,
        maxOutputTokens: grant.maxOutputTokens,
      }),
      costUsd: grant.maximumCostUsd,
    }),
    DISCOVERY_CANDIDATES,
    BENCHMARK_WORKLOAD.discoveryRendersPerCandidate,
    DEFAULT_DISCOVERY_EXECUTION_BUDGET,
    {
      sourceSet: "builtin-manufacturing-candidates-v1",
      provider: "openai-responses",
      model,
      configuration: Object.freeze({
        responseFormat: "translation-only",
        maxOutputTokens: String(DEFAULT_DISCOVERY_EXECUTION_BUDGET.maxOutputTokens),
        costAccounting: "preauthorized_per_call_ceiling",
      }),
    },
  );
  const { discovery, ...discoveryExecution } = budgetedDiscovery;
  const { failures } = discovery;
  await output({
    kind: "live_text_baseline_discovery",
    discovery,
    discoveryExecution,
    failures,
    healingInput: Object.freeze({
      dataClass: "open_data",
      failures: failures.map(openFailureFromDiscovery),
      hardBudget: DEFAULT_HEALING_BUDGET,
      perCallCostCeilings: DEFAULT_HEALING_COST_CEILINGS,
    }),
    nextStep:
      "Minimize each open-data failure, run bounded healing and zero-regression, then obtain exact base-hash plus diff approval from the Glossary Owner.",
  });
}

async function main(): Promise<void> {
  const commandArgumentIndex = process.argv[2] === "--" ? 3 : 2;
  const command = process.argv[commandArgumentIndex] ?? "self-check";
  switch (command) {
    case "owner-keygen":
      await ownerKeygen();
      return;
    case "self-check":
      await output(runMechanismSelfCheck());
      return;
    case "protocol":
      validateExecutableBenchmarkManifest();
      await output({ workload: BENCHMARK_WORKLOAD, manifest: EXECUTABLE_BENCHMARK_MANIFEST });
      return;
    case "run-local":
      await runLocal();
      return;
    case "healing-propose":
      await proposeHealing();
      return;
    case "healing-approve":
      await approveHealing();
      return;
    case "release-gate":
      await releaseGate();
      return;
    case "discover":
      await discover();
      return;
    default:
      throw new Error(`Unknown benchmark command: ${command}`);
  }
}

await main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "Benchmark failed") + "\n");
  process.exitCode = 1;
});

import { writeFile } from "node:fs/promises";
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
  const command = process.argv[2] ?? "self-check";
  switch (command) {
    case "self-check":
      await output(runMechanismSelfCheck());
      return;
    case "protocol":
      validateExecutableBenchmarkManifest();
      await output({ workload: BENCHMARK_WORKLOAD, manifest: EXECUTABLE_BENCHMARK_MANIFEST });
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

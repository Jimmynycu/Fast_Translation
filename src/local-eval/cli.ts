import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { replayLocalEvalCorpus } from "./corpus-replay.js";
import { assertContainedPath } from "./path-safety.js";

interface CliOptions {
  readonly manifestPath: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly outputPath: string;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  const supported = new Set([
    "--manifest",
    "--source-language",
    "--target-language",
    "--output",
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || !supported.has(flag)) {
      throw new TypeError("Unknown local evaluation replay argument " + (flag ?? ""));
    }
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(flag + " requires a value");
    }
    if (values.has(flag)) throw new TypeError(flag + " may be specified only once");
    values.set(flag, value);
  }

  const sourceLanguage = values.get("--source-language");
  const targetLanguage = values.get("--target-language");
  if (sourceLanguage === undefined || targetLanguage === undefined) {
    throw new TypeError("--source-language and --target-language are required");
  }

  return Object.freeze({
    manifestPath: resolve(
      values.get("--manifest") ?? "./work/tmp/local-eval-corpus/manifest.json",
    ),
    sourceLanguage,
    targetLanguage,
    outputPath: resolve(
      values.get("--output") ?? "./work/tmp/local-eval-corpus/replay-report.json",
    ),
  });
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const outputPath = await assertContainedPath(
    options.outputPath,
    process.cwd(),
    "--output",
  );
  const report = await replayLocalEvalCorpus({
    manifestPath: options.manifestPath,
    sourceLanguage: options.sourceLanguage,
    targetLanguage: options.targetLanguage,
  });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, undefined, 2) + "\n", "utf8");
  console.log(
    "Local evaluation replay: " + report.summary.passed + "/" +
      report.summary.total + " fixtures passed",
  );
  console.log("Report: " + outputPath);
  console.log(
    "Transcript source: manifest fixture text; acoustic STT was not evaluated.",
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error(
      "Local evaluation replay failed: " +
        (error instanceof Error ? error.message : String(error)),
    );
    process.exitCode = 1;
  });
}

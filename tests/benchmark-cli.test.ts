import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const taskTemp = join(process.cwd(), "work", "tmp", "benchmark-cli-tests");
const builtCli = resolve(process.cwd(), "dist-test", "src", "benchmark", "cli.js");

function spawnBuiltCli(args: readonly string[], timeout = 10_000) {
  return spawnSync(process.execPath, [builtCli, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TEMP: resolve(process.cwd(), "work", "tmp"),
      TMP: resolve(process.cwd(), "work", "tmp"),
      TMPDIR: resolve(process.cwd(), "work", "tmp"),
    },
    timeout,
  });
}

describe("mechanism-only benchmark CLI", () => {
  it("runs the default pnpm benchmark command as a mechanism-only report with provider and product limits", () => {
    const pnpmExecutable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const command = process.platform === "win32"
      ? `${pnpmExecutable} benchmark`
      : pnpmExecutable;
    const result = spawnSync(command, process.platform === "win32" ? [] : ["benchmark"], {
      cwd: process.cwd(),
      encoding: "utf8",
      ...(process.platform === "win32" ? { shell: true } : {}),
      env: {
        ...process.env,
        NO_COLOR: "1",
        TEMP: resolve(process.cwd(), "work", "tmp"),
        TMP: resolve(process.cwd(), "work", "tmp"),
        TMPDIR: resolve(process.cwd(), "work", "tmp"),
      },
      timeout: 30_000,
    });

    assert.equal(result.error, undefined, result.error?.message ?? "benchmark CLI spawn failed");
    assert.equal(result.signal, null, "benchmark CLI timed out");
    assert.equal(result.status, 0, result.stderr);
    const jsonStart = result.stdout.indexOf("{");
    assert.notEqual(jsonStart, -1, result.stdout);
    const report = JSON.parse(result.stdout.slice(jsonStart)) as {
      verdict?: string;
      acceptanceVerdict?: string;
      limitations?: unknown;
    };
    assert.equal(report.verdict, "MECHANISM_PASS");
    assert.equal(report.acceptanceVerdict, "NOT_RUN");
    assert.ok(Array.isArray(report.limitations));
    assert.equal(report.limitations.some((limitation) =>
      limitation === "Provider acceptance remains NOT_RUN: no STT, translation, TTS, or Palabra execution was run."
    ), true);
    assert.equal(report.limitations.some((limitation) =>
      limitation === "Product acceptance remains NOT_RUN: no acoustic latency, human review, or product go/no-go validation was run."
    ), true);
  });

  it("requires an explicit model before discovery can make a network call", async () => {
    const directory = join(taskTemp, "missing-model");
    const markerPath = join(directory, "network-called");
    const probePath = join(directory, "network-probe.mjs");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    await writeFile(
      probePath,
      [
        'import { writeFileSync } from "node:fs";',
        "globalThis.fetch = async () => {",
        '  writeFileSync(process.env.BENCHMARK_CLI_NETWORK_MARKER, "called");',
        '  throw new Error("network must not be reached");',
        "};",
      ].join("\n"),
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(probePath).href,
          resolve(process.cwd(), "dist-test", "src", "benchmark", "cli.js"),
          "discover",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENAI_API_KEY: "test-openai-key",
            OPENAI_TEXT_MODEL: "legacy-model-must-not-be-used",
            BENCHMARK_CLI_NETWORK_MARKER: markerPath,
            TEMP: resolve(process.cwd(), "work", "tmp"),
            TMP: resolve(process.cwd(), "work", "tmp"),
            TMPDIR: resolve(process.cwd(), "work", "tmp"),
          },
          timeout: 10_000,
        },
      );

      assert.equal(result.error, undefined, result.error?.message ?? "discovery CLI spawn failed");
      assert.equal(result.signal, null, "discovery CLI timed out");
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /--model is required/u);
      await assert.rejects(access(markerPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("runs the built self-check with exact JSON stdout and no preamble", () => {
    const result = spawnBuiltCli(["self-check"]);
    assert.equal(result.error, undefined, result.error?.message ?? "self-check spawn failed");
    assert.equal(result.signal, null, "self-check timed out");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.startsWith("{"), true, result.stdout);
    const report = JSON.parse(result.stdout) as { verdict?: string; acceptanceVerdict?: string };
    assert.equal(report.verdict, "MECHANISM_PASS");
    assert.equal(report.acceptanceVerdict, "NOT_RUN");
    assert.equal(result.stdout, JSON.stringify(report, null, 2) + "\n");
  });

  it("writes built self-check JSON to --output instead of stdout", async () => {
    const directory = join(taskTemp, "built-output");
    const outputPath = join(directory, "self-check.json");
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    try {
      const result = spawnBuiltCli(["self-check", "--output", outputPath]);
      assert.equal(result.error, undefined, result.error?.message ?? "output spawn failed");
      assert.equal(result.signal, null, "output command timed out");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      const content = await readFile(outputPath, "utf8");
      assert.equal(content.startsWith("{"), true, content);
      const report = JSON.parse(content) as { verdict?: string; acceptanceVerdict?: string };
      assert.equal(report.verdict, "MECHANISM_PASS");
      assert.equal(report.acceptanceVerdict, "NOT_RUN");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unknown built command with static stderr and no stdout", () => {
    const result = spawnBuiltCli(["unknown-command"]);
    assert.equal(result.error, undefined, result.error?.message ?? "unknown command spawn failed");
    assert.equal(result.signal, null, "unknown command timed out");
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Unknown benchmark command: unknown-command\n");
  });
});

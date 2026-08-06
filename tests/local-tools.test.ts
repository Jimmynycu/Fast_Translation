import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSecureContext } from "node:tls";
import { describe, it } from "node:test";

const powerShellProbe = process.platform === "win32"
  ? spawnSync("powershell.exe", ["-NoProfile", "-Command", "exit 0"])
  : undefined;
const localToolsUnavailable =
  process.platform !== "win32" ||
  powerShellProbe?.error !== undefined ||
  powerShellProbe?.status !== 0;

function runPowerShell(script: string, args: readonly string[]) {
  const localTemp = resolve(process.cwd(), "work", "tmp");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: localTemp,
        TMP: localTemp,
        TMPDIR: localTemp,
      },
    },
  );
}

describe("keyless local tools", () => {
  it("generates a phone-trustable LAN certificate chain and Node TLS key pair", {
    skip: localToolsUnavailable,
    timeout: 30_000,
  }, async () => {
    const relativeDirectory = "work/tmp/tool-tests/tls-" + randomUUID();
    const absoluteDirectory = resolve(process.cwd(), relativeDirectory);
    try {
      const result = runPowerShell(
        resolve(process.cwd(), "scripts", "generate-lan-tls.ps1"),
        [
          "-OutputDirectory",
          relativeDirectory,
          "-DnsName",
          "relay.lan.test",
          "-IpAddress",
          "192.0.2.10",
        ],
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const [cert, key, metadataText] = await Promise.all([
        readFile(resolve(absoluteDirectory, "server-cert.pem"), "utf8"),
        readFile(resolve(absoluteDirectory, "server-key.pem"), "utf8"),
        readFile(resolve(absoluteDirectory, "metadata.json"), "utf8"),
      ]);
      assert.doesNotThrow(() => createSecureContext({ cert, key }));
      const metadata = JSON.parse(metadataText) as {
        dnsName: string;
        ipAddresses: string[];
        trustAnchorPath: string;
      };
      assert.equal(metadata.dnsName, "relay.lan.test");
      assert.deepEqual(metadata.ipAddresses, ["192.0.2.10"]);
      assert.equal(metadata.trustAnchorPath, "local-demo-ca.cer");
    } finally {
      await rm(absoluteDirectory, { recursive: true, force: true });
    }
  });

  it("renders replayable glossary source and alias WAV fixtures as canonical audio", {
    skip: localToolsUnavailable,
    timeout: 30_000,
  }, async () => {
    const relativeDirectory = "work/tmp/tool-tests/corpus-" + randomUUID();
    const absoluteDirectory = resolve(process.cwd(), relativeDirectory);
    try {
      const result = runPowerShell(
        resolve(process.cwd(), "scripts", "generate-local-eval-corpus.ps1"),
        [
          "-InputCsv",
          "examples/manufacturing-glossary.csv",
          "-OutputDirectory",
          relativeDirectory,
          "-Language",
          "en-US",
        ],
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const manifest = JSON.parse(
        await readFile(resolve(absoluteDirectory, "manifest.json"), "utf8"),
      ) as {
        schemaVersion: number;
        generator: string;
        fixtures: Array<{
          wavPath: string;
          wavSha256: string;
          phrase: string;
          targetExact: string;
        }>;
      };
      assert.equal(manifest.schemaVersion, 2);
      assert.ok([
        "Windows SAPI", "FFmpeg flite", "Windows SAPI + FFmpeg flite",
      ].includes(manifest.generator));
      assert.ok(manifest.fixtures.length > 0);
      assert.ok(manifest.fixtures.every((fixture) =>
        fixture.phrase.length > 0 && fixture.targetExact.length > 0
      ));
      const first = manifest.fixtures[0];
      assert.ok(first);
      const wav = await readFile(resolve(absoluteDirectory, first.wavPath));
      assert.equal(
        createHash("sha256").update(wav).digest("hex"),
        first.wavSha256,
      );
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.toString("ascii", 8, 12), "WAVE");
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt32LE(24), 24_000);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.ok(wav.byteLength > 44);
    } finally {
      await rm(absoluteDirectory, { recursive: true, force: true });
    }
  });
});

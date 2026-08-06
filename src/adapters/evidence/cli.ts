import { exportEncryptedEvidence } from "./export.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function evidenceKey(): Buffer {
  const encoded = process.env.EVIDENCE_ENCRYPTION_KEY_BASE64;
  if (
    encoded === undefined ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded.trim())
  ) {
    throw new Error("EVIDENCE_ENCRYPTION_KEY_BASE64 is required");
  }
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.byteLength !== 32) {
    throw new Error("EVIDENCE_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
  }
  return key;
}

async function main(): Promise<void> {
  if (!process.argv.includes("--acknowledge-plaintext-export")) {
    throw new Error(
      "--acknowledge-plaintext-export is required because output files contain decrypted evidence",
    );
  }
  const manifest = await exportEncryptedEvidence({
    encryptedPath: requiredArgument("--input"),
    outputDirectory: requiredArgument("--output-dir"),
    key: evidenceKey(),
  });
  process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
}

await main().catch((error: unknown) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Evidence export failed") + "\n",
  );
  process.exitCode = 1;
});

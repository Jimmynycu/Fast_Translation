import { createHash, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertContainedPath } from "../local-eval/path-safety.js";

export const OPERATOR_TEST_TRUST_ANCHOR = "operator_supplied_test_key" as const;
export const CUSTOMER_OWNER_ACCEPTANCE_VERDICT = "NOT_RUN" as const;

export interface OperatorTestOwnerKeySummary {
  readonly schemaVersion: 1;
  readonly kind: "operator_test_owner_key";
  readonly algorithm: "Ed25519";
  readonly trustAnchorSource: typeof OPERATOR_TEST_TRUST_ANCHOR;
  readonly customerOwnerAcceptanceVerdict: typeof CUSTOMER_OWNER_ACCEPTANCE_VERDICT;
  readonly keyIdSha256: string;
  readonly privateKeyFile: "owner-private-key.pem";
  readonly publicKeyFile: "owner-public-key.pem";
}

export interface GeneratedOperatorTestOwnerKeyFiles {
  readonly outputDirectory: string;
  readonly privateKeyPath: string;
  readonly publicKeyPath: string;
  readonly summaryPath: string;
  readonly summary: OperatorTestOwnerKeySummary;
}

export function ownerKeyIdSha256(publicKey: KeyObject | string | Buffer): string {
  const key = createPublicKey(publicKey);
  const der = key.export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

async function assertWorkspaceLocalDirectory(outputDirectory: string): Promise<string> {
  const workspaceRoot = resolve(process.cwd());
  const resolvedDirectory = resolve(workspaceRoot, outputDirectory);
  const relativeDirectory = relative(workspaceRoot, resolvedDirectory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(".." + sep) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new Error("owner key output directory must be a non-root path inside the workspace");
  }
  return assertContainedPath(
    resolvedDirectory,
    workspaceRoot,
    "owner key output directory",
  );
}

async function assertDoesNotExist(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("refusing to overwrite existing owner key artifact: " + basename(path));
}

export async function generateOperatorTestOwnerKeyFiles(
  outputDirectory: string,
): Promise<GeneratedOperatorTestOwnerKeyFiles> {
  const resolvedDirectory = await assertWorkspaceLocalDirectory(outputDirectory);
  const privateKeyPath = join(resolvedDirectory, "owner-private-key.pem");
  const publicKeyPath = join(resolvedDirectory, "owner-public-key.pem");
  const summaryPath = join(resolvedDirectory, "owner-key-summary.json");
  await Promise.all([privateKeyPath, publicKeyPath, summaryPath].map(assertDoesNotExist));
  await mkdir(resolvedDirectory, { recursive: true });

  const keyPair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const keyIdSha256 = ownerKeyIdSha256(keyPair.publicKey);
  const summary: OperatorTestOwnerKeySummary = Object.freeze({
    schemaVersion: 1,
    kind: "operator_test_owner_key",
    algorithm: "Ed25519",
    trustAnchorSource: OPERATOR_TEST_TRUST_ANCHOR,
    customerOwnerAcceptanceVerdict: CUSTOMER_OWNER_ACCEPTANCE_VERDICT,
    keyIdSha256,
    privateKeyFile: "owner-private-key.pem",
    publicKeyFile: "owner-public-key.pem",
  });
  await writeFile(privateKeyPath, keyPair.privateKey, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(publicKeyPath, keyPair.publicKey, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(summaryPath, JSON.stringify(summary, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return Object.freeze({
    outputDirectory: resolvedDirectory,
    privateKeyPath,
    publicKeyPath,
    summaryPath,
    summary,
  });
}
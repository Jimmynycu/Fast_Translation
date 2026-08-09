import {
  SessionArtifactStore,
  type SessionArtifactStoreOptions,
} from "./session-artifact-store.js";

const ROOT_KEY_NAME = "EVIDENCE_ROOT_KEY_BASE64";
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_HTTP_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LOOPBACK_HTTP_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export interface ManagedEvidenceExportCliRuntime {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

interface ParsedArguments {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function normalizedArguments(arguments_: readonly string[]): readonly string[] {
  return arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
}

function parseArguments(
  arguments_: readonly string[],
  valueNames: readonly string[],
  flagNames: readonly string[],
): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const supportedValues = new Set(valueNames);
  const supportedFlags = new Set(flagNames);
  const normalized = normalizedArguments(arguments_);
  for (let index = 0; index < normalized.length; index += 1) {
    const name = normalized[index];
    if (name === undefined) break;
    if (supportedFlags.has(name)) {
      if (flags.has(name)) throw new TypeError(name + " may be specified only once");
      flags.add(name);
      continue;
    }
    if (!supportedValues.has(name)) {
      const safeName = /^--[A-Za-z0-9-]+$/u.test(name) ? name : "<invalid>";
      throw new TypeError("Unknown evidence administration argument " + safeName);
    }
    const value = normalized[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TypeError(name + " requires a value");
    }
    if (values.has(name)) throw new TypeError(name + " may be specified only once");
    values.set(name, value);
    index += 1;
  }
  return Object.freeze({ values, flags });
}

function requiredValue(values: ReadonlyMap<string, string>, name: string): string {
  const raw = values.get(name);
  const value = raw?.trim();
  if (value === undefined || value.length === 0) throw new TypeError(name + " is required");
  if (raw !== value) throw new TypeError(name + " must not contain surrounding whitespace");
  return value;
}

function requiredCanonicalCommandId(values: ReadonlyMap<string, string>): string {
  const commandId = requiredValue(values, "--command-id");
  if (!CANONICAL_UUID.test(commandId)) {
    throw new TypeError("--command-id must be a canonical UUID");
  }
  return commandId;
}

function rootKey(environment: NodeJS.ProcessEnv): Uint8Array {
  const encoded = environment[ROOT_KEY_NAME]?.trim();
  if (encoded === undefined || encoded.length === 0) {
    throw new Error(ROOT_KEY_NAME + " is required for local-admin evidence operations");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error(ROOT_KEY_NAME + " must be canonical Base64");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== encoded) {
    throw new Error(ROOT_KEY_NAME + " must be canonical Base64 for exactly 32 bytes");
  }
  return Uint8Array.from(decoded);
}

function assertLocalAdmin(flags: ReadonlySet<string>): void {
  if (!flags.has("--local-admin")) {
    throw new Error("--local-admin is required for an offline root-key operation");
  }
}

function parseOfflineEvidenceArguments(arguments_: readonly string[]): ParsedArguments {
  return parseArguments(
    arguments_,
    ["--archive-root", "--key-root", "--export-root", "--receipt-root"],
    ["--local-admin", "--acknowledge-plaintext-export"],
  );
}

function createOfflineEvidenceStoreFromParsed(
  parsed: ParsedArguments,
  environment: NodeJS.ProcessEnv,
): Readonly<{ store: SessionArtifactStore; parsed: ParsedArguments }> {
  assertLocalAdmin(parsed.flags);
  const storeOptions: SessionArtifactStoreOptions = {
    archiveDirectory: requiredValue(parsed.values, "--archive-root"),
    keyDirectory: requiredValue(parsed.values, "--key-root"),
    exportDirectory: requiredValue(parsed.values, "--export-root"),
    receiptDirectory: requiredValue(parsed.values, "--receipt-root"),
    rootKey: rootKey(environment),
  };
  return Object.freeze({ store: new SessionArtifactStore(storeOptions), parsed });
}

/**
 * Offline administration is retained only for encrypted retention sweeping.
 * Plaintext export never constructs a Store from a root key.
 */
export function createOfflineEvidenceStore(
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{ store: SessionArtifactStore; parsed: ParsedArguments }> {
  return createOfflineEvidenceStoreFromParsed(
    parseOfflineEvidenceArguments(arguments_),
    environment,
  );
}

export async function withOfflineEvidenceRootLease<T>(
  store: SessionArtifactStore,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await store.acquireEvidenceRootLease("offline_admin");
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

function parseManagedExportArguments(arguments_: readonly string[]): ParsedArguments {
  return parseArguments(
    arguments_,
    ["--base-url", "--session-id", "--command-id"],
    ["--acknowledge-plaintext-export"],
  );
}

function requiredBaseUrl(values: ReadonlyMap<string, string>): URL {
  const value = requiredValue(values, "--base-url");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("--base-url must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("--base-url must be a valid HTTP(S) URL");
  }
  const exactLoopbackHttp = url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol === "http:" && !exactLoopbackHttp) {
    throw new TypeError("--base-url must use HTTPS unless it targets exact loopback HTTP");
  }
  if (url.port === "0") {
    throw new TypeError("--base-url has an unsafe port");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError("--base-url must be an origin without credentials or a path");
  }
  return url;
}

function requiredSessionId(values: ReadonlyMap<string, string>): string {
  const sessionId = requiredValue(values, "--session-id");
  if (
    sessionId.length > 256 ||
    /[\u0000-\u001f\u007f/\\]/u.test(sessionId)
  ) {
    throw new TypeError("--session-id is invalid");
  }
  return sessionId;
}

function requiredAccessToken(environment: NodeJS.ProcessEnv): string {
  const raw = environment.EVIDENCE_OWNER_ACCESS_TOKEN;
  const token = raw?.trim();
  if (token === undefined || token.length === 0) {
    throw new Error("EVIDENCE_OWNER_ACCESS_TOKEN is required");
  }
  if (raw !== token) {
    throw new Error("EVIDENCE_OWNER_ACCESS_TOKEN must not contain surrounding whitespace");
  }
  if (token.length > 4096 || /[\r\n]/u.test(token)) {
    throw new Error("EVIDENCE_OWNER_ACCESS_TOKEN is invalid");
  }
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error("Evidence export response was invalid");
  }
  return value;
}

function requiredNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Evidence export response was invalid");
  }
  return value;
}

function safeCompletedExportPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || value.status !== "completed") {
    throw new Error("Evidence export response was invalid");
  }
  const trackDigestsValue = value.trackDigests;
  if (!isRecord(trackDigestsValue)) throw new Error("Evidence export response was invalid");
  const trackDigests: Record<string, Readonly<{ recordCount: number; sha256: string }>> = {};
  for (const track of ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const) {
    const digest = trackDigestsValue[track];
    if (!isRecord(digest)) throw new Error("Evidence export response was invalid");
    trackDigests[track] = Object.freeze({
      recordCount: requiredNonNegativeInteger(digest.recordCount),
      sha256: requiredSha256(digest.sha256),
    });
  }
  if (typeof value.exportId !== "string" || !SHA256_HEX.test(value.exportId)) {
    throw new Error("Evidence export response was invalid");
  }
  if (typeof value.retentionDeadlineAt !== "string" || value.retentionDeadlineAt.length === 0) {
    throw new Error("Evidence export response was invalid");
  }
  return Object.freeze({
    status: "completed",
    exportId: value.exportId,
    manifestFileSha256: requiredSha256(value.manifestFileSha256),
    processingManifestSha256: requiredSha256(value.processingManifestSha256),
    finalizationManifestSha256: requiredSha256(value.finalizationManifestSha256),
    retentionDeadlineAt: value.retentionDeadlineAt,
    recordCount: requiredNonNegativeInteger(value.recordCount),
    finalChainSha256: requiredSha256(value.finalChainSha256),
    evidenceSealSha256: requiredSha256(value.evidenceSealSha256),
    trackDigests: Object.freeze(trackDigests),
  });
}

function httpFailure(status: number): Error {
  switch (status) {
    case 401:
      return new Error("Evidence export authorization failed");
    case 404:
      return new Error("Evidence export target was not found");
    case 409:
      return new Error("Managed evidence export command conflicted");
    case 410:
      return new Error("Managed evidence export retention has expired");
    case 503:
      return new Error("Evidence retention is unavailable");
    default:
      return new Error("Evidence export request failed");
  }
}

async function requestManagedExport(
  baseUrl: URL,
  sessionId: string,
  accessToken: string,
  commandId: string,
  runtime: ManagedEvidenceExportCliRuntime,
): Promise<Readonly<Record<string, unknown>>> {
  let encodedSessionId: string;
  try {
    encodedSessionId = encodeURIComponent(sessionId);
  } catch {
    throw new Error("--session-id is invalid");
  }
  const endpoint = new URL(
    "api/sessions/" + encodedSessionId + "/evidence/exports",
    baseUrl,
  );
  const fetchImplementation = runtime.fetch ?? fetch;
  const timeoutMs = runtime.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Evidence export request timed out");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let response: Response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ commandId, acknowledgePlaintextExport: true }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    throw new Error(timedOut ? "Evidence export request timed out" : "Evidence export request failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    clearTimeout(timeout);
    throw httpFailure(response.status);
  }
  try {
    const body = response.body;
    if (body === null) throw new Error("Evidence export response was invalid");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Evidence export response was invalid");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("Evidence export response was invalid");
    }
    return safeCompletedExportPayload(parsed);
  } catch (error: unknown) {
    if (timedOut) throw new Error("Evidence export request timed out");
    if (error instanceof Error && error.message === "Evidence export response was invalid") {
      throw error;
    }
    throw new Error("Evidence export response was invalid");
  } finally {
    clearTimeout(timeout);
  }
}

export async function runManagedEvidenceExportCli(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  runtime: ManagedEvidenceExportCliRuntime = {},
): Promise<void> {
  const parsed = parseManagedExportArguments(arguments_);
  if (!parsed.flags.has("--acknowledge-plaintext-export")) {
    throw new Error(
      "--acknowledge-plaintext-export is required because output files contain decrypted evidence",
    );
  }
  const result = await requestManagedExport(
    requiredBaseUrl(parsed.values),
    requiredSessionId(parsed.values),
    requiredAccessToken(environment),
    requiredCanonicalCommandId(parsed.values),
    runtime,
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (import.meta.main) {
  await runManagedEvidenceExportCli().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "Evidence export failed") + "\n",
    );
    process.exitCode = 1;
  });
}

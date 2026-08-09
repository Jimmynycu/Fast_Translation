import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { MEDIA_PROFILES, type MediaProfile } from "./core/types.js";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const requiredToken = z.string().min(32).max(512).regex(/^\S+$/u, "must not contain whitespace");
const optionalOperatorToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  requiredToken.optional(),
);
const requiredIdentity = z.string().min(1).max(512).regex(/^\S+$/u, "must not contain whitespace");
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, "must be lowercase SHA-256 hex");
const loopbackHttpHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const exactLoopbackBindHosts = new Set(["127.0.0.1", "::1", "[::1]"]);
const exactLoopbackHttpUrl = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?]|$)/iu;

function decodeRootKey(value: string): Buffer | undefined {
  const key = Buffer.from(value, "base64");
  return key.byteLength === 32 && key.toString("base64") === value ? key : undefined;
}

function parsePublicBaseUrl(value: string): URL {
  const publicBaseUrl = new URL(value);
  if (publicBaseUrl.username !== "" || publicBaseUrl.password !== "") {
    throw new TypeError("PUBLIC_BASE_URL must not include credentials or userinfo");
  }
  if (publicBaseUrl.hash !== "" || value.includes("#")) {
    throw new TypeError("PUBLIC_BASE_URL must not include a fragment");
  }
  if (publicBaseUrl.protocol !== "http:" && publicBaseUrl.protocol !== "https:") {
    throw new TypeError("PUBLIC_BASE_URL must use HTTP(S)");
  }
  if (
    publicBaseUrl.protocol === "http:" &&
    (!loopbackHttpHosts.has(publicBaseUrl.hostname) || !exactLoopbackHttpUrl.test(value))
  ) {
    throw new TypeError(
      "PUBLIC_BASE_URL must use HTTPS except for exact loopback HTTP hosts",
    );
  }
  return publicBaseUrl;
}

const environmentSchema = z
  .object({
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4207),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4207"),
    ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY: z.enum(["true", "false"]).default("false"),
    TLS_CERT_PATH: optionalSecret,
    TLS_KEY_PATH: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    PALABRA_API_KEY: optionalSecret,
    OPERATOR_TOKEN: optionalOperatorToken,
    RETENTION_OWNER_ID: requiredIdentity,
    RETENTION_OWNER_TOKEN: requiredToken,
    EVIDENCE_REVIEWER_ID: requiredIdentity,
    EVIDENCE_REVIEWER_TOKEN: requiredToken,
    PROCESSING_PROFILE_PATH: z.string().min(1),
    PROCESSING_PROFILE_SHA256: sha256,
    DEPLOYMENT_BUILD_SHA256: sha256,
    MEDIA_PROFILE: z.enum(MEDIA_PROFILES).default("browser_pair"),
    EVIDENCE_ARCHIVE_DIRECTORY: z.string().min(1),
    EVIDENCE_KEY_DIRECTORY: z.string().min(1),
    EVIDENCE_EXPORT_DIRECTORY: z.string().min(1),
    EVIDENCE_RECEIPT_DIRECTORY: z.string().min(1),
    EVIDENCE_ROOT_KEY_BASE64: z.string().min(1),
    SECURITY_DATA_DIRECTORY: z.string().min(1).default("./data"),
    GLOSSARY_DIRECTORY: z.string().min(1).default("./data/glossaries"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((value, context) => {
    if ((value.TLS_CERT_PATH === undefined) !== (value.TLS_KEY_PATH === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.TLS_CERT_PATH === undefined ? "TLS_CERT_PATH" : "TLS_KEY_PATH"],
        message: "TLS_CERT_PATH and TLS_KEY_PATH must be configured together",
      });
    }
    if (decodeRootKey(value.EVIDENCE_ROOT_KEY_BASE64) === undefined) {
      context.addIssue({
        code: "custom",
        path: ["EVIDENCE_ROOT_KEY_BASE64"],
        message: "EVIDENCE_ROOT_KEY_BASE64 must be valid base64 encoding of exactly 32 bytes",
      });
    }
    if (value.RETENTION_OWNER_TOKEN === value.EVIDENCE_REVIEWER_TOKEN) {
      context.addIssue({
        code: "custom",
        path: ["EVIDENCE_REVIEWER_TOKEN"],
        message: "RETENTION_OWNER_TOKEN and EVIDENCE_REVIEWER_TOKEN must be distinct",
      });
    }
    if (
      value.OPERATOR_TOKEN !== undefined &&
      (value.OPERATOR_TOKEN === value.RETENTION_OWNER_TOKEN ||
        value.OPERATOR_TOKEN === value.EVIDENCE_REVIEWER_TOKEN)
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPERATOR_TOKEN"],
        message: "OPERATOR_TOKEN, RETENTION_OWNER_TOKEN, and EVIDENCE_REVIEWER_TOKEN must be distinct",
      });
    }
    if (value.RETENTION_OWNER_ID === value.EVIDENCE_REVIEWER_ID) {
      context.addIssue({
        code: "custom",
        path: ["EVIDENCE_REVIEWER_ID"],
        message: "RETENTION_OWNER_ID and EVIDENCE_REVIEWER_ID must be distinct",
      });
    }
  });

const obsoleteEnvironmentVariables = [
  "APP_PROFILE",
  "TRANSLATION_PROFILE",
  "TRANSLATION_PROVIDER",
  "TRANSLATION_MODE",
  "OPENAI_REALTIME_MODEL",
  "OPENAI_TRANSCRIBE_MODEL",
  "OPENAI_TEXT_MODEL",
  "OPENAI_TTS_MODEL",
  "OPENAI_TTS_VOICE",
  "PALABRA_INPUT_CHUNK_MS",
  "EVIDENCE_PROFILE",
  "EVIDENCE_DIRECTORY",
  "EVIDENCE_KEY_BASE64",
  "EVIDENCE_ENCRYPTION_KEY_BASE64",
  "EVIDENCE_MIN_FREE_BYTES",
] as const;

function assertNoObsoleteEnvironmentRoutes(environment: NodeJS.ProcessEnv): void {
  for (const name of obsoleteEnvironmentVariables) {
    if (environment[name] !== undefined) {
      throw new TypeError(
        name + " is no longer supported; configure processing routing through PROCESSING_PROFILE_PATH",
      );
    }
  }
}

function isSameOrNestedPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isStrictDescendantPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath);
}

function existingRealPath(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new TypeError("Security roots and their existing parents must be real directories");
  }
  return realpathSync.native(path);
}

function assertSecurityRootPath(
  path: string,
  label: string,
  cwd: string,
  securityDataDirectory: string,
  webDirectory: string,
): void {
  const resolvedPath = resolve(path);
  const filesystemRoot = parse(resolvedPath).root;
  if (resolvedPath === filesystemRoot) {
    throw new TypeError(label + " must not be a filesystem root");
  }
  if (isSameOrNestedPath(resolvedPath, cwd)) {
    throw new TypeError(label + " must not be the deployment cwd or one of its ancestors");
  }
  if (!isStrictDescendantPath(securityDataDirectory, resolvedPath)) {
    throw new TypeError(
      label + " must be a strict descendant of the dedicated security data directory",
    );
  }
  if (isSameOrNestedPath(webDirectory, resolvedPath) || isSameOrNestedPath(resolvedPath, webDirectory)) {
    throw new TypeError(label + " must be disjoint from the web static root");
  }

  // Existing roots are safe only when their real path remains inside the same
  // dedicated parent and does not widen the recursive hardening scope.
  const realPath = existingRealPath(resolvedPath);
  if (realPath === undefined) return;
  const realCwd = existingRealPath(cwd) ?? resolve(cwd);
  const realParent = existingRealPath(securityDataDirectory) ?? resolve(securityDataDirectory);
  const realWeb = existingRealPath(webDirectory) ?? resolve(webDirectory);
  if (parse(realPath).root === realPath || isSameOrNestedPath(realPath, realCwd)) {
    throw new TypeError(label + " must not resolve to the deployment cwd or a broad existing directory");
  }
  if (!isStrictDescendantPath(realParent, realPath)) {
    throw new TypeError(label + " must resolve beneath the dedicated security data directory");
  }
  if (isSameOrNestedPath(realWeb, realPath) || isSameOrNestedPath(realPath, realWeb)) {
    throw new TypeError(label + " must be disjoint from the web static root");
  }
}

function assertTlsPathOutsideWebRoot(
  path: string,
  label: string,
  webDirectory: string,
): void {
  const resolvedPath = resolve(path);
  if (isSameOrNestedPath(webDirectory, resolvedPath)) {
    throw new TypeError(label + " must not be inside the web static root");
  }
  if (!existsSync(resolvedPath)) return;
  const info = lstatSync(resolvedPath);
  if (info.isDirectory() || (!info.isFile() && !info.isSymbolicLink())) {
    throw new TypeError(label + " must point to a regular TLS file");
  }
  let realPath: string;
  try {
    realPath = realpathSync.native(resolvedPath);
  } catch {
    throw new TypeError(label + " must resolve to a regular TLS file");
  }
  try {
    if (!lstatSync(realPath).isFile()) {
      throw new TypeError(label + " must resolve to a regular TLS file");
    }
  } catch (error: unknown) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(label + " must resolve to a regular TLS file", { cause: error });
  }
  let realWebDirectory: string | undefined;
  if (existsSync(webDirectory)) {
    try {
      realWebDirectory = realpathSync.native(webDirectory);
    } catch {
      realWebDirectory = undefined;
    }
  }
  if (isSameOrNestedPath(webDirectory, realPath) ||
    (realWebDirectory !== undefined && isSameOrNestedPath(realWebDirectory, realPath))) {
    throw new TypeError(label + " must not resolve inside the web static root");
  }
}

function assertDisjointEvidenceDirectories(directories: readonly string[]): void {
  for (let index = 0; index < directories.length; index += 1) {
    const left = directories[index];
    if (left === undefined) continue;
    for (const right of directories.slice(index + 1)) {
      if (isSameOrNestedPath(left, right) || isSameOrNestedPath(right, left)) {
        throw new TypeError("Evidence directories must be distinct and non-nested security roots");
      }
    }
  }
}

function assertGlossaryDirectoryIsDisjointFromEvidenceDirectories(
  glossaryDirectory: string,
  evidenceDirectories: readonly string[],
): void {
  for (const evidenceDirectory of evidenceDirectories) {
    if (
      isSameOrNestedPath(evidenceDirectory, glossaryDirectory) ||
      isSameOrNestedPath(glossaryDirectory, evidenceDirectory)
    ) {
      throw new TypeError("Glossary directory must be a distinct and non-nested security root");
    }
  }
}

function generatedOperatorToken(excluded: ReadonlySet<string>): string {
  let token: string;
  do {
    token = randomBytes(32).toString("base64url");
  } while (excluded.has(token));
  return token;
}

export type ProcessingProfileDeploymentReference = Readonly<{
  path: string;
  expectedSha256: string;
}>;

export type DeploymentRoleCredential = Readonly<{
  id: string;
  token: string;
}>;

export type EvidenceStorageConfig = Readonly<{
  archiveDirectory: string;
  keyDirectory: string;
  exportDirectory: string;
  receiptDirectory: string;
  rootKey: Buffer;
}>;

export type AppConfig = Readonly<{
  host: string;
  port: number;
  publicBaseUrl: URL;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  openaiApiKey?: string;
  palabraApiKey?: string;
  operatorToken: string;
  retentionOwner: DeploymentRoleCredential;
  evidenceReviewer: DeploymentRoleCredential;
  processingProfile: ProcessingProfileDeploymentReference;
  deploymentBuildSha256: string;
  mediaProfile: MediaProfile;
  securityDataDirectory: string;
  strictSecurityAncestors: boolean;
  evidence: EvidenceStorageConfig;
  glossaryDirectory: string;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}>;

export function loadConfig(environment: NodeJS.ProcessEnv, cwd = process.cwd()): AppConfig {
  assertNoObsoleteEnvironmentRoutes(environment);
  const parsed = environmentSchema.parse(environment);
  const publicBaseUrl = parsePublicBaseUrl(parsed.PUBLIC_BASE_URL);
  const allowInsecureLoopbackDataBoundary =
    parsed.ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY === "true";
  if (allowInsecureLoopbackDataBoundary && publicBaseUrl.protocol !== "http:") {
    throw new TypeError(
      "ALLOW_INSECURE_LOOPBACK_DATA_BOUNDARY=true is permitted only for exact loopback HTTP",
    );
  }
  if ((publicBaseUrl.protocol === "http:" || allowInsecureLoopbackDataBoundary) &&
    !exactLoopbackBindHosts.has(parsed.HOST)) {
    throw new TypeError(
      "HOST must be an exact numeric loopback bind address for plaintext HTTP",
    );
  }
  if (publicBaseUrl.protocol === "https:" &&
    (parsed.TLS_CERT_PATH === undefined || parsed.TLS_KEY_PATH === undefined)) {
    throw new TypeError(
      "TLS_CERT_PATH and TLS_KEY_PATH are required when PUBLIC_BASE_URL uses HTTPS",
    );
  }
  const resolvedCwd = resolve(cwd);
  const configuredSecurityDataDirectory = environment.SECURITY_DATA_DIRECTORY;
  const securityDataDirectory = resolve(cwd, parsed.SECURITY_DATA_DIRECTORY);
  if (parse(securityDataDirectory).root === securityDataDirectory) {
    throw new TypeError("SECURITY_DATA_DIRECTORY must not be a filesystem root");
  }
  // An existing parent must be a real directory before any managed root can
  // be created beneath it; this also rejects a parent symlink/junction.
  existingRealPath(securityDataDirectory);
  if (publicBaseUrl.protocol === "https:" &&
    (configuredSecurityDataDirectory === undefined ||
      !isAbsolute(configuredSecurityDataDirectory) ||
      isSameOrNestedPath(resolvedCwd, securityDataDirectory) ||
      isSameOrNestedPath(securityDataDirectory, resolvedCwd))) {
    throw new TypeError(
      "SECURITY_DATA_DIRECTORY must be an explicit absolute path outside the deployment cwd for HTTPS",
    );
  }
  const webDirectory = resolve(cwd, "web");
  if (parsed.TLS_CERT_PATH !== undefined) {
    assertTlsPathOutsideWebRoot(resolve(cwd, parsed.TLS_CERT_PATH), "TLS_CERT_PATH", webDirectory);
  }
  if (parsed.TLS_KEY_PATH !== undefined) {
    assertTlsPathOutsideWebRoot(resolve(cwd, parsed.TLS_KEY_PATH), "TLS_KEY_PATH", webDirectory);
  }
  const archiveDirectory = resolve(cwd, parsed.EVIDENCE_ARCHIVE_DIRECTORY);
  const keyDirectory = resolve(cwd, parsed.EVIDENCE_KEY_DIRECTORY);
  const exportDirectory = resolve(cwd, parsed.EVIDENCE_EXPORT_DIRECTORY);
  const receiptDirectory = resolve(cwd, parsed.EVIDENCE_RECEIPT_DIRECTORY);
  const glossaryDirectory = resolve(cwd, parsed.GLOSSARY_DIRECTORY);
  const securityRoots: readonly [string, string][] = [
    ["EVIDENCE_ARCHIVE_DIRECTORY", archiveDirectory],
    ["EVIDENCE_KEY_DIRECTORY", keyDirectory],
    ["EVIDENCE_EXPORT_DIRECTORY", exportDirectory],
    ["EVIDENCE_RECEIPT_DIRECTORY", receiptDirectory],
    ["GLOSSARY_DIRECTORY", glossaryDirectory],
  ];
  for (const [label, path] of securityRoots) {
    assertSecurityRootPath(path, label, resolvedCwd, securityDataDirectory, webDirectory);
  }
  const evidenceDirectories = [
    archiveDirectory,
    keyDirectory,
    exportDirectory,
    receiptDirectory,
  ];
  assertDisjointEvidenceDirectories(evidenceDirectories);
  assertGlossaryDirectoryIsDisjointFromEvidenceDirectories(glossaryDirectory, evidenceDirectories);

  const operatorToken = parsed.OPERATOR_TOKEN ?? generatedOperatorToken(new Set([
    parsed.RETENTION_OWNER_TOKEN,
    parsed.EVIDENCE_REVIEWER_TOKEN,
  ]));

  return Object.freeze({
    host: parsed.HOST,
    port: parsed.PORT,
    publicBaseUrl,
    ...(parsed.TLS_CERT_PATH === undefined
      ? {}
      : { tlsCertPath: resolve(cwd, parsed.TLS_CERT_PATH) }),
    ...(parsed.TLS_KEY_PATH === undefined ? {} : { tlsKeyPath: resolve(cwd, parsed.TLS_KEY_PATH) }),
    ...(parsed.OPENAI_API_KEY === undefined ? {} : { openaiApiKey: parsed.OPENAI_API_KEY }),
    ...(parsed.PALABRA_API_KEY === undefined ? {} : { palabraApiKey: parsed.PALABRA_API_KEY }),
    operatorToken,
    retentionOwner: Object.freeze({
      id: parsed.RETENTION_OWNER_ID,
      token: parsed.RETENTION_OWNER_TOKEN,
    }),
    evidenceReviewer: Object.freeze({
      id: parsed.EVIDENCE_REVIEWER_ID,
      token: parsed.EVIDENCE_REVIEWER_TOKEN,
    }),
    processingProfile: Object.freeze({
      path: resolve(cwd, parsed.PROCESSING_PROFILE_PATH),
      expectedSha256: parsed.PROCESSING_PROFILE_SHA256,
    }),
    deploymentBuildSha256: parsed.DEPLOYMENT_BUILD_SHA256,
    mediaProfile: parsed.MEDIA_PROFILE,
    securityDataDirectory,
    strictSecurityAncestors: !allowInsecureLoopbackDataBoundary,
    evidence: Object.freeze({
      archiveDirectory,
      keyDirectory,
      exportDirectory,
      receiptDirectory,
      rootKey: decodeRootKey(parsed.EVIDENCE_ROOT_KEY_BASE64)!,
    }),
    glossaryDirectory,
    logLevel: parsed.LOG_LEVEL,
  });
}

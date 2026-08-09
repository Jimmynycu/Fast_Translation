import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac, hkdfSync, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import {
  FileGlossaryRepository,
  GlossaryIntegrityError,
  GlossaryVersionDeletedError,
  GlossaryVersionConflictError,
} from "../src/adapters/glossary/file-repository.js";
import {
  MAX_GLOSSARY_ALIASES_PER_ENTRY,
  MAX_GLOSSARY_TERM_CHARACTERS,
} from "../src/core/glossary.js";

const approval = {
  approvedBy: "Customer Glossary Owner",
  approvedAt: "2026-08-05T12:00:00.000Z",
} as const;
const repositoryRootKey = Buffer.alloc(32, 7);
const execFile = promisify(execFileCallback);
const testRootLeases = new WeakMap<
  FileGlossaryRepository,
  Awaited<ReturnType<FileGlossaryRepository["acquireRootLease"]>>
>();

interface SyncableFileHandle {
  sync(): Promise<void>;
  stat(): Promise<Readonly<{ isDirectory(): boolean }>>;
}

const WINDOWS_ACL_DENYLIST_VERIFICATION_SCRIPT = [
  "& {",
  "param([string] $encodedPath)",
  '$ErrorActionPreference = "Stop"',
  '$base64 = $encodedPath.Replace("-", "+").Replace("_", "/")',
  'switch ($base64.Length % 4) { 2 { $base64 += "==" } 3 { $base64 += "=" } 1 { throw "Invalid encoded path" } }',
  '$path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($base64))',
  '$acl = Get-Acl -LiteralPath $path',
  'if (-not $acl.AreAccessRulesProtected) { throw "Windows root DACL inherits permissions" }',
  '$rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))',
  'foreach ($sid in @("S-1-1-0", "S-1-5-32-545")) {',
  '  if (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid }).Count -ne 0) {',
  '    throw "Windows root still grants a public principal"',
  '  }',
  '}',
  "}",
].join("\n");

function encodePowerShellPath(path: string): string {
  return Buffer.from(path, "utf16le").toString("base64url");
}

async function makeWindowsDirectoryPermissive(directory: string): Promise<void> {
  await execFile("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)F"], {
    windowsHide: true,
  });
}

async function makeWindowsFilePermissive(path: string): Promise<void> {
  await execFile("icacls.exe", [path, "/grant", "*S-1-1-0:F"], { windowsHide: true });
}

async function assertWindowsDirectoryRejectsPublicPrincipals(directory: string): Promise<void> {
  await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_ACL_DENYLIST_VERIFICATION_SCRIPT,
    encodePowerShellPath(directory),
  ], { windowsHide: true });
}

async function withInjectedDirectorySyncFailure<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    if ((await this.stat()).isDirectory()) {
      const failure = Object.assign(new Error("injected directory sync failure"), { code: "EPERM" });
      throw failure;
    }
    return originalSync.call(this);
  };
  try {
    return await operation();
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
}

function repositoryDirectory(name: string): string {
  return join(process.cwd(), "work", "tmp", "glossary-tests", name);
}

const repositorySecurityBoundary = repositoryDirectory("");

async function makeRepository(name: string): Promise<FileGlossaryRepository> {
  return leaseTestRepository(await makeUnleasedRepository(name));
}

async function leaseTestRepository(repository: FileGlossaryRepository): Promise<FileGlossaryRepository> {
  const rootLease = await repository.acquireRootLease();
  testRootLeases.set(repository, rootLease);
  return repository;
}

async function makeUnleasedRepository(name: string): Promise<FileGlossaryRepository> {
  const directory = repositoryDirectory(name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return repositoryAt(directory);
}

async function releaseTestRootLease(repository: FileGlossaryRepository): Promise<void> {
  const rootLease = testRootLeases.get(repository);
  if (rootLease === undefined) return;
  testRootLeases.delete(repository);
  await rootLease.release();
}

async function restartRepository(
  previous: FileGlossaryRepository,
  directory: string,
): Promise<FileGlossaryRepository> {
  await releaseTestRootLease(previous);
  return leaseTestRepository(repositoryAt(directory));
}

function repositoryAt(
  directory: string,
  now: () => Date = () => new Date("2026-08-06T00:00:00.000Z"),
  options: Readonly<{
    readonly securityBoundaryDirectory?: string;
    readonly strictAncestors?: boolean;
  }> = {},
): FileGlossaryRepository {
  return new FileGlossaryRepository({
    directory,
    securityBoundaryDirectory: options.securityBoundaryDirectory ?? repositorySecurityBoundary,
    strictAncestors: options.strictAncestors ?? false,
    rootKey: repositoryRootKey,
    now,
  });
}

function singleEntryGlossary(id = "factory-terms", version = "v1") {
  return {
    id,
    version,
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  } as const;
}

function canonicalFixtureJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, entry]) => [key, canonicalize(entry)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(canonicalize(value));
}

function glossaryReceiptHmac(key: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", key)
    .update(purpose, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function glossaryRootMarker(
  marker: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const rootLeaseKey = Buffer.from(hkdfSync(
    "sha256",
    repositoryRootKey,
    Buffer.from("fast-translation/glossary-repository/v1", "utf8"),
    Buffer.from("root-lease-authentication", "utf8"),
    32,
  ));
  try {
    return Object.freeze({
      ...marker,
      markerHmac: glossaryReceiptHmac(
        rootLeaseKey,
        "glossary-root-lease-marker",
        canonicalFixtureJson(marker),
      ),
    });
  } finally {
    rootLeaseKey.fill(0);
  }
}

async function writeCrashPendingDeletionReceipt(
  directory: string,
  storageId: string,
  encryptedArtifactPath: string,
  request: Readonly<{
    commandId: string;
    ownerId: string;
    reason: string;
    requestedAtMs: number;
  }>,
): Promise<void> {
  const receiptKey = Buffer.from(hkdfSync(
    "sha256",
    repositoryRootKey,
    Buffer.from("fast-translation/glossary-repository/v1", "utf8"),
    Buffer.from("deletion-receipt-authentication", "utf8"),
    32,
  ));
  try {
    const requestHmac = glossaryReceiptHmac(
      receiptKey,
      "glossary-deletion-request",
      canonicalFixtureJson({ storageId, ownerId: request.ownerId, reason: request.reason }),
    );
    const unsigned = {
      schemaVersion: 1,
      kind: "glossary_deletion_receipt",
      storageId,
      deletionReceiptId: glossaryReceiptHmac(
        receiptKey,
        "glossary-deletion-receipt",
        storageId + "\u0000" + request.commandId,
      ),
      commandIdHmac: glossaryReceiptHmac(receiptKey, "command-id", request.commandId),
      requestHmac,
      ownerIdHmac: glossaryReceiptHmac(receiptKey, "deletion-owner", request.ownerId),
      reasonHmac: glossaryReceiptHmac(receiptKey, "deletion-reason", request.reason),
      encryptedArtifactSha256: createHash("sha256")
        .update(await readFile(encryptedArtifactPath))
        .digest("hex"),
      requestedAtMs: request.requestedAtMs,
      status: "pending",
    } as const;
    const receipt = {
      ...unsigned,
      receiptHmac: glossaryReceiptHmac(
        receiptKey,
        "glossary-deletion-receipt-body",
        canonicalFixtureJson(unsigned),
      ),
    };
    const path = join(directory, storageId + ".delete.json");
    await writeFile(path, JSON.stringify(receipt) + "\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);
  } finally {
    receiptKey.fill(0);
  }
}

async function loadPinned(
  repository: FileGlossaryRepository,
  id: string,
  version: string,
) {
  const lease = await repository.acquire(id, version);
  try {
    return lease.glossary;
  } finally {
    await lease.release();
  }
}

/** A central-directory-only ZIP is sufficient to prove guards run before ExcelJS inflates it. */
function syntheticXlsxArchive(options: Readonly<{
  entryCount?: number;
  compressedBytes?: number;
  uncompressedBytes?: number;
}> = {}): Uint8Array {
  const entryCount = options.entryCount ?? 1;
  const compressedBytes = options.compressedBytes ?? 1;
  const uncompressedBytes = options.uncompressedBytes ?? 1;
  const fileName = Buffer.from("xl/worksheets/sheet1.xml", "utf8");
  const centralHeaderBytes = 46 + fileName.byteLength;
  const archive = Buffer.alloc(centralHeaderBytes + 22);

  archive.writeUInt32LE(0x02014b50, 0); // central-directory file header
  archive.writeUInt16LE(20, 4);
  archive.writeUInt16LE(20, 6);
  archive.writeUInt16LE(0, 8);
  archive.writeUInt16LE(8, 10);
  archive.writeUInt32LE(0, 12);
  archive.writeUInt32LE(compressedBytes, 20);
  archive.writeUInt32LE(uncompressedBytes, 24);
  archive.writeUInt16LE(fileName.byteLength, 28);
  archive.writeUInt16LE(0, 30);
  archive.writeUInt16LE(0, 32);
  archive.writeUInt16LE(0, 34);
  archive.writeUInt16LE(0, 36);
  archive.writeUInt32LE(0, 38);
  archive.writeUInt32LE(0, 42);
  fileName.copy(archive, 46);

  const endOffset = centralHeaderBytes;
  archive.writeUInt32LE(0x06054b50, endOffset); // end of central directory
  archive.writeUInt16LE(0, endOffset + 4);
  archive.writeUInt16LE(0, endOffset + 6);
  archive.writeUInt16LE(entryCount, endOffset + 8);
  archive.writeUInt16LE(entryCount, endOffset + 10);
  archive.writeUInt32LE(centralHeaderBytes, endOffset + 12);
  archive.writeUInt32LE(0, endOffset + 16);
  archive.writeUInt16LE(0, endOffset + 20);
  return new Uint8Array(archive);
}

test("requires an instance-owned root lease and blocks a second repository from deleting an active version", async () => {
  const first = await makeUnleasedRepository("root-lease-two-instances");
  const glossary = singleEntryGlossary();
  await assert.rejects(first.import(glossary), /glossary root.*lease/u);

  const rootLease = await first.acquireRootLease();
  try {
    await first.import(glossary);
    const activeVersion = await first.acquire(glossary.id, glossary.version);
    try {
      await assert.rejects(
        rootLease.release(),
        /cannot be released while a glossary version is leased/u,
      );
      const second = repositoryAt(repositoryDirectory("root-lease-two-instances"));
      await assert.rejects(second.acquireRootLease(), /glossary root is leased by another process/iu);
      await assert.rejects(second.delete({
        id: glossary.id,
        version: glossary.version,
        commandId: "a9d5e108-5baf-47ca-bc19-2b88be34f0e9",
        ownerId: "customer-retention-owner",
        reason: "Customer requested glossary deletion",
        requestedAtMs: Date.parse("2026-08-05T12:00:00.000Z"),
      }), /glossary root.*lease/u);
    } finally {
      await activeVersion.release();
    }
  } finally {
    await rootLease.release();
  }

  const restarted = repositoryAt(repositoryDirectory("root-lease-two-instances"));
  const restartedRootLease = await restarted.acquireRootLease();
  try {
    assert.equal(await restarted.has(glossary.id, glossary.version), true);
  } finally {
    await restartedRootLease.release();
  }
});

test("rejects a foreign root lease without mutating its protected root", async () => {
  const directory = repositoryDirectory("root-lease-foreign-admission");
  const first = await makeUnleasedRepository("root-lease-foreign-admission");
  const rootLease = await first.acquireRootLease();
  const markerPath = join(directory, ".glossary-root.lifecycle.lock");
  try {
    // Deliberately make the protected root non-owner-only after the first
    // owner has admitted. A rejected contender must not "harden" it first.
    if (process.platform !== "win32") await chmod(directory, 0o755);
    const snapshot = async (path: string) => {
      const info = await stat(path);
      return Object.freeze({
        mode: info.mode & 0o777,
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
      });
    };
    const before = Object.freeze({
      root: await snapshot(directory),
      marker: await snapshot(markerPath),
    });

    const contender = repositoryAt(directory);
    await assert.rejects(
      contender.acquireRootLease(),
      /glossary root is leased by another process/iu,
    );
    assert.deepEqual({
      root: await snapshot(directory),
      marker: await snapshot(markerPath),
    }, before);
  } finally {
    // Restore the owning root's required mode before its normal release path.
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await rootLease.release();
  }
});

test("keeps the root marker when a lease acquisition and root release overlap", async () => {
  const directory = repositoryDirectory("root-lease-acquire-release-race");
  const repository = await makeUnleasedRepository("root-lease-acquire-release-race");
  const rootLease = await repository.acquireRootLease();
  const glossary = singleEntryGlossary();
  try {
    await repository.import(glossary);
    const acquisition = repository.acquire(glossary.id, glossary.version);
    // Let acquisition enter the root-operation lifecycle before requesting
    // shutdown. It may still be decrypting when release starts.
    await Promise.resolve();
    const releaseAttempt = rootLease.release();
    const versionLease = await acquisition;
    try {
      await assert.rejects(
        releaseAttempt,
        /cannot be released while a glossary version is leased/u,
      );
      const second = repositoryAt(directory);
      await assert.rejects(second.acquireRootLease(), /glossary root is leased by another process/iu);
    } finally {
      await versionLease.release();
    }
    await rootLease.release();
  } finally {
    // The root lease release above is idempotent after the version is released.
    await rootLease.release();
  }
});

test("reclaims a same-host root marker from a stale process incarnation", async () => {
  const directory = repositoryDirectory("root-lease-stale-incarnation");
  await makeUnleasedRepository("root-lease-stale-incarnation");
  const markerPath = join(directory, ".glossary-root.lifecycle.lock");
  await writeFile(markerPath, JSON.stringify(glossaryRootMarker({
    schemaVersion: 1,
    kind: "glossary_root_process_lease",
    host: hostname(),
    processId: process.pid,
    processStartIdentity: randomUUID(),
    lockId: randomUUID(),
  })) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") await chmod(markerPath, 0o600);

  const repository = repositoryAt(directory);
  const rootLease = await repository.acquireRootLease();
  try {
    const contender = repositoryAt(directory);
    await assert.rejects(contender.acquireRootLease(), /glossary root is leased by another process/iu);
  } finally {
    await rootLease.release();
  }
});

test("cleans up an uncommitted root marker when directory sync fails", async () => {
  const name = "root-lease-directory-sync-failure";
  const directory = repositoryDirectory(name);
  const repository = await makeUnleasedRepository(name);
  const markerPath = join(directory, ".glossary-root.lifecycle.lock");

  await withInjectedDirectorySyncFailure(directory, async () => {
    await assert.rejects(
      repository.acquireRootLease(),
      /injected directory sync failure/u,
    );
  });
  await assert.rejects(readFile(markerPath));

  const rootLease = await repository.acquireRootLease();
  await rootLease.release();
});

test("does not reclaim an unauthenticated or forged root marker", async () => {
  for (const [name, marker] of [
    ["unsigned", {
      schemaVersion: 1,
      kind: "glossary_root_process_lease",
      host: hostname(),
      processId: process.pid,
      processStartIdentity: randomUUID(),
      lockId: randomUUID(),
    }],
    ["forged", glossaryRootMarker({
      schemaVersion: 1,
      kind: "glossary_root_process_lease",
      host: hostname(),
      processId: process.pid,
      processStartIdentity: randomUUID(),
      lockId: randomUUID(),
    })],
  ] as const) {
    const directory = repositoryDirectory("root-lease-" + name + "-marker");
    await makeUnleasedRepository("root-lease-" + name + "-marker");
    const markerPath = join(directory, ".glossary-root.lifecycle.lock");
    const serialized = JSON.stringify(
      name === "forged"
        ? { ...marker, markerHmac: "0".repeat(64) }
        : marker,
    ) + "\n";
    await writeFile(markerPath, serialized, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(markerPath, 0o600);

    const repository = repositoryAt(directory);
    await assert.rejects(
      repository.acquireRootLease(),
      /glossary root is leased by another process/iu,
    );
    assert.equal(await readFile(markerPath, "utf8"), serialized);
  }
});

test("fails closed on malformed and oversized root marker descriptors", async () => {
  for (const [name, serialized] of [
    ["malformed", "{not-json\n"],
    ["oversized", JSON.stringify({ padding: "x".repeat(20_000) }) + "\n"],
  ] as const) {
    const directory = repositoryDirectory("root-lease-" + name + "-descriptor");
    await makeUnleasedRepository("root-lease-" + name + "-descriptor");
    const markerPath = join(directory, ".glossary-root.lifecycle.lock");
    await writeFile(markerPath, serialized, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(markerPath, 0o600);

    const repository = repositoryAt(directory);
    await assert.rejects(
      repository.acquireRootLease(),
      name === "oversized"
        ? /root lease marker is not a secure regular file/iu
        : /glossary root is leased by another process/iu,
    );
    assert.equal(await readFile(markerPath, "utf8"), serialized);
  }
});

test("reclaims crash-orphaned encrypted temporary aliases before delete and restart", async () => {
  const directory = repositoryDirectory("root-lease-crash-temp-alias");
  const first = await makeUnleasedRepository("root-lease-crash-temp-alias");
  const firstRootLease = await first.acquireRootLease();
  const glossary = singleEntryGlossary();
  let imported;
  try {
    imported = await first.import(glossary);
    await link(imported.storagePath, imported.storagePath + ".0123456789abcdef01234567.tmp");
  } finally {
    await firstRootLease.release();
  }

  const restarted = repositoryAt(directory);
  const restartedRootLease = await restarted.acquireRootLease();
  try {
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
    const deletion = await restarted.delete({
      id: glossary.id,
      version: glossary.version,
      commandId: "6dc3ce5c-f20e-4b7e-8dc7-2d6c9f35d251",
      ownerId: "customer-retention-owner",
      reason: "Customer requested glossary deletion",
      requestedAtMs: Date.parse("2026-08-05T12:00:00.000Z"),
    });
    assert.equal(deletion.status, "completed");
    const receiptName = (await readdir(directory)).find((name) => name.endsWith(".delete.json"));
    if (receiptName === undefined) throw new Error("deletion receipt was not written");
    await link(
      join(directory, receiptName),
      join(directory, receiptName + ".0123456789abcdef01234567.tmp"),
    );
  } finally {
    await restartedRootLease.release();
  }

  const afterReceiptRestart = repositoryAt(directory);
  const afterReceiptLease = await afterReceiptRestart.acquireRootLease();
  try {
    const names = await readdir(directory);
    assert.equal(names.some((name) => name.endsWith(".tmp")), false);
    assert.deepEqual(
      names.filter((name) => !name.startsWith(".glossary-root.")).map(
        (name) => /\.delete\.json$/u.test(name),
      ),
      [true],
    );
  } finally {
    await afterReceiptLease.release();
  }
});

test("finishes an authenticated crash-pending deletion during fresh root-lease acquisition", async () => {
  const directory = repositoryDirectory("root-lease-pending-recovery");
  const first = await makeUnleasedRepository("root-lease-pending-recovery");
  const firstRootLease = await first.acquireRootLease();
  const glossary = singleEntryGlossary();
  const deletion = {
    commandId: "7dcba3a1-5483-4e1c-aea3-0e1f9450f11b",
    ownerId: "customer-retention-owner",
    reason: "Customer requested glossary deletion",
    requestedAtMs: Date.parse("2026-08-05T12:00:00.000Z"),
  } as const;
  try {
    const imported = await first.import(glossary);
    const storageId = (await readdir(directory))
      .find((name) => name.endsWith(".glossary.enc"))?.slice(0, 64);
    if (storageId === undefined) throw new Error("encrypted glossary was not written");
    await writeCrashPendingDeletionReceipt(directory, storageId, imported.storagePath, deletion);
  } finally {
    await firstRootLease.release();
  }

  const restarted = repositoryAt(directory);
  const restartedRootLease = await restarted.acquireRootLease();
  try {
    const completed = await restarted.delete({
      id: glossary.id,
      version: glossary.version,
      ...deletion,
    });
    assert.equal(completed.status, "completed");
    assert.equal(await restarted.has(glossary.id, glossary.version), false);
    const names = await readdir(directory);
    assert.equal(names.some((name) => name.endsWith(".glossary.enc")), false);
    const receipt = await readFile(
      join(directory, names.find((name) => name.endsWith(".delete.json")) ?? ""),
      "utf8",
    );
    assert.doesNotMatch(receipt, /factory-terms|Customer requested|Spindle|主軸/u);
  } finally {
    await restartedRootLease.release();
  }
});

test("clamps a rollback clock to the deletion request timestamp", async () => {
  const directory = repositoryDirectory("deletion-clock-rollback");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const repository = repositoryAt(
    directory,
    () => new Date("2026-08-04T12:00:00.000Z"),
  );
  const rootLease = await repository.acquireRootLease();
  const glossary = singleEntryGlossary();
  const requestedAtMs = Date.parse("2026-08-05T12:00:00.000Z");
  try {
    await repository.import(glossary);
    const deletion = await repository.delete({
      id: glossary.id,
      version: glossary.version,
      commandId: "5b482bdd-4303-44ac-bd19-dab53c0a94ee",
      ownerId: "customer-retention-owner",
      reason: "Customer requested glossary deletion",
      requestedAtMs,
    });
    assert.equal(deletion.status, "completed");
    if (deletion.status !== "completed") throw new Error("deletion did not complete");
    assert.equal(deletion.requestedAtMs, requestedAtMs);
    assert.equal(deletion.deletedAtMs, requestedAtMs);
  } finally {
    await rootLease.release();
  }
});

test("rejects a glossary root with an intermediate symbolic-link ancestor", {
  skip: process.platform === "win32",
}, async () => {
  const root = repositoryDirectory("root-ancestor-symlink");
  const physicalParent = join(root, "physical-parent");
  const linkedParent = join(root, "linked-parent");
  await rm(root, { recursive: true, force: true });
  await mkdir(physicalParent, { recursive: true });
  await symlink(physicalParent, linkedParent, "dir");
  const repository = repositoryAt(
    join(linkedParent, "glossaries"),
    undefined,
    { securityBoundaryDirectory: root, strictAncestors: true },
  );
  await assert.rejects(repository.acquireRootLease(), /symbolic-link.*ancestor/u);
});

test("hardens the glossary root to the current POSIX owner and owner-only mode", {
  skip: process.platform === "win32",
}, async () => {
  const directory = repositoryDirectory("root-posix-owner-only");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o755 });
  await chmod(directory, 0o755);
  const repository = repositoryAt(directory);
  const rootLease = await repository.acquireRootLease();
  try {
    const info = await stat(directory);
    assert.equal(info.mode & 0o777, 0o700);
    if (typeof process.getuid === "function") assert.equal(info.uid, process.getuid());
  } finally {
    await rootLease.release();
  }
});

test("hardens the glossary root against Everyone and Users on Windows", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = repositoryDirectory("windows-root-acl");
  const staleDirectory = join(directory, "stale");
  const staleFile = join(staleDirectory, "prior-glossary.enc");
  await rm(directory, { recursive: true, force: true });
  await mkdir(staleDirectory, { recursive: true });
  await writeFile(staleFile, "not-a-glossary\n");
  await makeWindowsDirectoryPermissive(directory);
  await makeWindowsDirectoryPermissive(staleDirectory);
  await makeWindowsFilePermissive(staleFile);
  const repository = repositoryAt(directory);
  const rootLease = await repository.acquireRootLease();
  try {
    await assertWindowsDirectoryRejectsPublicPrincipals(directory);
    await assertWindowsDirectoryRejectsPublicPrincipals(staleDirectory);
    await assertWindowsDirectoryRejectsPublicPrincipals(staleFile);
  } finally {
    await rootLease.release();
  }
});

test("rejects a glossary root beneath a writable non-sticky POSIX parent", {
  skip: process.platform === "win32",
}, async () => {
  const parent = repositoryDirectory("root-writable-parent");
  await rm(parent, { recursive: true, force: true });
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o777);
  try {
    const repository = repositoryAt(
      join(parent, "glossaries"),
      undefined,
      { securityBoundaryDirectory: repositorySecurityBoundary, strictAncestors: true },
    );
    await assert.rejects(repository.acquireRootLease(), /writable.*ancestor/u);
  } finally {
    await chmod(parent, 0o700);
  }
});

test("imports approved CSV and acquires an immutable compiled version", async () => {
  const repository = await makeRepository("csv");
  const request = {
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Abel Ng,Abel|A. Ng,\u827e\u8c9d\u723e\u00b7\u5433",
      "term-2,ZX-900,ZX900|Z X 900,ZX-900",
    ].join("\n")),
  } as const;
  const imported = await repository.import(request);
  const pinned = await loadPinned(repository, request.id, request.version);

  assert.equal(pinned.hash, imported.hash);
  assert.equal(pinned.compiled.entries.length, 2);
  assert.match(pinned.compiled.entries[0]?.id ?? "", /^term_[a-f0-9]{32}$/u);
  assert.notEqual(pinned.compiled.entries[0]?.id, "term-1");
  assert.equal(pinned.compiled.bind("Ask Abel about ZX900.").bindings.length, 2);
  const persistedArtifact = await readFile(imported.storagePath, "utf8");
  assert.doesNotMatch(
    persistedArtifact,
    /Customer Glossary Owner|factory-terms|terms\.csv|Abel Ng|艾貝爾·吳/u,
  );
  assert.match(persistedArtifact, /A256GCM/u);
  const storedFiles = await readdir(repositoryDirectory("csv"), { withFileTypes: true });
  const encryptedFiles = storedFiles.filter((entry) => entry.name.endsWith(".glossary.enc"));
  assert.equal(encryptedFiles.length, 1);
  assert.match(encryptedFiles[0]?.name ?? "", /^[a-f0-9]{64}\.glossary\.enc$/u);
  assert.equal(storedFiles.some((entry) => entry.name.endsWith(".tmp")), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(repositoryDirectory("csv"))).mode & 0o777, 0o700);
    assert.equal((await stat(imported.storagePath)).mode & 0o777, 0o600);
  }

  const restarted = await restartRepository(repository, repositoryDirectory("csv"));
  assert.equal((await loadPinned(restarted, request.id, request.version)).hash, imported.hash);

  const same = await restarted.import({
    ...request,
    approval: {
      approvedBy: "Another Approver",
      approvedAt: "2026-08-06T00:00:00.000Z",
    },
  });
  assert.equal(same.approval.approvedBy, approval.approvedBy);

  await assert.rejects(
    restarted.import({
      ...request,
      contents: new TextEncoder().encode(
        "id,source,aliases,target_exact\nterm-1,Abel Ng,,wrong",
      ),
    }),
    GlossaryVersionConflictError,
  );
});

test("rejects an import when the glossary directory sync fails", async () => {
  const repository = await makeRepository("directory-sync-failure");
  try {
    await withInjectedDirectorySyncFailure(repositoryDirectory("directory-sync-failure"), async () => {
      await assert.rejects(
        repository.import(singleEntryGlossary("directory-sync-failure", "v1")),
        /injected directory sync failure/u,
      );
    });
  } finally {
    await releaseTestRootLease(repository);
  }
});

test("imports canonical columns from the first XLSX worksheet", async () => {
  const repository = await makeRepository("xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Manufacturing Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  sheet.addRow(["term-1", "pick-and-place", "pick and place|PnP", "\u53d6\u653e\u6a5f"]);
  const contents = await workbook.xlsx.writeBuffer();

  await repository.import({
    id: "smt",
    version: "v3",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.xlsx",
    contents: new Uint8Array(contents),
  });
  const pinned = await loadPinned(repository, "smt", "v3");
  assert.deepEqual(pinned.compiled.entries[0]?.aliases, ["pick and place", "PnP"]);
});

test("accepts exact CSV term and alias limits but rejects one beyond without persistence", async () => {
  const repository = await makeRepository("import-bounds-csv");
  const boundedSource = "s".repeat(MAX_GLOSSARY_TERM_CHARACTERS);
  const aliases = Array.from({ length: MAX_GLOSSARY_ALIASES_PER_ENTRY }, (_, index) => `alias-${index}`);
  await repository.import({
    id: "bounded-csv",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      `term-1,${boundedSource},${aliases.join("|")},target`,
    ].join("\n")),
  });
  assert.equal(await repository.has("bounded-csv", "v1"), true);

  const oversized = boundedSource + "s";
  await assert.rejects(
    repository.import({
      id: "oversized-csv",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        `term-1,${oversized},${aliases.join("|")},target`,
      ].join("\n")),
    }),
    (error: unknown) => {
      assert(error instanceof TypeError);
      assert.equal(error.message, "glossary import cell exceeds the maximum normalized size");
      assert.equal(error.message.includes(oversized), false);
      return true;
    },
  );
  assert.equal(await repository.has("oversized-csv", "v1"), false);

  await assert.rejects(
    repository.import({
      id: "too-many-aliases-csv",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        `term-1,source,${[...aliases, "alias-over"].join("|")},target`,
      ].join("\n")),
    }),
    /maximum alias count/u,
  );
  assert.equal(await repository.has("too-many-aliases-csv", "v1"), false);
});

test("rejects an XLSX cell over the normalized glossary bound before acquisition", async () => {
  const repository = await makeRepository("import-bounds-xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  const oversized = "x".repeat(MAX_GLOSSARY_TERM_CHARACTERS + 1);
  sheet.addRow(["term-1", oversized, "", "target"]);

  await assert.rejects(
    repository.import({
      id: "oversized-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /maximum normalized size/u,
  );
  assert.equal(await repository.has("oversized-xlsx", "v1"), false);
});

test("rejects an XLSX glossary after the ten-thousandth data row before materializing it", async () => {
  const repository = await makeRepository("import-row-bound-xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  for (let index = 0; index < 10_001; index += 1) {
    sheet.addRow([`term-${index}`, `source-${index}`, "", `target-${index}`]);
  }

  await assert.rejects(
    repository.import({
      id: "too-many-rows-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /maximum row count/u,
  );
  assert.equal(await repository.has("too-many-rows-xlsx", "v1"), false);
});

test("rejects a CSV glossary after the maximum data row before record materialization", async () => {
  const repository = await makeRepository("import-row-bound-csv");
  const rows = ["id,source,aliases,target_exact"];
  for (let index = 0; index < 10_001; index += 1) {
    rows.push(`term-${index},source-${index},,target-${index}`);
  }
  await assert.rejects(
    repository.import({
      id: "too-many-rows-csv",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode(rows.join("\n")),
    }),
    /maximum row count/u,
  );
  assert.equal(await repository.has("too-many-rows-csv", "v1"), false);
});

test("rejects a high-expansion XLSX central directory before ExcelJS can inflate it", async () => {
  const repository = await makeRepository("xlsx-zip-bomb");
  await assert.rejects(
    repository.import({
      id: "zip-bomb",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      // The archive stays tiny while declaring 1 GiB of inflated data.
      contents: syntheticXlsxArchive({ uncompressedBytes: 1024 * 1024 * 1024 }),
    }),
    /compression ratio exceeds/u,
  );
  assert.equal(await repository.has("zip-bomb", "v1"), false);
});

test("rejects an XLSX central directory with too many entries before parsing it", async () => {
  const repository = await makeRepository("xlsx-entry-count");
  await assert.rejects(
    repository.import({
      id: "too-many-zip-entries",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: syntheticXlsxArchive({ entryCount: 1_025 }),
    }),
    /entry count exceeds/u,
  );
  assert.equal(await repository.has("too-many-zip-entries", "v1"), false);
});


test("rejects duplicate normalized CSV headers before values can be overwritten", async () => {
  const repository = await makeRepository("csv-duplicate-headers");
  await assert.rejects(
    repository.import({
      id: "duplicate-csv",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target exact,target-exact",
        "term-1,Spindle,,主軸,錯誤值",
      ].join("\n")),
    }),
    /duplicate normalized column target_exact/u,
  );
  assert.equal(await repository.has("duplicate-csv", "v1"), false);
});

test("rejects duplicate normalized XLSX headers before values can be overwritten", async () => {
  const repository = await makeRepository("xlsx-duplicate-headers");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Manufacturing Terms");
  sheet.addRow(["id", "source", "aliases", "target exact", "target-exact"]);
  sheet.addRow(["term-1", "Spindle", "", "主軸", "錯誤值"]);

  await assert.rejects(
    repository.import({
      id: "duplicate-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /duplicate normalized column target_exact/u,
  );
  assert.equal(await repository.has("duplicate-xlsx", "v1"), false);
});

test("rejects a glossary whose automatic reverse direction is ambiguous", async () => {
  const repository = await makeRepository("reverse-conflict");
  await assert.rejects(
    repository.import({
      id: "ambiguous-reverse",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        "term-1,Spindle,,approved-main-shaft",
        "term-2,Main shaft,,approved-main-shaft",
      ].join("\n")),
    }),
    /conflicts between/u,
  );
  assert.equal(await repository.has("ambiguous-reverse", "v1"), false);
});

test("rejects duplicate source or alias ownership from a CSV before acquisition", async () => {
  const repository = await makeRepository("ambiguous-alias");
  await assert.rejects(
    repository.import({
      id: "ambiguous-alias",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        "term-1,Spindle, spindle | main spindle,主軸",
      ].join("\n")),
    }),
    /ambiguous normalized term/u,
  );
  assert.equal(await repository.has("ambiguous-alias", "v1"), false);
});

test("rejects an ambiguous XLSX source/alias overlap before acquisition", async () => {
  const repository = await makeRepository("ambiguous-xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  sheet.addRow(["term-1", "Torque controller", "", "扭力控制器"]);
  sheet.addRow(["term-2", "Controller", " torque controller ", "控制器"]);
  await assert.rejects(
    repository.import({
      id: "ambiguous-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /conflicts between/u,
  );
  assert.equal(await repository.has("ambiguous-xlsx", "v1"), false);
});

test("acquire fails closed when an encrypted glossary payload is tampered", async () => {
  const repository = await makeRepository("tampered-identity");
  const imported = await repository.import({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  });
  const persisted = JSON.parse(await readFile(imported.storagePath, "utf8")) as {
    ciphertext: string;
  };
  persisted.ciphertext = (persisted.ciphertext.startsWith("A") ? "B" : "A") +
    persisted.ciphertext.slice(1);
  await writeFile(imported.storagePath, JSON.stringify(persisted), "utf8");
  await assert.rejects(
    loadPinned(repository, "factory-terms", "v1"),
    GlossaryIntegrityError,
  );
});

test("acquire rejects an encrypted glossary envelope with extra fields", async () => {
  const repository = await makeRepository("tampered-reverse-ambiguity");
  const imported = await repository.import({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  });
  const persisted = JSON.parse(await readFile(imported.storagePath, "utf8")) as Record<string, unknown>;
  persisted.legacyPlaintext = "forbidden";
  await writeFile(imported.storagePath, JSON.stringify(persisted), "utf8");
  await assert.rejects(
    loadPinned(repository, "factory-terms", "v1"),
    GlossaryIntegrityError,
  );
});

test("fails closed when an encrypted glossary file loses its owner-only mode", async () => {
  if (process.platform === "win32") return;
  const repository = await makeRepository("insecure-file-mode");
  const imported = await repository.import({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  });
  await chmod(imported.storagePath, 0o644);
  await assert.rejects(
    loadPinned(repository, "factory-terms", "v1"),
    GlossaryIntegrityError,
  );
});



test("requires explicit customer approval metadata", async () => {
  const repository = await makeRepository("approval");
  await assert.rejects(repository.import({
    id: "terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval: { approvedBy: " ", approvedAt: "not-a-date" },
    fileName: "terms.csv",
    contents: new TextEncoder().encode(
      "id,source,aliases,target_exact\nterm-1,Spindle,,\u4e3b\u8ef8",
    ),
  }), /approvedBy/u);
});

test("deletes only an unleased encrypted glossary and preserves an opaque restart-safe receipt", async () => {
  const repository = await makeRepository("deletion");
  const glossary = {
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode(
      "id,source,aliases,target_exact\nterm-1,Spindle,,主軸",
    ),
  } as const;
  await repository.import(glossary);
  const lease = await repository.acquire(glossary.id, glossary.version);
  const deletion = {
    id: glossary.id,
    version: glossary.version,
    commandId: "0c7f796b-56a6-4d2e-82eb-0d960c8c5465",
    ownerId: "customer-retention-owner",
    reason: "Customer requested glossary deletion",
    requestedAtMs: Date.parse("2026-08-05T12:00:00.000Z"),
  } as const;

  assert.deepEqual(await repository.delete(deletion), { status: "active" });
  await Promise.all([lease.release(), lease.release()]);

  const completed = await repository.delete(deletion);
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") throw new Error("deletion did not complete");
  assert.match(completed.deletionReceiptId, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(completed).sort(), [
    "deletedAtMs",
    "deletionReceiptId",
    "requestedAtMs",
    "status",
  ]);
  assert.equal(await repository.has(glossary.id, glossary.version), false);
  await assert.rejects(
    repository.acquire(glossary.id, glossary.version),
    GlossaryVersionDeletedError,
  );

  const storedFiles = await readdir(repositoryDirectory("deletion"), { withFileTypes: true });
  const receiptFiles = storedFiles.filter((entry) => entry.name.endsWith(".delete.json"));
  assert.deepEqual(receiptFiles.map((entry) => /^[a-f0-9]{64}\.delete\.json$/u.test(entry.name)), [true]);
  const receipt = await readFile(
    join(repositoryDirectory("deletion"), receiptFiles[0]?.name ?? ""),
    "utf8",
  );
  assert.doesNotMatch(
    receipt,
    /factory-terms|terms\.csv|Customer requested|customer-retention-owner|Spindle|主軸/u,
  );

  const restarted = await restartRepository(repository, repositoryDirectory("deletion"));
  // HTTP retries have a fresh server-derived timestamp but must receive the
  // original signed completion receipt for the same owner command.
  assert.deepEqual(await restarted.delete({
    ...deletion,
    requestedAtMs: deletion.requestedAtMs + 60_000,
  }), completed);
  assert.deepEqual(await restarted.delete({ ...deletion, reason: "different request" }), {
    status: "conflict",
  });
  await assert.rejects(restarted.import(glossary), GlossaryVersionDeletedError);
  await restarted.import({ ...glossary, version: "v2" });
  assert.equal((await loadPinned(restarted, glossary.id, "v2")).compiled.version, "v2");
  assert.deepEqual(await restarted.delete({
    ...deletion,
    version: "v-missing",
    commandId: "1bf2ff4c-0c3e-4b94-a55b-f7ee4aee4ac6",
  }), { status: "not_found" });
});

test("fails closed when a deletion receipt is tampered", async () => {
  const repository = await makeRepository("deletion-receipt-tamper");
  const glossary = {
    id: "terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode(
      "id,source,aliases,target_exact\nterm-1,Torque,,扭力",
    ),
  } as const;
  await repository.import(glossary);
  const deletion = {
    id: glossary.id,
    version: glossary.version,
    commandId: "b722cc48-1185-4b70-a7ce-e3ab1a6e0f6d",
    ownerId: "customer-retention-owner",
    reason: "Customer requested glossary deletion",
    requestedAtMs: Date.parse("2026-08-05T12:00:00.000Z"),
  } as const;
  await repository.delete(deletion);
  const receiptFile = (await readdir(repositoryDirectory("deletion-receipt-tamper")))
    .find((name) => name.endsWith(".delete.json"));
  if (receiptFile === undefined) throw new Error("deletion receipt was not written");
  const receiptPath = join(repositoryDirectory("deletion-receipt-tamper"), receiptFile);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.status = "pending";
  await writeFile(receiptPath, JSON.stringify(receipt), "utf8");

  await releaseTestRootLease(repository);
  const restarted = repositoryAt(repositoryDirectory("deletion-receipt-tamper"));
  await assert.rejects(restarted.acquireRootLease(), GlossaryIntegrityError);
});

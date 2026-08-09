import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { z } from "zod";
import {
  hardenWindowsSecurityRoot,
  verifyWindowsSecurityRoot,
} from "../security/windows-root-acl.js";
import {
  compileGlossaryPair,
  MAX_GLOSSARY_ALIASES_PER_ENTRY,
  MAX_GLOSSARY_TERM_CHARACTERS,
  MAX_GLOSSARY_TERM_UTF8_BYTES,
  type CompiledGlossary,
  type GlossaryEntrySpec,
  type GlossarySpec,
} from "../../core/glossary.js";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
/**
 * XLSX is a ZIP container. These caps are deliberately lower than the generic
 * upload cap because ExcelJS expands the archive in memory.
 */
const MAX_XLSX_ARCHIVE_ENTRIES = 1_024;
const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = 100;
const MAX_ENCRYPTED_GLOSSARY_BYTES = 64 * 1024 * 1024;
const MAX_DELETION_RECEIPT_BYTES = 16 * 1024;
const ENVELOPE_SCHEMA_VERSION = 1;
const ENVELOPE_KIND = "encrypted_glossary";
const ENVELOPE_ALGORITHM = "A256GCM";
const ENVELOPE_NONCE_BYTES = 12;
const ENVELOPE_TAG_BYTES = 16;
const DELETION_RECEIPT_KIND = "glossary_deletion_receipt";
const ROOT_LEASE_SCHEMA_VERSION = 1;
const ROOT_LEASE_KIND = "glossary_root_process_lease";
const ROOT_LEASE_RECLAIM_KIND = "glossary_root_reclaim_claim";
const ROOT_LEASE_FILE_NAME = ".glossary-root.lifecycle.lock";
const ROOT_LEASE_MAX_BYTES = 16 * 1024;
const PROCESS_START_IDENTITY = randomUUID();
const ZIP_CENTRAL_DIRECTORY_FILE_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffff_ffff;
const REQUIRED_COLUMNS = ["id", "source", "aliases", "target_exact"] as const;
const TEMPORARY_ARTIFACT_NAME = /^[a-f0-9]{64}\.(?:glossary\.enc|delete\.json)\.[a-f0-9]{24}\.tmp$/u;
const TEMPORARY_ROOT_LOCK_NAME = /^\.glossary-root\.lifecycle\.lock(?:\.[a-f0-9]{24}\.reclaim)?\.[a-f0-9]{24}\.tmp$/u;

const MAX_GLOSSARY_IMPORT_ROWS = MAX_ENTRIES;

const persistedSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  version: z.string(),
  sourceLanguage: z.string(),
  targetLanguage: z.string(),
  entries: z.array(z.object({
    id: z.string(),
    source: z.string(),
    aliases: z.array(z.string()),
    targetExact: z.string(),
  }).strict()),
  approval: z.object({
    approvedBy: z.string(),
    approvedAt: z.string(),
  }).strict(),
  importedAt: z.string(),
  sourceFileName: z.string(),
  hash: z.string(),
}).strict();

const encryptedEnvelopeSchema = z.object({
  schemaVersion: z.literal(ENVELOPE_SCHEMA_VERSION),
  kind: z.literal(ENVELOPE_KIND),
  algorithm: z.literal(ENVELOPE_ALGORITHM),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
}).strict();

interface EncryptedGlossaryEnvelope {
  readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  readonly kind: typeof ENVELOPE_KIND;
  readonly algorithm: typeof ENVELOPE_ALGORITHM;
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface PersistedGlossaryVersion {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly GlossaryEntrySpec[];
  readonly approval: GlossaryApproval;
  readonly importedAt: string;
  readonly sourceFileName: string;
  readonly hash: string;
}

export interface GlossaryApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface GlossaryImportRequest {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly approval: GlossaryApproval;
  readonly fileName: string;
  readonly contents: Uint8Array;
}

export interface ImportedGlossaryVersion {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly entryCount: number;
  readonly approval: GlossaryApproval;
  readonly importedAt: string;
  readonly sourceFileName: string;
  readonly storagePath: string;
}

export interface PinnedGlossaryVersion extends ImportedGlossaryVersion {
  readonly compiled: CompiledGlossary;
}

export interface AcquiredGlossaryVersion {
  readonly glossary: PinnedGlossaryVersion;
  /** Idempotently releases the in-memory use lease for this immutable version. */
  release(): Promise<void>;
}

/**
 * Exclusive, process-owned authority over one configured glossary root.
 * Hold it for the server lifetime; releasing it prevents new repository
 * operations from this instance and permits a later process to take over.
 */
export interface GlossaryRootLease {
  release(): Promise<void>;
}

export interface GlossaryDeletionRequest {
  readonly id: string;
  readonly version: string;
  readonly commandId: string;
  readonly ownerId: string;
  readonly reason: string;
  readonly requestedAtMs: number;
}

export type GlossaryDeletionResult =
  | Readonly<{
    readonly status: "completed";
    readonly deletionReceiptId: string;
    readonly requestedAtMs: number;
    readonly deletedAtMs: number;
  }>
  | Readonly<{ readonly status: "active" | "not_found" | "conflict" }>;

interface GlossaryDeletionReceipt {
  readonly schemaVersion: 1;
  readonly kind: typeof DELETION_RECEIPT_KIND;
  readonly storageId: string;
  readonly deletionReceiptId: string;
  readonly commandIdHmac: string;
  readonly requestHmac: string;
  readonly ownerIdHmac: string;
  readonly reasonHmac: string;
  readonly encryptedArtifactSha256: string;
  readonly requestedAtMs: number;
  readonly status: "pending" | "completed";
  readonly deletedAtMs?: number;
  readonly receiptHmac: string;
}

interface GlossaryRootLeaseMarker {
  readonly schemaVersion: typeof ROOT_LEASE_SCHEMA_VERSION;
  readonly kind: typeof ROOT_LEASE_KIND;
  readonly host: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly lockId: string;
  readonly markerHmac: string;
}

interface GlossaryRootReclaimClaimMarker {
  readonly schemaVersion: typeof ROOT_LEASE_SCHEMA_VERSION;
  readonly kind: typeof ROOT_LEASE_RECLAIM_KIND;
  readonly targetDigest: string;
  readonly host: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly lockId: string;
  readonly markerHmac: string;
}

interface RootScopeSnapshot {
  readonly configuredPath: string;
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

interface RootLockMarkerSnapshot {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly contents: string;
  readonly digest: string;
  readonly parsed: unknown;
}

interface HeldGlossaryRootLease {
  readonly path: string;
  readonly lockId: string;
  closing: boolean;
  activeOperations: number;
  operationsDrained: Promise<void> | undefined;
  resolveOperationsDrained: (() => void) | undefined;
  releasePromise: Promise<void> | undefined;
}

type UnsignedGlossaryDeletionReceipt = Omit<GlossaryDeletionReceipt, "receiptHmac">;

export interface FileGlossaryRepositoryOptions {
  readonly directory: string;
  /** Dedicated common parent hardened before this root is trusted on Windows. */
  readonly securityBoundaryDirectory?: string;
  /** Check ancestors above the dedicated boundary for replacement rights on Windows. */
  readonly strictAncestors?: boolean;
  /** The deployment root key. It is purpose-separated with HKDF internally. */
  readonly rootKey: Uint8Array;
  readonly now?: () => Date;
}

export class GlossaryVersionConflictError extends Error {
  constructor(id: string, version: string) {
    super("glossary " + id + "@" + version + " already exists with different content");
    this.name = "GlossaryVersionConflictError";
  }
}

export class GlossaryVersionNotFoundError extends Error {
  constructor(id: string, version: string) {
    super("glossary " + id + "@" + version + " does not exist");
    this.name = "GlossaryVersionNotFoundError";
  }
}

export class GlossaryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryIntegrityError";
  }
}

export class GlossaryVersionDeletedError extends Error {
  constructor() {
    super("A deleted glossary version cannot be recreated or acquired");
    this.name = "GlossaryVersionDeletedError";
  }
}

export class FileGlossaryRepository {
  readonly #directory: string;
  readonly #securityBoundaryDirectory: string | undefined;
  readonly #strictAncestors: boolean;
  readonly #encryptionKey: Buffer;
  readonly #storageIdKey: Buffer;
  readonly #receiptKey: Buffer;
  readonly #rootLeaseKey: Buffer;
  readonly #now: () => Date;
  readonly #versionLocks = new Map<string, Promise<void>>();
  readonly #leaseCounts = new Map<string, number>();
  #validatedRootScope: RootScopeSnapshot | undefined;
  #rootProcessLease: HeldGlossaryRootLease | undefined;
  #rootLifecycleQueue = Promise.resolve();

  constructor(options: FileGlossaryRepositoryOptions) {
    if (options.directory.trim().length === 0) {
      throw new TypeError("glossary repository directory must not be empty");
    }
    if (options.securityBoundaryDirectory !== undefined && options.securityBoundaryDirectory.trim().length === 0) {
      throw new TypeError("glossary security boundary directory must not be empty");
    }
    if (!(options.rootKey instanceof Uint8Array) || options.rootKey.byteLength !== 32) {
      throw new RangeError("glossary repository root key must be exactly 32 bytes");
    }
    this.#directory = resolve(options.directory);
    this.#securityBoundaryDirectory = options.securityBoundaryDirectory === undefined
      ? undefined
      : resolve(options.securityBoundaryDirectory);
    if (options.strictAncestors !== undefined && typeof options.strictAncestors !== "boolean") {
      throw new TypeError("strictAncestors must be a boolean");
    }
    this.#strictAncestors = options.strictAncestors ?? true;
    const rootKey = Buffer.from(options.rootKey);
    this.#encryptionKey = deriveKey(rootKey, "payload-encryption");
    this.#storageIdKey = deriveKey(rootKey, "storage-identity");
    this.#receiptKey = deriveKey(rootKey, "deletion-receipt-authentication");
    this.#rootLeaseKey = deriveKey(rootKey, "root-lease-authentication");
    rootKey.fill(0);
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Acquires exclusive process ownership of this configured security root.
   * The caller holds this lease for its complete server lifecycle.
   */
  async acquireRootLease(): Promise<GlossaryRootLease> {
    return this.#withRootLifecycleLock(async () => {
      if (this.#rootProcessLease !== undefined) {
        throw new Error("This glossary repository already owns a root process lease");
      }
      await this.#assertNoLiveForeignRootLeaseBeforeRootMutation();
      await this.#ensureRoot();
      const path = this.#rootLeasePath();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const lockId = randomUUID();
        const markerBody = {
          schemaVersion: ROOT_LEASE_SCHEMA_VERSION,
          kind: ROOT_LEASE_KIND,
          host: hostname(),
          processId: process.pid,
          processStartIdentity: PROCESS_START_IDENTITY,
          lockId,
        } as const;
        const marker: GlossaryRootLeaseMarker = Object.freeze({
          ...markerBody,
          markerHmac: this.#rootMarkerHmac(markerBody),
        });
        if (await this.#createExclusiveRootLockMarker(path, marker)) {
          const held: HeldGlossaryRootLease = {
            path,
            lockId,
            closing: false,
            activeOperations: 0,
            operationsDrained: undefined,
            resolveOperationsDrained: undefined,
            releasePromise: undefined,
          };
          this.#rootProcessLease = held;
          try {
            await this.#cleanupCrashTemporaryAliases();
            await this.#recoverPendingDeletions();
          } catch (error) {
            this.#rootProcessLease = undefined;
            await this.#releaseOwnedRootLockMarker(path, lockId).catch(() => undefined);
            throw error;
          }
          return Object.freeze({
            release: async (): Promise<void> => {
              const existing = held.releasePromise;
              if (existing !== undefined) return existing;
              const release = this.#releaseRootLease(held);
              held.releasePromise = release;
              try {
                await release;
              } catch (error) {
                if (held.releasePromise === release) held.releasePromise = undefined;
                throw error;
              }
            },
          });
        }
        if (attempt === 0 && await this.#reclaimDeadRootLease()) continue;
        throw new Error("Glossary root is leased by another process");
      }
      throw new Error("Glossary root process lease could not be acquired");
    });
  }

  async import(request: GlossaryImportRequest): Promise<ImportedGlossaryVersion> {
    const releaseRootOperation = await this.#enterOwnedRootOperation();
    try {
      validateApproval(request.approval);
      if (request.contents.byteLength === 0) {
        throw new TypeError("glossary import file must not be empty");
      }
      if (request.contents.byteLength > MAX_IMPORT_BYTES) {
        throw new TypeError("glossary import exceeds " + MAX_IMPORT_BYTES + " bytes");
      }

      const entries = await parseEntries(request.fileName, request.contents);
      if (entries.length === 0) {
        throw new TypeError("glossary import must contain at least one entry");
      }
      if (entries.length > MAX_ENTRIES) {
        throw new TypeError("glossary import exceeds " + MAX_ENTRIES + " entries");
      }

      const spec: GlossarySpec = {
        id: request.id,
        version: request.version,
        sourceLanguage: request.sourceLanguage,
        targetLanguage: request.targetLanguage,
        entries,
      };
      const compiled = compileGlossaryPair(spec).forward;
      const storageId = this.#storageId(compiled.id, compiled.version);
      const storagePath = this.#storagePath(storageId);
      const importedAt = this.#now().toISOString();
      const persisted: PersistedGlossaryVersion = {
        schemaVersion: 1,
        id: compiled.id,
        version: compiled.version,
        sourceLanguage: compiled.sourceLanguage,
        targetLanguage: compiled.targetLanguage,
        entries: Object.freeze(entries.map((entry) => Object.freeze({
          id: entry.id,
          source: entry.source,
          aliases: Object.freeze([...entry.aliases]),
          targetExact: entry.targetExact,
        }))),
        approval: Object.freeze({
          approvedBy: request.approval.approvedBy.trim(),
          approvedAt: new Date(request.approval.approvedAt).toISOString(),
        }),
        importedAt,
        sourceFileName: request.fileName,
        hash: compiled.hash,
      };

      const encrypted = this.#encrypt(storageId, persisted);
      return await this.#withVersionLock(storageId, async () => {
        await this.#ensureRoot();
        if (await this.#readDeletionReceipt(storageId) !== undefined) {
          throw new GlossaryVersionDeletedError();
        }
        try {
          await this.#writeNew(storagePath, encrypted);
          return importedRecord(persisted, storagePath);
        } catch (error) {
          if (!isNodeError(error, "EEXIST")) throw error;
          const existing = await this.#read(compiled.id, compiled.version);
          if (existing.hash !== compiled.hash) {
            throw new GlossaryVersionConflictError(compiled.id, compiled.version);
          }
          return importedRecord(existing, storagePath);
        }
      });
    } finally {
      await releaseRootOperation();
    }
  }

  async acquire(id: string, version: string): Promise<AcquiredGlossaryVersion> {
    const releaseRootOperation = await this.#enterOwnedRootOperation();
    try {
      const normalizedId = normalizedIdentity(id, "glossary id");
      const normalizedVersion = normalizedIdentity(version, "glossary version");
      const storageId = this.#storageId(normalizedId, normalizedVersion);
      return await this.#withVersionLock(storageId, async () => {
        await this.#ensureRoot();
        if (await this.#readDeletionReceipt(storageId) !== undefined) {
          throw new GlossaryVersionDeletedError();
        }
        const glossary = await this.#loadPinned(normalizedId, normalizedVersion);
        this.#leaseCounts.set(storageId, (this.#leaseCounts.get(storageId) ?? 0) + 1);
        let released = false;
        return Object.freeze({
          glossary,
          release: async (): Promise<void> => {
            await this.#withVersionLock(storageId, async () => {
              if (released) return;
              const count = this.#leaseCounts.get(storageId);
              if (count === undefined || count < 1) {
                throw new Error("Glossary lease accounting is invalid");
              }
              if (count === 1) this.#leaseCounts.delete(storageId);
              else this.#leaseCounts.set(storageId, count - 1);
              released = true;
            });
          },
        });
      });
    } finally {
      await releaseRootOperation();
    }
  }

  async delete(request: GlossaryDeletionRequest): Promise<GlossaryDeletionResult> {
    const releaseRootOperation = await this.#enterOwnedRootOperation();
    try {
      const normalized: GlossaryDeletionRequest = Object.freeze({
        id: normalizedIdentity(request.id, "glossary id"),
        version: normalizedIdentity(request.version, "glossary version"),
        commandId: normalizedCommandId(request.commandId),
        ownerId: normalizedAuditText(request.ownerId, "ownerId", 512),
        reason: normalizedAuditText(request.reason, "reason", 500),
        requestedAtMs: checkedEpochMs(request.requestedAtMs, "requestedAtMs"),
      });
      const storageId = this.#storageId(normalized.id, normalized.version);
      return await this.#withVersionLock(
        storageId,
        () => this.#deleteLocked(storageId, normalized),
      );
    } finally {
      await releaseRootOperation();
    }
  }

  async has(id: string, version: string): Promise<boolean> {
    const releaseRootOperation = await this.#enterOwnedRootOperation();
    try {
      const normalizedId = normalizedIdentity(id, "glossary id");
      const normalizedVersion = normalizedIdentity(version, "glossary version");
      const storageId = this.#storageId(normalizedId, normalizedVersion);
      return await this.#withVersionLock(storageId, async () => {
        await this.#ensureRoot();
        if (await this.#readDeletionReceipt(storageId) !== undefined) return false;
        try {
          const info = await lstat(this.#storagePath(storageId));
          return !info.isSymbolicLink() && info.isFile();
        } catch (error) {
          if (isNodeError(error, "ENOENT")) return false;
          throw error;
        }
      });
    } finally {
      await releaseRootOperation();
    }
  }

  async #deleteLocked(
    storageId: string,
    request: GlossaryDeletionRequest,
  ): Promise<GlossaryDeletionResult> {
    await this.#ensureRoot();
    await this.#cleanupCrashTemporaryAliases(storageId);
    const requestHmac = hmac(
      this.#receiptKey,
      "glossary-deletion-request",
      canonicalJson({ storageId, ownerId: request.ownerId, reason: request.reason }),
    );
    const existing = await this.#readDeletionReceipt(storageId);
    if (existing !== undefined) {
      if (
        !sameHex(existing.commandIdHmac, hmac(this.#receiptKey, "command-id", request.commandId)) ||
        !sameHex(existing.requestHmac, requestHmac)
      ) {
        return Object.freeze({ status: "conflict" as const });
      }
      return deletionResult(await this.#completePendingDeletion(storageId, existing));
    }
    if ((this.#leaseCounts.get(storageId) ?? 0) > 0) {
      return Object.freeze({ status: "active" as const });
    }

    let encryptedArtifactSha256: string;
    try {
      encryptedArtifactSha256 = await this.#managedFileSha256(this.#storagePath(storageId));
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return Object.freeze({ status: "not_found" as const });
      throw error;
    }
    const pending = this.#signDeletionReceipt({
      schemaVersion: 1,
      kind: DELETION_RECEIPT_KIND,
      storageId,
      deletionReceiptId: hmac(
        this.#receiptKey,
        "glossary-deletion-receipt",
        storageId + "\u0000" + request.commandId,
      ),
      commandIdHmac: hmac(this.#receiptKey, "command-id", request.commandId),
      requestHmac,
      ownerIdHmac: hmac(this.#receiptKey, "deletion-owner", request.ownerId),
      reasonHmac: hmac(this.#receiptKey, "deletion-reason", request.reason),
      encryptedArtifactSha256,
      requestedAtMs: request.requestedAtMs,
      status: "pending",
    });
    try {
      await this.#writeNew(
        this.#receiptPath(storageId),
        JSON.stringify(pending) + "\n",
      );
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const raced = await this.#readDeletionReceipt(storageId);
      if (raced === undefined) throw error;
      if (
        !sameHex(raced.commandIdHmac, pending.commandIdHmac) ||
        !sameHex(raced.requestHmac, pending.requestHmac)
      ) {
        return Object.freeze({ status: "conflict" as const });
      }
      return deletionResult(await this.#completePendingDeletion(storageId, raced));
    }
    return deletionResult(await this.#completePendingDeletion(storageId, pending));
  }

  async #loadPinned(id: string, version: string): Promise<PinnedGlossaryVersion> {
    const persisted = await this.#read(id, version);
    if (persisted.id !== id || persisted.version !== version) {
      throw new GlossaryIntegrityError(
        "glossary storage identity does not match its requested immutable version",
      );
    }
    let compiled: CompiledGlossary;
    try {
      compiled = compileGlossaryPair({
        id: persisted.id,
        version: persisted.version,
        sourceLanguage: persisted.sourceLanguage,
        targetLanguage: persisted.targetLanguage,
        entries: persisted.entries,
      }).forward;
    } catch {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    }
    if (compiled.hash !== persisted.hash) {
      throw new GlossaryIntegrityError(
        "glossary " + persisted.id + "@" + persisted.version +
          " failed its content hash",
      );
    }
    return Object.freeze({
      ...importedRecord(
        persisted,
        this.#storagePath(this.#storageId(id, version)),
      ),
      compiled,
    });
  }

  async #read(id: string, version: string): Promise<PersistedGlossaryVersion> {
    const storageId = this.#storageId(id, version);
    const storagePath = this.#storagePath(storageId);
    await this.#ensureRoot();
    let serialized: string;
    try {
      const info = await lstat(storagePath);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size === 0 ||
        info.size > MAX_ENCRYPTED_GLOSSARY_BYTES ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      ) {
        throw new GlossaryIntegrityError("glossary storage failed integrity verification");
      }
      serialized = await readFile(storagePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new GlossaryVersionNotFoundError(id, version);
      }
      throw error;
    }

    return this.#decrypt(storageId, serialized);
  }

  #storageId(id: string, version: string): string {
    return hmac(
      this.#storageIdKey,
      "glossary-storage-identity",
      canonicalJson({ id, version }),
    );
  }

  #storagePath(storageId: string): string {
    const path = resolve(
      this.#directory,
      storageId + ".glossary.enc",
    );
    if (path !== this.#directory && !path.startsWith(this.#directory + sep)) {
      throw new TypeError("glossary path escaped its repository");
    }
    return path;
  }

  #receiptPath(storageId: string): string {
    const path = resolve(this.#directory, storageId + ".delete.json");
    if (path !== this.#directory && !path.startsWith(this.#directory + sep)) {
      throw new TypeError("glossary receipt path escaped its repository");
    }
    return path;
  }

  #rootLeasePath(): string {
    const path = resolve(this.#directory, ROOT_LEASE_FILE_NAME);
    if (path !== this.#directory && !path.startsWith(this.#directory + sep)) {
      throw new TypeError("glossary root lease path escaped its repository");
    }
    return path;
  }

  #encrypt(storageId: string, persisted: PersistedGlossaryVersion): string {
    const plaintext = Buffer.from(JSON.stringify(persisted), "utf8");
    try {
      const nonce = randomBytes(ENVELOPE_NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
      cipher.setAAD(glossaryAad(storageId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope: EncryptedGlossaryEnvelope = Object.freeze({
        schemaVersion: ENVELOPE_SCHEMA_VERSION,
        kind: ENVELOPE_KIND,
        algorithm: ENVELOPE_ALGORITHM,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      });
      return JSON.stringify(envelope) + "\n";
    } finally {
      plaintext.fill(0);
    }
  }

  #decrypt(storageId: string, serialized: string): PersistedGlossaryVersion {
    let candidate: unknown;
    try {
      candidate = JSON.parse(serialized);
    } catch {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    }
    const envelope = encryptedEnvelopeSchema.safeParse(candidate);
    if (!envelope.success) {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    }

    let plaintext: Buffer | undefined;
    try {
      const nonce = decodeCanonicalBase64(envelope.data.nonce, ENVELOPE_NONCE_BYTES);
      const tag = decodeCanonicalBase64(envelope.data.tag, ENVELOPE_TAG_BYTES);
      const ciphertext = decodeCanonicalBase64(envelope.data.ciphertext);
      if (ciphertext.byteLength === 0) throw new Error("empty encrypted glossary");
      const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, nonce);
      decipher.setAAD(glossaryAad(storageId));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      candidate = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    } finally {
      plaintext?.fill(0);
    }

    const persisted = persistedSchema.safeParse(candidate);
    if (!persisted.success) {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    }
    validatePersistedMetadata(persisted.data);
    return freezePersisted(persisted.data);
  }

  async #ensureRoot(): Promise<void> {
    const cached = this.#validatedRootScope;
    if (cached !== undefined) {
      await this.#assertCachedSecurityRoot(cached);
      return;
    }
    await this.#assertRootAncestorsAreRealDirectories(this.#directory);
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.#assertRootAncestorsAreRealDirectories(this.#directory);
    let info = await lstat(this.#directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Glossary security root must be a real directory");
    }
    if (process.platform !== "win32") {
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("Glossary security root must be owned by the service user on POSIX");
      }
      await chmod(this.#directory, 0o700);
      info = await lstat(this.#directory);
      this.#assertPosixRootAccess(info, "must be owner-only on POSIX");
    } else {
      await hardenWindowsSecurityRoot(this.#directory, this.#securityBoundaryDirectory, this.#strictAncestors);
    }
    this.#validatedRootScope = Object.freeze({
      configuredPath: this.#directory,
      realPath: await realpath(this.#directory),
      device: String(info.dev),
      inode: String(info.ino),
    });
  }

  /**
   * Admission must be read-only until a live foreign process lease has been
   * ruled out. In particular, do not mkdir/chmod a root that belongs to a
   * running server merely to discover its lock marker.
   */
  async #assertNoLiveForeignRootLeaseBeforeRootMutation(): Promise<void> {
    await this.#assertRootAncestorsAreRealDirectories(this.#directory);
    const marker = await this.#readRootLockMarkerSnapshot(this.#rootLeasePath());
    if (marker === undefined) return;
    if (await this.#isStaleRootLockMarker(
      marker.parsed,
      (value: unknown): value is GlossaryRootLeaseMarker => this.#isGlossaryRootLeaseMarker(value),
    )) {
      return;
    }
    throw new Error("Glossary root is leased by another process");
  }

  async #assertCachedSecurityRoot(snapshot: RootScopeSnapshot): Promise<void> {
    await this.#assertRootAncestorsAreRealDirectories(snapshot.configuredPath);
    const info = await lstat(snapshot.configuredPath);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      String(info.dev) !== snapshot.device ||
      String(info.ino) !== snapshot.inode ||
      await realpath(snapshot.configuredPath) !== snapshot.realPath
    ) {
      throw new Error("Glossary security root changed after validation");
    }
    if (process.platform === "win32") {
      await verifyWindowsSecurityRoot(
        snapshot.configuredPath,
        this.#securityBoundaryDirectory,
        this.#strictAncestors,
      );
    } else {
      this.#assertPosixRootAccess(info, "must remain owner-only on POSIX");
    }
  }

  #assertPosixRootAccess(info: Awaited<ReturnType<typeof lstat>>, requirement: string): void {
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (Number(info.mode) & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())
    ) {
      throw new Error("Glossary security root " + requirement);
    }
  }

  /**
   * `lstat(root)` follows symlinked parents. Inspect the whole lexical chain
   * before creating or trusting the root, then reject replaceable parents on
   * POSIX unless the sticky-bit protects the service-owned child entry.
   */
  async #assertRootAncestorsAreRealDirectories(root: string): Promise<void> {
    const configuredRoot = resolve(root);
    const ancestors: string[] = [];
    for (let current = configuredRoot; ; current = dirname(current)) {
      ancestors.push(current);
      if (dirname(current) === current) break;
    }
    for (const ancestor of ancestors.reverse()) {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(ancestor);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Glossary security root has a symbolic-link or non-directory ancestor");
      }
      if (
        process.platform !== "win32" &&
        ancestor !== configuredRoot &&
        (info.mode & 0o022) !== 0 &&
        (info.mode & 0o1000) === 0
      ) {
        throw new Error("Glossary security root has a writable non-sticky ancestor");
      }
    }
  }

  async #withRootLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#rootLifecycleQueue;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#rootLifecycleQueue = queued;
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#rootLifecycleQueue === queued) this.#rootLifecycleQueue = Promise.resolve();
    }
  }

  async #enterOwnedRootOperation(): Promise<() => Promise<void>> {
    const held = await this.#withRootLifecycleLock(async () => {
      const candidate = this.#rootProcessLease;
      if (candidate === undefined || candidate.closing) {
        throw new Error("An instance-owned glossary root lease is required");
      }
      await this.#ensureRoot();
      await this.#assertHeldRootLeaseOwnership(candidate);
      candidate.activeOperations += 1;
      if (candidate.activeOperations === 1) {
        candidate.operationsDrained = new Promise<void>((resolve) => {
          candidate.resolveOperationsDrained = resolve;
        });
      }
      return candidate;
    });
    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      await this.#withRootLifecycleLock(async () => {
        if (held.activeOperations < 1) {
          throw new Error("Glossary root lease operation accounting is invalid");
        }
        held.activeOperations -= 1;
        if (held.activeOperations === 0) {
          held.resolveOperationsDrained?.();
          held.operationsDrained = undefined;
          held.resolveOperationsDrained = undefined;
        }
      });
    };
  }

  async #releaseRootLease(held: HeldGlossaryRootLease): Promise<void> {
    let operationsDrained: Promise<void> | undefined;
    await this.#withRootLifecycleLock(async () => {
      if (this.#rootProcessLease !== held) return;
      if ([...this.#leaseCounts.values()].some((count) => count > 0)) {
        throw new Error("Glossary root lease cannot be released while a glossary version is leased");
      }
      held.closing = true;
      operationsDrained = held.operationsDrained;
    });
    await operationsDrained;
    await this.#withRootLifecycleLock(async () => {
      if (this.#rootProcessLease !== held) return;
      await this.#ensureRoot();
      if ([...this.#leaseCounts.values()].some((count) => count > 0)) {
        held.closing = false;
        throw new Error("Glossary root lease cannot be released while a glossary version is leased");
      }
      await this.#releaseOwnedRootLockMarker(held.path, held.lockId);
      if (this.#rootProcessLease === held) this.#rootProcessLease = undefined;
    });
  }

  async #assertHeldRootLeaseOwnership(held: HeldGlossaryRootLease): Promise<void> {
    const snapshot = await this.#readRootLockMarkerSnapshot(held.path);
    if (
      snapshot === undefined ||
      !this.#isGlossaryRootLeaseMarker(snapshot.parsed) ||
      snapshot.parsed.host !== hostname() ||
      snapshot.parsed.processId !== process.pid ||
      snapshot.parsed.processStartIdentity !== PROCESS_START_IDENTITY ||
      snapshot.parsed.lockId !== held.lockId
    ) {
      throw new Error("Glossary root lease ownership was lost");
    }
  }

  async #createExclusiveRootLockMarker(
    path: string,
    marker: GlossaryRootLeaseMarker | GlossaryRootReclaimClaimMarker,
  ): Promise<boolean> {
    const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdTemporary = false;
    let linked = false;
    let committed = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      createdTemporary = true;
      await handle.writeFile(JSON.stringify(marker) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, path);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) return false;
        throw error;
      }
      linked = true;
      if (process.platform !== "win32") await chmod(path, 0o600);
      await this.#syncDirectory();
      committed = true;
      return true;
    } catch (error) {
      if (linked && !committed) {
        await this.#releaseOwnedRootLockMarker(path, marker.lockId).catch(() => undefined);
      }
      throw error;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (createdTemporary) {
        await unlink(temporary).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      }
    }
  }

  async #readRootLockMarkerSnapshot(path: string): Promise<RootLockMarkerSnapshot | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const lexicalInfo = await lstat(path);
      if (
        lexicalInfo.isSymbolicLink() ||
        !lexicalInfo.isFile() ||
        lexicalInfo.size === 0 ||
        lexicalInfo.size > ROOT_LEASE_MAX_BYTES ||
        (process.platform !== "win32" && (lexicalInfo.mode & 0o077) !== 0)
      ) {
        throw new Error("Glossary root lease marker is not a secure regular file");
      }
      handle = await open(path, "r");
      const info = await handle.stat();
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        String(info.dev) !== String(lexicalInfo.dev) ||
        String(info.ino) !== String(lexicalInfo.ino) ||
        info.size === 0 ||
        !Number.isSafeInteger(info.size) ||
        info.size > ROOT_LEASE_MAX_BYTES ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      ) {
        throw new Error("Glossary root lease marker changed during read");
      }
      const bytes = Buffer.alloc(ROOT_LEASE_MAX_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          bytesRead,
          bytes.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      const finalInfo = await handle.stat();
      const currentPathInfo = await lstat(path);
      if (
        finalInfo.dev !== info.dev ||
        finalInfo.ino !== info.ino ||
        currentPathInfo.isSymbolicLink() ||
        !currentPathInfo.isFile() ||
        String(currentPathInfo.dev) !== String(info.dev) ||
        String(currentPathInfo.ino) !== String(info.ino) ||
        bytesRead !== finalInfo.size ||
        finalInfo.size > ROOT_LEASE_MAX_BYTES ||
        bytesRead > ROOT_LEASE_MAX_BYTES
      ) {
        throw new Error("Glossary root lease marker exceeds its bounded descriptor read");
      }
      const contents = bytes.subarray(0, bytesRead).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        parsed = undefined;
      }
      return Object.freeze({
        path,
        device: String(info.dev),
        inode: String(info.ino),
        contents,
        digest: createHash("sha256").update(contents, "utf8").digest("hex"),
        parsed,
      });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  }

  #sameRootLockMarkerSnapshot(left: RootLockMarkerSnapshot, right: RootLockMarkerSnapshot): boolean {
    return left.path === right.path &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.digest === right.digest;
  }

  #hasRootLockOwnership(marker: unknown): marker is Readonly<{
    readonly schemaVersion: 1;
    readonly host: string;
    readonly processId: number;
    readonly processStartIdentity: string;
    readonly lockId: string;
    readonly [key: string]: unknown;
  }> {
    if (!isPlainObject(marker)) return false;
    const candidate = marker as Partial<{
      readonly schemaVersion: unknown;
      readonly host: unknown;
      readonly processId: unknown;
      readonly processStartIdentity: unknown;
      readonly lockId: unknown;
    }>;
    return candidate.schemaVersion === ROOT_LEASE_SCHEMA_VERSION &&
      typeof candidate.host === "string" && candidate.host.length > 0 &&
      isNonNegativeSafeInteger(candidate.processId) && candidate.processId > 0 &&
      isUuid(candidate.processStartIdentity) &&
      isUuid(candidate.lockId);
  }

  #rootMarkerHmac(marker: Readonly<Record<string, unknown>>): string {
    return hmac(
      this.#rootLeaseKey,
      "glossary-root-lease-marker",
      canonicalJson(marker),
    );
  }

  #isAuthenticatedRootMarker(marker: unknown): boolean {
    if (!isPlainObject(marker) || !isHexSha256(marker.markerHmac)) return false;
    const { markerHmac: _markerHmac, ...body } = marker;
    return sameHex(marker.markerHmac, this.#rootMarkerHmac(body));
  }

  #isGlossaryRootLeaseMarker(marker: unknown): marker is GlossaryRootLeaseMarker {
    return this.#hasRootLockOwnership(marker) &&
      marker.kind === ROOT_LEASE_KIND &&
      this.#isAuthenticatedRootMarker(marker) &&
      hasExactObjectKeys(marker, [
        "host",
        "kind",
        "lockId",
        "markerHmac",
        "processId",
        "processStartIdentity",
        "schemaVersion",
      ]);
  }

  #isGlossaryRootReclaimClaim(marker: unknown): marker is GlossaryRootReclaimClaimMarker {
    return this.#hasRootLockOwnership(marker) &&
      marker.kind === ROOT_LEASE_RECLAIM_KIND &&
      this.#isAuthenticatedRootMarker(marker) &&
      isHexSha256(marker.targetDigest) &&
      hasExactObjectKeys(marker, [
        "host",
        "kind",
        "lockId",
        "markerHmac",
        "processId",
        "processStartIdentity",
        "schemaVersion",
        "targetDigest",
      ]);
  }

  async #isStaleRootLockMarker(
    marker: unknown,
    isExpectedMarker: (value: unknown) => boolean,
  ): Promise<boolean> {
    // An unauthenticated or malformed marker is not evidence of a dead lease.
    // Fail closed rather than letting an attacker manufacture a reclaimable
    // descriptor for a live process.
    if (!isExpectedMarker(marker) || !this.#hasRootLockOwnership(marker)) return false;
    if (marker.host !== hostname()) return false;
    if (marker.processId === process.pid) {
      return marker.processStartIdentity !== PROCESS_START_IDENTITY;
    }
    try {
      process.kill(marker.processId, 0);
      // Node cannot attest another live process's opaque incarnation. Fail
      // closed rather than reclaiming a PID that could have been reused.
      return false;
    } catch (error) {
      return isNodeError(error, "ESRCH");
    }
  }

  async #reclaimDeadRootLease(): Promise<boolean> {
    return this.#reclaimStaleRootLockMarker(
      this.#rootLeasePath(),
      (marker: unknown): marker is GlossaryRootLeaseMarker => this.#isGlossaryRootLeaseMarker(marker),
    );
  }

  #rootLockReclaimPath(snapshot: RootLockMarkerSnapshot): string {
    const digest = createHash("sha256")
      .update(snapshot.path + "\u0000" + snapshot.device + "\u0000" + snapshot.inode + "\u0000" + snapshot.digest, "utf8")
      .digest("hex");
    return snapshot.path + "." + digest.slice(0, 24) + ".reclaim";
  }

  async #reclaimStaleRootLockMarker(
    path: string,
    isExpectedMarker: (value: unknown) => boolean,
    depth = 0,
  ): Promise<boolean> {
    const snapshot = await this.#readRootLockMarkerSnapshot(path);
    if (snapshot === undefined) return true;
    if (!await this.#isStaleRootLockMarker(snapshot.parsed, isExpectedMarker)) return false;

    const claimPath = this.#rootLockReclaimPath(snapshot);
    const claimBody = {
      schemaVersion: ROOT_LEASE_SCHEMA_VERSION,
      kind: ROOT_LEASE_RECLAIM_KIND,
      targetDigest: snapshot.digest,
      host: hostname(),
      processId: process.pid,
      processStartIdentity: PROCESS_START_IDENTITY,
      lockId: randomUUID(),
    } as const;
    const claim: GlossaryRootReclaimClaimMarker = Object.freeze({
      ...claimBody,
      markerHmac: this.#rootMarkerHmac(claimBody),
    });
    if (!(await this.#createExclusiveRootLockMarker(claimPath, claim))) {
      if (
        depth >= 2 ||
        !await this.#reclaimStaleRootLockMarker(
          claimPath,
          (marker: unknown): marker is GlossaryRootReclaimClaimMarker =>
            this.#isGlossaryRootReclaimClaim(marker),
          depth + 1,
        )
      ) {
        return false;
      }
      return this.#reclaimStaleRootLockMarker(path, isExpectedMarker, depth + 1);
    }
    try {
      const current = await this.#readRootLockMarkerSnapshot(path);
      if (current === undefined) return true;
      if (!this.#sameRootLockMarkerSnapshot(snapshot, current)) return false;
      await unlink(path);
      await this.#syncDirectory();
      return true;
    } finally {
      await this.#releaseOwnedRootLockMarker(claimPath, claim.lockId);
    }
  }

  async #releaseOwnedRootLockMarker(path: string, lockId: string): Promise<void> {
    const snapshot = await this.#readRootLockMarkerSnapshot(path);
    if (
      snapshot === undefined ||
      (!this.#isGlossaryRootLeaseMarker(snapshot.parsed) &&
        !this.#isGlossaryRootReclaimClaim(snapshot.parsed))
    ) return;
    const marker = snapshot.parsed;
    if (
      marker.host !== hostname() ||
      marker.lockId !== lockId ||
      marker.processId !== process.pid ||
      marker.processStartIdentity !== PROCESS_START_IDENTITY
    ) {
      return;
    }
    try {
      const current = await this.#readRootLockMarkerSnapshot(path);
      if (current === undefined || !this.#sameRootLockMarkerSnapshot(snapshot, current)) return;
      await unlink(path);
      await this.#syncDirectory();
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  async #cleanupCrashTemporaryAliases(storageId?: string): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!entry.name.endsWith(".tmp")) continue;
      if (!TEMPORARY_ARTIFACT_NAME.test(entry.name) && !TEMPORARY_ROOT_LOCK_NAME.test(entry.name)) {
        throw new Error("Glossary security root contains an unexpected temporary file");
      }
      if (
        storageId !== undefined &&
        !entry.name.startsWith(storageId + ".glossary.enc.") &&
        !entry.name.startsWith(storageId + ".delete.json.")
      ) {
        continue;
      }
      const path = resolve(this.#directory, entry.name);
      if (path !== this.#directory && !path.startsWith(this.#directory + sep)) {
        throw new Error("Glossary temporary path escaped its repository");
      }
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Glossary temporary path is not a regular file");
      }
      await unlink(path);
      removed = true;
    }
    if (removed) await this.#syncDirectory();
  }

  async #recoverPendingDeletions(): Promise<void> {
    const entries = await readdir(this.#directory, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^([a-f0-9]{64})\.delete\.json$/u.exec(entry.name);
      if (match === null) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) {
        throw new Error("Glossary deletion receipt path is not a regular file");
      }
      const storageId = match[1]!;
      await this.#withVersionLock(storageId, async () => {
        const receipt = await this.#readDeletionReceipt(storageId);
        if (receipt === undefined || receipt.status === "completed") return;
        await this.#completePendingDeletion(storageId, receipt);
      });
    }
  }

  async #withVersionLock<T>(storageId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#versionLocks.get(storageId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#versionLocks.set(storageId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#versionLocks.get(storageId) === queued) this.#versionLocks.delete(storageId);
    }
  }

  #deletionReceiptHmac(receipt: object): string {
    return hmac(
      this.#receiptKey,
      "glossary-deletion-receipt-body",
      canonicalJson(receipt),
    );
  }

  #signDeletionReceipt(
    receipt: UnsignedGlossaryDeletionReceipt,
  ): GlossaryDeletionReceipt {
    return Object.freeze({
      ...receipt,
      receiptHmac: this.#deletionReceiptHmac(receipt),
    });
  }

  #assertDeletionReceiptHmac(candidate: Record<string, unknown>): void {
    const receiptHmac = candidate.receiptHmac;
    if (!isHexSha256(receiptHmac)) {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
    const expected = this.#deletionReceiptHmac(Object.fromEntries(
      Object.entries(candidate).filter(([key]) => key !== "receiptHmac"),
    ));
    if (!sameHex(receiptHmac, expected)) {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
  }

  async #readDeletionReceipt(storageId: string): Promise<GlossaryDeletionReceipt | undefined> {
    const path = this.#receiptPath(storageId);
    let serialized: string;
    try {
      const info = await lstat(path);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size === 0 ||
        info.size > MAX_DELETION_RECEIPT_BYTES ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      ) {
        throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
      }
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(serialized);
    } catch {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
    if (!isPlainObject(candidate)) {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
    this.#assertDeletionReceiptHmac(candidate);
    const receipt = candidate as Partial<GlossaryDeletionReceipt>;
    const expectedKeys = [
      "commandIdHmac",
      "deletionReceiptId",
      "encryptedArtifactSha256",
      "kind",
      "ownerIdHmac",
      "reasonHmac",
      "receiptHmac",
      "requestHmac",
      "requestedAtMs",
      "schemaVersion",
      "status",
      "storageId",
      ...(receipt.status === "completed" ? ["deletedAtMs"] : []),
    ].sort();
    if (
      canonicalJson(Object.keys(candidate).sort()) !== canonicalJson(expectedKeys) ||
      receipt.schemaVersion !== 1 ||
      receipt.kind !== DELETION_RECEIPT_KIND ||
      receipt.storageId !== storageId ||
      !isHexSha256(receipt.deletionReceiptId) ||
      !isHexSha256(receipt.commandIdHmac) ||
      !isHexSha256(receipt.requestHmac) ||
      !isHexSha256(receipt.ownerIdHmac) ||
      !isHexSha256(receipt.reasonHmac) ||
      !isHexSha256(receipt.encryptedArtifactSha256) ||
      !isHexSha256(receipt.receiptHmac) ||
      !isNonNegativeSafeInteger(receipt.requestedAtMs) ||
      (receipt.status !== "pending" && receipt.status !== "completed")
    ) {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
    if (
      receipt.status === "completed" &&
      (!isNonNegativeSafeInteger(receipt.deletedAtMs) ||
        receipt.deletedAtMs < receipt.requestedAtMs)
    ) {
      throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
    }
    return Object.freeze(receipt as GlossaryDeletionReceipt);
  }

  async #completePendingDeletion(
    storageId: string,
    receipt: GlossaryDeletionReceipt,
  ): Promise<GlossaryDeletionReceipt> {
    if (receipt.status === "completed") return receipt;
    await this.#removeExpectedArtifact(storageId, receipt.encryptedArtifactSha256);
    await this.#cleanupCrashTemporaryAliases(storageId);
    const observedAtMs = this.#now().getTime();
    if (!isNonNegativeSafeInteger(observedAtMs)) {
      throw new Error("glossary deletion clock is invalid");
    }
    // The receipt's requested timestamp is the monotonic lower bound. A wall
    // clock rollback must not strand a completed deletion as a pending tombstone.
    const deletedAtMs = Math.max(observedAtMs, receipt.requestedAtMs);
    const { receiptHmac: _ignored, ...unsigned } = receipt;
    const completed = this.#signDeletionReceipt({
      ...unsigned,
      status: "completed",
      deletedAtMs,
    });
    await this.#writeReplace(
      this.#receiptPath(storageId),
      JSON.stringify(completed) + "\n",
    );
    return completed;
  }

  async #managedFileSha256(path: string): Promise<string> {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      info.size === 0 ||
      info.size > MAX_ENCRYPTED_GLOSSARY_BYTES ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0)
    ) {
      throw new GlossaryIntegrityError("glossary storage failed integrity verification");
    }
    return createHash("sha256").update(await readFile(path)).digest("hex");
  }

  async #removeExpectedArtifact(storageId: string, expectedSha256: string): Promise<void> {
    const path = this.#storagePath(storageId);
    try {
      const actualSha256 = await this.#managedFileSha256(path);
      if (!sameHex(actualSha256, expectedSha256)) {
        throw new GlossaryIntegrityError("glossary storage failed integrity verification");
      }
      await unlink(path);
      await this.#syncDirectory();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
  }

  async #writeNew(path: string, contents: string): Promise<void> {
    const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let linked = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, path);
      linked = true;
      if (process.platform !== "win32") await chmod(path, 0o600);
      await this.#syncDirectory();
    } finally {
      if (handle !== undefined) await handle.close();
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
      if (linked) await this.#syncDirectory();
    }
  }

  async #writeReplace(path: string, contents: string): Promise<void> {
    const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renamed = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      renamed = true;
      if (process.platform !== "win32") await chmod(path, 0o600);
      await this.#syncDirectory();
    } finally {
      if (handle !== undefined) await handle.close();
      if (!renamed) {
        await unlink(temporary).catch((error: unknown) => {
          if (!isNodeError(error, "ENOENT")) throw error;
        });
      }
    }
  }

  async #syncDirectory(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.#directory, process.platform === "win32" ? "r+" : "r");
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }
}

function deriveKey(
  rootKey: Buffer,
  purpose:
    | "payload-encryption"
    | "storage-identity"
    | "deletion-receipt-authentication"
    | "root-lease-authentication",
): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    rootKey,
    Buffer.from("fast-translation/glossary-repository/v1", "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

function hmac(key: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", key)
    .update(purpose, "utf8")
    .update("\u0000", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function glossaryAad(storageId: string): Buffer {
  return Buffer.from(canonicalJson({
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    kind: ENVELOPE_KIND,
    storageId,
    purpose: "glossary-payload",
  }), "utf8");
}

function decodeCanonicalBase64(value: string, expectedBytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.byteLength === 0 ||
    decoded.toString("base64") !== value ||
    (expectedBytes !== undefined && decoded.byteLength !== expectedBytes)
  ) {
    throw new Error("invalid base64");
  }
  return decoded;
}

function freezePersisted(value: PersistedGlossaryVersion): PersistedGlossaryVersion {
  return Object.freeze({
    ...value,
    entries: Object.freeze(value.entries.map((entry) =>
      Object.freeze({
        ...entry,
        aliases: Object.freeze([...entry.aliases]),
      })
    )),
    approval: Object.freeze({ ...value.approval }),
  });
}

function validatePersistedMetadata(value: PersistedGlossaryVersion): void {
  try {
    if (
      normalizedIdentity(value.id, "stored glossary id") !== value.id ||
      normalizedIdentity(value.version, "stored glossary version") !== value.version ||
      value.sourceLanguage.trim().length === 0 ||
      value.targetLanguage.trim().length === 0 ||
      value.approval.approvedBy.trim().length === 0 ||
      !Number.isFinite(Date.parse(value.approval.approvedAt)) ||
      !Number.isFinite(Date.parse(value.importedAt)) ||
      value.sourceFileName.trim().length === 0 ||
      !isHexSha256(value.hash)
    ) {
      throw new Error("invalid stored glossary metadata");
    }
  } catch {
    throw new GlossaryIntegrityError("glossary storage failed integrity verification");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactObjectKeys(value: object, expected: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkedEpochMs(value: unknown, field: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(field + " must be a non-negative safe integer");
  }
  return value;
}

function normalizedCommandId(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("commandId must be a UUID");
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(normalized)) {
    throw new TypeError("commandId must be a UUID");
  }
  return normalized;
}

function normalizedAuditText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== "string") throw new TypeError(field + " must be text");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new RangeError(field + " must contain 1-" + maximumLength + " characters");
  }
  return normalized;
}

function isHexSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function sameHex(left: string, right: string): boolean {
  if (!isHexSha256(left) || !isHexSha256(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function deletionResult(receipt: GlossaryDeletionReceipt): GlossaryDeletionResult {
  if (receipt.status !== "completed" || receipt.deletedAtMs === undefined) {
    throw new GlossaryIntegrityError("glossary deletion receipt failed integrity verification");
  }
  return Object.freeze({
    status: "completed" as const,
    deletionReceiptId: receipt.deletionReceiptId,
    requestedAtMs: receipt.requestedAtMs,
    deletedAtMs: receipt.deletedAtMs,
  });
}

function normalizedIdentity(value: string, field: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (normalized.length === 0) throw new TypeError(field + " must not be empty");
  return normalized;
}

function validateApproval(approval: GlossaryApproval): void {
  if (approval.approvedBy.trim().length === 0) {
    throw new TypeError("approval.approvedBy must not be empty");
  }
  if (!Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new TypeError("approval.approvedAt must be an ISO date");
  }
}

function assertImportCellBounds(value: string): void {
  if (
    [...value].length > MAX_GLOSSARY_TERM_CHARACTERS ||
    Buffer.byteLength(value, "utf8") > MAX_GLOSSARY_TERM_UTF8_BYTES
  ) {
    throw new TypeError("glossary import cell exceeds the maximum normalized size");
  }
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (
    [...normalized].length > MAX_GLOSSARY_TERM_CHARACTERS ||
    Buffer.byteLength(normalized, "utf8") > MAX_GLOSSARY_TERM_UTF8_BYTES
  ) {
    throw new TypeError("glossary import cell exceeds the maximum normalized size");
  }
}

function assertImportRecordCellsBounded(record: unknown): void {
  if (typeof record !== "object" || record === null) return;
  for (const value of Object.values(record)) {
    if (typeof value === "string") assertImportCellBounds(value);
  }
}

async function parseEntries(
  fileName: string,
  contents: Uint8Array,
): Promise<GlossaryEntrySpec[]> {
  const extension = extname(fileName).toLocaleLowerCase("en-US");
  if (extension === ".csv") {
    let recordCount = 0;
    const records: unknown = parse(new TextDecoder().decode(contents), {
      bom: true,
      columns: (headers: string[]) => {
        headers.forEach(assertImportCellBounds);
        validateHeaders(headers);
        return headers.map(normalizeHeader);
      },
      on_record: (record: unknown) => {
        recordCount += 1;
        if (recordCount > MAX_GLOSSARY_IMPORT_ROWS) {
          throw new TypeError("glossary import exceeds the maximum row count");
        }
        assertImportRecordCellsBounded(record);
        return record;
      },
      skip_empty_lines: true,
      trim: true,
    });
    if (!Array.isArray(records)) {
      throw new TypeError("CSV glossary did not produce records");
    }
    return records.map((record, index) => entryFromUnknown(record, index + 2));
  }
  if (extension === ".xlsx") return parseXlsx(contents);
  throw new TypeError("glossary import must be a .csv or .xlsx file");
}

async function parseXlsx(contents: Uint8Array): Promise<GlossaryEntrySpec[]> {
  assertSafeXlsxArchive(contents);
  const workbook = new ExcelJS.Workbook();
  const loadBuffer = Buffer.from(contents) as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(loadBuffer);
  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new TypeError("XLSX glossary must contain a worksheet");
  }

  const headers: string[] = [];
  const records: Record<string, string>[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > MAX_GLOSSARY_IMPORT_ROWS + 1) {
      throw new TypeError("glossary import exceeds the maximum row count");
    }
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const text = cell.text;
      assertImportCellBounds(text);
      values[columnNumber - 1] = text.trim();
    });
    if (rowNumber === 1) {
      for (const value of values) headers.push(normalizeHeader(value));
      validateHeaders(headers);
      return;
    }
    if (values.every((value) => (value ?? "").length === 0)) return;
    const record: Record<string, string> = {};
    for (const [index, header] of headers.entries()) {
      record[header] = values[index] ?? "";
    }
    if (records.length >= MAX_GLOSSARY_IMPORT_ROWS) {
      throw new TypeError("glossary import exceeds the maximum row count");
    }
    records.push(record);
  });
  return records.map((record, index) => entryFromRecord(record, index + 2));
}

/**
 * Parses only ZIP central-directory metadata, before ExcelJS receives the
 * archive. It never inflates an entry, so declared expansion is bounded before
 * a malicious workbook can drive an allocation in the XLSX reader.
 */
function assertSafeXlsxArchive(contents: Uint8Array): void {
  const view = new DataView(contents.buffer, contents.byteOffset, contents.byteLength);
  const eocdOffset = findZipEndOfCentralDirectory(view);
  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnThisDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirectorySize = view.getUint32(eocdOffset + 12, true);
  const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnThisDisk !== entryCount) {
    throw new TypeError("XLSX archive must use a single ZIP disk");
  }
  if (
    entryCount === ZIP64_UINT16_SENTINEL ||
    centralDirectorySize === ZIP64_UINT32_SENTINEL ||
    centralDirectoryOffset === ZIP64_UINT32_SENTINEL
  ) {
    throw new TypeError("XLSX ZIP64 archives are not accepted for glossary import");
  }
  if (entryCount > MAX_XLSX_ARCHIVE_ENTRIES) {
    throw new TypeError(
      "XLSX archive entry count exceeds " + MAX_XLSX_ARCHIVE_ENTRIES,
    );
  }
  if (
    centralDirectoryOffset > eocdOffset ||
    centralDirectorySize > eocdOffset - centralDirectoryOffset
  ) {
    throw new TypeError("XLSX archive central directory is outside the archive");
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    const fixedHeaderBytes = 46;
    if (
      cursor > centralDirectoryEnd - fixedHeaderBytes ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_DIRECTORY_FILE_HEADER
    ) {
      throw new TypeError("XLSX archive central-directory entry is malformed");
    }

    const flags = view.getUint16(cursor + 8, true);
    const compressedBytes = view.getUint32(cursor + 20, true);
    const uncompressedBytes = view.getUint32(cursor + 24, true);
    const nameBytes = view.getUint16(cursor + 28, true);
    const extraBytes = view.getUint16(cursor + 30, true);
    const commentBytes = view.getUint16(cursor + 32, true);
    const headerBytes = fixedHeaderBytes + nameBytes + extraBytes + commentBytes;

    if ((flags & 0x0001) !== 0) {
      throw new TypeError("XLSX archive must not contain encrypted ZIP entries");
    }
    if (
      compressedBytes === ZIP64_UINT32_SENTINEL ||
      uncompressedBytes === ZIP64_UINT32_SENTINEL
    ) {
      throw new TypeError("XLSX ZIP64 archive entries are not accepted for glossary import");
    }
    if (cursor > centralDirectoryEnd - headerBytes) {
      throw new TypeError("XLSX archive central-directory entry exceeds its declared bounds");
    }
    if (
      uncompressedBytes > 0 &&
      (compressedBytes === 0 ||
        uncompressedBytes > compressedBytes * MAX_XLSX_COMPRESSION_RATIO)
    ) {
      throw new TypeError(
        "XLSX archive compression ratio exceeds " + MAX_XLSX_COMPRESSION_RATIO,
      );
    }
    if (uncompressedBytes > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new TypeError(
        "XLSX archive entry exceeds " + MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES +
          " uncompressed bytes",
      );
    }
    totalUncompressedBytes += uncompressedBytes;
    if (totalUncompressedBytes > MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new TypeError(
        "XLSX archive exceeds " + MAX_XLSX_TOTAL_UNCOMPRESSED_BYTES +
          " total uncompressed bytes",
      );
    }
    cursor += headerBytes;
  }

  if (cursor !== centralDirectoryEnd) {
    throw new TypeError("XLSX archive central-directory size does not match its entries");
  }
  if (totalUncompressedBytes > contents.byteLength * MAX_XLSX_COMPRESSION_RATIO) {
    throw new TypeError(
      "XLSX archive compression ratio exceeds " + MAX_XLSX_COMPRESSION_RATIO,
    );
  }
}

function findZipEndOfCentralDirectory(view: DataView): number {
  const fixedBytes = 22;
  if (view.byteLength < fixedBytes) {
    throw new TypeError("XLSX archive is missing the ZIP end record");
  }
  const earliestOffset = Math.max(0, view.byteLength - fixedBytes - ZIP64_UINT16_SENTINEL);
  for (let offset = view.byteLength - fixedBytes; offset >= earliestOffset; offset -= 1) {
    if (view.getUint32(offset, true) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = view.getUint16(offset + 20, true);
    if (offset + fixedBytes + commentBytes === view.byteLength) return offset;
  }
  throw new TypeError("XLSX archive is missing a valid ZIP central directory");
}

function entryFromUnknown(candidate: unknown, row: number): GlossaryEntrySpec {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("glossary row " + row + " must be an object");
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string") {
      throw new TypeError("glossary row " + row + " column " + key + " must be text");
    }
    record[normalizeHeader(key)] = value;
  }
  validateHeaders(Object.keys(record));
  return entryFromRecord(record, row);
}

function entryFromRecord(record: Record<string, string>, row: number): GlossaryEntrySpec {
  const id = record.id;
  const source = record.source;
  const targetExact = record.target_exact;
  if (id === undefined || source === undefined || targetExact === undefined) {
    throw new TypeError("glossary row " + row + " is missing a required column");
  }
  return {
    id,
    source,
    aliases: parseAliases(record.aliases ?? "", row),
    targetExact,
  };
}

function parseAliases(value: string, row: number): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new TypeError("glossary row " + row + " aliases must be valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.some((alias) => typeof alias !== "string")) {
      throw new TypeError("glossary row " + row + " aliases JSON must be a string array");
    }
    if (parsed.length > MAX_GLOSSARY_ALIASES_PER_ENTRY) {
      throw new TypeError("glossary entry exceeds the maximum alias count");
    }
    return parsed;
  }
  const aliases = trimmed.split(/[|;\n]/u).map((alias) => alias.trim()).filter(Boolean);
  if (aliases.length > MAX_GLOSSARY_ALIASES_PER_ENTRY) {
    throw new TypeError("glossary entry exceeds the maximum alias count");
  }
  return aliases;
}

function validateHeaders(headers: readonly string[]): void {
  const available = new Set<string>();
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    if (available.has(normalized)) {
      throw new TypeError("glossary import has duplicate normalized column " + normalized);
    }
    available.add(normalized);
  }
  for (const column of REQUIRED_COLUMNS) {
    if (!available.has(column)) {
      throw new TypeError("glossary import is missing required column " + column);
    }
  }
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[\s-]+/gu, "_");
}

function importedRecord(
  persisted: PersistedGlossaryVersion,
  storagePath: string,
): ImportedGlossaryVersion {
  return Object.freeze({
    id: persisted.id,
    version: persisted.version,
    hash: persisted.hash,
    entryCount: persisted.entries.length,
    approval: Object.freeze({ ...persisted.approval }),
    importedAt: persisted.importedAt,
    sourceFileName: persisted.sourceFileName,
    storagePath,
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

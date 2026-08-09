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
  appendFile,
  chmod,
  lstat,
  link,
  mkdir,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  hardenWindowsSecurityRoot,
  verifyWindowsSecurityRoots,
} from "../security/windows-root-acl.js";
import {
  validateEvidenceFinalizeRequest,
  validateEvidenceFinalization,
  validateRecorderPreflightRequest,
  validateRecorderPreflightResult,
} from "../../core/evidence-lifecycle.js";
import type {
  EvidenceReviewArtifactPort,
  EvidenceReviewLease,
  EvidenceReviewLeaseCompletion,
  EvidenceReviewLeaseResult,
  EvidenceReviewRequest,
} from "./review.js";
import type {
  EvidenceFinalization,
  EvidenceFinalizeRequest,
  EvidenceFinalizationFailureCode,
  FinalizedTrackDigest,
  RecorderPreflightFailureCode,
  RecorderPreflightRequest,
  RecorderPreflightResult,
} from "../../core/evidence-lifecycle.js";
import {
  validateSessionProcessingManifest,
  type SessionProcessingManifest,
} from "../../core/processing-profile.js";
import { CANONICAL_AUDIO } from "../../core/audio.js";
import { EVIDENCE_AUDIO_TRACKS } from "../../core/types.js";
import type {
  EvidenceAudioTrack,
  EvidencePort,
  EvidenceRecord,
  EvidenceReviewGrant,
} from "../../core/types.js";

const FORMAT_VERSION = 3 as const;
const AES_256_GCM = "aes-256-gcm";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const EMPTY_CHAIN_SHA256 = "0".repeat(64);
const EMPTY_LEDGER_SHA256 = createHash("sha256").update("").digest("hex");
const DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MINIMUM_FREE_BYTES = 64 * 1024 * 1024;
const MAX_PENDING_RECORDS = 1_000;
const MAX_PENDING_ARTIFACT_LIFECYCLE_OPERATIONS = 64;
const MAX_PENDING_ARTIFACT_LIFECYCLE_OPERATIONS_GLOBAL = 256;
// Ledger data is untrusted whenever it is recovered or replayed. Keep every
// physical line and decrypted envelope small enough to bound the scanner,
// JSON parser, and AES-GCM plaintext allocation independently of ledger size.
const ARCHIVE_STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_ARCHIVE_ENVELOPE_PLAINTEXT_BYTES = 1 * 1024 * 1024;
const MAX_ARCHIVE_ENVELOPE_LINE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_FREE_AUDIT_LINE_BYTES = 64 * 1024;
/**
 * Detached audit data is content-free, but it is still attacker-controlled
 * durable input. Keep both its physical size and authenticated entry count
 * bounded, while reserving the tail of the budget for owner lifecycle work
 * after reviewer reads.
 */
// A legal 64,000-record artifact may require 640 metadata pages at the
// public maximum page size. Keep a bounded traversal budget plus a reserved
// tail for owner lifecycle actions instead of stranding an authorized review
// part-way through an otherwise valid artifact.
const MAX_CONTENT_FREE_AUDIT_ENTRIES = 1_024;
const MAX_CONTENT_FREE_AUDIT_BYTES = 4 * 1024 * 1024;
const MAX_CONTENT_FREE_AUDIT_REVIEW_ENTRIES = 1_000;
const MAX_VERIFIED_AUDIT_HEAD_CACHE_ENTRIES = 256;
const MAX_LOCK_MARKER_BYTES = 16 * 1024;
const MAX_SESSION_SIDECAR_BYTES = 1 * 1024 * 1024;
const MAX_DELETION_RECEIPT_BYTES = 64 * 1024;
const MAX_CONTENT_FREE_AUDIT_HEAD_BYTES = 16 * 1024;
const MAX_SWEEP_HEALTH_BYTES = 16 * 1024;
const MAX_RECORD_SERIALIZED_BYTES = 768 * 1024;
const MAX_PENDING_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_RECORDS = 64_000;
const MAX_SESSION_SERIALIZED_RECORD_BYTES = 192 * 1024 * 1024;
const MAX_SESSION_AUDIO_BYTES = 128 * 1024 * 1024;
const MAX_SESSION_AUDIO_DURATION_MS = 5 * 60 * 1_000;
const FREE_SPACE_RECHECK_RECORD_INTERVAL = 256;
const ROOT_LEASE_RELEASE_DRAIN_TIMEOUT_MS = 1_000;
const MAX_STORED_COMMAND_RESULTS = 8;
const MAX_MANAGED_EXPORT_COMPLETION_VALUE_BYTES = 64 * 1024;
const MAX_MANAGED_EXPORT_MANIFEST_BYTES = 512 * 1024;
const MAX_MANAGED_EXPORT_CHECKSUMS_BYTES = 8 * 1024;
const MAX_RECORDER_PROBE_BYTES = 64 * 1024;
const PCM16LE_CODEC = "evidence_pcm16le";
const PCM16LE_CODEC_VERSION = 1 as const;
// A process-incarnation token distinguishes a crash-stale marker from a live
// process that happens to reuse the same numeric PID after restart.
const PROCESS_START_IDENTITY = randomUUID();

type SecurityRootName = "archive" | "key" | "export" | "receipt";
type WindowsRootAclOperation = "harden" | "verify";
type ArchivePurpose = "record" | "finalization_manifest" | "seal";
type AtomicWriteContents = Uint8Array | string;
type AtomicWriteProducer = (write: (contents: AtomicWriteContents) => Promise<void>) => Promise<void>;
type AtomicWriteSource = AtomicWriteContents | AtomicWriteProducer;
type RootKeyPurpose =
  | "dek_wrap"
  | "archive_id"
  | "audit_entry_encryption"
  | "audit_head_encryption"
  | "audit_chain_authentication"
  | "lock_marker_authentication";

type EvidenceAuditAction =
  | "review_metadata_page"
  | "review_audio_window"
  | "retention_view"
  | "owner_export"
  | "retention_extension"
  | "deletion";
type EvidenceAuditOutcome =
  | "completed"
  | "conflict"
  | "expired"
  | "grant_denied"
  | "integrity_failed"
  | "not_found"
  | "not_sealed"
  | "pending"
  | "rejected";
type EvidenceAuditRole = "retention_owner" | "evidence_reviewer" | "retention_system";

interface EncryptedBlob {
  readonly v: 3;
  readonly alg: "A256GCM";
  readonly index: number;
  readonly purpose: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface RecordEnvelope {
  readonly kind: "record";
  readonly index: number;
  readonly previousChainSha256: string;
  readonly recordSha256: string;
  readonly chainSha256: string;
  readonly record: EvidenceRecord;
}

interface FinalizationEnvelope {
  readonly kind: "finalization_manifest";
  readonly manifest: SessionArtifactFinalizationManifest;
}

interface SealEnvelope {
  readonly kind: "seal";
  readonly seal: SessionArtifactSeal;
}

type ArchiveEnvelope = RecordEnvelope | FinalizationEnvelope | SealEnvelope;

interface EvidenceLedgerProjection {
  readonly recordCount: number;
  readonly finalChainSha256: string;
  readonly trackDigests: Readonly<Record<EvidenceAudioTrack, EvidenceTrackDigest>>;
  readonly tracks: Readonly<Record<EvidenceAudioTrack, FinalizedTrackDigest>>;
  readonly consentReceiptRefs: readonly string[];
  readonly lastPersistedEventCursor: number;
  readonly processingManifest: SessionProcessingManifest;
  /** Raw grant is private to Store authorization, never exported in a summary. */
  readonly evidenceReviewGrant: EvidenceReviewGrant;
  readonly reviewGrantSha256: string;
  readonly audioTimeline: VerifiedAudioTimeline;
}

interface MutableEvidenceLedgerProjection {
  recordCount: number;
  serializedRecordBytes: number;
  finalChainSha256: string;
  readonly trackDigests: Record<EvidenceAudioTrack, EvidenceTrackDigest>;
  readonly tracks: Record<EvidenceAudioTrack, FinalizedTrackDigest>;
  readonly consentReceiptRefsBySide: Map<"A" | "B", string>;
  lastPersistedEventCursor: number | undefined;
  processingManifest: SessionProcessingManifest | undefined;
  evidenceReviewGrant: EvidenceReviewGrant | undefined;
  audioOriginTimelineAtMonoMs: number | undefined;
  audioLastTimelineAtMonoMs: number | undefined;
  readonly audioTrackState: Record<EvidenceAudioTrack, {
    originTimelineAtMonoMs: number | undefined;
    previousEndSampleFrame: number;
  }>;
}

interface ScannedRecordLedger {
  readonly projection: MutableEvidenceLedgerProjection;
  readonly sawTerminalEnvelope: boolean;
}

interface RetentionMetadata {
  readonly finalizedAtMonoMs: number;
  readonly finalizedAtMs: number;
  readonly initialRetentionDeadlineAtMs: number;
  readonly retentionDeadlineAtMs: number;
  readonly extensionUsed: boolean;
}

/**
 * Describes how a failed terminal artifact obtained its deletion audit. A
 * verified ledger can be admitted after restart; an explicit orphan fallback
 * is also safe to delete, but an ordinary unverified failure remains degraded.
 */
type FinalizationFailureAuditSource =
  | "verified_ledger"
  | "verified_sidecar_projection"
  | "orphaned_without_ledger"
  | "unverified_immediate";

/** Content-free audit data retained after the encrypted sidecar is erased. */
interface ExtensionApprovalAudit {
  readonly commandIdHmac: string;
  readonly ownerIdHmac: string;
  readonly reasonHmac: string;
  readonly approvedAtMs: number;
  readonly requestedDeadlineAtMs: number;
}

interface StoredCommandResult {
  readonly commandIdHmac: string;
  readonly requestHmac: string;
  readonly operation: "extend" | "delete";
  readonly result: RetentionExtensionResult | EvidenceDeletionResult;
}

interface PendingRetentionExtension {
  readonly commandIdHmac: string;
  readonly requestHmac: string;
  readonly ownerIdHmac: string;
  readonly reasonHmac: string;
  readonly auditActorIdHmac: string;
  readonly auditRequestHmac: string;
  readonly requestedDeadlineAtMs: number;
  readonly decidedAtMs: number;
  readonly result: Readonly<{
    readonly status: "extended";
    readonly retentionDeadlineAtMs: number;
    readonly extensionUsed: true;
  }>;
}

interface ManagedExportMetadata {
  readonly exportId: string;
  readonly commandIdHmac: string;
  readonly requestHmac: string;
  readonly ownerIdHmac: string;
  readonly auditActorIdHmac: string;
  readonly auditRequestHmac: string;
  readonly status: "pending" | "audit_pending" | "completed";
  readonly manifestFileSha256?: string;
  readonly completedAtMs?: number;
  /** Encrypted, JSON-only response metadata for idempotent authorized retries. */
  readonly completionValue?: JsonValue;
}

type JsonPrimitive = null | boolean | number | string;
interface JsonArray extends ReadonlyArray<JsonValue> {}
interface JsonObject { readonly [key: string]: JsonValue; }
type JsonValue = JsonPrimitive | JsonArray | JsonObject;

interface SessionArtifactMetadata {
  readonly schemaVersion: 3;
  readonly archiveId: string;
  readonly sessionId: string;
  readonly createdAtMs: number;
  /** Opaque frozen governance owner used only when a failed orphan has no ledger grant. */
  readonly dataOwnerIdHmac: string;
  readonly phase: "active" | "finalizing" | "sealed" | "FINALIZATION_FAILED" | "deletion_pending";
  readonly processingManifestSha256?: string;
  readonly processingProfileSha256?: string;
  readonly processingProfileReferenceDigest?: string;
  readonly preflight?: RecorderPreflightResult;
  readonly retention?: RetentionMetadata;
  readonly extensionApproval?: ExtensionApprovalAudit;
  readonly finalizationReason?: string;
  readonly finalizationLastPersistedEventCursor?: number;
  readonly finalizationFailureCode?: EvidenceFinalizationFailureCode;
  readonly finalizationFailureAudit?: FinalizationFailureAuditSource;
  readonly finalization?: SessionArtifactFinalizationManifest;
  readonly seal?: SessionArtifactSeal;
  readonly rebuildAttempted: boolean;
  readonly auditInitialized: boolean;
  readonly commands: readonly StoredCommandResult[];
  readonly pendingRetentionExtension?: PendingRetentionExtension;
  readonly managedExport?: ManagedExportMetadata;
}

interface SidecarFile {
  readonly schemaVersion: 3;
  readonly kind: "wrapped_session_dek";
  readonly archiveId: string;
  readonly wrappedDek: EncryptedBlob;
  readonly metadata: EncryptedBlob;
  readonly finalizedAtMonoMs?: number;
  readonly finalizedAtMs?: number;
  readonly retentionDeadlineAtMs?: number;
}

interface DeletionReceipt {
  readonly schemaVersion: 3;
  readonly kind: "evidence_deletion_receipt";
  readonly archiveId: string;
  readonly deletionReceiptId: string;
  readonly commandIdHmac: string;
  readonly requestHmac: string;
  readonly deletionActorHmac: string;
  readonly deletionReasonHmac: string;
  readonly disposition: "early" | "scheduled";
  readonly managedExportRegistered: boolean;
  readonly finalizedAtMs: number;
  readonly retentionDeadlineAtMs: number;
  readonly processingManifestSha256: string;
  readonly processingProfileSha256: string;
  readonly processingProfileReferenceDigest: string;
  readonly finalizationStatus: "sealed" | "FINALIZATION_FAILED";
  readonly finalizationFailureCode?: EvidenceFinalizationFailureCode;
  readonly finalizationFailureAudit?: FinalizationFailureAuditSource;
  readonly finalizationManifestSha256?: string;
  readonly finalSealSha256?: string;
  readonly encryptedLedgerSha256: string;
  readonly auditIntegrity: "valid" | "invalid";
  readonly auditCount: number;
  readonly auditHeadSha256: string;
  readonly extensionUsed: boolean;
  readonly extensionApproval?: ExtensionApprovalAudit;
  readonly verificationMaximumHours: 24;
  readonly status: "pending" | "completed";
  readonly startedAtMs: number;
  readonly deletedAtMs?: number;
  readonly completedWithinVerificationMaximumHours?: boolean;
  /** HMAC of the complete content-free receipt body, excluding this field. */
  readonly receiptHmac: string;
}

/**
 * The encrypted append-only journal contains no evidence content or stable
 * session identity. The per-entry head is HMAC-authenticated independently of
 * its AES-GCM envelope, and the separately encrypted head file prevents an
 * undetectable journal truncation from becoming a valid shorter history.
 */
interface ContentFreeAuditEntry {
  readonly action: EvidenceAuditAction;
  readonly outcome: EvidenceAuditOutcome;
  readonly role: EvidenceAuditRole;
  readonly actorIdHmac: string;
  readonly requestHmac: string;
  readonly responseSha256: string;
  readonly timestampMs: number;
  readonly priorHeadSha256: string;
  readonly headSha256: string;
  readonly count: number;
  readonly auditId: string;
}

interface ContentFreeAuditHead {
  readonly count: number;
  readonly headSha256: string;
}

interface AuditIntegritySnapshot extends ContentFreeAuditHead {
  readonly integrity: "valid" | "invalid";
}

interface AuditJournalSnapshot {
  readonly device: string;
  readonly inode: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

interface CachedAuditHead extends ContentFreeAuditHead {
  readonly journal?: AuditJournalSnapshot;
}

interface AuditAppendInput {
  readonly action: EvidenceAuditAction;
  readonly outcome: EvidenceAuditOutcome;
  readonly role: EvidenceAuditRole;
  readonly actorIdHmac: string;
  readonly requestHmac: string;
  readonly responseSha256: string;
  readonly timestampMs: number;
}

type UnsignedDeletionReceipt = Omit<DeletionReceipt, "receiptHmac">;

interface PendingDeletionReceiptInput {
  readonly commandId: string;
  readonly requestHmac: string;
  readonly actorId: string;
  readonly reason: string;
  readonly disposition: "early" | "scheduled";
  readonly startedAtMs: number;
}

interface SweepHealthFile {
  readonly schemaVersion: 3;
  readonly kind: "retention_sweep_health";
  readonly lastSuccessfulSweepAtMs: number;
}

interface ArtifactLifecycleLockFile {
  readonly schemaVersion: 3;
  readonly kind: "session_artifact_lifecycle_lock";
  readonly archiveId: string;
  readonly host: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly lockId: string;
  readonly markerHmac: string;
}

interface EvidenceRootLeaseFile {
  readonly schemaVersion: 3;
  readonly kind: "evidence_root_process_lease";
  readonly role: EvidenceRootLeaseRole;
  readonly host: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly lockId: string;
  readonly markerHmac: string;
}

interface LockReclaimClaimFile {
  readonly schemaVersion: 3;
  readonly kind: "evidence_lock_reclaim_claim";
  readonly targetDigest: string;
  readonly host: string;
  readonly processId: number;
  readonly processStartIdentity: string;
  readonly lockId: string;
  readonly markerHmac: string;
}

interface LockMarkerSnapshot {
  readonly path: string;
  readonly device: string;
  readonly inode: string;
  readonly contents: string;
  readonly digest: string;
  readonly parsed: unknown;
}

interface BoundedManagedFileSnapshot {
  readonly device: string;
  readonly inode: string;
  readonly contents: Buffer;
}

interface HeldFileLock {
  readonly path: string;
  readonly lockId: string;
}

/**
 * The root marker must outlive every operation admitted under it. `closing`
 * stops new admissions while `activeOperations` drains the work that already
 * proved ownership of this exact marker.
 */
interface HeldEvidenceRootLease {
  readonly role: EvidenceRootLeaseRole;
  readonly path: string;
  readonly lockId: string;
  closing: boolean;
  activeOperations: number;
  resolveDrain?: () => void;
}

interface SecurityRootSnapshot {
  readonly name: SecurityRootName;
  readonly configuredPath: string;
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
  readonly ancestors: readonly SecurityRootAncestorSnapshot[];
}

interface SecurityRootAncestorSnapshot {
  readonly configuredPath: string;
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

interface RuntimeState {
  readonly sessionId: string;
  readonly archiveId: string;
  readonly dek: Buffer;
  metadata: SessionArtifactMetadata;
  pending: number;
  pendingBytes: number;
  recordCount: number;
  serializedRecordBytes: number;
  audioBytes: number;
  audioOriginTimelineAtMonoMs: number | undefined;
  audioLastTimelineAtMonoMs: number | undefined;
  recordsSinceFreeSpaceCheck: number;
  chainSha256: string;
  closed: boolean;
  deleting: boolean;
  failure?: Error;
  terminalFenceError?: Error;
  readonly terminalFenceWaiters: Set<(error: Error) => void>;
  evictionScheduled: boolean;
  initialize: Promise<void>;
  tail: Promise<void>;
  finalization?: Promise<EvidenceFinalization>;
}

class RecorderPreflightError extends Error {
  readonly failureCode: RecorderPreflightFailureCode;

  constructor(failureCode: RecorderPreflightFailureCode, cause?: unknown) {
    super(failureCode, cause === undefined ? undefined : { cause });
    this.name = "RecorderPreflightError";
    this.failureCode = failureCode;
  }
}

class ArtifactLifecycleQueueFullError extends Error {
  constructor() {
    super("Artifact lifecycle operation capacity is exhausted");
    this.name = "ArtifactLifecycleQueueFullError";
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function checkedSessionId(sessionId: string): string {
  if (typeof sessionId !== "string") throw new RangeError("sessionId is required");
  const canonical = sessionId.normalize("NFC").trim();
  if (canonical.length === 0) throw new RangeError("sessionId is required");
  if (canonical !== sessionId || canonical.length > 256) {
    throw new RangeError("sessionId must be canonical and at most 256 characters");
  }
  return canonical;
}

function checkedCommandText(value: string, field: string): string {
  if (typeof value !== "string") throw new RangeError(field + " is required");
  const normalized = value.trim();
  if (normalized.length === 0) throw new RangeError(field + " is required");
  return normalized;
}

function checkedRetentionOwnerAuthority(value: unknown): RetentionOwnerAuthority {
  if (
    !isPlainObject(value) ||
    canonicalEvidenceJson(Object.keys(value).sort()) !== canonicalEvidenceJson(["actorId", "kind"]) ||
    value.kind !== "retention_owner"
  ) {
    throw new RangeError("retention owner authority is invalid");
  }
  return freeze({
    kind: "retention_owner" as const,
    actorId: checkedCanonicalReviewIdentity(value.actorId, "retention owner actorId"),
  });
}

function checkedEpochMs(value: number, field: string): number {
  if (!isNonNegativeSafeInteger(value)) {
    throw new RangeError(field + " must be a non-negative safe integer");
  }
  return value;
}

function assertFinalizationNotAborted(request: EvidenceFinalizeRequest): void {
  if (!request.abortSignal?.aborted) return;
  const error = new Error("Evidence finalization was cancelled before its terminal commit");
  error.name = "AbortError";
  throw error;
}

function checkedArchiveId(archiveId: string): string {
  if (!SHA256_HEX.test(archiveId)) {
    throw new RangeError("archiveId must be exactly 64 lowercase hexadecimal characters");
  }
  return archiveId;
}

function checkedCanonicalReviewIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(field + " is invalid");
  const canonical = value.normalize("NFC").trim();
  if (canonical !== value || canonical.length === 0 || canonical.length > 128) {
    throw new Error(field + " is invalid");
  }
  return canonical;
}

function checkedEvidenceReviewGrant(value: unknown): EvidenceReviewGrant {
  if (!isPlainObject(value)) throw new Error("Evidence review grant is invalid");
  const keys = Object.keys(value).sort();
  if (canonicalEvidenceJson(keys) !== canonicalEvidenceJson([
    "bilingualReviewerId",
    "dataOwnerId",
  ])) {
    throw new Error("Evidence review grant is invalid");
  }
  const dataOwnerId = checkedCanonicalReviewIdentity(value.dataOwnerId, "evidenceReviewGrant.dataOwnerId");
  const bilingualReviewerId = checkedCanonicalReviewIdentity(
    value.bilingualReviewerId,
    "evidenceReviewGrant.bilingualReviewerId",
  );
  if (dataOwnerId === bilingualReviewerId) {
    throw new Error("Evidence review grant is invalid");
  }
  return freeze({ dataOwnerId, bilingualReviewerId });
}

function canonicalEvidence(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Object.freeze({ $bytes: Buffer.from(value).toString("base64") });
  }
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalEvidence(entry)]),
    );
  }
  return value;
}

function canonicalEvidenceJson(value: unknown): string {
  return JSON.stringify(canonicalEvidence(value));
}

function jsonClone(value: unknown, errorMessage: string): JsonValue {
  const stack: Array<Readonly<{ readonly value: unknown; readonly depth: number; readonly exit?: boolean }>> = [
    { value, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let scalarBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current.exit) {
      if (current.value !== null && typeof current.value === "object") active.delete(current.value);
      continue;
    }
    const entry = current.value;
    if (current.depth > 32 || nodes > 4_096) throw new Error(errorMessage);
    if (entry === null || typeof entry === "boolean") continue;
    if (typeof entry === "string") scalarBytes += Buffer.byteLength(entry, "utf8");
    else if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error(errorMessage);
    } else if (typeof entry === "object") {
      if (!Array.isArray(entry) && !isPlainObject(entry)) throw new Error(errorMessage);
      if (active.has(entry)) throw new Error(errorMessage);
      if (visited.has(entry)) continue;
      visited.add(entry);
      active.add(entry);
      nodes += 1;
      stack.push({ value: entry, depth: current.depth, exit: true });
      for (const [key, child] of Object.entries(entry)) {
        scalarBytes += Buffer.byteLength(key, "utf8");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      throw new Error(errorMessage);
    }
    if (scalarBytes > MAX_MANAGED_EXPORT_COMPLETION_VALUE_BYTES) throw new Error(errorMessage);
  }
  let cloned: unknown;
  try {
    const serialized = canonicalEvidenceJson(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_MANAGED_EXPORT_COMPLETION_VALUE_BYTES) {
      throw new Error(errorMessage);
    }
    cloned = JSON.parse(serialized);
  } catch {
    throw new Error(errorMessage);
  }
  if (!isJsonValue(cloned)) throw new Error(errorMessage);
  return freeze(cloned);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isBoundedJsonValue(value: unknown): value is JsonValue {
  try {
    jsonClone(value, "JSON value exceeds its bounded shape");
    return true;
  } catch {
    return false;
  }
}

function isFinalizationFailureCode(value: unknown): value is EvidenceFinalizationFailureCode {
  return value === "seal_write_failed" ||
    value === "integrity_verification_failed" ||
    value === "manifest_write_failed";
}

function isFinalizationFailureAuditSource(value: unknown): value is FinalizationFailureAuditSource {
  return value === "verified_ledger" ||
    value === "verified_sidecar_projection" ||
    value === "orphaned_without_ledger" ||
    value === "unverified_immediate";
}

function evidenceSha256(value: unknown): string {
  return createHash("sha256").update(canonicalEvidenceJson(value), "utf8").digest("hex");
}

function opaqueHmac(key: Buffer, purpose: string, value: string): string {
  return createHmac("sha256", key).update(purpose, "utf8").update("\u0000", "utf8")
    .update(value, "utf8").digest("hex");
}

function aad(archiveId: string, index: number, purpose: string): Buffer {
  return Buffer.from(canonicalEvidenceJson({ schemaVersion: FORMAT_VERSION, archiveId, index, purpose }), "utf8");
}

function encryptBlob(
  key: Buffer,
  archiveId: string,
  index: number,
  purpose: string,
  plaintext: Uint8Array,
): EncryptedBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_256_GCM, key, iv);
  cipher.setAAD(aad(archiveId, index, purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Object.freeze({
    v: FORMAT_VERSION,
    alg: "A256GCM",
    index,
    purpose,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function decryptBlob(
  key: Buffer,
  archiveId: string,
  expectedIndex: number,
  expectedPurpose: string,
  candidate: unknown,
): Buffer {
  if (candidate === null || typeof candidate !== "object") {
    throw new Error("Encrypted artifact blob is invalid");
  }
  const blob = candidate as Partial<EncryptedBlob>;
  if (
    blob.v !== FORMAT_VERSION ||
    blob.alg !== "A256GCM" ||
    blob.index !== expectedIndex ||
    blob.purpose !== expectedPurpose ||
    typeof blob.iv !== "string" ||
    typeof blob.tag !== "string" ||
    typeof blob.ciphertext !== "string"
  ) {
    throw new Error("Encrypted artifact AAD binding is invalid");
  }
  const iv = decodeCanonicalBase64(blob.iv, "Encrypted artifact IV");
  const tag = decodeCanonicalBase64(blob.tag, "Encrypted artifact authentication tag");
  const ciphertext = decodeCanonicalBase64(blob.ciphertext, "Encrypted artifact ciphertext");
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error("Encrypted artifact AES-GCM parameters are invalid");
  }
  const decipher = createDecipheriv(AES_256_GCM, key, iv);
  decipher.setAAD(aad(archiveId, expectedIndex, expectedPurpose));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
}

function decodeCanonicalBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(field + " is not canonical base64");
  }
  return decoded;
}

function freeze<T>(value: T): T {
  // Node rejects Object.freeze() for non-empty typed arrays. Binary evidence
  // has already been cloned at the encrypted boundary; keep the surrounding
  // record immutable without attempting an unsupported view freeze.
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isNestedOrEqual(left: string, right: string): boolean {
  if (left === right) return true;
  const path = relative(left, right);
  return path.length > 0 && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
}

function validateRootKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) {
    throw new RangeError("Evidence root key must be exactly 32 bytes");
  }
  return Buffer.from(key);
}

function deriveKey(rootKey: Buffer, purpose: RootKeyPurpose): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    rootKey,
    Buffer.from("fast-translation/session-artifact-store/v3", "utf8"),
    Buffer.from(purpose, "utf8"),
    32,
  ));
}

function plainText(value: unknown): Buffer {
  return Buffer.from(canonicalEvidenceJson(value), "utf8");
}

function parseJson<T>(plaintext: Uint8Array, errorMessage: string): T {
  try {
    return JSON.parse(Buffer.from(plaintext).toString("utf8")) as T;
  } catch {
    throw new Error(errorMessage);
  }
}

interface StoredPcm16le {
  readonly codec: typeof PCM16LE_CODEC;
  readonly version: typeof PCM16LE_CODEC_VERSION;
  readonly encoding: "base64";
  readonly byteLength: number;
  readonly data: string;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return canonicalEvidenceJson(Object.keys(value).sort()) === canonicalEvidenceJson([...keys].sort());
}

function encodePcm16le(pcm16le: Uint8Array): StoredPcm16le {
  return Object.freeze({
    codec: PCM16LE_CODEC,
    version: PCM16LE_CODEC_VERSION,
    encoding: "base64" as const,
    byteLength: pcm16le.byteLength,
    data: Buffer.from(pcm16le).toString("base64"),
  });
}

function decodePcm16le(candidate: unknown): Uint8Array {
  if (!isPlainObject(candidate)) {
    throw new Error("Evidence audio PCM envelope is invalid");
  }
  const keys = Object.keys(candidate).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(["byteLength", "codec", "data", "encoding", "version"]) ||
    candidate.codec !== PCM16LE_CODEC ||
    candidate.version !== PCM16LE_CODEC_VERSION ||
    candidate.encoding !== "base64" ||
    typeof candidate.byteLength !== "number" ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 0 ||
    typeof candidate.data !== "string"
  ) {
    throw new Error("Evidence audio PCM envelope is invalid");
  }
  const decoded = Buffer.from(candidate.data, "base64");
  if (decoded.toString("base64") !== candidate.data || decoded.byteLength !== candidate.byteLength) {
    throw new Error("Evidence audio PCM envelope is not canonical");
  }
  return Uint8Array.from(decoded);
}

function encodeEvidenceRecordForArchive(record: EvidenceRecord): unknown {
  if (record.type !== "audio") return record;
  if (!(record.frame.pcm16le instanceof Uint8Array)) {
    throw new Error("Evidence audio PCM must be a Uint8Array");
  }
  return {
    ...record,
    frame: {
      ...record.frame,
      pcm16le: encodePcm16le(record.frame.pcm16le),
    },
  };
}

function assertEvidenceRecordSessionIdentity(record: EvidenceRecord, expectedSessionId: string): void {
  const stack: unknown[] = [record];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== "object" || ArrayBuffer.isView(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === "sessionId" && entry !== expectedSessionId) {
        throw new Error("Evidence record session identity does not match its artifact");
      }
      if (entry !== null && typeof entry === "object") stack.push(entry);
    }
  }
}

function serializedEvidenceRecordBytes(record: EvidenceRecord): number {
  const encoded = encodeEvidenceRecordForArchive(record);
  const stack: Array<Readonly<{ readonly value: unknown; readonly depth: number; readonly exit?: boolean }>> = [
    { value: encoded, depth: 0 },
  ];
  const visited = new WeakSet<object>();
  const active = new WeakSet<object>();
  let nodes = 0;
  let scalarBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const { value, depth } = current;
    if (current.exit) {
      if (value !== null && typeof value === "object") active.delete(value);
      continue;
    }
    if (depth > 64 || nodes > 20_000) {
      throw new Error("Evidence record structure exceeds its maximum");
    }
    if (value === null || value === undefined || typeof value === "boolean") continue;
    if (typeof value === "string") {
      scalarBytes += Buffer.byteLength(value, "utf8");
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("Evidence record contains an invalid number");
    } else if (typeof value === "object") {
      if (ArrayBuffer.isView(value)) {
        scalarBytes += value.byteLength;
      } else {
        if (active.has(value)) throw new Error("Evidence record contains a cycle");
        if (visited.has(value)) continue;
        visited.add(value);
        active.add(value);
        nodes += 1;
        stack.push({ value, depth, exit: true });
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          scalarBytes += Buffer.byteLength(key, "utf8");
          stack.push({ value: entry, depth: depth + 1 });
        }
      }
    } else {
      throw new Error("Evidence record contains an unsupported value");
    }
    if (scalarBytes > MAX_RECORD_SERIALIZED_BYTES) {
      throw new Error("Evidence record exceeds its maximum serialized size");
    }
  }
  let serialized: string;
  try {
    serialized = canonicalEvidenceJson(encoded);
  } catch (error: unknown) {
    throw new Error("Evidence record is not serializable", { cause: error });
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_RECORD_SERIALIZED_BYTES) {
    throw new Error("Evidence record exceeds its maximum serialized size");
  }
  return byteLength;
}

function decodeEvidenceRecordFromArchive(record: EvidenceRecord): EvidenceRecord {
  if (record.type !== "audio") return record;
  const pcm16le = decodePcm16le(record.frame.pcm16le);
  if (
    !Number.isSafeInteger(record.frame.format.bytesPerFrame) ||
    record.frame.format.bytesPerFrame < 0 ||
    pcm16le.byteLength !== record.frame.format.bytesPerFrame
  ) {
    throw new Error("Evidence audio PCM length does not match its declared format");
  }
  return freeze({
    ...record,
    frame: {
      ...record.frame,
      pcm16le,
    },
  });
}

function commandFingerprint(
  hmacKey: Buffer,
  operation: string,
  request: object,
): string {
  return opaqueHmac(hmacKey, "command:" + operation, canonicalEvidenceJson(request));
}

/**
 * The v3 encrypted artifact roots are intentionally separate security scopes.
 * Callers must provide each root explicitly; there is no compatibility layout.
 */
export interface SessionArtifactStoreOptions {
  readonly archiveDirectory: string;
  readonly keyDirectory: string;
  readonly exportDirectory: string;
  readonly receiptDirectory: string;
  /** Dedicated common parent hardened before any child root is trusted on Windows. */
  readonly securityBoundaryDirectory?: string;
  /** Check ancestors above the dedicated boundary for replacement rights on Windows. */
  readonly strictAncestors?: boolean;
  readonly rootKey: Uint8Array;
  /** Required when this Store can create recorder artifacts; offline sweep-only Stores may omit it. */
  readonly dataOwnerId?: string;
  readonly minimumFreeBytes?: number;
  readonly now?: () => number;
  /**
   * Diagnostic seam for confirming ACL tooling stays at root-lease admission
   * rather than per-record or per-audit hot paths.
   */
  readonly onWindowsSecurityRootAclOperation?: (operation: WindowsRootAclOperation) => void;
}

export interface EvidenceTrackDigest {
  readonly recordCount: number;
  readonly sha256: string;
}

/**
 * Recomputes the four terminal track chains from a sealed evidence ledger.
 * Every chain starts with 64 zeroes. For each audio record for a track, in
 * ledger order, it advances with canonical SHA-256 of
 * `{schemaVersion:3,track,index,previousChainSha256,recordSha256}` where
 * `recordSha256` is canonical SHA-256 of that complete evidence record.
 */
export function computeEvidenceTrackDigests(
  records: readonly EvidenceRecord[],
): Readonly<Record<EvidenceAudioTrack, EvidenceTrackDigest>> {
  const chains: Record<EvidenceAudioTrack, EvidenceTrackDigest> = {
    source_a: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
    source_b: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
    playout_to_a: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
    playout_to_b: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
  };
  for (const record of records) {
    if (record.type !== "audio") continue;
    const current = chains[record.track];
    const index = current.recordCount;
    const recordSha256 = evidenceSha256(record);
    chains[record.track] = Object.freeze({
      recordCount: index + 1,
      sha256: evidenceSha256({
        schemaVersion: FORMAT_VERSION,
        track: record.track,
        index,
        previousChainSha256: current.sha256,
        recordSha256,
      }),
    });
  }
  return freeze(chains);
}

export interface SessionArtifactSeal {
  readonly schemaVersion: 3;
  readonly recordCount: number;
  readonly finalChainSha256: string;
  readonly finalizationManifestSha256: string;
  readonly sealSha256: string;
}

export interface SessionArtifactFinalizationManifest {
  readonly schemaVersion: 3;
  readonly kind: "session_artifact_finalization";
  readonly archiveId: string;
  readonly processingManifest: SessionProcessingManifest;
  readonly processingManifestSha256: string;
  /** Hash only: reviewer identities remain in the encrypted ledger. */
  readonly reviewGrantSha256: string;
  readonly consentReceiptRefs: readonly string[];
  readonly finalizedAtMonoMs: number;
  readonly finalizedAtUtc: string;
  readonly reason: string;
  readonly retentionDeadlineAtMs: number;
  readonly retentionDeadlineAt: string;
  readonly recordCount: number;
  readonly finalChainSha256: string;
  readonly trackDigests: Readonly<Record<EvidenceAudioTrack, EvidenceTrackDigest>>;
  readonly tracks: Readonly<Record<EvidenceAudioTrack, FinalizedTrackDigest>>;
  readonly manifestSha256: string;
}

export interface SessionArtifactDescriptor {
  readonly archiveId: string;
  readonly archivePath: string;
  readonly retentionDeadlineAtMs?: number;
  readonly status: "active" | "finalizing" | "sealed" | "FINALIZATION_FAILED" | "deletion_pending";
}

/** Server routes normally resolve a session ID; internal callers may use an opaque archive ID. */
export type SessionArtifactLookup =
  | Readonly<{ readonly sessionId: string }>
  | Readonly<{ readonly archiveId: string }>;

/**
 * The verified layout of the canonical four-track timeline. The frame count
 * is the largest verified frame end relative to the earliest verified frame
 * start across every track. It deliberately represents the timeline extent
 * rather than a sum, so an exporter can create bounded sparse WAVs without
 * collecting or sorting every frame.
 */
export interface VerifiedAudioTimeline {
  readonly originTimelineAtMonoMs: number | null;
  readonly durationSampleFrames: number;
}

/**
 * The metadata-only projection available to a managed export callback. It
 * intentionally has no archive path and no materialized ledger. Call
 * `ManagedEvidenceExportLease.records()` while the callback is active to
 * replay verified evidence one record at a time.
 */
export interface VerifiedSessionArtifactSummary {
  readonly archiveId: string;
  readonly status: "sealed";
  readonly retentionDeadlineAtMs: number;
  readonly seal: SessionArtifactSeal;
  readonly finalization: SessionArtifactFinalizationManifest;
  readonly audioTimeline: VerifiedAudioTimeline;
}

interface VerifiedSealedLeaseArtifact {
  readonly summary: VerifiedSessionArtifactSummary;
  /** Kept exclusively inside the Store for review assignment checks. */
  readonly evidenceReviewGrant: EvidenceReviewGrant;
}

export interface RetentionExtensionRequest {
  readonly sessionId: string;
  readonly commandId: string;
  readonly authority: RetentionOwnerAuthority;
  readonly reason: string;
  readonly requestedAtMs: number;
  readonly requestedDeadlineAtMs: number;
}

export interface EvidenceDeleteRequest {
  readonly sessionId: string;
  readonly commandId: string;
  readonly authority: RetentionOwnerAuthority;
  readonly reason: string;
  readonly requestedAtMs: number;
}

export interface RetentionExtensionResult {
  readonly status: "extended" | "conflict" | "not_found" | "rejected";
  readonly retentionDeadlineAtMs?: number;
  readonly extensionUsed?: boolean;
}

export type EvidenceDeletionResult =
  | Readonly<{ readonly status: "completed"; readonly deletionReceiptId: string }>
  | Readonly<{ readonly status: "pending" | "conflict" | "not_found" | "rejected" }>;

export interface SessionRetentionStatus {
  readonly status: "active" | "finalizing" | "sealed" | "FINALIZATION_FAILED" | "deletion_pending" | "deleted";
  readonly retentionDeadlineAtMs?: number;
  readonly extensionUsed: boolean;
}

export interface RetentionSweepHealth {
  readonly health: "healthy" | "degraded";
  readonly lastSuccessfulSweepAtMs?: number;
}

export interface RetentionSweepResult extends RetentionSweepHealth {
  readonly status: "completed" | "degraded";
  readonly expiredArtifactsDeleted: number;
}

export interface ArtifactRecoveryResult extends RetentionSweepHealth {
  readonly status: "completed" | "degraded";
  readonly recoveredDeletions: number;
  readonly sealedArtifacts: number;
  readonly finalizationFailures: number;
  /** Active artifacts found after process restart are not silently admitted. */
  readonly orphanedActiveArtifacts: number;
}

/**
 * A store-owned export transaction. The callback runs while the artifact's
 * in-process and cross-process lifecycle locks are both held. Its workspace
 * is backend-only: callers must never serialize the path into an API or CLI
 * response.
 */
export interface ManagedEvidenceExportLease {
  readonly exportId: string;
  readonly outputDirectory: string;
  readonly artifact: VerifiedSessionArtifactSummary;
  /**
   * Replay the fully verified sealed ledger while this callback is active.
   * The iterable is replayable; it never exposes unverified archive reads or
   * a materialized record array.
   */
  records(): AsyncIterable<EvidenceRecord>;
  /** The store's injected clock, valid only while the callback runs. */
  nowMs(): number;
}

/** The callback's value is returned unchanged; its manifest hash is verified. */
export interface ManagedEvidenceExportLeaseCompletion<T> {
  readonly value: T;
  readonly manifestFileSha256: string;
  readonly completedAtMs: number;
}

export type ManagedEvidenceExportLeaseResult<T> =
  | Readonly<{
    readonly status: "completed";
    readonly exportId: string;
    readonly manifestFileSha256: string;
    readonly completedAtMs: number;
    readonly value: T;
  }>
  | Readonly<{ readonly status: "audit_failed" | "conflict" | "expired" | "not_found" }>;

export interface ManagedEvidenceExportLeaseRequest {
  readonly lookup: SessionArtifactLookup;
  readonly commandId: string;
  readonly authority: RetentionOwnerAuthority;
  readonly requestedAtMs: number;
}

export interface RetentionOwnerAuthority {
  readonly kind: "retention_owner";
  readonly actorId: string;
}

/**
 * A root lease prevents an offline administration process from racing the
 * long-lived service that owns these evidence roots. Composition acquires the
 * `server` role at startup and releases it during orderly shutdown; offline
 * Offline sweep tooling acquires `offline_admin` around recovery/sweep work.
 */
export type EvidenceRootLeaseRole = "server" | "offline_admin";

export interface EvidenceRootProcessLease {
  readonly role: EvidenceRootLeaseRole;
  release(): Promise<void>;
}

/**
 * The storage-management boundary consumed by retention, export, and startup
 * recovery. Relay code depends only on EvidencePort.
 */
export interface SessionArtifactManagementPort extends EvidencePort {
  preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult>;
  finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization>;
  artifact(lookup: SessionArtifactLookup): Promise<SessionArtifactDescriptor | undefined>;
  getRetention(sessionId: string): Promise<SessionRetentionStatus | undefined>;
  extendRetention(request: RetentionExtensionRequest): Promise<RetentionExtensionResult>;
  deleteEvidence(request: EvidenceDeleteRequest): Promise<EvidenceDeletionResult>;
  getRetentionSweepHealth(): RetentionSweepHealth;
  recover(): Promise<ArtifactRecoveryResult>;
  sweepExpired(): Promise<RetentionSweepResult>;
  acquireEvidenceRootLease(role: EvidenceRootLeaseRole): Promise<EvidenceRootProcessLease>;
  withManagedExportLease<T>(
    request: ManagedEvidenceExportLeaseRequest,
    transaction: (
      lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>>;
}

/**
 * Version-three encrypted session evidence storage. Each session receives a
 * random DEK; the root key is used only to derive a wrapping key and an opaque
 * archive-ID HMAC key.
 */
export class SessionArtifactStore implements SessionArtifactManagementPort, EvidenceReviewArtifactPort {
  readonly #archiveDirectory: string;
  readonly #keyDirectory: string;
  readonly #exportDirectory: string;
  readonly #receiptDirectory: string;
  readonly #wrappingKey: Buffer;
  readonly #archiveIdKey: Buffer;
  readonly #auditEntryKey: Buffer;
  readonly #auditHeadKey: Buffer;
  readonly #auditAuthenticationKey: Buffer;
  readonly #lockMarkerAuthenticationKey: Buffer;
  readonly #configuredDataOwnerId: string | undefined;
  readonly #minimumFreeBytes: number;
  readonly #now: () => number;
  readonly #securityBoundaryDirectory: string | undefined;
  readonly #strictAncestors: boolean;
  readonly #onWindowsSecurityRootAclOperation: ((operation: WindowsRootAclOperation) => void) | undefined;
  readonly #states = new Map<string, RuntimeState>();
  readonly #artifactLocks = new Map<string, Promise<void>>();
  readonly #artifactLockAdmissions = new Map<string, number>();
  #artifactLockAdmissionTotal = 0;
  /**
   * Populated only after a streaming authenticated audit scan under the owned
   * root lease. Hot-path appends recheck the encrypted head in O(1), while a
   * restart/recovery clears and rebuilds this cache before new admissions.
   */
  readonly #verifiedAuditHeads = new Map<string, CachedAuditHead>();
  /** Pending receipts are durable deletion work, never a healthy sweep state. */
  readonly #pendingDeletionArchiveIds = new Set<string>();
  #validatedRootScopes: readonly SecurityRootSnapshot[] | undefined;
  #rootProcessLease: HeldEvidenceRootLease | undefined;
  /** The Windows DACL check is expensive; verify once for each owned lease. */
  #windowsAclVerificationLeaseId: string | undefined;
  #lastSuccessfulSweepAtMs: number | undefined;

  constructor(options: SessionArtifactStoreOptions) {
    const roots: Readonly<Record<SecurityRootName, string>> = Object.freeze({
      archive: checkedRoot(options.archiveDirectory, "archiveDirectory"),
      key: checkedRoot(options.keyDirectory, "keyDirectory"),
      export: checkedRoot(options.exportDirectory, "exportDirectory"),
      receipt: checkedRoot(options.receiptDirectory, "receiptDirectory"),
    });
    const rootEntries = Object.entries(roots) as readonly [SecurityRootName, string][];
    for (const [leftName, left] of rootEntries) {
      for (const [rightName, right] of rootEntries) {
        if (leftName === rightName) continue;
        if (isNestedOrEqual(left, right)) {
          throw new RangeError("Artifact roots must be distinct, non-nested security roots");
        }
      }
    }
    const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
    if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) {
      throw new RangeError("minimumFreeBytes must be a non-negative safe integer");
    }
    if (
      options.onWindowsSecurityRootAclOperation !== undefined &&
      typeof options.onWindowsSecurityRootAclOperation !== "function"
    ) {
      throw new RangeError("onWindowsSecurityRootAclOperation must be a function");
    }
    const rootKey = validateRootKey(options.rootKey);
    this.#archiveDirectory = roots.archive;
    this.#keyDirectory = roots.key;
    this.#exportDirectory = roots.export;
    this.#receiptDirectory = roots.receipt;
    this.#wrappingKey = deriveKey(rootKey, "dek_wrap");
    this.#archiveIdKey = deriveKey(rootKey, "archive_id");
    this.#auditEntryKey = deriveKey(rootKey, "audit_entry_encryption");
    this.#auditHeadKey = deriveKey(rootKey, "audit_head_encryption");
    this.#auditAuthenticationKey = deriveKey(rootKey, "audit_chain_authentication");
    this.#lockMarkerAuthenticationKey = deriveKey(rootKey, "lock_marker_authentication");
    this.#configuredDataOwnerId = options.dataOwnerId === undefined
      ? undefined
      : checkedCanonicalReviewIdentity(options.dataOwnerId, "dataOwnerId");
    this.#minimumFreeBytes = minimumFreeBytes;
    this.#now = options.now ?? (() => Date.now());
    this.#securityBoundaryDirectory = options.securityBoundaryDirectory === undefined
      ? undefined
      : checkedRoot(options.securityBoundaryDirectory, "securityBoundaryDirectory");
    if (options.strictAncestors !== undefined && typeof options.strictAncestors !== "boolean") {
      throw new TypeError("strictAncestors must be a boolean");
    }
    this.#strictAncestors = options.strictAncestors ?? true;
    this.#onWindowsSecurityRootAclOperation = options.onWindowsSecurityRootAclOperation;
    rootKey.fill(0);
  }

  async persist(record: EvidenceRecord): Promise<void> {
    const sessionId = checkedSessionId(record.sessionId);
    assertEvidenceRecordSessionIdentity(record, sessionId);
    const serializedRecordBytes = serializedEvidenceRecordBytes(record);
    const archiveId = this.#archiveIdForSession(sessionId);
    await this.#withOwnedRootLeaseOperation(async () => {
      await this.#ensureRoots();
      await this.#persistLocked(record, sessionId, archiveId, serializedRecordBytes);
    });
  }

  async #persistLocked(
    record: EvidenceRecord,
    sessionId: string,
    archiveId: string,
    serializedRecordBytes: number,
  ): Promise<void> {
    if (await this.#hasDeletionTombstone(archiveId)) {
      throw new Error("Deleted session evidence cannot be persisted");
    }
    const state = this.#stateForSession(sessionId);
    if (
      state.pending >= MAX_PENDING_RECORDS ||
      state.pendingBytes > MAX_PENDING_RECORD_BYTES - serializedRecordBytes
    ) {
      throw new Error("Session evidence recorder is not accepting records");
    }
    const immutableRecord = structuredClone(record) as EvidenceRecord;
    state.pending += 1;
    state.pendingBytes += serializedRecordBytes;
    await this.#enqueuePersist(state, serializedRecordBytes, async () => {
      await state.initialize;
      if (state.terminalFenceError !== undefined) throw state.terminalFenceError;
      if (
        state.closed ||
        state.deleting ||
        state.metadata.phase !== "active" ||
        state.failure !== undefined
      ) {
        throw new Error("Evidence record was submitted after its artifact became unavailable");
      }
      if (immutableRecord.type === "session_event" && immutableRecord.event.type === "session_opened") {
        const grant = checkedEvidenceReviewGrant(immutableRecord.event.snapshot.spec.evidenceReviewGrant);
        if (this.#dataOwnerIdHmac(state.archiveId, grant.dataOwnerId) !== state.metadata.dataOwnerIdHmac) {
          throw new Error("Evidence review grant data owner does not match the frozen governance owner");
        }
      }
      if (
        (immutableRecord.type === "audio" || immutableRecord.type === "recorder_track_armed") &&
        state.metadata.preflight?.status !== "ready"
      ) {
        throw new Error("Recorder preflight must succeed before audio evidence persists");
      }
      if (
        state.recordCount >= MAX_SESSION_RECORDS ||
        state.serializedRecordBytes > MAX_SESSION_SERIALIZED_RECORD_BYTES - serializedRecordBytes
      ) {
        throw new Error("Session evidence artifact exceeds its maximum size");
      }
      if (immutableRecord.type === "audio") {
        this.#validateVerifiedAudioRecord(immutableRecord);
        if (state.audioBytes > MAX_SESSION_AUDIO_BYTES - immutableRecord.frame.pcm16le.byteLength) {
          throw new Error("Session evidence audio exceeds its maximum size");
        }
        const origin = state.audioOriginTimelineAtMonoMs === undefined
          ? immutableRecord.timelineAtMonoMs
          : Math.min(state.audioOriginTimelineAtMonoMs, immutableRecord.timelineAtMonoMs);
        const last = state.audioLastTimelineAtMonoMs === undefined
          ? immutableRecord.timelineAtMonoMs
          : Math.max(state.audioLastTimelineAtMonoMs, immutableRecord.timelineAtMonoMs);
        if (last - origin + CANONICAL_AUDIO.frameDurationMs > MAX_SESSION_AUDIO_DURATION_MS) {
          throw new Error("Session evidence audio exceeds its maximum duration");
        }
      }
      if (state.recordsSinceFreeSpaceCheck >= FREE_SPACE_RECHECK_RECORD_INTERVAL) {
        const preflight = state.metadata.preflight;
        const required = preflight?.status === "ready"
          ? preflight.requiredFreeBytes
          : String(this.#minimumFreeBytes);
        if (!/^[0-9]+$/u.test(required)) {
          throw new Error("Recorder preflight free-space reservation is invalid");
        }
        await this.#availableFreeBytes(BigInt(required));
        state.recordsSinceFreeSpaceCheck = 0;
      }
      // Free-space and other admission probes may yield while finalization is
      // being cancelled. Recheck the terminal fence before the DEK is read to
      // serialize or encrypt a record.
      if (state.terminalFenceError !== undefined) throw state.terminalFenceError;
      if (
        state.closed ||
        state.deleting ||
        state.metadata.phase !== "active" ||
        state.failure !== undefined
      ) {
        throw new Error("Evidence record was submitted after its artifact became unavailable");
      }
      // State initialization can restore an active encrypted ledger. Construct
      // every chain-dependent field only after that restoration and inside the
      // serialized write operation, never from the fresh-state defaults.
      const index = state.recordCount;
      const previousChainSha256 = state.chainSha256;
      const recordSha256 = evidenceSha256(immutableRecord);
      const envelope: RecordEnvelope = Object.freeze({
        kind: "record",
        index,
        previousChainSha256,
        recordSha256,
        chainSha256: evidenceSha256({
          schemaVersion: FORMAT_VERSION,
          index,
          previousChainSha256,
          recordSha256,
        }),
        record: immutableRecord,
      });
      await this.#appendArchiveEnvelope(state, envelope, "record");
      if (state.terminalFenceError !== undefined) throw state.terminalFenceError;
      state.recordCount = index + 1;
      state.serializedRecordBytes += serializedRecordBytes;
      state.chainSha256 = envelope.chainSha256;
      state.recordsSinceFreeSpaceCheck += 1;
      if (immutableRecord.type === "audio") {
        state.audioBytes += immutableRecord.frame.pcm16le.byteLength;
        state.audioOriginTimelineAtMonoMs = state.audioOriginTimelineAtMonoMs === undefined
          ? immutableRecord.timelineAtMonoMs
          : Math.min(state.audioOriginTimelineAtMonoMs, immutableRecord.timelineAtMonoMs);
        state.audioLastTimelineAtMonoMs = state.audioLastTimelineAtMonoMs === undefined
          ? immutableRecord.timelineAtMonoMs
          : Math.max(state.audioLastTimelineAtMonoMs, immutableRecord.timelineAtMonoMs);
      }
    });
  }

  async flush(sessionId: string): Promise<void> {
    const checkedSession = checkedSessionId(sessionId);
    await this.#withOwnedRootLeaseOperation(async () => {
      await this.#ensureRoots();
      await this.#flushLocked(checkedSession);
    });
  }

  async #flushLocked(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return;
    await state.initialize;
    await this.#stateTailWithTerminalFence(state);
    if (state.failure !== undefined) throw state.failure;
    if (state.closed || state.deleting) return;
    await this.#syncFile(this.#spoolPath(state.archiveId));
  }

  async artifact(lookup: SessionArtifactLookup): Promise<SessionArtifactDescriptor | undefined> {
    const archiveId = this.#archiveIdForLookup(lookup);
    return this.#withOwnedArtifactOperation(archiveId, () => this.#artifact(lookup));
  }

  async preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    validateRecorderPreflightRequest(request);
    const sessionId = checkedSessionId(request.sessionId);
    const archiveId = this.#archiveIdForSession(sessionId);
    return this.#withOwnedArtifactOperation(
      archiveId,
      () => this.#preflightRecorderLocked(request, sessionId),
    );
  }

  async #preflightRecorderLocked(
    request: RecorderPreflightRequest,
    sessionId: string,
  ): Promise<RecorderPreflightResult> {
    if (await this.#hasDeletionTombstone(this.#archiveIdForSession(sessionId))) {
      return this.#preflightFailure(request, "evidence_preflight_failed");
    }
    const state = this.#stateForSession(sessionId);
    try {
      await state.initialize;
      if (state.deleting || state.closed || state.metadata.phase !== "active") {
        return this.#preflightFailure(request, "evidence_preflight_failed");
      }
      const existing = state.metadata.preflight;
      if (existing !== undefined) {
        if (
          existing.status === "ready" &&
          existing.processingManifestSha256 === request.processingManifestSha256
        ) {
          return existing;
        }
        return this.#preflightFailure(request, "evidence_preflight_failed");
      }
      const processingManifest = await this.#processingManifestForState(state);
      if (processingManifest.manifestSha256 !== request.processingManifestSha256) {
        return this.#preflightFailure(request, "evidence_preflight_failed");
      }
      const requiredFreeBytes = this.#requiredFreeBytes(processingManifest);
      const availableFreeBytes = await this.#availableFreeBytes(requiredFreeBytes);
      const probe = await this.#runEncryptedTrackProbe(state, EVIDENCE_AUDIO_TRACKS);
      const preflightBody = {
        schemaVersion: FORMAT_VERSION,
        kind: "recorder_preflight" as const,
        archiveId: state.archiveId,
        processingManifestSha256: request.processingManifestSha256,
        checkedAtMonoMs: request.checkedAtMonoMs,
        requiredFreeBytes: requiredFreeBytes.toString(),
        availableFreeBytes,
        tracks: EVIDENCE_AUDIO_TRACKS,
        encryptedSpoolSha256: probe.encryptedSpoolSha256,
        sealedRecordCount: probe.sealedRecordCount,
      };
      const manifestSha256 = evidenceSha256(preflightBody);
      const result: RecorderPreflightResult = freeze({
        status: "ready" as const,
        sessionId,
        processingManifestSha256: request.processingManifestSha256,
        preflightId: randomUUID(),
        checkedAtMonoMs: request.checkedAtMonoMs,
        requiredFreeBytes: requiredFreeBytes.toString(),
        availableFreeBytes,
        tracks: EVIDENCE_AUDIO_TRACKS,
        manifestSha256,
        encryptedSpoolSha256: probe.encryptedSpoolSha256,
        sealedRecordCount: probe.sealedRecordCount,
        sealSha256: evidenceSha256({
          schemaVersion: FORMAT_VERSION,
          manifestSha256,
          encryptedSpoolSha256: probe.encryptedSpoolSha256,
          sealedRecordCount: probe.sealedRecordCount,
        }),
      });
      validateRecorderPreflightResult(result);
      state.metadata = freeze({
        ...state.metadata,
        processingManifestSha256: request.processingManifestSha256,
        processingProfileSha256: processingManifest.profile.sha256,
        processingProfileReferenceDigest: this.#processingProfileReferenceDigest(processingManifest),
        preflight: result,
      });
      await this.#persistSidecar(state);
      return result;
    } catch (error: unknown) {
      return this.#preflightFailure(
        request,
        error instanceof RecorderPreflightError ? error.failureCode : "evidence_preflight_failed",
      );
    }
  }

  async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    validateEvidenceFinalizeRequest(request);
    const sessionId = checkedSessionId(request.sessionId);
    const archiveId = this.#archiveIdForSession(sessionId);
    return this.#withOwnedArtifactOperation(archiveId, async () => {
      if (await this.#hasDeletionTombstone(archiveId)) {
        return this.#finalizationFailure(
          sessionId,
          request.processingManifestSha256,
          new Error("A deleted session artifact cannot be finalized"),
        );
      }
      const state = this.#stateForSession(sessionId);
      if (state.finalization !== undefined) return state.finalization;
      const completion = this.#finalizeOnce(state, request);
      state.finalization = completion;
      void completion.finally(() => {
        // An aborted finalizer may return before a stuck append settles, but
        // its DEK/state must remain pinned under the same root lease until the
        // underlying writer can no longer mutate the spool.
        void state.tail.finally(() => this.#evictTerminalState(state));
      }).catch(() => undefined);
      return completion;
    });
  }

  /**
   * Issues a deliberately narrow review lease only after the sealed ledger,
   * its finalization projection, the immutable review grant, and the detached
   * audit chain have all been verified under the lifecycle lock.
   */
  async withVerifiedSealedReviewLease<T>(
    request: EvidenceReviewRequest,
    transaction: (
      lease: EvidenceReviewLease,
    ) => Promise<EvidenceReviewLeaseCompletion<T>>,
  ): Promise<EvidenceReviewLeaseResult> {
    if (typeof transaction !== "function") {
      throw new RangeError("Evidence review transaction is required");
    }
    const sessionId = checkedSessionId(request.sessionId);
    const archiveId = this.#archiveIdForSession(sessionId);
    try {
      return await this.#withOwnedArtifactOperation(
        archiveId,
        () => this.#withVerifiedSealedReviewLeaseLocked(request, sessionId, archiveId, transaction),
      );
    } catch (error: unknown) {
      if (error instanceof ArtifactLifecycleQueueFullError) {
        return freeze({ status: "audit_failed" as const });
      }
      throw error;
    }
  }

  async #withVerifiedSealedReviewLeaseLocked<T>(
    request: EvidenceReviewRequest,
    sessionId: string,
    archiveId: string,
    transaction: (lease: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
  ): Promise<EvidenceReviewLeaseResult> {
    if (await this.#hasDeletionTombstone(archiveId)) return freeze({ status: "not_found" as const });
    let state: RuntimeState;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return freeze({ status: "not_found" as const });
      return freeze({ status: "integrity_failed" as const });
    }
    try {
      if (state.metadata.sessionId !== sessionId) return freeze({ status: "not_found" as const });
      let authenticatedGrant: EvidenceReviewGrant;
      try {
        authenticatedGrant = await this.#authenticatedEvidenceReviewGrantForState(state);
      } catch {
        // Until the immutable grant itself authenticates, every caller sees
        // the same authorization denial regardless of lifecycle or tail state.
        return freeze({ status: "grant_denied" as const });
      }
      if (!this.#reviewActorMatchesGrant(request, authenticatedGrant)) {
        try {
          const audit = await this.#requireValidAudit(archiveId);
          // Authorization must be decided before lifecycle or integrity gates,
          // but a denied caller must not consume the owner-reserved audit tail.
          if (!(await this.#reviewAuditAdmissionOpen(archiveId, audit))) {
            return freeze({ status: "audit_failed" as const });
          }
        } catch {
          return freeze({ status: "audit_failed" as const });
        }
        return this.#reviewUnavailableResult(archiveId, request, "grant_denied");
      }
      try {
        await this.#recoverPendingRetentionExtension(state);
      } catch {
        return freeze({ status: "audit_failed" as const });
      }
      try {
        const audit = await this.#requireValidAudit(archiveId);
        // Reviewer reads and retention summaries stop before the final twenty-four
        // entries. This leaves enough bounded journal capacity for owner
        // export, extension, and deletion lifecycle actions, and fails closed
        // before any archive replay or callback can disclose content.
        if (!(await this.#reviewAuditAdmissionOpen(archiveId, audit))) {
          return freeze({ status: "audit_failed" as const });
        }
      } catch {
        return freeze({ status: "audit_failed" as const });
      }
      if (state.metadata.phase !== "sealed") {
        return this.#reviewUnavailableResult(archiveId, request, "not_sealed");
      }
      if (this.#isRetentionExpired(state.metadata)) {
        return this.#reviewUnavailableResult(archiveId, request, "expired");
      }
      let verified: VerifiedSealedLeaseArtifact;
      try {
        verified = await this.#verifyArchiveForSealedLease(state, this.#archivePath(archiveId));
      } catch {
        return this.#reviewUnavailableResult(archiveId, request, "integrity_failed");
      }
      if (canonicalEvidenceJson(verified.evidenceReviewGrant) !== canonicalEvidenceJson(authenticatedGrant)) {
        return this.#reviewUnavailableResult(archiveId, request, "integrity_failed");
      }
      const artifact = verified.summary;
      const durationMs = Math.round(
        (artifact.audioTimeline.durationSampleFrames * 1_000) / CANONICAL_AUDIO.sampleRateHz,
      );
      if (!isNonNegativeSafeInteger(durationMs)) {
        return this.#reviewUnavailableResult(archiveId, request, "integrity_failed");
      }
      let callbackActive = true;
      const lease: EvidenceReviewLease = freeze({
        summary: freeze({
          status: "sealed" as const,
          finalizationSha256: artifact.finalization.manifestSha256,
          recordCount: artifact.finalization.recordCount,
          retentionDeadlineAtMs: artifact.retentionDeadlineAtMs,
        }),
        originTimelineAtMonoMs: artifact.audioTimeline.originTimelineAtMonoMs,
        durationMs,
        records: (): AsyncIterable<EvidenceRecord> => this.#replayManagedExportRecords(
          state,
          this.#archivePath(archiveId),
          artifact,
          () => callbackActive,
        ),
      });
      let completion: EvidenceReviewLeaseCompletion<T>;
      try {
        completion = await transaction(lease);
      } finally {
        callbackActive = false;
      }
      if (this.#isRetentionExpired(state.metadata)) {
        return this.#reviewUnavailableResult(archiveId, request, "expired");
      }
      if (
        completion === null ||
        typeof completion !== "object" ||
        !isSha256((completion as Partial<EvidenceReviewLeaseCompletion<T>>).responseSha256)
      ) {
        throw new Error("Evidence review completion is invalid");
      }
      try {
        const audit = await this.#appendReviewAudit(
          archiveId,
          request,
          "completed",
          completion.responseSha256,
        );
        // The callback value is deliberately not part of this adapter result.
        // EvidenceReview retains it internally and releases it only after
        // checking this durable audit receipt's response hash.
        return freeze({
          status: "completed" as const,
          auditId: audit.auditId,
          responseSha256: completion.responseSha256,
        });
      } catch {
        return freeze({ status: "audit_failed" as const });
      }
    } finally {
      this.#evictTerminalState(state);
    }
  }

  async getRetention(sessionId: string): Promise<SessionRetentionStatus | undefined> {
    const archiveId = this.#archiveIdForSession(checkedSessionId(sessionId));
    return this.#withOwnedArtifactOperation(
      archiveId,
      () => this.#getRetentionLocked(sessionId, archiveId),
    );
  }

  async #getRetentionLocked(
    sessionId: string,
    archiveId: string,
  ): Promise<SessionRetentionStatus | undefined> {
    const receipt = await this.#readDeletionReceipt(archiveId);
    if (receipt?.status === "completed") {
      this.#pendingDeletionArchiveIds.delete(archiveId);
      return freeze({ status: "deleted", extensionUsed: false });
    }
    if (receipt?.status === "pending") {
      this.#pendingDeletionArchiveIds.add(archiveId);
      return freeze({
        status: "deletion_pending",
        retentionDeadlineAtMs: receipt.retentionDeadlineAtMs,
        extensionUsed: receipt.extensionUsed,
      });
    }
    let state: RuntimeState | undefined;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    try {
      if (state.metadata.sessionId !== sessionId) return undefined;
      await this.#recoverPendingRetentionExtension(state);
      return this.#retentionStatus(state.metadata);
    } finally {
      this.#evictTerminalState(state);
    }
  }

  async extendRetention(request: RetentionExtensionRequest): Promise<RetentionExtensionResult> {
    const normalizedRequest: RetentionExtensionRequest = freeze({
      ...request,
      sessionId: checkedSessionId(request.sessionId),
      commandId: checkedCommandText(request.commandId, "commandId"),
      authority: checkedRetentionOwnerAuthority(request.authority),
      reason: checkedCommandText(request.reason, "reason"),
      requestedAtMs: checkedEpochMs(request.requestedAtMs, "requestedAtMs"),
      requestedDeadlineAtMs: checkedEpochMs(request.requestedDeadlineAtMs, "requestedDeadlineAtMs"),
    });
    const sessionId = normalizedRequest.sessionId;
    const archiveId = this.#archiveIdForSession(sessionId);
    try {
      return await this.#withOwnedArtifactOperation(
        archiveId,
        () => this.#extendRetentionLocked(normalizedRequest, sessionId, archiveId),
      );
    } catch (error: unknown) {
      if (error instanceof ArtifactLifecycleQueueFullError) return freeze({ status: "conflict" as const });
      throw error;
    }
  }

  async #extendRetentionLocked(
    request: RetentionExtensionRequest,
    sessionId: string,
    archiveId: string,
  ): Promise<RetentionExtensionResult> {
    const deletionReceipt = await this.#readDeletionReceipt(archiveId);
    if (deletionReceipt !== undefined) {
      if (deletionReceipt.status === "pending") this.#pendingDeletionArchiveIds.add(archiveId);
      return freeze({ status: "not_found" });
    }
    let state: RuntimeState;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return freeze({ status: "not_found" });
      throw error;
    }
    try {
      if (state.metadata.sessionId !== sessionId) return freeze({ status: "not_found" });
      let grant: EvidenceReviewGrant;
      try {
        grant = await this.#authenticatedEvidenceReviewGrantForState(state);
      } catch {
        return freeze({ status: "not_found" as const });
      }
      if (request.authority.actorId !== grant.dataOwnerId) {
        return freeze({ status: "not_found" as const });
      }
      try {
        await this.#recoverPendingRetentionExtension(state);
      } catch {
        return freeze({ status: "rejected" as const });
      }
      try {
        await this.#requireValidAudit(archiveId);
      } catch {
        return freeze({ status: "rejected" as const });
      }
      const fingerprint = commandFingerprint(this.#archiveIdKey, "extend", {
        sessionId,
        ownerId: request.authority.actorId,
        reason: request.reason,
        requestedDeadlineAtMs: request.requestedDeadlineAtMs,
      });
      const commandIdHmac = opaqueHmac(this.#archiveIdKey, "command-id", request.commandId);
      const ownerIdHmac = opaqueHmac(
        this.#archiveIdKey,
        "retention-extension-owner",
        request.authority.actorId,
      );
      const reasonHmac = opaqueHmac(this.#archiveIdKey, "retention-extension-reason", request.reason);
      const pendingExtension = state.metadata.pendingRetentionExtension;
      if (pendingExtension !== undefined) {
        if (
          pendingExtension.commandIdHmac !== commandIdHmac ||
          pendingExtension.requestHmac !== fingerprint ||
          pendingExtension.ownerIdHmac !== ownerIdHmac ||
          pendingExtension.reasonHmac !== reasonHmac
        ) {
          return this.#auditedRetentionExtensionResult(
            archiveId,
            request,
            freeze({ status: "conflict" as const }),
          );
        }
        try {
          const audit = await this.#appendPendingRetentionExtensionAudit(archiveId, pendingExtension);
          return await this.#commitPendingRetentionExtension(state, pendingExtension, audit);
        } catch {
          return freeze({ status: "rejected" as const });
        }
      }
      const existing = this.#commandResult<RetentionExtensionResult>(state.metadata, "extend", request.commandId, fingerprint);
      if (existing !== undefined) {
        if (existing.status === "conflict") {
          return this.#auditedRetentionExtensionResult(archiveId, request, existing);
        }
        return existing;
      }
      const retention = state.metadata.retention;
      const decidedAtMs = checkedEpochMs(this.#now(), "retention decision clock");
      if (
        state.metadata.phase !== "sealed" ||
        retention === undefined ||
        retention.extensionUsed ||
        decidedAtMs >= retention.retentionDeadlineAtMs ||
        request.requestedDeadlineAtMs <= retention.retentionDeadlineAtMs ||
        request.requestedDeadlineAtMs > retention.finalizedAtMs + MAX_RETENTION_MS
      ) {
        const result = freeze({ status: "rejected" as const });
        return this.#auditedRetentionExtensionResult(archiveId, request, result);
      }
      const result = freeze({
        status: "extended" as const,
        retentionDeadlineAtMs: request.requestedDeadlineAtMs,
        extensionUsed: true as const,
      });
      const pending: PendingRetentionExtension = freeze({
        commandIdHmac,
        requestHmac: fingerprint,
        ownerIdHmac,
        reasonHmac,
        auditActorIdHmac: this.#retentionExtensionAuditActorHmac(request),
        auditRequestHmac: this.#pendingRetentionExtensionAuditRequestHmac(
          commandIdHmac,
          fingerprint,
          ownerIdHmac,
          reasonHmac,
          request.requestedDeadlineAtMs,
        ),
        requestedDeadlineAtMs: request.requestedDeadlineAtMs,
        decidedAtMs,
        result,
      });
      const originalMetadata = state.metadata;
      state.metadata = freeze({ ...originalMetadata, pendingRetentionExtension: pending });
      try {
        await this.#persistSidecar(state);
      } catch {
        state.metadata = originalMetadata;
        return freeze({ status: "rejected" as const });
      }
      try {
        const audit = await this.#appendPendingRetentionExtensionAudit(archiveId, pending);
        return await this.#commitPendingRetentionExtension(state, pending, audit);
      } catch {
        return freeze({ status: "rejected" as const });
      }
    } finally {
      this.#evictTerminalState(state);
    }
  }

  async deleteEvidence(request: EvidenceDeleteRequest): Promise<EvidenceDeletionResult> {
    const normalizedRequest: EvidenceDeleteRequest = freeze({
      ...request,
      sessionId: checkedSessionId(request.sessionId),
      commandId: checkedCommandText(request.commandId, "commandId"),
      authority: checkedRetentionOwnerAuthority(request.authority),
      reason: checkedCommandText(request.reason, "reason"),
      requestedAtMs: checkedEpochMs(request.requestedAtMs, "requestedAtMs"),
    });
    const sessionId = normalizedRequest.sessionId;
    const archiveId = this.#archiveIdForSession(sessionId);
    try {
      return await this.#withOwnedArtifactOperation(
        archiveId,
        () => this.#deleteEvidenceLocked(normalizedRequest, sessionId, archiveId),
      );
    } catch (error: unknown) {
      if (error instanceof ArtifactLifecycleQueueFullError) return freeze({ status: "conflict" as const });
      throw error;
    }
  }

  async #deleteEvidenceLocked(
    request: EvidenceDeleteRequest,
    sessionId: string,
    archiveId: string,
  ): Promise<EvidenceDeletionResult> {
    const fingerprint = commandFingerprint(this.#archiveIdKey, "delete", {
      sessionId,
      ownerId: request.authority.actorId,
      reason: request.reason,
    });
    const receipt = await this.#readDeletionReceipt(archiveId);
    if (receipt !== undefined) {
      if (
        receipt.deletionActorHmac !== opaqueHmac(
          this.#archiveIdKey,
          "deletion-actor",
          request.authority.actorId,
        )
      ) {
        return freeze({ status: "not_found" });
      }
      const commandIdHmac = opaqueHmac(this.#archiveIdKey, "command-id", request.commandId);
      if (receipt.commandIdHmac !== commandIdHmac || receipt.requestHmac !== fingerprint) {
        await this.#appendOwnerDeletionAudit(archiveId, request, "conflict").catch(() => undefined);
        return freeze({ status: "conflict" });
      }
      return receipt.status === "completed"
        ? freeze({ status: "completed", deletionReceiptId: receipt.deletionReceiptId })
        : this.#completePendingDeletionLocked(receipt);
    }
    let state: RuntimeState;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return freeze({ status: "not_found" });
      throw error;
    }
    try {
      if (state.metadata.sessionId !== sessionId) return freeze({ status: "not_found" });
      let ownerAuthorized = false;
      try {
        const grant = await this.#authenticatedEvidenceReviewGrantForState(state);
        ownerAuthorized = request.authority.actorId === grant.dataOwnerId;
      } catch {
        // A sidecar-only/corrupt-ledger orphan cannot reconstruct the frozen
        // grant. Only its authenticated governance-owner binding may authorize
        // deletion, and only after recovery made it a governed failed terminal.
        ownerAuthorized = state.metadata.phase === "FINALIZATION_FAILED" &&
          (
            state.metadata.finalizationFailureAudit === "verified_sidecar_projection" ||
            state.metadata.finalizationFailureAudit === "orphaned_without_ledger"
          ) &&
          this.#dataOwnerIdHmac(state.archiveId, request.authority.actorId) === state.metadata.dataOwnerIdHmac;
      }
      if (!ownerAuthorized) {
        return freeze({ status: "not_found" as const });
      }
      // A completed extension audit is the authoritative retention decision.
      // Reconcile its pending sidecar intent before any owner deletion can
      // evaluate the old deadline or erase the artifact.
      await this.#recoverPendingRetentionExtension(state);
      if (state.metadata.managedExport?.status === "pending") return freeze({ status: "pending" });
      const existing = this.#commandResult<EvidenceDeletionResult>(state.metadata, "delete", request.commandId, fingerprint);
      if (existing !== undefined) return existing;
      if (state.metadata.phase !== "sealed" && state.metadata.phase !== "FINALIZATION_FAILED") {
        const result = freeze({ status: "rejected" as const });
        await this.#appendOwnerDeletionAudit(archiveId, request, "rejected").catch(() => undefined);
        return result;
      }
      // Bind the command and semantic request in the signed durable receipt
      // before appending its audit decision. If the process fails after the
      // append, a restart cannot accept a changed owner/reason under the same
      // command ID or append the decision again.
      const pending = await this.#createPendingDeletionReceipt(state, {
        commandId: request.commandId,
        requestHmac: fingerprint,
        actorId: request.authority.actorId,
        reason: request.reason,
        disposition: "early",
        startedAtMs: this.#now(),
      });
      await this.#writeDeletionReceipt(pending);
      this.#pendingDeletionArchiveIds.add(archiveId);
      state.deleting = true;
      state.closed = true;
      // Deletion is the one lifecycle operation that continues through a
      // corrupt audit. A failed append is reflected by the signed invalid
      // audit snapshot in the completed receipt rather than blocking
      // cryptographic erasure of the evidence.
      await this.#appendOwnerDeletionAudit(archiveId, request, "pending").catch(() => undefined);
      await this.#stateTailWithTerminalFence(state).catch(() => undefined);
      return this.#completePendingDeletionLocked(pending);
    } finally {
      this.#evictTerminalState(state);
    }
  }

  getRetentionSweepHealth(): RetentionSweepHealth {
    const lastSuccessfulSweepAtMs = this.#lastSuccessfulSweepAtMs;
    const health =
      this.#pendingDeletionArchiveIds.size === 0 &&
      lastSuccessfulSweepAtMs !== undefined &&
      this.#now() - lastSuccessfulSweepAtMs <= SWEEP_MAX_AGE_MS
        ? "healthy"
        : "degraded";
    return freeze({
      health,
      ...(lastSuccessfulSweepAtMs === undefined ? {} : { lastSuccessfulSweepAtMs }),
    });
  }

  async recover(): Promise<ArtifactRecoveryResult> {
    return this.#withOwnedRootLeaseOperation(async () => {
      try {
      await this.#ensureRoots();
      await this.#removeLockMarkerTemporaries();
      await this.#loadSweepHealth();
      this.#verifiedAuditHeads.clear();
      let recoveredDeletions = 0;
      let sealedArtifacts = 0;
      let finalizationFailures = 0;
      let orphanedActiveArtifacts = 0;
      for (const archiveId of await this.#registeredAuditArchiveIds()) {
        try {
          await this.#withArtifactLock(archiveId, async () => {
            const audit = await this.#auditIntegritySnapshot(archiveId, true);
            if (audit.integrity !== "valid") throw new Error("Evidence audit integrity is invalid");
          });
        } catch {
          // Preserve the immutable audit files for deletion/recovery evidence,
          // but never admit review/export/extension from a corrupt chain.
          finalizationFailures += 1;
        }
      }
      for (const archiveId of await this.#registeredReceiptArchiveIds()) {
        try {
          await this.#withArtifactLock(archiveId, async () => {
            const receipt = await this.#readDeletionReceipt(archiveId);
            if (receipt === undefined) return;
            if (receipt.status === "pending") {
              this.#pendingDeletionArchiveIds.add(archiveId);
              await this.#completePendingDeletionLocked(receipt);
              recoveredDeletions += 1;
              return;
            }
            await this.#removeManagedArtifacts(archiveId, true, receipt.managedExportRegistered);
            this.#zeroizeAndForgetState(archiveId);
          });
        } catch {
          // A pending receipt is a durable, unfinished deletion. Keep startup
          // degraded until a later recovery, owner retry, or sweep completes it.
          this.#pendingDeletionArchiveIds.add(archiveId);
          finalizationFailures += 1;
        }
      }
      const keyArchiveIds = await this.#registeredKeyArchiveIds();
      const keyArchiveIdSet = new Set(keyArchiveIds);
      for (const archiveId of keyArchiveIds) {
        try {
          await this.#withArtifactLock(archiveId, async () => {
            if (await this.#hasDeletionTombstone(archiveId)) {
              await this.#removeManagedArtifacts(archiveId, true, false);
              return;
            }
            // A durable probe file is never session evidence. Its only valid
            // lifetime is the synchronous preflight probe that created it, so
            // an exclusive recovery owner can always remove crash residue.
            await this.#safeRemoveFile(this.#probePath(archiveId));
            await this.#removeDerivedTemporaryArtifacts(archiveId);
            // Recovery needs the authenticated sidecar even if an active
            // spool is torn. Under an exclusive root lease that state is an
            // orphan candidate and must be quarantined rather than stranded
            // behind append-cursor reconstruction.
            const state = await this.#loadStateByArchiveId(archiveId, false);
            try {
              await this.#recoverPendingRetentionExtension(state);
              if (state.metadata.managedExport?.status === "audit_pending") {
                await this.#recoverPendingManagedExport(state);
              } else if (state.metadata.managedExport?.status === "pending") {
                await this.#clearPendingManagedExportLocked(state);
              }
              if (state.metadata.phase === "finalizing") {
                const recovered = await this.#recoverFinalization(state);
                if (recovered.status === "sealed") sealedArtifacts += 1;
                else finalizationFailures += 1;
              } else if (state.metadata.phase === "sealed") {
                sealedArtifacts += 1;
              } else if (state.metadata.phase === "active") {
                // A root-process lease proves no live recorder may still own
                // this artifact. Without that exclusive admission boundary we
                // keep the artifact active and report degraded rather than
                // risk erasing an in-flight call.
                if (this.#rootProcessLease === undefined) {
                  orphanedActiveArtifacts += 1;
                } else {
                  const remediation = await this.#markFinalizationFailed(
                    state,
                    state.metadata.processingManifestSha256 ?? EMPTY_CHAIN_SHA256,
                    new Error("Recovered active artifact has no live recorder owner"),
                    true,
                  );
                  if (remediation.status !== "FINALIZATION_FAILED" || state.metadata.retention === undefined) {
                    orphanedActiveArtifacts += 1;
                  }
                }
              } else if (state.metadata.phase === "FINALIZATION_FAILED") {
                if (!(await this.#isRecoverableFinalizationFailure(state))) {
                  finalizationFailures += 1;
                }
              } else {
                finalizationFailures += 1;
              }
            } finally {
              // Recovery must never retain all DEKs merely for bookkeeping.
              this.#evictState(state);
            }
          });
        } catch {
          finalizationFailures += 1;
        }
      }
      for (const archiveId of await this.#registeredTemporaryArchiveIds()) {
        if (keyArchiveIdSet.has(archiveId)) continue;
        try {
          await this.#withArtifactLock(archiveId, async () => {
            if (await this.#hasDeletionTombstone(archiveId)) {
              await this.#removeManagedArtifacts(archiveId, true, false);
              return;
            }
            // A temp-only archive has no durable sidecar and cannot represent
            // an admitted call after restart. Erase it rather than guessing.
            await this.#removeManagedArtifacts(archiveId, true, false);
            orphanedActiveArtifacts += 1;
          });
        } catch {
          finalizationFailures += 1;
        }
      }
      const status =
        finalizationFailures === 0 &&
        orphanedActiveArtifacts === 0 &&
        this.#pendingDeletionArchiveIds.size === 0
        ? "completed" as const
        : "degraded" as const;
      return freeze({
        status,
        recoveredDeletions,
        sealedArtifacts,
        finalizationFailures,
        orphanedActiveArtifacts,
        ...this.getRetentionSweepHealth(),
      });
      } catch {
        return freeze({
          status: "degraded" as const,
          recoveredDeletions: 0,
          sealedArtifacts: 0,
          finalizationFailures: 0,
          orphanedActiveArtifacts: 0,
          ...this.getRetentionSweepHealth(),
        });
      }
    });
  }

  async sweepExpired(): Promise<RetentionSweepResult> {
    return this.#withOwnedRootLeaseOperation(async () => {
      try {
      await this.#ensureRoots();
      let expiredArtifactsDeleted = 0;
      const receiptArchiveIds = await this.#registeredReceiptArchiveIds();
      const receiptArchiveIdSet = new Set(receiptArchiveIds);
      for (const archiveId of receiptArchiveIds) {
        if (await this.#sweepOneExpiredArtifact(archiveId)) expiredArtifactsDeleted += 1;
      }
      for (const archiveId of await this.#registeredKeyArchiveIds()) {
        if (receiptArchiveIdSet.has(archiveId)) continue;
        if (await this.#sweepOneExpiredArtifact(archiveId)) expiredArtifactsDeleted += 1;
      }
      if (this.#pendingDeletionArchiveIds.size !== 0) {
        return freeze({
          status: "degraded" as const,
          expiredArtifactsDeleted,
          ...this.getRetentionSweepHealth(),
        });
      }
      this.#lastSuccessfulSweepAtMs = this.#now();
      await this.#writeSweepHealth(this.#lastSuccessfulSweepAtMs);
      return freeze({
        status: "completed" as const,
        expiredArtifactsDeleted,
        ...this.getRetentionSweepHealth(),
      });
      } catch {
        return freeze({
          status: "degraded" as const,
          expiredArtifactsDeleted: 0,
          ...this.getRetentionSweepHealth(),
        });
      }
    });
  }

  async #sweepOneExpiredArtifact(archiveId: string): Promise<boolean> {
    return this.#withArtifactLock(archiveId, async () => {
      const deletionReceipt = await this.#readDeletionReceipt(archiveId);
      if (deletionReceipt !== undefined) {
        if (deletionReceipt.status === "completed") {
          this.#pendingDeletionArchiveIds.delete(archiveId);
          return false;
        }
        this.#pendingDeletionArchiveIds.add(archiveId);
        await this.#completePendingDeletionLocked(deletionReceipt);
        return deletionReceipt.disposition === "scheduled";
      }
      let state: RuntimeState;
      try {
        state = await this.#loadStateByArchiveId(archiveId);
      } catch (error: unknown) {
        // The key sidecar may have been listed just before an earlier queued
        // owner deletion completed. It is already safely gone, not a sweep
        // failure and not a reason to degrade retention health.
        if (isErrno(error, "ENOENT")) return false;
        throw error;
      }
      try {
        // Never sweep against the stale pre-extension deadline after the
        // completion audit crossed its durability boundary but the sidecar
        // commit did not. A failed reconciliation leaves the artifact in
        // place and degrades the sweep instead of deleting early.
        await this.#recoverPendingRetentionExtension(state);
        const retention = state.metadata.retention;
        if (
          (state.metadata.phase !== "sealed" && state.metadata.phase !== "FINALIZATION_FAILED") ||
          retention === undefined ||
          state.metadata.managedExport?.status === "pending" ||
          this.#now() < retention.retentionDeadlineAtMs
        ) {
          return false;
        }
        const commandId = "expiry:" + archiveId + ":" + retention.retentionDeadlineAtMs;
        const requestHmac = opaqueHmac(this.#archiveIdKey, "expiry", commandId);
        const pending = await this.#createPendingDeletionReceipt(state, {
          commandId,
          requestHmac,
          actorId: "retention-sweep",
          reason: "retention-deadline",
          disposition: "scheduled",
          startedAtMs: this.#now(),
        });
        state.deleting = true;
        state.closed = true;
        await this.#writeDeletionReceipt(pending);
        this.#pendingDeletionArchiveIds.add(archiveId);
        await this.#stateTailWithTerminalFence(state).catch(() => undefined);
        await this.#completePendingDeletionLocked(pending);
        return true;
      } finally {
        this.#evictTerminalState(state);
      }
    });
  }

  async withManagedExportLease<T>(
    request: ManagedEvidenceExportLeaseRequest,
    transaction: (
      lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>> {
    if (typeof transaction !== "function") {
      throw new RangeError("Managed export transaction is required");
    }
    const normalizedRequest: ManagedEvidenceExportLeaseRequest = freeze({
      lookup: request.lookup,
      commandId: checkedCommandText(request.commandId, "commandId"),
      authority: checkedRetentionOwnerAuthority(request.authority),
      requestedAtMs: checkedEpochMs(request.requestedAtMs, "requestedAtMs"),
    });
    const archiveId = this.#archiveIdForLookup(normalizedRequest.lookup);
    try {
      return await this.#withOwnedArtifactOperation(
        archiveId,
        () => this.#withManagedExportLeaseLocked(normalizedRequest, archiveId, transaction),
      );
    } catch (error: unknown) {
      if (error instanceof ArtifactLifecycleQueueFullError) return freeze({ status: "audit_failed" as const });
      throw error;
    }
  }

  async #withManagedExportLeaseLocked<T>(
    request: ManagedEvidenceExportLeaseRequest,
    archiveId: string,
    transaction: (
      lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>> {
    if (await this.#hasDeletionTombstone(archiveId)) return freeze({ status: "not_found" });
    let state: RuntimeState;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
    } catch {
      return freeze({ status: "not_found" as const });
    }
    try {
      let grant: EvidenceReviewGrant;
      try {
        grant = await this.#authenticatedEvidenceReviewGrantForState(state);
      } catch {
        return freeze({ status: "not_found" as const });
      }
      if (request.authority.actorId !== grant.dataOwnerId) {
        return freeze({ status: "not_found" as const });
      }
      try {
        await this.#recoverPendingRetentionExtension(state);
      } catch {
        return freeze({ status: "audit_failed" as const });
      }
      const fingerprint = commandFingerprint(this.#archiveIdKey, "export_lease", {
        archiveId,
        commandId: request.commandId,
        ownerId: request.authority.actorId,
      });
      const commandIdHmac = opaqueHmac(this.#archiveIdKey, "command-id", request.commandId);
      const ownerIdHmac = opaqueHmac(this.#archiveIdKey, "managed-export-owner-id", request.authority.actorId);
      const auditActorIdHmac = this.#auditActorIdHmac("retention_owner", request.authority.actorId);
      const auditRequestHmac = this.#managedExportAuditRequestHmac(
        commandIdHmac,
        fingerprint,
        ownerIdHmac,
      );
      const existing = state.metadata.managedExport;
      if (existing !== undefined) {
        if (
          existing.commandIdHmac !== commandIdHmac ||
          existing.requestHmac !== fingerprint ||
          existing.ownerIdHmac !== ownerIdHmac ||
          existing.auditActorIdHmac !== auditActorIdHmac ||
          existing.auditRequestHmac !== auditRequestHmac
        ) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "conflict");
        }
        if (
          (existing.status !== "audit_pending" && existing.status !== "completed") ||
          !isSha256(existing.manifestFileSha256) ||
          !isNonNegativeSafeInteger(existing.completedAtMs) ||
          existing.completionValue === undefined
        ) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "conflict");
        }
        if (this.#isRetentionExpired(state.metadata)) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
        }
        try {
          await this.#requireValidAudit(archiveId);
          await this.#verifyCompletedManagedExportWorkspace(
            archiveId,
            existing.manifestFileSha256,
            existing.exportId,
          );
        } catch {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "conflict");
        }
        if (this.#isRetentionExpired(state.metadata)) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
        }
        if (existing.status === "audit_pending") {
          try {
            await this.#appendOwnerExportAudit(
              archiveId,
              request,
              "completed",
              existing.manifestFileSha256,
            );
            await this.#ensurePendingCommitAuditAnchor(state);
          } catch {
            return freeze({ status: "audit_failed" as const });
          }
          const auditPendingMetadata = state.metadata;
          state.metadata = freeze({
            ...auditPendingMetadata,
            managedExport: freeze({ ...existing, status: "completed" as const }),
          });
          try {
            await this.#persistSidecar(state);
          } catch {
            state.metadata = auditPendingMetadata;
            return freeze({ status: "audit_failed" as const });
          }
        }
        if (this.#isRetentionExpired(state.metadata)) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
        }
        return freeze({
          status: "completed" as const,
          exportId: existing.exportId,
          manifestFileSha256: existing.manifestFileSha256,
          completedAtMs: existing.completedAtMs,
          value: structuredClone(existing.completionValue) as T,
        });
      }
      let exportAuditHead: ContentFreeAuditHead;
      try {
        exportAuditHead = await this.#requireValidAudit(archiveId);
      } catch {
        return freeze({ status: "audit_failed" as const });
      }
      if (!(await this.#auditAppendAdmissionOpen(archiveId, exportAuditHead))) {
        return freeze({ status: "audit_failed" as const });
      }
      if (state.metadata.phase !== "sealed") {
        return this.#auditedOwnerExportUnavailableResult(archiveId, request, "conflict");
      }
      if (this.#isRetentionExpired(state.metadata)) {
        return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
      }
      const verifiedLeaseArtifact = await this.#verifyArchiveForSealedLease(
        state,
        this.#archivePath(state.archiveId),
      );
      const artifact = verifiedLeaseArtifact.summary;
      const exportId = opaqueHmac(
        this.#archiveIdKey,
        "managed-export",
        archiveId + "\u0000" + request.commandId,
      );
      const outputDirectory = this.#exportPath(archiveId);
      state.metadata = freeze({
        ...state.metadata,
        managedExport: freeze({
          exportId,
          commandIdHmac,
          requestHmac: fingerprint,
          ownerIdHmac,
          auditActorIdHmac,
          auditRequestHmac,
          status: "pending" as const,
        }),
      });
      await this.#persistSidecar(state);
      let callbackActive = true;
      try {
        await this.#createManagedExportDirectory(outputDirectory);
        const lease: ManagedEvidenceExportLease = freeze({
          exportId,
          outputDirectory,
          artifact,
          records: (): AsyncIterable<EvidenceRecord> => this.#replayManagedExportRecords(
            state,
            this.#archivePath(state.archiveId),
            artifact,
            () => callbackActive,
          ),
          nowMs: (): number => {
            if (!callbackActive) throw new Error("Managed export lease is no longer active");
            return checkedEpochMs(this.#now(), "managed export clock");
          },
        });
        const completion = await transaction(lease);
        callbackActive = false;
        const completedAtMs = checkedEpochMs(completion.completedAtMs, "completedAtMs");
        const decidedAtMs = checkedEpochMs(this.#now(), "managed export completion clock");
        if (completedAtMs < request.requestedAtMs || completedAtMs > decidedAtMs) {
          throw new Error("Managed export completion clock is invalid");
        }
        if (!isSha256(completion.manifestFileSha256)) {
          throw new Error("Managed export manifest hash is invalid");
        }
        const manifestPath = join(outputDirectory, "export-manifest.json");
        const boundedManifest = await this.#readBoundedManagedFile(
          manifestPath,
          MAX_MANAGED_EXPORT_MANIFEST_BYTES,
          "Managed export manifest",
        );
        if (boundedManifest === undefined) throw new Error("Managed export manifest is missing");
        const manifestFileSha256 = createHash("sha256")
          .update(boundedManifest.contents)
          .digest("hex");
        if (manifestFileSha256 !== completion.manifestFileSha256) {
          throw new Error("Managed export manifest hash does not match its workspace file");
        }
        await this.#verifyCompletedManagedExportWorkspace(archiveId, manifestFileSha256, exportId);
        if (this.#isRetentionExpired(state.metadata)) {
          await this.#clearPendingManagedExportLocked(state);
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
        }
        const completionValue = jsonClone(
          completion.value,
          "Managed export completion value must be JSON-serializable",
        );
        state.metadata = freeze({
          ...state.metadata,
          managedExport: freeze({
            exportId,
            commandIdHmac,
            requestHmac: fingerprint,
            ownerIdHmac,
            auditActorIdHmac,
            auditRequestHmac,
            status: "audit_pending" as const,
            manifestFileSha256,
            completedAtMs,
            completionValue,
          }),
        });
        await this.#persistSidecar(state);
        try {
          await this.#appendOwnerExportAudit(archiveId, request, "completed", manifestFileSha256);
          await this.#ensurePendingCommitAuditAnchor(state);
        } catch {
          return freeze({ status: "audit_failed" as const });
        }
        const auditPendingMetadata = state.metadata;
        state.metadata = freeze({
          ...auditPendingMetadata,
          managedExport: freeze({
            exportId,
            commandIdHmac,
            requestHmac: fingerprint,
            ownerIdHmac,
            auditActorIdHmac,
            auditRequestHmac,
            status: "completed" as const,
            manifestFileSha256,
            completedAtMs,
            completionValue,
          }),
        });
        try {
          await this.#persistSidecar(state);
        } catch {
          state.metadata = auditPendingMetadata;
          return freeze({ status: "audit_failed" as const });
        }
        if (this.#isRetentionExpired(state.metadata)) {
          return this.#auditedOwnerExportUnavailableResult(archiveId, request, "expired");
        }
        return freeze({
          status: "completed" as const,
          exportId,
          manifestFileSha256,
          completedAtMs,
          value: structuredClone(completionValue) as T,
        });
      } catch (error: unknown) {
        callbackActive = false;
        if (state.metadata.managedExport?.status === "audit_pending") {
          return freeze({ status: "audit_failed" as const });
        }
        await this.#clearPendingManagedExportLocked(state).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#evictTerminalState(state);
    }
  }

  async #clearPendingManagedExportLocked(state: RuntimeState): Promise<void> {
    if (state.metadata.managedExport?.status !== "pending") return;
    await this.#safeRemoveExportDirectory(state.archiveId);
    const { managedExport: _managedExport, ...withoutManagedExport } = state.metadata;
    state.metadata = freeze(withoutManagedExport);
    await this.#persistSidecar(state);
  }

  async #verifyCompletedManagedExportWorkspace(
    archiveId: string,
    expectedManifestSha256: string,
    expectedExportId: string,
  ): Promise<void> {
    const outputDirectory = this.#exportPath(archiveId);
    const expectedNames = [
      "events.jsonl",
      "source_a.wav",
      "source_b.wav",
      "playout_to_a.wav",
      "playout_to_b.wav",
      "four-track.wav",
      "checksums.sha256",
      "export-manifest.json",
    ] as const;
    const directoryInfo = await lstat(outputDirectory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw new Error("Managed export workspace is not a regular directory");
    }
    const foundNames = new Set<string>();
    const directory = await opendir(outputDirectory);
    for await (const entry of directory) {
      if (foundNames.size >= expectedNames.length || !expectedNames.includes(entry.name as never)) {
        throw new Error("Managed export workspace contains an unexpected entry");
      }
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Managed export workspace contains a non-regular entry");
      }
      if (foundNames.has(entry.name)) {
        throw new Error("Managed export workspace contains a duplicate entry");
      }
      foundNames.add(entry.name);
    }
    if (expectedNames.some((name) => !foundNames.has(name))) {
      throw new Error("Managed export workspace is incomplete");
    }
    const manifestPath = join(outputDirectory, "export-manifest.json");
    const manifestFile = await this.#readBoundedManagedFile(
      manifestPath,
      MAX_MANAGED_EXPORT_MANIFEST_BYTES,
      "Managed export manifest",
    );
    if (
      manifestFile === undefined ||
      createHash("sha256").update(manifestFile.contents).digest("hex") !== expectedManifestSha256
    ) {
      throw new Error("Managed export manifest no longer matches its completion receipt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestFile.contents.toString("utf8"));
    } catch {
      throw new Error("Managed export manifest is corrupt");
    }
    const manifestKeys = [
      "schemaVersion",
      "kind",
      "exportId",
      "processing",
      "processingManifest",
      "processingManifestSha256",
      "consentReceiptRefs",
      "finalization",
      "eventCount",
      "originTimelineAtMonoMs",
      "trackFrameCounts",
      "events",
      "tracks",
      "fourTrack",
      "plaintextWarning",
      "exportSha256",
    ] as const;
    if (
      !isPlainObject(parsed) ||
      !hasExactKeys(parsed, manifestKeys) ||
      parsed.schemaVersion !== FORMAT_VERSION ||
      parsed.kind !== "managed_finalized_four_track_evidence_export" ||
      parsed.exportId !== expectedExportId ||
      parsed.plaintextWarning !== "AUTHORIZED_PLAINTEXT_EXPORT" ||
      !isSha256(parsed.exportSha256)
    ) {
      throw new Error("Managed export manifest has invalid identity");
    }
    const events = parsed.events;
    const tracks = parsed.tracks;
    const fourTrack = parsed.fourTrack;
    if (
      !isPlainObject(events) ||
      !hasExactKeys(events, ["path", "sha256"]) ||
      events.path !== "events.jsonl" ||
      !isSha256(events.sha256) ||
      !isPlainObject(tracks) ||
      !hasExactKeys(tracks, EVIDENCE_AUDIO_TRACKS) ||
      !isPlainObject(fourTrack)
    ) {
      throw new Error("Managed export manifest file projection is invalid");
    }
    const wavKeys = [
      "path",
      "channels",
      "sampleRateHz",
      "bitsPerSample",
      "sampleFrames",
      "dataBytes",
      "sha256",
    ] as const;
    const expectedTrackPaths: Readonly<Record<EvidenceAudioTrack, string>> = freeze({
      source_a: "source_a.wav",
      source_b: "source_b.wav",
      playout_to_a: "playout_to_a.wav",
      playout_to_b: "playout_to_b.wav",
    });
    const hashes = new Map<string, string>([[events.path, events.sha256]]);
    for (const track of EVIDENCE_AUDIO_TRACKS) {
      const wav = tracks[track];
      if (
        !isPlainObject(wav) ||
        !hasExactKeys(wav, wavKeys) ||
        wav.path !== expectedTrackPaths[track] ||
        wav.channels !== 1 ||
        wav.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
        wav.bitsPerSample !== 16 ||
        !isNonNegativeSafeInteger(wav.sampleFrames) ||
        !isNonNegativeSafeInteger(wav.dataBytes) ||
        !isSha256(wav.sha256)
      ) {
        throw new Error("Managed export track manifest is invalid");
      }
      hashes.set(wav.path, wav.sha256);
    }
    if (
      !hasExactKeys(fourTrack, wavKeys) ||
      fourTrack.path !== "four-track.wav" ||
      fourTrack.channels !== 4 ||
      fourTrack.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
      fourTrack.bitsPerSample !== 16 ||
      !isNonNegativeSafeInteger(fourTrack.sampleFrames) ||
      !isNonNegativeSafeInteger(fourTrack.dataBytes) ||
      !isSha256(fourTrack.sha256)
    ) {
      throw new Error("Managed export four-track manifest is invalid");
    }
    hashes.set(fourTrack.path, fourTrack.sha256);
    for (const [name, expectedSha256] of hashes) {
      if (await this.#sha256File(join(outputDirectory, name)) !== expectedSha256) {
        throw new Error("Managed export output no longer matches its manifest");
      }
    }
    const checksumFile = await this.#readBoundedManagedFile(
      join(outputDirectory, "checksums.sha256"),
      MAX_MANAGED_EXPORT_CHECKSUMS_BYTES,
      "Managed export checksums",
    );
    const expectedChecksums = [
      `${events.sha256}  events.jsonl`,
      ...EVIDENCE_AUDIO_TRACKS.map((track) => {
        const wav = tracks[track] as Readonly<Record<string, unknown>>;
        return `${String(wav.sha256)}  ${String(wav.path)}`;
      }),
      `${fourTrack.sha256}  four-track.wav`,
      `${expectedManifestSha256}  export-manifest.json`,
    ].join("\n") + "\n";
    if (checksumFile === undefined || checksumFile.contents.toString("utf8") !== expectedChecksums) {
      throw new Error("Managed export checksum file is invalid");
    }
  }

  async #recoverPendingManagedExport(state: RuntimeState): Promise<void> {
    const pending = state.metadata.managedExport;
    if (
      pending?.status !== "audit_pending" ||
      !isSha256(pending.manifestFileSha256)
    ) {
      return;
    }
    await this.#ensurePendingCommitAuditAnchor(state);
    await this.#verifyCompletedManagedExportWorkspace(
      state.archiveId,
      pending.manifestFileSha256,
      pending.exportId,
    );
    const completionAudit = await this.#findMatchingCommandAudit(state.archiveId, {
      action: "owner_export",
      outcome: "completed",
      role: "retention_owner",
      actorIdHmac: pending.auditActorIdHmac,
      requestHmac: pending.auditRequestHmac,
      responseSha256: pending.manifestFileSha256,
    });
    if (completionAudit === undefined) return;
    const auditPendingMetadata = state.metadata;
    state.metadata = freeze({
      ...auditPendingMetadata,
      managedExport: freeze({ ...pending, status: "completed" as const }),
    });
    try {
      await this.#persistSidecar(state);
    } catch (error: unknown) {
      state.metadata = auditPendingMetadata;
      throw error;
    }
  }

  #archiveIdForSession(sessionId: string): string {
    return opaqueHmac(this.#archiveIdKey, "session-archive", sessionId);
  }

  #reserveArtifactLockAdmission(archiveId: string): () => void {
    checkedArchiveId(archiveId);
    const admitted = this.#artifactLockAdmissions.get(archiveId) ?? 0;
    if (
      admitted >= MAX_PENDING_ARTIFACT_LIFECYCLE_OPERATIONS ||
      this.#artifactLockAdmissionTotal >= MAX_PENDING_ARTIFACT_LIFECYCLE_OPERATIONS_GLOBAL
    ) {
      throw new ArtifactLifecycleQueueFullError();
    }
    this.#artifactLockAdmissions.set(archiveId, admitted + 1);
    this.#artifactLockAdmissionTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#artifactLockAdmissions.get(archiveId);
      if (current === undefined || current <= 1) {
        this.#artifactLockAdmissions.delete(archiveId);
      } else {
        this.#artifactLockAdmissions.set(archiveId, current - 1);
      }
      this.#artifactLockAdmissionTotal -= 1;
    };
  }

  async #withOwnedArtifactOperation<T>(
    archiveId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    // Count this exact lease generation before either the capacity reservation
    // or marker verification can yield. Release must not clear an admission
    // that can later decrement a successor lease's counters.
    const lease = this.#beginOwnedRootLeaseOperation();
    let releaseAdmission: (() => void) | undefined;
    try {
      releaseAdmission = this.#reserveArtifactLockAdmission(archiveId);
      await this.#verifyEnteredRootLeaseOperation(lease);
      return await this.#withArtifactLock(archiveId, action, true);
    } finally {
      releaseAdmission?.();
      this.#leaveOwnedRootLeaseOperation(lease);
    }
  }

  async #withArtifactLock<T>(
    archiveId: string,
    action: () => Promise<T>,
    admissionReserved = false,
  ): Promise<T> {
    const releaseAdmission = admissionReserved
      ? undefined
      : this.#reserveArtifactLockAdmission(archiveId);
    const previous = this.#artifactLocks.get(archiveId) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.catch(() => undefined).then(() => held);
    this.#artifactLocks.set(archiveId, current);
    await previous.catch(() => undefined);
    let fileLock: HeldFileLock | undefined;
    try {
      fileLock = await this.#acquireArtifactFileLock(archiveId);
      return await action();
    } finally {
      try {
        if (fileLock !== undefined) await this.#releaseArtifactFileLock(fileLock);
      } finally {
        release();
        if (this.#artifactLocks.get(archiveId) === current) this.#artifactLocks.delete(archiveId);
        releaseAdmission?.();
      }
    }
  }

  #archiveIdForLookup(lookup: SessionArtifactLookup): string {
    if ("archiveId" in lookup) return checkedArchiveId(lookup.archiveId);
    return this.#archiveIdForSession(checkedSessionId(lookup.sessionId));
  }

  async #hasDeletionTombstone(archiveId: string): Promise<boolean> {
    const receipt = await this.#readDeletionReceipt(archiveId);
    return receipt !== undefined;
  }

  #spoolPath(archiveId: string): string {
    return join(this.#archiveDirectory, checkedArchiveId(archiveId) + ".spool.enc");
  }

  #archivePath(archiveId: string): string {
    return join(this.#archiveDirectory, checkedArchiveId(archiveId) + ".evidence.jsonl.enc");
  }

  #keyPath(archiveId: string): string {
    return join(this.#keyDirectory, checkedArchiveId(archiveId) + ".key.json");
  }

  #lifecycleLockPath(archiveId: string): string {
    return join(this.#keyDirectory, checkedArchiveId(archiveId) + ".lifecycle.lock");
  }

  #rootLeasePath(): string {
    return join(this.#keyDirectory, "evidence-root.lifecycle.lock");
  }

  #signLockMarker<T extends object>(body: T): T & Readonly<{ markerHmac: string }> {
    return freeze({
      ...body,
      markerHmac: opaqueHmac(
        this.#lockMarkerAuthenticationKey,
        "evidence-lock-marker",
        canonicalEvidenceJson(body),
      ),
    });
  }

  #hasValidLockMarkerHmac(marker: unknown): boolean {
    if (!isPlainObject(marker) || !isSha256(marker.markerHmac)) return false;
    const { markerHmac, ...body } = marker;
    const expected = opaqueHmac(
      this.#lockMarkerAuthenticationKey,
      "evidence-lock-marker",
      canonicalEvidenceJson(body),
    );
    return timingSafeEqual(Buffer.from(markerHmac, "hex"), Buffer.from(expected, "hex"));
  }

  #lockMarkerHasExactKeys(marker: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
    return canonicalEvidenceJson(Object.keys(marker).sort()) === canonicalEvidenceJson([...keys].sort());
  }

  async acquireEvidenceRootLease(role: EvidenceRootLeaseRole): Promise<EvidenceRootProcessLease> {
    if (role !== "server" && role !== "offline_admin") {
      throw new RangeError("Evidence root lease role is invalid");
    }
    if (this.#rootProcessLease !== undefined) {
      throw new Error("This evidence store already owns a root process lease");
    }
    // A rejected competing lease must be observationally read-only. In
    // particular, do not chmod, harden ACLs, or create any configured root
    // until a minimally safe read has established that no live foreign root
    // marker already owns the key scope.
    await this.#assertNoLiveForeignEvidenceRootLease();
    await this.#ensureRoots();
    const path = this.#rootLeasePath();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lockId = randomUUID();
      const marker: EvidenceRootLeaseFile = this.#signLockMarker({
        schemaVersion: FORMAT_VERSION,
        kind: "evidence_root_process_lease",
        role,
        host: hostname(),
        processId: process.pid,
        processStartIdentity: PROCESS_START_IDENTITY,
        lockId,
      });
      if (await this.#createExclusiveLockMarker(path, marker)) {
        const held: HeldEvidenceRootLease = {
          role,
          path,
          lockId,
          closing: false,
          activeOperations: 0,
        };
        this.#rootProcessLease = held;
        this.#windowsAclVerificationLeaseId = process.platform === "win32" ? lockId : undefined;
        let releasePromise: Promise<void> | undefined;
        return freeze({
          role,
          release: (): Promise<void> => {
            if (releasePromise !== undefined) return releasePromise;
            // Synchronously stop a new operation from passing its admission
            // check while the release waits for work already in progress.
            held.closing = true;
            const attempt = this.#releaseEvidenceRootLease(held).then(() => {
              if (this.#rootProcessLease === held) this.#rootProcessLease = undefined;
            });
            releasePromise = attempt;
            // A failed removal leaves the exact marker and this closed lease
            // in place. Clear only the in-flight promise so a later release
            // call can retry the same ownership safely.
            void attempt.catch(() => {
              if (releasePromise === attempt) releasePromise = undefined;
            });
            return attempt;
          },
        });
      }
      if (attempt === 0 && await this.#reclaimDeadEvidenceRootLease()) continue;
      throw new Error("Evidence root is leased by another process");
    }
    throw new Error("Evidence root process lease could not be acquired");
  }

  async #assertNoLiveForeignEvidenceRootLease(): Promise<void> {
    // This checks every existing ancestor without creating or hardening one,
    // so the marker read cannot be redirected through a symlinked parent.
    await this.#assertRootAncestorsAreRealDirectories(this.#keyDirectory);
    const snapshot = await this.#readLockMarkerSnapshot(this.#rootLeasePath());
    if (snapshot === undefined) return;
    if (!await this.#isStaleLockMarker(
      snapshot.parsed,
      (marker: unknown): marker is EvidenceRootLeaseFile => this.#isEvidenceRootLeaseMarker(marker),
    )) {
      throw new Error("Evidence root is leased by another process");
    }
  }

  async #withOwnedRootLeaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    const lease = await this.#enterOwnedRootLeaseOperation();
    try {
      return await operation();
    } finally {
      this.#leaveOwnedRootLeaseOperation(lease);
    }
  }

  async #enterOwnedRootLeaseOperation(): Promise<HeldEvidenceRootLease> {
    const lease = this.#beginOwnedRootLeaseOperation();
    try {
      await this.#verifyEnteredRootLeaseOperation(lease);
      return lease;
    } catch (error: unknown) {
      this.#leaveOwnedRootLeaseOperation(lease);
      throw error;
    }
  }

  #beginOwnedRootLeaseOperation(): HeldEvidenceRootLease {
    const lease = this.#rootProcessLease;
    if (lease === undefined || lease.closing) {
      throw new Error("This evidence store must own an evidence root lease before filesystem operations");
    }
    lease.activeOperations += 1;
    return lease;
  }

  async #verifyEnteredRootLeaseOperation(lease: HeldEvidenceRootLease): Promise<void> {
    await this.#assertOwnedRootLease(lease);
    if (this.#rootProcessLease !== lease || lease.closing) {
      throw new Error("This evidence store must own an evidence root lease before filesystem operations");
    }
  }

  #leaveOwnedRootLeaseOperation(lease: HeldEvidenceRootLease): void {
    lease.activeOperations -= 1;
    if (lease.activeOperations !== 0) return;
    const resolveDrain = lease.resolveDrain;
    delete lease.resolveDrain;
    resolveDrain?.();
  }

  async #assertOwnedRootLease(expectedLease?: HeldEvidenceRootLease): Promise<void> {
    const lease = expectedLease ?? this.#rootProcessLease;
    if (lease === undefined) {
      throw new Error("This evidence store must own an evidence root lease before filesystem operations");
    }
    const snapshot = await this.#readLockMarkerSnapshot(lease.path);
    if (
      this.#rootProcessLease !== lease ||
      snapshot === undefined ||
      !this.#isEvidenceRootLeaseMarker(snapshot.parsed) ||
      snapshot.parsed.role !== lease.role ||
      snapshot.parsed.lockId !== lease.lockId
    ) {
      throw new Error("This evidence store no longer owns the evidence root lease");
    }
  }

  async #releaseEvidenceRootLease(lease: HeldEvidenceRootLease): Promise<void> {
    if (lease.activeOperations !== 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            lease.resolveDrain = resolve;
          }),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Evidence root lease is busy with an unfinished operation")),
              ROOT_LEASE_RELEASE_DRAIN_TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        delete lease.resolveDrain;
      }
      if (lease.activeOperations !== 0) {
        throw new Error("Evidence root lease is busy with an unfinished operation");
      }
    }
    try {
      await this.#releaseOwnedLockMarker(lease.path, lease.lockId);
      // The root lease is the lifetime boundary for every decrypted DEK and
      // lifecycle projection. A later holder may recover or quarantine the
      // same artifact, so this Store must never reuse state cached under the
      // prior lease after it successfully relinquishes the roots.
      for (const state of this.#states.values()) {
        state.dek.fill(0);
        state.pending = 0;
        state.pendingBytes = 0;
        state.closed = true;
        state.deleting = true;
      }
      this.#states.clear();
      this.#artifactLocks.clear();
      this.#artifactLockAdmissions.clear();
      this.#artifactLockAdmissionTotal = 0;
      this.#pendingDeletionArchiveIds.clear();
      this.#lastSuccessfulSweepAtMs = undefined;
    } finally {
      this.#verifiedAuditHeads.clear();
      this.#windowsAclVerificationLeaseId = undefined;
    }
  }

  async #reclaimDeadEvidenceRootLease(): Promise<boolean> {
    return this.#reclaimStaleLockMarker(
      this.#rootLeasePath(),
      (marker: unknown): marker is EvidenceRootLeaseFile => this.#isEvidenceRootLeaseMarker(marker),
    );
  }

  async #acquireArtifactFileLock(archiveId: string): Promise<HeldFileLock> {
    checkedArchiveId(archiveId);
    await this.#assertOwnedRootLease();
    await this.#ensureRoots();
    const path = this.#lifecycleLockPath(archiveId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lockId = randomUUID();
      const marker: ArtifactLifecycleLockFile = this.#signLockMarker({
        schemaVersion: FORMAT_VERSION,
        kind: "session_artifact_lifecycle_lock",
        archiveId,
        host: hostname(),
        processId: process.pid,
        processStartIdentity: PROCESS_START_IDENTITY,
        lockId,
      });
      if (await this.#createExclusiveLockMarker(path, marker)) return { path, lockId };
      if (attempt === 0 && await this.#reclaimDeadArtifactFileLock(archiveId)) continue;
      throw new Error("Artifact lifecycle is locked by another process");
    }
    throw new Error("Artifact lifecycle lock could not be acquired");
  }

  async #releaseArtifactFileLock(lock: HeldFileLock): Promise<void> {
    await this.#releaseOwnedLockMarker(lock.path, lock.lockId);
  }

  async #reclaimDeadArtifactFileLock(archiveId: string): Promise<boolean> {
    return this.#reclaimStaleLockMarker(
      this.#lifecycleLockPath(archiveId),
      (marker: unknown): marker is ArtifactLifecycleLockFile =>
        this.#isArtifactLifecycleLockMarker(marker, archiveId),
    );
  }

  /**
   * Creates a complete, fsynced marker off-path, then hard-links it into the
   * lock name. Unlike `open(lock, "wx")` followed by a write, a crash never
   * exposes an empty/torn marker as an acquired lock.
   */
  async #createExclusiveLockMarker(
    path: string,
    marker: EvidenceRootLeaseFile | ArtifactLifecycleLockFile | LockReclaimClaimFile,
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
      } catch (error: unknown) {
        if (isErrno(error, "EEXIST")) return false;
        throw error;
      }
      linked = true;
      await unlink(temporary);
      createdTemporary = false;
      await this.#syncDirectory(dirname(path));
      committed = true;
      return true;
    } catch (error: unknown) {
      if (linked && !committed) {
        // A link is not an acquired lock until its directory entry is durable.
        // If that durability boundary fails, remove only the exact marker we
        // just authenticated and linked so the failed attempt cannot deadlock
        // this process or a successor.
        await this.#releaseOwnedLockMarker(path, marker.lockId).catch(() => undefined);
      }
      throw error;
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      if (createdTemporary) {
        await unlink(temporary).catch(() => undefined);
      }
    }
  }

  async #readBoundedManagedFile(
    path: string,
    maximumBytes: number,
    description: string,
  ): Promise<BoundedManagedFileSnapshot | undefined> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const pathInfo = await lstat(path);
      if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
        throw new Error(description + " is not a regular file");
      }
      handle = await open(path, "r");
      const info = await handle.stat();
      if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
        throw new Error(description + " is not a regular file");
      }
      if (info.size > maximumBytes) {
        throw new Error(description + " exceeds its maximum size");
      }
      const bytes = Buffer.alloc(maximumBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > maximumBytes) {
        throw new Error(description + " exceeds its maximum size");
      }
      const currentPathInfo = await lstat(path);
      if (
        currentPathInfo.isSymbolicLink() ||
        !currentPathInfo.isFile() ||
        String(currentPathInfo.dev) !== String(info.dev) ||
        String(currentPathInfo.ino) !== String(info.ino)
      ) {
        throw new Error(description + " changed while it was read");
      }
      return freeze({
        device: String(info.dev),
        inode: String(info.ino),
        contents: bytes.subarray(0, offset),
      });
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      if (handle !== undefined) await handle.close();
    }
  }

  async #readLockMarkerSnapshot(path: string): Promise<LockMarkerSnapshot | undefined> {
    const file = await this.#readBoundedManagedFile(
      path,
      MAX_LOCK_MARKER_BYTES,
      "Lifecycle lock marker",
    );
    if (file === undefined) return undefined;
    const contents = file.contents.toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      parsed = undefined;
    }
    return freeze({
      path,
      device: file.device,
      inode: file.inode,
      contents,
      digest: createHash("sha256").update(contents).digest("hex"),
      parsed,
    });
  }

  #sameLockMarkerSnapshot(left: LockMarkerSnapshot, right: LockMarkerSnapshot): boolean {
    return left.path === right.path &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.digest === right.digest;
  }

  #hasLockOwnership(marker: unknown): marker is Readonly<{
    readonly schemaVersion: 3;
    readonly host: string;
    readonly processId: number;
    readonly processStartIdentity: string;
    readonly lockId: string;
    readonly markerHmac: string;
    readonly [key: string]: unknown;
  }> {
    if (!isPlainObject(marker) || !this.#hasValidLockMarkerHmac(marker)) return false;
    const candidate = marker as Partial<{
      readonly schemaVersion: number;
      readonly host: unknown;
      readonly processId: unknown;
      readonly processStartIdentity: unknown;
      readonly lockId: unknown;
      readonly markerHmac: unknown;
    }>;
    return candidate.schemaVersion === FORMAT_VERSION &&
      typeof candidate.host === "string" && candidate.host.length > 0 &&
      isNonNegativeSafeInteger(candidate.processId) && candidate.processId > 0 &&
      typeof candidate.processStartIdentity === "string" && candidate.processStartIdentity.length > 0 &&
      typeof candidate.lockId === "string" && candidate.lockId.length > 0 &&
      isSha256(candidate.markerHmac);
  }

  #isEvidenceRootLeaseMarker(marker: unknown): marker is EvidenceRootLeaseFile {
    return this.#hasLockOwnership(marker) &&
      this.#lockMarkerHasExactKeys(marker, [
        "host",
        "kind",
        "lockId",
        "markerHmac",
        "processId",
        "processStartIdentity",
        "role",
        "schemaVersion",
      ]) &&
      marker.kind === "evidence_root_process_lease" &&
      (marker.role === "server" || marker.role === "offline_admin");
  }

  #isArtifactLifecycleLockMarker(marker: unknown, archiveId: string): marker is ArtifactLifecycleLockFile {
    return this.#hasLockOwnership(marker) &&
      this.#lockMarkerHasExactKeys(marker, [
        "archiveId",
        "host",
        "kind",
        "lockId",
        "markerHmac",
        "processId",
        "processStartIdentity",
        "schemaVersion",
      ]) &&
      marker.kind === "session_artifact_lifecycle_lock" &&
      marker.archiveId === archiveId;
  }

  #isLockReclaimClaimMarker(marker: unknown): marker is LockReclaimClaimFile {
    return this.#hasLockOwnership(marker) &&
      this.#lockMarkerHasExactKeys(marker, [
        "host",
        "kind",
        "lockId",
        "markerHmac",
        "processId",
        "processStartIdentity",
        "schemaVersion",
        "targetDigest",
      ]) &&
      marker.kind === "evidence_lock_reclaim_claim" &&
      isSha256(marker.targetDigest);
  }

  async #isStaleLockMarker(
    marker: unknown,
    isExpectedMarker: (value: unknown) => boolean,
  ): Promise<boolean> {
    // Only an authenticated marker can be reclaimed automatically. A
    // malformed or forged marker is an ambiguous security-root mutation and
    // requires explicit operator remediation rather than PID-based guessing.
    if (!isExpectedMarker(marker) || !this.#hasLockOwnership(marker)) return false;
    if (marker.host !== hostname()) return false;
    if (marker.processId === process.pid) {
      return marker.processStartIdentity !== PROCESS_START_IDENTITY;
    }
    try {
      process.kill(marker.processId, 0);
      // Another same-host process is live. Its opaque incarnation cannot be
      // verified through Node alone, so fail closed rather than erase it.
      return false;
    } catch (error: unknown) {
      return isErrno(error, "ESRCH");
    }
  }

  #reclaimClaimPath(snapshot: LockMarkerSnapshot): string {
    const targetDigest = createHash("sha256")
      .update(snapshot.path + "\u0000" + snapshot.device + "\u0000" + snapshot.inode + "\u0000" + snapshot.digest)
      .digest("hex");
    return snapshot.path + "." + targetDigest.slice(0, 24) + ".reclaim";
  }

  async #reclaimStaleLockMarker(
    path: string,
    isExpectedMarker: (value: unknown) => boolean,
    depth = 0,
  ): Promise<boolean> {
    const snapshot = await this.#readLockMarkerSnapshot(path);
    if (snapshot === undefined) return true;
    if (!await this.#isStaleLockMarker(snapshot.parsed, isExpectedMarker)) return false;

    const claimPath = this.#reclaimClaimPath(snapshot);
    const claim: LockReclaimClaimFile = this.#signLockMarker({
      schemaVersion: FORMAT_VERSION,
      kind: "evidence_lock_reclaim_claim",
      targetDigest: snapshot.digest,
      host: hostname(),
      processId: process.pid,
      processStartIdentity: PROCESS_START_IDENTITY,
      lockId: randomUUID(),
    });
    if (!(await this.#createExclusiveLockMarker(claimPath, claim))) {
      // A prior reclaimer owns this exact snapshot. If it crashed, one bounded
      // recursive takeover clears its claim; otherwise we leave the live
      // claimant untouched and report the lock as unavailable.
      if (depth >= 2 || !await this.#reclaimStaleLockMarker(
        claimPath,
        (marker: unknown): marker is LockReclaimClaimFile => this.#isLockReclaimClaimMarker(marker),
        depth + 1,
      )) {
        return false;
      }
      return this.#reclaimStaleLockMarker(path, isExpectedMarker, depth + 1);
    }
    try {
      const current = await this.#readLockMarkerSnapshot(path);
      if (current === undefined) return true;
      if (!this.#sameLockMarkerSnapshot(snapshot, current)) return false;
      await unlink(path);
      await this.#syncDirectory(dirname(path));
      return true;
    } finally {
      await this.#releaseOwnedLockMarker(claimPath, claim.lockId);
    }
  }

  async #releaseOwnedLockMarker(path: string, lockId: string): Promise<void> {
    const snapshot = await this.#readLockMarkerSnapshot(path);
    if (snapshot === undefined) return;
    if (!this.#hasLockOwnership(snapshot.parsed)) {
      throw new Error("Lifecycle lock marker authentication is invalid");
    }
    const marker = snapshot.parsed;
    if (
      marker.lockId !== lockId ||
      marker.processId !== process.pid ||
      marker.processStartIdentity !== PROCESS_START_IDENTITY
    ) {
      return;
    }
    try {
      const current = await this.#readLockMarkerSnapshot(path);
      if (current === undefined || !this.#sameLockMarkerSnapshot(snapshot, current)) return;
      await unlink(path);
      await this.#syncDirectory(dirname(path));
    } catch (error: unknown) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }

  #probePath(archiveId: string): string {
    return join(this.#archiveDirectory, checkedArchiveId(archiveId) + ".probe.enc");
  }

  #exportPath(archiveId: string): string {
    return join(this.#exportDirectory, checkedArchiveId(archiveId));
  }

  #receiptPath(archiveId: string): string {
    return join(this.#receiptDirectory, checkedArchiveId(archiveId) + ".delete.json");
  }

  #auditJournalPath(archiveId: string): string {
    return join(this.#receiptDirectory, checkedArchiveId(archiveId) + ".audit.jsonl.enc");
  }

  #auditHeadPath(archiveId: string): string {
    return join(this.#receiptDirectory, checkedArchiveId(archiveId) + ".audit.head.enc");
  }

  async #auditJournalSnapshot(archiveId: string): Promise<AuditJournalSnapshot> {
    const path = this.#auditJournalPath(archiveId);
    await this.#assertManagedFile(path);
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      !Number.isFinite(info.mtimeMs) ||
      !Number.isFinite(info.ctimeMs)
    ) {
      throw new Error("Evidence audit journal identity is invalid");
    }
    if (info.size > MAX_CONTENT_FREE_AUDIT_BYTES) {
      throw new Error("Evidence audit journal exceeds its maximum size");
    }
    return freeze({
      device: String(info.dev),
      inode: String(info.ino),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    });
  }

  async #cacheVerifiedAuditHead(
    archiveId: string,
    head: ContentFreeAuditHead,
  ): Promise<CachedAuditHead> {
    const cached = head.count === 0
      ? freeze({ ...head })
      : freeze({ ...head, journal: await this.#auditJournalSnapshot(archiveId) });
    this.#verifiedAuditHeads.delete(archiveId);
    this.#verifiedAuditHeads.set(archiveId, cached);
    while (this.#verifiedAuditHeads.size > MAX_VERIFIED_AUDIT_HEAD_CACHE_ENTRIES) {
      const leastRecentlyUsed = this.#verifiedAuditHeads.keys().next().value;
      if (leastRecentlyUsed === undefined) break;
      this.#verifiedAuditHeads.delete(leastRecentlyUsed);
    }
    return cached;
  }

  async #reviewAuditAdmissionOpen(
    archiveId: string,
    audit: ContentFreeAuditHead,
  ): Promise<boolean> {
    if (audit.count >= MAX_CONTENT_FREE_AUDIT_REVIEW_ENTRIES) return false;
    try {
      const path = this.#auditJournalPath(archiveId);
      if (!(await this.#pathExists(path))) return audit.count === 0;
      const snapshot = await this.#auditJournalSnapshot(archiveId);
      // A review callback must not run when the eventual audit append could
      // fail solely because the detached journal has reached its byte cap.
      return snapshot.size <= MAX_CONTENT_FREE_AUDIT_BYTES - MAX_CONTENT_FREE_AUDIT_LINE_BYTES;
    } catch {
      return false;
    }
  }

  async #auditAppendAdmissionOpen(
    archiveId: string,
    audit: ContentFreeAuditHead,
  ): Promise<boolean> {
    if (audit.count >= MAX_CONTENT_FREE_AUDIT_ENTRIES) return false;
    try {
      const path = this.#auditJournalPath(archiveId);
      if (!(await this.#pathExists(path))) return audit.count === 0;
      const snapshot = await this.#auditJournalSnapshot(archiveId);
      return snapshot.size <= MAX_CONTENT_FREE_AUDIT_BYTES - MAX_CONTENT_FREE_AUDIT_LINE_BYTES;
    } catch {
      return false;
    }
  }

  #auditRequestHmac(action: EvidenceAuditAction, selection: unknown): string {
    return opaqueHmac(
      this.#auditAuthenticationKey,
      "content-free-audit-request:" + action,
      canonicalEvidenceJson(selection),
    );
  }

  #auditActorIdHmac(role: EvidenceAuditRole, actorId: string): string {
    return opaqueHmac(
      this.#auditAuthenticationKey,
      "content-free-audit-actor:" + role,
      actorId,
    );
  }

  #auditIdForEntry(
    archiveId: string,
    entry: Omit<ContentFreeAuditEntry, "auditId" | "headSha256">,
  ): string {
    return opaqueHmac(
      this.#auditAuthenticationKey,
      "content-free-audit-id:" + archiveId,
      canonicalEvidenceJson(entry),
    );
  }

  #auditHeadSha256(
    archiveId: string,
    entry: Omit<ContentFreeAuditEntry, "headSha256">,
  ): string {
    return opaqueHmac(
      this.#auditAuthenticationKey,
      "content-free-audit-head:" + archiveId,
      canonicalEvidenceJson(entry),
    );
  }

  #isEvidenceAuditAction(value: unknown): value is EvidenceAuditAction {
    return value === "review_metadata_page" ||
      value === "review_audio_window" ||
      value === "retention_view" ||
      value === "owner_export" ||
      value === "retention_extension" ||
      value === "deletion";
  }

  #isEvidenceAuditOutcome(value: unknown): value is EvidenceAuditOutcome {
    return value === "completed" ||
      value === "conflict" ||
      value === "expired" ||
      value === "grant_denied" ||
      value === "integrity_failed" ||
      value === "not_found" ||
      value === "not_sealed" ||
      value === "pending" ||
      value === "rejected";
  }

  #isEvidenceAuditRole(value: unknown): value is EvidenceAuditRole {
    return value === "retention_owner" ||
      value === "evidence_reviewer" ||
      value === "retention_system";
  }

  #validateContentFreeAuditEntry(
    archiveId: string,
    candidate: unknown,
    expectedCount: number,
    expectedPriorHeadSha256: string,
  ): ContentFreeAuditEntry {
    if (!isPlainObject(candidate)) throw new Error("Evidence audit entry is invalid");
    const expectedKeys = [
      "action",
      "actorIdHmac",
      "auditId",
      "count",
      "headSha256",
      "outcome",
      "priorHeadSha256",
      "requestHmac",
      "responseSha256",
      "role",
      "timestampMs",
    ];
    if (canonicalEvidenceJson(Object.keys(candidate).sort()) !== canonicalEvidenceJson(expectedKeys)) {
      throw new Error("Evidence audit entry is invalid");
    }
    const entry = candidate as Partial<ContentFreeAuditEntry>;
    if (
      !this.#isEvidenceAuditAction(entry.action) ||
      !this.#isEvidenceAuditOutcome(entry.outcome) ||
      !this.#isEvidenceAuditRole(entry.role) ||
      !isSha256(entry.actorIdHmac) ||
      !isSha256(entry.requestHmac) ||
      !isSha256(entry.responseSha256) ||
      !isNonNegativeSafeInteger(entry.timestampMs) ||
      !isSha256(entry.priorHeadSha256) ||
      !isSha256(entry.headSha256) ||
      !isNonNegativeSafeInteger(entry.count) ||
      entry.count !== expectedCount ||
      entry.priorHeadSha256 !== expectedPriorHeadSha256
    ) {
      throw new Error("Evidence audit entry is invalid");
    }
    const withoutAuditIdAndHead = {
      action: entry.action,
      outcome: entry.outcome,
      role: entry.role,
      actorIdHmac: entry.actorIdHmac,
      requestHmac: entry.requestHmac,
      responseSha256: entry.responseSha256,
      timestampMs: entry.timestampMs,
      priorHeadSha256: entry.priorHeadSha256,
      count: entry.count,
    } satisfies Omit<ContentFreeAuditEntry, "auditId" | "headSha256">;
    const expectedAuditId = this.#auditIdForEntry(archiveId, withoutAuditIdAndHead);
    if (entry.auditId !== expectedAuditId) throw new Error("Evidence audit entry is invalid");
    const withoutHead = { ...withoutAuditIdAndHead, auditId: entry.auditId } satisfies Omit<
      ContentFreeAuditEntry,
      "headSha256"
    >;
    const expectedHead = this.#auditHeadSha256(archiveId, withoutHead);
    if (!timingSafeEqual(Buffer.from(entry.headSha256, "hex"), Buffer.from(expectedHead, "hex"))) {
      throw new Error("Evidence audit entry integrity is invalid");
    }
    return freeze({ ...withoutHead, headSha256: entry.headSha256 });
  }

  async *#iterateContentFreeAuditEntries(
    archiveId: string,
  ): AsyncGenerator<ContentFreeAuditEntry> {
    const path = this.#auditJournalPath(archiveId);
    await this.#assertManagedFile(path);
    let count = 0;
    let totalBytes = 0;
    let priorHeadSha256 = EMPTY_CHAIN_SHA256;
    for await (const line of this.#iterateBoundedUtf8Lines(
      path,
      MAX_CONTENT_FREE_AUDIT_LINE_BYTES,
      "Evidence audit journal line exceeds its maximum",
    )) {
      if (line.length === 0) throw new Error("Evidence audit journal is invalid");
      totalBytes += Buffer.byteLength(line, "utf8") + 1;
      if (totalBytes > MAX_CONTENT_FREE_AUDIT_BYTES) {
        throw new Error("Evidence audit journal exceeds its maximum size");
      }
      if (count >= MAX_CONTENT_FREE_AUDIT_ENTRIES) {
        throw new Error("Evidence audit journal exceeds its maximum entry count");
      }
      count += 1;
      let encrypted: unknown;
      try {
        encrypted = JSON.parse(line);
      } catch {
        throw new Error("Evidence audit journal is invalid");
      }
      const plaintext = decryptBlob(
        this.#auditEntryKey,
        archiveId,
        count,
        "content_free_audit_entry",
        encrypted,
      );
      const entry = this.#validateContentFreeAuditEntry(
        archiveId,
        parseJson<unknown>(plaintext, "Evidence audit entry is invalid"),
        count,
        priorHeadSha256,
      );
      priorHeadSha256 = entry.headSha256;
      yield entry;
    }
  }

  async #readContentFreeAuditHead(archiveId: string): Promise<ContentFreeAuditHead> {
    const path = this.#auditHeadPath(archiveId);
    const file = await this.#readBoundedManagedFile(
      path,
      MAX_CONTENT_FREE_AUDIT_HEAD_BYTES,
      "Evidence audit head",
    );
    if (file === undefined) throw new Error("Evidence audit head is missing");
    let encrypted: unknown;
    try {
      encrypted = JSON.parse(file.contents.toString("utf8"));
    } catch {
      throw new Error("Evidence audit head is invalid");
    }
    const index = (encrypted as Partial<EncryptedBlob>)?.index;
    if (!isNonNegativeSafeInteger(index) || index === 0) {
      throw new Error("Evidence audit head is invalid");
    }
    const head = parseJson<unknown>(
      decryptBlob(this.#auditHeadKey, archiveId, index, "content_free_audit_head", encrypted),
      "Evidence audit head is invalid",
    );
    if (
      !isPlainObject(head) ||
      canonicalEvidenceJson(Object.keys(head).sort()) !== canonicalEvidenceJson(["count", "headSha256"]) ||
      !isNonNegativeSafeInteger(head.count) ||
      head.count !== index ||
      !isSha256(head.headSha256)
    ) {
      throw new Error("Evidence audit head is invalid");
    }
    return freeze({ count: head.count, headSha256: head.headSha256 });
  }

  async #writeContentFreeAuditHead(
    archiveId: string,
    head: ContentFreeAuditHead,
  ): Promise<void> {
    const encryptedHead = encryptBlob(
      this.#auditHeadKey,
      archiveId,
      head.count,
      "content_free_audit_head",
      plainText(head),
    );
    await this.#writeAtomic(this.#auditHeadPath(archiveId), JSON.stringify(encryptedHead) + "\n");
  }

  async #verifyContentFreeAuditFilesPrivate(archiveId: string): Promise<void> {
    const paths = [this.#auditJournalPath(archiveId), this.#auditHeadPath(archiveId)];
    if (process.platform === "win32") {
      // Root-lease admission has already hardened and verified this private,
      // protected-inheritance root. Per-entry auditing must stay bounded: do
      // not spawn the recursive root ACL verifier for historical descendants
      // on every append or one-tail recovery. The exact new files are still
      // checked for regular, non-reparse shape before use.
      for (const path of paths) {
        if (await this.#pathExists(path)) await this.#assertManagedFile(path);
      }
      return;
    }
    for (const path of paths) {
      if (!(await this.#pathExists(path))) continue;
      await this.#assertManagedFile(path);
      await chmod(path, 0o600);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o077) !== 0) {
        throw new Error("Evidence audit file is not private");
      }
    }
  }

  async #readVerifiedContentFreeAudit(archiveId: string): Promise<ContentFreeAuditHead> {
    const journalExists = await this.#pathExists(this.#auditJournalPath(archiveId));
    const headExists = await this.#pathExists(this.#auditHeadPath(archiveId));
    if (!journalExists && !headExists) {
      if (await this.#hasAuthenticatedAuditAnchor(archiveId)) {
        throw new Error("Evidence audit chain was reset after initialization");
      }
      return freeze({ count: 0, headSha256: EMPTY_CHAIN_SHA256 });
    }
    if (!journalExists) throw new Error("Evidence audit chain is incomplete");
    // Reject an over-cap journal from its durable size before replaying or
    // decrypting any entry. The iterator separately enforces the entry-count
    // limit while preserving streaming verification.
    await this.#auditJournalSnapshot(archiveId);
    const persistedHead = headExists
      ? await this.#readContentFreeAuditHead(archiveId)
      : undefined;
    let count = 0;
    let finalHeadSha256 = EMPTY_CHAIN_SHA256;
    let headAtPersistedCount: string | undefined;
    let singleUnanchoredEntry: ContentFreeAuditEntry | undefined;
    let trailingEntry: ContentFreeAuditEntry | undefined;
    for await (const entry of this.#iterateContentFreeAuditEntries(archiveId)) {
      count = entry.count;
      finalHeadSha256 = entry.headSha256;
      if (persistedHead === undefined) {
        if (entry.count === 1) singleUnanchoredEntry = entry;
        continue;
      }
      if (entry.count === persistedHead.count) {
        headAtPersistedCount = entry.headSha256;
      } else if (entry.count === persistedHead.count + 1) {
        trailingEntry = entry;
      }
    }
    if (count === 0) throw new Error("Evidence audit journal is empty");
    if (persistedHead === undefined) {
      const onlyEntry = singleUnanchoredEntry;
      if (
        count !== 1 ||
        onlyEntry === undefined ||
        onlyEntry.count !== 1 ||
        onlyEntry.priorHeadSha256 !== EMPTY_CHAIN_SHA256
      ) {
        throw new Error("Evidence audit chain is incomplete");
      }
      const recovered = freeze({ count: onlyEntry.count, headSha256: onlyEntry.headSha256 });
      await this.#writeContentFreeAuditHead(archiveId, recovered);
      await this.#verifyContentFreeAuditFilesPrivate(archiveId);
      return recovered;
    }
    if (persistedHead.count === count && persistedHead.headSha256 === finalHeadSha256) {
      return persistedHead;
    }
    if (
      count === persistedHead.count + 1 &&
      headAtPersistedCount === persistedHead.headSha256 &&
      trailingEntry !== undefined &&
      trailingEntry.count === persistedHead.count + 1 &&
      trailingEntry.priorHeadSha256 === persistedHead.headSha256
    ) {
      const recovered = freeze({ count: trailingEntry.count, headSha256: trailingEntry.headSha256 });
      await this.#writeContentFreeAuditHead(archiveId, recovered);
      await this.#verifyContentFreeAuditFilesPrivate(archiveId);
      return recovered;
    }
    throw new Error("Evidence audit chain does not match its authenticated head");
  }

  async #auditIntegritySnapshot(
    archiveId: string,
    forceStreamingValidation = false,
  ): Promise<AuditIntegritySnapshot> {
    try {
      const cached = forceStreamingValidation ? undefined : this.#verifiedAuditHeads.get(archiveId);
      let head: ContentFreeAuditHead;
      if (cached === undefined) {
        head = await this.#readVerifiedContentFreeAudit(archiveId);
        await this.#cacheVerifiedAuditHead(archiveId, head);
      } else if (cached.count === 0) {
        if (
          await this.#pathExists(this.#auditJournalPath(archiveId)) ||
          await this.#pathExists(this.#auditHeadPath(archiveId))
        ) {
          throw new Error("Evidence audit cache does not match the filesystem");
        }
        head = cached;
      } else {
        const onDisk = await this.#readContentFreeAuditHead(archiveId);
        if (onDisk.count !== cached.count || onDisk.headSha256 !== cached.headSha256) {
          throw new Error("Evidence audit cache does not match the authenticated head");
        }
        const journal = await this.#auditJournalSnapshot(archiveId);
        if (
          cached.journal === undefined ||
          canonicalEvidenceJson(journal) !== canonicalEvidenceJson(cached.journal)
        ) {
          throw new Error("Evidence audit cache does not match the journal identity");
        }
        head = cached;
      }
      if (cached !== undefined) {
        this.#verifiedAuditHeads.delete(archiveId);
        this.#verifiedAuditHeads.set(archiveId, cached);
      }
      return freeze({ ...head, integrity: "valid" as const });
    } catch {
      // Never serialize an untrusted observed head into a signed receipt.
      this.#verifiedAuditHeads.delete(archiveId);
      return freeze({ count: 0, headSha256: EMPTY_CHAIN_SHA256, integrity: "invalid" as const });
    }
  }

  async #requireValidAudit(archiveId: string): Promise<ContentFreeAuditHead> {
    const snapshot = await this.#auditIntegritySnapshot(archiveId);
    if (snapshot.integrity !== "valid") throw new Error("Evidence audit integrity is invalid");
    return freeze({ count: snapshot.count, headSha256: snapshot.headSha256 });
  }

  async #markAuditInitialized(archiveId: string): Promise<void> {
    let state: RuntimeState;
    try {
      state = await this.#loadStateByArchiveId(archiveId, false);
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) {
        const receipt = await this.#readDeletionReceipt(archiveId);
        if (receipt !== undefined && receipt.auditCount > 0) return;
      }
      throw error;
    }
    if (state.metadata.auditInitialized) return;
    const original = state.metadata;
    state.metadata = freeze({ ...original, auditInitialized: true });
    try {
      await this.#persistSidecar(state);
    } catch (error: unknown) {
      state.metadata = original;
      throw error;
    }
  }

  async #hasAuthenticatedAuditAnchor(archiveId: string): Promise<boolean> {
    const known = [...this.#states.values()].find((state) => state.archiveId === archiveId);
    if (known !== undefined) {
      await known.initialize;
      if (known.metadata.auditInitialized) return true;
    } else {
      try {
        const state = await this.#loadStateByArchiveId(archiveId, false);
        if (state.metadata.auditInitialized) return true;
      } catch (error: unknown) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    const receipt = await this.#readDeletionReceipt(archiveId);
    return receipt !== undefined && receipt.auditCount > 0;
  }

  async #ensurePendingCommitAuditAnchor(state: RuntimeState): Promise<void> {
    const verified = await this.#requireValidAudit(state.archiveId);
    if (verified.count === 0) throw new Error("Pending lifecycle commit has no durable audit");
    if (!state.metadata.auditInitialized) {
      // Journal/head durability can precede the encrypted sidecar marker by
      // one crash window. Re-establish that authenticated anchor first, then
      // reverify the chain before any pending state becomes effective.
      await this.#markAuditInitialized(state.archiveId);
    }
    if (!state.metadata.auditInitialized) {
      throw new Error("Pending lifecycle commit lacks an authenticated audit anchor");
    }
    const reverified = await this.#requireValidAudit(state.archiveId);
    if (reverified.count === 0) throw new Error("Pending lifecycle commit has no durable audit");
  }

  async #appendContentFreeAudit(
    archiveId: string,
    input: AuditAppendInput,
  ): Promise<ContentFreeAuditEntry> {
    const previous = await this.#requireValidAudit(archiveId);
    if (previous.count >= MAX_CONTENT_FREE_AUDIT_ENTRIES) {
      throw new Error("Evidence audit journal entry capacity is exhausted");
    }
    const count = previous.count + 1;
    if (!Number.isSafeInteger(count)) throw new Error("Evidence audit count exceeds a safe integer");
    const entryWithoutAuditIdAndHead = {
      action: input.action,
      outcome: input.outcome,
      role: input.role,
      actorIdHmac: input.actorIdHmac,
      requestHmac: input.requestHmac,
      responseSha256: input.responseSha256,
      timestampMs: checkedEpochMs(input.timestampMs, "evidence audit clock"),
      priorHeadSha256: previous.headSha256,
      count,
    } satisfies Omit<ContentFreeAuditEntry, "auditId" | "headSha256">;
    const auditId = this.#auditIdForEntry(archiveId, entryWithoutAuditIdAndHead);
    const entryWithoutHead = {
      ...entryWithoutAuditIdAndHead,
      auditId,
    } satisfies Omit<ContentFreeAuditEntry, "headSha256">;
    const entry = freeze({
      ...entryWithoutHead,
      headSha256: this.#auditHeadSha256(archiveId, entryWithoutHead),
    });
    const journalPath = this.#auditJournalPath(archiveId);
    if (await this.#pathExists(journalPath)) await this.#assertManagedFile(journalPath);
    const encryptedEntry = encryptBlob(
      this.#auditEntryKey,
      archiveId,
      count,
      "content_free_audit_entry",
      plainText(entry),
    );
    const serializedEntry = JSON.stringify(encryptedEntry) + "\n";
    try {
      // The artifact lifecycle lock serializes all audit appends. Recheck the
      // authenticated head and physical journal size immediately before the
      // write so a stale in-memory cursor can never overrun either bound.
      const headPath = this.#auditHeadPath(archiveId);
      const journalExists = await this.#pathExists(journalPath);
      const headExists = await this.#pathExists(headPath);
      if (previous.count === 0) {
        if (journalExists || headExists) {
          throw new Error("Evidence audit append cursor is stale");
        }
      } else {
        if (!journalExists || !headExists) {
          throw new Error("Evidence audit append cursor is stale");
        }
        const onDisk = await this.#readContentFreeAuditHead(archiveId);
        if (onDisk.count !== previous.count || onDisk.headSha256 !== previous.headSha256) {
          throw new Error("Evidence audit append cursor is stale");
        }
      }
      const currentBytes = journalExists
        ? (await this.#auditJournalSnapshot(archiveId)).size
        : 0;
      const appendedBytes = Buffer.byteLength(serializedEntry, "utf8");
      if (
        count > MAX_CONTENT_FREE_AUDIT_ENTRIES ||
        serializedEntry.length === 0 ||
        appendedBytes > MAX_CONTENT_FREE_AUDIT_LINE_BYTES + 1 ||
        currentBytes > MAX_CONTENT_FREE_AUDIT_BYTES - appendedBytes
      ) {
        throw new Error("Evidence audit journal capacity is exhausted");
      }
      await appendFile(journalPath, serializedEntry, { encoding: "utf8", mode: 0o600 });
      await this.#assertManagedFile(journalPath);
      await this.#syncFile(journalPath);
      await this.#syncDirectory(this.#receiptDirectory);
      await this.#writeContentFreeAuditHead(archiveId, {
        count,
        headSha256: entry.headSha256,
      });
      await this.#verifyContentFreeAuditFilesPrivate(archiveId);
      await this.#cacheVerifiedAuditHead(archiveId, { count, headSha256: entry.headSha256 });
      await this.#markAuditInitialized(archiveId);
      return entry;
    } catch (error: unknown) {
      // A journal fsync can succeed while the head write fails. Drop the
      // cache so the next locked admission performs the bounded one-tail
      // recovery path instead of trusting the old in-memory head.
      this.#verifiedAuditHeads.delete(archiveId);
      throw error;
    }
  }

  async #appendCommandAuditOnce(
    archiveId: string,
    input: AuditAppendInput,
  ): Promise<ContentFreeAuditEntry> {
    const head = await this.#requireValidAudit(archiveId);
    if (head.count > 0) {
      const existing = await this.#findMatchingCommandAudit(archiveId, input);
      if (existing !== undefined) {
        await this.#markAuditInitialized(archiveId);
        return existing;
      }
    }
    return this.#appendContentFreeAudit(archiveId, input);
  }

  async #findMatchingCommandAudit(
    archiveId: string,
    input: Omit<AuditAppendInput, "timestampMs">,
  ): Promise<ContentFreeAuditEntry | undefined> {
    for await (const entry of this.#iterateContentFreeAuditEntries(archiveId)) {
      if (
        entry.action === input.action &&
        entry.outcome === input.outcome &&
        entry.role === input.role &&
        entry.actorIdHmac === input.actorIdHmac &&
        entry.requestHmac === input.requestHmac &&
        entry.responseSha256 === input.responseSha256
      ) {
        return entry;
      }
    }
    return undefined;
  }

  #reviewAuditAction(request: EvidenceReviewRequest): EvidenceAuditAction {
    if (request.kind === "metadata_page") return "review_metadata_page";
    if (request.kind === "audio_window") return "review_audio_window";
    return "retention_view";
  }

  #reviewAuditSelection(request: EvidenceReviewRequest): unknown {
    if (request.kind === "metadata_page") {
      return freeze({
        kind: "metadata_page" as const,
        pageSize: request.pageSize ?? null,
        cursorHmac: request.cursor === undefined
          ? null
          : opaqueHmac(
            this.#auditAuthenticationKey,
            "content-free-audit-review-cursor",
            request.cursor,
          ),
      });
    }
    if (request.kind === "retention_summary") {
      return freeze({ kind: "retention_summary" as const });
    }
    return freeze({
      kind: "audio_window" as const,
      track: request.track,
      startOffsetMs: request.startOffsetMs,
      durationMs: request.durationMs,
    });
  }

  #reviewActorMatchesGrant(request: EvidenceReviewRequest, grant: EvidenceReviewGrant): boolean {
    const actor = request.actor;
    if (actor.role === "retention_owner") return actor.actorId === grant.dataOwnerId;
    if (actor.role === "evidence_reviewer") return actor.actorId === grant.bilingualReviewerId;
    return false;
  }

  #dataOwnerIdHmac(archiveId: string, dataOwnerId: string): string {
    return opaqueHmac(
      this.#archiveIdKey,
      "frozen-governance-data-owner:" + checkedArchiveId(archiveId),
      checkedCanonicalReviewIdentity(dataOwnerId, "dataOwnerId"),
    );
  }

  async #appendReviewAudit(
    archiveId: string,
    request: EvidenceReviewRequest,
    outcome: Extract<EvidenceAuditOutcome, "completed" | "grant_denied" | "integrity_failed" | "not_sealed" | "expired">,
    responseSha256: string,
  ): Promise<ContentFreeAuditEntry> {
    const actor = request.actor;
    if (
      (actor.role !== "retention_owner" && actor.role !== "evidence_reviewer") ||
      typeof actor.actorId !== "string" ||
      actor.actorId.length === 0 ||
      !isSha256(responseSha256)
    ) {
      throw new Error("Evidence review audit input is invalid");
    }
    const action = this.#reviewAuditAction(request);
    return this.#appendContentFreeAudit(archiveId, {
      action,
      outcome,
      role: actor.role,
      actorIdHmac: this.#auditActorIdHmac(actor.role, actor.actorId),
      requestHmac: this.#auditRequestHmac(action, this.#reviewAuditSelection(request)),
      responseSha256,
      timestampMs: this.#now(),
    });
  }

  async #reviewUnavailableResult(
    archiveId: string,
    request: EvidenceReviewRequest,
    status: Extract<
      EvidenceAuditOutcome,
      "expired" | "grant_denied" | "integrity_failed" | "not_sealed"
    >,
  ): Promise<EvidenceReviewLeaseResult> {
    try {
      await this.#appendReviewAudit(archiveId, request, status, evidenceSha256({ status }));
      return freeze({ status });
    } catch {
      if (status === "grant_denied") return freeze({ status });
      return freeze({ status: "audit_failed" as const });
    }
  }

  async #appendOwnerDeletionAudit(
    archiveId: string,
    request: EvidenceDeleteRequest,
    outcome: Extract<EvidenceAuditOutcome, "completed" | "conflict" | "not_found" | "pending" | "rejected">,
  ): Promise<ContentFreeAuditEntry> {
    const action: EvidenceAuditAction = "deletion";
    return this.#appendCommandAuditOnce(archiveId, {
      action,
      outcome,
      role: "retention_owner",
      actorIdHmac: this.#auditActorIdHmac("retention_owner", request.authority.actorId),
      requestHmac: this.#auditRequestHmac(action, {
        commandIdHmac: opaqueHmac(this.#auditAuthenticationKey, "content-free-audit-delete-command", request.commandId),
        reasonHmac: opaqueHmac(this.#auditAuthenticationKey, "content-free-audit-delete-reason", request.reason),
      }),
      responseSha256: evidenceSha256({ status: outcome }),
      timestampMs: this.#now(),
    });
  }

  async #appendDeletionCompletionAudit(receipt: DeletionReceipt): Promise<ContentFreeAuditEntry> {
    const action: EvidenceAuditAction = "deletion";
    const role: EvidenceAuditRole = receipt.disposition === "scheduled"
      ? "retention_system"
      : "retention_owner";
    return this.#appendCommandAuditOnce(receipt.archiveId, {
      action,
      outcome: "completed",
      role,
      // Raw owner identity has been cryptographically erased with the
      // sidecar. Use a purpose-separated synthetic completion actor instead
      // of copying a prior HMAC under the wrong domain.
      actorIdHmac: this.#auditActorIdHmac(role, "evidence-deletion-completion"),
      requestHmac: opaqueHmac(
        this.#auditAuthenticationKey,
        "content-free-audit-delete-completion-request",
        receipt.requestHmac,
      ),
      responseSha256: evidenceSha256({
        status: "completed",
        deletionReceiptId: receipt.deletionReceiptId,
      }),
      timestampMs: this.#now(),
    });
  }

  async #appendRetentionExtensionAudit(
    archiveId: string,
    request: RetentionExtensionRequest,
    outcome: Extract<EvidenceAuditOutcome, "completed" | "conflict" | "rejected">,
    result: RetentionExtensionResult,
  ): Promise<ContentFreeAuditEntry> {
    const action: EvidenceAuditAction = "retention_extension";
    return this.#appendCommandAuditOnce(archiveId, {
      action,
      outcome,
      role: "retention_owner",
      actorIdHmac: this.#retentionExtensionAuditActorHmac(request),
      requestHmac: this.#retentionExtensionAuditRequestHmac(request),
      responseSha256: evidenceSha256(result),
      timestampMs: this.#now(),
    });
  }

  #retentionExtensionAuditActorHmac(request: RetentionExtensionRequest): string {
    return this.#auditActorIdHmac("retention_owner", request.authority.actorId);
  }

  #retentionExtensionAuditRequestHmac(request: RetentionExtensionRequest): string {
    return this.#auditRequestHmac("retention_extension", {
      commandIdHmac: opaqueHmac(
        this.#auditAuthenticationKey,
        "content-free-audit-extension-command",
        request.commandId,
      ),
      reasonHmac: opaqueHmac(
        this.#auditAuthenticationKey,
        "content-free-audit-extension-reason",
        request.reason,
      ),
      requestedDeadlineAtMs: request.requestedDeadlineAtMs,
    });
  }

  #pendingRetentionExtensionAuditRequestHmac(
    commandIdHmac: string,
    requestHmac: string,
    ownerIdHmac: string,
    reasonHmac: string,
    requestedDeadlineAtMs: number,
  ): string {
    return this.#auditRequestHmac("retention_extension", {
      commandIdHmac,
      requestHmac,
      ownerIdHmac,
      reasonHmac,
      requestedDeadlineAtMs,
    });
  }

  async #appendPendingRetentionExtensionAudit(
    archiveId: string,
    pending: PendingRetentionExtension,
  ): Promise<ContentFreeAuditEntry> {
    return this.#appendCommandAuditOnce(archiveId, {
      action: "retention_extension",
      outcome: "completed",
      role: "retention_owner",
      actorIdHmac: pending.auditActorIdHmac,
      requestHmac: pending.auditRequestHmac,
      responseSha256: evidenceSha256(pending.result),
      timestampMs: pending.decidedAtMs,
    });
  }

  async #auditedRetentionExtensionResult(
    archiveId: string,
    request: RetentionExtensionRequest,
    result: RetentionExtensionResult,
  ): Promise<RetentionExtensionResult> {
    const outcome: Extract<EvidenceAuditOutcome, "completed" | "conflict" | "rejected"> =
      result.status === "extended" ? "completed" : result.status === "conflict" ? "conflict" : "rejected";
    try {
      await this.#appendRetentionExtensionAudit(archiveId, request, outcome, result);
      return result;
    } catch {
      // Extension is fail-closed: a caller does not receive an approval until
      // the content-free audit has crossed its own durability boundary.
      return freeze({ status: "rejected" as const });
    }
  }

  async #commitPendingRetentionExtension(
    state: RuntimeState,
    pending: PendingRetentionExtension,
    audit: ContentFreeAuditEntry,
  ): Promise<RetentionExtensionResult> {
    await this.#ensurePendingCommitAuditAnchor(state);
    const retention = state.metadata.retention;
    if (
      state.metadata.pendingRetentionExtension !== pending ||
      state.metadata.phase !== "sealed" ||
      retention === undefined ||
      retention.extensionUsed ||
      pending.requestedDeadlineAtMs <= retention.retentionDeadlineAtMs ||
      pending.requestedDeadlineAtMs > retention.finalizedAtMs + MAX_RETENTION_MS
    ) {
      throw new Error("Pending retention extension no longer matches artifact state");
    }
    const pendingMetadata = state.metadata;
    const { pendingRetentionExtension: _pending, ...withoutPending } = pendingMetadata;
    const commandEntry: StoredCommandResult = freeze({
      commandIdHmac: pending.commandIdHmac,
      requestHmac: pending.requestHmac,
      operation: "extend" as const,
      result: pending.result,
    });
    state.metadata = freeze({
      ...withoutPending,
      retention: freeze({
        ...retention,
        retentionDeadlineAtMs: pending.requestedDeadlineAtMs,
        extensionUsed: true,
      }),
      extensionApproval: freeze({
        commandIdHmac: pending.commandIdHmac,
        ownerIdHmac: pending.ownerIdHmac,
        reasonHmac: pending.reasonHmac,
        approvedAtMs: audit.timestampMs,
        requestedDeadlineAtMs: pending.requestedDeadlineAtMs,
      }),
      commands: Object.freeze([...withoutPending.commands, commandEntry]),
    });
    try {
      await this.#persistSidecar(state);
      return pending.result;
    } catch (error: unknown) {
      state.metadata = pendingMetadata;
      throw error;
    }
  }

  async #recoverPendingRetentionExtension(state: RuntimeState): Promise<void> {
    const pending = state.metadata.pendingRetentionExtension;
    if (pending === undefined) return;
    await this.#requireValidAudit(state.archiveId);
    const audit = await this.#findMatchingCommandAudit(state.archiveId, {
      action: "retention_extension",
      outcome: "completed",
      role: "retention_owner",
      actorIdHmac: pending.auditActorIdHmac,
      requestHmac: pending.auditRequestHmac,
      responseSha256: evidenceSha256(pending.result),
    });
    if (audit !== undefined) {
      await this.#commitPendingRetentionExtension(state, pending, audit);
      return;
    }
    const original = state.metadata;
    const { pendingRetentionExtension: _pending, ...withoutPending } = original;
    state.metadata = freeze(withoutPending);
    try {
      await this.#persistSidecar(state);
    } catch (error: unknown) {
      state.metadata = original;
      throw error;
    }
  }

  async #appendOwnerExportAudit(
    archiveId: string,
    request: ManagedEvidenceExportLeaseRequest,
    outcome: Extract<EvidenceAuditOutcome, "completed" | "conflict" | "expired">,
    responseSha256: string,
  ): Promise<ContentFreeAuditEntry> {
    const action: EvidenceAuditAction = "owner_export";
    const commandIdHmac = opaqueHmac(this.#archiveIdKey, "command-id", request.commandId);
    const requestHmac = commandFingerprint(this.#archiveIdKey, "export_lease", {
      archiveId,
      commandId: request.commandId,
      ownerId: request.authority.actorId,
    });
    const ownerIdHmac = opaqueHmac(
      this.#archiveIdKey,
      "managed-export-owner-id",
      request.authority.actorId,
    );
    return this.#appendCommandAuditOnce(archiveId, {
      action,
      outcome,
      role: "retention_owner",
      actorIdHmac: this.#auditActorIdHmac("retention_owner", request.authority.actorId),
      requestHmac: this.#managedExportAuditRequestHmac(commandIdHmac, requestHmac, ownerIdHmac),
      responseSha256,
      timestampMs: this.#now(),
    });
  }

  #managedExportAuditRequestHmac(
    commandIdHmac: string,
    requestHmac: string,
    ownerIdHmac: string,
  ): string {
    return this.#auditRequestHmac("owner_export", {
      commandIdHmac,
      requestHmac,
      ownerIdHmac,
    });
  }

  async #auditedOwnerExportUnavailableResult(
    archiveId: string,
    request: ManagedEvidenceExportLeaseRequest,
    status: "conflict" | "expired",
  ): Promise<Readonly<{ readonly status: "audit_failed" | "conflict" | "expired" }>> {
    try {
      await this.#appendOwnerExportAudit(
        archiveId,
        request,
        status,
        evidenceSha256({ status }),
      );
      return freeze({ status });
    } catch {
      return freeze({ status: "audit_failed" as const });
    }
  }

  #sweepHealthPath(): string {
    return join(this.#receiptDirectory, "retention-sweep-health.json");
  }

  #zeroizeAndForgetState(archiveId: string): void {
    this.#verifiedAuditHeads.delete(archiveId);
    for (const state of this.#states.values()) {
      if (state.archiveId !== archiveId) continue;
      state.closed = true;
      state.deleting = true;
      this.#scheduleStateEviction(state);
      return;
    }
  }

  #evictTerminalState(state: RuntimeState): void {
    if (state.metadata.phase === "active") return;
    this.#scheduleStateEviction(state);
  }

  #scheduleStateEviction(state: RuntimeState): void {
    if (state.evictionScheduled) return;
    state.evictionScheduled = true;
    void state.tail.finally(() => {
      state.evictionScheduled = false;
      this.#evictState(state);
    }).catch(() => undefined);
  }

  #evictState(state: RuntimeState): void {
    if (this.#states.get(state.sessionId) !== state) return;
    state.dek.fill(0);
    state.closed = true;
    this.#states.delete(state.sessionId);
  }

  #isRetentionExpired(metadata: SessionArtifactMetadata): boolean {
    const retention = metadata.retention;
    return retention !== undefined && checkedEpochMs(this.#now(), "retention clock") >= retention.retentionDeadlineAtMs;
  }

  #stateForSession(sessionId: string): RuntimeState {
    const archiveId = this.#archiveIdForSession(sessionId);
    const configuredDataOwnerId = this.#configuredDataOwnerId;
    if (configuredDataOwnerId === undefined) {
      throw new Error("A configured data owner is required to create an evidence artifact");
    }
    const dataOwnerIdHmac = this.#dataOwnerIdHmac(archiveId, configuredDataOwnerId);
    const existing = this.#states.get(sessionId);
    if (existing !== undefined) {
      if (existing.metadata.dataOwnerIdHmac !== dataOwnerIdHmac) {
        throw new Error("Configured data owner does not match the frozen governance owner");
      }
      return existing;
    }
    const state: RuntimeState = {
      sessionId,
      archiveId,
      dek: randomBytes(32),
      metadata: freeze({
        schemaVersion: FORMAT_VERSION,
        archiveId,
        sessionId,
        createdAtMs: this.#now(),
        dataOwnerIdHmac,
        phase: "active",
        rebuildAttempted: false,
        auditInitialized: false,
        commands: [],
      }),
      pending: 0,
      pendingBytes: 0,
      recordCount: 0,
      serializedRecordBytes: 0,
      audioBytes: 0,
      audioOriginTimelineAtMonoMs: undefined,
      audioLastTimelineAtMonoMs: undefined,
      recordsSinceFreeSpaceCheck: 0,
      chainSha256: EMPTY_CHAIN_SHA256,
      closed: false,
      deleting: false,
      terminalFenceWaiters: new Set(),
      evictionScheduled: false,
      initialize: Promise.resolve(),
      tail: Promise.resolve(),
    };
    state.initialize = this.#initializeState(state);
    this.#states.set(sessionId, state);
    return state;
  }

  async #loadStateByArchiveId(
    archiveId: string,
    restoreActiveAppendCursor = true,
  ): Promise<RuntimeState> {
    const known = [...this.#states.values()].find((state) => state.archiveId === archiveId);
    if (known !== undefined) {
      await known.initialize;
      return known;
    }
    await this.#ensureRoots();
    const sidecar = await this.#readSidecar(archiveId);
    const unwrappedDek = decryptBlob(
      this.#wrappingKey,
      archiveId,
      0,
      "wrapped_dek",
      sidecar.wrappedDek,
    );
    let state: RuntimeState | undefined;
    try {
      if (unwrappedDek.byteLength !== 32) throw new Error("Wrapped session DEK has invalid length");
      const metadata = parseJson<SessionArtifactMetadata>(
        decryptBlob(this.#wrappingKey, archiveId, 1, "metadata", sidecar.metadata),
        "Session artifact metadata is corrupt",
      );
      this.#validateMetadata(archiveId, metadata, sidecar);
      state = {
        sessionId: metadata.sessionId,
        archiveId,
        dek: Buffer.from(unwrappedDek),
        metadata: freeze(metadata),
        pending: 0,
        pendingBytes: 0,
        recordCount: 0,
        serializedRecordBytes: 0,
        audioBytes: 0,
        audioOriginTimelineAtMonoMs: undefined,
        audioLastTimelineAtMonoMs: undefined,
        recordsSinceFreeSpaceCheck: 0,
        chainSha256: EMPTY_CHAIN_SHA256,
        closed: metadata.phase !== "active",
        deleting: metadata.phase === "deletion_pending",
        terminalFenceWaiters: new Set(),
        evictionScheduled: false,
        initialize: Promise.resolve(),
        tail: Promise.resolve(),
      };
      // Only an active writer needs a restored append cursor. Terminal and
      // finalizing states are verified by their dedicated lifecycle paths;
      // eagerly parsing a known-corrupt failed ledger would make its durable
      // retention/deletion audit impossible to read or erase.
      const activePath = this.#spoolPath(archiveId);
      if (restoreActiveAppendCursor && metadata.phase === "active" && await this.#pathExists(activePath)) {
        const { projection } = await this.#scanVerifiedRecordLedger(state, activePath, "reject");
        state.recordCount = projection.recordCount;
        state.serializedRecordBytes = projection.serializedRecordBytes;
        state.audioBytes = Object.values(projection.tracks)
          .reduce((total, track) => total + track.byteCount, 0);
        state.audioOriginTimelineAtMonoMs = projection.audioOriginTimelineAtMonoMs;
        state.audioLastTimelineAtMonoMs = projection.audioLastTimelineAtMonoMs;
        state.chainSha256 = projection.finalChainSha256;
      }
      this.#states.set(state.sessionId, state);
      return state;
    } catch (error: unknown) {
      // `Buffer.from(unwrappedDek)` is a distinct plaintext copy. If active
      // cursor restoration fails before the state becomes usable, wipe it
      // and remove the state if a future loading path registered it before
      // becoming usable.
      if (state !== undefined) {
        state.dek.fill(0);
        if (this.#states.get(state.sessionId) === state) this.#states.delete(state.sessionId);
      }
      throw error;
    } finally {
      unwrappedDek.fill(0);
    }
  }

  async #initializeState(state: RuntimeState): Promise<void> {
    try {
      await this.#ensureRoots();
      const existing = await this.#pathExists(this.#keyPath(state.archiveId));
      if (existing) {
        const sidecar = await this.#readSidecar(state.archiveId);
        const unwrappedDek = decryptBlob(this.#wrappingKey, state.archiveId, 0, "wrapped_dek", sidecar.wrappedDek);
        try {
          const metadata = parseJson<SessionArtifactMetadata>(
            decryptBlob(this.#wrappingKey, state.archiveId, 1, "metadata", sidecar.metadata),
            "Session artifact metadata is corrupt",
          );
          this.#validateMetadata(state.archiveId, metadata, sidecar);
          if (metadata.sessionId !== state.sessionId || unwrappedDek.byteLength !== 32) {
            throw new Error("Artifact archive identity collision");
          }
          state.dek.fill(0);
          state.dek.set(unwrappedDek);
          state.metadata = freeze(metadata);
          state.closed = metadata.phase !== "active";
          state.deleting = metadata.phase === "deletion_pending";
          const path = this.#spoolPath(state.archiveId);
          if (metadata.phase === "active" && await this.#pathExists(path)) {
            const { projection } = await this.#scanVerifiedRecordLedger(state, path, "reject");
            state.recordCount = projection.recordCount;
            state.serializedRecordBytes = projection.serializedRecordBytes;
            state.audioBytes = Object.values(projection.tracks)
              .reduce((total, track) => total + track.byteCount, 0);
            state.audioOriginTimelineAtMonoMs = projection.audioOriginTimelineAtMonoMs;
            state.audioLastTimelineAtMonoMs = projection.audioLastTimelineAtMonoMs;
            state.chainSha256 = projection.finalChainSha256;
          }
          return;
        } finally {
          unwrappedDek.fill(0);
        }
      }
      if (await this.#readDeletionReceipt(state.archiveId) !== undefined) {
        state.dek.fill(0);
        state.closed = true;
        throw new Error("A deleted session artifact cannot be recreated");
      }
      await this.#persistSidecar(state);
    } catch (error: unknown) {
      // Initialization owns the state registered by #stateForSession. On any
      // failure, a copied DEK must not stay cached in that abandoned state.
      state.dek.fill(0);
      state.closed = true;
      state.deleting = true;
      if (this.#states.get(state.sessionId) === state) this.#states.delete(state.sessionId);
      throw error;
    }
  }

  async #ensureRoots(): Promise<void> {
    const cached = this.#validatedRootScopes;
    if (cached !== undefined) {
      for (const snapshot of cached) {
        await this.#assertCachedSecurityRoot(snapshot);
      }
      if (process.platform === "win32") {
        const lease = this.#rootProcessLease;
        if (lease === undefined || this.#windowsAclVerificationLeaseId !== lease.lockId) {
          this.#onWindowsSecurityRootAclOperation?.("verify");
          await verifyWindowsSecurityRoots(
            cached.map((snapshot) => snapshot.configuredPath),
            this.#securityBoundaryDirectory,
            this.#strictAncestors,
          );
          if (lease !== undefined && this.#rootProcessLease === lease) {
            this.#windowsAclVerificationLeaseId = lease.lockId;
          }
        }
      }
      return;
    }
    const roots: readonly [SecurityRootName, string][] = [
      ["archive", this.#archiveDirectory],
      ["key", this.#keyDirectory],
      ["export", this.#exportDirectory],
      ["receipt", this.#receiptDirectory],
    ];
    const realRoots: [SecurityRootName, string][] = [];
    const snapshots: SecurityRootSnapshot[] = [];
    for (const [name, root] of roots) {
      // Check existing ancestors before mkdir so recursive creation never
      // follows an attacker-controlled parent symlink.
      await this.#assertRootAncestorsAreRealDirectories(root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const ancestors = await this.#assertRootAncestorsAreRealDirectories(root);
      let info = await lstat(root);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Artifact security root must be a real directory");
      }
      if (process.platform !== "win32") {
        if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
          throw new Error("Artifact security root must be owned by the service user on POSIX");
        }
        await chmod(root, 0o700);
        info = await lstat(root);
        if (
          info.isSymbolicLink() ||
          !info.isDirectory() ||
          (info.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())
        ) {
          throw new Error("Artifact security root must be owner-only on POSIX");
        }
      } else {
        this.#onWindowsSecurityRootAclOperation?.("harden");
        await hardenWindowsSecurityRoot(root, this.#securityBoundaryDirectory, this.#strictAncestors);
      }
      const resolvedRoot = await realpath(root);
      realRoots.push([name, resolvedRoot]);
      snapshots.push(freeze({
        name,
        configuredPath: root,
        realPath: resolvedRoot,
        device: String(info.dev),
        inode: String(info.ino),
        ancestors,
      }));
    }
    for (const [leftName, left] of realRoots) {
      for (const [rightName, right] of realRoots) {
        if (leftName === rightName) continue;
        if (isNestedOrEqual(left, right)) {
          throw new Error("Artifact real security roots must be distinct and non-nested");
        }
      }
    }
    this.#validatedRootScopes = Object.freeze(snapshots);
  }

  async #assertCachedSecurityRoot(snapshot: SecurityRootSnapshot): Promise<void> {
    const ancestors = await this.#assertRootAncestorsAreRealDirectories(snapshot.configuredPath);
    if (canonicalEvidenceJson(ancestors) !== canonicalEvidenceJson(snapshot.ancestors)) {
      throw new Error("Artifact security root ancestors changed after validation");
    }
    const info = await lstat(snapshot.configuredPath);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      String(info.dev) !== snapshot.device ||
      String(info.ino) !== snapshot.inode ||
      await realpath(snapshot.configuredPath) !== snapshot.realPath
    ) {
      throw new Error("Artifact security root changed after validation");
    }
    if (process.platform !== "win32" &&
      (
        (info.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && info.uid !== process.getuid())
      )
    ) {
      throw new Error("Artifact security root must remain owner-only on POSIX");
    }
  }

  /**
   * `lstat(root)` follows symlinked parents. Reject every ancestor link before
   * using a configured root, so two lexical roots cannot secretly share a
   * security scope through an intermediate symlink or junction.
   */
  async #assertRootAncestorsAreRealDirectories(
    root: string,
  ): Promise<readonly SecurityRootAncestorSnapshot[]> {
    const configuredRoot = resolve(root);
    const ancestors: string[] = [];
    for (let current = configuredRoot; ; current = dirname(current)) {
      ancestors.push(current);
      if (dirname(current) === current) break;
    }
    const snapshots: SecurityRootAncestorSnapshot[] = [];
    for (const ancestor of ancestors.reverse()) {
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(ancestor);
      } catch (error: unknown) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("Artifact security root has a symbolic-link or non-directory ancestor");
      }
      if (
        process.platform !== "win32" &&
        ancestor !== configuredRoot &&
        (info.mode & 0o022) !== 0 &&
        (info.mode & 0o1000) === 0
      ) {
        throw new Error("Artifact security root has a writable non-sticky ancestor");
      }
      snapshots.push(freeze({
        configuredPath: ancestor,
        realPath: await realpath(ancestor),
        device: String(info.dev),
        inode: String(info.ino),
      }));
    }
    return Object.freeze(snapshots);
  }

  async #pathExists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  async #assertManagedFile(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error("Managed artifact path is not a regular file");
    }
  }

  async #syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, process.platform === "win32" ? "r+" : "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #syncFile(path: string): Promise<void> {
    await this.#assertManagedFile(path);
    const handle = await open(path, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #sha256File(path: string, abortSignal?: AbortSignal): Promise<string> {
    await this.#assertManagedFile(path);
    const digest = createHash("sha256");
    const input = createReadStream(path, { highWaterMark: ARCHIVE_STREAM_CHUNK_BYTES });
    try {
      for await (const chunk of input) {
        if (abortSignal?.aborted) {
          const error = new Error("Evidence finalization was cancelled while hashing its archive");
          error.name = "AbortError";
          throw error;
        }
        digest.update(chunk);
      }
      if (abortSignal?.aborted) {
        const error = new Error("Evidence finalization was cancelled while hashing its archive");
        error.name = "AbortError";
        throw error;
      }
      return digest.digest("hex");
    } finally {
      input.destroy();
    }
  }

  async #writeAtomic(
    path: string,
    source: AtomicWriteSource,
    commitFence?: () => void,
  ): Promise<void> {
    const directory = dirname(path);
    const temporary = path + "." + randomBytes(12).toString("hex") + ".tmp";
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let createdTemporary = false;
    let renamed = false;
    try {
      handle = await open(temporary, "wx", 0o600);
      createdTemporary = true;
      const write = async (contents: AtomicWriteContents): Promise<void> => {
        if (handle === undefined) throw new Error("Atomic artifact writer is closed");
        await handle.writeFile(contents);
      };
      if (typeof source === "function") {
        await source(write);
      } else {
        await write(source);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      commitFence?.();
      await rename(temporary, path);
      renamed = true;
      commitFence?.();
      await this.#syncDirectory(directory);
      commitFence?.();
    } finally {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        if (createdTemporary && !renamed) {
          await this.#safeRemoveFile(temporary).catch(() => undefined);
        }
      }
    }
  }

  /**
   * Reads UTF-8 JSONL without allowing `readline` to accumulate an unbounded
   * logical line. The byte cap is checked before a completed line is decoded
   * or parsed, and the pending suffix never grows beyond that cap.
   */
  async *#iterateBoundedUtf8Lines(
    path: string,
    maximumLineBytes: number,
    oversizedLineMessage: string,
  ): AsyncGenerator<string> {
    const input = createReadStream(path, { highWaterMark: ARCHIVE_STREAM_CHUNK_BYTES });
    let pending = Buffer.alloc(0);
    try {
      for await (const rawChunk of input) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        let offset = 0;
        while (offset < chunk.byteLength) {
          const newline = chunk.indexOf(0x0a, offset);
          if (newline === -1) {
            const suffix = chunk.subarray(offset);
            if (pending.byteLength + suffix.byteLength > maximumLineBytes) {
              throw new Error(oversizedLineMessage);
            }
            pending = pending.byteLength === 0
              ? Buffer.from(suffix)
              : Buffer.concat([pending, suffix]);
            break;
          }
          const fragment = chunk.subarray(offset, newline);
          if (pending.byteLength + fragment.byteLength > maximumLineBytes) {
            throw new Error(oversizedLineMessage);
          }
          let line = pending.byteLength === 0
            ? fragment
            : Buffer.concat([pending, fragment]);
          pending = Buffer.alloc(0);
          if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
            line = line.subarray(0, line.byteLength - 1);
          }
          yield line.toString("utf8");
          offset = newline + 1;
        }
      }
      if (pending.byteLength > 0) {
        let line = pending;
        if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) {
          line = line.subarray(0, line.byteLength - 1);
        }
        yield line.toString("utf8");
      }
    } finally {
      input.destroy();
    }
  }

  async #readSidecar(archiveId: string): Promise<SidecarFile> {
    const path = this.#keyPath(archiveId);
    const file = await this.#readBoundedManagedFile(
      path,
      MAX_SESSION_SIDECAR_BYTES,
      "Session key sidecar",
    );
    if (file === undefined) {
      const missing = new Error("Session key sidecar is missing") as NodeJS.ErrnoException;
      missing.code = "ENOENT";
      throw missing;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.contents.toString("utf8"));
    } catch {
      throw new Error("Session key sidecar is corrupt");
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new Error("Session key sidecar is corrupt");
    }
    const sidecar = parsed as Partial<SidecarFile>;
    if (
      sidecar.schemaVersion !== FORMAT_VERSION ||
      sidecar.kind !== "wrapped_session_dek" ||
      sidecar.archiveId !== archiveId ||
      sidecar.wrappedDek === undefined ||
      sidecar.metadata === undefined
    ) {
      throw new Error("Session key sidecar has invalid identity");
    }
    return sidecar as SidecarFile;
  }

  #sidecarFor(state: RuntimeState): SidecarFile {
    const metadata = plainText(state.metadata);
    const wrappedDek = encryptBlob(this.#wrappingKey, state.archiveId, 0, "wrapped_dek", state.dek);
    const encryptedMetadata = encryptBlob(
      this.#wrappingKey,
      state.archiveId,
      1,
      "metadata",
      metadata,
    );
    const retention = state.metadata.retention;
    return freeze({
      schemaVersion: FORMAT_VERSION,
      kind: "wrapped_session_dek",
      archiveId: state.archiveId,
      wrappedDek,
      metadata: encryptedMetadata,
      ...(retention === undefined
        ? {}
        : {
          finalizedAtMonoMs: retention.finalizedAtMonoMs,
          finalizedAtMs: retention.finalizedAtMs,
          retentionDeadlineAtMs: retention.retentionDeadlineAtMs,
        }),
    });
  }

  async #persistSidecar(state: RuntimeState, commitFence?: () => void): Promise<void> {
    await this.#ensureRoots();
    const sidecar = this.#sidecarFor(state);
    await this.#writeAtomic(
      this.#keyPath(state.archiveId),
      JSON.stringify(sidecar) + "\n",
      commitFence,
    );
  }

  #validateMetadata(archiveId: string, metadata: SessionArtifactMetadata, sidecar: SidecarFile): void {
    let canonicalSessionId = false;
    try {
      canonicalSessionId = checkedSessionId(metadata.sessionId) === metadata.sessionId &&
        this.#archiveIdForSession(metadata.sessionId) === archiveId;
    } catch {
      canonicalSessionId = false;
    }
    if (
      metadata.schemaVersion !== FORMAT_VERSION ||
      metadata.archiveId !== archiveId ||
      !canonicalSessionId ||
      !Number.isFinite(metadata.createdAtMs) ||
      !isSha256(metadata.dataOwnerIdHmac) ||
      typeof metadata.auditInitialized !== "boolean" ||
      !Array.isArray(metadata.commands) ||
      metadata.commands.length > MAX_STORED_COMMAND_RESULTS ||
      !["active", "finalizing", "sealed", "FINALIZATION_FAILED", "deletion_pending"].includes(metadata.phase)
    ) {
      throw new Error("Session artifact metadata has invalid fields");
    }
    const retention = metadata.retention;
    if (retention !== undefined) {
      if (
        !Number.isFinite(retention.finalizedAtMonoMs) ||
        !Number.isSafeInteger(retention.finalizedAtMs) ||
        !Number.isFinite(retention.initialRetentionDeadlineAtMs) ||
        !Number.isFinite(retention.retentionDeadlineAtMs) ||
        retention.initialRetentionDeadlineAtMs < retention.finalizedAtMs ||
        retention.retentionDeadlineAtMs < retention.initialRetentionDeadlineAtMs ||
        retention.retentionDeadlineAtMs > retention.finalizedAtMs + MAX_RETENTION_MS ||
        typeof retention.extensionUsed !== "boolean" ||
        sidecar.finalizedAtMonoMs !== retention.finalizedAtMonoMs ||
        sidecar.finalizedAtMs !== retention.finalizedAtMs ||
        sidecar.retentionDeadlineAtMs !== retention.retentionDeadlineAtMs
      ) {
        throw new Error("Session artifact retention metadata is invalid");
      }
    } else if (
      sidecar.finalizedAtMonoMs !== undefined ||
      sidecar.finalizedAtMs !== undefined ||
      sidecar.retentionDeadlineAtMs !== undefined
    ) {
      throw new Error("Session key sidecar retention projection is invalid");
    }
    const extensionApproval = metadata.extensionApproval;
    const pendingExtension = metadata.pendingRetentionExtension;
    if (
      pendingExtension !== undefined &&
      (
        metadata.phase !== "sealed" ||
        retention === undefined ||
        retention.extensionUsed ||
        extensionApproval !== undefined ||
        !isSha256(pendingExtension.commandIdHmac) ||
        !isSha256(pendingExtension.requestHmac) ||
        !isSha256(pendingExtension.ownerIdHmac) ||
        !isSha256(pendingExtension.reasonHmac) ||
        !isSha256(pendingExtension.auditActorIdHmac) ||
        !isSha256(pendingExtension.auditRequestHmac) ||
        pendingExtension.auditRequestHmac !== this.#pendingRetentionExtensionAuditRequestHmac(
          pendingExtension.commandIdHmac,
          pendingExtension.requestHmac,
          pendingExtension.ownerIdHmac,
          pendingExtension.reasonHmac,
          pendingExtension.requestedDeadlineAtMs,
        ) ||
        !isNonNegativeSafeInteger(pendingExtension.decidedAtMs) ||
        !isNonNegativeSafeInteger(pendingExtension.requestedDeadlineAtMs) ||
        pendingExtension.requestedDeadlineAtMs <= retention.retentionDeadlineAtMs ||
        pendingExtension.requestedDeadlineAtMs > retention.finalizedAtMs + MAX_RETENTION_MS ||
        pendingExtension.result.status !== "extended" ||
        pendingExtension.result.retentionDeadlineAtMs !== pendingExtension.requestedDeadlineAtMs ||
        pendingExtension.result.extensionUsed !== true
      )
    ) {
      throw new Error("Session artifact pending retention extension is invalid");
    }
    if (
      (retention === undefined && extensionApproval !== undefined) ||
      (retention !== undefined && retention.extensionUsed !== (extensionApproval !== undefined))
    ) {
      throw new Error("Session artifact extension approval metadata is invalid");
    }
    if (
      extensionApproval !== undefined &&
      (
        !isSha256(extensionApproval.commandIdHmac) ||
        !isSha256(extensionApproval.ownerIdHmac) ||
        !isSha256(extensionApproval.reasonHmac) ||
        !isNonNegativeSafeInteger(extensionApproval.approvedAtMs) ||
        !isNonNegativeSafeInteger(extensionApproval.requestedDeadlineAtMs) ||
        retention === undefined ||
        extensionApproval.requestedDeadlineAtMs !== retention.retentionDeadlineAtMs
      )
    ) {
      throw new Error("Session artifact extension approval metadata is invalid");
    }
    if (metadata.phase === "FINALIZATION_FAILED") {
      if (
        retention === undefined ||
        !isFinalizationFailureCode(metadata.finalizationFailureCode) ||
        !isFinalizationFailureAuditSource(metadata.finalizationFailureAudit) ||
        !this.#hasVerifiedProcessingAuditProjection(metadata)
      ) {
        throw new Error("Failed finalization lacks a durable deletion audit projection");
      }
    } else if (
      metadata.finalizationFailureCode !== undefined ||
      metadata.finalizationFailureAudit !== undefined
    ) {
      throw new Error("Non-failed artifact has finalization failure audit metadata");
    }
    const managedExport = metadata.managedExport;
    if (managedExport !== undefined) {
      const pending = managedExport.status === "pending";
      const auditPending = managedExport.status === "audit_pending";
      const completed = managedExport.status === "completed";
      if (
        !isSha256(managedExport.exportId) ||
        !isSha256(managedExport.commandIdHmac) ||
        !isSha256(managedExport.requestHmac) ||
        !isSha256(managedExport.ownerIdHmac) ||
        !isSha256(managedExport.auditActorIdHmac) ||
        !isSha256(managedExport.auditRequestHmac) ||
        managedExport.auditRequestHmac !== this.#managedExportAuditRequestHmac(
          managedExport.commandIdHmac,
          managedExport.requestHmac,
          managedExport.ownerIdHmac,
        ) ||
        (!pending && !auditPending && !completed) ||
        (pending && (
          managedExport.manifestFileSha256 !== undefined ||
          managedExport.completedAtMs !== undefined ||
          managedExport.completionValue !== undefined
        )) ||
        ((auditPending || completed) && (
          !isSha256(managedExport.manifestFileSha256) ||
          !isNonNegativeSafeInteger(managedExport.completedAtMs) ||
          managedExport.completionValue === undefined ||
          !isBoundedJsonValue(managedExport.completionValue)
        ))
      ) {
        throw new Error("Session artifact managed export metadata is invalid");
      }
    }
  }

  #enqueuePersist(
    state: RuntimeState,
    reservedBytes: number,
    write: () => Promise<void>,
  ): Promise<void> {
    const operation = state.tail
      .then(async () => {
        if (state.failure !== undefined) throw state.failure;
        await write();
      })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error("Session artifact write failed");
        state.failure ??= failure;
        throw state.failure;
      });
    state.tail = operation.catch(() => undefined);
    // Keep the public persist/root-operation lifetime tied to the actual
    // filesystem write. Finalization may fail fast through the separate
    // terminal fence, but a root lease cannot be handed to another Store
    // while this underlying append can still mutate its spool.
    return operation.finally(async () => {
      state.pending -= 1;
      state.pendingBytes -= reservedBytes;
      if (
        state.terminalFenceError !== undefined &&
        await this.#readDeletionReceipt(state.archiveId) !== undefined
      ) {
        // A terminally fenced append may finish after deletion removed the
        // original spool. Clean any late directory entry before its root
        // operation releases the lease for handoff.
        await this.#safeRemoveFile(this.#spoolPath(state.archiveId));
        await this.#safeRemoveFile(this.#archivePath(state.archiveId));
        await this.#safeRemoveFile(this.#probePath(state.archiveId));
        await this.#removeDerivedTemporaryArtifacts(state.archiveId);
      }
    });
  }

  #fenceAbortedFinalization(state: RuntimeState): Error {
    const existing = state.terminalFenceError;
    if (existing !== undefined) return existing;
    const error = new Error("Evidence finalization was cancelled before pending recording completed");
    error.name = "AbortError";
    state.closed = true;
    state.terminalFenceError = error;
    for (const reject of state.terminalFenceWaiters) reject(error);
    state.terminalFenceWaiters.clear();
    return error;
  }

  async #raceWithTerminalFence<T>(state: RuntimeState, operation: Promise<T>): Promise<T> {
    if (state.terminalFenceError !== undefined) throw state.terminalFenceError;
    let rejectFence!: (error: Error) => void;
    const fence = new Promise<never>((_resolve, reject) => {
      rejectFence = reject;
    });
    state.terminalFenceWaiters.add(rejectFence);
    try {
      return await Promise.race([operation, fence]);
    } finally {
      state.terminalFenceWaiters.delete(rejectFence);
    }
  }

  async #stateTailWithTerminalFence(state: RuntimeState): Promise<void> {
    await this.#raceWithTerminalFence(state, state.tail);
  }

  async #awaitFinalizationTail(
    state: RuntimeState,
    request: EvidenceFinalizeRequest,
  ): Promise<void> {
    const signal = request.abortSignal;
    if (signal === undefined) {
      await this.#stateTailWithTerminalFence(state);
      return;
    }
    if (signal.aborted) throw this.#fenceAbortedFinalization(state);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.#fenceAbortedFinalization(state));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.#stateTailWithTerminalFence(state), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #appendArchiveEnvelope(
    state: RuntimeState,
    envelope: ArchiveEnvelope,
    purpose: ArchivePurpose,
  ): Promise<void> {
    if (purpose === "record" && state.terminalFenceError !== undefined) {
      throw state.terminalFenceError;
    }
    const line = this.#serializeArchiveEnvelope(state, envelope, purpose);
    const path = this.#spoolPath(state.archiveId);
    if (await this.#pathExists(path)) await this.#assertManagedFile(path);
    if (purpose === "record" && state.terminalFenceError !== undefined) {
      throw state.terminalFenceError;
    }
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
    await this.#assertManagedFile(path);
    await this.#syncFile(path);
    await this.#syncDirectory(this.#archiveDirectory);
  }

  #serializeArchiveEnvelope(
    state: RuntimeState,
    envelope: ArchiveEnvelope,
    purpose: ArchivePurpose,
  ): string {
    const index = envelope.kind === "record"
      ? envelope.index
      : envelope.kind === "finalization_manifest"
        ? state.recordCount
        : state.recordCount + 1;
    const serializableEnvelope = envelope.kind === "record"
      ? { ...envelope, record: encodeEvidenceRecordForArchive(envelope.record) }
      : envelope;
    const plaintext = plainText(serializableEnvelope);
    try {
      if (plaintext.byteLength > MAX_ARCHIVE_ENVELOPE_PLAINTEXT_BYTES) {
        throw new Error("Session artifact archive envelope plaintext exceeds its maximum");
      }
      const line = JSON.stringify(encryptBlob(state.dek, state.archiveId, index, purpose, plaintext)) + "\n";
      if (Buffer.byteLength(line, "utf8") > MAX_ARCHIVE_ENVELOPE_LINE_BYTES) {
        throw new Error("Session artifact archive line exceeds its maximum");
      }
      return line;
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * Decrypts a ledger line at a time. Callers that need a whole ledger may
   * collect this iterator, but export verification intentionally does not.
   */
  async *#iterateArchiveEnvelopes(
    state: RuntimeState,
    path: string,
    allowUnsealed: boolean,
  ): AsyncGenerator<ArchiveEnvelope> {
    await this.#assertManagedFile(path);
    let recordIndex = 0;
    let envelopeCount = 0;
    let sawEnvelope = false;
    for await (const line of this.#iterateBoundedUtf8Lines(
      path,
      MAX_ARCHIVE_ENVELOPE_LINE_BYTES,
      "Session artifact archive line exceeds its maximum",
    )) {
      // Preserve the existing newline-tolerant archive format, while never
      // treating a blank line as a record index.
      if (line.length === 0) continue;
      sawEnvelope = true;
      let blob: unknown;
      try {
        blob = JSON.parse(line);
      } catch {
        throw new Error("Session artifact archive line is corrupt");
      }
      const parsed = blob as Partial<EncryptedBlob>;
      const purpose = parsed.purpose;
      if (purpose !== "record" && purpose !== "finalization_manifest" && purpose !== "seal") {
        throw new Error("Session artifact archive purpose is invalid");
      }
      const expectedIndex = purpose === "record"
        ? recordIndex
        : purpose === "finalization_manifest"
          ? recordIndex
          : recordIndex + 1;
      const plaintext = decryptBlob(state.dek, state.archiveId, expectedIndex, purpose, parsed);
      let parsedEnvelope: ArchiveEnvelope;
      try {
        if (plaintext.byteLength > MAX_ARCHIVE_ENVELOPE_PLAINTEXT_BYTES) {
          throw new Error("Session artifact archive envelope plaintext exceeds its maximum");
        }
        parsedEnvelope = parseJson<ArchiveEnvelope>(plaintext, "Session artifact archive payload is corrupt");
      } finally {
        plaintext.fill(0);
      }
      if (
        parsedEnvelope === null ||
        typeof parsedEnvelope !== "object" ||
        (parsedEnvelope.kind !== "record" &&
          parsedEnvelope.kind !== "finalization_manifest" &&
          parsedEnvelope.kind !== "seal") ||
        parsedEnvelope.kind !== purpose
      ) {
        throw new Error("Session artifact archive payload is invalid");
      }
      const envelope: ArchiveEnvelope = parsedEnvelope.kind === "record"
        ? freeze({ ...parsedEnvelope, record: decodeEvidenceRecordFromArchive(parsedEnvelope.record) })
        : parsedEnvelope;
      if (envelope.kind === "record") {
        if (envelopeCount !== recordIndex || envelope.index !== recordIndex) {
          throw new Error("Session artifact record index is invalid");
        }
        recordIndex += 1;
      }
      envelopeCount += 1;
      yield envelope;
    }
    if (!sawEnvelope && !allowUnsealed) throw new Error("Session artifact archive is empty");
  }

  #preflightFailure(
    request: RecorderPreflightRequest,
    failureCode: RecorderPreflightFailureCode,
  ): RecorderPreflightResult {
    const result: RecorderPreflightResult = freeze({
      status: "failed" as const,
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      checkedAtMonoMs: request.checkedAtMonoMs,
      failureCode,
    });
    validateRecorderPreflightResult(result);
    return result;
  }

  #requiredFreeBytes(processingManifest: SessionProcessingManifest): bigint {
    const manifestMinimum = processingManifest.evidence.minimumFreeBytes;
    if (!/^[1-9][0-9]*$/u.test(manifestMinimum)) {
      throw new RecorderPreflightError("evidence_preflight_failed");
    }
    return BigInt(manifestMinimum) > BigInt(this.#minimumFreeBytes)
      ? BigInt(manifestMinimum)
      : BigInt(this.#minimumFreeBytes);
  }

  async #availableFreeBytes(requiredFreeBytes: bigint): Promise<string> {
    let info: Awaited<ReturnType<typeof statfs>>;
    try {
      info = await statfs(this.#archiveDirectory);
    } catch (error: unknown) {
      throw new RecorderPreflightError("free_space_unavailable", error);
    }
    const availableBlocks = BigInt(info.bavail);
    const blockSize = BigInt(info.bsize);
    const freeBytes = availableBlocks * blockSize;
    if (freeBytes < requiredFreeBytes) {
      throw new RecorderPreflightError("insufficient_evidence_disk");
    }
    return freeBytes.toString();
  }

  async #runEncryptedTrackProbe(
    state: RuntimeState,
    tracks: readonly EvidenceAudioTrack[],
  ): Promise<Readonly<{ readonly encryptedSpoolSha256: string; readonly sealedRecordCount: number }>> {
    const path = this.#probePath(state.archiveId);
    if (await this.#pathExists(path)) {
      await this.#assertManagedFile(path);
      await unlink(path);
      await this.#syncDirectory(this.#archiveDirectory);
    }
    const lines = tracks.map((track, index) => JSON.stringify(encryptBlob(
      state.dek,
      state.archiveId,
      index,
      "recorder_preflight_probe:" + track,
      plainText({ schemaVersion: FORMAT_VERSION, kind: "four_track_probe", track }),
    ))).join("\n") + "\n";
    await this.#writeAtomic(path, lines);
    try {
      await this.#assertManagedFile(path);
      const probe = await this.#readBoundedManagedFile(
        path,
        MAX_RECORDER_PROBE_BYTES,
        "Encrypted recorder probe",
      );
      if (probe === undefined) throw new Error("Encrypted recorder probe is missing");
      const encryptedBytes = probe.contents;
      const encryptedSpoolSha256 = createHash("sha256").update(encryptedBytes).digest("hex");
      const encryptedLines = encryptedBytes.toString("utf8")
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      if (encryptedLines.length !== tracks.length) {
        throw new Error("Encrypted recorder probe has an unexpected record count");
      }
      for (const [index, line] of encryptedLines.entries()) {
        const track = tracks[index];
        if (track === undefined) throw new Error("Encrypted recorder probe track is missing");
        const blob = JSON.parse(line) as unknown;
        const value = parseJson<Readonly<{ schemaVersion: number; kind: string; track: string }>>(
          decryptBlob(state.dek, state.archiveId, index, "recorder_preflight_probe:" + track, blob),
          "Encrypted recorder probe cannot be decoded",
        );
        if (value.schemaVersion !== FORMAT_VERSION || value.kind !== "four_track_probe" || value.track !== track) {
          throw new Error("Encrypted recorder probe verification failed");
        }
      }
      return freeze({ encryptedSpoolSha256, sealedRecordCount: encryptedLines.length });
    } catch (error: unknown) {
      throw new RecorderPreflightError("evidence_preflight_integrity_failed", error);
    } finally {
      if (await this.#pathExists(path)) {
        await this.#assertManagedFile(path);
        await unlink(path);
        await this.#syncDirectory(this.#archiveDirectory);
      }
    }
  }

  async #processingManifestForState(
    state: RuntimeState,
    finalizationRequest?: EvidenceFinalizeRequest,
  ): Promise<SessionProcessingManifest> {
    if (finalizationRequest === undefined) {
      await this.#stateTailWithTerminalFence(state);
    } else {
      await this.#awaitFinalizationTail(state, finalizationRequest);
    }
    if (state.failure !== undefined) throw state.failure;
    const { projection } = await this.#scanVerifiedRecordLedger(
      state,
      this.#spoolPath(state.archiveId),
      "discard",
    );
    const manifest = this.#processingManifestFromProjection(projection);
    validateSessionProcessingManifest(manifest);
    this.#validateEvidenceControls(manifest);
    return manifest;
  }

  #validateEvidenceControls(manifest: SessionProcessingManifest): void {
    const controls = manifest.evidence;
    const policy = manifest.retentionPolicy;
    if (
      controls.storage !== "local_encrypted_file" ||
      controls.encryption !== "aes_256_gcm" ||
      controls.providerEvents !== "final_only" ||
      controls.provisionalEvents !== "live_only" ||
      canonicalEvidenceJson(controls.tracks) !== canonicalEvidenceJson(EVIDENCE_AUDIO_TRACKS) ||
      policy.mode !== "scheduled_delete" ||
      policy.defaultDays !== 14 ||
      policy.maximumDays !== 30 ||
      policy.verificationMaximumHours !== 24
    ) {
      throw new Error("Session processing manifest has incompatible evidence controls");
    }
  }

  #processingProfileReferenceDigest(manifest: SessionProcessingManifest): string {
    return opaqueHmac(
      this.#archiveIdKey,
      "processing-profile-reference",
      canonicalEvidenceJson(manifest.profile),
    );
  }

  #finalizationFailure(
    sessionId: string,
    processingManifestSha256: string,
    error: unknown,
  ): EvidenceFinalization {
    const failureCode = this.#finalizationFailureCode(error);
    const result: EvidenceFinalization = freeze({
      status: "FINALIZATION_FAILED" as const,
      sessionId,
      processingManifestSha256,
      failureCode,
      recovery: "quarantine_delete_rerun" as const,
    });
    return result;
  }

  #finalizationFailureCode(error: unknown): EvidenceFinalizationFailureCode {
    const message = error instanceof Error ? error.message : "Evidence finalization failed";
    return /integrity|chain|decrypt|sealed artifact/u.test(message)
      ? "integrity_verification_failed"
      : /seal/u.test(message)
        ? "seal_write_failed"
        : "manifest_write_failed";
  }

  async #finalizeOnce(
    state: RuntimeState,
    request: EvidenceFinalizeRequest,
  ): Promise<EvidenceFinalization> {
    try {
      await state.initialize;
      if (state.metadata.phase === "sealed" && state.metadata.seal !== undefined && state.metadata.retention !== undefined) {
        if (state.metadata.processingManifestSha256 !== request.processingManifestSha256) {
          return this.#finalizationFailure(
            request.sessionId,
            request.processingManifestSha256,
            new Error("Finalization processing manifest conflicts with sealed artifact"),
          );
        }
        return this.#sealedFinalization(state);
      }
      assertFinalizationNotAborted(request);
      if (
        state.metadata.preflight?.status !== "ready" ||
        state.metadata.processingManifestSha256 !== request.processingManifestSha256
      ) {
        throw new Error("Recorder preflight must succeed before evidence finalization");
      }
      // Once a recorder was successfully armed, a terminal failure must retain
      // the same retention/deletion clock as a sealed artifact. Persist this
      // audit state before reading the ledger again: that read is precisely
      // what can fail for a corrupt or torn terminal artifact.
      const finalizedAtMs = checkedEpochMs(this.#now(), "evidence finalization clock");
      const retention: RetentionMetadata = state.metadata.retention ?? freeze({
        finalizedAtMonoMs: request.finalizedAtMonoMs,
        finalizedAtMs,
        initialRetentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
        retentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
        extensionUsed: false,
      });
      state.metadata = freeze({
        ...state.metadata,
        phase: "finalizing",
        retention,
        finalizationReason: request.reason,
        finalizationLastPersistedEventCursor: request.lastPersistedEventCursor,
      });
      await this.#persistSidecar(state);
      const processingManifest = await this.#processingManifestForState(state, request);
      assertFinalizationNotAborted(request);
      if (processingManifest.manifestSha256 !== request.processingManifestSha256) {
        throw new Error("Finalization processing manifest does not match the recorded session manifest");
      }
      if (processingManifest.retentionPolicy.defaultDays * DAY_MS !== DEFAULT_RETENTION_MS) {
        throw new Error("Processing manifest has an invalid default retention duration");
      }
      await this.#awaitFinalizationTail(state, request);
      assertFinalizationNotAborted(request);
      if (state.failure !== undefined) throw state.failure;
      state.closed = true;
      await this.#syncFile(this.#spoolPath(state.archiveId));
      await this.#writeFinalizationAndSeal(state, request, retention);
      const encryptedLedgerSha256 = await this.#promoteVerifiedArchive(state, request.abortSignal);
      return this.#sealedFinalization(state, encryptedLedgerSha256);
    } catch (error: unknown) {
      const finalizationAborted = request.abortSignal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      if (finalizationAborted) {
        this.#fenceAbortedFinalization(state);
        return this.#markFinalizationFailed(
          state,
          request.processingManifestSha256,
          error,
          true,
          true,
        );
      }
      if (
        !state.metadata.rebuildAttempted &&
        state.metadata.phase === "finalizing"
      ) {
        try {
          state.metadata = freeze({ ...state.metadata, rebuildAttempted: true });
          await this.#persistSidecar(state);
          await this.#rebuildFinalizationOnce(state, request);
          const encryptedLedgerSha256 = await this.#promoteVerifiedArchive(state, request.abortSignal);
          return this.#sealedFinalization(state, encryptedLedgerSha256);
        } catch (rebuildError: unknown) {
          return this.#markFinalizationFailed(
            state,
            request.processingManifestSha256,
            rebuildError,
          );
        }
      }
      return this.#markFinalizationFailed(
        state,
        request.processingManifestSha256,
        error,
      );
    }
  }

  async #writeFinalizationAndSeal(
    state: RuntimeState,
    request: EvidenceFinalizeRequest,
    retention: RetentionMetadata,
  ): Promise<void> {
    const { projection: mutableProjection } = await this.#scanVerifiedRecordLedger(
      state,
      this.#spoolPath(state.archiveId),
      "reject",
    );
    assertFinalizationNotAborted(request);
    if (
      state.recordCount !== mutableProjection.recordCount ||
      state.chainSha256 !== mutableProjection.finalChainSha256
    ) {
      throw new Error("Session artifact append cursor does not match the verified ledger");
    }
    await this.#appendFinalizationAndSeal(
      state,
      this.#finishEvidenceLedgerProjection(mutableProjection),
      request,
      retention,
    );
  }

  async #appendFinalizationAndSeal(
    state: RuntimeState,
    projection: EvidenceLedgerProjection,
    request: EvidenceFinalizeRequest,
    retention: RetentionMetadata,
  ): Promise<void> {
    const manifest = this.#createFinalizationManifest(state, projection, request, retention);
    const seal = this.#createSeal(
      projection.recordCount,
      projection.finalChainSha256,
      manifest.manifestSha256,
    );
    assertFinalizationNotAborted(request);
    await this.#appendArchiveEnvelope(state, freeze({ kind: "finalization_manifest", manifest }), "finalization_manifest");
    assertFinalizationNotAborted(request);
    await this.#appendArchiveEnvelope(state, freeze({ kind: "seal", seal }), "seal");
    assertFinalizationNotAborted(request);
    await this.#syncFile(this.#spoolPath(state.archiveId));
  }

  async #rebuildFinalizationOnce(
    state: RuntimeState,
    request: EvidenceFinalizeRequest,
  ): Promise<void> {
    const retention = state.metadata.retention;
    if (retention === undefined) throw new Error("Finalization retention metadata is missing");
    let scanned = await this.#scanVerifiedRecordLedger(
      state,
      this.#spoolPath(state.archiveId),
      "discard",
    );
    if (scanned.sawTerminalEnvelope) {
      scanned = {
        projection: await this.#rewriteSpoolRecords(state),
        sawTerminalEnvelope: false,
      };
    }
    state.recordCount = scanned.projection.recordCount;
    state.serializedRecordBytes = scanned.projection.serializedRecordBytes;
    state.audioBytes = Object.values(scanned.projection.tracks)
      .reduce((total, track) => total + track.byteCount, 0);
    state.audioOriginTimelineAtMonoMs = scanned.projection.audioOriginTimelineAtMonoMs;
    state.audioLastTimelineAtMonoMs = scanned.projection.audioLastTimelineAtMonoMs;
    state.chainSha256 = scanned.projection.finalChainSha256;
    await this.#appendFinalizationAndSeal(
      state,
      this.#finishEvidenceLedgerProjection(scanned.projection),
      request,
      retention,
    );
  }

  async #rewriteSpoolRecords(
    state: RuntimeState,
  ): Promise<MutableEvidenceLedgerProjection> {
    const path = this.#spoolPath(state.archiveId);
    let rewritten: MutableEvidenceLedgerProjection | undefined;
    await this.#writeAtomic(path, async (write) => {
      const scanned = await this.#scanVerifiedRecordLedger(
        state,
        path,
        "discard",
        async (record) => write(this.#serializeArchiveEnvelope(state, record, "record")),
      );
      rewritten = scanned.projection;
    });
    if (rewritten === undefined) throw new Error("Session artifact rewrite produced no ledger projection");
    return rewritten;
  }

  async #scanVerifiedRecordLedger(
    state: RuntimeState,
    path: string,
    terminalHandling: "reject" | "discard",
    onRecord?: (record: RecordEnvelope) => Promise<void>,
  ): Promise<ScannedRecordLedger> {
    const projection = this.#newEvidenceLedgerProjection();
    let sawTerminalEnvelope = false;
    for await (const envelope of this.#iterateArchiveEnvelopes(state, path, true)) {
      if (envelope.kind !== "record") {
        sawTerminalEnvelope = true;
        if (terminalHandling === "reject") {
          throw new Error("Session artifact spool contains terminal envelopes");
        }
        continue;
      }
      if (sawTerminalEnvelope) {
        throw new Error("Session artifact record appears after a terminal envelope");
      }
      this.#acceptVerifiedRecordEnvelope(
        projection,
        envelope,
        state.sessionId,
        state.metadata.dataOwnerIdHmac,
      );
      await onRecord?.(envelope);
    }
    return { projection, sawTerminalEnvelope };
  }

  #acceptVerifiedRecordEnvelope(
    projection: MutableEvidenceLedgerProjection,
    envelope: RecordEnvelope,
    expectedSessionId: string,
    expectedDataOwnerIdHmac: string,
  ): void {
    if (
      envelope.index !== projection.recordCount ||
      envelope.previousChainSha256 !== projection.finalChainSha256 ||
      !isSha256(envelope.recordSha256) ||
      !isSha256(envelope.chainSha256)
    ) {
      throw new Error("Session artifact record chain is invalid");
    }
    if (evidenceSha256(envelope.record) !== envelope.recordSha256) {
      throw new Error("Session artifact record digest is invalid");
    }
    const expectedChainSha256 = evidenceSha256({
      schemaVersion: FORMAT_VERSION,
      index: envelope.index,
      previousChainSha256: envelope.previousChainSha256,
      recordSha256: envelope.recordSha256,
    });
    if (expectedChainSha256 !== envelope.chainSha256) {
      throw new Error("Session artifact record chain digest is invalid");
    }
    projection.finalChainSha256 = expectedChainSha256;
    this.#acceptVerifiedEvidenceRecord(
      projection,
      envelope.record,
      envelope.recordSha256,
      expectedSessionId,
      expectedDataOwnerIdHmac,
    );
  }

  #processingManifestFromProjection(
    projection: MutableEvidenceLedgerProjection,
  ): SessionProcessingManifest {
    if (projection.processingManifest === undefined) {
      throw new Error("Finalization requires the authoritative session processing manifest record");
    }
    return freeze(structuredClone(projection.processingManifest));
  }

  #lastPersistedEventCursorFromProjection(projection: MutableEvidenceLedgerProjection): number {
    if (projection.lastPersistedEventCursor === undefined) {
      throw new Error("Finalization requires persisted session events");
    }
    return projection.lastPersistedEventCursor;
  }

  #newEvidenceLedgerProjection(): MutableEvidenceLedgerProjection {
    const trackDigests: Record<EvidenceAudioTrack, EvidenceTrackDigest> = {
      source_a: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
      source_b: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
      playout_to_a: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
      playout_to_b: { recordCount: 0, sha256: EMPTY_CHAIN_SHA256 },
    };
    const tracks: Record<EvidenceAudioTrack, FinalizedTrackDigest> = {
      source_a: { sha256: EMPTY_CHAIN_SHA256, frameCount: 0, byteCount: 0 },
      source_b: { sha256: EMPTY_CHAIN_SHA256, frameCount: 0, byteCount: 0 },
      playout_to_a: { sha256: EMPTY_CHAIN_SHA256, frameCount: 0, byteCount: 0 },
      playout_to_b: { sha256: EMPTY_CHAIN_SHA256, frameCount: 0, byteCount: 0 },
    };
    const audioTrackState: MutableEvidenceLedgerProjection["audioTrackState"] = {
      source_a: { originTimelineAtMonoMs: undefined, previousEndSampleFrame: 0 },
      source_b: { originTimelineAtMonoMs: undefined, previousEndSampleFrame: 0 },
      playout_to_a: { originTimelineAtMonoMs: undefined, previousEndSampleFrame: 0 },
      playout_to_b: { originTimelineAtMonoMs: undefined, previousEndSampleFrame: 0 },
    };
    return {
      recordCount: 0,
      serializedRecordBytes: 0,
      finalChainSha256: EMPTY_CHAIN_SHA256,
      trackDigests,
      tracks,
      consentReceiptRefsBySide: new Map<"A" | "B", string>(),
      lastPersistedEventCursor: undefined,
      processingManifest: undefined,
      evidenceReviewGrant: undefined,
      audioOriginTimelineAtMonoMs: undefined,
      audioLastTimelineAtMonoMs: undefined,
      audioTrackState,
    };
  }

  #acceptVerifiedEvidenceRecord(
    projection: MutableEvidenceLedgerProjection,
    record: EvidenceRecord,
    recordSha256: string,
    expectedSessionId: string,
    expectedDataOwnerIdHmac: string,
  ): void {
    if (!isSha256(recordSha256)) throw new Error("Artifact record digest is invalid");
    assertEvidenceRecordSessionIdentity(record, expectedSessionId);
    projection.serializedRecordBytes += serializedEvidenceRecordBytes(record);
    if (
      projection.recordCount >= MAX_SESSION_RECORDS ||
      projection.serializedRecordBytes > MAX_SESSION_SERIALIZED_RECORD_BYTES
    ) {
      throw new Error("Session evidence artifact exceeds its maximum size");
    }
    projection.recordCount += 1;
    if (record.type === "session_event") {
      if (
        projection.lastPersistedEventCursor === undefined ||
        record.event.cursor > projection.lastPersistedEventCursor
      ) {
        projection.lastPersistedEventCursor = record.event.cursor;
      }
      if (record.event.type === "session_opened" && projection.processingManifest === undefined) {
        projection.processingManifest = freeze(structuredClone(record.event.snapshot.spec.processingManifest));
      }
      if (record.event.type === "session_opened") {
        const grant = checkedEvidenceReviewGrant(record.event.snapshot.spec.evidenceReviewGrant);
        if (this.#dataOwnerIdHmac(this.#archiveIdForSession(expectedSessionId), grant.dataOwnerId) !== expectedDataOwnerIdHmac) {
          throw new Error("Evidence review grant data owner does not match the frozen governance owner");
        }
        if (
          projection.evidenceReviewGrant !== undefined &&
          canonicalEvidenceJson(projection.evidenceReviewGrant) !== canonicalEvidenceJson(grant)
        ) {
          throw new Error("Evidence review grant changes within a ledger");
        }
        projection.evidenceReviewGrant = grant;
      }
      if (record.event.type === "participant_consent") {
        projection.consentReceiptRefsBySide.set(
          record.event.side,
          opaqueHmac(this.#archiveIdKey, "consent-receipt", canonicalEvidenceJson(record.event)),
        );
      }
      return;
    }
    if (record.type !== "audio") return;
    this.#validateVerifiedAudioRecord(record);
    const currentDigest = projection.trackDigests[record.track];
    const nextTrackDigest: EvidenceTrackDigest = {
      recordCount: currentDigest.recordCount + 1,
      sha256: evidenceSha256({
        schemaVersion: FORMAT_VERSION,
        track: record.track,
        index: currentDigest.recordCount,
        previousChainSha256: currentDigest.sha256,
        recordSha256,
      }),
    };
    projection.trackDigests[record.track] = nextTrackDigest;
    const currentTrack = projection.tracks[record.track];
    projection.tracks[record.track] = {
      sha256: nextTrackDigest.sha256,
      frameCount: currentTrack.frameCount + 1,
      byteCount: currentTrack.byteCount + record.frame.pcm16le.byteLength,
    };

    const trackTimeline = projection.audioTrackState[record.track];
    if (trackTimeline.originTimelineAtMonoMs === undefined) {
      trackTimeline.originTimelineAtMonoMs = record.timelineAtMonoMs;
    }
    const startSampleFrame = this.#sampleOffset(
      record.timelineAtMonoMs,
      trackTimeline.originTimelineAtMonoMs,
    );
    if (startSampleFrame < trackTimeline.previousEndSampleFrame) {
      throw new Error("Overlapping or out-of-order frames found on one evidence track");
    }
    trackTimeline.previousEndSampleFrame = startSampleFrame + CANONICAL_AUDIO.samplesPerFrame;
    projection.audioOriginTimelineAtMonoMs = projection.audioOriginTimelineAtMonoMs === undefined
      ? record.timelineAtMonoMs
      : Math.min(projection.audioOriginTimelineAtMonoMs, record.timelineAtMonoMs);
    projection.audioLastTimelineAtMonoMs = projection.audioLastTimelineAtMonoMs === undefined
      ? record.timelineAtMonoMs
      : Math.max(projection.audioLastTimelineAtMonoMs, record.timelineAtMonoMs);
    const aggregateAudioBytes = Object.values(projection.tracks)
      .reduce((total, track) => total + track.byteCount, 0);
    if (aggregateAudioBytes > MAX_SESSION_AUDIO_BYTES) {
      throw new Error("Session evidence audio exceeds its maximum size");
    }
    if (
      projection.audioLastTimelineAtMonoMs - projection.audioOriginTimelineAtMonoMs +
        CANONICAL_AUDIO.frameDurationMs > MAX_SESSION_AUDIO_DURATION_MS
    ) {
      throw new Error("Session evidence audio exceeds its maximum duration");
    }
  }

  #validateVerifiedAudioRecord(record: Extract<EvidenceRecord, { readonly type: "audio" }>): void {
    const { frame } = record;
    if (
      record.sessionId !== frame.sessionId ||
      !Number.isFinite(record.timelineAtMonoMs) ||
      record.timelineAtMonoMs < 0 ||
      frame.format.encoding !== CANONICAL_AUDIO.encoding ||
      frame.format.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
      frame.format.channels !== CANONICAL_AUDIO.channels ||
      frame.format.frameDurationMs !== CANONICAL_AUDIO.frameDurationMs ||
      frame.format.bytesPerFrame !== CANONICAL_AUDIO.bytesPerFrame ||
      !(frame.pcm16le instanceof Uint8Array) ||
      frame.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame
    ) {
      throw new Error("Evidence audio record is not canonical");
    }
  }

  #sampleOffset(timelineAtMonoMs: number, originTimelineAtMonoMs: number): number {
    const sampleOffset = Math.round(
      ((timelineAtMonoMs - originTimelineAtMonoMs) * CANONICAL_AUDIO.sampleRateHz) / 1_000,
    );
    if (!Number.isSafeInteger(sampleOffset) || sampleOffset < 0) {
      throw new Error("Evidence audio timeline is invalid");
    }
    return sampleOffset;
  }

  #finishEvidenceLedgerProjection(
    projection: MutableEvidenceLedgerProjection,
  ): EvidenceLedgerProjection {
    if (
      projection.processingManifest === undefined ||
      projection.evidenceReviewGrant === undefined ||
      projection.lastPersistedEventCursor === undefined ||
      projection.consentReceiptRefsBySide.get("A") === undefined ||
      projection.consentReceiptRefsBySide.get("B") === undefined
    ) {
      throw new Error("Finalization requires the authoritative processing manifest, events, and consent records");
    }
    const originTimelineAtMonoMs = projection.audioOriginTimelineAtMonoMs ?? null;
    const durationSampleFrames = originTimelineAtMonoMs === null
      ? 0
      : this.#sampleOffset(projection.audioLastTimelineAtMonoMs!, originTimelineAtMonoMs) +
        CANONICAL_AUDIO.samplesPerFrame;
    return freeze({
      recordCount: projection.recordCount,
      finalChainSha256: projection.finalChainSha256,
      trackDigests: freeze(structuredClone(projection.trackDigests)),
      tracks: freeze(structuredClone(projection.tracks)),
      consentReceiptRefs: Object.freeze([
        projection.consentReceiptRefsBySide.get("A")!,
        projection.consentReceiptRefsBySide.get("B")!,
      ]),
      lastPersistedEventCursor: projection.lastPersistedEventCursor,
      processingManifest: freeze(structuredClone(projection.processingManifest)),
      evidenceReviewGrant: freeze(structuredClone(projection.evidenceReviewGrant)),
      reviewGrantSha256: evidenceSha256(projection.evidenceReviewGrant),
      audioTimeline: freeze({ originTimelineAtMonoMs, durationSampleFrames }),
    });
  }

  #createFinalizationManifest(
    state: RuntimeState,
    projection: EvidenceLedgerProjection,
    request: EvidenceFinalizeRequest,
    retention: RetentionMetadata,
  ): SessionArtifactFinalizationManifest {
    const processingManifest = projection.processingManifest;
    validateSessionProcessingManifest(processingManifest);
    this.#validateEvidenceControls(processingManifest);
    const processingManifestSha256 = processingManifest.manifestSha256;
    if (
      !isSha256(processingManifestSha256) ||
      processingManifestSha256 !== state.metadata.processingManifestSha256 ||
      processingManifestSha256 !== request.processingManifestSha256
    ) {
      throw new Error("Session processing manifest does not match recorder preflight");
    }
    if (projection.lastPersistedEventCursor !== request.lastPersistedEventCursor) {
      throw new Error("Finalization cursor does not match the durable evidence ledger");
    }
    const finalizedAtUtc = new Date(retention.finalizedAtMs).toISOString();
    const retentionDeadlineAt = new Date(retention.retentionDeadlineAtMs).toISOString();
    const body = {
      schemaVersion: FORMAT_VERSION,
      kind: "session_artifact_finalization" as const,
      archiveId: state.archiveId,
      processingManifest,
      processingManifestSha256,
      reviewGrantSha256: projection.reviewGrantSha256,
      consentReceiptRefs: projection.consentReceiptRefs,
      finalizedAtMonoMs: request.finalizedAtMonoMs,
      finalizedAtUtc,
      reason: request.reason,
      retentionDeadlineAtMs: retention.retentionDeadlineAtMs,
      retentionDeadlineAt,
      recordCount: projection.recordCount,
      finalChainSha256: projection.finalChainSha256,
      trackDigests: projection.trackDigests,
      tracks: projection.tracks,
    };
    return freeze({ ...body, manifestSha256: evidenceSha256(body) });
  }

  #createSeal(
    recordCount: number,
    finalChainSha256: string,
    finalizationManifestSha256: string,
  ): SessionArtifactSeal {
    const body = {
      schemaVersion: FORMAT_VERSION,
      recordCount,
      finalChainSha256,
      finalizationManifestSha256,
    };
    return freeze({ ...body, sealSha256: evidenceSha256(body) });
  }

  async #promoteVerifiedArchive(
    state: RuntimeState,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const assertNotAborted = (): void => {
      if (!abortSignal?.aborted) return;
      const error = new Error("Evidence finalization was cancelled before archive promotion");
      error.name = "AbortError";
      throw error;
    };
    const archive = this.#archivePath(state.archiveId);
    if (await this.#pathExists(archive)) {
      const verifiedArchive = (await this.#verifyArchiveForSealedLease(state, archive)).summary;
      assertNotAborted();
      const encryptedLedgerSha256 = await this.#sha256File(archive, abortSignal);
      assertNotAborted();
      await this.#markSealedFromVerified(
        state,
        verifiedArchive,
        assertNotAborted,
      );
      return encryptedLedgerSha256;
    }
    const spool = this.#spoolPath(state.archiveId);
    const verifiedSpool = (await this.#verifyArchiveForSealedLease(state, spool)).summary;
    assertNotAborted();
    await rename(spool, archive);
    await this.#syncDirectory(this.#archiveDirectory);
    const verifiedArchive = (await this.#verifyArchiveForSealedLease(state, archive)).summary;
    assertNotAborted();
    const encryptedLedgerSha256 = await this.#sha256File(archive, abortSignal);
    assertNotAborted();
    if (verifiedSpool.seal.sealSha256 !== verifiedArchive.seal.sealSha256) {
      throw new Error("Finalized archive changed during atomic promotion");
    }
    await this.#markSealedFromVerified(state, verifiedArchive, assertNotAborted);
    return encryptedLedgerSha256;
  }

  async #markSealedFromVerified(
    state: RuntimeState,
    verifiedArchive: Readonly<{
      readonly finalization: SessionArtifactFinalizationManifest;
      readonly seal: SessionArtifactSeal;
    }>,
    commitFence?: () => void,
  ): Promise<void> {
    state.metadata = freeze({
      ...state.metadata,
      phase: "sealed",
      finalization: verifiedArchive.finalization,
      seal: verifiedArchive.seal,
      retention: freeze({
        finalizedAtMonoMs: verifiedArchive.finalization.finalizedAtMonoMs,
        finalizedAtMs: Date.parse(verifiedArchive.finalization.finalizedAtUtc),
        initialRetentionDeadlineAtMs: verifiedArchive.finalization.retentionDeadlineAtMs,
        retentionDeadlineAtMs: verifiedArchive.finalization.retentionDeadlineAtMs,
        extensionUsed: state.metadata.retention?.extensionUsed ?? false,
      }),
    });
    await this.#persistSidecar(state, commitFence);
  }

  async #recoverFinalization(state: RuntimeState): Promise<EvidenceFinalization> {
    const request =
      state.metadata.retention === undefined ||
      state.metadata.finalizationReason === undefined ||
      state.metadata.processingManifestSha256 === undefined ||
      state.metadata.finalizationLastPersistedEventCursor === undefined
      ? undefined
      : {
        sessionId: state.sessionId,
        processingManifestSha256: state.metadata.processingManifestSha256,
        finalizedAtMonoMs: state.metadata.retention.finalizedAtMonoMs,
        reason: state.metadata.finalizationReason,
        lastPersistedEventCursor: state.metadata.finalizationLastPersistedEventCursor,
      };
    if (request === undefined) {
      return this.#markFinalizationFailed(
        state,
        state.metadata.processingManifestSha256 ?? EMPTY_CHAIN_SHA256,
        new Error("Cannot recover finalization without durable retention metadata"),
      );
    }
    try {
      const spool = this.#spoolPath(state.archiveId);
      if (await this.#pathExists(this.#archivePath(state.archiveId))) {
        await this.#markSealedFromVerified(
          state,
          (await this.#verifyArchiveForSealedLease(
            state,
            this.#archivePath(state.archiveId),
          )).summary,
        );
        return this.#sealedFinalization(state);
      }
      try {
        await this.#verifyArchiveForSealedLease(state, spool);
        await this.#promoteVerifiedArchive(state);
        return this.#sealedFinalization(state);
      } catch {
        if (state.metadata.rebuildAttempted) throw new Error("Finalization rebuild was already attempted");
        state.metadata = freeze({ ...state.metadata, rebuildAttempted: true });
        await this.#persistSidecar(state);
        await this.#rebuildFinalizationOnce(state, request);
        await this.#promoteVerifiedArchive(state);
        return this.#sealedFinalization(state);
      }
    } catch (error: unknown) {
      return this.#markFinalizationFailed(
        state,
        request.processingManifestSha256,
        error,
      );
    }
  }

  async #sealedFinalization(
    state: RuntimeState,
    verifiedEncryptedLedgerSha256?: string,
  ): Promise<EvidenceFinalization> {
    const retention = state.metadata.retention;
    const seal = state.metadata.seal;
    const finalization = state.metadata.finalization;
    if (retention === undefined || seal === undefined || finalization === undefined) {
      throw new Error("Sealed artifact is missing finalization metadata");
    }
    const encryptedLedgerSha256 = verifiedEncryptedLedgerSha256 ??
      await this.#sha256File(this.#archivePath(state.archiveId));
    const result: EvidenceFinalization = freeze({
      status: "sealed" as const,
      sessionId: state.sessionId,
      processingManifestSha256: finalization.processingManifestSha256,
      manifestSha256: finalization.manifestSha256,
      encryptedLedgerSha256,
      finalChainSha256: seal.finalChainSha256,
      recordCount: seal.recordCount,
      finalizedAtUtc: finalization.finalizedAtUtc,
      retentionDeadlineAt: finalization.retentionDeadlineAt,
      tracks: finalization.tracks,
    });
    validateEvidenceFinalization(result, {
      sessionId: state.sessionId,
      processingManifestSha256: finalization.processingManifestSha256,
      retentionPolicy: finalization.processingManifest.retentionPolicy,
    });
    return result;
  }

  async #markFinalizationFailed(
    state: RuntimeState,
    processingManifestSha256: string,
    error: unknown,
    allowOrphanedAuditFallback = false,
    skipVerifiedLedgerAudit = false,
  ): Promise<EvidenceFinalization> {
    const failureCode = this.#finalizationFailureCode(error);
    let auditedProcessingManifestSha256 = processingManifestSha256;
    let finalizationFailureAudit: FinalizationFailureAuditSource;
    try {
      if (skipVerifiedLedgerAudit) throw new Error("Verified ledger audit was fenced by cancellation");
      auditedProcessingManifestSha256 = await this.#ensureFailedFinalizationAuditMetadata(state);
      finalizationFailureAudit = "verified_ledger";
    } catch {
      const fallback = this.#ensureFailedFinalizationFallbackAuditMetadata(
        state,
        allowOrphanedAuditFallback,
      );
      auditedProcessingManifestSha256 = fallback.processingManifestSha256;
      finalizationFailureAudit = fallback.finalizationFailureAudit;
    }
    state.closed = true;
    state.metadata = freeze({
      ...state.metadata,
      phase: "FINALIZATION_FAILED",
      finalizationFailureCode: failureCode,
      finalizationFailureAudit,
    });
    // Do not claim a governed terminal failure until its audit projection is
    // durable. The fallback is intentionally content-free and either uses the
    // verified sidecar projection or an immediate deletion deadline, so no
    // crash path can persist an undeletable terminal artifact.
    await this.#persistSidecar(state);
    return freeze({
      status: "FINALIZATION_FAILED" as const,
      sessionId: state.sessionId,
      processingManifestSha256: auditedProcessingManifestSha256,
      failureCode,
      recovery: "quarantine_delete_rerun" as const,
    });
  }

  /**
   * A failed terminal ledger remains retention-governed only when the
   * non-content audit projection is durable. Derive it from the authoritative
   * session-opened record instead of trusting a caller-provided hash.
   */
  async #ensureFailedFinalizationAuditMetadata(state: RuntimeState): Promise<string> {
    const { projection } = await this.#scanVerifiedRecordLedger(
      state,
      this.#spoolPath(state.archiveId),
      "discard",
    );
    const processingManifest = this.#processingManifestFromProjection(projection);
    validateSessionProcessingManifest(processingManifest);
    this.#validateEvidenceControls(processingManifest);
    const processingManifestSha256 = processingManifest.manifestSha256;
    const finalizedAtMs = checkedEpochMs(this.#now(), "failed finalization audit clock");
    const retention = state.metadata.retention ?? freeze({
      finalizedAtMonoMs: finalizedAtMs,
      finalizedAtMs,
      initialRetentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
      retentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
      extensionUsed: false,
    });
    state.metadata = freeze({
      ...state.metadata,
      processingManifestSha256,
      processingProfileSha256: processingManifest.profile.sha256,
      processingProfileReferenceDigest: this.#processingProfileReferenceDigest(processingManifest),
      retention,
      finalizationReason: state.metadata.finalizationReason ?? "failed_finalization_remediation",
      finalizationLastPersistedEventCursor:
        state.metadata.finalizationLastPersistedEventCursor ??
        this.#lastPersistedEventCursorFromProjection(projection),
    });
    return processingManifestSha256;
  }

  #hasVerifiedProcessingAuditProjection(metadata: SessionArtifactMetadata): boolean {
    return isSha256(metadata.processingManifestSha256) &&
      isSha256(metadata.processingProfileSha256) &&
      isSha256(metadata.processingProfileReferenceDigest);
  }

  /**
   * Records an auditable retention/deletion projection when a crash orphan
   * cannot reconstruct its ledger. Sidecar projection fields are authenticated
   * by the wrapped-DEK metadata; if they do not exist, use opaque IDs and an
   * immediate deletion deadline rather than leaving an undeletable terminal.
   */
  #ensureFailedFinalizationFallbackAuditMetadata(
    state: RuntimeState,
    allowOrphanedAuditFallback: boolean,
  ): Readonly<{
    processingManifestSha256: string;
    finalizationFailureAudit: FinalizationFailureAuditSource;
  }> {
    const metadata = state.metadata;
    const hasVerifiedProjection = this.#hasVerifiedProcessingAuditProjection(metadata);
    const finalizedAtMs = checkedEpochMs(this.#now(), "failed finalization fallback clock");
    const retention = hasVerifiedProjection
      ? metadata.retention ?? freeze({
        finalizedAtMonoMs: finalizedAtMs,
        finalizedAtMs,
        initialRetentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
        retentionDeadlineAtMs: finalizedAtMs + DEFAULT_RETENTION_MS,
        extensionUsed: false,
      })
      : freeze({
        finalizedAtMonoMs: finalizedAtMs,
        finalizedAtMs,
        initialRetentionDeadlineAtMs: finalizedAtMs,
        retentionDeadlineAtMs: finalizedAtMs,
        extensionUsed: false,
      });
    let processingManifestSha256: string;
    let processingProfileSha256: string;
    let processingProfileReferenceDigest: string;
    if (
      isSha256(metadata.processingManifestSha256) &&
      isSha256(metadata.processingProfileSha256) &&
      isSha256(metadata.processingProfileReferenceDigest)
    ) {
      processingManifestSha256 = metadata.processingManifestSha256;
      processingProfileSha256 = metadata.processingProfileSha256;
      processingProfileReferenceDigest = metadata.processingProfileReferenceDigest;
    } else {
      processingManifestSha256 = opaqueHmac(
        this.#archiveIdKey,
        "orphaned-finalization-processing-manifest",
        state.archiveId,
      );
      processingProfileSha256 = opaqueHmac(
        this.#archiveIdKey,
        "orphaned-finalization-processing-profile",
        state.archiveId,
      );
      processingProfileReferenceDigest = opaqueHmac(
        this.#archiveIdKey,
        "orphaned-finalization-processing-profile-reference",
        state.archiveId,
      );
    }
    const finalizationFailureAudit = hasVerifiedProjection
      ? "verified_sidecar_projection" as const
      : allowOrphanedAuditFallback
        ? "orphaned_without_ledger" as const
        : "unverified_immediate" as const;
    state.metadata = freeze({
      ...metadata,
      processingManifestSha256,
      processingProfileSha256,
      processingProfileReferenceDigest,
      retention,
      finalizationReason: metadata.finalizationReason ?? "failed_finalization_remediation",
      finalizationLastPersistedEventCursor: metadata.finalizationLastPersistedEventCursor ?? 0,
    });
    return freeze({ processingManifestSha256, finalizationFailureAudit });
  }

  async #isRecoverableFinalizationFailure(state: RuntimeState): Promise<boolean> {
    const metadata = state.metadata;
    if (
      metadata.phase !== "FINALIZATION_FAILED" ||
      metadata.retention === undefined ||
      !isFinalizationFailureCode(metadata.finalizationFailureCode) ||
      !isFinalizationFailureAuditSource(metadata.finalizationFailureAudit) ||
      !this.#hasVerifiedProcessingAuditProjection(metadata)
    ) {
      return false;
    }
    if (
      metadata.finalizationFailureAudit === "verified_sidecar_projection" ||
      metadata.finalizationFailureAudit === "orphaned_without_ledger"
    ) {
      return true;
    }
    if (metadata.finalizationFailureAudit !== "verified_ledger") return false;
    try {
      const processingManifest = await this.#processingManifestForState(state);
      return processingManifest.manifestSha256 === metadata.processingManifestSha256 &&
        processingManifest.profile.sha256 === metadata.processingProfileSha256 &&
        this.#processingProfileReferenceDigest(processingManifest) === metadata.processingProfileReferenceDigest;
    } catch {
      return false;
    }
  }

  async #authenticatedEvidenceReviewGrantForState(state: RuntimeState): Promise<EvidenceReviewGrant> {
    const path = state.metadata.phase === "sealed"
      ? this.#archivePath(state.archiveId)
      : await this.#pathExists(this.#spoolPath(state.archiveId))
        ? this.#spoolPath(state.archiveId)
        : this.#archivePath(state.archiveId);
    const projection = this.#newEvidenceLedgerProjection();
    for await (const envelope of this.#iterateArchiveEnvelopes(state, path, true)) {
      if (envelope.kind !== "record") break;
      this.#acceptVerifiedRecordEnvelope(
        projection,
        envelope,
        state.sessionId,
        state.metadata.dataOwnerIdHmac,
      );
      if (projection.evidenceReviewGrant !== undefined) {
        return freeze(structuredClone(projection.evidenceReviewGrant));
      }
    }
    throw new Error("Evidence review grant is unavailable");
  }

  /**
   * Performs a complete, bounded verification pass before a managed export
   * callback receives any record. The callback gets only this immutable
   * metadata summary and must use the replay iterator below for evidence.
   */
  async #verifyArchiveForSealedLease(
    state: RuntimeState,
    path: string,
  ): Promise<VerifiedSealedLeaseArtifact> {
    const projection = this.#newEvidenceLedgerProjection();
    let manifest: SessionArtifactFinalizationManifest | undefined;
    let seal: SessionArtifactSeal | undefined;
    let envelopeIndex = 0;
    for await (const envelope of this.#iterateArchiveEnvelopes(state, path, false)) {
      if (envelope.kind === "record") {
        if (manifest !== undefined || seal !== undefined) {
          throw new Error("Record appears after finalization");
        }
        this.#acceptVerifiedRecordEnvelope(
          projection,
          envelope,
          state.sessionId,
          state.metadata.dataOwnerIdHmac,
        );
      } else if (envelope.kind === "finalization_manifest") {
        if (manifest !== undefined || seal !== undefined || envelopeIndex !== projection.recordCount) {
          throw new Error("Artifact finalization manifest position is invalid");
        }
        manifest = envelope.manifest;
      } else {
        if (seal !== undefined || manifest === undefined || envelopeIndex !== projection.recordCount + 1) {
          throw new Error("Artifact seal position is invalid");
        }
        seal = envelope.seal;
      }
      envelopeIndex += 1;
    }
    if (manifest === undefined || seal === undefined) {
      throw new Error("Artifact finalization is incomplete");
    }
    const verifiedProjection = this.#finishEvidenceLedgerProjection(projection);
    this.#validateFinalizationManifestProjection(state, manifest, verifiedProjection);
    const expectedSeal = this.#createSeal(
      verifiedProjection.recordCount,
      verifiedProjection.finalChainSha256,
      manifest.manifestSha256,
    );
    if (canonicalEvidenceJson(seal) !== canonicalEvidenceJson(expectedSeal)) {
      throw new Error("Artifact seal validation failed");
    }
    const retention = state.metadata.retention;
    if (retention === undefined) throw new Error("Artifact retention projection is missing");
    return freeze({
      summary: freeze({
        archiveId: state.archiveId,
        status: "sealed" as const,
        // The signed finalization retains the initial deadline. The encrypted
        // sidecar is the authenticated source for the one permitted extension.
        retentionDeadlineAtMs: retention.retentionDeadlineAtMs,
        seal: expectedSeal,
        finalization: freeze(structuredClone(manifest)),
        audioTimeline: verifiedProjection.audioTimeline,
      }),
      evidenceReviewGrant: freeze(structuredClone(verifiedProjection.evidenceReviewGrant)),
    });
  }

  async *#replayManagedExportRecords(
    state: RuntimeState,
    path: string,
    expectedSummary: VerifiedSessionArtifactSummary,
    isCallbackActive: () => boolean,
  ): AsyncGenerator<EvidenceRecord> {
    if (!isCallbackActive()) throw new Error("Managed export lease is no longer active");
    // Recheck the full encrypted ledger for each replay. The artifact lock
    // remains held by the encompassing lease, so this protects against a
    // corrupted/torn archive without retaining a materialized record list.
    const replaySummary = (await this.#verifyArchiveForSealedLease(state, path)).summary;
    if (canonicalEvidenceJson(replaySummary) !== canonicalEvidenceJson(expectedSummary)) {
      throw new Error("Managed export artifact changed during its lease");
    }
    for await (const envelope of this.#iterateArchiveEnvelopes(state, path, false)) {
      if (!isCallbackActive()) throw new Error("Managed export lease is no longer active");
      if (envelope.kind !== "record") continue;
      yield freeze(structuredClone(envelope.record));
    }
  }

  #validateFinalizationManifestProjection(
    state: RuntimeState,
    manifest: SessionArtifactFinalizationManifest,
    projection: EvidenceLedgerProjection,
  ): void {
    if (
      manifest.schemaVersion !== FORMAT_VERSION ||
      manifest.kind !== "session_artifact_finalization" ||
      manifest.archiveId !== state.archiveId ||
      !isSha256(manifest.processingManifestSha256) ||
      !isSha256(manifest.reviewGrantSha256) ||
      manifest.processingManifestSha256 !== state.metadata.processingManifestSha256 ||
      manifest.recordCount !== projection.recordCount ||
      manifest.finalChainSha256 !== projection.finalChainSha256 ||
      !isSha256(manifest.manifestSha256)
    ) {
      throw new Error("Artifact finalization manifest is invalid");
    }
    const { manifestSha256, ...body } = manifest;
    if (evidenceSha256(body) !== manifestSha256) {
      throw new Error("Artifact finalization manifest digest is invalid");
    }
    try {
      validateSessionProcessingManifest(manifest.processingManifest);
      this.#validateEvidenceControls(manifest.processingManifest);
    } catch (error: unknown) {
      throw new Error(
        "Artifact processing manifest projection is invalid",
        { cause: error },
      );
    }
    if (manifest.processingManifest.manifestSha256 !== manifest.processingManifestSha256) {
      throw new Error("Artifact processing manifest projection is invalid");
    }
    if (
      canonicalEvidenceJson(manifest.processingManifest) !== canonicalEvidenceJson(projection.processingManifest) ||
      manifest.reviewGrantSha256 !== projection.reviewGrantSha256 ||
      canonicalEvidenceJson(manifest.trackDigests) !== canonicalEvidenceJson(projection.trackDigests) ||
      canonicalEvidenceJson(manifest.tracks) !== canonicalEvidenceJson(projection.tracks) ||
      canonicalEvidenceJson(manifest.consentReceiptRefs) !== canonicalEvidenceJson(projection.consentReceiptRefs)
    ) {
      throw new Error("Artifact finalization projection does not match evidence records");
    }
    const retention = state.metadata.retention;
    if (
      retention === undefined ||
      retention.finalizedAtMonoMs !== manifest.finalizedAtMonoMs ||
      retention.initialRetentionDeadlineAtMs !== manifest.retentionDeadlineAtMs ||
      retention.finalizedAtMs !== Date.parse(manifest.finalizedAtUtc) ||
      manifest.finalizedAtUtc !== new Date(retention.finalizedAtMs).toISOString() ||
      manifest.retentionDeadlineAt !== new Date(manifest.retentionDeadlineAtMs).toISOString() ||
      state.metadata.finalizationLastPersistedEventCursor !== projection.lastPersistedEventCursor
    ) {
      throw new Error("Artifact finalization retention projection is invalid");
    }
  }

  #retentionStatus(metadata: SessionArtifactMetadata): SessionRetentionStatus {
    const retention = metadata.retention;
    return freeze({
      status: metadata.phase,
      ...(retention === undefined ? {} : { retentionDeadlineAtMs: retention.retentionDeadlineAtMs }),
      extensionUsed: retention?.extensionUsed ?? false,
    });
  }

  #commandResult<T extends StoredCommandResult["result"]>(
    metadata: SessionArtifactMetadata,
    operation: StoredCommandResult["operation"],
    commandId: string,
    requestHmac: string,
  ): T | undefined {
    const commandIdHmac = opaqueHmac(this.#archiveIdKey, "command-id", commandId);
    const entry = metadata.commands.find(
      (candidate) => candidate.operation === operation && candidate.commandIdHmac === commandIdHmac,
    );
    if (entry === undefined) return undefined;
    if (entry.requestHmac !== requestHmac) {
      return freeze({ status: "conflict" }) as T;
    }
    return structuredClone(entry.result) as T;
  }

  async #artifact(lookup: SessionArtifactLookup): Promise<SessionArtifactDescriptor | undefined> {
    const archiveId = this.#archiveIdForLookup(lookup);
    const receipt = await this.#readDeletionReceipt(archiveId);
    if (receipt !== undefined) return undefined;
    let state: RuntimeState | undefined;
    try {
      state = await this.#loadStateByArchiveId(archiveId);
      await this.#recoverPendingRetentionExtension(state);
      const retention = state.metadata.retention;
      if (this.#isRetentionExpired(state.metadata)) return undefined;
      const archivePath = state.metadata.phase === "sealed"
        ? this.#archivePath(archiveId)
        : this.#spoolPath(archiveId);
      if (!(await this.#pathExists(archivePath))) return undefined;
      await this.#assertManagedFile(archivePath);
      return freeze({
        archiveId,
        archivePath,
        ...(retention === undefined ? {} : { retentionDeadlineAtMs: retention.retentionDeadlineAtMs }),
        status: state.metadata.phase,
      });
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    } finally {
      if (state !== undefined) this.#evictTerminalState(state);
    }
  }

  #deletionReceiptHmac(receipt: object): string {
    return opaqueHmac(
      this.#archiveIdKey,
      "deletion-receipt-body",
      canonicalEvidenceJson(receipt),
    );
  }

  #signDeletionReceipt(receipt: UnsignedDeletionReceipt): DeletionReceipt {
    return freeze({
      ...receipt,
      receiptHmac: this.#deletionReceiptHmac(receipt),
    });
  }

  #assertDeletionReceiptHmac(receipt: object): void {
    const entries = Object.entries(receipt);
    const receiptHmac = entries.find(([key]) => key === "receiptHmac")?.[1];
    if (!isSha256(receiptHmac)) {
      throw new Error("Deletion receipt integrity is invalid");
    }
    const expected = this.#deletionReceiptHmac(Object.fromEntries(
      entries.filter(([key]) => key !== "receiptHmac"),
    ));
    if (!timingSafeEqual(Buffer.from(receiptHmac, "hex"), Buffer.from(expected, "hex"))) {
      throw new Error("Deletion receipt integrity is invalid");
    }
  }

  async #readDeletionReceipt(archiveId: string): Promise<DeletionReceipt | undefined> {
    const path = this.#receiptPath(archiveId);
    const file = await this.#readBoundedManagedFile(
      path,
      MAX_DELETION_RECEIPT_BYTES,
      "Deletion receipt",
    );
    if (file === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.contents.toString("utf8"));
    } catch {
      throw new Error("Deletion receipt is corrupt");
    }
    if (!isPlainObject(parsed)) throw new Error("Deletion receipt is corrupt");
    // Authenticate the whole body before branching on status, deadline, or
    // governance fields. This keeps receipt tampering non-oracular.
    this.#assertDeletionReceiptHmac(parsed);
    const receipt = parsed as Partial<DeletionReceipt>;
    const finalizedAtMs = receipt.finalizedAtMs;
    const retentionDeadlineAtMs = receipt.retentionDeadlineAtMs;
    const startedAtMs = receipt.startedAtMs;
    const expectedKeys = [
      "archiveId",
      "auditCount",
      "auditHeadSha256",
      "auditIntegrity",
      "commandIdHmac",
      "deletionActorHmac",
      "deletionReasonHmac",
      "deletionReceiptId",
      "disposition",
      "encryptedLedgerSha256",
      "extensionUsed",
      "finalizationStatus",
      "finalizedAtMs",
      "kind",
      "managedExportRegistered",
      "processingManifestSha256",
      "processingProfileReferenceDigest",
      "processingProfileSha256",
      "receiptHmac",
      "requestHmac",
      "retentionDeadlineAtMs",
      "schemaVersion",
      "startedAtMs",
      "status",
      "verificationMaximumHours",
      ...(receipt.finalizationStatus === "sealed"
        ? ["finalSealSha256", "finalizationManifestSha256"]
        : ["finalizationFailureAudit", "finalizationFailureCode"]),
      ...(receipt.extensionUsed === true
        ? ["extensionApproval"]
        : []),
      ...(receipt.status === "completed"
        ? ["completedWithinVerificationMaximumHours", "deletedAtMs"]
        : []),
    ].sort();
    if (
      canonicalEvidenceJson(Object.keys(receipt).sort()) !== canonicalEvidenceJson(expectedKeys) ||
      receipt.schemaVersion !== FORMAT_VERSION ||
      receipt.kind !== "evidence_deletion_receipt" ||
      receipt.archiveId !== archiveId ||
      !isSha256(receipt.deletionReceiptId) ||
      !isSha256(receipt.commandIdHmac) ||
      !isSha256(receipt.requestHmac) ||
      !isSha256(receipt.deletionActorHmac) ||
      !isSha256(receipt.deletionReasonHmac) ||
      !isSha256(receipt.receiptHmac) ||
      (receipt.auditIntegrity !== "valid" && receipt.auditIntegrity !== "invalid") ||
      !isNonNegativeSafeInteger(receipt.auditCount) ||
      !isSha256(receipt.auditHeadSha256) ||
      (receipt.auditIntegrity === "invalid" && (
        receipt.auditCount !== 0 || receipt.auditHeadSha256 !== EMPTY_CHAIN_SHA256
      )) ||
      (receipt.disposition !== "early" && receipt.disposition !== "scheduled") ||
      typeof receipt.managedExportRegistered !== "boolean" ||
      !isNonNegativeSafeInteger(finalizedAtMs) ||
      !isNonNegativeSafeInteger(retentionDeadlineAtMs) ||
      retentionDeadlineAtMs < finalizedAtMs ||
      !isSha256(receipt.processingManifestSha256) ||
      !isSha256(receipt.processingProfileSha256) ||
      !isSha256(receipt.processingProfileReferenceDigest) ||
      (receipt.finalizationStatus !== "sealed" && receipt.finalizationStatus !== "FINALIZATION_FAILED") ||
      !isSha256(receipt.encryptedLedgerSha256) ||
      typeof receipt.extensionUsed !== "boolean" ||
      receipt.verificationMaximumHours !== 24 ||
      (receipt.status !== "pending" && receipt.status !== "completed") ||
      !isNonNegativeSafeInteger(startedAtMs)
    ) {
      throw new Error("Deletion receipt is invalid");
    }
    if (receipt.finalizationStatus === "sealed") {
      if (
        !isSha256(receipt.finalizationManifestSha256) ||
        !isSha256(receipt.finalSealSha256)
      ) {
        throw new Error("Sealed deletion receipt is invalid");
      }
    } else if (
      !isFinalizationFailureCode(receipt.finalizationFailureCode) ||
      !isFinalizationFailureAuditSource(receipt.finalizationFailureAudit)
    ) {
      throw new Error("Failed finalization deletion receipt is invalid");
    }
    if (receipt.extensionUsed) {
      const approval = receipt.extensionApproval;
      if (
        approval === undefined ||
        !isSha256(approval.commandIdHmac) ||
        !isSha256(approval.ownerIdHmac) ||
        !isSha256(approval.reasonHmac) ||
        !isNonNegativeSafeInteger(approval.approvedAtMs) ||
        !isNonNegativeSafeInteger(approval.requestedDeadlineAtMs) ||
        approval.requestedDeadlineAtMs !== receipt.retentionDeadlineAtMs
      ) {
        throw new Error("Deletion receipt extension approval is invalid");
      }
    }
    if (receipt.status === "completed") {
      const deletedAtMs = receipt.deletedAtMs;
      const completedWithinVerificationMaximumHours = receipt.completedWithinVerificationMaximumHours;
      if (
        !isNonNegativeSafeInteger(deletedAtMs) ||
        deletedAtMs < startedAtMs ||
        typeof completedWithinVerificationMaximumHours !== "boolean" ||
        completedWithinVerificationMaximumHours !== (
          deletedAtMs <= retentionDeadlineAtMs + receipt.verificationMaximumHours * HOUR_MS
        )
      ) {
        throw new Error("Completed deletion receipt is invalid");
      }
    }
    return freeze(receipt as DeletionReceipt);
  }

  async #writeDeletionReceipt(receipt: DeletionReceipt): Promise<void> {
    checkedArchiveId(receipt.archiveId);
    this.#assertDeletionReceiptHmac(receipt);
    await this.#ensureRoots();
    await this.#writeAtomic(this.#receiptPath(receipt.archiveId), JSON.stringify(receipt) + "\n");
  }

  async #registeredKeyArchiveIds(): Promise<readonly string[]> {
    await this.#ensureRoots();
    const names = await readdir(this.#keyDirectory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of names) {
      const match = /^([a-f0-9]{64})\.key\.json$/u.exec(entry.name);
      if (match === null) continue;
      const archiveId = match[1];
      if (archiveId === undefined) continue;
      const path = this.#keyPath(archiveId);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Registered key sidecar is not a regular file");
      }
      ids.push(archiveId);
    }
    return Object.freeze(ids.sort());
  }

  async #registeredReceiptArchiveIds(): Promise<readonly string[]> {
    await this.#ensureRoots();
    const names = await readdir(this.#receiptDirectory, { withFileTypes: true });
    const ids: string[] = [];
    for (const entry of names) {
      const match = /^([a-f0-9]{64})\.delete\.json$/u.exec(entry.name);
      if (match === null) continue;
      const archiveId = match[1];
      if (archiveId === undefined) continue;
      const path = this.#receiptPath(archiveId);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Registered deletion receipt is not a regular file");
      }
      ids.push(archiveId);
    }
    return Object.freeze(ids.sort());
  }

  async #registeredAuditArchiveIds(): Promise<readonly string[]> {
    await this.#ensureRoots();
    const names = await readdir(this.#receiptDirectory, { withFileTypes: true });
    const ids = new Set<string>();
    for (const entry of names) {
      const match = /^([a-f0-9]{64})\.audit(?:\.jsonl|\.head)\.enc$/u.exec(entry.name);
      if (match === null) continue;
      const archiveId = match[1];
      if (archiveId === undefined) continue;
      const path = join(this.#receiptDirectory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Registered evidence audit is not a regular file");
      }
      ids.add(archiveId);
    }
    return Object.freeze([...ids].sort());
  }

  async #registeredTemporaryArchiveIds(): Promise<readonly string[]> {
    await this.#ensureRoots();
    const scopes: readonly Readonly<{
      readonly directory: string;
      readonly suffixes: readonly string[];
    }>[] = [
      {
        directory: this.#archiveDirectory,
        suffixes: [".spool.enc", ".evidence.jsonl.enc", ".probe.enc"],
      },
      { directory: this.#keyDirectory, suffixes: [".key.json"] },
      { directory: this.#receiptDirectory, suffixes: [".delete.json", ".audit.head.enc"] },
    ];
    const archiveIds = new Set<string>();
    for (const scope of scopes) {
      const names = await readdir(scope.directory, { withFileTypes: true });
      for (const entry of names) {
        const match = /^([a-f0-9]{64})(\.(?:spool\.enc|evidence\.jsonl\.enc|probe\.enc|key\.json|delete\.json|audit\.head\.enc))\.([a-f0-9]{24})\.tmp$/u.exec(entry.name);
        if (match === null) continue;
        const archiveId = match[1];
        const suffix = match[2];
        if (archiveId === undefined || suffix === undefined || !scope.suffixes.includes(suffix)) continue;
        const path = join(scope.directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error("Registered artifact temporary is not a regular file");
        }
        archiveIds.add(archiveId);
      }
    }
    return Object.freeze([...archiveIds].sort());
  }

  async #removeLockMarkerTemporaries(): Promise<void> {
    const entries = await readdir(this.#keyDirectory, { withFileTypes: true });
    let removed = false;
    for (const entry of entries) {
      if (!/^(?:evidence-root|[a-f0-9]{64})\.lifecycle\.lock\.[a-f0-9]{24}\.tmp$/u.test(entry.name)) {
        continue;
      }
      const path = join(this.#keyDirectory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error("Lifecycle lock temporary is not a regular file");
      }
      await unlink(path);
      removed = true;
    }
    if (removed) await this.#syncDirectory(this.#keyDirectory);
  }

  async #removeDerivedTemporaryArtifacts(archiveId: string): Promise<void> {
    checkedArchiveId(archiveId);
    const scopes: readonly Readonly<{
      readonly directory: string;
      readonly suffixes: readonly string[];
    }>[] = [
      {
        directory: this.#archiveDirectory,
        suffixes: [".spool.enc", ".evidence.jsonl.enc", ".probe.enc"],
      },
      { directory: this.#keyDirectory, suffixes: [".key.json"] },
      { directory: this.#receiptDirectory, suffixes: [".delete.json", ".audit.head.enc"] },
    ];
    for (const scope of scopes) {
      const names = await readdir(scope.directory, { withFileTypes: true });
      let removed = false;
      for (const entry of names) {
        const match = /^([a-f0-9]{64})(\.(?:spool\.enc|evidence\.jsonl\.enc|probe\.enc|key\.json|delete\.json|audit\.head\.enc))\.([a-f0-9]{24})\.tmp$/u.exec(entry.name);
        if (match === null || match[1] !== archiveId || match[2] === undefined || !scope.suffixes.includes(match[2])) {
          continue;
        }
        const path = join(scope.directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error("Managed artifact temporary is not a regular file");
        }
        await unlink(path);
        removed = true;
      }
      if (removed) await this.#syncDirectory(scope.directory);
    }
  }

  async #safeRemoveFile(path: string): Promise<void> {
    if (!(await this.#pathExists(path))) return;
    await this.#assertManagedFile(path);
    await unlink(path);
    await this.#syncDirectory(dirname(path));
  }

  async #safeRemoveExportDirectory(archiveId: string): Promise<void> {
    const path = this.#exportPath(archiveId);
    if (!(await this.#pathExists(path))) return;
    const root = resolve(this.#exportDirectory);
    const target = resolve(path);
    if (!isNestedOrEqual(root, target) || target === root || target !== join(root, archiveId)) {
      throw new Error("Managed export path escapes its security root");
    }
    await this.#assertSafeTree(path);
    await rm(path, { recursive: true, force: false, maxRetries: 0 });
    await this.#syncDirectory(this.#exportDirectory);
  }

  async #assertSafeTree(path: string): Promise<void> {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("Managed artifact tree contains a symbolic link");
    if (info.isFile()) return;
    if (!info.isDirectory()) throw new Error("Managed artifact tree has an unsupported entry");
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Managed artifact tree contains a symbolic link");
      if (!entry.isFile() && !entry.isDirectory()) {
        throw new Error("Managed artifact tree has an unsupported entry");
      }
      await this.#assertSafeTree(child);
    }
  }

  /**
   * The receipt is durable before this method runs. The key sidecar is removed
   * first (cryptographic erase), then only paths derived from the registered
   * 64-hex archive ID are touched.
   */
  async #createPendingDeletionReceipt(
    state: RuntimeState,
    input: PendingDeletionReceiptInput,
  ): Promise<DeletionReceipt> {
    const retention = state.metadata.retention;
    const finalization = state.metadata.finalization;
    const seal = state.metadata.seal;
    const isSealed = state.metadata.phase === "sealed";
    const isFinalizationFailure = state.metadata.phase === "FINALIZATION_FAILED";
    if ((!isSealed && !isFinalizationFailure) || retention === undefined) {
      throw new Error("Only a terminal artifact can receive a deletion receipt");
    }
    if (
      !Number.isSafeInteger(input.startedAtMs) ||
      input.startedAtMs < 0 ||
      input.commandId.trim().length === 0 ||
      input.actorId.trim().length === 0 ||
      input.reason.trim().length === 0
    ) {
      throw new Error("Deletion receipt input is invalid");
    }
    const extensionApproval = state.metadata.extensionApproval;
    if (retention.extensionUsed !== (extensionApproval !== undefined)) {
      throw new Error("Deletion receipt extension audit does not match retention state");
    }
    const audit = await this.#auditIntegritySnapshot(state.archiveId, true);
    const receipt = {
      schemaVersion: FORMAT_VERSION,
      kind: "evidence_deletion_receipt" as const,
      archiveId: state.archiveId,
      deletionReceiptId: opaqueHmac(
        this.#archiveIdKey,
        "deletion-receipt",
        state.archiveId + "\u0000" + input.commandId,
      ),
      commandIdHmac: opaqueHmac(this.#archiveIdKey, "command-id", input.commandId),
      requestHmac: input.requestHmac,
      deletionActorHmac: opaqueHmac(this.#archiveIdKey, "deletion-actor", input.actorId),
      deletionReasonHmac: opaqueHmac(this.#archiveIdKey, "deletion-reason", input.reason),
      disposition: input.disposition,
      managedExportRegistered: state.metadata.managedExport !== undefined,
      auditIntegrity: audit.integrity,
      auditCount: audit.count,
      auditHeadSha256: audit.headSha256,
      finalizedAtMs: retention.finalizedAtMs,
      retentionDeadlineAtMs: retention.retentionDeadlineAtMs,
      extensionUsed: retention.extensionUsed,
      ...(extensionApproval === undefined ? {} : { extensionApproval }),
      status: "pending" as const,
      startedAtMs: input.startedAtMs,
    };
    if (isSealed) {
      if (finalization === undefined || seal === undefined) {
        throw new Error("Sealed deletion receipt is missing its finalization projection");
      }
      try {
        validateSessionProcessingManifest(finalization.processingManifest);
        this.#validateEvidenceControls(finalization.processingManifest);
      } catch (error: unknown) {
        throw new Error("Deletion receipt requires a verified processing manifest", { cause: error });
      }
      if (
        finalization.processingManifestSha256 !== state.metadata.processingManifestSha256 ||
        finalization.processingManifest.manifestSha256 !== finalization.processingManifestSha256 ||
        !isSha256(finalization.manifestSha256) ||
        !isSha256(seal.sealSha256) ||
        !isSha256(seal.finalChainSha256)
      ) {
        throw new Error("Deletion receipt requires a sealed finalization projection");
      }
      return this.#signDeletionReceipt({
        ...receipt,
        processingManifestSha256: finalization.processingManifestSha256,
        processingProfileSha256: finalization.processingManifest.profile.sha256,
        processingProfileReferenceDigest: this.#processingProfileReferenceDigest(finalization.processingManifest),
        finalizationStatus: "sealed" as const,
        finalizationManifestSha256: finalization.manifestSha256,
        finalSealSha256: seal.sealSha256,
        encryptedLedgerSha256: await this.#sha256File(this.#archivePath(state.archiveId)),
        verificationMaximumHours: finalization.processingManifest.retentionPolicy.verificationMaximumHours,
      });
    }
    const processingManifestSha256 = state.metadata.processingManifestSha256;
    const processingProfileSha256 = state.metadata.processingProfileSha256;
    const processingProfileReferenceDigest = state.metadata.processingProfileReferenceDigest;
    const finalizationFailureCode = state.metadata.finalizationFailureCode;
    const finalizationFailureAudit = state.metadata.finalizationFailureAudit ?? "unverified_immediate";
    if (
      !isSha256(processingManifestSha256) ||
      !isSha256(processingProfileSha256) ||
      !isSha256(processingProfileReferenceDigest) ||
      !isFinalizationFailureCode(finalizationFailureCode) ||
      !isFinalizationFailureAuditSource(finalizationFailureAudit)
    ) {
      throw new Error("Failed finalization lacks a durable deletion audit projection");
    }
    const spoolPath = this.#spoolPath(state.archiveId);
    const archivePath = this.#archivePath(state.archiveId);
    const ledgerPath = await this.#pathExists(spoolPath)
      ? spoolPath
      : await this.#pathExists(archivePath)
        ? archivePath
        : undefined;
    return this.#signDeletionReceipt({
      ...receipt,
      processingManifestSha256,
      processingProfileSha256,
      processingProfileReferenceDigest,
      finalizationStatus: "FINALIZATION_FAILED" as const,
      finalizationFailureCode,
      finalizationFailureAudit,
      encryptedLedgerSha256: ledgerPath === undefined
        ? EMPTY_LEDGER_SHA256
        : await this.#sha256File(ledgerPath),
      verificationMaximumHours: 24 as const,
    });
  }

  #completeDeletionReceipt(
    receipt: DeletionReceipt,
    deletedAtMs: number,
    audit: AuditIntegritySnapshot,
  ): DeletionReceipt {
    if (!Number.isSafeInteger(deletedAtMs) || deletedAtMs < 0) {
      throw new Error("Deletion completion clock is invalid");
    }
    // The pending receipt is durable before erasure. A rollback after that
    // point must not leave a syntactically invalid completed tombstone once
    // ciphertext is gone, so completion is never earlier than its request.
    const completedAtMs = Math.max(deletedAtMs, receipt.startedAtMs);
    const { receiptHmac: _receiptHmac, ...unsigned } = receipt;
    return this.#signDeletionReceipt({
      ...unsigned,
      auditIntegrity: audit.integrity,
      auditCount: audit.count,
      auditHeadSha256: audit.headSha256,
      status: "completed" as const,
      deletedAtMs: completedAtMs,
      completedWithinVerificationMaximumHours:
        completedAtMs <= receipt.retentionDeadlineAtMs + receipt.verificationMaximumHours * HOUR_MS,
    });
  }

  /**
   * Finishes a receipt that was made durable before cryptographic erasure.
   * Callers already hold the per-artifact lifecycle lock, so a retry cannot
   * race new evidence, finalization, export, delete, or retention sweep work.
   */
  async #completePendingDeletionLocked(receipt: DeletionReceipt): Promise<EvidenceDeletionResult> {
    if (receipt.status !== "pending") {
      throw new Error("Only a pending deletion receipt can be completed");
    }
    const archiveId = checkedArchiveId(receipt.archiveId);
    this.#pendingDeletionArchiveIds.add(archiveId);
    try {
      await this.#removeManagedArtifacts(archiveId, true, receipt.managedExportRegistered);
      await this.#appendDeletionCompletionAudit(receipt).catch(() => undefined);
      const audit = await this.#auditIntegritySnapshot(archiveId, true);
      const completed = this.#completeDeletionReceipt(receipt, this.#now(), audit);
      await this.#writeDeletionReceipt(completed);
      this.#pendingDeletionArchiveIds.delete(archiveId);
      this.#zeroizeAndForgetState(archiveId);
      return freeze({ status: "completed", deletionReceiptId: receipt.deletionReceiptId });
    } catch (error: unknown) {
      // The durable pending receipt is intentionally retained. It prevents
      // resurrection and makes the next locked owner/sweep/recovery attempt
      // resume cleanup without reconstructing any evidence state.
      this.#pendingDeletionArchiveIds.add(archiveId);
      throw error;
    }
  }

  async #removeManagedArtifacts(
    archiveId: string,
    eraseKeySidecar: boolean,
    managedExportRegistered: boolean,
  ): Promise<void> {
    checkedArchiveId(archiveId);
    if (eraseKeySidecar) await this.#safeRemoveFile(this.#keyPath(archiveId));
    await this.#safeRemoveFile(this.#spoolPath(archiveId));
    await this.#safeRemoveFile(this.#archivePath(archiveId));
    await this.#safeRemoveFile(this.#probePath(archiveId));
    if (managedExportRegistered) await this.#safeRemoveExportDirectory(archiveId);
    await this.#removeDerivedTemporaryArtifacts(archiveId);
  }

  async #createManagedExportDirectory(path: string): Promise<void> {
    const target = resolve(path);
    const root = resolve(this.#exportDirectory);
    const archiveId = target.slice(root.length + 1);
    checkedArchiveId(archiveId);
    if (target !== join(root, archiveId) || !isNestedOrEqual(root, target)) {
      throw new Error("Managed export workspace escapes its security root");
    }
    if (await this.#pathExists(target)) {
      throw new Error("Managed export workspace already exists before registration");
    }
    await mkdir(target, { recursive: false, mode: 0o700 });
    const created = await lstat(target);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("Managed export workspace is not a real directory");
    }
    await this.#syncDirectory(this.#exportDirectory);
  }

  async #loadSweepHealth(): Promise<void> {
    const path = this.#sweepHealthPath();
    const file = await this.#readBoundedManagedFile(
      path,
      MAX_SWEEP_HEALTH_BYTES,
      "Retention sweep health file",
    );
    if (file === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.contents.toString("utf8"));
    } catch {
      throw new Error("Retention sweep health file is corrupt");
    }
    if (parsed === null || typeof parsed !== "object") throw new Error("Retention sweep health file is corrupt");
    const health = parsed as Partial<SweepHealthFile>;
    if (
      health.schemaVersion !== FORMAT_VERSION ||
      health.kind !== "retention_sweep_health" ||
      !Number.isFinite(health.lastSuccessfulSweepAtMs)
    ) {
      throw new Error("Retention sweep health file is invalid");
    }
    this.#lastSuccessfulSweepAtMs = health.lastSuccessfulSweepAtMs;
  }

  async #writeSweepHealth(lastSuccessfulSweepAtMs: number): Promise<void> {
    const health: SweepHealthFile = freeze({
      schemaVersion: FORMAT_VERSION,
      kind: "retention_sweep_health",
      lastSuccessfulSweepAtMs,
    });
    await this.#writeAtomic(this.#sweepHealthPath(), JSON.stringify(health) + "\n");
  }
}

function checkedRoot(value: string, name: string): string {
  if (value.trim().length === 0) throw new RangeError(name + " is required");
  return resolve(value);
}

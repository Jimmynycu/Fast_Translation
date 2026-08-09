import type {
  EvidenceAudioTrack,
  EvidenceRecorderPreflightRecord,
  EventCursor,
} from "./types.js";
import type { RetentionPolicy } from "./processing-profile.js";

export interface RecorderPreflightRequest {
  readonly sessionId: string;
  readonly processingManifestSha256: string;
  readonly checkedAtMonoMs: number;
}

const RECORDER_PREFLIGHT_FAILURE_CODES = [
  "free_space_unavailable",
  "insufficient_evidence_disk",
  "evidence_preflight_failed",
  "evidence_preflight_integrity_failed",
] as const;

export type RecorderPreflightFailureCode = (typeof RECORDER_PREFLIGHT_FAILURE_CODES)[number];

export type RecorderPreflightResult =
  | Readonly<{
      readonly status: "ready";
      readonly sessionId: string;
      readonly processingManifestSha256: string;
      readonly preflightId: string;
      readonly checkedAtMonoMs: number;
      readonly requiredFreeBytes: string;
      readonly availableFreeBytes: string;
      readonly tracks: readonly EvidenceAudioTrack[];
      readonly manifestSha256: string;
      readonly encryptedSpoolSha256: string;
      readonly sealedRecordCount: number;
      readonly sealSha256: string;
    }>
  | Readonly<{
      readonly status: "failed";
      readonly sessionId: string;
      readonly processingManifestSha256: string;
      readonly checkedAtMonoMs: number;
      readonly failureCode: RecorderPreflightFailureCode;
    }>;

export interface EvidenceFinalizeRequest {
  readonly sessionId: string;
  readonly processingManifestSha256: string;
  readonly finalizedAtMonoMs: number;
  readonly reason: string;
  readonly lastPersistedEventCursor: EventCursor;
  /**
   * Relay-owned cancellation fence for bounded terminal finalization. The
   * signal is intentionally process-local and is never serialized into the
   * evidence envelope.
   */
  readonly abortSignal?: AbortSignal;
}

export interface FinalizedTrackDigest {
  readonly sha256: string;
  readonly frameCount: number;
  readonly byteCount: number;
}

export type EvidenceFinalizationFailureCode =
  | "seal_write_failed"
  | "integrity_verification_failed"
  | "manifest_write_failed";

export type EvidenceFinalization =
  | Readonly<{
      readonly status: "sealed";
      readonly sessionId: string;
      readonly processingManifestSha256: string;
      readonly manifestSha256: string;
      readonly encryptedLedgerSha256: string;
      readonly finalChainSha256: string;
      readonly recordCount: number;
      readonly finalizedAtUtc: string;
      readonly retentionDeadlineAt: string;
      readonly tracks: Readonly<Record<EvidenceAudioTrack, FinalizedTrackDigest>>;
    }>
  | Readonly<{
      readonly status: "FINALIZATION_FAILED";
      readonly sessionId: string;
      readonly processingManifestSha256: string;
      readonly failureCode: EvidenceFinalizationFailureCode;
      readonly recovery: "rebuild_from_spool" | "quarantine_delete_rerun";
    }>;

export interface EvidenceFinalizationExpectation {
  readonly sessionId: string;
  readonly processingManifestSha256: string;
  readonly retentionPolicy: RetentionPolicy;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/u;
const EXPECTED_TRACKS: readonly EvidenceAudioTrack[] = [
  "source_a",
  "source_b",
  "playout_to_a",
  "playout_to_b",
];

function assertNonempty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

function assertMono(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be a non-negative finite number`);
}

function assertExactTracks(tracks: readonly EvidenceAudioTrack[]): void {
  if (JSON.stringify(tracks) !== JSON.stringify(EXPECTED_TRACKS)) {
    throw new TypeError("Recorder preflight must verify exactly the four required tracks");
  }
}

export function validateRecorderPreflightRequest(request: RecorderPreflightRequest): void {
  assertNonempty(request.sessionId, "sessionId");
  assertSha256(request.processingManifestSha256, "processingManifestSha256");
  assertMono(request.checkedAtMonoMs, "checkedAtMonoMs");
}

export function validateRecorderPreflightResult(result: RecorderPreflightResult): void {
  validateRecorderPreflightRequest(result);
  if (result.status === "failed") {
    if (!RECORDER_PREFLIGHT_FAILURE_CODES.includes(result.failureCode)) {
      throw new TypeError("Recorder preflight failure is invalid");
    }
    return;
  }
  if (result.status !== "ready") throw new TypeError("Unsupported recorder preflight status");
  assertNonempty(result.preflightId, "preflightId");
  if (!DECIMAL_PATTERN.test(result.requiredFreeBytes) || !DECIMAL_PATTERN.test(result.availableFreeBytes)) {
    throw new TypeError("Recorder preflight free-space values must be decimal strings");
  }
  if (BigInt(result.availableFreeBytes) < BigInt(result.requiredFreeBytes)) {
    throw new TypeError("Recorder preflight available space is below the required minimum");
  }
  assertExactTracks(result.tracks);
  assertSha256(result.manifestSha256, "manifestSha256");
  assertSha256(result.encryptedSpoolSha256, "encryptedSpoolSha256");
  assertSha256(result.sealSha256, "sealSha256");
  if (!Number.isSafeInteger(result.sealedRecordCount) || result.sealedRecordCount < 1) {
    throw new TypeError("sealedRecordCount must be a positive safe integer");
  }
}

export function validateEvidenceRecorderPreflightRecord(record: EvidenceRecorderPreflightRecord): void {
  assertNonempty(record.sessionId, "record.sessionId");
  assertMono(record.timestampMonoMs, "record.timestampMonoMs");
  validateRecorderPreflightResult(record.preflight);
  if (record.preflight.sessionId !== record.sessionId) {
    throw new TypeError("Preflight sessionId does not match record sessionId");
  }
}

export function validateEvidenceFinalizeRequest(request: EvidenceFinalizeRequest): void {
  assertNonempty(request.sessionId, "sessionId");
  assertSha256(request.processingManifestSha256, "processingManifestSha256");
  assertMono(request.finalizedAtMonoMs, "finalizedAtMonoMs");
  assertNonempty(request.reason, "reason");
  if (!Number.isSafeInteger(request.lastPersistedEventCursor) || request.lastPersistedEventCursor < 0) {
    throw new TypeError("lastPersistedEventCursor must be a non-negative safe integer");
  }
  if (
    request.abortSignal !== undefined &&
    (typeof request.abortSignal !== "object" ||
      request.abortSignal === null ||
      typeof request.abortSignal.aborted !== "boolean" ||
      typeof request.abortSignal.addEventListener !== "function")
  ) {
    throw new TypeError("abortSignal must be an AbortSignal when provided");
  }
  if ("retentionDeadlineAt" in (request as unknown as Record<string, unknown>)) {
    throw new TypeError("Retention deadline is created only during finalization");
  }
}

export function validateEvidenceFinalization(
  finalization: EvidenceFinalization,
  expected: EvidenceFinalizationExpectation,
): void {
  assertNonempty(expected.sessionId, "expected.sessionId");
  assertSha256(expected.processingManifestSha256, "expected.processingManifestSha256");
  assertNonempty(finalization.sessionId, "finalization.sessionId");
  assertSha256(finalization.processingManifestSha256, "finalization.processingManifestSha256");
  if (
    finalization.sessionId !== expected.sessionId ||
    finalization.processingManifestSha256 !== expected.processingManifestSha256
  ) {
    throw new TypeError("Evidence finalization does not match the session processing manifest");
  }
  if (finalization.status === "FINALIZATION_FAILED") {
    if (
      !(["seal_write_failed", "integrity_verification_failed", "manifest_write_failed"] as const)
        .includes(finalization.failureCode) ||
      !(["rebuild_from_spool", "quarantine_delete_rerun"] as const).includes(finalization.recovery)
    ) {
      throw new TypeError("Evidence finalization failure is invalid");
    }
    return;
  }
  if (finalization.status !== "sealed") throw new TypeError("Unsupported evidence finalization status");
  assertSha256(finalization.manifestSha256, "manifestSha256");
  assertSha256(finalization.encryptedLedgerSha256, "encryptedLedgerSha256");
  assertSha256(finalization.finalChainSha256, "finalChainSha256");
  if (!Number.isSafeInteger(finalization.recordCount) || finalization.recordCount < 1) {
    throw new TypeError("recordCount must be a positive safe integer");
  }
  for (const field of ["finalizedAtUtc", "retentionDeadlineAt"] as const) {
    const value = finalization[field];
    if (!value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
      throw new TypeError(`${field} must be a canonical UTC timestamp`);
    }
  }
  const finalizedAtMs = Date.parse(finalization.finalizedAtUtc);
  const retentionDeadlineAtMs = Date.parse(finalization.retentionDeadlineAt);
  const expectedRetentionMs = expected.retentionPolicy.defaultDays * 24 * 60 * 60 * 1_000;
  if (retentionDeadlineAtMs - finalizedAtMs !== expectedRetentionMs) {
    throw new TypeError("Evidence finalization retention deadline does not match the approved policy");
  }
  for (const track of EXPECTED_TRACKS) {
    const digest = finalization.tracks[track];
    assertSha256(digest.sha256, `tracks.${track}.sha256`);
    if (!Number.isSafeInteger(digest.frameCount) || digest.frameCount < 0) {
      throw new TypeError(`tracks.${track}.frameCount must be a non-negative safe integer`);
    }
    if (!Number.isSafeInteger(digest.byteCount) || digest.byteCount < 0) {
      throw new TypeError(`tracks.${track}.byteCount must be a non-negative safe integer`);
    }
  }
}

import { createHash } from "node:crypto";
import {
  validateEvidenceFinalization,
  validateEvidenceFinalizeRequest,
  validateRecorderPreflightRequest,
  validateRecorderPreflightResult,
  type EvidenceFinalization,
  type EvidenceFinalizeRequest,
  type RecorderPreflightRequest,
  type RecorderPreflightResult,
} from "../../core/evidence-lifecycle.js";
import {
  EVIDENCE_AUDIO_TRACKS,
  type EvidenceAudioTrack,
} from "../../core/types.js";
import type { RetentionPolicy } from "../../core/processing-profile.js";

type SessionEvidence = Readonly<{ readonly sessionId: string }> & object;

const SYNTHETIC_PREFLIGHT_ID = "synthetic-in-memory-preflight-v1";
const SYNTHETIC_RETENTION_POLICY_SHA256 =
  "ad32c420501e03fce574fc92ccfa340aeabf97ca115cdc7c39f713a2cb4bd3e8";
const SYNTHETIC_EVIDENCE_DIGEST_DOMAIN =
  "fast-translation:test-only:in-memory-evidence:v1";
const SYNTHETIC_RETENTION_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
const SYNTHETIC_RETENTION_POLICY: RetentionPolicy = Object.freeze({
  policyRef: Object.freeze({
    id: "synthetic-in-memory-retention-policy",
    revision: "v1",
    sha256: SYNTHETIC_RETENTION_POLICY_SHA256,
    approvedBy: "test-only",
    approvedAtUtc: "1970-01-01T00:00:00.000Z",
  }),
  mode: "scheduled_delete",
  defaultDays: 14,
  maximumDays: 30,
  verificationMaximumHours: 24,
});

interface SyntheticAudioRecord extends SessionEvidence {
  readonly type: "audio";
  readonly track: EvidenceAudioTrack;
  readonly frame: Readonly<{ readonly pcm16le: Uint8Array }>;
}

type CanonicalEvidenceScalar = null | boolean | number | string;
interface CanonicalEvidenceArray extends ReadonlyArray<CanonicalEvidenceValue> {}
interface CanonicalEvidenceObject {
  readonly [key: string]: CanonicalEvidenceValue;
}
type CanonicalEvidenceValue =
  | CanonicalEvidenceScalar
  | CanonicalEvidenceArray
  | CanonicalEvidenceObject;

function canonicalEvidenceValue(value: unknown): CanonicalEvidenceValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Evidence digest input must be finite");
    return value;
  }
  if (value instanceof Uint8Array) {
    return Object.freeze({
      $uint8arrayBase64: Buffer.from(value).toString("base64"),
    });
  }
  if (Array.isArray(value)) return Object.freeze(value.map(canonicalEvidenceValue));
  if (typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalEvidenceValue(entry)]),
    ));
  }
  throw new TypeError("Evidence digest input must be canonical JSON-compatible data");
}

function syntheticContentSha256(kind: string, value: unknown): string {
  return createHash("sha256")
    .update(`${SYNTHETIC_EVIDENCE_DIGEST_DOMAIN}:${kind}\n`, "utf8")
    .update(JSON.stringify(canonicalEvidenceValue(value)), "utf8")
    .digest("hex");
}

function isSyntheticAudioRecord(record: SessionEvidence): record is SyntheticAudioRecord {
  const candidate = record as Partial<SyntheticAudioRecord>;
  if (candidate.type !== "audio") return false;
  return (
    EVIDENCE_AUDIO_TRACKS.includes(candidate.track as EvidenceAudioTrack) &&
    candidate.frame?.pcm16le instanceof Uint8Array
  );
}

function requiresRecorderPreflight(record: SessionEvidence): boolean {
  const type = (record as Readonly<{ type?: unknown }>).type;
  return type === "audio" || type === "recorder_track_armed";
}

function syntheticFinalizationFailure(request: EvidenceFinalizeRequest): EvidenceFinalization {
  return Object.freeze({
    status: "FINALIZATION_FAILED" as const,
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    failureCode: "integrity_verification_failed" as const,
    recovery: "rebuild_from_spool" as const,
  });
}

function finalizationAborted(request: EvidenceFinalizeRequest): boolean {
  return request.abortSignal?.aborted === true;
}

/**
 * Test-only, keyless evidence port. Its receipt digests are content-bound to
 * virtual records, but it does not claim encrypted persistence, disk capacity,
 * four-track capture coverage, or a production evidence receipt.
 */
export class InMemoryEvidenceStore<T extends SessionEvidence> {
  readonly #records: T[] = [];
  readonly #preflights = new Map<string, RecorderPreflightResult>();
  readonly #finalizations = new Map<string, EvidenceFinalization>();
  readonly #capacity: number;

  constructor(capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive safe integer");
    }
    this.#capacity = capacity;
  }

  async persist(record: T): Promise<void> {
    if (record.sessionId.trim().length === 0) {
      throw new Error("Evidence sessionId is required");
    }
    if (this.#finalizations.has(record.sessionId)) {
      throw new Error("Cannot persist evidence after finalization");
    }
    if (
      requiresRecorderPreflight(record) &&
      this.#preflights.get(record.sessionId)?.status !== "ready"
    ) {
      throw new Error("Recorder preflight must succeed before persisting audio evidence");
    }
    if (this.#records.length >= this.#capacity) {
      throw new Error("In-memory evidence capacity is exhausted");
    }
    this.#records.push(structuredClone(record));
  }

  async flush(_sessionId: string): Promise<void> {}

  async preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    validateRecorderPreflightRequest(request);
    const existing = this.#preflights.get(request.sessionId);
    if (existing !== undefined) {
      if (
        existing.status === "ready" &&
        existing.processingManifestSha256 === request.processingManifestSha256
      ) {
        return existing;
      }
      return Object.freeze({
        status: "failed" as const,
        sessionId: request.sessionId,
        processingManifestSha256: request.processingManifestSha256,
        checkedAtMonoMs: request.checkedAtMonoMs,
        failureCode: "evidence_preflight_integrity_failed" as const,
      });
    }
    const manifestSha256 = request.processingManifestSha256;
    const encryptedSpoolSha256 = syntheticContentSha256("spool", {
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
    });
    const preflightBody = {
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      preflightId: SYNTHETIC_PREFLIGHT_ID,
      checkedAtMonoMs: request.checkedAtMonoMs,
      requiredFreeBytes: "0",
      availableFreeBytes: "0",
      tracks: Object.freeze([...EVIDENCE_AUDIO_TRACKS]),
      manifestSha256,
      encryptedSpoolSha256,
      sealedRecordCount: 1,
    };
    const result: RecorderPreflightResult = Object.freeze({
      status: "ready" as const,
      ...preflightBody,
      sealSha256: syntheticContentSha256("preflight-seal", preflightBody),
    });
    validateRecorderPreflightResult(result);
    this.#preflights.set(request.sessionId, result);
    return result;
  }

  async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    validateEvidenceFinalizeRequest(request);
    // Relay finalization is cancellable: never create a sealed result after
    // the caller's terminal timeout fence has fired.
    if (finalizationAborted(request)) {
      return syntheticFinalizationFailure(request);
    }
    const existing = this.#finalizations.get(request.sessionId);
    if (existing !== undefined) return existing;

    const preflight = this.#preflights.get(request.sessionId);
    if (
      preflight?.status !== "ready" ||
      preflight.processingManifestSha256 !== request.processingManifestSha256
    ) {
      return syntheticFinalizationFailure(request);
    }

    const records = this.records(request.sessionId);
    if (records.length === 0) return syntheticFinalizationFailure(request);
    const tracks = Object.fromEntries(
      EVIDENCE_AUDIO_TRACKS.map((track) => {
        const audio = records.filter(
          (record): record is T & SyntheticAudioRecord => isSyntheticAudioRecord(record) && record.track === track,
        );
        return [track, Object.freeze({
          sha256: syntheticContentSha256("track", {
            sessionId: request.sessionId,
            processingManifestSha256: request.processingManifestSha256,
            track,
            records: audio,
          }),
          frameCount: audio.length,
          byteCount: audio.reduce((total, record) => total + record.frame.pcm16le.byteLength, 0),
        })];
      }),
    ) as Record<EvidenceAudioTrack, Readonly<{ sha256: string; frameCount: number; byteCount: number }>>;
    const finalizedAtUtc = new Date(request.finalizedAtMonoMs).toISOString();
    const retentionDeadlineAt = new Date(
      request.finalizedAtMonoMs + SYNTHETIC_RETENTION_DURATION_MS,
    ).toISOString();
    const encryptedLedgerSha256 = syntheticContentSha256("ledger", {
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      records,
    });
    const finalizationBody = {
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      manifestSha256: request.processingManifestSha256,
      preflightId: preflight.preflightId,
      preflightSealSha256: preflight.sealSha256,
      encryptedLedgerSha256,
      recordCount: records.length,
      finalizedAtUtc,
      retentionDeadlineAt,
      reason: request.reason,
      lastPersistedEventCursor: request.lastPersistedEventCursor,
      tracks,
    };
    const result: EvidenceFinalization = Object.freeze({
      status: "sealed",
      sessionId: finalizationBody.sessionId,
      processingManifestSha256: finalizationBody.processingManifestSha256,
      manifestSha256: finalizationBody.manifestSha256,
      encryptedLedgerSha256: finalizationBody.encryptedLedgerSha256,
      finalChainSha256: syntheticContentSha256("finalization", finalizationBody),
      recordCount: finalizationBody.recordCount,
      finalizedAtUtc: finalizationBody.finalizedAtUtc,
      retentionDeadlineAt: finalizationBody.retentionDeadlineAt,
      tracks: Object.freeze(tracks),
    });
    validateEvidenceFinalization(result, {
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      retentionPolicy: SYNTHETIC_RETENTION_POLICY,
    });
    if (finalizationAborted(request)) {
      return syntheticFinalizationFailure(request);
    }
    this.#finalizations.set(request.sessionId, result);
    return result;
  }

  records(sessionId?: string): readonly T[] {
    const records =
      sessionId === undefined
        ? this.#records
        : this.#records.filter((record) => record.sessionId === sessionId);
    return Object.freeze(records.map((record) => structuredClone(record)));
  }
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { CANONICAL_AUDIO } from "../../core/audio.js";
import { EVIDENCE_AUDIO_TRACKS } from "../../core/types.js";
import type {
  EvidenceAudioTrack,
  EvidenceRecord,
  SessionEvent,
} from "../../core/types.js";

export const EVIDENCE_REVIEW_DEFAULT_PAGE_SIZE = 50;
export const EVIDENCE_REVIEW_MINIMUM_PAGE_SIZE = 1;
export const EVIDENCE_REVIEW_MAXIMUM_PAGE_SIZE = 100;
export const EVIDENCE_REVIEW_MINIMUM_AUDIO_DURATION_MS = 20;
export const EVIDENCE_REVIEW_MAXIMUM_AUDIO_DURATION_MS = 30_000;
export const EVIDENCE_REVIEW_AUDIO_ALIGNMENT_MS = 20;
export const EVIDENCE_REVIEW_MAXIMUM_MONO_WAV_BYTES = 1_440_044;
/** Maximum opaque glossary entry IDs in one projected provenance record. */
export const EVIDENCE_REVIEW_MAXIMUM_GLOSSARY_PROVENANCE_ENTRY_IDS = 100;
/** Maximum combined UTF-8 bytes for projected glossary provenance entry IDs. */
export const EVIDENCE_REVIEW_MAXIMUM_GLOSSARY_PROVENANCE_ENTRY_IDS_UTF8_BYTES = 8 * 1024;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const OPAQUE_AUDIT_ID = /^[A-Za-z0-9_-]{1,256}$/u;
const CURSOR_TOKEN = /^[A-Za-z0-9_-]{1,512}$/u;
const CURSOR_VERSION = 1 as const;
const CURSOR_PREFIX = "evidence-review-v1";
const CURSOR_AAD = Buffer.from("fast-translation/evidence-review/cursor/aes-gcm/v1", "utf8");
const CURSOR_KEY_INFO = Buffer.from("fast-translation/evidence-review/cursor/key/v1", "utf8");
const RESPONSE_HASH_CONTEXT = "fast-translation/evidence-review/response/v1\0";
const MAXIMUM_TRANSCRIPT_UTF8_BYTES = 8 * 1024;
const MAXIMUM_CONCURRENT_REVIEWS_PER_SESSION = 4;
const MAXIMUM_CONCURRENT_REVIEWS_TOTAL = 32;
/** Fixed fail-closed bound; the review request contract has no caller deadline. */
const EVIDENCE_REVIEW_RECORD_ITERATION_DEADLINE_MS = 1_000;

export type EvidenceReviewRole = "retention_owner" | "evidence_reviewer";

export interface EvidenceReviewActor {
  readonly role: EvidenceReviewRole;
  readonly actorId: string;
}

export interface EvidenceReviewMetadataPageRequest {
  readonly kind: "metadata_page";
  readonly sessionId: string;
  readonly actor: EvidenceReviewActor;
  readonly cursor?: string;
  readonly pageSize?: number;
}

/** An audited sealed-artifact summary with no ledger replay or cursor. */
export interface EvidenceReviewRetentionSummaryRequest {
  readonly kind: "retention_summary";
  readonly sessionId: string;
  readonly actor: EvidenceReviewActor;
}

export interface EvidenceReviewAudioWindowRequest {
  readonly kind: "audio_window";
  readonly sessionId: string;
  readonly actor: EvidenceReviewActor;
  readonly track: EvidenceAudioTrack;
  /** Relative to the verified evidence timeline, never an absolute clock. */
  readonly startOffsetMs: number;
  readonly durationMs: number;
}

export type EvidenceReviewRequest =
  | EvidenceReviewMetadataPageRequest
  | EvidenceReviewRetentionSummaryRequest
  | EvidenceReviewAudioWindowRequest;

/**
 * A deliberately content-free sealed-artifact projection. It must never grow
 * archive identity, filesystem locations, raw manifests, or grant identities.
 */
export interface EvidenceReviewArtifactSummary {
  readonly status: "sealed";
  readonly finalizationSha256: string;
  readonly recordCount: number;
  readonly retentionDeadlineAtMs: number;
}

/**
 * A callback-scoped, verified replay stream. Authorization and assignment are
 * enforced by the artifact port before this object is issued.
 */
export interface EvidenceReviewLease {
  readonly summary: EvidenceReviewArtifactSummary;
  /** `null` for a valid sealed artifact with no recorded audio. */
  readonly originTimelineAtMonoMs: number | null;
  readonly durationMs: number;
  records(): AsyncIterable<EvidenceRecord>;
}

/**
 * Supplied by EvidenceReview to the artifact port. The port durably audits
 * this hash before it returns `completed`; no public value is released first.
 */
export interface EvidenceReviewLeaseCompletion<T> {
  readonly value: T;
  readonly responseSha256: string;
}

export type EvidenceReviewLeaseUnavailableStatus =
  | "not_found"
  | "not_sealed"
  | "grant_denied"
  | "expired"
  | "integrity_failed"
  | "audit_failed";

export type EvidenceReviewLeaseResult =
  | Readonly<{
    readonly status: "completed";
    /** Opaque correlation token for the content-free durable audit. */
    readonly auditId: string;
    readonly responseSha256: string;
  }>
  | Readonly<{ readonly status: EvidenceReviewLeaseUnavailableStatus }>;

/**
 * The sole artifact dependency of EvidenceReview. In particular it does not
 * include archive paths, manifests, or a materialized ledger.
 */
export interface EvidenceReviewArtifactPort {
  withVerifiedSealedReviewLease<T>(
    request: EvidenceReviewRequest,
    transaction: (
      lease: EvidenceReviewLease,
    ) => Promise<EvidenceReviewLeaseCompletion<T>>,
  ): Promise<EvidenceReviewLeaseResult>;
}

export interface EvidenceReviewOptions {
  readonly artifacts: EvidenceReviewArtifactPort;
  /** Exactly 32 bytes; copied and purpose-separated inside the module. */
  readonly cursorKey: Uint8Array;
}

export interface EvidenceReviewResponseSummary {
  readonly finalizationSha256: string;
  readonly durationMs: number;
  readonly recordCount: number;
  readonly retentionDeadlineAtMs: number;
}

export type EvidenceReviewMetadataRecord =
  | Readonly<{
    readonly kind: "transcript";
    readonly direction: "source" | "target";
    readonly turnId: string;
    readonly segmentId: string;
    readonly revision: number;
    readonly text: string;
  }>
  | Readonly<{
    readonly kind: "glossary_provenance";
    readonly action: "bound" | "authorized" | "bypassed";
    readonly turnId: string;
    readonly segmentId: string;
    readonly revision: number;
    readonly glossaryHash: string;
    readonly entryIds: readonly string[];
  }>
  | Readonly<{
    readonly kind: "alert";
    readonly code: string;
  }>;

export interface CompletedEvidenceReviewMetadataPage {
  readonly status: "completed";
  readonly kind: "metadata_page";
  readonly auditId: string;
  readonly summary: EvidenceReviewResponseSummary;
  readonly records: readonly EvidenceReviewMetadataRecord[];
  readonly nextCursor?: string;
}

export interface CompletedEvidenceReviewRetentionSummary {
  readonly status: "completed";
  readonly kind: "retention_summary";
  readonly auditId: string;
  readonly summary: EvidenceReviewResponseSummary;
}

export interface CompletedEvidenceReviewAudioWindow {
  readonly status: "completed";
  readonly kind: "audio_window";
  readonly auditId: string;
  readonly summary: EvidenceReviewResponseSummary;
  readonly track: EvidenceAudioTrack;
  readonly startOffsetMs: number;
  readonly durationMs: number;
  readonly wav: Uint8Array;
}

export type EvidenceReviewResult =
  | CompletedEvidenceReviewMetadataPage
  | CompletedEvidenceReviewRetentionSummary
  | CompletedEvidenceReviewAudioWindow
  | Readonly<{ readonly status: EvidenceReviewLeaseUnavailableStatus }>;

type CompletedReviewValue = Omit<CompletedEvidenceReviewMetadataPage, "auditId">
  | Omit<CompletedEvidenceReviewRetentionSummary, "auditId">
  | Omit<CompletedEvidenceReviewAudioWindow, "auditId">;

interface CursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly f: string;
  readonly p: number;
  readonly n: number;
}

interface CursorKeys {
  readonly encryptionKey: Buffer;
}

type EvidenceReviewRecordStreamStatus = "integrity_failed" | "audit_failed";

class EvidenceReviewRecordStreamError extends Error {
  readonly status: EvidenceReviewRecordStreamStatus;

  constructor(status: EvidenceReviewRecordStreamStatus, message: string) {
    super(message);
    this.name = "EvidenceReviewRecordStreamError";
    this.status = status;
  }
}

const STATIC_ALERT_CODES = new Set<string>([
  "aborted",
  "configuration_error",
  "connection_failed",
  "evidence_store_failed",
  "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK",
  "GLOSSARY_DIRECTION_MISMATCH",
  "GLOSSARY_GLOSSARY_MISMATCH",
  "GLOSSARY_PLACEHOLDER_DUPLICATE",
  "GLOSSARY_PLACEHOLDER_MISSING",
  "GLOSSARY_PLACEHOLDER_REORDERED",
  "GLOSSARY_PLACEHOLDER_UNKNOWN",
  "GLOSSARY_TARGET_EXACT_MISSING",
  "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM",
  "PALABRA_ABORTED",
  "PALABRA_CONFIGURATION",
  "PALABRA_CONNECTION",
  "PALABRA_CONNECT_TIMEOUT",
  "PALABRA_GLOSSARY_UNSUPPORTED",
  "PALABRA_INPUT",
  "PALABRA_INPUT_FORMAT",
  "PALABRA_INVALID_AUDIO",
  "PALABRA_INVALID_PAYLOAD",
  "PALABRA_LOCAL_AUDIO_QUEUE_TRIMMED",
  "PALABRA_PREPARE",
  "PALABRA_READINESS_TIMEOUT",
  "PALABRA_TURN_TIMEOUT",
  "TEXT_TRANSLATION_FALLBACK",
  "TRANSCRIPTION_FAILED",
  "TRANSCRIPTION_LOW_CONFIDENCE",
  "TTS_FAILED",
  "glossary_mismatch",
  "invalid_input",
  "invalid_participant_state",
  "invalid_participant_readiness",
  "invalid_playout_clear_ack",
  "invalid_playout_sequence",
  "invalid_playout_timeline",
  "invalid_queue_sample",
  "invalid_response",
  "invalid_source_sequence",
  "media_cleanup_failed",
  "media_ingress_failed",
  "media_playout_failed",
  "participant_disconnected",
  "placeholder_duplicate",
  "placeholder_missing",
  "placeholder_reordered",
  "placeholder_unknown",
  "playout_clear_failed",
  "playout_clear_tracking_trimmed",
  "playout_metadata_trimmed",
  "playout_queue_trimmed",
  "provider_cancel_failed",
  "provider_error",
  "request_failed",
  "source_queue_overflow",
  "source_input_closed",
  "source_queue_trimmed",
  "target_exact_missing",
  "timeout",
  "translation_cleanup_failed",
  "translation_failed",
  "translation_prepare_failed",
  "wrong_lane_media",
  "wrong_session_media",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEvidenceAudioTrack(value: unknown): value is EvidenceAudioTrack {
  return typeof value === "string" && (EVIDENCE_AUDIO_TRACKS as readonly string[]).includes(value);
}

function checkedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value !== value.trim()
  ) {
    throw new RangeError(`${field} must contain 1-512 non-whitespace-boundary characters`);
  }
  return value;
}

function checkedActor(value: unknown): EvidenceReviewActor {
  if (!isRecord(value) || (value.role !== "retention_owner" && value.role !== "evidence_reviewer")) {
    throw new RangeError("actor.role must be retention_owner or evidence_reviewer");
  }
  return Object.freeze({ role: value.role, actorId: checkedText(value.actorId, "actor.actorId") });
}

function checkedPageSize(value: unknown): number {
  const pageSize = value === undefined ? EVIDENCE_REVIEW_DEFAULT_PAGE_SIZE : value;
  if (
    typeof pageSize !== "number" ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < EVIDENCE_REVIEW_MINIMUM_PAGE_SIZE ||
    pageSize > EVIDENCE_REVIEW_MAXIMUM_PAGE_SIZE
  ) {
    throw new RangeError("pageSize must be an integer from 1 through 100");
  }
  return pageSize;
}

function checkedAlignedMs(value: unknown, field: string): number {
  if (!isSafeNonNegativeInteger(value) || value % EVIDENCE_REVIEW_AUDIO_ALIGNMENT_MS !== 0) {
    throw new RangeError(`${field} must be a non-negative 20ms-aligned safe integer`);
  }
  return value;
}

function normalizeRequest(request: EvidenceReviewRequest): EvidenceReviewRequest {
  if (!isRecord(request)) throw new TypeError("Evidence review request must be an object");
  const sessionId = checkedText(request.sessionId, "sessionId");
  const actor = checkedActor(request.actor);
  if (request.kind === "retention_summary") {
    return Object.freeze({ kind: "retention_summary" as const, sessionId, actor });
  }
  if (request.kind === "metadata_page") {
    if (
      request.cursor !== undefined &&
      (typeof request.cursor !== "string" || request.cursor.length === 0 || request.cursor.length > 512)
    ) {
      throw new RangeError("cursor must be a 1-512 character opaque token");
    }
    return Object.freeze({
      kind: "metadata_page" as const,
      sessionId,
      actor,
      pageSize: checkedPageSize(request.pageSize),
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    });
  }
  if (request.kind !== "audio_window") throw new RangeError("Unsupported evidence review request kind");
  if (!isEvidenceAudioTrack(request.track)) throw new RangeError("track must be an evidence audio track");
  const startOffsetMs = checkedAlignedMs(request.startOffsetMs, "startOffsetMs");
  const durationMs = checkedAlignedMs(request.durationMs, "durationMs");
  if (
    durationMs < EVIDENCE_REVIEW_MINIMUM_AUDIO_DURATION_MS ||
    durationMs > EVIDENCE_REVIEW_MAXIMUM_AUDIO_DURATION_MS
  ) {
    throw new RangeError("durationMs must be 20-30000 milliseconds");
  }
  if (startOffsetMs > Number.MAX_SAFE_INTEGER - durationMs) {
    throw new RangeError("audio window end offset must be a safe integer");
  }
  return Object.freeze({
    kind: "audio_window" as const,
    sessionId,
    actor,
    track: request.track,
    startOffsetMs,
    durationMs,
  });
}

function checkedLease(lease: EvidenceReviewLease): EvidenceReviewLease {
  if (!isRecord(lease) || !isRecord(lease.summary) || lease.summary.status !== "sealed") {
    throw new TypeError("Evidence review lease did not provide a sealed safe summary");
  }
  if (!isSha256(lease.summary.finalizationSha256)) {
    throw new TypeError("Evidence review lease finalization hash is invalid");
  }
  if (!isSafeNonNegativeInteger(lease.summary.recordCount)) {
    throw new TypeError("Evidence review lease record count is invalid");
  }
  if (!isSafeNonNegativeInteger(lease.summary.retentionDeadlineAtMs)) {
    throw new TypeError("Evidence review lease retention deadline is invalid");
  }
  if (
    lease.originTimelineAtMonoMs !== null &&
    (!isSafeNonNegativeInteger(lease.originTimelineAtMonoMs))
  ) {
    throw new TypeError("Evidence review lease audio origin is invalid");
  }
  if (!isSafeNonNegativeInteger(lease.durationMs)) {
    throw new TypeError("Evidence review lease audio duration is invalid");
  }
  if (typeof lease.records !== "function") throw new TypeError("Evidence review lease records stream is invalid");
  return lease;
}

function deriveCursorKeys(cursorKey: Uint8Array): CursorKeys {
  if (!(cursorKey instanceof Uint8Array) || cursorKey.byteLength !== 32) {
    throw new RangeError("cursorKey must contain exactly 32 bytes");
  }
  const copiedKey = Buffer.from(cursorKey);
  try {
    return Object.freeze({
      encryptionKey: Buffer.from(hkdfSync("sha256", copiedKey, Buffer.alloc(0), CURSOR_KEY_INFO, 32)),
    });
  } finally {
    copiedKey.fill(0);
  }
}

function cursorPlaintext(payload: CursorPayload): Buffer {
  return Buffer.from(JSON.stringify({ v: payload.v, f: payload.f, p: payload.p, n: payload.n }), "utf8");
}

function encodeCursor(keys: CursorKeys, payload: CursorPayload): string {
  const plaintext = cursorPlaintext(payload);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.encryptionKey, nonce);
  cipher.setAAD(CURSOR_AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [
    CURSOR_PREFIX,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function parseTokenPart(value: string, expectedBytes?: number): Buffer | undefined {
  if (!CURSOR_TOKEN.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength === 0 || bytes.toString("base64url") !== value) return undefined;
  if (expectedBytes !== undefined && bytes.byteLength !== expectedBytes) return undefined;
  return bytes;
}

function decodedCursorPayload(value: unknown): CursorPayload | undefined {
  if (!isRecord(value) || value.v !== CURSOR_VERSION || !isSha256(value.f)) return undefined;
  if (
    typeof value.p !== "number" ||
    !Number.isSafeInteger(value.p) ||
    value.p < EVIDENCE_REVIEW_MINIMUM_PAGE_SIZE ||
    value.p > EVIDENCE_REVIEW_MAXIMUM_PAGE_SIZE ||
    !isSafeNonNegativeInteger(value.n)
  ) {
    return undefined;
  }
  return Object.freeze({ v: CURSOR_VERSION, f: value.f, p: value.p, n: value.n });
}

function decodeCursor(keys: CursorKeys, cursor: string): CursorPayload {
  if (cursor.length > 512) throw new RangeError("Invalid evidence review cursor");
  const parts = cursor.split(".");
  if (parts.length !== 4 || parts[0] !== CURSOR_PREFIX) throw new RangeError("Invalid evidence review cursor");
  const nonce = parseTokenPart(parts[1] ?? "", 12);
  const ciphertext = parseTokenPart(parts[2] ?? "");
  const tag = parseTokenPart(parts[3] ?? "", 16);
  if (nonce === undefined || ciphertext === undefined || tag === undefined) {
    throw new RangeError("Invalid evidence review cursor");
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keys.encryptionKey, nonce);
    decipher.setAAD(CURSOR_AAD);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new RangeError("Invalid evidence review cursor");
  }
  let payload: CursorPayload | undefined;
  try {
    payload = decodedCursorPayload(JSON.parse(plaintext.toString("utf8")) as unknown);
  } catch {
    payload = undefined;
  }
  if (payload === undefined) throw new RangeError("Invalid evidence review cursor");
  return payload;
}

function closeUntrustedRecordIterator(iterator: AsyncIterator<unknown>): () => void {
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      const returnMethod = iterator.return;
      if (typeof returnMethod !== "function") return;
      void Promise.resolve(returnMethod.call(iterator)).catch(() => undefined);
    } catch {
      // The iterator is untrusted; closing it is best effort after fail-closed
      // review admission has already stopped consuming it.
    }
  };
}

async function nextUntrustedRecord(
  iterator: AsyncIterator<unknown>,
): Promise<IteratorResult<unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => iterator.next()),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new EvidenceReviewRecordStreamError(
            "audit_failed",
            "Evidence review record stream did not yield before its bounded deadline",
          ));
        }, EVIDENCE_REVIEW_RECORD_ITERATION_DEADLINE_MS);
      }),
    ]);
  } catch (error: unknown) {
    if (error instanceof EvidenceReviewRecordStreamError) throw error;
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream yielded an invalid iterator result",
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function* boundedReviewRecords(lease: EvidenceReviewLease): AsyncIterable<EvidenceRecord> {
  let iterable: unknown;
  try {
    iterable = lease.records();
  } catch {
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream could not be opened",
    );
  }
  if ((typeof iterable !== "object" && typeof iterable !== "function") || iterable === null) {
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream is not async iterable",
    );
  }
  let asyncIteratorFactory: unknown;
  try {
    asyncIteratorFactory = (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator];
  } catch {
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream async iterator is invalid",
    );
  }
  if (typeof asyncIteratorFactory !== "function") {
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream is not async iterable",
    );
  }
  let iterator: AsyncIterator<unknown>;
  try {
    iterator = asyncIteratorFactory.call(iterable);
  } catch {
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream iterator is invalid",
    );
  }
  const closeIterator = closeUntrustedRecordIterator(iterator);
  try {
    if (typeof iterator?.next !== "function") throw new TypeError("invalid iterator");
  } catch {
    closeIterator();
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream iterator is invalid",
    );
  }
  const expectedRecordCount = lease.summary.recordCount;
  let seen = 0;
  try {
    while (seen <= expectedRecordCount) {
      const next = await nextUntrustedRecord(iterator);
      if (!isRecord(next) || typeof next.done !== "boolean") {
        throw new EvidenceReviewRecordStreamError(
          "integrity_failed",
          "Evidence review record stream yielded an invalid result",
        );
      }
      if (next.done) {
        if (seen !== expectedRecordCount) {
          throw new EvidenceReviewRecordStreamError(
            "integrity_failed",
            "Evidence review record stream ended before its sealed record count",
          );
        }
        return;
      }
      if (seen >= expectedRecordCount || !isRecord(next.value)) {
        throw new EvidenceReviewRecordStreamError(
          "integrity_failed",
          "Evidence review record stream exceeded its sealed record count",
        );
      }
      seen += 1;
      yield next.value as unknown as EvidenceRecord;
    }
  } catch (error: unknown) {
    if (error instanceof EvidenceReviewRecordStreamError) throw error;
    throw new EvidenceReviewRecordStreamError(
      "integrity_failed",
      "Evidence review record stream failed during replay",
    );
  } finally {
    closeIterator();
  }
}

function responseSummary(lease: EvidenceReviewLease): EvidenceReviewResponseSummary {
  return Object.freeze({
    finalizationSha256: lease.summary.finalizationSha256,
    durationMs: lease.durationMs,
    recordCount: lease.summary.recordCount,
    retentionDeadlineAtMs: lease.summary.retentionDeadlineAtMs,
  });
}

function validFinalEventText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAXIMUM_TRANSCRIPT_UTF8_BYTES;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

/**
 * Glossary entry IDs are provenance, never glossary text. Keep their bounded
 * projection independent from page size so a page cannot expand unboundedly
 * through one otherwise-valid final glossary event.
 */
function validGlossaryProvenanceEntryIds(values: unknown): values is readonly string[] {
  if (
    !Array.isArray(values) ||
    values.length > EVIDENCE_REVIEW_MAXIMUM_GLOSSARY_PROVENANCE_ENTRY_IDS
  ) {
    return false;
  }
  let utf8Bytes = 0;
  for (const value of values) {
    if (!validIdentifier(value)) return false;
    utf8Bytes += Buffer.byteLength(value, "utf8");
    if (utf8Bytes > EVIDENCE_REVIEW_MAXIMUM_GLOSSARY_PROVENANCE_ENTRY_IDS_UTF8_BYTES) {
      return false;
    }
  }
  return true;
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function audioRelativeOffset(
  record: EvidenceRecord,
  sessionId: string,
  originTimelineAtMonoMs: number | null,
  durationMs: number,
): number | undefined {
  if (record.type !== "audio" || originTimelineAtMonoMs === null || record.sessionId !== sessionId) {
    return undefined;
  }
  const frame = record.frame;
  if (
    !isEvidenceAudioTrack(record.track) ||
    frame.sessionId !== sessionId ||
    frame.format.encoding !== CANONICAL_AUDIO.encoding ||
    frame.format.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
    frame.format.channels !== CANONICAL_AUDIO.channels ||
    frame.format.frameDurationMs !== CANONICAL_AUDIO.frameDurationMs ||
    !(frame.pcm16le instanceof Uint8Array) ||
    frame.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame ||
    !isSafeNonNegativeInteger(record.timelineAtMonoMs)
  ) {
    return undefined;
  }
  const offsetMs = record.timelineAtMonoMs - originTimelineAtMonoMs;
  if (
    !Number.isSafeInteger(offsetMs) ||
    offsetMs < 0 ||
    offsetMs % EVIDENCE_REVIEW_AUDIO_ALIGNMENT_MS !== 0 ||
    offsetMs + EVIDENCE_REVIEW_AUDIO_ALIGNMENT_MS > durationMs
  ) {
    return undefined;
  }
  return offsetMs;
}

function projectSessionEvent(event: SessionEvent): EvidenceReviewMetadataRecord | undefined {
  if ((event.type === "source_transcript" || event.type === "target_transcript") && event.final === true) {
    if (
      !validIdentifier(event.turnId) ||
      !validIdentifier(event.segmentId) ||
      !validRevision(event.revision) ||
      !validFinalEventText(event.text)
    ) {
      return undefined;
    }
    return Object.freeze({
      kind: "transcript" as const,
      direction: event.type === "source_transcript" ? "source" as const : "target" as const,
      turnId: event.turnId,
      segmentId: event.segmentId,
      revision: event.revision,
      text: event.text,
    });
  }
  if (
    (event.type === "glossary_bound" || event.type === "glossary_authorized" || event.type === "glossary_bypassed") &&
    event.final === true
  ) {
    if (
      !validIdentifier(event.turnId) ||
      !validIdentifier(event.segmentId) ||
      !validRevision(event.revision) ||
      !isSha256(event.glossaryHash) ||
      !validGlossaryProvenanceEntryIds(event.entryIds)
    ) {
      return undefined;
    }
    const action = event.type === "glossary_bound"
      ? "bound" as const
      : event.type === "glossary_authorized"
        ? "authorized" as const
        : "bypassed" as const;
    return Object.freeze({
      kind: "glossary_provenance" as const,
      action,
      turnId: event.turnId,
      segmentId: event.segmentId,
      revision: event.revision,
      glossaryHash: event.glossaryHash,
      entryIds: Object.freeze([...event.entryIds]),
    });
  }
  if (event.type === "alert") {
    const code = typeof event.alert.code === "string" && STATIC_ALERT_CODES.has(event.alert.code)
      ? event.alert.code
      : "unclassified_relay_alert";
    return Object.freeze({ kind: "alert" as const, code });
  }
  return undefined;
}

function projectMetadataRecord(
  record: EvidenceRecord,
  sessionId: string,
): EvidenceReviewMetadataRecord | undefined {
  if (record.type === "session_event") {
    if (record.sessionId !== sessionId || record.event.sessionId !== sessionId) return undefined;
    return projectSessionEvent(record.event);
  }
  // Metadata review never emits per-frame audio markers. Audio evidence is
  // available only through the bounded audio-window projection.
  return undefined;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function hashReviewResponse(value: CompletedReviewValue): string {
  const hash = createHash("sha256");
  hash.update(RESPONSE_HASH_CONTEXT, "utf8");
  if (value.kind === "metadata_page") {
    hash.update(JSON.stringify(canonical({
      kind: value.kind,
      summary: value.summary,
      records: value.records,
      ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    })), "utf8");
  } else if (value.kind === "audio_window") {
    hash.update(JSON.stringify(canonical({
      kind: value.kind,
      summary: value.summary,
      track: value.track,
      startOffsetMs: value.startOffsetMs,
      durationMs: value.durationMs,
    })), "utf8");
    hash.update("\0", "utf8");
    hash.update(value.wav);
  } else {
    hash.update(JSON.stringify(canonical({
      kind: value.kind,
      summary: value.summary,
    })), "utf8");
  }
  return hash.digest("hex");
}

function monoWav(durationMs: number): Buffer {
  const sampleFrames = durationMs * (CANONICAL_AUDIO.sampleRateHz / 1_000);
  const dataBytes = sampleFrames * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  if (!Number.isSafeInteger(dataBytes) || wav.byteLength > EVIDENCE_REVIEW_MAXIMUM_MONO_WAV_BYTES) {
    throw new RangeError("Evidence review WAV exceeds the 30 second mono PCM16LE limit");
  }
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz, 24);
  wav.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

async function buildAudioWindow(
  request: EvidenceReviewAudioWindowRequest,
  lease: EvidenceReviewLease,
): Promise<CompletedReviewValue> {
  const endOffsetMs = request.startOffsetMs + request.durationMs;
  if (
    lease.originTimelineAtMonoMs === null ||
    !Number.isSafeInteger(endOffsetMs) ||
    endOffsetMs > lease.durationMs
  ) {
    throw new RangeError("Audio window must be wholly inside the verified audio timeline");
  }
  const wav = monoWav(request.durationMs);
  const writtenOffsets = new Set<number>();
  for await (const record of boundedReviewRecords(lease)) {
    try {
      const relativeOffsetMs = audioRelativeOffset(
        record,
        request.sessionId,
        lease.originTimelineAtMonoMs,
        lease.durationMs,
      );
      if (
        relativeOffsetMs === undefined ||
        record.type !== "audio" ||
        record.track !== request.track ||
        relativeOffsetMs < request.startOffsetMs ||
        relativeOffsetMs >= request.startOffsetMs + request.durationMs
      ) {
        continue;
      }
      const windowOffsetMs = relativeOffsetMs - request.startOffsetMs;
      if (writtenOffsets.has(windowOffsetMs)) continue;
      writtenOffsets.add(windowOffsetMs);
      const pcmOffset = 44 + (windowOffsetMs / EVIDENCE_REVIEW_AUDIO_ALIGNMENT_MS) * CANONICAL_AUDIO.bytesPerFrame;
      wav.set(record.frame.pcm16le, pcmOffset);
    } catch (error: unknown) {
      if (error instanceof EvidenceReviewRecordStreamError) throw error;
      throw new EvidenceReviewRecordStreamError(
        "integrity_failed",
        "Evidence review audio record shape is invalid",
      );
    }
  }
  return Object.freeze({
    status: "completed" as const,
    kind: "audio_window" as const,
    summary: responseSummary(lease),
    track: request.track,
    startOffsetMs: request.startOffsetMs,
    durationMs: request.durationMs,
    wav,
  });
}

async function buildMetadataPage(
  request: EvidenceReviewMetadataPageRequest,
  lease: EvidenceReviewLease,
  cursorKeys: CursorKeys,
  decodedCursor: CursorPayload | undefined,
): Promise<CompletedReviewValue> {
  const pageSize = checkedPageSize(request.pageSize);
  const cursor = decodedCursor === undefined
    ? Object.freeze({
      v: CURSOR_VERSION,
      f: lease.summary.finalizationSha256,
      p: pageSize,
      n: 0,
    })
    : decodedCursor;
  if (
    cursor.f !== lease.summary.finalizationSha256 ||
    cursor.p !== pageSize ||
    cursor.n > lease.summary.recordCount
  ) {
    throw new RangeError("Evidence review cursor does not match this sealed artifact");
  }
  const records: EvidenceReviewMetadataRecord[] = [];
  let nextRecordOrdinal: number | undefined;
  let ordinal = 0;
  for await (const record of boundedReviewRecords(lease)) {
    try {
      if (ordinal < cursor.n) {
        ordinal += 1;
        continue;
      }
      const projected = projectMetadataRecord(record, request.sessionId);
      if (projected !== undefined) {
        if (records.length === pageSize) {
          nextRecordOrdinal ??= ordinal;
        } else {
          records.push(projected);
        }
      }
      ordinal += 1;
    } catch (error: unknown) {
      if (error instanceof EvidenceReviewRecordStreamError) throw error;
      throw new EvidenceReviewRecordStreamError(
        "integrity_failed",
        "Evidence review metadata record shape is invalid",
      );
    }
  }
  const nextCursor = nextRecordOrdinal === undefined
    ? undefined
    : encodeCursor(cursorKeys, {
      v: CURSOR_VERSION,
      f: lease.summary.finalizationSha256,
      p: pageSize,
      n: nextRecordOrdinal,
    });
  return Object.freeze({
    status: "completed" as const,
    kind: "metadata_page" as const,
    summary: responseSummary(lease),
    records: Object.freeze(records),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  });
}

function buildRetentionSummary(lease: EvidenceReviewLease): CompletedReviewValue {
  return Object.freeze({
    status: "completed" as const,
    kind: "retention_summary" as const,
    summary: responseSummary(lease),
  });
}

function attachAuditId(value: CompletedReviewValue, auditId: string): EvidenceReviewResult {
  if (value.kind === "metadata_page") {
    return Object.freeze({
      status: "completed" as const,
      kind: "metadata_page" as const,
      auditId,
      summary: value.summary,
      records: value.records,
      ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
    });
  }
  if (value.kind === "retention_summary") {
    return Object.freeze({
      status: "completed" as const,
      kind: "retention_summary" as const,
      auditId,
      summary: value.summary,
    });
  }
  return Object.freeze({
    status: "completed" as const,
    kind: "audio_window" as const,
    auditId,
    summary: value.summary,
    track: value.track,
    startOffsetMs: value.startOffsetMs,
    durationMs: value.durationMs,
    wav: value.wav,
  });
}

function isUnavailableStatus(value: unknown): value is EvidenceReviewLeaseUnavailableStatus {
  return value === "not_found" ||
    value === "not_sealed" ||
    value === "grant_denied" ||
    value === "expired" ||
    value === "integrity_failed" ||
    value === "audit_failed";
}

export class EvidenceReview {
  readonly #artifacts: EvidenceReviewArtifactPort;
  readonly #cursorKeys: CursorKeys;
  readonly #activeReviewsBySession = new Map<string, number>();
  #activeReviewsTotal = 0;

  constructor(options: EvidenceReviewOptions) {
    if (!isRecord(options) || options.artifacts === undefined) {
      throw new TypeError("EvidenceReview requires an artifact port");
    }
    if (typeof options.artifacts.withVerifiedSealedReviewLease !== "function") {
      throw new TypeError("EvidenceReview artifact port is invalid");
    }
    this.#artifacts = options.artifacts;
    this.#cursorKeys = deriveCursorKeys(options.cursorKey);
  }

  async review(request: EvidenceReviewRequest): Promise<EvidenceReviewResult> {
    const normalizedRequest = normalizeRequest(request);
    let decodedCursor: CursorPayload | undefined;
    if (normalizedRequest.kind === "metadata_page" && normalizedRequest.cursor !== undefined) {
      try {
        decodedCursor = decodeCursor(this.#cursorKeys, normalizedRequest.cursor);
      } catch {
        return Object.freeze({ status: "audit_failed" as const });
      }
    }
    const sessionActive = this.#activeReviewsBySession.get(normalizedRequest.sessionId) ?? 0;
    if (
      sessionActive >= MAXIMUM_CONCURRENT_REVIEWS_PER_SESSION ||
      this.#activeReviewsTotal >= MAXIMUM_CONCURRENT_REVIEWS_TOTAL
    ) {
      return Object.freeze({ status: "audit_failed" as const });
    }
    this.#activeReviewsBySession.set(normalizedRequest.sessionId, sessionActive + 1);
    this.#activeReviewsTotal += 1;
    try {
      let capturedCompletion: EvidenceReviewLeaseCompletion<CompletedReviewValue> | undefined;
      const result = await this.#artifacts.withVerifiedSealedReviewLease<CompletedReviewValue>(
        normalizedRequest,
        async (untrustedLease) => {
          if (capturedCompletion !== undefined) {
            throw new Error("Evidence review artifact port invoked its transaction more than once");
          }
          const lease = checkedLease(untrustedLease);
          const value = normalizedRequest.kind === "metadata_page"
            ? await buildMetadataPage(normalizedRequest, lease, this.#cursorKeys, decodedCursor)
            : normalizedRequest.kind === "audio_window"
              ? await buildAudioWindow(normalizedRequest, lease)
              : buildRetentionSummary(lease);
          capturedCompletion = Object.freeze({ value, responseSha256: hashReviewResponse(value) });
          return capturedCompletion;
        },
      );
      if (!isRecord(result)) throw new TypeError("Evidence review artifact port returned an invalid result");
      if (result.status !== "completed") {
        if (!isUnavailableStatus(result.status)) {
          throw new TypeError("Evidence review artifact port returned an unsupported status");
        }
        return Object.freeze({ status: result.status });
      }
      if (
        !OPAQUE_AUDIT_ID.test(result.auditId) ||
        !isSha256(result.responseSha256)
      ) {
        throw new TypeError("Evidence review artifact port completed with an invalid audit result");
      }
      if (capturedCompletion === undefined) {
        throw new Error("Evidence review artifact port completed without invoking its transaction");
      }
      const expectedHash = hashReviewResponse(capturedCompletion.value);
      if (
        !timingSafeEqual(Buffer.from(capturedCompletion.responseSha256, "hex"), Buffer.from(expectedHash, "hex")) ||
        !timingSafeEqual(Buffer.from(result.responseSha256, "hex"), Buffer.from(expectedHash, "hex"))
      ) {
        throw new Error("Evidence review audit response hash does not match the completed response");
      }
      return attachAuditId(capturedCompletion.value, result.auditId);
    } catch (error: unknown) {
      if (error instanceof EvidenceReviewRecordStreamError) {
        return Object.freeze({ status: error.status });
      }
      throw error;
    } finally {
      this.#activeReviewsTotal -= 1;
      const activeForSession = this.#activeReviewsBySession.get(normalizedRequest.sessionId) ?? 0;
      if (activeForSession <= 1) {
        this.#activeReviewsBySession.delete(normalizedRequest.sessionId);
      } else {
        this.#activeReviewsBySession.set(normalizedRequest.sessionId, activeForSession - 1);
      }
    }
  }
}

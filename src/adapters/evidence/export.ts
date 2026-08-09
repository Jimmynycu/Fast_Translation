import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { CANONICAL_AUDIO } from "../../core/audio.js";
import {
  type SessionProcessingManifest,
  validateSessionProcessingManifest,
} from "../../core/processing-profile.js";
import {
  EVIDENCE_AUDIO_TRACKS,
  type EvidenceAudioRecord,
  type EvidenceAudioTrack,
  type EvidenceRecord,
  type SessionOpenedEvent,
} from "../../core/types.js";
import type {
  EvidenceTrackDigest,
  ManagedEvidenceExportLease,
  ManagedEvidenceExportLeaseCompletion,
  SessionArtifactLookup,
  SessionArtifactManagementPort,
  SessionArtifactSeal,
  RetentionOwnerAuthority,
  VerifiedSessionArtifactSummary,
} from "./session-artifact-store.js";

export interface ExportedWavFile {
  readonly path: string;
  readonly channels: 1 | 4;
  readonly sampleRateHz: 24_000;
  readonly bitsPerSample: 16;
  readonly sampleFrames: number;
  readonly dataBytes: number;
  readonly sha256: string;
}

/**
 * A non-secret, immutable projection made explicit in the plaintext export
 * manifest. Region remains an assurance object: an unverified POC region is
 * retained as NOT_RUN, never converted into a verified region claim.
 */
export interface EvidenceExportProcessingProjection {
  readonly profile: SessionProcessingManifest["profile"];
  readonly operationScope: SessionProcessingManifest["operationScope"];
  readonly acceptanceImpact: SessionProcessingManifest["acceptanceImpact"];
  readonly provider: SessionProcessingManifest["selectedTranslation"]["provider"];
  readonly mode: SessionProcessingManifest["selectedTranslation"]["mode"];
  readonly behaviorVersion: SessionProcessingManifest["selectedTranslation"]["behaviorVersion"];
  readonly servicesSha256: SessionProcessingManifest["selectedTranslation"]["servicesSha256"];
  readonly serviceRegions: readonly Readonly<{
    readonly id: SessionProcessingManifest["services"][number]["id"];
    readonly role: SessionProcessingManifest["services"][number]["role"];
    readonly provider: SessionProcessingManifest["services"][number]["provider"];
    readonly category: SessionProcessingManifest["services"][number]["category"];
    readonly region: SessionProcessingManifest["services"][number]["region"];
  }>[];
  readonly retentionPolicy: SessionProcessingManifest["retentionPolicy"];
  readonly fallback: SessionProcessingManifest["fallback"];
}

/**
 * The encrypted artifact store owns identity, authorization registration, and
 * output-path confinement. The export layer only needs this narrow public
 * port, which keeps it behind the authenticated owner route and test seams.
 */
export type ManagedEvidenceExportPort = Pick<
  SessionArtifactManagementPort,
  "withManagedExportLease"
>;

/**
 * The managed-export durability boundary. Production fsyncs the completed
 * plaintext entries and their workspace; tests can supply this narrow port to
 * prove that the store never receives a completion before that barrier.
 */
export interface ManagedEvidenceExportDurabilityPort {
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

/**
 * Every binary chunk emitted to a managed export file writer is bounded by
 * this value. It covers PCM, WAV headers, four-track interleaving, and UTF-8
 * encoded text output; the complete WAV layout is separately bounded below.
 */
export const MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES = 4 * 1024;

/**
 * A managed export is intentionally bounded before it opens any plaintext
 * WAV.  This keeps sparse-timeline metadata from turning into an unbounded
 * preallocation while leaving enough room for a normal short evidence clip.
 */
export const MANAGED_EVIDENCE_EXPORT_MAX_DURATION_MS = 5 * 60 * 1_000;
export const MANAGED_EVIDENCE_EXPORT_MAX_AGGREGATE_WAV_BYTES = 128 * 1024 * 1024;

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ManagedEvidenceExportWriteChunk = ArrayBufferView | string;

/**
 * A single managed plaintext output. The store still owns its directory and
 * lifecycle; this port only permits bounded writes to a store-provided path.
 */
export interface ManagedEvidenceExportWritableFile {
  truncate(byteLength: number): Promise<void>;
  write(chunk: ManagedEvidenceExportWriteChunk, position: number): Promise<void>;
  close(): Promise<void>;
}

/**
 * Filesystem boundary for managed plaintext export. Supplying a wrapper lets
 * callers observe emitted chunks without patching process-global allocation
 * APIs or exposing archive paths outside the managed lease.
 */
export interface ManagedEvidenceExportFileWriterPort {
  openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile>;
}

export interface ManagedEvidenceExportRequest {
  readonly artifacts: ManagedEvidenceExportPort;
  readonly lookup: SessionArtifactLookup;
  readonly commandId: string;
  readonly authority: RetentionOwnerAuthority;
  readonly requestedAtMs: number;
  readonly durability?: ManagedEvidenceExportDurabilityPort;
  readonly fileWriter?: ManagedEvidenceExportFileWriterPort;
}

/**
 * This disk manifest deliberately excludes raw session/archive filesystem
 * identities. The encrypted event payloads remain the authorized plaintext
 * evidence; this manifest only describes their verified export.
 */
export interface EvidenceExportManifest {
  readonly schemaVersion: 3;
  readonly kind: "managed_finalized_four_track_evidence_export";
  readonly exportId: string;
  readonly processing: EvidenceExportProcessingProjection;
  readonly processingManifest: VerifiedSessionArtifactSummary["finalization"]["processingManifest"];
  readonly processingManifestSha256: string;
  readonly consentReceiptRefs: readonly string[];
  readonly finalization: Readonly<{
    readonly manifestSha256: string;
    readonly finalizedAtMonoMs: number;
    readonly finalizedAtUtc: string;
    readonly reason: string;
    readonly retentionDeadlineAtMs: number;
    readonly retentionDeadlineAt: string;
    readonly recordCount: number;
    readonly finalChainSha256: string;
    readonly evidenceSeal: SessionArtifactSeal;
    readonly trackDigests: Readonly<Record<EvidenceAudioTrack, EvidenceTrackDigest>>;
    readonly finalizedTracks: VerifiedSessionArtifactSummary["finalization"]["tracks"];
  }>;
  readonly eventCount: number;
  readonly originTimelineAtMonoMs: number;
  readonly trackFrameCounts: Readonly<Record<EvidenceAudioTrack, number>>;
  readonly events: Readonly<{
    readonly path: "events.jsonl";
    readonly sha256: string;
  }>;
  readonly tracks: Readonly<Record<EvidenceAudioTrack, ExportedWavFile>>;
  readonly fourTrack: ExportedWavFile;
  readonly plaintextWarning: "AUTHORIZED_PLAINTEXT_EXPORT";
  readonly exportSha256: string;
}

/**
 * Safe to serialize from the owner API. It intentionally
 * excludes conversation data, paths, raw session IDs, and archive IDs.
 */
export interface CompletedManagedEvidenceExport {
  readonly status: "completed";
  readonly exportId: string;
  readonly manifestFileSha256: string;
  readonly processingManifestSha256: string;
  readonly finalizationManifestSha256: string;
  readonly retentionDeadlineAtMs: number;
  readonly recordCount: number;
  readonly finalChainSha256: string;
  readonly evidenceSealSha256: string;
  readonly trackDigests: Readonly<Record<EvidenceAudioTrack, EvidenceTrackDigest>>;
}

export type ManagedEvidenceExportResult =
  | CompletedManagedEvidenceExport
  | Readonly<{ readonly status: "audit_failed" | "conflict" | "expired" | "not_found" }>;

const TRACK_FILE_NAMES: Readonly<Record<EvidenceAudioTrack, string>> = Object.freeze({
  source_a: "source_a.wav",
  source_b: "source_b.wav",
  playout_to_a: "playout_to_a.wav",
  playout_to_b: "playout_to_b.wav",
});

function managedOutputPaths(outputDirectory: string): readonly string[] {
  return [
    join(outputDirectory, "events.jsonl"),
    ...EVIDENCE_AUDIO_TRACKS.map((track) => join(outputDirectory, TRACK_FILE_NAMES[track])),
    join(outputDirectory, "four-track.wav"),
    join(outputDirectory, "checksums.sha256"),
    join(outputDirectory, "export-manifest.json"),
  ];
}

async function fsyncPath(path: string, flags: "r" | "r+"): Promise<void> {
  const file = await open(path, flags);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

const defaultManagedEvidenceExportDurability: ManagedEvidenceExportDurabilityPort = Object.freeze({
  async syncFile(path: string): Promise<void> {
    await fsyncPath(path, "r+");
  },
  async syncDirectory(path: string): Promise<void> {
    // POSIX accepts an fsync on a read-only directory descriptor, whereas
    // Windows needs a read/write handle for FlushFileBuffers.
    await fsyncPath(path, process.platform === "win32" ? "r+" : "r");
  },
});

function resolveDurabilityPort(
  candidate: ManagedEvidenceExportDurabilityPort | undefined,
): ManagedEvidenceExportDurabilityPort {
  if (candidate === undefined) return defaultManagedEvidenceExportDurability;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.syncFile !== "function" ||
    typeof candidate.syncDirectory !== "function"
  ) {
    throw new RangeError("Managed evidence export durability port is invalid");
  }
  return candidate;
}

async function syncManagedExportOutput(
  durability: ManagedEvidenceExportDurabilityPort,
  outputDirectory: string,
): Promise<void> {
  for (const path of managedOutputPaths(outputDirectory)) {
    await durability.syncFile(path);
  }
  await durability.syncDirectory(outputDirectory);
}

const SHA256_HEX = /^[a-f0-9]{64}$/u;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sha256(value: Uint8Array | string | unknown): string {
  const hash = createHash("sha256");
  if (typeof value === "string" || value instanceof Uint8Array) {
    hash.update(value);
  } else {
    hash.update(JSON.stringify(canonical(value)), "utf8");
  }
  return hash.digest("hex");
}

function deepFreeze<T>(value: T): T {
  // Node does not support freezing non-empty typed-array views. Audio is
  // copied into freshly rendered WAV buffers before it can leave the managed
  // workspace, so retain immutable parents without freezing the view itself.
  if (ArrayBuffer.isView(value)) return value;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isTrack(value: unknown): value is EvidenceAudioTrack {
  return typeof value === "string" && EVIDENCE_AUDIO_TRACKS.includes(value as EvidenceAudioTrack);
}

function requireNonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RangeError(name + " is required");
  }
  return value.trim();
}

function requireTimestamp(value: unknown, name: string): number {
  if (!Number.isFinite(value) || (value as number) < 0) {
    throw new RangeError(name + " must be a finite non-negative number");
  }
  return value as number;
}

function requireCanonicalUtcTimestamp(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new RangeError(name + " must be a canonical UTC timestamp");
  }
  return value;
}

function validateLookup(lookup: SessionArtifactLookup): void {
  const candidate = lookup as Record<string, unknown>;
  if (
    Object.keys(candidate).length === 1 &&
    typeof candidate.archiveId === "string" &&
    SHA256_HEX.test(candidate.archiveId)
  ) {
    return;
  }
  if (
    Object.keys(candidate).length === 1 &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.trim().length > 0
  ) {
    return;
  }
  throw new RangeError("lookup must identify exactly one session or opaque archive");
}

function validateAudioRecord(record: EvidenceAudioRecord): void {
  const frame = record.frame;
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0 ||
    !isTrack(record.track) ||
    frame.sessionId !== record.sessionId ||
    frame.format.encoding !== CANONICAL_AUDIO.encoding ||
    frame.format.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
    frame.format.channels !== CANONICAL_AUDIO.channels ||
    frame.format.frameDurationMs !== CANONICAL_AUDIO.frameDurationMs ||
    frame.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame ||
    !Number.isFinite(record.timelineAtMonoMs) ||
    record.timelineAtMonoMs < 0 ||
    !Number.isFinite(frame.capturedAtMs) ||
    frame.capturedAtMs < 0
  ) {
    throw new Error("Invalid canonical audio evidence record");
  }
}

function validateRecord(record: EvidenceRecord, expectedSessionId: string | undefined): string {
  const sessionId = requireNonEmpty(record.sessionId, "evidence sessionId");
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) {
    throw new Error("Managed evidence export accepts exactly one session");
  }
  if (record.type === "audio") validateAudioRecord(record);
  return sessionId;
}

function projectProcessingManifest(
  processingManifest: SessionProcessingManifest,
): EvidenceExportProcessingProjection {
  // This is the canonical core validation, rather than a second export-only
  // hashing policy. The store independently invokes the same validation as
  // part of the verified sealing projection before returning this immutable projection.
  validateSessionProcessingManifest(processingManifest);
  const { profile, selectedTranslation, services } = processingManifest;
  requireNonEmpty(profile.id, "processing profile id");
  requireNonEmpty(profile.version, "processing profile version");
  if (!SHA256_HEX.test(profile.sha256)) {
    throw new Error("Processing profile reference must include a canonical SHA-256");
  }
  requireNonEmpty(selectedTranslation.provider, "processing provider");
  if (!SHA256_HEX.test(selectedTranslation.servicesSha256)) {
    throw new Error("Processing services projection must include a canonical SHA-256");
  }
  if (!Array.isArray(services) || services.length === 0) {
    throw new Error("Processing manifest requires at least one service region projection");
  }
  const serviceRegions = services.map((service) => {
    requireNonEmpty(service.id, "processing service id");
    requireNonEmpty(service.provider, "processing service provider");
    const region = service.region;
    if (region.status === "verified") {
      requireNonEmpty(region.value, "verified processing region");
      requireNonEmpty(region.evidenceRef.id, "verified processing region evidence id");
      requireNonEmpty(region.evidenceRef.revision, "verified processing region evidence revision");
      if (!SHA256_HEX.test(region.evidenceRef.sha256)) {
        throw new Error("Verified processing region evidence must include a canonical SHA-256");
      }
    } else if (
      region.status !== "unverified" ||
      region.acceptanceImpact !== "NOT_RUN" ||
      typeof region.reason !== "string" ||
      region.reason.trim().length === 0
    ) {
      throw new Error("Processing region assurance is invalid");
    }
    return deepFreeze({
      id: service.id,
      role: service.role,
      provider: service.provider,
      category: service.category,
      region: structuredClone(region),
    });
  });
  if (
    processingManifest.acceptanceImpact === "PASS" &&
    serviceRegions.some((service) => service.region.status === "unverified")
  ) {
    throw new Error("Processing manifest cannot claim PASS with an unverified service region");
  }
  return deepFreeze({
    profile: structuredClone(profile),
    operationScope: processingManifest.operationScope,
    acceptanceImpact: processingManifest.acceptanceImpact,
    provider: selectedTranslation.provider,
    mode: selectedTranslation.mode,
    behaviorVersion: selectedTranslation.behaviorVersion,
    servicesSha256: selectedTranslation.servicesSha256,
    serviceRegions,
    retentionPolicy: structuredClone(processingManifest.retentionPolicy),
    fallback: structuredClone(processingManifest.fallback),
  });
}

function validateVerifiedArtifact(
  artifact: VerifiedSessionArtifactSummary,
): EvidenceExportProcessingProjection {
  const { audioTimeline, finalization, seal } = artifact;
  if (artifact.status !== "sealed") {
    throw new Error("Managed evidence export requires a sealed finalization");
  }
  if (!SHA256_HEX.test(artifact.archiveId)) {
    throw new Error("Managed evidence export requires a canonical archive identity");
  }
  requireCanonicalUtcTimestamp(finalization.finalizedAtUtc, "finalization finalizedAtUtc");
  const retentionDeadlineAt = requireCanonicalUtcTimestamp(
    finalization.retentionDeadlineAt,
    "finalization retentionDeadlineAt",
  );
  const finalizedAtMs = Date.parse(finalization.finalizedAtUtc);
  const maximumRetentionMs = finalization.processingManifest.retentionPolicy.maximumDays * DAY_MS;
  if (
    finalization.schemaVersion !== 3 ||
    finalization.kind !== "session_artifact_finalization" ||
    finalization.archiveId !== artifact.archiveId ||
    !SHA256_HEX.test(finalization.manifestSha256) ||
    !SHA256_HEX.test(finalization.processingManifestSha256) ||
    !SHA256_HEX.test(finalization.finalChainSha256) ||
    !SHA256_HEX.test(seal.sealSha256) ||
    seal.schemaVersion !== 3 ||
    seal.finalizationManifestSha256 !== finalization.manifestSha256 ||
    seal.recordCount !== finalization.recordCount ||
    seal.finalChainSha256 !== finalization.finalChainSha256 ||
    !Number.isSafeInteger(artifact.retentionDeadlineAtMs) ||
    artifact.retentionDeadlineAtMs < finalization.retentionDeadlineAtMs ||
    !Number.isSafeInteger(maximumRetentionMs) ||
    maximumRetentionMs < 0 ||
    !Number.isSafeInteger(finalizedAtMs) ||
    finalizedAtMs < 0 ||
    artifact.retentionDeadlineAtMs > finalizedAtMs + maximumRetentionMs ||
    !Number.isSafeInteger(finalization.recordCount) ||
    finalization.recordCount < 0 ||
    !Number.isSafeInteger(finalization.retentionDeadlineAtMs) ||
    finalization.retentionDeadlineAtMs < 0 ||
    !Number.isSafeInteger(finalization.finalizedAtMonoMs) ||
    finalization.finalizedAtMonoMs < 0 ||
    Date.parse(retentionDeadlineAt) !== finalization.retentionDeadlineAtMs
  ) {
    throw new Error("Verified finalization metadata does not match its sealed ledger");
  }
  const processing = projectProcessingManifest(finalization.processingManifest);
  const processingManifestHash = finalization.processingManifest.manifestSha256;
  if (processingManifestHash !== finalization.processingManifestSha256) {
    throw new Error("Verified finalization processing manifest does not match its hash");
  }
  if (
    finalization.consentReceiptRefs.length !== 2 ||
    new Set(finalization.consentReceiptRefs).size !== 2 ||
    finalization.consentReceiptRefs.some((reference) => reference.trim().length === 0)
  ) {
    throw new Error("Verified finalization requires two participant consent receipts");
  }
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    const digest = finalization.trackDigests[track];
    if (
      digest === undefined ||
      !Number.isSafeInteger(digest.recordCount) ||
      digest.recordCount < 0 ||
      !SHA256_HEX.test(digest.sha256)
    ) {
      throw new Error("Verified finalization has an invalid evidence track digest");
    }
    const finalizedTrack = finalization.tracks[track];
    if (
      finalizedTrack === undefined ||
      !SHA256_HEX.test(finalizedTrack.sha256) ||
      !Number.isSafeInteger(finalizedTrack.frameCount) ||
      finalizedTrack.frameCount < 0 ||
      !Number.isSafeInteger(finalizedTrack.byteCount) ||
      finalizedTrack.byteCount < 0 ||
      finalizedTrack.frameCount !== digest.recordCount ||
      finalizedTrack.byteCount !== digest.recordCount * CANONICAL_AUDIO.bytesPerFrame ||
      finalizedTrack.sha256 !== digest.sha256
    ) {
      throw new Error("Verified finalization has an invalid finalized audio track digest");
    }
  }
  const audioRecordCount = EVIDENCE_AUDIO_TRACKS.reduce(
    (total, track) => total + finalization.trackDigests[track].recordCount,
    0,
  );
  if (!Number.isSafeInteger(audioRecordCount) || audioRecordCount > finalization.recordCount) {
    throw new Error("Verified finalization has an invalid audio record count");
  }
  if (
    !Number.isSafeInteger(audioTimeline.durationSampleFrames) ||
    audioTimeline.durationSampleFrames < 0 ||
    (audioRecordCount === 0 &&
      (audioTimeline.originTimelineAtMonoMs !== null || audioTimeline.durationSampleFrames !== 0)) ||
    (audioRecordCount > 0 &&
      (!Number.isFinite(audioTimeline.originTimelineAtMonoMs) ||
        (audioTimeline.originTimelineAtMonoMs ?? -1) < 0 ||
        audioTimeline.durationSampleFrames < CANONICAL_AUDIO.samplesPerFrame))
  ) {
    throw new Error("Verified finalization has an invalid audio timeline");
  }
  return processing;
}

function sanitize(value: unknown): unknown {
  if (value instanceof Uint8Array) return { byteLength: value.byteLength };
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "pcm16le")
        .map(([key, entry]) => [key, sanitize(entry)]),
    );
  }
  return value;
}

/**
 * A session-opened snapshot includes live participant endpoint grants. The
 * plaintext export must not recursively serialize it: this closed projection
 * deliberately excludes participants and any current or future access grant.
 */
function projectSessionOpenedEvent(event: SessionOpenedEvent) {
  const { snapshot } = event;
  return {
    type: event.type,
    cursor: event.cursor,
    sessionId: event.sessionId,
    timestampMonoMs: event.timestampMonoMs,
    lane: event.lane,
    generation: event.generation,
    snapshot: {
      status: snapshot.status,
      spec: {
        sideA: { language: snapshot.spec.sideA.language },
        sideB: { language: snapshot.spec.sideB.language },
        provider: snapshot.spec.provider,
        mode: snapshot.spec.mode,
        processingManifestSha256: snapshot.spec.processingManifest.manifestSha256,
      },
    },
  };
}

function sanitizeEvidenceRecord(record: EvidenceRecord): unknown {
  if (record.type === "session_event" && record.event.type === "session_opened") {
    return {
      type: record.type,
      sessionId: record.sessionId,
      event: projectSessionOpenedEvent(record.event),
    };
  }
  return sanitize(record);
}

const RIFF_CHUNK_SIZE_MAX = 0xffff_ffff;

function wavRiffChunkSize(channels: 1 | 4, dataBytes: number): number {
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0) {
    throw new RangeError("WAV export has an invalid data size");
  }
  const riffChunkSize = 36 + dataBytes;
  if (!Number.isSafeInteger(riffChunkSize) || riffChunkSize > RIFF_CHUNK_SIZE_MAX) {
    throw new RangeError(
      channels === 4
        ? "Managed four-track WAV RIFF size exceeds the 32-bit limit"
        : "WAV export exceeds the RIFF 32-bit size limit",
    );
  }
  return riffChunkSize;
}

function wavHeader(channels: 1 | 4, sampleFrames: number): Buffer {
  const dataBytes = sampleFrames * channels * 2;
  const riffChunkSize = wavRiffChunkSize(channels, dataBytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(riffChunkSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz, 24);
  header.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function sampleOffset(timelineAtMonoMs: number, originAtMonoMs: number): number {
  const offset = Math.round(
    ((timelineAtMonoMs - originAtMonoMs) * CANONICAL_AUDIO.sampleRateHz) / 1_000,
  );
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Audio evidence produced an invalid timeline offset");
  }
  return offset;
}

const WAV_HEADER_BYTES = 44;
const FILE_HASH_CHUNK_BYTES = 2 * 1024;
const INTERLEAVE_SAMPLE_FRAMES = 256;
const TEXT_WRITE_CHARACTERS = MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES / 4;
const textEncoder = new TextEncoder();

interface OpenWavFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly file: ManagedEvidenceExportWritableFile;
  readonly channels: 1 | 4;
  readonly sampleFrames: number;
  readonly dataBytes: number;
}

function wavDataBytes(channels: 1 | 4, sampleFrames: number): number {
  const dataBytes = sampleFrames * channels * 2;
  wavRiffChunkSize(channels, dataBytes);
  return dataBytes;
}

function validateManagedExportAudioLayout(sampleFrames: number): void {
  if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 0) {
    throw new RangeError("Managed evidence export timeline exceeds a safe duration");
  }
  const monoDataBytes = wavDataBytes(1, sampleFrames);
  const fourTrackDataBytes = wavDataBytes(4, sampleFrames);
  // Validate the 4-channel RIFF field explicitly before any file is opened;
  // wavDataBytes also enforces this invariant for all subsequent writes.
  const fourTrackRiffChunkSize = wavRiffChunkSize(4, fourTrackDataBytes);
  const aggregateWavBytes =
    EVIDENCE_AUDIO_TRACKS.length * (WAV_HEADER_BYTES + monoDataBytes) +
    WAV_HEADER_BYTES + fourTrackDataBytes;
  if (
    !Number.isSafeInteger(aggregateWavBytes) ||
    aggregateWavBytes > MANAGED_EVIDENCE_EXPORT_MAX_AGGREGATE_WAV_BYTES
  ) {
    throw new RangeError("Managed evidence export exceeds its maximum aggregate WAV size");
  }
  if (fourTrackRiffChunkSize > RIFF_CHUNK_SIZE_MAX) {
    throw new RangeError("Managed four-track WAV RIFF size exceeds the 32-bit limit");
  }
  const durationMs = (sampleFrames * 1_000) / CANONICAL_AUDIO.sampleRateHz;
  if (!Number.isFinite(durationMs) || durationMs > MANAGED_EVIDENCE_EXPORT_MAX_DURATION_MS) {
    throw new RangeError("Managed evidence export exceeds its maximum duration");
  }
}

async function writeAll(
  file: ManagedEvidenceExportWritableFile,
  contents: Uint8Array,
  position: number,
): Promise<void> {
  if (contents.byteLength > MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES) {
    throw new RangeError("Managed evidence export binary write exceeds its bounded chunk size");
  }
  await file.write(contents, position);
}

async function writeText(
  file: ManagedEvidenceExportWritableFile,
  contents: string,
  position: number,
): Promise<number> {
  let characterOffset = 0;
  let byteOffset = position;
  while (characterOffset < contents.length) {
    let end = Math.min(characterOffset + TEXT_WRITE_CHARACTERS, contents.length);
    if (
      end < contents.length &&
      /[\uD800-\uDBFF]/u.test(contents[end - 1]!) &&
      /[\uDC00-\uDFFF]/u.test(contents[end]!)
    ) {
      end -= 1;
    }
    const chunk = textEncoder.encode(contents.slice(characterOffset, end));
    await writeAll(file, chunk, byteOffset);
    byteOffset += chunk.byteLength;
    characterOffset = end;
  }
  return byteOffset;
}

interface ClosableFile {
  close(): Promise<void>;
}

async function closeAll(files: readonly ClosableFile[]): Promise<void> {
  const results = await Promise.allSettled(files.map(async (file) => file.close()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined) throw failure.reason;
}

async function writeNodeFileChunk(
  file: FileHandle,
  chunk: ManagedEvidenceExportWriteChunk,
  position: number,
): Promise<void> {
  const contents = typeof chunk === "string"
    ? textEncoder.encode(chunk)
    : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let offset = 0;
  while (offset < contents.byteLength) {
    const { bytesWritten } = await file.write(
      contents,
      offset,
      contents.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Unable to write managed export file");
    offset += bytesWritten;
  }
}

const defaultManagedEvidenceExportFileWriter: ManagedEvidenceExportFileWriterPort = Object.freeze({
  async openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile> {
    const file = await open(path, "w", 0o600);
    try {
      await file.chmod(0o600);
      return {
        async truncate(byteLength: number): Promise<void> {
          await file.truncate(byteLength);
        },
        async write(chunk: ManagedEvidenceExportWriteChunk, position: number): Promise<void> {
          await writeNodeFileChunk(file, chunk, position);
        },
        async close(): Promise<void> {
          await file.close();
        },
      };
    } catch (error: unknown) {
      await file.close().catch(() => undefined);
      throw error;
    }
  },
});

function resolveFileWriterPort(
  candidate: ManagedEvidenceExportFileWriterPort | undefined,
): ManagedEvidenceExportFileWriterPort {
  if (candidate === undefined) return defaultManagedEvidenceExportFileWriter;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.openPrivateOutput !== "function"
  ) {
    throw new RangeError("Managed evidence export file writer is invalid");
  }
  return candidate;
}

async function createPreallocatedWav(
  fileWriter: ManagedEvidenceExportFileWriterPort,
  outputDirectory: string,
  path: string,
  channels: 1 | 4,
  sampleFrames: number,
): Promise<OpenWavFile> {
  const dataBytes = wavDataBytes(channels, sampleFrames);
  const absolutePath = join(outputDirectory, path);
  const file = await fileWriter.openPrivateOutput(absolutePath);
  try {
    await file.truncate(WAV_HEADER_BYTES + dataBytes);
    await writeAll(file, wavHeader(channels, sampleFrames), 0);
    return { path, absolutePath, file, channels, sampleFrames, dataBytes };
  } catch (error: unknown) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function createMonoWavs(
  fileWriter: ManagedEvidenceExportFileWriterPort,
  outputDirectory: string,
  sampleFrames: number,
): Promise<Readonly<Record<EvidenceAudioTrack, OpenWavFile>>> {
  // Admission must happen before the first open/truncate.  A sparse timeline
  // can otherwise allocate all four mono files before a later guard notices
  // that the aggregate export is too large.
  validateManagedExportAudioLayout(sampleFrames);
  const wavs = {} as Record<EvidenceAudioTrack, OpenWavFile>;
  try {
    for (const track of EVIDENCE_AUDIO_TRACKS) {
      wavs[track] = await createPreallocatedWav(
        fileWriter,
        outputDirectory,
        TRACK_FILE_NAMES[track],
        1,
        sampleFrames,
      );
    }
    return wavs;
  } catch (error: unknown) {
    await closeAll(Object.values(wavs).map((wav) => wav.file)).catch(() => undefined);
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

async function readExactly(
  file: FileHandle,
  target: Buffer,
  position: number,
  byteLength: number,
): Promise<void> {
  let offset = 0;
  while (offset < byteLength) {
    const { bytesRead } = await file.read(target, offset, byteLength - offset, position + offset);
    if (bytesRead === 0) throw new Error("Managed mono WAV unexpectedly ended during interleaving");
    offset += bytesRead;
  }
}

async function openReadFiles(paths: readonly string[]): Promise<readonly FileHandle[]> {
  const files: FileHandle[] = [];
  try {
    for (const path of paths) files.push(await open(path, "r"));
    return files;
  } catch (error: unknown) {
    await closeAll(files).catch(() => undefined);
    throw error;
  }
}

async function createInterleavedWav(
  fileWriter: ManagedEvidenceExportFileWriterPort,
  outputDirectory: string,
  sampleFrames: number,
): Promise<OpenWavFile> {
  validateManagedExportAudioLayout(sampleFrames);
  const output = await createPreallocatedWav(
    fileWriter,
    outputDirectory,
    "four-track.wav",
    4,
    sampleFrames,
  );
  let inputFiles: readonly FileHandle[] = [];
  try {
    inputFiles = await openReadFiles(
      EVIDENCE_AUDIO_TRACKS.map((track) => join(outputDirectory, TRACK_FILE_NAMES[track])),
    );
    const monoChunkBytes = INTERLEAVE_SAMPLE_FRAMES * 2;
    const monoChunks = EVIDENCE_AUDIO_TRACKS.map(() => Buffer.allocUnsafe(monoChunkBytes));
    const interleavedChunk = Buffer.allocUnsafe(
      INTERLEAVE_SAMPLE_FRAMES * EVIDENCE_AUDIO_TRACKS.length * 2,
    );
    for (let sampleOffsetFrames = 0; sampleOffsetFrames < sampleFrames;) {
      const frames = Math.min(INTERLEAVE_SAMPLE_FRAMES, sampleFrames - sampleOffsetFrames);
      const monoBytes = frames * 2;
      for (const [channel, input] of inputFiles.entries()) {
        await readExactly(
          input,
          monoChunks[channel]!,
          WAV_HEADER_BYTES + sampleOffsetFrames * 2,
          monoBytes,
        );
      }
      let outputOffset = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        const monoOffset = frame * 2;
        for (const chunk of monoChunks) {
          interleavedChunk[outputOffset] = chunk[monoOffset]!;
          interleavedChunk[outputOffset + 1] = chunk[monoOffset + 1]!;
          outputOffset += 2;
        }
      }
      await writeAll(
        output.file,
        interleavedChunk.subarray(0, outputOffset),
        WAV_HEADER_BYTES + sampleOffsetFrames * EVIDENCE_AUDIO_TRACKS.length * 2,
      );
      sampleOffsetFrames += frames;
    }
    return output;
  } catch (error: unknown) {
    await output.file.close().catch(() => undefined);
    throw error;
  } finally {
    await closeAll(inputFiles).catch(() => undefined);
  }
}

async function writePrivateFile(
  fileWriter: ManagedEvidenceExportFileWriterPort,
  path: string,
  contents: Uint8Array | string,
): Promise<void> {
  const file = await fileWriter.openPrivateOutput(path);
  try {
    // A custom writer may reopen an existing managed file without the
    // truncating flag.  Positional writes alone would leave stale tail bytes
    // in checksums or the manifest, so every replacement starts empty.
    await file.truncate(0);
    if (typeof contents !== "string") {
      await writeAll(file, contents, 0);
      return;
    }
    await writeText(file, contents, 0);
  } finally {
    await file.close();
  }
}

function exportedWavFile(wav: OpenWavFile, sha256: string): ExportedWavFile {
  return deepFreeze({
    path: wav.path,
    channels: wav.channels,
    sampleRateHz: 24_000,
    bitsPerSample: 16,
    sampleFrames: wav.sampleFrames,
    dataBytes: wav.dataBytes,
    sha256,
  });
}

function completedResult(
  artifact: VerifiedSessionArtifactSummary,
  exportId: string,
  manifestFileSha256: string,
): CompletedManagedEvidenceExport {
  const finalization = artifact.finalization;
  return deepFreeze({
    status: "completed" as const,
    exportId,
    manifestFileSha256,
    processingManifestSha256: finalization.processingManifestSha256,
    finalizationManifestSha256: finalization.manifestSha256,
    retentionDeadlineAtMs: artifact.retentionDeadlineAtMs,
    recordCount: finalization.recordCount,
    finalChainSha256: finalization.finalChainSha256,
    evidenceSealSha256: artifact.seal.sealSha256,
    trackDigests: structuredClone(finalization.trackDigests),
  });
}

async function writeManagedExport(
  lease: ManagedEvidenceExportLease,
  durability: ManagedEvidenceExportDurabilityPort,
  fileWriter: ManagedEvidenceExportFileWriterPort,
): Promise<ManagedEvidenceExportLeaseCompletion<CompletedManagedEvidenceExport>> {
  const artifact = lease.artifact;
  const processing = validateVerifiedArtifact(artifact);
  const finalization = artifact.finalization;
  const effectiveRetentionDeadlineAt = new Date(artifact.retentionDeadlineAtMs).toISOString();
  const sampleFrames = artifact.audioTimeline.durationSampleFrames;
  const originTimelineAtMonoMs = artifact.audioTimeline.originTimelineAtMonoMs ?? 0;
  const monoWavs = await createMonoWavs(fileWriter, lease.outputDirectory, sampleFrames);
  const trackFrameCounts: Record<EvidenceAudioTrack, number> = {
    source_a: 0,
    source_b: 0,
    playout_to_a: 0,
    playout_to_b: 0,
  };
  const previousEndByTrack: Record<EvidenceAudioTrack, number> = {
    source_a: 0,
    source_b: 0,
    playout_to_a: 0,
    playout_to_b: 0,
  };
  let eventFile: ManagedEvidenceExportWritableFile | undefined;
  let recordCount = 0;
  let eventCount = 0;
  let eventPosition = 0;
  let streamedSessionId: string | undefined;
  try {
    eventFile = await fileWriter.openPrivateOutput(join(lease.outputDirectory, "events.jsonl"));
    await eventFile.truncate(0);
    for await (const record of lease.records()) {
      streamedSessionId = validateRecord(record, streamedSessionId);
      recordCount += 1;
      if (!Number.isSafeInteger(recordCount)) {
        throw new Error("Managed evidence export record count exceeds a safe integer");
      }
      if (record.type === "audio") {
        const origin = artifact.audioTimeline.originTimelineAtMonoMs;
        if (origin === null) {
          throw new Error("Audio evidence cannot use an empty verified audio timeline");
        }
        const start = sampleOffset(record.timelineAtMonoMs, origin);
        const end = start + CANONICAL_AUDIO.samplesPerFrame;
        if (!Number.isSafeInteger(end) || end > sampleFrames) {
          throw new Error("Audio evidence exceeds its verified timeline");
        }
        if (start < previousEndByTrack[record.track]) {
          throw new Error("Overlapping or out-of-order frames found on one evidence track");
        }
        await writeAll(
          monoWavs[record.track].file,
          record.frame.pcm16le,
          WAV_HEADER_BYTES + start * 2,
        );
        previousEndByTrack[record.track] = end;
        trackFrameCounts[record.track] += 1;
        continue;
      }
      eventPosition = await writeText(
        eventFile,
        JSON.stringify(sanitizeEvidenceRecord(record)) + "\n",
        eventPosition,
      );
      if (!Number.isSafeInteger(eventPosition)) {
        throw new Error("Managed evidence export events file exceeds a safe integer");
      }
      eventCount += 1;
    }
  } finally {
    await closeAll([
      ...EVIDENCE_AUDIO_TRACKS.map((track) => monoWavs[track].file),
      ...(eventFile === undefined ? [] : [eventFile]),
    ]);
  }
  if (streamedSessionId === undefined || recordCount === 0) {
    throw new Error("Finalized evidence contains no records");
  }
  if (recordCount !== finalization.recordCount) {
    throw new Error("Verified finalization record count does not match its replay");
  }
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    if (trackFrameCounts[track] !== finalization.trackDigests[track].recordCount) {
      throw new Error("Verified finalization track digest does not match its replay");
    }
  }

  const eventsSha256 = await sha256File(join(lease.outputDirectory, "events.jsonl"));
  const exportedTracks = {} as Record<EvidenceAudioTrack, ExportedWavFile>;
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    exportedTracks[track] = exportedWavFile(
      monoWavs[track],
      await sha256File(monoWavs[track].absolutePath),
    );
  }
  const fourTrackWav = await createInterleavedWav(fileWriter, lease.outputDirectory, sampleFrames);
  await fourTrackWav.file.close();
  const fourTrack = exportedWavFile(
    fourTrackWav,
    await sha256File(fourTrackWav.absolutePath),
  );
  const body = {
    schemaVersion: 3 as const,
    kind: "managed_finalized_four_track_evidence_export" as const,
    exportId: lease.exportId,
    processing,
    processingManifest: structuredClone(finalization.processingManifest),
    processingManifestSha256: finalization.processingManifestSha256,
    consentReceiptRefs: [...finalization.consentReceiptRefs],
    finalization: deepFreeze({
      manifestSha256: finalization.manifestSha256,
      finalizedAtMonoMs: finalization.finalizedAtMonoMs,
      finalizedAtUtc: finalization.finalizedAtUtc,
      reason: finalization.reason,
      retentionDeadlineAtMs: artifact.retentionDeadlineAtMs,
      retentionDeadlineAt: effectiveRetentionDeadlineAt,
      recordCount: finalization.recordCount,
      finalChainSha256: finalization.finalChainSha256,
      evidenceSeal: structuredClone(artifact.seal),
      trackDigests: structuredClone(finalization.trackDigests),
      finalizedTracks: structuredClone(finalization.tracks),
    }),
    eventCount,
    originTimelineAtMonoMs,
    trackFrameCounts: deepFreeze(trackFrameCounts),
    events: deepFreeze({
      path: "events.jsonl" as const,
      sha256: eventsSha256,
    }),
    tracks: deepFreeze(exportedTracks),
    fourTrack,
    plaintextWarning: "AUTHORIZED_PLAINTEXT_EXPORT" as const,
  };
  const manifest = deepFreeze({ ...body, exportSha256: sha256(body) });
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  const manifestFileSha256 = sha256(manifestText);
  const checksumLines = [
    `${manifest.events.sha256}  events.jsonl`,
    ...EVIDENCE_AUDIO_TRACKS.map(
      (track) => `${manifest.tracks[track].sha256}  ${manifest.tracks[track].path}`,
    ),
    `${manifest.fourTrack.sha256}  ${manifest.fourTrack.path}`,
    `${manifestFileSha256}  export-manifest.json`,
  ];
  await writePrivateFile(
    fileWriter,
    join(lease.outputDirectory, "checksums.sha256"),
    checksumLines.join("\n") + "\n",
  );
  // This is intentionally the final output file. A verification/write failure
  // rejects the callback; the store then aborts the lease and removes its
  // pending managed workspace before releasing lifecycle locks.
  await writePrivateFile(
    fileWriter,
    join(lease.outputDirectory, "export-manifest.json"),
    manifestText,
  );
  // Completion metadata is durable only after each plaintext entry and the
  // containing directory have crossed their fsync barriers. A failure escapes
  // this callback so the store aborts the pending export workspace.
  await syncManagedExportOutput(durability, lease.outputDirectory);
  const completedAtMs = requireTimestamp(lease.nowMs(), "managed export completedAtMs");
  return deepFreeze({
    value: completedResult(artifact, lease.exportId, manifestFileSha256),
    manifestFileSha256,
    completedAtMs,
  });
}

/**
 * Exports only a store-verified, terminal session artifact. The store owns one
 * atomic lease spanning verification, workspace creation, plaintext writes,
 * completion, and cleanup. No arbitrary filesystem input/output path crosses
 * this boundary, so delete/sweep cannot interleave a partial plaintext export.
 */
export async function exportManagedFinalizedEvidence(
  request: ManagedEvidenceExportRequest,
): Promise<ManagedEvidenceExportResult> {
  requireNonEmpty(request.commandId, "commandId");
  const authority = request.authority;
  if (
    authority === null ||
    typeof authority !== "object" ||
    authority.kind !== "retention_owner" ||
    typeof authority.actorId !== "string" ||
    authority.actorId.trim().length === 0
  ) {
    throw new RangeError("retention owner authority is invalid");
  }
  validateLookup(request.lookup);
  const requestedAtMs = requireTimestamp(request.requestedAtMs, "requestedAtMs");
  const durability = resolveDurabilityPort(request.durability);
  const fileWriter = resolveFileWriterPort(request.fileWriter);
  const result = await request.artifacts.withManagedExportLease({
    lookup: request.lookup,
    commandId: request.commandId,
    authority: request.authority,
    requestedAtMs,
  }, async (lease) => writeManagedExport(lease, durability, fileWriter));
  if (result.status !== "completed") {
    return Object.freeze({ status: result.status });
  }
  requireTimestamp(result.completedAtMs, "managed export completion receipt timestamp");
  if (
    result.value.status !== "completed" ||
    result.value.exportId !== result.exportId ||
    result.value.manifestFileSha256 !== result.manifestFileSha256
  ) {
    throw new Error("Managed export completion did not persist the expected receipt");
  }
  return result.value;
}

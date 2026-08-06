import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CANONICAL_AUDIO } from "../../core/audio.js";
import {
  EVIDENCE_AUDIO_TRACKS,
  type EvidenceAudioRecord,
  type EvidenceAudioTrack,
  type EvidenceRecord,
  type EvidenceSessionEventRecord,
} from "../../core/types.js";
import { readEncryptedEvidence } from "./encrypted-file.js";

export interface ExportedWavFile {
  readonly path: string;
  readonly channels: 1 | 4;
  readonly sampleRateHz: 24_000;
  readonly bitsPerSample: 16;
  readonly sampleFrames: number;
  readonly dataBytes: number;
  readonly sha256: string;
}

export interface EvidenceExportManifest {
  readonly schemaVersion: 1;
  readonly kind: "decrypted_four_track_evidence_export";
  readonly sessionId: string;
  readonly encryptedSourceSha256: string;
  readonly recordCount: number;
  readonly eventCount: number;
  readonly originCapturedAtMs: number;
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

export interface ExportEncryptedEvidenceOptions {
  readonly encryptedPath: string;
  readonly key: Uint8Array;
  readonly outputDirectory: string;
}

const TRACK_FILE_NAMES: Readonly<Record<EvidenceAudioTrack, string>> = Object.freeze({
  source_a: "source_a.wav",
  source_b: "source_b.wav",
  playout_to_a: "playout_to_a.wav",
  playout_to_b: "playout_to_b.wav",
});

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
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

function isTrack(value: unknown): value is EvidenceAudioTrack {
  return typeof value === "string" &&
    EVIDENCE_AUDIO_TRACKS.some((candidate) => candidate === value);
}

function validateEventRecord(record: EvidenceSessionEventRecord): void {
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0 ||
    typeof record.event !== "object" ||
    record.event === null ||
    record.event.sessionId !== record.sessionId
  ) {
    throw new Error("Invalid session event evidence record");
  }
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

function validateRecords(records: readonly EvidenceRecord[]): string {
  if (records.length === 0) throw new Error("Encrypted evidence contains no records");
  const sessionId = records[0]?.sessionId;
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw new Error("Encrypted evidence has no valid sessionId");
  }
  for (const record of records) {
    if (record.sessionId !== sessionId) {
      throw new Error("Encrypted evidence export accepts exactly one session");
    }
    if (record.type === "audio") validateAudioRecord(record);
    else if (record.type === "session_event") validateEventRecord(record);
    else throw new Error("Unsupported evidence record type");
  }
  return sessionId;
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

function wavHeader(channels: 1 | 4, sampleFrames: number): Buffer {
  const dataBytes = sampleFrames * channels * 2;
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0 || dataBytes > 0xffff_ffff - 36) {
    throw new RangeError("WAV export exceeds the RIFF 32-bit size limit");
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
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

function audioByTrack(
  records: readonly EvidenceRecord[],
): Readonly<Record<EvidenceAudioTrack, readonly EvidenceAudioRecord[]>> {
  const mutable: Record<EvidenceAudioTrack, EvidenceAudioRecord[]> = {
    source_a: [],
    source_b: [],
    playout_to_a: [],
    playout_to_b: [],
  };
  for (const record of records) {
    if (record.type === "audio") mutable[record.track].push(record);
  }
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    mutable[track].sort(
      (left, right) =>
        left.timelineAtMonoMs - right.timelineAtMonoMs ||
        left.frame.sequence - right.frame.sequence,
    );
  }
  return deepFreeze(mutable);
}

function timelineOrigin(
  tracks: Readonly<Record<EvidenceAudioTrack, readonly EvidenceAudioRecord[]>>,
): number {
  const firstTimes = EVIDENCE_AUDIO_TRACKS
    .map((track) => tracks[track][0]?.timelineAtMonoMs)
    .filter((value): value is number => value !== undefined);
  return firstTimes.length === 0 ? 0 : Math.min(...firstTimes);
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

function sampleFrameCount(
  tracks: Readonly<Record<EvidenceAudioTrack, readonly EvidenceAudioRecord[]>>,
  originCapturedAtMs: number,
): number {
  let maximum = 0;
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    for (const record of tracks[track]) {
      maximum = Math.max(
        maximum,
        sampleOffset(record.timelineAtMonoMs, originCapturedAtMs) +
          CANONICAL_AUDIO.samplesPerFrame,
      );
    }
  }
  return maximum;
}

function renderMonoPcm(
  records: readonly EvidenceAudioRecord[],
  originCapturedAtMs: number,
  sampleFrames: number,
): Buffer {
  const pcm = Buffer.alloc(sampleFrames * 2);
  let previousEnd = 0;
  for (const record of records) {
    const start = sampleOffset(record.timelineAtMonoMs, originCapturedAtMs);
    if (start < previousEnd) {
      throw new Error("Overlapping frames found on one evidence track");
    }
    Buffer.from(record.frame.pcm16le).copy(pcm, start * 2);
    previousEnd = start + CANONICAL_AUDIO.samplesPerFrame;
  }
  return pcm;
}

function renderFourTrackPcm(
  mono: Readonly<Record<EvidenceAudioTrack, Buffer>>,
  sampleFrames: number,
): Buffer {
  const output = Buffer.alloc(sampleFrames * EVIDENCE_AUDIO_TRACKS.length * 2);
  for (let sample = 0; sample < sampleFrames; sample += 1) {
    for (const [channel, track] of EVIDENCE_AUDIO_TRACKS.entries()) {
      const sourceOffset = sample * 2;
      const targetOffset = (sample * EVIDENCE_AUDIO_TRACKS.length + channel) * 2;
      output[targetOffset] = mono[track][sourceOffset] ?? 0;
      output[targetOffset + 1] = mono[track][sourceOffset + 1] ?? 0;
    }
  }
  return output;
}

async function writeWav(
  outputDirectory: string,
  path: string,
  channels: 1 | 4,
  sampleFrames: number,
  pcm: Buffer,
): Promise<ExportedWavFile> {
  const bytes = Buffer.concat([wavHeader(channels, sampleFrames), pcm]);
  await writeFile(join(outputDirectory, path), bytes, { mode: 0o600 });
  return deepFreeze({
    path,
    channels,
    sampleRateHz: 24_000,
    bitsPerSample: 16,
    sampleFrames,
    dataBytes: pcm.byteLength,
    sha256: sha256(bytes),
  });
}

export async function exportEncryptedEvidence(
  options: ExportEncryptedEvidenceOptions,
): Promise<EvidenceExportManifest> {
  if (options.encryptedPath.trim().length === 0) {
    throw new RangeError("encryptedPath is required");
  }
  if (options.outputDirectory.trim().length === 0) {
    throw new RangeError("outputDirectory is required");
  }

  const records = await readEncryptedEvidence<EvidenceRecord>(
    options.encryptedPath,
    options.key,
  );
  const encryptedBytes = await readFile(options.encryptedPath);
  const sessionId = validateRecords(records);
  const tracks = audioByTrack(records);
  const originCapturedAtMs = timelineOrigin(tracks);
  const sampleFrames = sampleFrameCount(tracks, originCapturedAtMs);
  const monoPcm: Record<EvidenceAudioTrack, Buffer> = {
    source_a: renderMonoPcm(tracks.source_a, originCapturedAtMs, sampleFrames),
    source_b: renderMonoPcm(tracks.source_b, originCapturedAtMs, sampleFrames),
    playout_to_a: renderMonoPcm(tracks.playout_to_a, originCapturedAtMs, sampleFrames),
    playout_to_b: renderMonoPcm(tracks.playout_to_b, originCapturedAtMs, sampleFrames),
  };
  const fourTrackPcm = renderFourTrackPcm(monoPcm, sampleFrames);
  const eventRecords = records.filter(
    (record): record is EvidenceSessionEventRecord => record.type === "session_event",
  );
  const eventsText = eventRecords
    .map((record) => JSON.stringify(sanitize(record)))
    .join("\n") + (eventRecords.length === 0 ? "" : "\n");

  await mkdir(options.outputDirectory, { recursive: true });
  await writeFile(join(options.outputDirectory, "events.jsonl"), eventsText, {
    encoding: "utf8",
    mode: 0o600,
  });

  const exportedTracks = {} as Record<EvidenceAudioTrack, ExportedWavFile>;
  for (const track of EVIDENCE_AUDIO_TRACKS) {
    exportedTracks[track] = await writeWav(
      options.outputDirectory,
      TRACK_FILE_NAMES[track],
      1,
      sampleFrames,
      monoPcm[track],
    );
  }
  const fourTrack = await writeWav(
    options.outputDirectory,
    "four-track.wav",
    4,
    sampleFrames,
    fourTrackPcm,
  );
  const trackFrameCounts = deepFreeze(Object.fromEntries(
    EVIDENCE_AUDIO_TRACKS.map((track) => [track, tracks[track].length]),
  ) as Record<EvidenceAudioTrack, number>);
  const body = {
    schemaVersion: 1 as const,
    kind: "decrypted_four_track_evidence_export" as const,
    sessionId,
    encryptedSourceSha256: sha256(encryptedBytes),
    recordCount: records.length,
    eventCount: eventRecords.length,
    originCapturedAtMs,
    trackFrameCounts,
    events: deepFreeze({
      path: "events.jsonl" as const,
      sha256: sha256(eventsText),
    }),
    tracks: deepFreeze(exportedTracks),
    fourTrack,
    plaintextWarning: "AUTHORIZED_PLAINTEXT_EXPORT" as const,
  };
  const manifest = deepFreeze({ ...body, exportSha256: sha256(body) });
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(join(options.outputDirectory, "export-manifest.json"), manifestText, {
    encoding: "utf8",
    mode: 0o600,
  });
  const checksumLines = [
    `${manifest.events.sha256}  events.jsonl`,
    ...EVIDENCE_AUDIO_TRACKS.map(
      (track) => `${manifest.tracks[track].sha256}  ${manifest.tracks[track].path}`,
    ),
    `${manifest.fourTrack.sha256}  ${manifest.fourTrack.path}`,
    `${sha256(manifestText)}  export-manifest.json`,
  ];
  await writeFile(
    join(options.outputDirectory, "checksums.sha256"),
    checksumLines.join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return manifest;
}

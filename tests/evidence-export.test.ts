import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, open, type FileHandle, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import {
  exportManagedFinalizedEvidence,
  MANAGED_EVIDENCE_EXPORT_MAX_AGGREGATE_WAV_BYTES,
  MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES,
  MANAGED_EVIDENCE_EXPORT_MAX_DURATION_MS,
  type ManagedEvidenceExportDurabilityPort,
  type ManagedEvidenceExportFileWriterPort,
  type ManagedEvidenceExportPort,
  type ManagedEvidenceExportWritableFile,
} from "../src/adapters/evidence/export.js";
import {
  runManagedEvidenceExportCli,
} from "../src/adapters/evidence/cli.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import {
  SessionArtifactStore,
  type ManagedEvidenceExportLease,
  type ManagedEvidenceExportLeaseCompletion,
  type ManagedEvidenceExportLeaseRequest,
  type ManagedEvidenceExportLeaseResult,
  type EvidenceRootProcessLease,
  type VerifiedSessionArtifactSummary,
} from "../src/adapters/evidence/session-artifact-store.js";
import type { EvidenceRecord } from "../src/core/types.js";
import {
  canonicalJsonSha256,
  type SessionProcessingManifest,
} from "../src/core/processing-profile.js";
import { createSyntheticPocProcessingManifest } from "../src/local-eval/synthetic-poc-processing-manifest.js";

const taskTemp = join(process.cwd(), "work", "tmp", "evidence-export-tests");
const testRunId = randomUUID();

const archiveId = "0123456789abcdef".repeat(4);
const exportId = "e".repeat(64);
const sessionId = "customer-session-123";
const sessionOpenedAccessToken = "session-opened-access-token-sentinel";
const sessionOpenedQr = "data:image/png;base64,SESSION-OPENED-QR-SENTINEL";
const sessionOpenedOwnerId = "session-opened-owner-id-sentinel";
const sessionOpenedReviewerId = "session-opened-reviewer-id-sentinel";
const sessionOpenedEvidenceReviewGrantId = "session-opened-evidence-review-grant-id-sentinel";
const configuredOwnerAuthority = Object.freeze({
  kind: "retention_owner" as const,
  actorId: "configured-owner",
});
const configuredEvidenceReviewGrant = Object.freeze({
  dataOwnerId: configuredOwnerAuthority.actorId,
  bilingualReviewerId: "configured-reviewer",
});
const execFile = promisify(execFileCallback);
const PROCESS_COMMAND_TIMEOUT_MS = 120_000;
const canonicalProcessCommandId = "4c077a0a-3002-4a22-a9b3-e4587a7255e1";

async function isolatedDirectory(name: string): Promise<string> {
  const directory = join(taskTemp, testRunId, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

function quoteWindowsCommandArgument(value: string): string {
  if (/["\r\n]/u.test(value)) throw new TypeError("Test command arguments must not contain quotes or newlines");
  if (/^[^\s&|<>()^]+$/u.test(value)) return value;
  return `"${value}"`;
}

function runEvidencePackageCommand(
  command: "evidence:export" | "evidence:sweep",
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  const options = {
    cwd: process.cwd(),
    env: environment,
    maxBuffer: 1_024 * 1_024,
    timeout: PROCESS_COMMAND_TIMEOUT_MS,
  };
  if (process.platform !== "win32") {
    return execFile("pnpm", ["--silent", command, "--", ...arguments_], options);
  }
  const commandLine = [
    "pnpm",
    "--silent",
    command,
    "--",
    ...arguments_.map(quoteWindowsCommandArgument),
  ].join(" ");
  return execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", commandLine], options);
}

function runEvidenceScriptEntrypoint(
  script: "scripts/export-evidence.mjs" | "scripts/sweep-evidence.mjs",
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  return execFile(process.execPath, [script, ...arguments_], {
    cwd: process.cwd(),
    env: environment,
    maxBuffer: 1_024 * 1_024,
    timeout: PROCESS_COMMAND_TIMEOUT_MS,
  });
}

function literalPattern(value: string): RegExp {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");
}

function mixedRegionProcessingManifest(): SessionProcessingManifest {
  const source = createSyntheticPocProcessingManifest({ mode: "fast" });
  const services = source.services.map((service) => service.id === "synthetic-transcription"
    ? {
      ...service,
      region: {
        status: "verified" as const,
        value: "test-region-verified",
        evidenceRef: {
          id: "synthetic-region-verification",
          revision: "synthetic-poc-v1",
          sha256: "f".repeat(64),
          approvedBy: "synthetic-poc-harness@example.test",
          approvedAtUtc: "2026-08-09T00:00:00.000Z",
        },
      },
    }
    : service);
  const selectedTranslation = {
    ...source.selectedTranslation,
    servicesSha256: canonicalJsonSha256(services),
  };
  const manifestWithoutHash = {
    ...source,
    services,
    selectedTranslation,
  };
  const { manifestSha256: _manifestSha256, ...body } = manifestWithoutHash;
  return {
    ...manifestWithoutHash,
    manifestSha256: canonicalJsonSha256(body),
  };
}

type ReplayableEvidenceRecords =
  | readonly EvidenceRecord[]
  | (() => AsyncIterable<EvidenceRecord>);

interface StreamedArtifactFixture {
  readonly artifact: VerifiedSessionArtifactSummary;
  readonly records: ReplayableEvidenceRecords;
}

function verifiedArtifact(): StreamedArtifactFixture {
  const laneByTrack = {
    source_a: "A_TO_B",
    source_b: "B_TO_A",
    playout_to_a: "B_TO_A",
    playout_to_b: "A_TO_B",
  } as const;
  const audio = (["source_a", "source_b", "playout_to_a", "playout_to_b"] as const).map((track, index) => ({
    type: "audio" as const,
    sessionId,
    track,
    timelineAtMonoMs: 1_000,
    frame: createAudioFrame({
      sessionId,
      lane: laneByTrack[track],
      generation: 0,
      sequence: index,
      capturedAtMs: 1_000,
      pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
    }),
  }));
  // The pre-existing synthetic POC manifest is canonical and deliberately
  // retains unverified external-region assurance. Reusing it prevents this
  // export-boundary test from hand-authoring a second profile contract.
  const processingManifest = mixedRegionProcessingManifest();
  const records: readonly EvidenceRecord[] = [
    {
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
        timestampMonoMs: 999,
        lane: null,
        generation: null,
        snapshot: {
          sessionId,
          status: "waiting",
          spec: {
            sideA: { language: "en-US", displayName: "private-participant-a" },
            sideB: { language: "zh-TW", displayName: "private-participant-b" },
            provider: "openai_controlled",
            mode: "fast",
            processingManifest,
          },
          participants: {
            A: {
              kind: "browser_link",
              side: "A",
              url: "https://participant.example.test/join#access=" + sessionOpenedAccessToken,
              qrDataUrl: sessionOpenedQr,
            },
            B: {
              kind: "browser_link",
              side: "B",
              url: "https://participant.example.test/join#access=other-participant-token",
              qrDataUrl: "data:image/png;base64,other-qr",
            },
          },
          evidenceReviewGrant: {
            id: sessionOpenedEvidenceReviewGrantId,
            ownerId: sessionOpenedOwnerId,
            reviewerId: sessionOpenedReviewerId,
          },
        },
      },
    } as unknown as EvidenceRecord,
    ...audio,
    {
      type: "session_event",
      sessionId,
      event: {
        type: "session_closed",
        cursor: 5,
        sessionId,
        timestampMonoMs: 1_020,
        lane: null,
        generation: null,
        reason: "operator_end",
      },
    } as unknown as EvidenceRecord,
  ];
  return {
    artifact: {
      archiveId,
      status: "sealed",
      retentionDeadlineAtMs: 9_999,
      audioTimeline: {
        originTimelineAtMonoMs: 1_000,
        durationSampleFrames: CANONICAL_AUDIO.samplesPerFrame,
      },
      seal: {
        schemaVersion: 3,
        recordCount: 6,
        finalChainSha256: "b".repeat(64),
        finalizationManifestSha256: "c".repeat(64),
        sealSha256: "d".repeat(64),
      },
      finalization: {
      schemaVersion: 3,
      kind: "session_artifact_finalization",
      archiveId,
      processingManifest,
      processingManifestSha256: processingManifest.manifestSha256,
      consentReceiptRefs: ["receipt-A-opaque", "receipt-B-opaque"],
      finalizedAtMonoMs: 2_000,
      finalizedAtUtc: "2026-08-09T00:00:02.000Z",
      reason: "operator_end",
      retentionDeadlineAtMs: 9_999,
      retentionDeadlineAt: "1970-01-01T00:00:09.999Z",
      recordCount: 6,
      finalChainSha256: "b".repeat(64),
      trackDigests: {
        source_a: { recordCount: 1, sha256: "3".repeat(64) },
        source_b: { recordCount: 1, sha256: "4".repeat(64) },
        playout_to_a: { recordCount: 1, sha256: "5".repeat(64) },
        playout_to_b: { recordCount: 1, sha256: "6".repeat(64) },
      },
      tracks: {
        source_a: { frameCount: 1, byteCount: CANONICAL_AUDIO.bytesPerFrame, sha256: "3".repeat(64) },
        source_b: { frameCount: 1, byteCount: CANONICAL_AUDIO.bytesPerFrame, sha256: "4".repeat(64) },
        playout_to_a: { frameCount: 1, byteCount: CANONICAL_AUDIO.bytesPerFrame, sha256: "5".repeat(64) },
        playout_to_b: { frameCount: 1, byteCount: CANONICAL_AUDIO.bytesPerFrame, sha256: "6".repeat(64) },
      },
      manifestSha256: "c".repeat(64),
      },
    } as unknown as VerifiedSessionArtifactSummary,
    records,
  };
}

function completingLeasePort(
  artifact: VerifiedSessionArtifactSummary,
  records: ReplayableEvidenceRecords,
  outputDirectory: string,
  onComplete?: (completion: Readonly<{
    manifestFileSha256: string;
    completedAtMs: number;
  }>) => void,
): ManagedEvidenceExportPort {
  return {
    async withManagedExportLease<T>(
      _request: ManagedEvidenceExportLeaseRequest,
      transaction: (
        lease: ManagedEvidenceExportLease,
      ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
    ): Promise<ManagedEvidenceExportLeaseResult<T>> {
      const completion = await transaction({
        exportId,
        outputDirectory,
        artifact,
        async *records(): AsyncIterable<EvidenceRecord> {
          if (typeof records === "function") {
            for await (const record of records()) yield record;
            return;
          }
          for (const record of records) yield structuredClone(record);
        },
        nowMs: () => 11,
      });
      onComplete?.({
        manifestFileSha256: completion.manifestFileSha256,
        completedAtMs: completion.completedAtMs,
      });
      return {
        status: "completed" as const,
        exportId,
        manifestFileSha256: completion.manifestFileSha256,
        completedAtMs: completion.completedAtMs,
        value: completion.value,
      };
    },
  };
}

function largeStreamedArtifact(frameCount: number): StreamedArtifactFixture {
  const initial = verifiedArtifact();
  const laneByTrack = {
    source_a: "A_TO_B",
    source_b: "B_TO_A",
    playout_to_a: "B_TO_A",
    playout_to_b: "A_TO_B",
  } as const;
  const tracks = ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const;
  async function* records(): AsyncIterable<EvidenceRecord> {
    for (let index = 0; index < frameCount; index += 1) {
      for (const track of tracks) {
        const capturedAtMs = 1_000 + index * CANONICAL_AUDIO.frameDurationMs;
        yield {
          type: "audio",
          sessionId,
          track,
          timelineAtMonoMs: capturedAtMs,
          frame: createAudioFrame({
            sessionId,
            lane: laneByTrack[track],
            generation: 0,
            sequence: index,
            capturedAtMs,
            pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
          }),
        };
      }
    }
  }
  const recordCount = frameCount * tracks.length;
  const trackDigest = (sha256: string) => ({ recordCount: frameCount, sha256 });
  const artifact = {
    ...initial.artifact,
    audioTimeline: {
      originTimelineAtMonoMs: 1_000,
      durationSampleFrames: frameCount * CANONICAL_AUDIO.samplesPerFrame,
    },
    seal: {
      ...initial.artifact.seal,
      recordCount,
    },
    finalization: {
      ...initial.artifact.finalization,
      recordCount,
      trackDigests: {
        source_a: trackDigest("3".repeat(64)),
        source_b: trackDigest("4".repeat(64)),
        playout_to_a: trackDigest("5".repeat(64)),
        playout_to_b: trackDigest("6".repeat(64)),
      },
      tracks: {
        source_a: { frameCount, byteCount: frameCount * CANONICAL_AUDIO.bytesPerFrame, sha256: "3".repeat(64) },
        source_b: { frameCount, byteCount: frameCount * CANONICAL_AUDIO.bytesPerFrame, sha256: "4".repeat(64) },
        playout_to_a: { frameCount, byteCount: frameCount * CANONICAL_AUDIO.bytesPerFrame, sha256: "5".repeat(64) },
        playout_to_b: { frameCount, byteCount: frameCount * CANONICAL_AUDIO.bytesPerFrame, sha256: "6".repeat(64) },
      },
    },
  } as unknown as VerifiedSessionArtifactSummary;
  return { artifact, records };
}

async function writeTestFileChunk(
  file: FileHandle,
  chunk: Uint8Array,
  position: number,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Test writer could not write a managed export chunk");
    offset += bytesWritten;
  }
}

function observingExportFileWriter(
  binaryChunkByteLengths: number[],
): ManagedEvidenceExportFileWriterPort {
  return {
    async openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile> {
      const file = await open(path, "w", 0o600);
      try {
        await file.chmod(0o600);
      } catch (error: unknown) {
        await file.close().catch(() => undefined);
        throw error;
      }
      return {
        async truncate(byteLength: number): Promise<void> {
          await file.truncate(byteLength);
        },
        async write(chunk: ArrayBufferView | string, position: number): Promise<void> {
          const bytes = typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          if (typeof chunk !== "string") binaryChunkByteLengths.push(chunk.byteLength);
          await writeTestFileChunk(file, bytes, position);
        },
        async close(): Promise<void> {
          await file.close();
        },
      };
    },
  };
}

function staleTailExportFileWriter(): ManagedEvidenceExportFileWriterPort {
  return {
    async openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile> {
      await writeFile(path, "STALE-TAIL", { encoding: "utf8", mode: 0o600 });
      const file = await open(path, "r+");
      return {
        async truncate(byteLength: number): Promise<void> {
          await file.truncate(byteLength);
        },
        async write(chunk: ArrayBufferView | string, position: number): Promise<void> {
          const bytes = typeof chunk === "string"
            ? new TextEncoder().encode(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          await writeTestFileChunk(file, bytes, position);
        },
        async close(): Promise<void> {
          await file.close();
        },
      };
    },
  };
}

function faultInjectingExportFileWriter(options: Readonly<{
  readonly throwOnWrite?: number;
  readonly throwOnClose?: number;
}>): ManagedEvidenceExportFileWriterPort {
  const delegate = observingExportFileWriter([]);
  let writeCount = 0;
  let closeCount = 0;
  return {
    async openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile> {
      const file = await delegate.openPrivateOutput(path);
      return {
        truncate: file.truncate,
        async write(chunk: ArrayBufferView | string, position: number): Promise<void> {
          writeCount += 1;
          await file.write(chunk, position);
          if (options.throwOnWrite === writeCount) {
            throw new Error("injected managed export write failure");
          }
        },
        async close(): Promise<void> {
          const closeOrdinal = ++closeCount;
          await file.close();
          if (options.throwOnClose === closeOrdinal) {
            throw new Error("injected managed export close failure");
          }
        },
      };
    },
  };
}

async function createRealSealedStore(
  name: string,
  now: () => number = () => Date.parse("2026-08-09T12:00:00.000Z"),
): Promise<Readonly<{
  root: string;
  store: SessionArtifactStore;
  session: string;
  exportsRoot: string;
  archiveId: string;
  rootLease: EvidenceRootProcessLease;
}>> {
  const root = await isolatedDirectory("real-store-" + name);
  const exportsRoot = join(root, "exports");
  const session = "real-store-" + name;
  const store = new SessionArtifactStore({
    archiveDirectory: join(root, "archive"),
    keyDirectory: join(root, "keys"),
    exportDirectory: exportsRoot,
    receiptDirectory: join(root, "receipts"),
    securityBoundaryDirectory: root,
    strictAncestors: false,
    rootKey: Buffer.alloc(32, 13),
    dataOwnerId: configuredEvidenceReviewGrant.dataOwnerId,
    minimumFreeBytes: 1,
    now,
  });
  const rootLease = await store.acquireEvidenceRootLease("server");
  try {
    const processingManifest = mixedRegionProcessingManifest();
    const persist = async (value: EvidenceRecord): Promise<void> => {
      await store.persist(value);
    };
    await persist({
      type: "session_event",
      sessionId: session,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId: session,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: {
          status: "waiting",
          spec: {
            sideA: { language: "en-US" },
            sideB: { language: "zh-TW" },
            provider: "openai_controlled",
            mode: "fast",
            processingManifest,
            evidenceReviewGrant: configuredEvidenceReviewGrant,
          },
        },
      },
    } as unknown as EvidenceRecord);
    await store.flush(session);

    const preflight = await store.preflightRecorder({
      sessionId: session,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected encrypted preflight to succeed");
    await persist({
      type: "recorder_preflight",
      sessionId: session,
      timestampMonoMs: 2,
      preflight,
    });
    for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
      await persist({
        type: "session_event",
        sessionId: session,
        event: {
          type: "participant_consent",
          cursor,
          sessionId: session,
          timestampMonoMs: cursor,
          lane: null,
          generation: null,
          side,
          consentId: "consent-" + side,
          recording: true,
          processing: true,
          consentPolicyRef: processingManifest.consentPolicyRef,
        },
      } as unknown as EvidenceRecord);
    }
    const laneByTrack = {
      source_a: "A_TO_B",
      source_b: "B_TO_A",
      playout_to_a: "B_TO_A",
      playout_to_b: "A_TO_B",
    } as const;
    for (const [index, track] of ([
      "source_a",
      "source_b",
      "playout_to_a",
      "playout_to_b",
    ] as const).entries()) {
      await persist({
        type: "audio",
        sessionId: session,
        track,
        timelineAtMonoMs: 10,
        frame: createAudioFrame({
          sessionId: session,
          lane: laneByTrack[track],
          generation: 0,
          sequence: 0,
          capturedAtMs: 10,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
        }),
      });
    }
    await store.flush(session);
    const finalization = await store.finalize({
      sessionId: session,
      processingManifestSha256: processingManifest.manifestSha256,
      finalizedAtMonoMs: 20,
      reason: "operator_end",
      lastPersistedEventCursor: 3,
    });
    assert.equal(finalization.status, "sealed");
    assert.equal(finalization.processingManifestSha256, processingManifest.manifestSha256);
    const descriptor = await store.artifact({ sessionId: session });
    assert.ok(descriptor);
    assert.equal(descriptor.status, "sealed");
    return Object.freeze({
      root,
      store,
      session,
      exportsRoot,
      archiveId: descriptor.archiveId,
      rootLease,
    });
  } catch (error: unknown) {
    await rootLease.release();
    throw error;
  }
}

function testCanonicalJson(value: unknown): string {
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

async function seedAuditPendingManagedExport(
  root: string,
  archiveId: string,
): Promise<void> {
  // There is no public fault-injection seam for the post-audit sidecar write;
  // rewrap only this fixture's encrypted metadata to exercise the durable
  // audit_pending retry branch without platform-specific ACL races.
  const sidecarPath = join(root, "keys", archiveId + ".key.json");
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as Record<string, unknown>;
  const wrappingKey = Buffer.from(hkdfSync(
    "sha256",
    Buffer.alloc(32, 13),
    Buffer.from("fast-translation/session-artifact-store/v3", "utf8"),
    Buffer.from("dek_wrap", "utf8"),
    32,
  ));
  const metadataBlob = sidecar.metadata as Record<string, unknown>;
  const decryptor = createDecipheriv(
    "aes-256-gcm",
    wrappingKey,
    Buffer.from(String(metadataBlob.iv), "base64"),
  );
  decryptor.setAAD(Buffer.from(testCanonicalJson({
    schemaVersion: 3,
    archiveId,
    index: 1,
    purpose: "metadata",
  }), "utf8"));
  decryptor.setAuthTag(Buffer.from(String(metadataBlob.tag), "base64"));
  const metadataPlaintext = Buffer.concat([
    decryptor.update(Buffer.from(String(metadataBlob.ciphertext), "base64")),
    decryptor.final(),
  ]);
  const metadata = JSON.parse(metadataPlaintext.toString("utf8")) as Record<string, unknown>;
  const managedExport = metadata.managedExport;
  assert.ok(managedExport !== null && typeof managedExport === "object");
  metadata.managedExport = {
    ...(managedExport as Record<string, unknown>),
    status: "audit_pending",
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, iv);
  cipher.setAAD(Buffer.from(testCanonicalJson({
    schemaVersion: 3,
    archiveId,
    index: 1,
    purpose: "metadata",
  }), "utf8"));
  const encryptedMetadata = Buffer.concat([
    cipher.update(Buffer.from(testCanonicalJson(metadata), "utf8")),
    cipher.final(),
  ]);
  sidecar.metadata = {
    v: 3,
    alg: "A256GCM",
    index: 1,
    purpose: "metadata",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: encryptedMetadata.toString("base64"),
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar) + "\n", { encoding: "utf8", mode: 0o600 });
}

const managedExportHttpPayload = Object.freeze({
  status: "completed" as const,
  exportId: "e".repeat(64),
  manifestFileSha256: "a".repeat(64),
  processingManifestSha256: "b".repeat(64),
  finalizationManifestSha256: "c".repeat(64),
  retentionDeadlineAt: "2026-08-10T12:00:00.000Z",
  recordCount: 4,
  finalChainSha256: "d".repeat(64),
  evidenceSealSha256: "f".repeat(64),
  trackDigests: Object.freeze({
    source_a: Object.freeze({ recordCount: 1, sha256: "1".repeat(64) }),
    source_b: Object.freeze({ recordCount: 1, sha256: "2".repeat(64) }),
    playout_to_a: Object.freeze({ recordCount: 1, sha256: "3".repeat(64) }),
    playout_to_b: Object.freeze({ recordCount: 1, sha256: "4".repeat(64) }),
  }),
});

interface ManagedExportHttpRequest {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly authorization: string | undefined;
  readonly body: string;
}

interface ManagedExportHttpFixture {
  readonly url: string;
  readonly requests: ManagedExportHttpRequest[];
  close(): Promise<void>;
}

async function createManagedExportHttpFixture(
  statusCode = 200,
  payload: unknown = managedExportHttpPayload,
  chunkSize = 0,
): Promise<ManagedExportHttpFixture> {
  const requests: ManagedExportHttpRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.statusCode = statusCode;
      response.setHeader("content-type", "application/json");
      const body = JSON.stringify(payload);
      if (chunkSize <= 0) {
        response.end(body);
      } else {
        for (let offset = 0; offset < body.length; offset += chunkSize) {
          response.write(body.slice(offset, offset + chunkSize));
        }
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Expected a loopback HTTP fixture address");
  }
  return {
    url: "http://127.0.0.1:" + address.port,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

async function createHangingManagedExportHttpFixture(): Promise<Readonly<{
  readonly url: string;
  close(): Promise<void>;
}>> {
  const server = createServer(() => {
    // Keep the request open so the client must enforce its deadline.
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Expected a loopback HTTP fixture address");
  }
  return {
    url: "http://127.0.0.1:" + address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    }),
  };
}

function childProcessEnvironment(temporaryDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  delete environment.EVIDENCE_ROOT_KEY_BASE64;
  delete environment.OPENAI_API_KEY;
  delete environment.PALABRA_API_KEY;
  return {
    ...environment,
    EVIDENCE_OWNER_ACCESS_TOKEN: "retention-owner-token",
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
    TMPDIR: temporaryDirectory,
    NO_COLOR: "1",
  };
}

describe("managed finalized evidence export", () => {
  it("does not create an export for an artifact whose finalization did not seal", async () => {
    const outputDirectory = join(taskTemp, "unsealed");
    await rm(outputDirectory, { recursive: true, force: true });
    await mkdir(outputDirectory, { recursive: true });

    let completed = false;
    const artifacts = completingLeasePort({
      archiveId,
      status: "FINALIZATION_FAILED",
    } as unknown as VerifiedSessionArtifactSummary, [], outputDirectory, () => {
      completed = true;
    });

    await assert.rejects(
      exportManagedFinalizedEvidence({
        artifacts,
        lookup: { archiveId },
        commandId: "b".repeat(36),
      authority: { kind: "retention_owner", actorId: "owner-1" },
        requestedAtMs: 1_000,
      }),
      /sealed/u,
    );
    assert.equal(completed, false);
    await assert.rejects(access(join(outputDirectory, "export-manifest.json")));
  });

  it("exports only the verified finalized artifact into its managed workspace", async () => {
    const outputDirectory = await isolatedDirectory("sealed");
    const { artifact, records } = verifiedArtifact();
    let completedManifestHash: string | undefined;
    let completedAtMs: number | undefined;
    const artifacts = completingLeasePort(artifact, records, outputDirectory, (completion) => {
      completedManifestHash = completion.manifestFileSha256;
      completedAtMs = completion.completedAtMs;
    });

    const result = await exportManagedFinalizedEvidence({
      artifacts,
      lookup: { archiveId },
      commandId: "2d3ad424-a632-4e3a-8fcd-b0d87a31c4df",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
    });

    assert.equal(result.status, "completed");
    if (result.status !== "completed") throw new Error("expected completed export");
    assert.equal(result.exportId, exportId);
    assert.equal(result.processingManifestSha256, artifact.finalization.processingManifestSha256);
    assert.equal(result.finalizationManifestSha256, "c".repeat(64));
    assert.equal(completedAtMs, 11, "completion time must come from the active store lease clock");
    assert.deepEqual(result.trackDigests.source_a, { recordCount: 1, sha256: "3".repeat(64) });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(sessionId, "u"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(archiveId, "u"));
    assert.doesNotMatch(JSON.stringify(result), new RegExp(outputDirectory.replace(/[\\/]/gu, "[\\\\/]"), "u"));

    const manifestBytes = await readFile(join(outputDirectory, "export-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
    assert.equal(manifest.kind, "managed_finalized_four_track_evidence_export");
    assert.equal(manifest.exportId, exportId);
    assert.equal((manifest.processing as { provider: string }).provider, "openai_controlled");
    assert.equal((manifest.processing as { acceptanceImpact: string }).acceptanceImpact, "NOT_RUN");
    assert.equal(
      ((manifest.processing as { profile: { id: string } }).profile.id),
      "synthetic-keyless-poc",
    );
    const serviceRegions = (manifest.processing as {
      serviceRegions: readonly Readonly<{
        id: string;
        role: string;
        provider: string;
        category: string;
        region: Readonly<{ status: string }>;
      }>[];
    }).serviceRegions;
    const expectedServiceRegionsById = Object.fromEntries(
      artifact.finalization.processingManifest.services.map((service) => [service.id, {
        role: service.role,
        provider: service.provider,
        category: service.category,
        region: service.region,
      }]),
    );
    const projectedServiceRegionsById = Object.fromEntries(
      serviceRegions.map((service) => [service.id, {
        role: service.role,
        provider: service.provider,
        category: service.category,
        region: service.region,
      }]),
    );
    assert.equal(serviceRegions.length, 3, "the real export must project every processing service");
    assert.deepEqual(
      Object.keys(projectedServiceRegionsById).sort(),
      ["synthetic-text-translation", "synthetic-transcription", "synthetic-tts"],
    );
    assert.deepEqual(projectedServiceRegionsById, expectedServiceRegionsById);
    assert.equal(serviceRegions.filter((service) => service.region.status === "verified").length, 1);
    assert.equal(serviceRegions.filter((service) => service.region.status === "unverified").length, 2);
    assert.equal(
      ((manifest.finalization as { retentionDeadlineAtMs: number }).retentionDeadlineAtMs),
      9_999,
    );
    assert.deepEqual(
      ((manifest.finalization as {
        finalizedTracks: { source_a: { frameCount: number; byteCount: number; sha256: string } };
      }).finalizedTracks.source_a),
      { frameCount: 1, byteCount: CANONICAL_AUDIO.bytesPerFrame, sha256: "3".repeat(64) },
    );
    assert.doesNotMatch(manifestBytes.toString("utf8"), new RegExp(sessionId, "u"));
    assert.doesNotMatch(manifestBytes.toString("utf8"), new RegExp(archiveId, "u"));
    assert.equal(
      completedManifestHash,
      createHash("sha256").update(manifestBytes).digest("hex"),
    );

    const events = await readFile(join(outputDirectory, "events.jsonl"), "utf8");
    assert.match(events, /session_closed/u);
    assert.doesNotMatch(events, /pcm16le|base64/u);
    for (const sentinel of [
      sessionOpenedAccessToken,
      sessionOpenedQr,
      sessionOpenedOwnerId,
      sessionOpenedReviewerId,
      sessionOpenedEvidenceReviewGrantId,
    ]) {
      assert.doesNotMatch(events, literalPattern(sentinel));
    }
    assert.doesNotMatch(events, /#access=/u);
    const sessionOpened = events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event?: { type?: string; snapshot?: unknown } })
      .find((record) => record.event?.type === "session_opened");
    assert.deepEqual(sessionOpened?.event?.snapshot, {
      status: "waiting",
      spec: {
        sideA: { language: "en-US" },
        sideB: { language: "zh-TW" },
        provider: "openai_controlled",
        mode: "fast",
        processingManifestSha256: artifact.finalization.processingManifestSha256,
      },
    });
    const mixed = await readFile(join(outputDirectory, "four-track.wav"));
    assert.equal(mixed.toString("ascii", 0, 4), "RIFF");
    assert.equal(mixed.readUInt16LE(22), 4);
    assert.deepEqual([...mixed.subarray(44, 52)], [1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("does not return managed completion before every plaintext file and workspace sync", async () => {
    const outputDirectory = await isolatedDirectory("durability-order");
    const { artifact, records } = verifiedArtifact();
    const syncedPaths: string[] = [];
    let pathsAtCompletion: readonly string[] | undefined;
    const artifacts = completingLeasePort(artifact, records, outputDirectory, () => {
      pathsAtCompletion = [...syncedPaths];
    });
    const expectedFilePaths = [
      join(outputDirectory, "events.jsonl"),
      join(outputDirectory, "source_a.wav"),
      join(outputDirectory, "source_b.wav"),
      join(outputDirectory, "playout_to_a.wav"),
      join(outputDirectory, "playout_to_b.wav"),
      join(outputDirectory, "four-track.wav"),
      join(outputDirectory, "checksums.sha256"),
      join(outputDirectory, "export-manifest.json"),
    ];
    const durability: ManagedEvidenceExportDurabilityPort = {
      async syncFile(path: string): Promise<void> {
        await access(path);
        syncedPaths.push(path);
      },
      async syncDirectory(path: string): Promise<void> {
        await access(path);
        syncedPaths.push(path);
      },
    };

    const result = await exportManagedFinalizedEvidence({
      artifacts,
      lookup: { archiveId },
      commandId: "d81f4979-b3bb-4205-bb91-36e9fd5f207f",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
      durability,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(syncedPaths, [...expectedFilePaths, outputDirectory]);
    assert.deepEqual(pathsAtCompletion, syncedPaths);
  });

  it("aborts and cleans the managed workspace without a stale receipt when a durability sync fails", async () => {
    const { store, session, exportsRoot, rootLease } = await createRealSealedStore("durability-failure");
    let syncAttempts = 0;
    try {
      await assert.rejects(
        exportManagedFinalizedEvidence({
          artifacts: store,
          lookup: { sessionId: session },
          commandId: "ced1d2de-36c0-4e1a-95c1-93edba51b15d",
      authority: configuredOwnerAuthority,
          requestedAtMs: 30,
          durability: {
            async syncFile(): Promise<void> {
              syncAttempts += 1;
              throw new Error("injected durability failure");
            },
            async syncDirectory(): Promise<void> {
              throw new Error("directory sync must not run after a file sync failure");
            },
          },
        }),
        /injected durability failure/u,
      );
      assert.equal(syncAttempts, 1);
      assert.deepEqual(await readdir(exportsRoot), []);

      const retry = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId: "ced1d2de-36c0-4e1a-95c1-93edba51b15d",
      authority: configuredOwnerAuthority,
        requestedAtMs: 31,
      });
      assert.equal(retry.status, "completed", "a failed durability barrier must not leave a stale receipt");
      assert.equal((await readdir(exportsRoot)).length, 1);
    } finally {
      await rootLease.release();
    }
  });

  it("cleans real export state after writer write/close failures and retries the same command", async () => {
    for (const [name, writerOptions, expectedError] of [
      ["write", { throwOnWrite: 6 }, /injected managed export write failure/u],
      ["close", { throwOnClose: 1 }, /injected managed export close failure/u],
    ] as const) {
      const { root, store, session, exportsRoot, archiveId: realArchiveId, rootLease } =
        await createRealSealedStore("writer-failure-" + name);
      const commandId = "writer-failure-command-" + name;
      try {
        await assert.rejects(
          exportManagedFinalizedEvidence({
            artifacts: store,
            lookup: { sessionId: session },
            commandId,
      authority: configuredOwnerAuthority,
            requestedAtMs: 30,
            fileWriter: faultInjectingExportFileWriter(writerOptions),
          }),
          expectedError,
        );
        assert.deepEqual(await readdir(exportsRoot), []);
        for (const suffix of [".audit.jsonl.enc", ".audit.head.enc"]) {
          await assert.rejects(
            access(join(root, "receipts", realArchiveId + suffix)),
            /ENOENT/u,
            "a failed export must not append a completion audit",
          );
        }

        const retry = await exportManagedFinalizedEvidence({
          artifacts: store,
          lookup: { sessionId: session },
          commandId,
      authority: configuredOwnerAuthority,
          requestedAtMs: 31,
        });
        assert.equal(retry.status, "completed");
        assert.deepEqual(await readdir(exportsRoot), [realArchiveId]);
      } finally {
        await rootLease.release();
      }
    }
  });

  it("truncates custom replacement files before positional manifest writes", async () => {
    const outputDirectory = await isolatedDirectory("stale-tail-writer");
    const { artifact, records } = verifiedArtifact();
    const result = await exportManagedFinalizedEvidence({
      artifacts: completingLeasePort(artifact, records, outputDirectory),
      lookup: { archiveId },
      commandId: "b2fc6c8e-a8fb-4f89-93dc-d0b0d9d129db",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
      fileWriter: staleTailExportFileWriter(),
    });
    assert.equal(result.status, "completed");
    const manifest = await readFile(join(outputDirectory, "export-manifest.json"), "utf8");
    assert.doesNotMatch(manifest, /STALE-TAIL/u);
    assert.doesNotThrow(() => JSON.parse(manifest));
    const events = await readFile(join(outputDirectory, "events.jsonl"), "utf8");
    assert.doesNotMatch(events, /STALE-TAIL/u);
  });

  it("streams bounded binary chunks while exporting a verified timeline far larger than one chunk", async () => {
    const outputDirectory = await isolatedDirectory("bounded-large-timeline");
    const { artifact, records } = largeStreamedArtifact(128);
    const artifacts = completingLeasePort(artifact, records, outputDirectory);
    const binaryChunkByteLengths: number[] = [];
    const result = await exportManagedFinalizedEvidence({
      artifacts,
      lookup: { archiveId },
      commandId: "71309c46-237d-4ac7-a4ef-fd1aa98f5d92",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
      fileWriter: observingExportFileWriter(binaryChunkByteLengths),
    });
    assert.equal(result.status, "completed");
    assert.ok(binaryChunkByteLengths.length > 0, "the public writer must receive binary export chunks");
    assert.ok(
      binaryChunkByteLengths.every(
        (bytes) => bytes <= MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES,
      ),
    );
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "export-manifest.json"), "utf8"),
    ) as Readonly<{
      tracks: Readonly<Record<string, Readonly<{ sha256: string; dataBytes: number }>>>;
      fourTrack: Readonly<{ sha256: string; dataBytes: number }>;
    }>;
    assert.ok(manifest.fourTrack.dataBytes > MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES * 100);
    for (const track of ["source_a", "source_b", "playout_to_a", "playout_to_b"]) {
      const wavBytes = await readFile(join(outputDirectory, track + ".wav"));
      assert.equal(
        createHash("sha256").update(wavBytes).digest("hex"),
        manifest.tracks[track]?.sha256,
      );
      assert.ok(
        (await stat(join(outputDirectory, track + ".wav"))).size >
          MANAGED_EVIDENCE_EXPORT_MAX_BINARY_WRITE_BYTES,
      );
    }
    const fourTrackBytes = await readFile(join(outputDirectory, "four-track.wav"));
    assert.equal(createHash("sha256").update(fourTrackBytes).digest("hex"), manifest.fourTrack.sha256);
    assert.equal(
      result.status === "completed" ? result.manifestFileSha256 : undefined,
      createHash("sha256")
        .update(await readFile(join(outputDirectory, "export-manifest.json")))
        .digest("hex"),
    );
  });

  it("rejects an oversized WAV layout before opening or truncating any output", async () => {
    const { artifact, records } = verifiedArtifact();
    const durationLimitFrames = Math.floor(
      (MANAGED_EVIDENCE_EXPORT_MAX_DURATION_MS * CANONICAL_AUDIO.sampleRateHz) / 1_000,
    );
    const aggregateLimitFrames = Math.floor(
      (MANAGED_EVIDENCE_EXPORT_MAX_AGGREGATE_WAV_BYTES - 5 * 44) / 16,
    );
    const fourTrackRiffLimitFrames = Math.floor((0xffff_ffff - 36) / 8);
    for (const [name, sampleFrames, expectedError] of [
      ["duration", durationLimitFrames + 1, /maximum duration/u],
      ["aggregate", aggregateLimitFrames + 1, /maximum aggregate WAV size/u],
      ["riff", fourTrackRiffLimitFrames + 1, /RIFF/u],
    ] as const) {
      const outputDirectory = await isolatedDirectory("oversized-wav-layout-" + name);
      const oversized = {
        ...artifact,
        audioTimeline: {
          ...artifact.audioTimeline,
          durationSampleFrames: sampleFrames,
        },
      } as VerifiedSessionArtifactSummary;
      const openedPaths: string[] = [];
      const fileWriter: ManagedEvidenceExportFileWriterPort = {
        async openPrivateOutput(path: string): Promise<ManagedEvidenceExportWritableFile> {
          openedPaths.push(path);
          throw new Error("WAV output must not be opened after admission failure");
        },
      };

      await assert.rejects(
        exportManagedFinalizedEvidence({
          artifacts: completingLeasePort(oversized, records, outputDirectory),
          lookup: { archiveId },
          commandId: "0f8d1fd8-6f03-4c57-a194-567e2d3fb77e",
      authority: configuredOwnerAuthority,
          requestedAtMs: 10,
          fileWriter,
        }),
        expectedError,
      );
      assert.deepEqual(openedPaths, []);
      assert.deepEqual(await readdir(outputDirectory), []);
    }
  });

  it("rejects inconsistent sealed finalization before lease writes", async () => {
    const outputDirectory = await isolatedDirectory("mismatched-finalization");
    const { artifact, records } = verifiedArtifact();
    const inconsistent = {
      ...artifact,
      seal: { ...artifact.seal, recordCount: artifact.seal.recordCount + 1 },
    } as VerifiedSessionArtifactSummary;
    const artifacts = completingLeasePort(inconsistent, records, outputDirectory);

    await assert.rejects(
      exportManagedFinalizedEvidence({
        artifacts,
        lookup: { archiveId },
        commandId: "a8a9960a-337a-4d7b-b359-d878458f0d6b",
      authority: configuredOwnerAuthority,
        requestedAtMs: 10,
      }),
      /sealed ledger/u,
    );
    await assert.rejects(access(join(outputDirectory, "export-manifest.json")));
  });

  it("rejects a sealed artifact whose finalized per-track count disagrees with its ledger digest", async () => {
    const outputDirectory = await isolatedDirectory("mismatched-track-finalization");
    const { artifact, records } = verifiedArtifact();
    const inconsistent = {
      ...artifact,
      finalization: {
        ...artifact.finalization,
        tracks: {
          ...artifact.finalization.tracks,
          source_a: { ...artifact.finalization.tracks.source_a, frameCount: 0 },
        },
      },
    } as VerifiedSessionArtifactSummary;
    const artifacts = completingLeasePort(inconsistent, records, outputDirectory);

    await assert.rejects(
      exportManagedFinalizedEvidence({
        artifacts,
        lookup: { archiveId },
        commandId: "5a906ba3-d50d-45d5-bb3b-f20fb2a7d946",
      authority: configuredOwnerAuthority,
        requestedAtMs: 10,
      }),
      /finalized audio track digest/u,
    );
    await assert.rejects(access(join(outputDirectory, "export-manifest.json")));
  });

  it("surfaces a managed-export command conflict without writing plaintext files", async () => {
    const outputDirectory = await isolatedDirectory("conflict");
    const artifacts = {
      async withManagedExportLease() {
        return { status: "conflict" as const };
      },
    };

    const result = await exportManagedFinalizedEvidence({
      artifacts: artifacts as unknown as ManagedEvidenceExportPort,
      lookup: { archiveId },
      commandId: "8f15d1c1-6ec8-445c-ae96-779c87cdeae9",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
    });
    assert.deepEqual(result, { status: "conflict" });
    await assert.rejects(access(join(outputDirectory, "export-manifest.json")));
  });

  it("surfaces an expired managed artifact without creating plaintext files", async () => {
    const outputDirectory = await isolatedDirectory("expired");
    const artifacts = {
      async withManagedExportLease() {
        return { status: "expired" as const };
      },
    };

    const result = await exportManagedFinalizedEvidence({
      artifacts: artifacts as unknown as ManagedEvidenceExportPort,
      lookup: { archiveId },
      commandId: "2ec97844-6faf-4e53-8ee6-02f641e8d955",
      authority: configuredOwnerAuthority,
      requestedAtMs: 10,
    });
    assert.deepEqual(result, { status: "expired" });
    await assert.rejects(access(join(outputDirectory, "export-manifest.json")));
  });

  it("exports a real sealed artifact and removes its managed plaintext workspace on retention deletion", async () => {
    const { store, session, exportsRoot, archiveId: realArchiveId, rootLease } =
      await createRealSealedStore("retention-delete");
    try {
      const result = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId: "43c9f32f-15b9-4ae0-a169-35e14896182c",
      authority: configuredOwnerAuthority,
        requestedAtMs: 30,
      });
      assert.equal(result.status, "completed");
      assert.deepEqual(await readdir(exportsRoot), [realArchiveId]);

      const deletion = await store.deleteEvidence({
        sessionId: session,
        commandId: "3ce0a597-3d8b-4215-bde1-6b457bf7d6f4",
      authority: configuredOwnerAuthority,
        reason: "Customer requested deletion",
        requestedAtMs: 40,
      });
      assert.equal(deletion.status, "completed");
      if (deletion.status !== "completed") throw new Error("Expected evidence deletion to complete");
      assert.match(deletion.deletionReceiptId, /^[a-f0-9]{64}$/u);
      const postDelete = await store.withManagedExportLease({
        lookup: { sessionId: session },
        commandId: "7d21ec49-ef62-4d9b-844e-ea4f90e37d16",
        authority: configuredOwnerAuthority,
        requestedAtMs: 50,
      }, async () => {
        throw new Error("Deleted evidence must not issue a managed export lease");
      });
      assert.deepEqual(postDelete, { status: "not_found" });
      assert.deepEqual(await readdir(exportsRoot), []);
    } finally {
      await rootLease.release();
    }
  });

  it("rejects an exact-command retry after any completed export workspace tamper without rerunning the callback", async () => {
    const mutations: ReadonlyArray<Readonly<{
      readonly name: string;
      readonly apply: (workspace: string) => Promise<void>;
    }>> = [
      {
        name: "events-tampered",
        async apply(workspace: string): Promise<void> {
          await writeFile(join(workspace, "events.jsonl"), "tampered\n", { encoding: "utf8" });
        },
      },
      {
        name: "wav-truncated",
        async apply(workspace: string): Promise<void> {
          const file = await open(join(workspace, "source_a.wav"), "r+");
          try {
            await file.truncate(0);
          } finally {
            await file.close();
          }
        },
      },
      {
        name: "checksums-deleted",
        async apply(workspace: string): Promise<void> {
          await rm(join(workspace, "checksums.sha256"));
        },
      },
      {
        name: "unexpected-entry",
        async apply(workspace: string): Promise<void> {
          await writeFile(join(workspace, "unexpected.txt"), "unexpected", { encoding: "utf8" });
        },
      },
    ];

    const { store, session, exportsRoot, archiveId: realArchiveId, rootLease } =
      await createRealSealedStore("cached-export-integrity");
    const commandId = randomUUID();
    try {
      const initial = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId,
        authority: configuredOwnerAuthority,
        requestedAtMs: 30,
      });
      assert.equal(initial.status, "completed");
      const workspace = join(exportsRoot, realArchiveId);
      const originalFiles = new Map<string, Buffer>();
      for (const name of [
        "events.jsonl",
        "source_a.wav",
        "source_b.wav",
        "playout_to_a.wav",
        "playout_to_b.wav",
        "four-track.wav",
        "checksums.sha256",
        "export-manifest.json",
      ]) {
        originalFiles.set(name, await readFile(join(workspace, name)));
      }

      for (const mutation of mutations) {
        await mutation.apply(workspace);
        let callbackOutputOpenCount = 0;
        const retry = await exportManagedFinalizedEvidence({
          artifacts: store,
          lookup: { sessionId: session },
          commandId,
          authority: configuredOwnerAuthority,
          requestedAtMs: 31,
          fileWriter: {
            async openPrivateOutput(): Promise<ManagedEvidenceExportWritableFile> {
              callbackOutputOpenCount += 1;
              throw new Error("tampered cached export must not reacquire its callback");
            },
          },
        });

        assert.deepEqual(retry, { status: "conflict" }, mutation.name);
        assert.equal(callbackOutputOpenCount, 0, "cached export integrity failure must not rerun the callback");
        assert.doesNotMatch(JSON.stringify(retry), literalPattern(realArchiveId));
        assert.doesNotMatch(JSON.stringify(retry), literalPattern(workspace));

        for (const [name, contents] of originalFiles) {
          await writeFile(join(workspace, name), contents, { mode: 0o600 });
        }
        await rm(join(workspace, "unexpected.txt"), { force: true });
      }
    } finally {
      await rootLease.release();
    }
  });

  it("returns expired when a cached export crosses its deadline after workspace verification", async () => {
    const baseNowMs = Date.parse("2026-08-09T12:00:00.000Z");
    let advanceForRetry = false;
    let retryNowCalls = 0;
    let expiredAtMs = Number.MAX_SAFE_INTEGER;
    const now = (): number => {
      if (!advanceForRetry) return baseNowMs;
      retryNowCalls += 1;
      return retryNowCalls >= 2 ? expiredAtMs : baseNowMs;
    };
    const { store, session, rootLease } = await createRealSealedStore(
      "cached-export-deadline-crossing",
      now,
    );
    const commandId = randomUUID();
    try {
      const descriptor = await store.artifact({ sessionId: session });
      assert.ok(descriptor);
      if (descriptor === undefined) throw new Error("Expected the real fixture to be sealed");
      if (descriptor.retentionDeadlineAtMs === undefined) {
        throw new Error("Expected the real fixture to have a retention deadline");
      }
      expiredAtMs = descriptor.retentionDeadlineAtMs;

      const initial = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId,
        authority: configuredOwnerAuthority,
        requestedAtMs: 30,
      });
      assert.equal(initial.status, "completed");

      advanceForRetry = true;
      let callbackOutputOpenCount = 0;
      const retry = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId,
        authority: configuredOwnerAuthority,
        requestedAtMs: 31,
        fileWriter: {
          async openPrivateOutput(): Promise<ManagedEvidenceExportWritableFile> {
            callbackOutputOpenCount += 1;
            throw new Error("expired cached export must not reacquire its callback");
          },
        },
      });

      assert.deepEqual(retry, { status: "expired" });
      assert.ok(retryNowCalls >= 2, "the retry clock must be sampled before and after workspace verification");
      assert.equal(callbackOutputOpenCount, 0);
    } finally {
      await rootLease.release();
    }
  });

  it("returns expired when an audit-pending retry crosses its deadline during completion commit", async () => {
    const baseNowMs = Date.parse("2026-08-09T12:00:00.000Z");
    let advanceForRetry = false;
    let retryNowCalls = 0;
    let expiredAtMs = Number.MAX_SAFE_INTEGER;
    const now = (): number => {
      if (!advanceForRetry) return baseNowMs;
      retryNowCalls += 1;
      return retryNowCalls >= 3 ? expiredAtMs : baseNowMs;
    };
    const { root, store, session, archiveId: realArchiveId, rootLease } =
      await createRealSealedStore("cached-export-audit-pending-deadline", now);
    const commandId = randomUUID();
    try {
      const descriptor = await store.artifact({ sessionId: session });
      assert.ok(descriptor);
      if (descriptor === undefined || descriptor.retentionDeadlineAtMs === undefined) {
        throw new Error("Expected the real fixture to have a retention deadline");
      }
      expiredAtMs = descriptor.retentionDeadlineAtMs;

      const initial = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId,
        authority: configuredOwnerAuthority,
        requestedAtMs: 30,
      });
      assert.equal(initial.status, "completed");
      await seedAuditPendingManagedExport(root, realArchiveId);
      advanceForRetry = true;

      let callbackOutputOpenCount = 0;
      const retry = await exportManagedFinalizedEvidence({
        artifacts: store,
        lookup: { sessionId: session },
        commandId,
        authority: configuredOwnerAuthority,
        requestedAtMs: 31,
        fileWriter: {
          async openPrivateOutput(): Promise<ManagedEvidenceExportWritableFile> {
            callbackOutputOpenCount += 1;
            throw new Error("expired audit-pending export must not reacquire its callback");
          },
        },
      });

      assert.deepEqual(retry, { status: "expired" });
      assert.ok(retryNowCalls >= 3, "the retry clock must be sampled through completion audit/commit");
      assert.equal(callbackOutputOpenCount, 0);
    } finally {
      await rootLease.release();
    }
  });

  it("aborts partial plaintext and releases the artifact lease before deletion can proceed", async () => {
    const { store, session, exportsRoot, archiveId: realArchiveId, rootLease } =
      await createRealSealedStore("abort-and-delete");
    let deletionSettled = false;
    let deletionPromise: ReturnType<typeof store.deleteEvidence> | undefined;
    let sweepSettled = false;
    let sweepPromise: ReturnType<typeof store.sweepExpired> | undefined;
    try {
      await assert.rejects(
        store.withManagedExportLease({
          lookup: { sessionId: session },
          commandId: "0c7a5136-8cf7-4a6b-830a-fc40fd6d3ebd",
      authority: configuredOwnerAuthority,
          requestedAtMs: 30,
        }, async (lease) => {
          await writeFile(join(lease.outputDirectory, "partial-plaintext.txt"), "must-not-escape");
          deletionPromise = store.deleteEvidence({
            sessionId: session,
            commandId: "54fdec50-c95a-4516-a70f-8490b30d1a3d",
      authority: configuredOwnerAuthority,
            reason: "Customer requested deletion",
            requestedAtMs: 40,
          });
          void deletionPromise.then(
            () => { deletionSettled = true; },
            () => { deletionSettled = true; },
          );
          sweepPromise = store.sweepExpired();
          void sweepPromise.then(
            () => { sweepSettled = true; },
            () => { sweepSettled = true; },
          );
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(deletionSettled, false, "delete must wait for the export transaction");
          assert.equal(sweepSettled, false, "sweep must wait for the export transaction");
          throw new Error("deliberate export write failure");
        }),
        /deliberate export write failure/u,
      );
      assert.deepEqual(await readdir(exportsRoot), []);
      if (deletionPromise === undefined) throw new Error("Expected deletion to queue behind export lease");
      if (sweepPromise === undefined) throw new Error("Expected sweep to queue behind export lease");
      const deletion = await deletionPromise;
      const sweep = await sweepPromise;
      assert.equal(deletion.status, "completed");
      assert.equal(sweep.status, "completed");
      const postDelete = await store.withManagedExportLease({
        lookup: { sessionId: session },
        commandId: "9b6fb1ca-b7a1-43e3-a2ec-89a21a1ebcf7",
        authority: configuredOwnerAuthority,
        requestedAtMs: 50,
      }, async () => {
        throw new Error("Deleted evidence must not issue a managed export lease");
      });
      assert.deepEqual(postDelete, { status: "not_found" });
      assert.deepEqual(await readdir(exportsRoot), []);
      await assert.rejects(access(join(exportsRoot, realArchiveId, "partial-plaintext.txt")));
    } finally {
      await rootLease.release();
    }
  });
});

describe("authenticated managed evidence export CLI", () => {
  const accessToken = "retention-owner-token";
  const commandId = canonicalProcessCommandId;
  const session = "owner-session-42";

  function argumentsFor(baseUrl: string): string[] {
    return [
      "--base-url", baseUrl,
      "--session-id", session,
      "--command-id", commandId,
      "--acknowledge-plaintext-export",
    ];
  }

  it("requires an authenticated owner client and rejects offline export arguments", async () => {
    await assert.rejects(
      runManagedEvidenceExportCli([
        "--local-admin",
        "--archive-root", "forbidden",
        "--key-root", "forbidden",
        "--export-root", "forbidden",
        "--receipt-root", "forbidden",
      ]),
      /Unknown evidence administration argument --local-admin/u,
    );
    await assert.rejects(
      runManagedEvidenceExportCli([
        "--base-url", "http://127.0.0.1:1",
        "--session-id", session,
        "--command-id", commandId,
        "--acknowledge-plaintext-export",
      ], {}),
      /EVIDENCE_OWNER_ACCESS_TOKEN is required/u,
    );
    await assert.rejects(
      runManagedEvidenceExportCli([
        "--base-url", "http://127.0.0.1:1",
        "--session-id", session,
        "--command-id", commandId,
      ], {}),
      /--acknowledge-plaintext-export is required/u,
    );
  });

  it("does not send the bearer token to a non-loopback HTTP origin", async () => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected network request");
    };
    await assert.rejects(
      runManagedEvidenceExportCli(
        argumentsFor("http://198.51.100.1:4207"),
        { EVIDENCE_OWNER_ACCESS_TOKEN: accessToken },
        { fetch: fetchImplementation },
      ),
      /must use HTTPS unless it targets exact loopback HTTP/u,
    );
    assert.equal(fetchCalls, 0);
  });

  it("rejects an explicit zero port before contacting the owner route", async () => {
    let fetchCalls = 0;
    const fetchImplementation: typeof fetch = async () => {
      fetchCalls += 1;
      throw new Error("unexpected network request");
    };
    await assert.rejects(
      runManagedEvidenceExportCli(
        argumentsFor("http://127.0.0.1:0"),
        { EVIDENCE_OWNER_ACCESS_TOKEN: accessToken },
        { fetch: fetchImplementation },
      ),
      /unsafe port/u,
    );
    assert.equal(fetchCalls, 0);
  });

  it("bounds chunked HTTP responses before parsing them", async () => {
    const fixture = await createManagedExportHttpFixture(
      200,
      { ...managedExportHttpPayload, padding: "x".repeat(256 * 1024) },
      1_024,
    );
    try {
      await assert.rejects(
        runManagedEvidenceExportCli(argumentsFor(fixture.url), {
          EVIDENCE_OWNER_ACCESS_TOKEN: accessToken,
        }),
        /Evidence export response was invalid/u,
      );
    } finally {
      await fixture.close();
    }
  });

  it("fails a hanging owner request at the configured deadline", async () => {
    const fixture = await createHangingManagedExportHttpFixture();
    try {
      await assert.rejects(
        runManagedEvidenceExportCli(
          argumentsFor(fixture.url),
          { EVIDENCE_OWNER_ACCESS_TOKEN: accessToken },
          { timeoutMs: 25 },
        ),
        (error: unknown) => {
          assert.equal(
            error instanceof Error ? error.message : undefined,
            "Evidence export request timed out",
          );
          return true;
        },
      );
    } finally {
      await fixture.close();
    }
  });

  it("maps an expired owner export response to a static error", async () => {
    const fixture = await createManagedExportHttpFixture(410, {
      error: "expired at D:/secret/archive and Bearer " + accessToken,
    });
    try {
      await assert.rejects(
        runManagedEvidenceExportCli(argumentsFor(fixture.url), {
          EVIDENCE_OWNER_ACCESS_TOKEN: accessToken,
        }),
        (error: unknown) => {
          assert.equal(
            error instanceof Error ? error.message : undefined,
            "Managed evidence export retention has expired",
          );
          return true;
        },
      );
      assert.equal(fixture.requests.length, 1);
      assert.equal(fixture.requests[0]?.authorization, "Bearer " + accessToken);
    } finally {
      await fixture.close();
    }
  });

  it("runs package and script entrypoints through the owner HTTP route", async () => {
    const fixture = await createManagedExportHttpFixture();
    const temporaryDirectory = await isolatedDirectory("http-process");
    const environment = childProcessEnvironment(temporaryDirectory);
    try {
      const packageResult = await runEvidencePackageCommand(
        "evidence:export",
        argumentsFor(fixture.url),
        environment,
      );
      assert.equal(packageResult.stderr, "");
      const packagePayload = JSON.parse(packageResult.stdout) as Record<string, unknown>;
      assert.equal(packagePayload.status, "completed");
      assert.deepEqual(packagePayload.trackDigests, managedExportHttpPayload.trackDigests);

      const scriptResult = await runEvidenceScriptEntrypoint(
        "scripts/export-evidence.mjs",
        argumentsFor(fixture.url),
        environment,
      );
      assert.equal(scriptResult.stderr, "");
      const scriptPayload = JSON.parse(scriptResult.stdout) as Record<string, unknown>;
      assert.deepEqual(scriptPayload, packagePayload);

      assert.equal(fixture.requests.length, 2);
      for (const request of fixture.requests) {
        assert.equal(request.method, "POST");
        assert.equal(request.url, "/api/sessions/" + encodeURIComponent(session) + "/evidence/exports");
        assert.equal(request.authorization, "Bearer " + accessToken);
        assert.deepEqual(JSON.parse(request.body), {
          commandId,
          acknowledgePlaintextExport: true,
        });
        assert.doesNotMatch(JSON.stringify(request), literalPattern("EVIDENCE_ROOT_KEY_BASE64"));
      }
      for (const output of [packageResult.stdout, scriptResult.stdout]) {
        assert.doesNotMatch(output, literalPattern(accessToken));
        assert.doesNotMatch(output, literalPattern(session));
        assert.doesNotMatch(output, /D:[\\/]secret[\\/]archive/u);
      }
    } finally {
      await fixture.close();
    }
  });
});

describe("evidence root-key generation", () => {
  it("prints only the canonical root-key environment label", async () => {
    const result = await execFile(process.execPath, ["scripts/generate-evidence-key.mjs"], {
      cwd: process.cwd(),
    });
    assert.match(result.stdout, /EVIDENCE_ROOT_KEY_BASE64/u);
    assert.doesNotMatch(result.stdout, /EVIDENCE_KEY_BASE64/u);
    assert.doesNotMatch(result.stdout, /EVIDENCE_ENCRYPTION_KEY_BASE64/u);
  });
});

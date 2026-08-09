import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SessionArtifactStore } from "../src/adapters/evidence/session-artifact-store.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import type { SessionProcessingManifest } from "../src/core/processing-profile.js";
import {
  EVIDENCE_AUDIO_TRACKS,
  type EvidenceAudioTrack,
  type EvidenceRecord,
  type EvidenceReviewGrant,
  type SessionSnapshot,
} from "../src/core/types.js";
import { createSyntheticPocProcessingManifest } from "../src/local-eval/synthetic-poc-processing-manifest.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";

const taskTemp = join(process.cwd(), "work", "tmp", "evidence-tests");
const finalizedAtMs = Date.parse("2026-08-09T00:00:00.000Z");
const retentionDeadlineAt = "2026-08-23T00:00:00.000Z";
const fixtureSecret = "fixture-secret: tungsten-bore";
const FIXED_EVIDENCE_REVIEW_GRANT: EvidenceReviewGrant = Object.freeze({
  dataOwnerId: "evidence-test-data-owner",
  bilingualReviewerId: "evidence-test-bilingual-reviewer",
});

const FIXED_FINALIZED_TRACKS = Object.freeze({
  source_a: Object.freeze({
    sha256: "d6de9b4bc487a188e6c2e1fc1eea85b7e4199fd6aa1c15e25dfadf54656e410d",
    frameCount: 1,
    byteCount: CANONICAL_AUDIO.bytesPerFrame,
  }),
  source_b: Object.freeze({
    sha256: "149d9c76d7fb4f71116db2729beac2c3d1252b429815820f39ddec67661335be",
    frameCount: 1,
    byteCount: CANONICAL_AUDIO.bytesPerFrame,
  }),
  playout_to_a: Object.freeze({
    sha256: "0374edf91fb39833c8c49e01341b2a1355b03b4a80ff42816e0ae07ff7ce6c8c",
    frameCount: 1,
    byteCount: CANONICAL_AUDIO.bytesPerFrame,
  }),
  playout_to_b: Object.freeze({
    sha256: "5e77ece80a3c68ef0a79868b891ae684642092ed49e998eceecc003104970465",
    frameCount: 1,
    byteCount: CANONICAL_AUDIO.bytesPerFrame,
  }),
});

type EvidenceSessionEvent = Extract<EvidenceRecord, { readonly type: "session_event" }>["event"];

async function isolatedRoot(name: string): Promise<string> {
  const root = join(taskTemp, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

function storeFor(root: string, rootKeyByte = 7): SessionArtifactStore {
  return new SessionArtifactStore({
    archiveDirectory: join(root, "archive"),
    keyDirectory: join(root, "keys"),
    exportDirectory: join(root, "exports"),
    receiptDirectory: join(root, "receipts"),
    securityBoundaryDirectory: root,
    strictAncestors: false,
    rootKey: Buffer.alloc(32, rootKeyByte),
    dataOwnerId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
    minimumFreeBytes: 0,
    now: () => finalizedAtMs,
  });
}

function sessionEvent(sessionId: string, event: EvidenceSessionEvent): EvidenceRecord {
  return { type: "session_event", sessionId, event };
}

function openedRecord(sessionId: string, manifest: SessionProcessingManifest): EvidenceRecord {
  const snapshot = {
    sessionId,
    status: "waiting",
    spec: {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: manifest.selectedTranslation.provider,
      mode: manifest.selectedTranslation.mode,
      processingManifest: manifest,
      evidenceReviewGrant: FIXED_EVIDENCE_REVIEW_GRANT,
    },
    participants: {
      A: { kind: "browser_link", side: "A", url: "https://example.test/a", qrDataUrl: "data:,a" },
      B: { kind: "browser_link", side: "B", url: "https://example.test/b", qrDataUrl: "data:,b" },
    },
    participantConsent: {
      A: { consented: false, recording: false, processing: false },
      B: { consented: false, recording: false, processing: false },
    },
    recorderArmState: "awaiting_consents",
    recordingArmed: false,
    participantReadiness: { A: undefined, B: undefined },
    providerReadiness: { A_TO_B: undefined, B_TO_A: undefined },
    generations: { A_TO_B: 0, B_TO_A: 0 },
    behavior: resolveTranslationBehavior(manifest.selectedTranslation.mode),
    eventCursor: 1,
    openedAtMs: 0,
  } satisfies SessionSnapshot;
  return sessionEvent(sessionId, {
    type: "session_opened",
    cursor: 1,
    sessionId,
    timestampMonoMs: 0,
    lane: null,
    generation: null,
    snapshot,
  });
}

function consentRecord(
  sessionId: string,
  manifest: SessionProcessingManifest,
  side: "A" | "B",
  cursor: number,
): EvidenceRecord {
  return sessionEvent(sessionId, {
    type: "participant_consent",
    cursor,
    sessionId,
    timestampMonoMs: cursor,
    lane: null,
    generation: null,
    side,
    consentId: "fixture-consent-" + side,
    consentPolicyRef: manifest.consentPolicyRef,
    recording: true,
    processing: true,
    acceptedAtMonoMs: cursor,
  });
}

function transcriptRecord(sessionId: string): EvidenceRecord {
  return sessionEvent(sessionId, {
    type: "target_transcript",
    cursor: 4,
    sessionId,
    timestampMonoMs: 200,
    lane: "A_TO_B",
    generation: 0,
    turnId: "fixture-turn",
    segmentId: "fixture-segment",
    revision: 0,
    text: fixtureSecret,
    final: true,
    evidenceRef: "opaque-fixture-provider-ref",
  });
}

function audioRecord(sessionId: string, track: EvidenceAudioTrack): EvidenceRecord {
  const index = EVIDENCE_AUDIO_TRACKS.indexOf(track);
  const timelineAtMonoMs = 100 + index * CANONICAL_AUDIO.frameDurationMs;
  const lane = track === "source_a" || track === "playout_to_b" ? "A_TO_B" : "B_TO_A";
  return {
    type: "audio",
    sessionId,
    track,
    timelineAtMonoMs,
    frame: createAudioFrame({
      sessionId,
      lane,
      generation: 0,
      sequence: index,
      capturedAtMs: timelineAtMonoMs,
      pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
    }),
  };
}

async function encryptedArchiveLines(archivePath: string): Promise<string[]> {
  return (await readFile(archivePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);
}

interface SealedFixture {
  readonly root: string;
  readonly sessionId: string;
  readonly manifest: SessionProcessingManifest;
  readonly archiveId: string;
  readonly archivePath: string;
  readonly finalization: Extract<Awaited<ReturnType<SessionArtifactStore["finalize"]>>, { readonly status: "sealed" }>;
}

async function sealFixture(name: string, sessionId: string): Promise<SealedFixture> {
  const root = await isolatedRoot(name);
  const store = storeFor(root);
  const manifest = createSyntheticPocProcessingManifest({ mode: "accurate" });
  const lease = await store.acquireEvidenceRootLease("server");

  try {
    await store.persist(openedRecord(sessionId, manifest));
    await store.persist(consentRecord(sessionId, manifest, "A", 2));
    await store.persist(consentRecord(sessionId, manifest, "B", 3));

    const preflight = await store.preflightRecorder({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      checkedAtMonoMs: 10,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("fixture recorder preflight failed");

    await store.persist({
      type: "recorder_preflight",
      sessionId,
      timestampMonoMs: 10,
      preflight,
    });
    for (const track of EVIDENCE_AUDIO_TRACKS) {
      await store.persist({
        type: "recorder_track_armed",
        sessionId,
        track,
        armedAtMonoMs: 11,
        consentPolicyRef: manifest.consentPolicyRef,
      });
      await store.persist(audioRecord(sessionId, track));
    }
    await store.persist(transcriptRecord(sessionId));
    await store.flush(sessionId);

    const finalization = await store.finalize({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      finalizedAtMonoMs: 250,
      reason: "operator_end",
      lastPersistedEventCursor: 4,
    });
    if (finalization.status !== "sealed") {
      throw new Error(
        `fixture finalization failed: ${finalization.failureCode}/${finalization.recovery}`,
      );
    }
    assert.equal(finalization.status, "sealed");

    const descriptor = await store.artifact({ sessionId });
    if (descriptor === undefined) throw new Error("sealed fixture has no artifact descriptor");
    return {
      root,
      sessionId,
      manifest,
      archiveId: descriptor.archiveId,
      archivePath: descriptor.archivePath,
      finalization,
    };
  } finally {
    await lease.release();
  }
}

describe("session artifact evidence", () => {
  it("rejects unarmed audio persistence rather than silently dropping it", async () => {
    const store = storeFor(await isolatedRoot("unarmed-persist"));
    const lease = await store.acquireEvidenceRootLease("server");
    try {
      await assert.rejects(store.persist(audioRecord("unarmed-persist-session", "source_a")));
    } finally {
      await lease.release();
    }
  });

  it("seals encrypted canonical evidence with a fixed four-track vector and survives restart", async () => {
    const fixture = await sealFixture("sealed-durable-vector", "evidence-vector-session");

    assert.equal(fixture.finalization.sessionId, fixture.sessionId);
    assert.equal(fixture.finalization.processingManifestSha256, fixture.manifest.manifestSha256);
    assert.equal(fixture.finalization.recordCount, 13);
    assert.equal(fixture.finalization.finalizedAtUtc, "2026-08-09T00:00:00.000Z");
    assert.equal(fixture.finalization.retentionDeadlineAt, retentionDeadlineAt);
    assert.deepEqual(fixture.finalization.tracks, FIXED_FINALIZED_TRACKS);
    assert.match(fixture.finalization.manifestSha256, /^[a-f0-9]{64}$/u);
    assert.match(fixture.finalization.encryptedLedgerSha256, /^[a-f0-9]{64}$/u);
    assert.match(fixture.finalization.finalChainSha256, /^[a-f0-9]{64}$/u);
    assert.match(fixture.archiveId, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(fixture.archivePath, /evidence-vector-session/u);

    const ciphertext = await readFile(fixture.archivePath, "utf8");
    assert.doesNotMatch(ciphertext, /fixture-secret: tungsten-bore/u);
    assert.doesNotMatch(ciphertext, /fixture-consent-A/u);
    assert.equal(ciphertext.includes(FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId), false);
    assert.equal(ciphertext.includes(FIXED_EVIDENCE_REVIEW_GRANT.bilingualReviewerId), false);

    const reopened = storeFor(fixture.root);
    const reopenedLease = await reopened.acquireEvidenceRootLease("server");
    try {
      const replayedRecords: EvidenceRecord[] = [];
      const review = await reopened.withVerifiedSealedReviewLease({
        kind: "metadata_page",
        sessionId: fixture.sessionId,
        actor: {
          role: "retention_owner",
          actorId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
        pageSize: 100,
      }, async (lease) => {
        assert.deepEqual(lease.summary, {
          status: "sealed",
          finalizationSha256: fixture.finalization.manifestSha256,
          recordCount: 13,
          retentionDeadlineAtMs: finalizedAtMs + 14 * 24 * 60 * 60 * 1_000,
        });
        assert.equal(lease.originTimelineAtMonoMs, 100);
        assert.equal(lease.durationMs, 80);
        for await (const record of lease.records()) replayedRecords.push(record);
        return {
          value: null,
          responseSha256: "a".repeat(64),
        };
      });
      assert.equal(review.status, "completed");
      assert.equal(replayedRecords.length, 13);

      const restoredAudio = replayedRecords.filter(
        (record): record is Extract<EvidenceRecord, { readonly type: "audio" }> => record.type === "audio",
      );
      assert.equal(restoredAudio.length, EVIDENCE_AUDIO_TRACKS.length);
      for (const [index, track] of EVIDENCE_AUDIO_TRACKS.entries()) {
        const record = restoredAudio[index];
        if (record === undefined) throw new Error("sealed fixture is missing a restored audio record");
        assert.equal(record.track, track);
        assert.ok(record.frame.pcm16le instanceof Uint8Array);
        assert.deepEqual(
          record.frame.pcm16le,
          new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
        );
      }

      const durableTranscript = replayedRecords.find((record) =>
        record.type === "session_event" && record.event.type === "target_transcript"
      );
      if (
        durableTranscript === undefined ||
        durableTranscript.type !== "session_event" ||
        durableTranscript.event.type !== "target_transcript"
      ) {
        throw new Error("sealed fixture did not retain its final transcript evidence");
      }
      assert.equal(durableTranscript.event.text, fixtureSecret);
    } finally {
      await reopenedLease.release();
    }

    const wrongKeyStore = storeFor(fixture.root, 8);
    const wrongKeyLease = await wrongKeyStore.acquireEvidenceRootLease("server");
    try {
      let callbackInvoked = false;
      assert.deepEqual(await wrongKeyStore.withManagedExportLease({
        lookup: { archiveId: fixture.archiveId },
        commandId: "wrong-key-streaming-lease",
        authority: {
          kind: "retention_owner",
          actorId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
        requestedAtMs: finalizedAtMs,
      }, async () => {
        callbackInvoked = true;
        return {
          value: null,
          manifestFileSha256: "b".repeat(64),
          completedAtMs: finalizedAtMs,
        };
      }), { status: "not_found" });
      assert.equal(callbackInvoked, false);
    } finally {
      await wrongKeyLease.release();
    }
  });

  it("rejects independent truncated, reordered, and cross-artifact ciphertext vectors", async () => {
    const truncated = await sealFixture("tamper-truncated", "tamper-session-truncated");
    const truncatedLines = await encryptedArchiveLines(truncated.archivePath);
    assert.ok(truncatedLines.length >= 3, "fixture must contain records, a finalization manifest, and a seal");
    await writeFile(truncated.archivePath, truncatedLines.slice(0, -1).join("\n") + "\n", "utf8");
    const truncatedStore = storeFor(truncated.root);
    const truncatedLease = await truncatedStore.acquireEvidenceRootLease("server");
    try {
      let callbackInvoked = false;
      assert.deepEqual(await truncatedStore.withVerifiedSealedReviewLease({
        kind: "retention_summary",
        sessionId: truncated.sessionId,
        actor: {
          role: "retention_owner",
          actorId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      }, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256: "c".repeat(64) };
      }), { status: "integrity_failed" });
      assert.equal(callbackInvoked, false);
    } finally {
      await truncatedLease.release();
    }

    const reordered = await sealFixture("tamper-reordered", "tamper-session-reordered");
    const reorderedLines = await encryptedArchiveLines(reordered.archivePath);
    const first = reorderedLines[0];
    const second = reorderedLines[1];
    if (first === undefined || second === undefined) throw new Error("fixture archive is too short");
    await writeFile(
      reordered.archivePath,
      [second, first, ...reorderedLines.slice(2)].join("\n") + "\n",
      "utf8",
    );
    const reorderedStore = storeFor(reordered.root);
    const reorderedLease = await reorderedStore.acquireEvidenceRootLease("server");
    try {
      let callbackInvoked = false;
      // Authorization is decided before integrity; a reordered first envelope
      // prevents the immutable grant from authenticating, so this is denied.
      assert.deepEqual(await reorderedStore.withVerifiedSealedReviewLease({
        kind: "retention_summary",
        sessionId: reordered.sessionId,
        actor: {
          role: "retention_owner",
          actorId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      }, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256: "d".repeat(64) };
      }), { status: "grant_denied" });
      assert.equal(callbackInvoked, false);
    } finally {
      await reorderedLease.release();
    }

    const target = await sealFixture("tamper-cross-target", "tamper-session-cross-target");
    const source = await sealFixture("tamper-cross-source", "tamper-session-cross-source");
    const targetLines = await encryptedArchiveLines(target.archivePath);
    const sourceLines = await encryptedArchiveLines(source.archivePath);
    const targetFirst = targetLines[0];
    const sourceFirst = sourceLines[0];
    if (targetFirst === undefined || sourceFirst === undefined) {
      throw new Error("cross-artifact fixture archive is too short");
    }
    targetLines[0] = sourceFirst;
    await writeFile(target.archivePath, targetLines.join("\n") + "\n", "utf8");
    const targetStore = storeFor(target.root);
    const targetLease = await targetStore.acquireEvidenceRootLease("server");
    try {
      let callbackInvoked = false;
      assert.deepEqual(await targetStore.withVerifiedSealedReviewLease({
        kind: "retention_summary",
        sessionId: target.sessionId,
        actor: {
          role: "retention_owner",
          actorId: FIXED_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      }, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256: "e".repeat(64) };
      }), { status: "grant_denied" });
      assert.equal(callbackInvoked, false);
    } finally {
      await targetLease.release();
    }
  });
});

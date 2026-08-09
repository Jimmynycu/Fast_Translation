import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryEvidenceStore } from "../src/adapters/evidence/in-memory.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import type { EvidencePort, EvidenceRecord } from "../src/core/types.js";

interface TestRecord {
  readonly sessionId: string;
  readonly type: "test";
}

const PROCESSING_MANIFEST_SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("in-memory evidence port", () => {
  it("provides a content-bound virtual exact-four-track recorder preflight without a production storage claim", async () => {
    const store: EvidencePort = new InMemoryEvidenceStore<EvidenceRecord>();

    const preflight = await store.preflightRecorder({
      sessionId: "virtual-preflight",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      checkedAtMonoMs: 42,
    });

    assert.deepEqual(preflight, {
      status: "ready",
      sessionId: "virtual-preflight",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      preflightId: "synthetic-in-memory-preflight-v1",
      checkedAtMonoMs: 42,
      requiredFreeBytes: "0",
      availableFreeBytes: "0",
      tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
      manifestSha256: PROCESSING_MANIFEST_SHA256,
      encryptedSpoolSha256: "1d69f5a8ca3763a19e253d3a70902eedcd5362356178cd97e1350a25be94a30b",
      sealedRecordCount: 1,
      sealSha256: "812813cae997d441176ca44735a535bcf6d524d60f6feeca81be5df54f435b86",
    });
  });

  it("seals an independently fixed audio-content receipt only after matching virtual preflight and stops accepting records", async () => {
    const store = new InMemoryEvidenceStore<EvidenceRecord>();
    await store.preflightRecorder({
      sessionId: "virtual-finalize",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      checkedAtMonoMs: 11,
    });
    await store.persist({
      type: "audio",
      sessionId: "virtual-finalize",
      track: "source_a",
      timelineAtMonoMs: 0,
      frame: createAudioFrame({
        sessionId: "virtual-finalize",
        lane: "A_TO_B",
        generation: 0,
        sequence: 0,
        capturedAtMs: 0,
        pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame),
      }),
    });

    const receipt = await store.finalize({
      sessionId: "virtual-finalize",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      finalizedAtMonoMs: 99,
      reason: "test_complete",
      lastPersistedEventCursor: 0,
    });

    assert.deepEqual(receipt, {
      status: "sealed",
      sessionId: "virtual-finalize",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      manifestSha256: PROCESSING_MANIFEST_SHA256,
      encryptedLedgerSha256: "bf8fea2b547db4e5961348b99b40065a0d0ee69a04618caaaa56dfef022828bc",
      finalChainSha256: "c0caac633ee040dd96160dd78431f1cecbcca66f99114e86f5f6d31a1c852e2f",
      recordCount: 1,
      finalizedAtUtc: "1970-01-01T00:00:00.099Z",
      retentionDeadlineAt: "1970-01-15T00:00:00.099Z",
      tracks: {
        source_a: {
          sha256: "3ce82e5dc74da085be920467702c27a0d65fac3c0644179f8864b0c9abd30eaa",
          frameCount: 1,
          byteCount: 960,
        },
        source_b: {
          sha256: "41a01d08a0779f3a82e45a450c286925c328280dcabc8346c77ecdd78a29cc6c",
          frameCount: 0,
          byteCount: 0,
        },
        playout_to_a: {
          sha256: "46a7611bb4b4941964a205984a72db60d6d3c1dfd39027429e25ecae21e045e1",
          frameCount: 0,
          byteCount: 0,
        },
        playout_to_b: {
          sha256: "357fa42b13b5e0b6a5a91ddbf12f458c94c9dc59fa194c6a1bf63c95655bd3b9",
          frameCount: 0,
          byteCount: 0,
        },
      },
    });
    await assert.rejects(
      store.persist({
        type: "audio",
        sessionId: "virtual-finalize",
        track: "source_a",
        timelineAtMonoMs: 20,
        frame: createAudioFrame({
          sessionId: "virtual-finalize",
          lane: "A_TO_B",
          generation: 0,
          sequence: 1,
          capturedAtMs: 20,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame),
        }),
      }),
      /Cannot persist evidence after finalization/u,
    );
    assert.equal("record" in store, false);
    assert.equal("close" in store, false);
  });

  it("changes the sealed digest chain for an independently fixed PCM byte vector", async () => {
    const store = new InMemoryEvidenceStore<EvidenceRecord>();
    await store.preflightRecorder({
      sessionId: "virtual-finalize",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      checkedAtMonoMs: 11,
    });
    const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
    pcm16le[0] = 1;
    await store.persist({
      type: "audio",
      sessionId: "virtual-finalize",
      track: "source_a",
      timelineAtMonoMs: 0,
      frame: createAudioFrame({
        sessionId: "virtual-finalize",
        lane: "A_TO_B",
        generation: 0,
        sequence: 0,
        capturedAtMs: 0,
        pcm16le,
      }),
    });

    const receipt = await store.finalize({
      sessionId: "virtual-finalize",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      finalizedAtMonoMs: 99,
      reason: "test_complete",
      lastPersistedEventCursor: 0,
    });

    assert.equal(receipt.status, "sealed");
    if (receipt.status !== "sealed") return;
    assert.equal(
      receipt.tracks.source_a.sha256,
      "4d80d78e1ec132e059ea77c9b19ee43977895adfcbbc7313078411f0c75bbdea",
    );
    assert.equal(
      receipt.encryptedLedgerSha256,
      "9389b794d6d98ff66862f4bc0de176df0a2fcd0ed6cbb1b1bd869f186909228d",
    );
    assert.equal(
      receipt.finalChainSha256,
      "220632d4fe8ab621a05479efd6c28d9829a4186ff98198c32ff4abfa79d9c049",
    );
  });

  it("does not accept a recorder track before its virtual preflight succeeds", async () => {
    const store = new InMemoryEvidenceStore<EvidenceRecord>();
    const record: EvidenceRecord = {
      type: "audio",
      sessionId: "virtual-audio",
      track: "source_a",
      timelineAtMonoMs: 0,
      frame: createAudioFrame({
        sessionId: "virtual-audio",
        lane: "A_TO_B",
        generation: 0,
        sequence: 0,
        capturedAtMs: 0,
        pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame),
      }),
    };

    await assert.rejects(
      store.persist(record),
      /Recorder preflight must succeed before persisting audio evidence/u,
    );
    await store.preflightRecorder({
      sessionId: "virtual-audio",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      checkedAtMonoMs: 0,
    });
    await store.persist(record);
  });

  it("does not seal a virtual session without a matching preflight", async () => {
    const store = new InMemoryEvidenceStore<TestRecord>();

    const receipt = await store.finalize({
      sessionId: "not-preflighted",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      finalizedAtMonoMs: 0,
      reason: "test_complete",
      lastPersistedEventCursor: 0,
    });

    assert.deepEqual(receipt, {
      status: "FINALIZATION_FAILED",
      sessionId: "not-preflighted",
      processingManifestSha256: PROCESSING_MANIFEST_SHA256,
      failureCode: "integrity_verification_failed",
      recovery: "rebuild_from_spool",
    });
  });
});

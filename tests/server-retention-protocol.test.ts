import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  evidenceReviewAudioWindowRequestSchema,
  earlyEvidenceDeletionRequestSchema,
  evidenceReviewMetadataRequestSchema,
  managedPlaintextExportRequestSchema,
  retentionExtensionRequestSchema,
} from "../src/server/retention-protocol.js";

const COMMAND_ID = "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7";
const EMITTED_EVIDENCE_REVIEW_CURSOR = "evidence-review-v1.KQuv3cS8BaR-5Pzz.lwDyjUGJtHD3X0dFzy2gXB34PJzWHQkiQeR4_ONIOhTrm5mfoiZASLYFPZY_daX8ZoVmve-WFCzqtf8nnJmchXd3La7SGwNA8MCyvbad5_2_NeyrOGYpKwpB.sUjlPpCkwGaKWWyg4UMoAg";
const OVERSIZED_EVIDENCE_REVIEW_CURSOR = [
  "evidence-review-v1",
  "A".repeat(16),
  "A".repeat(480),
  "A".repeat(22),
].join(".");

const CANONICAL_COMMAND_IDS = [
  "e9a9ccfc-c6cb-1a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-2a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-3a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-5a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-6a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-7a67-9d8b-2c716c805be7",
  "e9a9ccfc-c6cb-8a67-9d8b-2c716c805be7",
];

describe("retention management HTTP protocol", () => {
  it("accepts a bounded evidence-review metadata page request", () => {
    assert.deepEqual(evidenceReviewMetadataRequestSchema.parse({}), {});
    assert.deepEqual(evidenceReviewMetadataRequestSchema.parse({
      cursor: EMITTED_EVIDENCE_REVIEW_CURSOR,
      pageSize: 100,
    }), {
      cursor: EMITTED_EVIDENCE_REVIEW_CURSOR,
      pageSize: 100,
    });
  });

  it("rejects malformed, oversized, or unbounded evidence-review metadata requests", () => {
    for (const cursor of [
      "",
      "not/a-cursor",
      "not+a-cursor",
      "not=a-cursor",
      "not.a-cursor",
      EMITTED_EVIDENCE_REVIEW_CURSOR.replace(".", "/"),
      EMITTED_EVIDENCE_REVIEW_CURSOR.slice(0, -1) + "B",
      `${EMITTED_EVIDENCE_REVIEW_CURSOR}.extra`,
      OVERSIZED_EVIDENCE_REVIEW_CURSOR,
    ]) {
      assert.throws(() => evidenceReviewMetadataRequestSchema.parse({ cursor }));
    }
    for (const pageSize of [0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => evidenceReviewMetadataRequestSchema.parse({ pageSize }));
    }
    assert.throws(() => evidenceReviewMetadataRequestSchema.parse({ pageSize: 1, unexpected: true }));
  });

  it("accepts an aligned evidence-review audio window for every logical track", () => {
    for (const track of ["source_a", "source_b", "playout_to_a", "playout_to_b"]) {
      const request = evidenceReviewAudioWindowRequestSchema.parse({
        track,
        startOffsetMs: 0,
        durationMs: 30_000,
      });
      assert.deepEqual(request, {
        track,
        startOffsetMs: 0,
        durationMs: 30_000,
      });
    }
  });

  it("rejects noncanonical or unbounded evidence-review audio windows", () => {
    for (const track of ["source_c", "SOURCE_A", "playout_to_c", ""]) {
      assert.throws(() => evidenceReviewAudioWindowRequestSchema.parse({
        track,
        startOffsetMs: 0,
        durationMs: 20,
      }));
    }
    for (const startOffsetMs of [
      -1,
      1,
      19,
      20.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => evidenceReviewAudioWindowRequestSchema.parse({
        track: "source_a",
        startOffsetMs,
        durationMs: 20,
      }));
    }
    for (const durationMs of [
      -20,
      0,
      19,
      21,
      20.5,
      30_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.throws(() => evidenceReviewAudioWindowRequestSchema.parse({
        track: "source_a",
        startOffsetMs: 0,
        durationMs,
      }));
    }
    assert.throws(() => evidenceReviewAudioWindowRequestSchema.parse({
      track: "source_a",
      startOffsetMs: 0,
      durationMs: 20,
      unexpected: true,
    }));
  });

  it("requires a canonical lowercase UUID v1-v8 command ID", () => {
    for (const commandId of CANONICAL_COMMAND_IDS) {
      const request = earlyEvidenceDeletionRequestSchema.parse({
        commandId,
        reason: "Customer requested immediate deletion",
      });
      assert.equal(request.commandId, commandId);
    }

    for (const commandId of [
      "E9A9CCFC-C6CB-4A67-9D8B-2C716C805BE7",
      "e9A9ccfc-c6cb-4a67-9d8b-2c716c805be7",
      "e9a9ccfc-c6cb-0a67-9d8b-2c716c805be7",
      "e9a9ccfc-c6cb-9a67-9d8b-2c716c805be7",
      "e9a9ccfc-c6cb-4a67-7d8b-2c716c805be7",
      "e9a9ccfc-c6cb-4a67-cd8b-2c716c805be7",
    ]) {
      assert.throws(
        () => earlyEvidenceDeletionRequestSchema.parse({
          commandId,
          reason: "Customer requested immediate deletion",
        }),
        /commandId/i,
      );
    }
  });

  it("accepts an owner retention extension with a UTC deadline", () => {
    const request = retentionExtensionRequestSchema.parse({
      commandId: COMMAND_ID,
      reason: "Required for the scheduled customer review",
      requestedDeadline: "2026-08-31T12:00:00Z",
    });

    assert.deepEqual(request, {
      commandId: COMMAND_ID,
      reason: "Required for the scheduled customer review",
      requestedDeadline: "2026-08-31T12:00:00Z",
    });
  });

  it("rejects an extension without a bounded reason, canonical UTC deadline, or clean body", () => {
    assert.throws(
      () => retentionExtensionRequestSchema.parse({
        commandId: COMMAND_ID,
        reason: " ",
        requestedDeadline: "2026-08-31T12:00:00Z",
      }),
      /reason/i,
    );
    assert.throws(
      () => retentionExtensionRequestSchema.parse({
        commandId: COMMAND_ID,
        reason: "Needed",
        requestedDeadline: "2026-08-31T20:00:00+08:00",
      }),
      /UTC|deadline/i,
    );
    assert.throws(
      () => retentionExtensionRequestSchema.parse({
        commandId: COMMAND_ID,
        reason: "Needed",
        requestedDeadline: "2026-08-31T12:00:00Z",
        actor: "owner",
      }),
      /unrecognized key/i,
    );
  });

  it("accepts a reasoned early evidence deletion command", () => {
    const request = earlyEvidenceDeletionRequestSchema.parse({
      commandId: COMMAND_ID,
      reason: "Customer requested immediate deletion",
    });

    assert.deepEqual(request, {
      commandId: COMMAND_ID,
      reason: "Customer requested immediate deletion",
    });
  });

  it("requires an explicit acknowledgement before a reviewer can request plaintext export", () => {
    const request = managedPlaintextExportRequestSchema.parse({
      commandId: COMMAND_ID,
      acknowledgePlaintextExport: true,
    });
    assert.deepEqual(request, {
      commandId: COMMAND_ID,
      acknowledgePlaintextExport: true,
    });
    assert.throws(
      () => managedPlaintextExportRequestSchema.parse({
        commandId: COMMAND_ID,
        acknowledgePlaintextExport: false,
      }),
      /acknowledgePlaintextExport/i,
    );
  });
});

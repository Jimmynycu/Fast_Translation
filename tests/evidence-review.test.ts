import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudioFrame } from "../src/core/audio.js";
import type { EvidenceRecord } from "../src/core/types.js";
import {
  EvidenceReview,
  type EvidenceReviewArtifactPort,
  type EvidenceReviewLease,
  type EvidenceReviewLeaseCompletion,
  type EvidenceReviewLeaseUnavailableStatus,
  type EvidenceReviewRequest,
} from "../src/adapters/evidence/review.js";

const SESSION_ID = "review-session";
const FINALIZATION_SHA256 = "a".repeat(64);

interface LeaseOptions {
  readonly finalizationSha256?: string;
  readonly originTimelineAtMonoMs?: number | null;
  readonly durationMs?: number;
  readonly recordCount?: number;
  readonly recordIterator?: () => AsyncIterable<EvidenceRecord>;
  readonly retentionDeadlineAtMs?: number;
  readonly onRecords?: () => void;
  readonly onIteratorReturn?: () => void;
}

function lease(
  records: readonly EvidenceRecord[] = [],
  options: LeaseOptions = {},
): EvidenceReviewLease {
  return {
    summary: {
      status: "sealed",
      finalizationSha256: options.finalizationSha256 ?? FINALIZATION_SHA256,
      recordCount: options.recordCount ?? records.length,
      retentionDeadlineAtMs: options.retentionDeadlineAtMs ?? 2_000,
    },
    originTimelineAtMonoMs: options.originTimelineAtMonoMs ?? 1_000,
    durationMs: options.durationMs ?? 40,
    async *records() {
      options.onRecords?.();
      try {
        if (options.recordIterator !== undefined) {
          for await (const record of options.recordIterator()) yield structuredClone(record);
        } else {
          for (const record of records) yield structuredClone(record);
        }
      } finally {
        options.onIteratorReturn?.();
      }
    },
  };
}

interface FakeReviewPortOptions extends LeaseOptions {
  readonly auditId?: string;
  readonly immediateStatus?: EvidenceReviewLeaseUnavailableStatus;
  readonly postTransactionStatus?: EvidenceReviewLeaseUnavailableStatus;
}

interface FakeReviewPort {
  readonly port: EvidenceReviewArtifactPort;
  readonly requests: EvidenceReviewRequest[];
  readonly completions: EvidenceReviewLeaseCompletion<unknown>[];
}

function fakeReviewPort(
  records: readonly EvidenceRecord[],
  options: FakeReviewPortOptions = {},
): FakeReviewPort {
  const requests: EvidenceReviewRequest[] = [];
  const completions: EvidenceReviewLeaseCompletion<unknown>[] = [];
  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      requests.push(request);
      if (options.immediateStatus !== undefined) return { status: options.immediateStatus };
      const completion = await transaction(lease(records, options));
      completions.push(completion);
      if (options.postTransactionStatus !== undefined) return { status: options.postTransactionStatus };
      return {
        status: "completed" as const,
        auditId: options.auditId ?? "audit-opaque-1",
        responseSha256: completion.responseSha256,
      };
    },
  };
  return { port, requests, completions };
}

function transcriptRecord(
  direction: "source" | "target",
  text: string,
  final = true,
): EvidenceRecord {
  const type = direction === "source" ? "source_transcript" as const : "target_transcript" as const;
  return {
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type,
      cursor: 1,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_000,
      lane: "A_TO_B",
      generation: 0,
      turnId: "turn-1",
      segmentId: "segment-1",
      revision: 1,
      text,
      final,
    },
  };
}

function audioRecord(
  track: "source_a" | "source_b" | "playout_to_a" | "playout_to_b",
  timelineAtMonoMs: number,
  sampleByte: number,
): EvidenceRecord {
  return {
    type: "audio",
    sessionId: SESSION_ID,
    track,
    timelineAtMonoMs,
    frame: createAudioFrame({
      sessionId: SESSION_ID,
      lane: "A_TO_B",
      generation: 0,
      sequence: timelineAtMonoMs / 20,
      capturedAtMs: timelineAtMonoMs,
      pcm16le: Buffer.alloc(960, sampleByte),
    }),
  };
}

function fiveMinuteFourTrackRecords(): AsyncIterable<EvidenceRecord> {
  const tracks = ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const;
  return (async function* () {
    for (let frameIndex = 0; frameIndex < 15_000; frameIndex += 1) {
      const timelineAtMonoMs = 1_000 + frameIndex * 20;
      for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        yield audioRecord(tracks[trackIndex]!, timelineAtMonoMs, (frameIndex + trackIndex) & 0xff);
      }
      if (frameIndex % 60 === 0) yield transcriptRecord("source", `metadata-${frameIndex}`);
    }
  })();
}

test("reviews a final transcript only after the verified lease durably audits its response", async () => {
  let resolveAudit: (() => void) | undefined;
  const audit = new Promise<void>((resolve) => { resolveAudit = resolve; });
  let resolveAuditStarted: (() => void) | undefined;
  const auditStarted = new Promise<void>((resolve) => { resolveAuditStarted = resolve; });
  let observedRequest: EvidenceReviewRequest | undefined;
  let observedCompletion: EvidenceReviewLeaseCompletion<unknown> | undefined;

  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      observedRequest = request;
      const completion = await transaction(lease([{
        type: "session_event",
        sessionId: SESSION_ID,
        event: {
          type: "source_transcript",
          cursor: 1,
          sessionId: SESSION_ID,
          timestampMonoMs: 1_000,
          lane: "A_TO_B",
          generation: 0,
          turnId: "turn-1",
          segmentId: "segment-1",
          revision: 1,
          text: "Committed source transcript",
          final: true,
        },
      }]));
      observedCompletion = completion;
      resolveAuditStarted?.();
      await audit;
      return {
        status: "completed" as const,
        auditId: "audit-opaque-1",
        responseSha256: completion.responseSha256,
      };
    },
  };
  const review = new EvidenceReview({ artifacts: port, cursorKey: Buffer.alloc(32, 7) });
  const request = {
    kind: "metadata_page" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
    pageSize: 1,
  };

  let settled = false;
  const pending = review.review(request).then((result) => {
    settled = true;
    return result;
  });
  await auditStarted;
  assert.equal(settled, false, "the public response must wait for the durable audit");
  assert.deepEqual(observedRequest, request);
  assert.match(observedCompletion?.responseSha256 ?? "", /^[a-f0-9]{64}$/u);

  resolveAudit?.();
  const result = await pending;
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "metadata_page") {
    throw new Error("Expected a completed metadata page");
  }
  assert.equal(result.auditId, "audit-opaque-1");
  assert.equal(result.summary.retentionDeadlineAtMs, 2_000);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /data-owner|bilingual-reviewer|grant/iu);
  assert.deepEqual(result.records, [{
    kind: "transcript",
    direction: "source",
    turnId: "turn-1",
    segmentId: "segment-1",
    revision: 1,
    text: "Committed source transcript",
  }]);
});

test("fails closed at the per-session and global concurrent review admission caps", async () => {
  let releaseGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  let artifactCalls = 0;
  let completedCalls = 0;
  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      _request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      artifactCalls += 1;
      const completion = await transaction(lease());
      await gate;
      completedCalls += 1;
      return {
        status: "completed" as const,
        auditId: "audit-admission-cap",
        responseSha256: completion.responseSha256,
      };
    },
  };
  const review = new EvidenceReview({ artifacts: port, cursorKey: Buffer.alloc(32, 21) });
  const requestFor = (sessionId: string): EvidenceReviewRequest => ({
    kind: "retention_summary",
    sessionId,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  });

  const sameSession = Array.from({ length: 4 }, () => review.review(requestFor(SESSION_ID)));
  assert.equal(artifactCalls, 4);
  assert.equal(completedCalls, 0);
  assert.deepEqual(await review.review(requestFor(SESSION_ID)), { status: "audit_failed" });
  assert.equal(artifactCalls, 4, "the rejected fifth request must not reach the artifact port");

  const otherSessions = Array.from(
    { length: 28 },
    (_, index) => review.review(requestFor(`review-admission-cap-${index}`)),
  );
  assert.equal(artifactCalls, 32);
  assert.deepEqual(await review.review(requestFor("review-admission-global-cap")), { status: "audit_failed" });
  assert.equal(artifactCalls, 32, "the rejected global-cap request must not reach the artifact port");
  assert.equal(completedCalls, 0, "admitted requests remain held until the deferred port releases them");

  releaseGate?.();
  const admittedResults = await Promise.all([...sameSession, ...otherSessions]);
  assert.equal(admittedResults.length, 32);
  assert.ok(admittedResults.every((result) => result.status === "completed"));
  assert.equal(completedCalls, 32);

  const afterRelease = await review.review(requestFor(SESSION_ID));
  assert.equal(afterRelease.status, "completed", "released admission slots must become reusable");
  assert.equal(artifactCalls, 33);
});

test("audits a retention summary without replaying any ledger records", async () => {
  let recordsCalls = 0;
  const fixture = fakeReviewPort(
    [transcriptRecord("source", "must not be read for retention")],
    { retentionDeadlineAtMs: 77_777, onRecords: () => { recordsCalls += 1; } },
  );
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 19) });
  const request = {
    kind: "retention_summary" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
  };

  const result = await review.review(request);
  assert.deepEqual(fixture.requests, [request]);
  assert.equal(recordsCalls, 0);
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "retention_summary") {
    throw new Error("Expected an audited retention summary");
  }
  assert.deepEqual(result, {
    status: "completed",
    kind: "retention_summary",
    auditId: "audit-opaque-1",
    summary: {
      finalizationSha256: FINALIZATION_SHA256,
      durationMs: 40,
      recordCount: 1,
      retentionDeadlineAtMs: 77_777,
    },
  });
  assert.equal(JSON.stringify(result).includes("must not be read for retention"), false);
});

test("paginates only safe records with a stable opaque cursor bound to the sealed finalization", async () => {
  const fixture = fakeReviewPort([
    transcriptRecord("source", "first"),
    transcriptRecord("target", "second"),
    transcriptRecord("source", "third"),
    transcriptRecord("target", "fourth"),
  ]);
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 8) });
  const request = {
    kind: "metadata_page" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
    pageSize: 2,
  };

  const first = await review.review(request);
  assert.equal(first.status, "completed");
  if (first.status !== "completed" || first.kind !== "metadata_page" || first.nextCursor === undefined) {
    throw new Error("Expected a first metadata page with a cursor");
  }
  const cursor = first.nextCursor;
  assert.deepEqual(first.records.map((record) => record.kind === "transcript" ? record.text : record.kind), [
    "first",
    "second",
  ]);
  assert.doesNotMatch(cursor, /review-session|first|second/iu);

  const repeated = await review.review(request);
  assert.equal(repeated.status, "completed");
  if (repeated.status !== "completed" || repeated.kind !== "metadata_page") {
    throw new Error("Expected a repeated metadata page");
  }
  if (repeated.nextCursor === undefined) throw new Error("Expected a repeated metadata cursor");
  assert.notEqual(repeated.nextCursor, cursor, "each cursor uses a fresh authenticated nonce");

  const second = await review.review({ ...request, cursor });
  assert.equal(second.status, "completed");
  if (second.status !== "completed" || second.kind !== "metadata_page") {
    throw new Error("Expected a second metadata page");
  }
  assert.deepEqual(second.records.map((record) => record.kind === "transcript" ? record.text : record.kind), [
    "third",
    "fourth",
  ]);
  assert.equal(second.nextCursor, undefined);

  await assert.rejects(
    review.review({ ...request, cursor, pageSize: 3 }),
    /does not match this sealed artifact/u,
  );

  const otherFixture = fakeReviewPort([
    transcriptRecord("source", "other"),
  ], { finalizationSha256: "c".repeat(64) });
  const otherReview = new EvidenceReview({ artifacts: otherFixture.port, cursorKey: Buffer.alloc(32, 8) });
  await assert.rejects(
    otherReview.review({ ...request, cursor }),
    /does not match this sealed artifact/u,
  );
  assert.deepEqual(fixture.requests[0], request);
});

test("reviews five minutes of four-track audio metadata in fewer than 240 pages while cursors skip audio", async () => {
  const transcriptCount = 250;
  const fixture = fakeReviewPort([], {
    durationMs: 300_000,
    recordCount: 60_250,
    recordIterator: fiveMinuteFourTrackRecords,
  });
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 24) });
  const base = {
    kind: "metadata_page" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
    pageSize: 100,
  };
  let cursor: string | undefined;
  let pageCount = 0;
  let projectedTranscriptCount = 0;
  while (true) {
    const result = await review.review(cursor === undefined ? base : { ...base, cursor });
    assert.equal(result.status, "completed");
    if (result.status !== "completed" || result.kind !== "metadata_page") {
      throw new Error("Expected a completed metadata page");
    }
    pageCount += 1;
    projectedTranscriptCount += result.records.filter((record) => record.kind === "transcript").length;
    assert.doesNotMatch(JSON.stringify(result), /"kind":"audio"/u);
    if (result.nextCursor === undefined) break;
    cursor = result.nextCursor;
    assert.ok(pageCount < 240);
  }
  assert.equal(projectedTranscriptCount, transcriptCount);
  assert.equal(pageCount, 3);
  assert.equal(fixture.requests.length, pageCount);
});

test("rejects overlong cursors and actor identities with outer whitespace before opening a review lease", async () => {
  const fixture = fakeReviewPort([]);
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 9) });
  const base = {
    kind: "metadata_page" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
  };

  await assert.rejects(
    review.review({ ...base, actor: { ...base.actor, actorId: " bilingual-reviewer " } }),
    /actor\.actorId/u,
  );
  await assert.rejects(
    review.review({ ...base, cursor: "x".repeat(513) }),
    /cursor/u,
  );
  assert.deepEqual(fixture.requests, []);
});

test("fails closed on a syntactically valid but unauthenticated metadata cursor before lease admission", async () => {
  const sourceFixture = fakeReviewPort([
    transcriptRecord("source", "cursor source"),
    transcriptRecord("target", "cursor target"),
  ]);
  const sourceReview = new EvidenceReview({ artifacts: sourceFixture.port, cursorKey: Buffer.alloc(32, 22) });
  const base = {
    kind: "metadata_page" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
    pageSize: 1,
  };
  const first = await sourceReview.review(base);
  assert.equal(first.status, "completed");
  if (first.status !== "completed" || first.kind !== "metadata_page" || first.nextCursor === undefined) {
    throw new Error("Expected a canonical metadata cursor");
  }
  const cursor = first.nextCursor;
  const tamperedCursor = cursor.slice(0, -1) + (cursor.endsWith("A") ? "B" : "A");
  const tamperedFixture = fakeReviewPort([]);
  const tamperedReview = new EvidenceReview({ artifacts: tamperedFixture.port, cursorKey: Buffer.alloc(32, 22) });

  const result = await tamperedReview.review({ ...base, cursor: tamperedCursor });
  assert.deepEqual(result, { status: "audit_failed" });
  assert.deepEqual(tamperedFixture.requests, []);
});

test("fails closed when metadata or audio record streams are short or overlong", async () => {
  const metadataRequest: EvidenceReviewRequest = {
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  };
  const audioRequest: EvidenceReviewRequest = {
    kind: "audio_window",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
    track: "source_a",
    startOffsetMs: 0,
    durationMs: 20,
  };
  const cases: readonly {
    readonly request: EvidenceReviewRequest;
    readonly records: readonly EvidenceRecord[];
    readonly recordCount: number;
  }[] = [
    {
      request: metadataRequest,
      records: [transcriptRecord("source", "short metadata")],
      recordCount: 2,
    },
    {
      request: metadataRequest,
      records: [
        transcriptRecord("source", "first metadata"),
        transcriptRecord("target", "overlong metadata"),
      ],
      recordCount: 1,
    },
    {
      request: audioRequest,
      records: [audioRecord("source_a", 1_000, 0x11)],
      recordCount: 2,
    },
    {
      request: audioRequest,
      records: [
        audioRecord("source_a", 1_000, 0x11),
        audioRecord("source_a", 1_020, 0x22),
      ],
      recordCount: 1,
    },
  ];
  for (const { request, records, recordCount } of cases) {
    const fixture = fakeReviewPort(records, { recordCount });
    const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, recordCount) });
    const result = await review.review(request);
    assert.deepEqual(result, { status: "integrity_failed" });
    assert.equal(fixture.completions.length, 0, "invalid record streams must never produce a completion");
  }
});

test("fails closed on malformed session-event and audio record shapes", async () => {
  const malformedSessionEvent = {
    type: "session_event",
    sessionId: SESSION_ID,
    event: null,
  } as unknown as EvidenceRecord;
  const malformedAudio = {
    type: "audio",
    sessionId: SESSION_ID,
    track: "source_a",
    timelineAtMonoMs: 1_000,
    frame: null,
  } as unknown as EvidenceRecord;
  const cases: readonly {
    readonly request: EvidenceReviewRequest;
    readonly record: EvidenceRecord;
  }[] = [
    {
      request: {
        kind: "metadata_page",
        sessionId: SESSION_ID,
        actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
      },
      record: malformedSessionEvent,
    },
    {
      request: {
        kind: "audio_window",
        sessionId: SESSION_ID,
        actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
        track: "source_a",
        startOffsetMs: 0,
        durationMs: 20,
      },
      record: malformedAudio,
    },
  ];
  for (const { request, record } of cases) {
    let returnCount = 0;
    const fixture = fakeReviewPort([record], { onIteratorReturn: () => { returnCount += 1; } });
    const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 23) });
    const result = await review.review(request);
    assert.deepEqual(result, { status: "integrity_failed" });
    assert.equal(fixture.completions.length, 0, "malformed records must not produce a completion");
    await Promise.resolve();
    assert.equal(returnCount, 1, "malformed projection must close its iterator exactly once");
  }
});

test("does not project a final transcript whose UTF-8 representation exceeds 8 KiB", async () => {
  const tooLargeUtf8Transcript = "界".repeat(2_731);
  assert.equal(Buffer.byteLength(tooLargeUtf8Transcript, "utf8"), 8_193);
  const fixture = fakeReviewPort([transcriptRecord("source", tooLargeUtf8Transcript)]);
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 10) });

  const result = await review.review({
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "metadata_page") {
    throw new Error("Expected a metadata page");
  }
  assert.deepEqual(result.records, []);
});

test("requires an audio window to sit wholly inside a verified non-empty audio timeline", async () => {
  const request = {
    kind: "audio_window" as const,
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer" as const, actorId: "bilingual-reviewer" },
    track: "source_a" as const,
    startOffsetMs: 20,
    durationMs: 20,
  };
  const noAudio = fakeReviewPort([], { originTimelineAtMonoMs: null, durationMs: 0 });
  const noAudioReview = new EvidenceReview({ artifacts: noAudio.port, cursorKey: Buffer.alloc(32, 11) });
  await assert.rejects(noAudioReview.review(request), /verified audio timeline/u);

  const truncated = fakeReviewPort([audioRecord("source_a", 1_000, 0x11)], { durationMs: 40 });
  const truncatedReview = new EvidenceReview({ artifacts: truncated.port, cursorKey: Buffer.alloc(32, 12) });
  await assert.rejects(
    truncatedReview.review({ ...request, startOffsetMs: 40 }),
    /verified audio timeline/u,
  );
});

test("allowlist-projects only committed review metadata without leaking evidence sentinels", async () => {
  const sentinel = "SENTINEL-do-not-release";
  const finalTranscript = {
    type: "session_event",
    sessionId: SESSION_ID,
    archiveId: sentinel,
    archivePath: sentinel,
    event: {
      type: "source_transcript",
      cursor: 1,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_000,
      lane: "A_TO_B",
      generation: 0,
      turnId: "turn-safe",
      segmentId: "segment-safe",
      revision: 1,
      text: "Committed text is the only permitted plaintext.",
      final: true,
      evidenceRef: sentinel,
      providerBody: sentinel,
    },
  } as unknown as EvidenceRecord;
  const glossary = {
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type: "glossary_authorized",
      cursor: 2,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_020,
      lane: "A_TO_B",
      generation: 0,
      turnId: "turn-safe",
      segmentId: "segment-safe",
      revision: 1,
      final: true,
      glossaryHash: "d".repeat(64),
      entryIds: ["opaque-entry-1"],
      glossaryPlaintext: sentinel,
      providerBody: sentinel,
    },
  } as unknown as EvidenceRecord;
  const staticAlert = {
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type: "alert",
      cursor: 3,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_040,
      lane: "A_TO_B",
      generation: 0,
      alert: {
        code: "translation_failed",
        message: sentinel,
        retryable: true,
        termId: sentinel,
        providerBody: sentinel,
      },
    },
  } as unknown as EvidenceRecord;
  const consent = {
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type: "participant_consent",
      cursor: 4,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_060,
      lane: null,
      generation: null,
      side: "A",
      consentId: sentinel,
      consentPolicyRef: {
        id: sentinel,
        revision: sentinel,
        sha256: "e".repeat(64),
        approvedBy: sentinel,
        approvedAtUtc: "2026-08-09T00:00:00.000Z",
        noticeVersion: sentinel,
      },
      recording: true,
      processing: true,
      acceptedAtMonoMs: 1_060,
    },
  } as unknown as EvidenceRecord;
  const unknownProviderAlert = {
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type: "alert",
      cursor: 5,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_070,
      lane: "A_TO_B",
      generation: 0,
      alert: { code: sentinel, message: sentinel, retryable: true },
    },
  } as unknown as EvidenceRecord;
  const rejectedProviderOutput = {
    type: "translation_rejected",
    sessionId: SESSION_ID,
    timestampMonoMs: 1_080,
    reason: "provider_error",
    identity: {
      sessionId: SESSION_ID,
      lane: "A_TO_B",
      generation: 0,
      turnId: sentinel,
      segmentId: sentinel,
      revision: 1,
      finality: "final",
      kind: "error",
      evidenceRef: sentinel,
      emittedAtMs: 1_080,
    },
  } as unknown as EvidenceRecord;
  const fixture = fakeReviewPort([
    finalTranscript,
    transcriptRecord("target", sentinel, false),
    glossary,
    staticAlert,
    consent,
    unknownProviderAlert,
    rejectedProviderOutput,
    audioRecord("source_a", 1_000, 0x35),
  ], { durationMs: 20, retentionDeadlineAtMs: 99_999 });
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 13) });

  const result = await review.review({
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "metadata_page") {
    throw new Error("Expected an allowlisted metadata page");
  }
  assert.equal(result.summary.retentionDeadlineAtMs, 99_999);
  assert.deepEqual(result.records.map((record) => record.kind), [
    "transcript",
    "glossary_provenance",
    "alert",
    "alert",
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [sentinel, SESSION_ID, "archiveId", "archivePath", "consentId", "providerBody", "evidenceRef", "grant"]) {
    assert.equal(serialized.includes(forbidden), false, `review result leaked ${forbidden}`);
  }
  assert.deepEqual(result.records[2], { kind: "alert", code: "translation_failed" });
  assert.deepEqual(result.records[3], { kind: "alert", code: "unclassified_relay_alert" });
});

test("omits overlimit glossary provenance rather than releasing a partial entry-id projection", async () => {
  const sentinel = "GLOSSARY-PROVENANCE-SENTINEL";
  const glossaryRecord = (cursor: number, entryIds: readonly string[]): EvidenceRecord => ({
    type: "session_event",
    sessionId: SESSION_ID,
    event: {
      type: "glossary_authorized",
      cursor,
      sessionId: SESSION_ID,
      timestampMonoMs: 1_000 + cursor * 20,
      lane: "A_TO_B",
      generation: 0,
      turnId: "turn-safe",
      segmentId: "segment-safe",
      revision: 1,
      final: true,
      glossaryHash: "f".repeat(64),
      entryIds,
    },
  } as unknown as EvidenceRecord);
  const tooManyIds = Array.from({ length: 101 }, (_, index) => `${sentinel}-count-${index}`);
  const tooManyUtf8Bytes = Array.from(
    { length: 100 },
    (_, index) => `${sentinel}-${index}-${"界".repeat(27)}`,
  );
  assert.ok(tooManyUtf8Bytes.every((id) => Buffer.byteLength(id, "utf8") <= 512));
  assert.ok(tooManyUtf8Bytes.reduce((total, id) => total + Buffer.byteLength(id, "utf8"), 0) > 8 * 1024);
  const fixture = fakeReviewPort([
    glossaryRecord(1, tooManyIds),
    glossaryRecord(2, tooManyUtf8Bytes),
    transcriptRecord("source", "the only returned record"),
  ]);
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 18) });

  const result = await review.review({
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "metadata_page") {
    throw new Error("Expected an allowlisted metadata page");
  }
  assert.deepEqual(result.records, [{
    kind: "transcript",
    direction: "source",
    turnId: "turn-1",
    segmentId: "segment-1",
    revision: 1,
    text: "the only returned record",
  }]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("returns the locally captured audited callback value when a malicious port attempts result substitution", async () => {
  const substitutedSentinel = "SUBSTITUTED-PORT-VALUE-MUST-NOT-ESCAPE";
  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      _request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      const completion = await transaction(lease([transcriptRecord("source", "safe committed text")]));
      return {
        status: "completed",
        auditId: "audit-opaque-substitution",
        responseSha256: completion.responseSha256,
        value: {
          status: "completed",
          kind: "metadata_page",
          records: [{ kind: "transcript", text: substitutedSentinel }],
        },
      } as never;
    },
  };
  const review = new EvidenceReview({ artifacts: port, cursorKey: Buffer.alloc(32, 14) });

  const result = await review.review({
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "metadata_page") {
    throw new Error("Expected the captured metadata page");
  }
  assert.deepEqual(result.records, [{
    kind: "transcript",
    direction: "source",
    turnId: "turn-1",
    segmentId: "segment-1",
    revision: 1,
    text: "safe committed text",
  }]);
  assert.equal(JSON.stringify(result).includes(substitutedSentinel), false);
});

test("rejects a completed audit result whose valid SHA-256 does not bind the captured response", async () => {
  let auditedResponseSha256: string | undefined;
  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      _request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      const completion = await transaction(lease([transcriptRecord("source", "never release this response")]));
      auditedResponseSha256 = completion.responseSha256;
      return {
        status: "completed" as const,
        auditId: "audit-mismatched-response-hash",
        responseSha256: completion.responseSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64),
      };
    },
  };
  const review = new EvidenceReview({ artifacts: port, cursorKey: Buffer.alloc(32, 20) });
  let completedResponseReleased = false;

  await assert.rejects(
    review.review({
      kind: "metadata_page",
      sessionId: SESSION_ID,
      actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
    }).then(() => { completedResponseReleased = true; }),
    /audit response hash does not match/u,
  );
  assert.match(auditedResponseSha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(completedResponseReleased, false);
});

test("renders a bounded mono PCM16LE WAV with zero-filled gaps and strict track isolation", async () => {
  const fixture = fakeReviewPort([
    audioRecord("source_a", 1_020, 0x11),
    audioRecord("source_b", 1_040, 0x22),
    audioRecord("playout_to_a", 1_040, 0x44),
    audioRecord("source_a", 1_060, 0x33),
  ], { durationMs: 100 });
  const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, 15) });

  const result = await review.review({
    kind: "audio_window",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
    track: "source_a",
    startOffsetMs: 20,
    durationMs: 60,
  });
  assert.equal(result.status, "completed");
  if (result.status !== "completed" || result.kind !== "audio_window") {
    throw new Error("Expected a mono audio window");
  }
  const wav = Buffer.from(result.wav);
  assert.equal(wav.byteLength, 44 + 60 * 48);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), wav.byteLength - 8);
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(28), 48_000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 60 * 48);
  assert.ok(wav.subarray(44, 44 + 960).every((byte) => byte === 0x11));
  assert.ok(wav.subarray(44 + 960, 44 + 1_920).every((byte) => byte === 0));
  assert.ok(wav.subarray(44 + 1_920, 44 + 2_880).every((byte) => byte === 0x33));

  const maximumFixture = fakeReviewPort([], { durationMs: 30_000 });
  const maximumReview = new EvidenceReview({ artifacts: maximumFixture.port, cursorKey: Buffer.alloc(32, 16) });
  const maximum = await maximumReview.review({
    kind: "audio_window",
    sessionId: SESSION_ID,
    actor: { role: "retention_owner", actorId: "data-owner" },
    track: "source_a",
    startOffsetMs: 0,
    durationMs: 30_000,
  });
  assert.equal(maximum.status, "completed");
  if (maximum.status !== "completed" || maximum.kind !== "audio_window") {
    throw new Error("Expected the maximum audio window");
  }
  assert.equal(maximum.wav.byteLength, 1_440_044);
  assert.equal(Buffer.from(maximum.wav).readUInt32LE(40), 1_440_000);
});

test("returns no review value when the artifact port reports any sealed-review gate or audit failure", async () => {
  const statuses: readonly EvidenceReviewLeaseUnavailableStatus[] = [
    "not_found",
    "not_sealed",
    "grant_denied",
    "expired",
    "integrity_failed",
    "audit_failed",
  ];
  for (const status of statuses) {
    const fixture = fakeReviewPort(
      [transcriptRecord("source", "must not be returned after " + status)],
      status === "audit_failed" ? { postTransactionStatus: status } : { immediateStatus: status },
    );
    const review = new EvidenceReview({ artifacts: fixture.port, cursorKey: Buffer.alloc(32, status.length) });
    const result = await review.review({
      kind: "metadata_page",
      sessionId: SESSION_ID,
      actor: { role: "evidence_reviewer", actorId: "bilingual-reviewer" },
    });
    assert.deepEqual(result, { status }, `status ${status} must not carry review content`);
    assert.equal(JSON.stringify(result).includes("must not be returned"), false);
    assert.equal(
      fixture.completions.length,
      status === "audit_failed" ? 1 : 0,
      "only a failed audit may see the locally captured callback response",
    );
  }
});

test("forwards the actor to the assignment-owning port and releases no data when that port denies the assignment", async () => {
  let observedActor: EvidenceReviewRequest["actor"] | undefined;
  const port: EvidenceReviewArtifactPort = {
    async withVerifiedSealedReviewLease<T>(
      request: EvidenceReviewRequest,
      transaction: (value: EvidenceReviewLease) => Promise<EvidenceReviewLeaseCompletion<T>>,
    ) {
      observedActor = request.actor;
      if (request.actor.actorId !== "assigned-bilingual-reviewer") {
        return { status: "grant_denied" as const };
      }
      const completion = await transaction(lease([transcriptRecord("source", "assigned evidence")]));
      return {
        status: "completed" as const,
        auditId: "audit-assigned-reviewer",
        responseSha256: completion.responseSha256,
      };
    },
  };
  const review = new EvidenceReview({ artifacts: port, cursorKey: Buffer.alloc(32, 17) });

  const result = await review.review({
    kind: "metadata_page",
    sessionId: SESSION_ID,
    actor: { role: "evidence_reviewer", actorId: "unassigned-reviewer" },
  });
  assert.deepEqual(observedActor, { role: "evidence_reviewer", actorId: "unassigned-reviewer" });
  assert.deepEqual(result, { status: "grant_denied" });
});

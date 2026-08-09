import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAudioFrame, CANONICAL_AUDIO } from "../src/core/audio.js";
import { SessionArtifactStore } from "../src/adapters/evidence/session-artifact-store.js";
import type {
  EvidenceReview,
  EvidenceReviewMetadataRecord,
  EvidenceReviewRequest,
  EvidenceReviewResult,
} from "../src/adapters/evidence/review.js";
import { createSyntheticPocProcessingManifest } from "../src/local-eval/synthetic-poc-processing-manifest.js";
import type {
  GuardedDuplexRelay,
  SessionEvent,
} from "../src/core/types.js";
import { createServerAccessControl } from "../src/server/access.js";
import {
  createServerApp,
  type ConfiguredTranslation,
  type GlossaryDeletionCommand,
  type GlossaryDeletionResult,
  type GlossaryImportResult,
  type GlossaryLease,
  type GlossaryRegistry,
  type GlossaryRootLease,
  type ServerArtifactGovernancePort,
} from "../src/server/app.js";
import type { ImportGlossaryRequest } from "../src/server/protocol.js";
import { createTestOnlyVerifiedHumanSessionProcessingProfile } from "./support/acceptance.js";
import type {
  ArtifactRecoveryResult,
  EvidenceRootLeaseRole,
  EvidenceRootProcessLease,
  EvidenceDeleteRequest,
  EvidenceDeletionResult,
  ManagedEvidenceExportLease,
  ManagedEvidenceExportLeaseCompletion,
  ManagedEvidenceExportLeaseRequest,
  ManagedEvidenceExportLeaseResult,
  RetentionExtensionRequest,
  RetentionExtensionResult,
  RetentionSweepHealth,
  RetentionSweepResult,
} from "../src/adapters/evidence/session-artifact-store.js";
import type { EvidenceRecord } from "../src/core/types.js";

const OPERATOR_TOKEN = "operator-0123456789abcdef0123456789abcdef";
const OWNER_TOKEN = "retention-owner-0123456789abcdef012345";
const REVIEWER_TOKEN = "evidence-reviewer-0123456789abcdef01234";
const OWNER_HEADERS = { authorization: "Bearer " + OWNER_TOKEN };
const REVIEWER_HEADERS = { authorization: "Bearer " + REVIEWER_TOKEN };
const OPERATOR_HEADERS = { authorization: "Bearer " + OPERATOR_TOKEN };
const DEPLOYMENT_BUILD_SHA256 = "b".repeat(64);
const SESSION_ID = "session-retention-1";
const COMMAND_ID = "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7";
const RETENTION_DEADLINE_MS = Date.parse("2026-08-23T12:00:00.000Z");
const EXTENDED_DEADLINE_MS = Date.parse("2026-08-30T12:00:00.000Z");
const REVIEW_FINALIZATION_SHA256 = "c".repeat(64);
const REVIEW_AUDIT_ID = "review-audit-01";
const REVIEW_WAV = Uint8Array.of(82, 73, 70, 70, 4, 0, 0, 0, 87, 65, 86, 69);
const CANONICAL_REVIEW_CURSOR = "evidence-review-v1.AQEBAQEBAQEBAQEB.Ag.AwMDAwMDAwMDAwMDAwMDAw";

const translation: ConfiguredTranslation = {
  providerId: "openai_controlled",
  modes: [
    { mode: "fast", behaviorVersion: 1, state: "locally_controlled", deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, state: "locally_controlled", deterministicGlossary: false },
    { mode: "accurate", behaviorVersion: 1, state: "locally_controlled", deterministicGlossary: true },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
  defaultMode: "balanced",
};

const unusedRelay: GuardedDuplexRelay = {
  async open() {
    throw new Error("The retention route must not open a relay session");
  },
  snapshot() {
    throw new Error("The retention route must not read a relay snapshot");
  },
  async command() {
    throw new Error("The retention route must not issue a relay command");
  },
  events(): AsyncIterable<SessionEvent> {
    return {
      async *[Symbol.asyncIterator]() {},
    };
  },
};

const unusedGlossaries: GlossaryRegistry = {
  async acquireRootLease() {
    return {
      async release(): Promise<void> {},
    };
  },
  async importFile() {
    throw new Error("The retention route must not import a glossary");
  },
  async acquire() {
    return undefined;
  },
  async deleteVersion() {
    throw new Error("The retention route must not delete a glossary");
  },
};

class TrackingGlossaryRegistry implements GlossaryRegistry {
  readonly lifecycleCalls: string[] = [];
  rootLeaseError: Error | undefined;

  async acquireRootLease(): Promise<GlossaryRootLease> {
    this.lifecycleCalls.push("lease");
    if (this.rootLeaseError !== undefined) throw this.rootLeaseError;
    let released = false;
    return {
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.lifecycleCalls.push("release");
      },
    };
  }

  async importFile(_request: ImportGlossaryRequest): Promise<GlossaryImportResult> {
    throw new Error("The retention route must not import a glossary");
  }

  async acquire(_version: string): Promise<GlossaryLease | undefined> {
    return undefined;
  }

  async deleteVersion(_command: GlossaryDeletionCommand): Promise<GlossaryDeletionResult> {
    throw new Error("The retention route must not delete a glossary");
  }
}

class FakeRetentionArtifacts implements ServerArtifactGovernancePort {
  readonly extensionRequests: RetentionExtensionRequest[] = [];
  readonly deletionRequests: EvidenceDeleteRequest[] = [];
  readonly managedExportRequests: ManagedEvidenceExportLeaseRequest[] = [];
  readonly acquiredEvidenceRootLeaseRoles: EvidenceRootLeaseRole[] = [];
  recoverCalls = 0;
  sweepCalls = 0;
  releasedEvidenceRootLeases = 0;
  evidenceRootLeaseError: Error | undefined;
  recoveryError: Error | undefined;
  recoveryResult: ArtifactRecoveryResult | undefined;
  sweepError: Error | undefined;
  sweepResult: RetentionSweepResult | undefined;
  managedExportStatus: "audit_failed" | "conflict" | "expired" | "not_found" = "conflict";
  extensionResult: RetentionExtensionResult = {
    status: "extended",
    retentionDeadlineAtMs: EXTENDED_DEADLINE_MS,
    extensionUsed: true,
  };
  deletionResult: EvidenceDeletionResult = {
    status: "completed",
    deletionReceiptId: "a".repeat(64),
  };
  retentionHealth: RetentionSweepHealth = {
    health: "healthy" as const,
    lastSuccessfulSweepAtMs: Date.parse("2026-08-09T12:00:00.000Z"),
  };
  async extendRetention(request: RetentionExtensionRequest): Promise<RetentionExtensionResult> {
    this.extensionRequests.push(structuredClone(request));
    return this.extensionResult;
  }

  async deleteEvidence(request: EvidenceDeleteRequest): Promise<EvidenceDeletionResult> {
    this.deletionRequests.push(structuredClone(request));
    return this.deletionResult;
  }

  getRetentionSweepHealth(): RetentionSweepHealth {
    return this.retentionHealth;
  }

  async recover(): Promise<ArtifactRecoveryResult> {
    this.lifecycleCalls.push("recover");
    this.recoverCalls += 1;
    if (this.recoveryError !== undefined) throw this.recoveryError;
    if (this.recoveryResult !== undefined) return this.recoveryResult;
    return {
      status: "completed" as const,
      recoveredDeletions: 0,
      sealedArtifacts: 0,
      finalizationFailures: 0,
      orphanedActiveArtifacts: 0,
      ...this.getRetentionSweepHealth(),
    };
  }

  async sweepExpired(): Promise<RetentionSweepResult> {
    this.lifecycleCalls.push("sweep");
    this.sweepCalls += 1;
    if (this.sweepError !== undefined) throw this.sweepError;
    if (this.sweepResult !== undefined) return this.sweepResult;
    return {
      status: "completed" as const,
      expiredArtifactsDeleted: 0,
      ...this.getRetentionSweepHealth(),
    };
  }

  readonly lifecycleCalls: string[] = [];

  async acquireEvidenceRootLease(role: EvidenceRootLeaseRole): Promise<EvidenceRootProcessLease> {
    this.acquiredEvidenceRootLeaseRoles.push(role);
    this.lifecycleCalls.push("lease:" + role);
    if (this.evidenceRootLeaseError !== undefined) throw this.evidenceRootLeaseError;
    let released = false;
    return {
      role,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        this.releasedEvidenceRootLeases += 1;
        this.lifecycleCalls.push("release:" + role);
      },
    };
  }

  async withManagedExportLease<T>(
    request: ManagedEvidenceExportLeaseRequest,
    _transaction: (
      _lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>> {
    this.managedExportRequests.push(structuredClone(request));
    return { status: this.managedExportStatus };
  }
}

function completedMetadataReview(
  overrides: Partial<Extract<EvidenceReviewResult, { readonly kind: "metadata_page" }>> = {},
): Extract<EvidenceReviewResult, { readonly kind: "metadata_page" }> {
  return {
    status: "completed",
    kind: "metadata_page",
    auditId: REVIEW_AUDIT_ID,
    summary: {
      finalizationSha256: REVIEW_FINALIZATION_SHA256,
      durationMs: 40,
      recordCount: 3,
      retentionDeadlineAtMs: RETENTION_DEADLINE_MS,
    },
    records: [{
      kind: "alert",
      code: "provider_error",
    }],
    ...overrides,
  };
}

function completedAudioReview(
  overrides: Partial<Extract<EvidenceReviewResult, { readonly kind: "audio_window" }>> = {},
): Extract<EvidenceReviewResult, { readonly kind: "audio_window" }> {
  return {
    status: "completed",
    kind: "audio_window",
    auditId: REVIEW_AUDIT_ID,
    summary: {
      finalizationSha256: REVIEW_FINALIZATION_SHA256,
      durationMs: 40,
      recordCount: 3,
      retentionDeadlineAtMs: RETENTION_DEADLINE_MS,
    },
    track: "source_a",
    startOffsetMs: 0,
    durationMs: 20,
    wav: REVIEW_WAV,
    ...overrides,
  };
}

function completedRetentionSummaryReview(
  overrides: Partial<Extract<EvidenceReviewResult, { readonly kind: "retention_summary" }>> = {},
): Extract<EvidenceReviewResult, { readonly kind: "retention_summary" }> {
  return {
    status: "completed",
    kind: "retention_summary",
    auditId: REVIEW_AUDIT_ID,
    summary: {
      finalizationSha256: REVIEW_FINALIZATION_SHA256,
      durationMs: 40,
      recordCount: 3,
      retentionDeadlineAtMs: RETENTION_DEADLINE_MS,
    },
    ...overrides,
  };
}

class FakeEvidenceReview implements Pick<EvidenceReview, "review"> {
  readonly requests: EvidenceReviewRequest[] = [];
  result: EvidenceReviewResult = completedMetadataReview();
  error: Error | undefined;
  beforeReturn: (() => Promise<void>) | undefined;

  async review(request: EvidenceReviewRequest): Promise<EvidenceReviewResult> {
    this.requests.push(structuredClone(request));
    await this.beforeReturn?.();
    if (this.error !== undefined) throw this.error;
    return this.result;
  }
}

async function createSealedArtifacts(): Promise<Readonly<{
  artifacts: SessionArtifactStore;
  sessionId: string;
  root: string;
  retentionDeadlineAt: string;
}>> {
  const root = join(process.cwd(), "work", "tmp", "server-retention-export", randomUUID());
  await mkdir(root, { recursive: true });
  const artifacts = new SessionArtifactStore({
    archiveDirectory: join(root, "archive"),
    keyDirectory: join(root, "keys"),
    exportDirectory: join(root, "exports"),
    receiptDirectory: join(root, "receipts"),
    rootKey: Buffer.alloc(32, 71),
    dataOwnerId: "customer-retention-owner",
    minimumFreeBytes: 1,
    now: () => Date.now(),
    securityBoundaryDirectory: root,
    strictAncestors: false,
  });
  const setupLease = await artifacts.acquireEvidenceRootLease("server");
  try {
    const sessionId = "server-managed-export-" + randomUUID();
    const processingManifest = createSyntheticPocProcessingManifest({ mode: "fast" });
    const persist = async (value: EvidenceRecord): Promise<void> => {
      await artifacts.persist(value);
    };

    await persist({
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
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
            evidenceReviewGrant: {
              dataOwnerId: "customer-retention-owner",
              bilingualReviewerId: "customer-evidence-reviewer",
            },
          },
        },
      },
    } as unknown as EvidenceRecord);
    await artifacts.flush(sessionId);

    const preflight = await artifacts.preflightRecorder({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected a ready evidence recorder");
    await persist({
      type: "recorder_preflight",
      sessionId,
      timestampMonoMs: 2,
      preflight,
    });
    for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
      await persist({
        type: "session_event",
        sessionId,
        event: {
          type: "participant_consent",
          cursor,
          sessionId,
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
        sessionId,
        track,
        timelineAtMonoMs: 10,
        frame: createAudioFrame({
          sessionId,
          lane: laneByTrack[track],
          generation: 0,
          sequence: 0,
          capturedAtMs: 10,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
        }),
      });
    }
    await artifacts.flush(sessionId);
    const finalization = await artifacts.finalize({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      finalizedAtMonoMs: 20,
      reason: "operator_end",
      lastPersistedEventCursor: 3,
    });
    assert.equal(finalization.status, "sealed");
    if (finalization.status !== "sealed") throw new Error("Expected sealed evidence finalization");
    return {
      artifacts,
      sessionId,
      root,
      retentionDeadlineAt: finalization.retentionDeadlineAt,
    };
  } finally {
    await setupLease.release();
  }
}

async function fixtureWithArtifacts<T extends ServerArtifactGovernancePort>(
  artifacts: T,
  webRoot?: string,
  glossaries: GlossaryRegistry = unusedGlossaries,
  evidenceReview: Pick<EvidenceReview, "review"> = new FakeEvidenceReview(),
) {
  const access = createServerAccessControl({
    operatorToken: OPERATOR_TOKEN,
    retentionOwner: { id: "customer-retention-owner", token: OWNER_TOKEN },
    evidenceReviewer: { id: "customer-evidence-reviewer", token: REVIEWER_TOKEN },
    participantSigningKey: Buffer.alloc(32, 53),
  });
  const app = await createServerApp({
    relay: unusedRelay,
    glossaries,
    mediaProfile: "fake_telephony",
    access,
    translation,
    processingProfile: createTestOnlyVerifiedHumanSessionProcessingProfile(),
    deploymentBuildSha256: DEPLOYMENT_BUILD_SHA256,
    artifacts,
    evidenceReview,
    ...(webRoot === undefined ? {} : { webRoot }),
  });
  await app.ready();
  return { app, artifacts, access, evidenceReview };
}

async function fixture() {
  return fixtureWithArtifacts(new FakeRetentionArtifacts());
}

describe("evidence review HTTP API", () => {
  it("returns only the safe metadata projection for the configured owner and reviewer", async () => {
    const evidenceReview = new FakeEvidenceReview();
    evidenceReview.result = {
      ...completedMetadataReview({
        records: [{
          kind: "alert",
          code: "provider_error",
          archivePath: "C:\\evidence\\archive.bin",
          providerReference: "provider-ref:private",
          rawPcm16le: "raw-pcm-private",
        } as unknown as EvidenceReviewMetadataRecord],
      }),
      archiveId: "internal-archive-id",
    } as EvidenceReviewResult;
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    const metadataPath = "/api/sessions/" + SESSION_ID + "/evidence/review";
    try {
      for (const headers of [OWNER_HEADERS, REVIEWER_HEADERS]) {
        const response = await app.inject({
          method: "POST",
          url: metadataPath,
          headers,
          payload: { pageSize: 1 },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.deepEqual(response.json(), {
          status: "completed",
          summary: {
            finalizationSha256: REVIEW_FINALIZATION_SHA256,
            durationMs: 40,
            recordCount: 3,
            retentionDeadlineAt: "2026-08-23T12:00:00.000Z",
          },
          records: [{ kind: "alert", code: "provider_error" }],
        });
        assert.doesNotMatch(
          response.body,
          /internal-archive-id|archive\\.bin|provider-ref|raw-pcm|customer-retention-owner|customer-evidence-reviewer/u,
        );
      }
      assert.deepEqual(evidenceReview.requests, [
        {
          kind: "metadata_page",
          sessionId: SESSION_ID,
          actor: { role: "retention_owner", actorId: "customer-retention-owner" },
          pageSize: 1,
        },
        {
          kind: "metadata_page",
          sessionId: SESSION_ID,
          actor: { role: "evidence_reviewer", actorId: "customer-evidence-reviewer" },
          pageSize: 1,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it("denies operator, participant, and missing credentials before starting review", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app, access } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    const metadataPath = "/api/sessions/" + SESSION_ID + "/evidence/review";
    try {
      const participantHeaders = {
        authorization: "Bearer " + access.issueParticipantAccess(SESSION_ID, "A"),
      };
      for (const headers of [undefined, OPERATOR_HEADERS, participantHeaders]) {
        const response = await app.inject({
          method: "POST",
          url: metadataPath,
          ...(headers === undefined ? {} : { headers }),
          payload: { pageSize: 1 },
        });
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.json(), {
          error: {
            code: "unauthorized",
            message: "A valid evidence management bearer token is required",
          },
        });
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("settles authorized and unauthorized evidence hooks", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const [unauthorized, authorized] = await Promise.all([
        app.inject({
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/review",
          payload: {},
        }),
        app.inject({
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/review",
          headers: OWNER_HEADERS,
          payload: {},
        }),
      ]);
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(authorized.statusCode, 200);
      assert.equal(unauthorized.headers["cache-control"], "no-store");
      assert.equal(authorized.headers["cache-control"], "no-store");
      assert.equal(evidenceReview.requests.length, 1);
    } finally {
      await app.close();
    }
  });

  it("awaits the audited review completion before responding", async () => {
    const evidenceReview = new FakeEvidenceReview();
    let releaseAudit!: () => void;
    const audit = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    let markAuditStarted!: () => void;
    const auditStarted = new Promise<void>((resolve) => {
      markAuditStarted = resolve;
    });
    evidenceReview.beforeReturn = async () => {
      markAuditStarted();
      await audit;
    };
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const responsePromise = app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      await auditStarted;
      let settled = false;
      void responsePromise.then(() => {
        settled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      releaseAudit();
      const response = await responsePromise;
      assert.equal(response.statusCode, 200);
    } finally {
      await app.close();
    }
  });

  it("returns direct WAV bytes with only the evidence-audit response header", async () => {
    const evidenceReview = new FakeEvidenceReview();
    evidenceReview.result = completedAudioReview();
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review/audio-window",
        headers: REVIEWER_HEADERS,
        payload: {
          track: "source_a",
          startOffsetMs: 0,
          durationMs: 20,
        },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["content-type"], "audio/wav");
      assert.equal(response.headers["x-evidence-audit-id"], REVIEW_AUDIT_ID);
      assert.equal(response.headers["content-disposition"], undefined);
      assert.deepEqual(response.rawPayload, Buffer.from(REVIEW_WAV));
      assert.doesNotMatch(response.body, /archive|path|provider-ref|raw-pcm/u);
      assert.deepEqual(evidenceReview.requests, [{
        kind: "audio_window",
        sessionId: SESSION_ID,
        actor: { role: "evidence_reviewer", actorId: "customer-evidence-reviewer" },
        track: "source_a",
        startOffsetMs: 0,
        durationMs: 20,
      }]);
    } finally {
      await app.close();
    }
  });

  it("maps unavailable review outcomes and input ranges without disclosing internal failures", async () => {
    const cases: ReadonlyArray<Readonly<{
      status: "not_found" | "grant_denied" | "not_sealed" | "expired" | "integrity_failed" | "audit_failed";
      expectedStatusCode: number;
      expectedBody: object;
    }>> = [
      {
        status: "not_found",
        expectedStatusCode: 404,
        expectedBody: { error: { code: "evidence_not_found", message: "Evidence was not found" } },
      },
      {
        status: "grant_denied",
        expectedStatusCode: 404,
        expectedBody: { error: { code: "evidence_not_found", message: "Evidence was not found" } },
      },
      {
        status: "not_sealed",
        expectedStatusCode: 409,
        expectedBody: { error: { code: "evidence_not_sealed", message: "Evidence is not sealed" } },
      },
      {
        status: "expired",
        expectedStatusCode: 410,
        expectedBody: { error: { code: "evidence_expired", message: "Evidence retention has expired" } },
      },
      {
        status: "integrity_failed",
        expectedStatusCode: 503,
        expectedBody: {
          error: {
            code: "evidence_review_unavailable",
            message: "Evidence review is temporarily unavailable",
          },
        },
      },
      {
        status: "audit_failed",
        expectedStatusCode: 503,
        expectedBody: {
          error: {
            code: "evidence_review_unavailable",
            message: "Evidence review is temporarily unavailable",
          },
        },
      },
    ];
    for (const outcome of cases) {
      const evidenceReview = new FakeEvidenceReview();
      evidenceReview.result = { status: outcome.status };
      const { app } = await fixtureWithArtifacts(
        new FakeRetentionArtifacts(),
        undefined,
        undefined,
        evidenceReview,
      );
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/review",
          headers: OWNER_HEADERS,
          payload: {},
        });
        assert.equal(response.statusCode, outcome.expectedStatusCode, outcome.status);
        assert.deepEqual(response.json(), outcome.expectedBody, outcome.status);
        assert.equal(response.headers["cache-control"], "no-store", outcome.status);
        assert.doesNotMatch(response.body, /grant_denied|integrity_failed|audit_failed|archive|path/u);
      } finally {
        await app.close();
      }
    }

    const metadataRange = new FakeEvidenceReview();
    metadataRange.error = new RangeError("private cursor detail");
    const metadataFixture = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      metadataRange,
    );
    try {
      const response = await metadataFixture.app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: { cursor: CANONICAL_REVIEW_CURSOR },
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: { code: "invalid_request", message: "Evidence review request is invalid" },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /private cursor detail/u);
      assert.deepEqual(metadataRange.requests, [{
        kind: "metadata_page",
        sessionId: SESSION_ID,
        actor: { role: "retention_owner", actorId: "customer-retention-owner" },
        cursor: CANONICAL_REVIEW_CURSOR,
      }]);
    } finally {
      await metadataFixture.app.close();
    }

    const audioRange = new FakeEvidenceReview();
    audioRange.error = new RangeError("private window detail");
    const audioFixture = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      audioRange,
    );
    try {
      const response = await audioFixture.app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review/audio-window",
        headers: OWNER_HEADERS,
        payload: { track: "source_a", startOffsetMs: 0, durationMs: 20 },
      });
      assert.equal(response.statusCode, 416);
      assert.deepEqual(response.json(), {
        error: {
          code: "audio_window_unavailable",
          message: "The requested audio window is unavailable",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /private window detail/u);
    } finally {
      await audioFixture.app.close();
    }
  });

  it("rejects malformed review bodies and degraded retention before review", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app, artifacts } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const malformed = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review/audio-window",
        headers: OWNER_HEADERS,
        payload: { track: "source_a", startOffsetMs: 1, durationMs: 20 },
      });
      assert.equal(malformed.statusCode, 400);
      assert.equal(malformed.json().error.code, "invalid_request");
      assert.equal(malformed.headers["cache-control"], "no-store");
      assert.deepEqual(evidenceReview.requests, []);

      artifacts.retentionHealth = { health: "degraded" };
      const degraded = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      assert.equal(degraded.statusCode, 503);
      assert.equal(degraded.json().error.code, "retention_degraded");
      assert.equal(degraded.headers["cache-control"], "no-store");
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("maps malformed JSON to a safe no-store response before review or storage", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: { ...OWNER_HEADERS, "content-type": "application/json" },
        payload: '{"pageSize":',
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          code: "invalid_request",
          message: "Invalid request body",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("maps oversized JSON to a safe no-store response before review or storage", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: { ...OWNER_HEADERS, "content-type": "application/json" },
        payload: Buffer.alloc(32 * 1024 * 1024 + 1, 0x20),
      });
      assert.equal(response.statusCode, 413);
      assert.deepEqual(response.json(), {
        error: {
          code: "payload_too_large",
          message: "Request payload is too large",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthorized oversized evidence body before parsing", async () => {
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: { "content-type": "application/json" },
        payload: Buffer.alloc(32 * 1024 * 1024 + 1, 0x20),
      });
      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), {
        error: {
          code: "unauthorized",
          message: "A valid evidence management bearer token is required",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("redacts unexpected evidence review failures", async () => {
    const evidenceReview = new FakeEvidenceReview();
    evidenceReview.error = new Error("private archive path");
    const { app } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      assert.equal(response.statusCode, 500);
      assert.deepEqual(response.json(), {
        error: {
          code: "internal_error",
          message: "The server could not complete the request",
        },
      });
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /private archive path/u);
      assert.equal(evidenceReview.requests.length, 1);
    } finally {
      await app.close();
    }
  });
});

describe("retention management HTTP API", () => {
  it("audits sealed retention reads through review and limits mutations to the data owner", async () => {
    const evidenceReview = new FakeEvidenceReview();
    evidenceReview.result = completedRetentionSummaryReview();
    const { app, artifacts, access } = await fixtureWithArtifacts(
      new FakeRetentionArtifacts(),
      undefined,
      undefined,
      evidenceReview,
    );
    const retentionPath = "/api/sessions/" + SESSION_ID + "/evidence/retention";
    try {
      assert.equal(artifacts.recoverCalls, 1);
      assert.equal(artifacts.sweepCalls, 1);

      const participantHeaders = {
        authorization: "Bearer " + access.issueParticipantAccess(SESSION_ID, "A"),
      };
      for (const headers of [undefined, OPERATOR_HEADERS, participantHeaders]) {
        const response = await app.inject({
          method: "GET",
          url: retentionPath,
          ...(headers === undefined ? {} : { headers }),
        });
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, "unauthorized");
        assert.equal(response.headers["cache-control"], "no-store");
      }

      for (const headers of [OWNER_HEADERS, REVIEWER_HEADERS]) {
        const response = await app.inject({ method: "GET", url: retentionPath, headers });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json(), {
          status: "sealed",
          retentionDeadlineAt: "2026-08-23T12:00:00.000Z",
        });
        assert.doesNotMatch(response.body, /archive|path|session-retention-1/u);
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.deepEqual(evidenceReview.requests, [
        {
          kind: "retention_summary",
          sessionId: SESSION_ID,
          actor: { role: "retention_owner", actorId: "customer-retention-owner" },
        },
        {
          kind: "retention_summary",
          sessionId: SESSION_ID,
          actor: { role: "evidence_reviewer", actorId: "customer-evidence-reviewer" },
        },
      ]);

      const extensionPath = retentionPath + "/extensions";
      const extensionPayload = {
        commandId: COMMAND_ID,
        reason: "Required for the scheduled customer review",
        requestedDeadline: "2026-08-30T12:00:00Z",
      };
      const reviewerExtension = await app.inject({
        method: "POST",
        url: extensionPath,
        headers: REVIEWER_HEADERS,
        payload: extensionPayload,
      });
      assert.equal(reviewerExtension.statusCode, 401);
      assert.equal(reviewerExtension.headers["cache-control"], "no-store");
      const extension = await app.inject({
        method: "POST",
        url: extensionPath,
        headers: OWNER_HEADERS,
        payload: extensionPayload,
      });
      assert.equal(extension.statusCode, 200);
      assert.equal(extension.headers["cache-control"], "no-store");
      assert.deepEqual(extension.json(), {
        status: "extended",
        retentionDeadlineAt: "2026-08-30T12:00:00.000Z",
        extensionUsed: true,
      });
      assert.equal(artifacts.extensionRequests.length, 1);
      assert.deepEqual(artifacts.extensionRequests[0], {
        sessionId: SESSION_ID,
        commandId: COMMAND_ID,
        authority: {
          kind: "retention_owner",
          actorId: "customer-retention-owner",
        },
        reason: "Required for the scheduled customer review",
        requestedAtMs: artifacts.extensionRequests[0]?.requestedAtMs,
        requestedDeadlineAtMs: EXTENDED_DEADLINE_MS,
      });
      assert.equal(typeof artifacts.extensionRequests[0]?.requestedAtMs, "number");

      const deletionPayload = {
        commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
        reason: "Customer requested early deletion",
      };
      const reviewerDeletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: REVIEWER_HEADERS,
        payload: deletionPayload,
      });
      assert.equal(reviewerDeletion.statusCode, 401);
      assert.equal(reviewerDeletion.headers["cache-control"], "no-store");
      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: deletionPayload,
      });
      assert.equal(deletion.statusCode, 200);
      assert.equal(deletion.headers["cache-control"], "no-store");
      assert.deepEqual(deletion.json(), {
        status: "completed",
        deletionReceiptId: "a".repeat(64),
      });
      assert.equal(artifacts.deletionRequests.length, 1);
      assert.deepEqual(artifacts.deletionRequests[0], {
        sessionId: SESSION_ID,
        commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
        authority: {
          kind: "retention_owner",
          actorId: "customer-retention-owner",
        },
        reason: "Customer requested early deletion",
        requestedAtMs: artifacts.deletionRequests[0]?.requestedAtMs,
      });
      assert.equal(typeof artifacts.deletionRequests[0]?.requestedAtMs, "number");
    } finally {
      await app.close();
    }
  });

  it("exposes safe degraded retention health and refuses new sessions", async () => {
    const { app, artifacts } = await fixture();
    artifacts.retentionHealth = {
      health: "degraded",
      lastSuccessfulSweepAtMs: Date.parse("2026-08-09T12:00:00.000Z"),
    };
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.equal(health.statusCode, 200);
      assert.deepEqual(health.json(), {
        status: "degraded",
        evidenceHealth: "healthy",
        retention: {
          health: "degraded",
          lastSuccessfulSweepAt: "2026-08-09T12:00:00.000Z",
        },
      });
      assert.doesNotMatch(health.body, /archive|path|session-retention-1/u);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
        },
      });
      assert.equal(created.statusCode, 503);
      assert.equal(created.json().error.code, "retention_degraded");
    } finally {
      await app.close();
    }
  });

  it("fails closed for evidence reads and writes after startup sweep failure", async () => {
    const artifacts = new FakeRetentionArtifacts();
    artifacts.sweepError = new Error("private sweep path");
    artifacts.retentionHealth = { health: "degraded" };
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(artifacts, undefined, undefined, evidenceReview);
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), {
        status: "degraded",
        evidenceHealth: "healthy",
        retention: { health: "degraded" },
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
        },
      });
      assert.equal(created.statusCode, 503);
      assert.equal(created.json().error.code, "retention_degraded");

      const start = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/commands",
        headers: OPERATOR_HEADERS,
        payload: { kind: "start", commandId: COMMAND_ID },
      });
      assert.equal(start.statusCode, 503);
      assert.equal(start.json().error.code, "retention_degraded");

      const review = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      assert.equal(review.statusCode, 503);
      assert.equal(review.json().error.code, "retention_degraded");
      assert.equal(review.headers["cache-control"], "no-store");

      const extension = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          reason: "Required for the scheduled customer review",
          requestedDeadline: "2026-08-30T12:00:00Z",
        },
      });
      assert.equal(extension.statusCode, 503);
      assert.equal(extension.json().error.code, "retention_degraded");

      const exportRequest = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(exportRequest.statusCode, 503);
      assert.equal(exportRequest.json().error.code, "retention_degraded");

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          reason: "Customer requested early deletion",
        },
      });
      assert.equal(deletion.statusCode, 200);
      assert.equal(artifacts.deletionRequests.length, 1);
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("marks retention degraded when startup sweep returns a degraded result and keeps owner deletion available", async () => {
    const artifacts = new FakeRetentionArtifacts();
    artifacts.retentionHealth = { health: "healthy" };
    artifacts.sweepResult = {
      status: "degraded",
      health: "degraded",
      expiredArtifactsDeleted: 0,
    };
    const evidenceReview = new FakeEvidenceReview();
    const { app } = await fixtureWithArtifacts(artifacts, undefined, undefined, evidenceReview);
    try {
      assert.equal(artifacts.sweepCalls, 1);
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), {
        status: "degraded",
        evidenceHealth: "healthy",
        retention: { health: "degraded" },
      });
      assert.doesNotMatch(health.body, /archive|path|session-retention-1/u);

      const created = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
        },
      });
      assert.equal(created.statusCode, 503);
      assert.equal(created.json().error.code, "retention_degraded");

      const review = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      assert.equal(review.statusCode, 503);
      assert.equal(review.json().error.code, "retention_degraded");
      assert.equal(review.headers["cache-control"], "no-store");

      const extension = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          reason: "Required for the scheduled customer review",
          requestedDeadline: "2026-08-30T12:00:00Z",
        },
      });
      assert.equal(extension.statusCode, 503);
      assert.equal(extension.json().error.code, "retention_degraded");
      assert.equal(extension.headers["cache-control"], "no-store");

      const exportRequest = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(exportRequest.statusCode, 503);
      assert.equal(exportRequest.json().error.code, "retention_degraded");
      assert.equal(exportRequest.headers["cache-control"], "no-store");

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          reason: "Customer requested early deletion",
        },
      });
      assert.equal(deletion.statusCode, 200);
      assert.equal(deletion.headers["cache-control"], "no-store");
      assert.equal(artifacts.deletionRequests.length, 1);
      assert.deepEqual(evidenceReview.requests, []);
    } finally {
      await app.close();
    }
  });

  it("blocks retention extensions while still allowing an owner deletion retry when degraded", async () => {
    const { app, artifacts } = await fixture();
    artifacts.retentionHealth = { health: "degraded" };
    try {
      const extension = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          reason: "Required for the scheduled customer review",
          requestedDeadline: "2026-08-30T12:00:00Z",
        },
      });
      assert.equal(extension.statusCode, 503);
      assert.equal(extension.json().error.code, "retention_degraded");
      assert.equal(artifacts.extensionRequests.length, 0);

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          reason: "Customer requested early deletion",
        },
      });
      assert.equal(deletion.statusCode, 200);
      assert.equal(artifacts.deletionRequests.length, 1);
    } finally {
      await app.close();
    }
  });

  it("requires a data-owner acknowledgement and gates managed exports when retention is degraded", async () => {
    const { app, artifacts } = await fixture();
    artifacts.retentionHealth = { health: "degraded" };
    const exportPath = "/api/sessions/" + SESSION_ID + "/evidence/exports";
    try {
      const reviewer = await app.inject({
        method: "POST",
        url: exportPath,
        headers: REVIEWER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(reviewer.statusCode, 401);
      assert.equal(reviewer.headers["cache-control"], "no-store");

      const missingAcknowledgement = await app.inject({
        method: "POST",
        url: exportPath,
        headers: OWNER_HEADERS,
        payload: { commandId: COMMAND_ID },
      });
      assert.equal(missingAcknowledgement.statusCode, 400);
      assert.equal(missingAcknowledgement.headers["cache-control"], "no-store");

      const exportRequest = await app.inject({
        method: "POST",
        url: exportPath,
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(exportRequest.statusCode, 503);
      assert.equal(exportRequest.headers["cache-control"], "no-store");
      assert.equal(exportRequest.json().error.code, "retention_degraded");
    } finally {
      await app.close();
    }
  });

  it("returns a terminal expired response without export metadata", async () => {
    const { app, artifacts } = await fixture();
    artifacts.managedExportStatus = "expired";
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(response.statusCode, 410);
      assert.equal(response.json().error.code, "evidence_expired");
      assert.equal("exportId" in response.json(), false);
      assert.equal("manifestFileSha256" in response.json(), false);
      assert.deepEqual(artifacts.managedExportRequests, [{
        lookup: { sessionId: SESSION_ID },
        commandId: COMMAND_ID,
        authority: {
          kind: "retention_owner",
          actorId: "customer-retention-owner",
        },
        requestedAtMs: artifacts.managedExportRequests[0]?.requestedAtMs,
      }]);
      assert.equal(typeof artifacts.managedExportRequests[0]?.requestedAtMs, "number");
    } finally {
      await app.close();
    }
  });

  it("maps unrepresented retention management outcomes to safe public responses", async () => {
    const cases: ReadonlyArray<Readonly<{
      name: string;
      configure: (artifacts: FakeRetentionArtifacts) => void;
      configureReview?: (evidenceReview: FakeEvidenceReview) => void;
      request: Readonly<{
        method: "GET" | "POST" | "DELETE";
        url: string;
        payload?: object;
      }>;
      expectedStatusCode: number;
      expectedBody: object;
    }>> = [
      {
        name: "an unavailable sealed retention review",
        configure: () => {},
        configureReview: (evidenceReview) => {
          evidenceReview.result = { status: "not_found" };
        },
        request: {
          method: "GET",
          url: "/api/sessions/" + SESSION_ID + "/evidence/retention",
        },
        expectedStatusCode: 404,
        expectedBody: {
          error: {
            code: "evidence_not_found",
            message: "Evidence was not found",
          },
        },
      },
      {
        name: "a rejected retention extension",
        configure: (artifacts) => {
          artifacts.extensionResult = { status: "rejected" };
        },
        request: {
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
          payload: {
            commandId: COMMAND_ID,
            reason: "Required for the scheduled customer review",
            requestedDeadline: "2026-08-30T12:00:00Z",
          },
        },
        expectedStatusCode: 422,
        expectedBody: {
          error: {
            code: "retention_extension_rejected",
            message: "The retention extension was rejected",
          },
        },
      },
      {
        name: "a pending evidence deletion",
        configure: (artifacts) => {
          artifacts.deletionResult = { status: "pending" };
        },
        request: {
          method: "DELETE",
          url: "/api/sessions/" + SESSION_ID + "/evidence",
          payload: {
            commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
            reason: "Customer requested early deletion",
          },
        },
        expectedStatusCode: 202,
        expectedBody: { status: "pending" },
      },
      {
        name: "a conflicting evidence deletion",
        configure: (artifacts) => {
          artifacts.deletionResult = { status: "conflict" };
        },
        request: {
          method: "DELETE",
          url: "/api/sessions/" + SESSION_ID + "/evidence",
          payload: {
            commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
            reason: "Customer requested early deletion",
          },
        },
        expectedStatusCode: 409,
        expectedBody: {
          error: {
            code: "idempotency_conflict",
            message: "A different command already uses this commandId",
          },
        },
      },
      {
        name: "a missing evidence deletion",
        configure: (artifacts) => {
          artifacts.deletionResult = { status: "not_found" };
        },
        request: {
          method: "DELETE",
          url: "/api/sessions/" + SESSION_ID + "/evidence",
          payload: {
            commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
            reason: "Customer requested early deletion",
          },
        },
        expectedStatusCode: 404,
        expectedBody: {
          error: {
            code: "evidence_not_found",
            message: "Evidence was not found",
          },
        },
      },
      {
        name: "a conflicting managed export",
        configure: (artifacts) => {
          artifacts.managedExportStatus = "conflict";
        },
        request: {
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
          payload: {
            commandId: COMMAND_ID,
            acknowledgePlaintextExport: true,
          },
        },
        expectedStatusCode: 409,
        expectedBody: {
          error: {
            code: "idempotency_conflict",
            message: "A different command already uses this commandId",
          },
        },
      },
      {
        name: "a missing managed export",
        configure: (artifacts) => {
          artifacts.managedExportStatus = "not_found";
        },
        request: {
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
          payload: {
            commandId: COMMAND_ID,
            acknowledgePlaintextExport: true,
          },
        },
        expectedStatusCode: 404,
        expectedBody: {
          error: {
            code: "evidence_not_found",
            message: "Evidence was not found",
          },
        },
      },
      {
        name: "an audit-failed managed export",
        configure: (artifacts) => {
          artifacts.managedExportStatus = "audit_failed";
        },
        request: {
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/exports",
          payload: {
            commandId: COMMAND_ID,
            acknowledgePlaintextExport: true,
          },
        },
        expectedStatusCode: 503,
        expectedBody: {
          error: {
            code: "evidence_audit_failed",
            message: "Evidence audit verification failed",
          },
        },
      },
      {
        name: "a missing retention extension",
        configure: (artifacts) => {
          artifacts.extensionResult = { status: "not_found" };
        },
        request: {
          method: "POST",
          url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
          payload: {
            commandId: COMMAND_ID,
            reason: "Required for the scheduled customer review",
            requestedDeadline: "2026-08-30T12:00:00Z",
          },
        },
        expectedStatusCode: 404,
        expectedBody: {
          error: {
            code: "evidence_not_found",
            message: "Evidence was not found",
          },
        },
      },
    ];

    for (const outcome of cases) {
      const evidenceReview = new FakeEvidenceReview();
      const { app, artifacts } = await fixtureWithArtifacts(
        new FakeRetentionArtifacts(),
        undefined,
        undefined,
        evidenceReview,
      );
      outcome.configure(artifacts);
      outcome.configureReview?.(evidenceReview);
      try {
        const response = await app.inject({
          method: outcome.request.method,
          url: outcome.request.url,
          headers: OWNER_HEADERS,
          ...(outcome.request.payload === undefined ? {} : { payload: outcome.request.payload }),
        });
        assert.equal(response.statusCode, outcome.expectedStatusCode, outcome.name);
        assert.deepEqual(response.json(), outcome.expectedBody, outcome.name);
        assert.equal(response.headers["cache-control"], "no-store", outcome.name);
        assert.doesNotMatch(response.body, /archive|path|owner|reason|receipt|export/iu, outcome.name);
      } finally {
        await app.close();
      }
    }
  });

  it("returns only managed export metadata after a data owner exports sealed evidence", async () => {
    const sealed = await createSealedArtifacts();
    const { app } = await fixtureWithArtifacts(sealed.artifacts);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + sealed.sessionId + "/evidence/exports",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "3e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          acknowledgePlaintextExport: true,
        },
      });
      assert.equal(response.statusCode, 200);
      const payload = response.json();
      assert.deepEqual(Object.keys(payload).sort(), [
        "evidenceSealSha256",
        "exportId",
        "finalChainSha256",
        "finalizationManifestSha256",
        "manifestFileSha256",
        "processingManifestSha256",
        "recordCount",
        "retentionDeadlineAt",
        "status",
        "trackDigests",
      ]);
      assert.equal(payload.status, "completed");
      assert.match(payload.exportId, /^[a-f0-9]{64}$/u);
      assert.equal(payload.retentionDeadlineAt, sealed.retentionDeadlineAt);
      assert.doesNotMatch(response.body, new RegExp(sealed.sessionId, "u"));
      assert.doesNotMatch(response.body, new RegExp(sealed.root.replace(/[\\/]/gu, "[\\\\/]"), "u"));
      assert.equal("archiveId" in payload, false);
      assert.equal("plaintext" in payload, false);
    } finally {
      await app.close();
    }
  });

  it("holds the server evidence-root lease from recovery through orderly shutdown", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const { app } = await fixtureWithArtifacts(artifacts);
    try {
      assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, ["server"]);
      assert.deepEqual(artifacts.lifecycleCalls, ["lease:server", "recover", "sweep"]);
      assert.equal(artifacts.releasedEvidenceRootLeases, 0);
    } finally {
      await app.close();
    }
    assert.equal(artifacts.releasedEvidenceRootLeases, 1);
    assert.deepEqual(artifacts.lifecycleCalls, [
      "lease:server",
      "recover",
      "sweep",
      "release:server",
    ]);
  });

  it("holds the glossary root lease from startup through orderly shutdown", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const glossaries = new TrackingGlossaryRegistry();
    const { app } = await fixtureWithArtifacts(artifacts, undefined, glossaries);
    try {
      assert.deepEqual(glossaries.lifecycleCalls, ["lease"]);
    } finally {
      await app.close();
    }
    assert.deepEqual(glossaries.lifecycleCalls, ["lease", "release"]);
  });

  it("fails closed before plugin initialization when the glossary root lease is unavailable", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const glossaries = new TrackingGlossaryRegistry();
    glossaries.rootLeaseError = new Error("Glossary root is leased by another process");
    await assert.rejects(
      fixtureWithArtifacts(artifacts, undefined, glossaries),
      /Glossary root is leased by another process/u,
    );
    assert.deepEqual(glossaries.lifecycleCalls, ["lease"]);
    assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, []);
    assert.equal(artifacts.recoverCalls, 0);
  });

  it("fails closed before recovery when the server evidence-root lease is unavailable", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const glossaries = new TrackingGlossaryRegistry();
    artifacts.evidenceRootLeaseError = new Error("Evidence root is leased by another process");
    await assert.rejects(
      fixtureWithArtifacts(artifacts, undefined, glossaries),
      /Evidence root is leased by another process/u,
    );
    assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, ["server"]);
    assert.equal(artifacts.recoverCalls, 0);
    assert.equal(artifacts.sweepCalls, 0);
    assert.equal(artifacts.releasedEvidenceRootLeases, 0);
    assert.deepEqual(glossaries.lifecycleCalls, ["lease", "release"]);
  });

  it("releases the server evidence-root lease when artifact recovery throws", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const glossaries = new TrackingGlossaryRegistry();
    artifacts.recoveryError = new Error("disk unreadable");
    await assert.rejects(
      fixtureWithArtifacts(artifacts, undefined, glossaries),
      /Evidence artifact recovery failed/u,
    );
    assert.deepEqual(artifacts.lifecycleCalls, ["lease:server", "recover", "release:server"]);
    assert.equal(artifacts.releasedEvidenceRootLeases, 1);
    assert.equal(artifacts.sweepCalls, 0);
    assert.deepEqual(glossaries.lifecycleCalls, ["lease", "release"]);
  });

  it("does not acquire the server evidence-root lease when the static plugin cannot initialize", async () => {
    const artifacts = new FakeRetentionArtifacts();
    await assert.rejects(fixtureWithArtifacts(artifacts, join(process.cwd(), "package.json")));
    assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, []);
    assert.equal(artifacts.recoverCalls, 0);
    assert.equal(artifacts.releasedEvidenceRootLeases, 0);
  });

  it("releases the glossary root lease when the static plugin cannot initialize", async () => {
    const artifacts = new FakeRetentionArtifacts();
    const glossaries = new TrackingGlossaryRegistry();
    await assert.rejects(
      fixtureWithArtifacts(artifacts, join(process.cwd(), "package.json"), glossaries),
    );
    assert.deepEqual(glossaries.lifecycleCalls, ["lease", "release"]);
    assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, []);
    assert.equal(artifacts.recoverCalls, 0);
  });

  it("fails startup before serving when encrypted artifact recovery is degraded", async () => {
    const artifacts = new FakeRetentionArtifacts();
    artifacts.recoveryResult = {
      status: "degraded",
      health: "degraded",
      recoveredDeletions: 0,
      sealedArtifacts: 0,
      finalizationFailures: 0,
      orphanedActiveArtifacts: 0,
    };
    await assert.rejects(
      fixtureWithArtifacts(artifacts),
      /Evidence artifact recovery failed/u,
    );
    assert.deepEqual(artifacts.acquiredEvidenceRootLeaseRoles, ["server"]);
    assert.equal(artifacts.releasedEvidenceRootLeases, 1);
    assert.equal(artifacts.recoverCalls, 1);
    assert.equal(artifacts.sweepCalls, 0);
  });

  it("starts degraded and keeps only owner deletion available after finalization failures", async () => {
    const artifacts = new FakeRetentionArtifacts();
    artifacts.recoveryResult = {
      status: "completed",
      health: "healthy",
      recoveredDeletions: 0,
      sealedArtifacts: 0,
      finalizationFailures: 1,
      orphanedActiveArtifacts: 0,
    };
    const { app } = await fixtureWithArtifacts(artifacts);
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.equal(health.json().status, "degraded");
      assert.equal(health.json().retention.health, "degraded");

      const review = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/review",
        headers: OWNER_HEADERS,
        payload: {},
      });
      assert.equal(review.statusCode, 503);
      assert.equal(review.json().error.code, "retention_degraded");

      const deletion = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          reason: "Customer requested early deletion",
        },
      });
      assert.equal(deletion.statusCode, 200);
      assert.equal(artifacts.deletionRequests.length, 1);
    } finally {
      await app.close();
    }
    assert.equal(artifacts.recoverCalls, 1);
  });

  it("does not delete unfinalized evidence when the management port rejects it", async () => {
    const { app, artifacts } = await fixture();
    artifacts.deletionResult = { status: "rejected" };
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/sessions/" + SESSION_ID + "/evidence",
        headers: OWNER_HEADERS,
        payload: {
          commandId: "9e1433e2-c480-45e9-bcbb-03ee6c3614cd",
          reason: "Customer requested early deletion",
        },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, "evidence_not_finalized");
      assert.equal(artifacts.deletionRequests.length, 1);
    } finally {
      await app.close();
    }
  });

  it("returns a conflict for a reused retention extension command", async () => {
    const { app, artifacts } = await fixture();
    artifacts.extensionResult = { status: "conflict" };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/" + SESSION_ID + "/evidence/retention/extensions",
        headers: OWNER_HEADERS,
        payload: {
          commandId: COMMAND_ID,
          reason: "Required for the scheduled customer review",
          requestedDeadline: "2026-08-30T12:00:00Z",
        },
      });
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().error.code, "idempotency_conflict");
      assert.equal(artifacts.extensionRequests.length, 1);
    } finally {
      await app.close();
    }
  });
});

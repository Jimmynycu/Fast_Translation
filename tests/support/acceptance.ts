import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  ArtifactRecoveryResult,
  EvidenceDeleteRequest,
  EvidenceDeletionResult,
  EvidenceRootLeaseRole,
  EvidenceRootProcessLease,
  ManagedEvidenceExportLease,
  ManagedEvidenceExportLeaseCompletion,
  ManagedEvidenceExportLeaseRequest,
  ManagedEvidenceExportLeaseResult,
  RetentionExtensionRequest,
  RetentionExtensionResult,
  RetentionSweepHealth,
  RetentionSweepResult,
  SessionArtifactDescriptor,
  SessionArtifactLookup,
  SessionArtifactManagementPort,
  SessionRetentionStatus,
} from "../../src/adapters/evidence/session-artifact-store.js";
import type {
  EvidenceReview,
  EvidenceReviewRequest,
  EvidenceReviewResult,
} from "../../src/adapters/evidence/review.js";
import { FakeTelephonyMediaPort } from "../../src/adapters/media/fake-telephony.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../../src/core/audio.js";
import {
  canonicalJsonSha256,
  validateApprovedSessionProcessingProfile,
  type ApprovedSessionProcessingProfile,
  type ContractEvidenceReference,
  type ExternalAssurance,
} from "../../src/core/processing-profile.js";
import { ModularGuardedDuplexRelay } from "../../src/core/relay.js";
import { resolveTranslationBehavior } from "../../src/core/translation-behavior.js";
import { createSyntheticPocProcessingProfile } from "../../src/local-eval/synthetic-poc-processing-manifest.js";
import { createMediaRuntime } from "../../src/media-runtime.js";
import { createServerAccessControl } from "../../src/server/access.js";
import {
  createServerApp,
  type GlossaryRegistry,
} from "../../src/server/app.js";
import type {
  AudioFrame,
  EvidencePort,
  EvidenceRecord,
  EvidenceAudioTrack,
  EvidenceFinalization,
  EvidenceFinalizeRequest,
  GenerationRef,
  Lane,
  LaneContext,
  RecorderPreflightRequest,
  RecorderPreflightResult,
  TranslationCapabilities,
  TranslationEvent,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
} from "../../src/core/types.js";

/**
 * The product modes are exercised against the same deterministic adapter. This
 * is intentionally a mechanism test surface, never a claim about a live
 * provider.
 */
export const ACCEPTANCE_MODES = ["fast", "balanced", "accurate"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];

const SYNTHETIC_EVIDENCE_SHA256 = createHash("sha256")
  .update("synthetic-acceptance-evidence-v1")
  .digest("hex");
export const SYNTHETIC_DEPLOYMENT_BUILD_SHA256 = "d".repeat(64);
const SYNTHETIC_EVIDENCE_TRACKS = [
  "source_a",
  "source_b",
  "playout_to_a",
  "playout_to_b",
] as const;
const RETENTION_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
const TEST_ONLY_ASSURANCE_SHA256 = "e".repeat(64);
const TEST_ONLY_APPROVED_AT_UTC = "2026-08-09T00:00:00.000Z";

function testOnlyEvidenceReference(subject: string): ContractEvidenceReference {
  return Object.freeze({
    id: "urn:test-only:" + subject,
    revision: "test-fixture-v1",
    sha256: TEST_ONLY_ASSURANCE_SHA256,
    approvedBy: "test-fixture@example.test",
    approvedAtUtc: TEST_ONLY_APPROVED_AT_UTC,
  });
}

function testOnlyVerifiedAssurance<T>(value: T, subject: string): ExternalAssurance<T> {
  return Object.freeze({
    status: "verified" as const,
    value,
    evidenceRef: testOnlyEvidenceReference(subject),
  });
}

const TEST_ONLY_VERIFIED_HUMAN_SESSION_PROFILE: ApprovedSessionProcessingProfile = (() => {
  const { sha256: _syntheticSha256, ...synthetic } = createSyntheticPocProcessingProfile();
  const body = {
    ...synthetic,
    id: "test-only-verified-human-session",
    version: "2026-08-09-test-only",
    services: Object.freeze(synthetic.services.map((service) => Object.freeze({
      ...service,
      trainingUse: testOnlyVerifiedAssurance(
        "no_training" as const,
        service.id + ":training-use",
      ),
      serviceRetention: testOnlyVerifiedAssurance(
        { kind: "zero_retention" } as const,
        service.id + ":service-retention",
      ),
    }))),
    approval: Object.freeze({
      approvalId: "test-only-human-session-admission",
      approvedBy: "test-fixture@example.test",
      approvedAtUtc: TEST_ONLY_APPROVED_AT_UTC,
    }),
  } satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;
  return Object.freeze({
    ...body,
    sha256: canonicalJsonSha256(body),
  });
})();

const TEST_ONLY_VERIFIED_HUMAN_SESSION_VALIDATION = validateApprovedSessionProcessingProfile(
  TEST_ONLY_VERIFIED_HUMAN_SESSION_PROFILE,
);

if (
  TEST_ONLY_VERIFIED_HUMAN_SESSION_PROFILE.services.some((service) =>
    service.trainingUse.status !== "verified" || service.serviceRetention.status !== "verified"
  ) ||
  TEST_ONLY_VERIFIED_HUMAN_SESSION_VALIDATION.acceptanceImpact !== "NOT_RUN"
) {
  throw new Error("Test-only human-session profile must verify only the admission assurances");
}

/**
 * Test-only positive fixture for server admission with injected local adapters.
 * Its urn:test-only evidence references are never a deployment, CLI, benchmark,
 * or product-acceptance claim.
 */
export function createTestOnlyVerifiedHumanSessionProcessingProfile(): ApprovedSessionProcessingProfile {
  return TEST_ONLY_VERIFIED_HUMAN_SESSION_PROFILE;
}

interface DeferredGate {
  readonly reached: Promise<void>;
  readonly markReached: () => void;
  readonly release: () => void;
  readonly wait: Promise<void>;
}

function deferredGate(): DeferredGate {
  let markReached!: () => void;
  let openGate!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    reached,
    markReached,
    release: openGate,
    wait,
  };
}

function acceptanceCapabilities(): TranslationCapabilities {
  return Object.freeze({
    providerId: "openai_controlled",
    modes: Object.freeze(ACCEPTANCE_MODES.map((mode) => {
      const behavior = resolveTranslationBehavior(mode);
      return Object.freeze({
        mode,
        behaviorVersion: behavior.version,
        state: "locally_controlled" as const,
        deterministicGlossary: false,
      });
    })),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  });
}

export function acceptanceServerTranslation(
  defaultMode: AcceptanceMode = "balanced",
): TranslationCapabilities & Readonly<{ defaultMode: AcceptanceMode }> {
  return Object.freeze({ ...acceptanceCapabilities(), defaultMode });
}

const emptyGlossaries: GlossaryRegistry = Object.freeze({
  async acquireRootLease() {
    return Object.freeze({
      async release(): Promise<void> {},
    });
  },
  async importFile() {
    throw new Error("The keyless acceptance harness does not import glossaries");
  },
  async acquire() {
    return undefined;
  },
  async deleteVersion() {
    throw new Error("The keyless acceptance harness does not delete glossaries");
  },
});

/**
 * Keyless acceptance never creates a sealed artifact review lease. It returns
 * the same generic absence result as the production review boundary without
 * pretending its in-memory relay evidence is reviewable.
 */
const keylessEvidenceReview = Object.freeze({
  async review(_request: EvidenceReviewRequest): Promise<EvidenceReviewResult> {
    return Object.freeze({ status: "not_found" as const });
  },
} satisfies Pick<EvidenceReview, "review">);

/**
 * Deterministic test-only adapter. It deliberately emits a post-cancellation
 * event when held so acceptance tests prove that the relay, not an adapter,
 * owns the generation fence.
 */
export class DeterministicAcceptanceTranslation implements TranslationPort {
  readonly capabilities = acceptanceCapabilities();
  readonly prepared: LaneContext[] = [];
  readonly requests: LaneContext[] = [];
  readonly receivedFrames: AudioFrame[] = [];
  readonly cancelled: GenerationRef[] = [];
  readonly closedSessionIds: string[] = [];
  readonly #nextFrameGate = new Map<Lane, DeferredGate>();
  readonly #heldFrameGate = new Map<Lane, DeferredGate>();

  holdNextFrame(lane: Lane): void {
    if (this.#nextFrameGate.has(lane)) {
      throw new Error("A deterministic acceptance gate is already armed for " + lane);
    }
    this.#nextFrameGate.set(lane, deferredGate());
  }

  async waitForHeldFrame(lane: Lane): Promise<void> {
    const gate = this.#heldFrameGate.get(lane) ?? this.#nextFrameGate.get(lane);
    if (gate === undefined) throw new Error("No deterministic acceptance gate is armed for " + lane);
    await gate.reached;
  }

  releaseHeldFrame(lane: Lane): void {
    const gate = this.#heldFrameGate.get(lane) ?? this.#nextFrameGate.get(lane);
    if (gate === undefined) throw new Error("No deterministic acceptance gate is armed for " + lane);
    this.#heldFrameGate.delete(lane);
    this.#nextFrameGate.delete(lane);
    gate.release();
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    this.prepared.push(structuredClone(context));
    return Object.freeze({
      readiness: "fixture_local" as const,
      remoteConnection: "not_applicable" as const,
    });
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    this.requests.push(structuredClone(request.context));
    const buffered: AudioFrame[] = [];
    let ordinal = 0;

    for await (const frame of request.frames) {
      const canonical = createAudioFrame({
        ...frame,
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
      });
      this.receivedFrames.push(canonical);
      const gate = this.#nextFrameGate.get(request.context.lane);
      if (gate !== undefined) {
        this.#nextFrameGate.delete(request.context.lane);
        this.#heldFrameGate.set(request.context.lane, gate);
        // The gate is intentionally released after relay cancellation in the
        // stale-generation test, so this adapter may emit a late provider event.
        // That verifies the relay fence rather than adapter co-operation.
        gate.markReached();
        await gate.wait;
        this.#heldFrameGate.delete(request.context.lane);
      }
      if (request.context.behavior.inputCommit === "speech_end") {
        buffered.push(canonical);
        continue;
      }
      yield* this.#eventsForFrame(request.context, canonical, ordinal);
      ordinal += 1;
    }

    for (const frame of buffered) {
      yield* this.#eventsForFrame(request.context, frame, ordinal);
      ordinal += 1;
    }
    yield this.#completed(request.context, ordinal);
  }

  async cancel(generation: GenerationRef): Promise<void> {
    this.cancelled.push(structuredClone(generation));
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closedSessionIds.push(sessionId);
  }

  *#eventsForFrame(
    context: LaneContext,
    frame: AudioFrame,
    ordinal: number,
  ): Iterable<TranslationEvent> {
    const prefix = context.turnId + ":" + ordinal;
    const evidenceRef = "acceptance:" + prefix;
    const source = "[" + context.behavior.mode + " source " + context.lane + " " + ordinal + "]";
    const target = "[" + context.behavior.mode + " target " + context.lane + " " + ordinal + "]";
    const base = {
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      evidenceRef,
      emittedAtMs: performance.now(),
    } as const;

    if (context.behavior.transcriptPolicy === "provisional_revisions") {
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 0,
        finality: "provisional",
        text: source + " draft",
      };
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 1,
        finality: "final",
        text: source + " replacement",
      };
      // A provider must not be able to revise a terminal segment. The relay
      // must discard this deliberately invalid late revision.
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 2,
        finality: "provisional",
        text: source + " rejected-after-final",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 0,
        finality: "provisional",
        text: target + " draft",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 1,
        finality: "final",
        text: target + " replacement",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 2,
        finality: "provisional",
        text: target + " rejected-after-final",
      };
    } else {
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 0,
        finality: "final",
        text: source,
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 0,
        finality: "final",
        text: target,
      };
    }

    yield {
      ...base,
      kind: "audio",
      segmentId: prefix + ":audio",
      targetSegmentId: prefix + ":target",
      revision: context.behavior.transcriptPolicy === "provisional_revisions" ? 1 : 0,
      finality: "final",
      playoutSequence: ordinal,
      frame,
    };
  }

  #completed(context: LaneContext, ordinal: number): TranslationEvent {
    return {
      kind: "completed",
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      segmentId: context.turnId + ":completed",
      revision: ordinal,
      finality: "final",
      evidenceRef: "acceptance:" + context.turnId + ":completed",
      emittedAtMs: performance.now(),
    };
  }
}

/**
 * Synthetic lifecycle fake for keyless acceptance. Its opaque receipts prove
 * ordering only; it does not emulate or claim production evidence storage.
 */
export class AcceptanceEvidence implements EvidencePort {
  readonly records: EvidenceRecord[] = [];
  readonly #preflights = new Map<
    string,
    Extract<RecorderPreflightResult, { readonly status: "ready" }>
  >();
  readonly #finalizations = new Map<string, EvidenceFinalization>();

  async persist(record: EvidenceRecord): Promise<void> {
    if (this.#finalizations.has(record.sessionId)) {
      throw new Error("Cannot persist synthetic evidence after finalization");
    }
    this.records.push(structuredClone(record));
  }

  async preflightRecorder(
    request: RecorderPreflightRequest,
  ): Promise<RecorderPreflightResult> {
    const existing = this.#preflights.get(request.sessionId);
    if (existing !== undefined) {
      if (existing.processingManifestSha256 === request.processingManifestSha256) return existing;
      return Object.freeze({
        status: "failed" as const,
        sessionId: request.sessionId,
        processingManifestSha256: request.processingManifestSha256,
        checkedAtMonoMs: request.checkedAtMonoMs,
        failureCode: "evidence_preflight_integrity_failed" as const,
      });
    }
    const preflight = Object.freeze({
      status: "ready" as const,
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      preflightId: "synthetic-acceptance-preflight:" + request.sessionId,
      checkedAtMonoMs: request.checkedAtMonoMs,
      requiredFreeBytes: "0",
      availableFreeBytes: "0",
      tracks: SYNTHETIC_EVIDENCE_TRACKS,
      manifestSha256: SYNTHETIC_EVIDENCE_SHA256,
      encryptedSpoolSha256: SYNTHETIC_EVIDENCE_SHA256,
      sealedRecordCount: Math.max(1, this.records.filter((record) => record.sessionId === request.sessionId).length),
      sealSha256: SYNTHETIC_EVIDENCE_SHA256,
    });
    this.#preflights.set(request.sessionId, preflight);
    return preflight;
  }

  async flush(_sessionId: string): Promise<void> {}

  async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    const existing = this.#finalizations.get(request.sessionId);
    if (existing !== undefined) return existing;

    const preflight = this.#preflights.get(request.sessionId);
    if (
      preflight === undefined ||
      preflight.processingManifestSha256 !== request.processingManifestSha256
    ) {
      return Object.freeze({
        status: "FINALIZATION_FAILED" as const,
        sessionId: request.sessionId,
        processingManifestSha256: request.processingManifestSha256,
        failureCode: "integrity_verification_failed" as const,
        recovery: "rebuild_from_spool" as const,
      });
    }

    const recordCount = this.records.filter((record) => record.sessionId === request.sessionId).length;
    if (recordCount === 0) {
      return Object.freeze({
        status: "FINALIZATION_FAILED" as const,
        sessionId: request.sessionId,
        processingManifestSha256: request.processingManifestSha256,
        failureCode: "integrity_verification_failed" as const,
        recovery: "rebuild_from_spool" as const,
      });
    }

    const finalization: EvidenceFinalization = Object.freeze({
      status: "sealed" as const,
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      manifestSha256: SYNTHETIC_EVIDENCE_SHA256,
      encryptedLedgerSha256: SYNTHETIC_EVIDENCE_SHA256,
      finalChainSha256: SYNTHETIC_EVIDENCE_SHA256,
      recordCount,
      finalizedAtUtc: new Date(request.finalizedAtMonoMs).toISOString(),
      retentionDeadlineAt: new Date(request.finalizedAtMonoMs + RETENTION_DURATION_MS).toISOString(),
      tracks: this.#trackDigests(request.sessionId),
    });
    this.#finalizations.set(request.sessionId, finalization);
    return finalization;
  }

  audioTracks(sessionId: string): readonly EvidenceAudioTrack[] {
    return Object.freeze([
      ...new Set(this.records
        .filter((record): record is Extract<EvidenceRecord, { type: "audio" }> =>
          record.type === "audio" && record.sessionId === sessionId
        )
        .map((record) => record.track)),
    ].sort());
  }

  #trackDigests(sessionId: string) {
    return Object.freeze({
      source_a: this.#trackDigest(sessionId, "source_a"),
      source_b: this.#trackDigest(sessionId, "source_b"),
      playout_to_a: this.#trackDigest(sessionId, "playout_to_a"),
      playout_to_b: this.#trackDigest(sessionId, "playout_to_b"),
    });
  }

  #trackDigest(sessionId: string, track: EvidenceAudioTrack) {
    const records = this.records.filter((record): record is Extract<EvidenceRecord, { type: "audio" }> =>
      record.type === "audio" && record.sessionId === sessionId && record.track === track
    );
    return Object.freeze({
      sha256: SYNTHETIC_EVIDENCE_SHA256,
      frameCount: records.length,
      byteCount: records.reduce((total, record) => total + record.frame.pcm16le.byteLength, 0),
    });
  }
}

/**
 * Keyless test-only management boundary. It supplies the no-op in-process
 * root lease required for app startup, but rejects artifact, evidence,
 * retention, and export operations so it cannot be mistaken for production
 * storage or cross-process ownership.
 */
export class KeylessArtifactManagement implements SessionArtifactManagementPort {
  async persist(_record: EvidenceRecord): Promise<void> {
    return this.#unsupported("persist");
  }

  async flush(_sessionId: string): Promise<void> {
    return this.#unsupported("flush");
  }

  async preflightRecorder(_request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    return this.#unsupported("preflightRecorder");
  }

  async finalize(_request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    return this.#unsupported("finalize");
  }

  async artifact(_lookup: SessionArtifactLookup): Promise<SessionArtifactDescriptor | undefined> {
    return this.#unsupported("artifact");
  }

  async getRetention(_sessionId: string): Promise<SessionRetentionStatus | undefined> {
    return this.#unsupported("getRetention");
  }

  async extendRetention(_request: RetentionExtensionRequest): Promise<RetentionExtensionResult> {
    return this.#unsupported("extendRetention");
  }

  async deleteEvidence(_request: EvidenceDeleteRequest): Promise<EvidenceDeletionResult> {
    return this.#unsupported("deleteEvidence");
  }

  getRetentionSweepHealth(): RetentionSweepHealth {
    return Object.freeze({ health: "healthy" as const });
  }

  async recover(): Promise<ArtifactRecoveryResult> {
    return Object.freeze({
      status: "completed" as const,
      health: "healthy" as const,
      recoveredDeletions: 0,
      sealedArtifacts: 0,
      finalizationFailures: 0,
      orphanedActiveArtifacts: 0,
    });
  }

  async sweepExpired(): Promise<RetentionSweepResult> {
    return Object.freeze({
      status: "completed" as const,
      health: "healthy" as const,
      expiredArtifactsDeleted: 0,
    });
  }

  async acquireEvidenceRootLease(role: EvidenceRootLeaseRole): Promise<EvidenceRootProcessLease> {
    return Object.freeze({
      role,
      async release(): Promise<void> {},
    });
  }

  async withManagedExportLease<T>(
    _request: ManagedEvidenceExportLeaseRequest,
    _transaction: (
      lease: ManagedEvidenceExportLease,
    ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
  ): Promise<ManagedEvidenceExportLeaseResult<T>> {
    return this.#unsupported("withManagedExportLease");
  }

  #unsupported(operation: string): never {
    throw new Error(`Keyless artifact management does not support ${operation}`);
  }
}

/**
 * Direct-port fixture for deterministic relay acceptance. It keeps the
 * provider, evidence, and media entirely in-process so no live provider key
 * or encrypted evidence key is needed.
 */
export function createKeylessTelephonyAcceptanceFixture(): Readonly<{
  readonly media: FakeTelephonyMediaPort;
  readonly translation: DeterministicAcceptanceTranslation;
  readonly evidence: AcceptanceEvidence;
  readonly relay: ModularGuardedDuplexRelay;
}> {
  const media = new FakeTelephonyMediaPort();
  const translation = new DeterministicAcceptanceTranslation();
  const evidence = new AcceptanceEvidence();
  const relay = new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    processingProfile: createSyntheticPocProcessingProfile(),
    endpointGrant: (sessionId, side) => ({
      kind: "telephony_test",
      side,
      address: "acceptance-telephony://" + encodeURIComponent(sessionId) + "/" + side,
    }),
  });
  return Object.freeze({ media, translation, evidence, relay });
}

/**
 * Real HTTP/WebSocket fixture backed by the same deterministic translation
 * port. The generated token authenticates only this process and is never a
 * provider credential.
 */
export async function createKeylessBrowserAcceptanceApplication(
  origin: string,
  defaultMode: AcceptanceMode = "fast",
  processingProfile: ApprovedSessionProcessingProfile = createTestOnlyVerifiedHumanSessionProcessingProfile(),
) {
  const operatorToken = "acceptance-" + randomUUID() + randomUUID();
  const access = createServerAccessControl({
    operatorToken,
    retentionOwner: {
      id: "test-data-owner",
      token: "acceptance-retention-owner-token-0123456789abcdef",
    },
    evidenceReviewer: {
      id: "test-bilingual-reviewer",
      token: "acceptance-evidence-reviewer-token-0123456789abcdef",
    },
  });
  const mediaRuntime = createMediaRuntime({
    profile: "browser_pair",
    publicBaseUrl: new URL(origin),
    access,
  });
  if (mediaRuntime.browserGateway === undefined) {
    throw new Error("The browser acceptance fixture requires a browser media gateway");
  }
  const translation = new DeterministicAcceptanceTranslation();
  const evidence = new AcceptanceEvidence();
  const artifacts = new KeylessArtifactManagement();
  const relay = new ModularGuardedDuplexRelay({
    media: mediaRuntime.port,
    translation,
    evidence,
    processingProfile,
    endpointGrant: mediaRuntime.endpointGrant,
  });
  const app = await createServerApp({
    relay,
    glossaries: emptyGlossaries,
    mediaProfile: "browser_pair",
    browserMedia: mediaRuntime.browserGateway,
    access,
    translation: acceptanceServerTranslation(defaultMode),
    processingProfile,
    deploymentBuildSha256: SYNTHETIC_DEPLOYMENT_BUILD_SHA256,
    artifacts,
    evidenceReview: keylessEvidenceReview,
    logger: false,
  });
  return Object.freeze({
    app,
    access,
    operatorToken,
    media: mediaRuntime.browserGateway,
    translation,
    evidence,
    relay,
  });
}

export async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

export function acceptanceTemporaryDirectory(name: string): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "acceptance-harness",
    name + "-" + randomUUID(),
  );
}

export function canonicalWav(frameCount = 2): Uint8Array {
  const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * frameCount);
  const pcmView = new DataView(pcm.buffer);
  for (let sample = 0; sample < pcm.byteLength / 2; sample += 1) {
    pcmView.setInt16(sample * 2, Math.round(Math.sin(sample / 12) * 3_000), true);
  }

  const wav = new Uint8Array(44 + pcm.byteLength);
  const buffer = Buffer.from(wav.buffer);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcm.byteLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz, 24);
  buffer.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

export function localEvalManifest(wav: Uint8Array): Readonly<Record<string, unknown>> {
  const wavSha256 = createHash("sha256").update(wav).digest("hex");
  const sourceGlossary = "id,source,target_exact\nacceptance-term,acceptance term,驗收術語\n";
  return Object.freeze({
    schemaVersion: 3,
    generatedAtUtc: "2026-08-09T00:00:00.000Z",
    generator: "acceptance-harness",
    voice: "deterministic test tone",
    language: "en-US",
    audio: {
      container: "wav",
      encoding: "pcm_s16le",
      sampleRateHz: CANONICAL_AUDIO.sampleRateHz,
      channels: CANONICAL_AUDIO.channels,
      bitsPerSample: 16,
    },
    sourceGlossary: "acceptance-terms.csv",
    sourceGlossarySha256: createHash("sha256").update(sourceGlossary).digest("hex"),
    fixtures: [{
      fixtureId: "acceptance-source-public",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "source",
      visibility: "public",
      expectation: "target_exact_present",
      phrase: "acceptance term",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-reverse-public",
      entryId: "acceptance-term",
      direction: "B_TO_A",
      phraseKind: "source",
      visibility: "public",
      expectation: "target_exact_present",
      phrase: "驗收術語",
      targetExact: "acceptance term",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-alias-holdout",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "alias",
      visibility: "holdout",
      expectation: "target_exact_present",
      phrase: "acceptance expression",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-confuser-holdout",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "confuser",
      visibility: "holdout",
      expectation: "target_exact_absent",
      phrase: "unrelated expression",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }],
  });
}

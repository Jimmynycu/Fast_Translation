import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type {
  EvidenceRootProcessLease,
  SessionArtifactStore,
} from "../src/adapters/evidence/session-artifact-store.js";
import { createServerAccessControl } from "../src/server/access.js";
import { createAudioFrame } from "../src/core/audio.js";
import { AsyncQueue } from "../src/core/async-queue.js";
import { compileGlossaryPair } from "../src/core/glossary.js";
import { ModularGuardedDuplexRelay, RelaySessionError } from "../src/core/relay.js";
import {
  createSyntheticPocProcessingManifest,
  createSyntheticPocProcessingProfile,
} from "../src/local-eval/synthetic-poc-processing-manifest.js";
import { EVIDENCE_AUDIO_TRACKS } from "../src/core/types.js";
import type {
  AudioFrame,
  EvidenceFinalization,
  EvidenceFinalizeRequest,
  EvidenceReviewGrant,
  EvidencePort,
  EvidenceRecord,
  GenerationRef,
  GlossarySpec,
  LaneContext,
  MediaClearRequest,
  MediaIngressEvent,
  MediaIngressRequest,
  MediaPlaybackRequest,
  MediaPort,
  SessionEvent,
  SessionSpec,
  Side,
  TranslationEvent,
  TranslationCapabilities,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
  RecorderPreflightRequest,
  RecorderPreflightResult,
} from "../src/core/types.js";

const TEST_CAPABILITIES: TranslationCapabilities = {
  providerId: "openai_controlled",
  modes: [
    { mode: "fast", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    { mode: "accurate", behaviorVersion: 1, state: "native", deterministicGlossary: true },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
};

const TEST_SHA256 = "a".repeat(64);
const CONFIDENTIAL_GLOSSARY_TARGET = "SENTINEL_CONFIDENTIAL_GLOSSARY_TARGET";
const CONFIDENTIAL_GLOSSARY_BYPASS_TARGET = "SENTINEL_CONFIDENTIAL_GLOSSARY_BYPASS_TARGET";
const CONFIDENTIAL_PROVIDER_NAME = "SENTINEL_PROVIDER_NAME";
const CONFIDENTIAL_PROVIDER_PATH = "SENTINEL_PROVIDER_PATH=/srv/private/translations";
const CONFIDENTIAL_PROVIDER_TOKEN = "SENTINEL_PROVIDER_TOKEN=sk-live-private";
const CONFIDENTIAL_PROVIDER_DIAGNOSTIC = [
  CONFIDENTIAL_PROVIDER_NAME,
  CONFIDENTIAL_PROVIDER_PATH,
  CONFIDENTIAL_PROVIDER_TOKEN,
].join(" ");
const TERMINOLOGY_GLOSSARY: GlossarySpec = Object.freeze({
  id: "relay-terminology",
  version: "v1",
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  entries: Object.freeze([Object.freeze({
    id: "term-1",
    source: "private source",
    aliases: Object.freeze([]),
    targetExact: CONFIDENTIAL_GLOSSARY_TARGET,
  })]),
});
const TERMINOLOGY_COMPILED = compileGlossaryPair(TERMINOLOGY_GLOSSARY).forward;

function readyPreflight(request: RecorderPreflightRequest): RecorderPreflightResult {
  return {
    status: "ready",
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    preflightId: "preflight-" + request.sessionId,
    checkedAtMonoMs: request.checkedAtMonoMs,
    requiredFreeBytes: "1048576",
    availableFreeBytes: "1073741824",
    tracks: EVIDENCE_AUDIO_TRACKS,
    manifestSha256: request.processingManifestSha256,
    encryptedSpoolSha256: TEST_SHA256,
    sealedRecordCount: 1,
    sealSha256: TEST_SHA256,
  };
}

function sealedFinalization(request: EvidenceFinalizeRequest): EvidenceFinalization {
  const track = { sha256: TEST_SHA256, frameCount: 0, byteCount: 0 } as const;
  return {
    status: "sealed",
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    manifestSha256: TEST_SHA256,
    encryptedLedgerSha256: TEST_SHA256,
    finalChainSha256: TEST_SHA256,
    recordCount: 1,
    finalizedAtUtc: "2026-08-09T00:00:00.000Z",
    retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    tracks: {
      source_a: track,
      source_b: track,
      playout_to_a: track,
      playout_to_b: track,
    },
  };
}

class FakeEvidence implements EvidencePort {
  readonly records: EvidenceRecord[] = [];
  readonly flushes: string[] = [];
  readonly preflightRequests: RecorderPreflightRequest[] = [];
  readonly finalizeRequests: EvidenceFinalizeRequest[] = [];

  async persist(record: EvidenceRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }

  async preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    this.preflightRequests.push(structuredClone(request));
    return readyPreflight(request);
  }

  async flush(sessionId: string): Promise<void> {
    this.flushes.push(sessionId);
  }

  async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    this.finalizeRequests.push(structuredClone(request));
    return sealedFinalization(request);
  }
}

class DeferredFlushEvidence extends FakeEvidence {
  #markFlushStarted!: () => void;
  #releaseFlush!: () => void;
  readonly #flushStarted = new Promise<void>((resolve) => {
    this.#markFlushStarted = resolve;
  });
  readonly #flushReleased = new Promise<void>((resolve) => {
    this.#releaseFlush = resolve;
  });

  override async flush(sessionId: string): Promise<void> {
    await super.flush(sessionId);
    this.#markFlushStarted();
    await this.#flushReleased;
  }

  async waitForFlush(): Promise<void> {
    await this.#flushStarted;
  }

  releaseFlush(): void {
    this.#releaseFlush();
  }
}

class DeferredConsentEvidence extends FakeEvidence {
  readonly #side: Side;
  readonly #reject: boolean;
  #markConsentPersistStarted!: () => void;
  #releaseConsentPersist!: () => void;
  readonly #consentPersistStarted = new Promise<void>((resolve) => {
    this.#markConsentPersistStarted = resolve;
  });
  readonly #consentPersistReleased = new Promise<void>((resolve) => {
    this.#releaseConsentPersist = resolve;
  });

  constructor(side: Side, reject: boolean) {
    super();
    this.#side = side;
    this.#reject = reject;
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (
      record.type === "session_event" &&
      record.event.type === "participant_consent" &&
      record.event.side === this.#side
    ) {
      this.#markConsentPersistStarted();
      await this.#consentPersistReleased;
      if (this.#reject) throw new Error("delayed consent durability rejection");
    }
    await super.persist(record);
  }

  async waitForConsentPersist(): Promise<void> {
    await this.#consentPersistStarted;
  }

  releaseConsentPersist(): void {
    this.#releaseConsentPersist();
  }
}

class DeferredSessionOpenedEvidence extends FakeEvidence {
  #markSessionOpenedPersistStarted!: () => void;
  #releaseSessionOpenedPersist!: () => void;
  readonly #sessionOpenedPersistStarted = new Promise<void>((resolve) => {
    this.#markSessionOpenedPersistStarted = resolve;
  });
  readonly #sessionOpenedPersistReleased = new Promise<void>((resolve) => {
    this.#releaseSessionOpenedPersist = resolve;
  });

  constructor(private readonly reject: boolean) {
    super();
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "session_event" && record.event.type === "session_opened") {
      this.#markSessionOpenedPersistStarted();
      await this.#sessionOpenedPersistReleased;
      if (this.reject) throw new Error("delayed session-opened durability rejection");
    }
    await super.persist(record);
  }

  async waitForSessionOpenedPersist(): Promise<void> {
    await this.#sessionOpenedPersistStarted;
  }

  releaseSessionOpenedPersist(): void {
    this.#releaseSessionOpenedPersist();
  }
}

class DeferredSessionStateEvidence extends FakeEvidence {
  #markSessionStatePersistStarted!: () => void;
  #releaseSessionStatePersist!: () => void;
  readonly #sessionStatePersistStarted = new Promise<void>((resolve) => {
    this.#markSessionStatePersistStarted = resolve;
  });
  readonly #sessionStatePersistReleased = new Promise<void>((resolve) => {
    this.#releaseSessionStatePersist = resolve;
  });

  constructor(
    private readonly status: "active" | "paused" | "ready",
    private readonly reject: boolean,
  ) {
    super();
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (
      record.type === "session_event" &&
      record.event.type === "session_state" &&
      record.event.status === this.status
    ) {
      this.#markSessionStatePersistStarted();
      await this.#sessionStatePersistReleased;
      if (this.reject) throw new Error("delayed session-state durability rejection");
    }
    await super.persist(record);
  }

  async waitForSessionStatePersist(): Promise<void> {
    await this.#sessionStatePersistStarted;
  }

  releaseSessionStatePersist(): void {
    this.#releaseSessionStatePersist();
  }
}

class DeferredParticipantStateEvidence extends FakeEvidence {
  #blocking = false;
  #markParticipantStatePersistStarted!: () => void;
  #releaseParticipantStatePersist!: () => void;
  readonly #participantStatePersistStarted = new Promise<void>((resolve) => {
    this.#markParticipantStatePersistStarted = resolve;
  });
  readonly #participantStatePersistReleased = new Promise<void>((resolve) => {
    this.#releaseParticipantStatePersist = resolve;
  });

  blockParticipantState(): void {
    this.#blocking = true;
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (this.#blocking && record.type === "session_event" && record.event.type === "participant_state") {
      this.#blocking = false;
      this.#markParticipantStatePersistStarted();
      await this.#participantStatePersistReleased;
    }
    await super.persist(record);
  }

  async waitForParticipantStatePersist(): Promise<void> {
    await this.#participantStatePersistStarted;
  }

  releaseParticipantStatePersist(): void {
    this.#releaseParticipantStatePersist();
  }
}

class NeverClosingStateEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "session_event" && record.event.type === "session_state" && record.event.status === "closing") {
      await new Promise<void>(() => {});
    }
    await super.persist(record);
  }
}

class DeferredQueueSampleEvidence extends FakeEvidence {
  queueSamplePersistAttempts = 0;
  #markQueueSamplePersistStarted!: () => void;
  #releaseQueueSamplePersist!: () => void;
  readonly #queueSamplePersistStarted = new Promise<void>((resolve) => {
    this.#markQueueSamplePersistStarted = resolve;
  });
  readonly #queueSamplePersistReleased = new Promise<void>((resolve) => {
    this.#releaseQueueSamplePersist = resolve;
  });

  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "session_event" && record.event.type === "queue_sample") {
      this.queueSamplePersistAttempts += 1;
      this.#markQueueSamplePersistStarted();
      await this.#queueSamplePersistReleased;
    }
    await super.persist(record);
  }

  async waitForQueueSamplePersist(): Promise<void> {
    await this.#queueSamplePersistStarted;
  }

  releaseQueueSamplePersist(): void {
    this.#releaseQueueSamplePersist();
  }
}

class DeferredWithdrawalEvidence extends FakeEvidence {
  #markWithdrawalPersistStarted!: () => void;
  #releaseWithdrawalPersist!: () => void;
  readonly #withdrawalPersistStarted = new Promise<void>((resolve) => {
    this.#markWithdrawalPersistStarted = resolve;
  });
  readonly #withdrawalPersistReleased = new Promise<void>((resolve) => {
    this.#releaseWithdrawalPersist = resolve;
  });

  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "session_event" && record.event.type === "participant_consent_withdrawal") {
      this.#markWithdrawalPersistStarted();
      await this.#withdrawalPersistReleased;
    }
    await super.persist(record);
  }

  async waitForWithdrawalPersist(): Promise<void> {
    await this.#withdrawalPersistStarted;
  }

  releaseWithdrawalPersist(): void {
    this.#releaseWithdrawalPersist();
  }
}

class DeferredEvidenceOperationEvidence extends FakeEvidence {
  persistAttempts = 0;
  #blocking = false;
  #markPersistStarted!: () => void;
  #releasePersist!: () => void;
  readonly #persistStarted = new Promise<void>((resolve) => {
    this.#markPersistStarted = resolve;
  });
  readonly #persistReleased = new Promise<void>((resolve) => {
    this.#releasePersist = resolve;
  });

  blockPersistence(): void {
    this.#blocking = true;
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (this.#blocking) {
      this.persistAttempts += 1;
      this.#markPersistStarted();
      await this.#persistReleased;
    }
    await super.persist(record);
  }

  async waitForPersist(): Promise<void> {
    await this.#persistStarted;
  }

  releasePersistence(): void {
    this.#releasePersist();
  }
}

class DeferredPlayoutAudioEvidence extends FakeEvidence {
  #blocking = false;
  #markPlayoutPersistStarted!: () => void;
  #releasePlayoutPersist!: () => void;
  readonly #playoutPersistStarted = new Promise<void>((resolve) => {
    this.#markPlayoutPersistStarted = resolve;
  });
  readonly #playoutPersistReleased = new Promise<void>((resolve) => {
    this.#releasePlayoutPersist = resolve;
  });

  blockPlayoutAudio(): void {
    this.#blocking = true;
  }

  override async persist(record: EvidenceRecord): Promise<void> {
    if (this.#blocking && record.type === "audio" && record.track === "playout_to_b") {
      this.#blocking = false;
      this.#markPlayoutPersistStarted();
      await this.#playoutPersistReleased;
    }
    await super.persist(record);
  }

  async waitForPlayoutPersist(): Promise<void> {
    await this.#playoutPersistStarted;
  }

  releasePlayoutPersist(): void {
    this.#releasePlayoutPersist();
  }
}

class RejectingParticipantReadinessEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "session_event" && record.event.type === "participant_readiness") {
      throw new Error("participant readiness durability rejected");
    }
    await super.persist(record);
  }
}

class RejectingRecorderPreflightEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "recorder_preflight") {
      throw new Error("recorder preflight durability rejected");
    }
    await super.persist(record);
  }
}

class RejectingRecorderArmEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "recorder_track_armed") {
      throw new Error("Evidence rejected recorder arm record");
    }
    await super.persist(record);
  }
}

class FailingFlushEvidence extends FakeEvidence {
  override async flush(sessionId: string): Promise<void> {
    await super.flush(sessionId);
    throw new Error("recorder flush failed");
  }
}

class FailingFinalizationEvidence extends FakeEvidence {
  override async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    this.finalizeRequests.push(structuredClone(request));
    return {
      status: "FINALIZATION_FAILED",
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      failureCode: "integrity_verification_failed",
      recovery: "rebuild_from_spool",
    };
  }
}

class FailedPreflightEvidence extends FakeEvidence {
  override async preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    this.preflightRequests.push(structuredClone(request));
    return {
      status: "failed",
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      checkedAtMonoMs: request.checkedAtMonoMs,
      failureCode: "insufficient_evidence_disk",
    };
  }
}

class DeferredFinalizationEvidence extends FakeEvidence {
  #markFinalizeStarted!: () => void;
  #releaseFinalize!: () => void;
  readonly #finalizeStarted = new Promise<void>((resolve) => {
    this.#markFinalizeStarted = resolve;
  });
  readonly #finalizeReleased = new Promise<void>((resolve) => {
    this.#releaseFinalize = resolve;
  });

  override async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    this.finalizeRequests.push(structuredClone(request));
    this.#markFinalizeStarted();
    await this.#finalizeReleased;
    return sealedFinalization(request);
  }

  async waitForFinalization(): Promise<void> {
    await this.#finalizeStarted;
  }

  releaseFinalization(): void {
    this.#releaseFinalize();
  }
}

class NeverFinalizationEvidence extends FakeEvidence {
  #markFinalizeStarted!: () => void;
  readonly #finalizeStarted = new Promise<void>((resolve) => {
    this.#markFinalizeStarted = resolve;
  });
  abortObserved = false;

  override async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    this.finalizeRequests.push(structuredClone(request));
    request.abortSignal?.addEventListener("abort", () => {
      this.abortObserved = true;
    }, { once: true });
    this.#markFinalizeStarted();
    await new Promise<void>(() => {});
    throw new Error("unreachable");
  }

  async waitForFinalization(): Promise<void> {
    await this.#finalizeStarted;
  }
}

class DelayedFinalizationEvidence extends FakeEvidence {
  override async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return super.finalize(request);
  }
}

class ThrowingSourceAudioEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "audio" && record.track === "source_a") {
      throw new Error("source audio writer failed");
    }
    await super.persist(record);
  }
}

class DeferredRejectingSourceAudioEvidence extends FakeEvidence {
  #markSourcePersistStarted!: () => void;
  #releaseSourcePersist!: () => void;
  #sourcePersistRejected = false;
  readonly #sourcePersistStarted = new Promise<void>((resolve) => {
    this.#markSourcePersistStarted = resolve;
  });
  readonly #sourcePersistReleased = new Promise<void>((resolve) => {
    this.#releaseSourcePersist = resolve;
  });

  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "audio" && record.track === "source_a") {
      this.#markSourcePersistStarted();
      await this.#sourcePersistReleased;
      this.#sourcePersistRejected = true;
      throw new Error("delayed source durability rejection");
    }
    await super.persist(record);
  }

  async waitForSourcePersist(): Promise<void> {
    await this.#sourcePersistStarted;
  }

  rejectSourcePersist(): void {
    this.#releaseSourcePersist();
  }

  override async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    if (!this.#sourcePersistRejected) return super.finalize(request);
    this.finalizeRequests.push(structuredClone(request));
    return {
      status: "FINALIZATION_FAILED",
      sessionId: request.sessionId,
      processingManifestSha256: request.processingManifestSha256,
      failureCode: "integrity_verification_failed",
      recovery: "rebuild_from_spool",
    };
  }
}

class DeferredSuccessfulSourceAudioEvidence extends FakeEvidence {
  #markSourcePersistStarted!: () => void;
  #releaseSourcePersist!: () => void;
  readonly #sourcePersistStarted = new Promise<void>((resolve) => {
    this.#markSourcePersistStarted = resolve;
  });
  readonly #sourcePersistReleased = new Promise<void>((resolve) => {
    this.#releaseSourcePersist = resolve;
  });

  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "audio" && record.track === "source_a") {
      this.#markSourcePersistStarted();
      await this.#sourcePersistReleased;
    }
    await super.persist(record);
  }

  async waitForSourcePersist(): Promise<void> {
    await this.#sourcePersistStarted;
  }

  releaseSourcePersist(): void {
    this.#releaseSourcePersist();
  }
}

class RejectingTranslationRejectionEvidence extends FakeEvidence {
  override async persist(record: EvidenceRecord): Promise<void> {
    if (record.type === "translation_rejected") {
      throw new Error("Evidence rejected translation rejection record");
    }
    await super.persist(record);
  }
}

class FakeMedia implements MediaPort {
  readonly played: Record<Side, AudioFrame[]> = { A: [], B: [] };
  readonly clears: MediaClearRequest[] = [];
  readonly closedSessions: string[] = [];
  readonly #queues = new Map<string, AsyncQueue<MediaIngressEvent>>();

  push(event: MediaIngressEvent): void {
    const queue = this.#queue(event.sessionId);
    const offered = queue.offer(event);
    if (!offered && (queue.closed || this.closedSessions.includes(event.sessionId))) return;
    assert.equal(offered, true);
  }

  pendingIngress(sessionId: string): number {
    return this.#queue(sessionId).size;
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    const queue = this.#queue(request.sessionId);
    request.signal.addEventListener("abort", () => queue.close(), { once: true });
    return queue;
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      this.played[request.side].push(frame);
      request.onPlayoutStarted(frame, performance.now());
    }
  }

  async clear(request: MediaClearRequest): Promise<void> {
    this.clears.push(request);
  }

  closeSession(sessionId: string): void | Promise<void> {
    this.closedSessions.push(sessionId);
    this.#queues.get(sessionId)?.close();
  }

  #queue(sessionId: string): AsyncQueue<MediaIngressEvent> {
    const existing = this.#queues.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new AsyncQueue<MediaIngressEvent>(100);
    this.#queues.set(sessionId, created);
    return created;
  }
}

class StalledMedia extends FakeMedia {
  override async play(request: MediaPlaybackRequest): Promise<void> {
    await new Promise<void>((resolve) => {
      request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class DelayedCloseMedia extends FakeMedia {
  override async closeSession(sessionId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    super.closeSession(sessionId);
  }
}

class RejectingClearMedia extends FakeMedia {
  override async clear(_request: MediaClearRequest): Promise<void> {
    throw new Error("playout clear rejected");
  }
}

class FakeTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  readonly captured: AudioFrame[] = [];
  readonly prepared: LaneContext[] = [];
  readonly closedSessions: string[] = [];
  readonly cancelled: GenerationRef[] = [];
  readonly #waitForRelease: boolean;
  #released = false;
  readonly #releaseWaiters: Array<() => void> = [];

  constructor(waitForRelease = false) {
    this.#waitForRelease = waitForRelease;
  }

  release(): void {
    this.#released = true;
    for (const resolve of this.#releaseWaiters.splice(0)) resolve();
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    this.prepared.push(context);
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      this.captured.push(frame);
      if (this.#waitForRelease && !this.#released) {
        await new Promise<void>((resolve) => this.#releaseWaiters.push(resolve));
      }
      yield {
        kind: "source_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "source-0",
        revision: 1,
        finality: "provisional",
        evidenceRef: "fake:source",
        emittedAtMs: performance.now(),
        text: "source",
      };
      yield {
        kind: "target_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "target-0",
        revision: 1,
        finality: "provisional",
        evidenceRef: "fake:target",
        emittedAtMs: performance.now(),
        text: "target",
      };
      yield {
        kind: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "audio-0",
        targetSegmentId: "target-0",
        revision: 1,
        finality: "provisional",
        evidenceRef: "fake:audio",
        emittedAtMs: performance.now(),
        playoutSequence: frame.sequence,
        frame: createAudioFrame({
          ...frame,
          generation: request.context.generation,
        }),
      };
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    this.cancelled.push(generation);
  }
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
  }

}

class NeverClosingTranslation extends FakeTranslation {
  override async closeSession(_sessionId: string): Promise<void> {
    await new Promise<void>(() => {});
  }
}

class InvalidAudioTargetTranslation extends FakeTranslation {
  readonly #targetSegmentId: string;
  readonly #audioRevision: number;

  constructor(targetSegmentId: string, audioRevision: number) {
    super();
    this.#targetSegmentId = targetSegmentId;
    this.#audioRevision = audioRevision;
  }

  override async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        emittedAtMs: performance.now(),
      } as const;
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: "target-0",
        revision: 1,
        finality: "final",
        evidenceRef: "invalid-target:transcript",
        text: "target",
      };
      yield {
        ...base,
        kind: "audio",
        segmentId: "audio-0",
        targetSegmentId: this.#targetSegmentId,
        revision: this.#audioRevision,
        finality: "final",
        evidenceRef: "invalid-target:audio",
        playoutSequence: frame.sequence,
        frame: createAudioFrame({ ...frame, generation: request.context.generation }),
      };
      return;
    }
  }
}

class TwoSegmentPlayoutTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      for (const [index, segmentId] of ["segment-one", "segment-two"].entries()) {
        const sequence = frame.sequence + index + 1;
        const targetSegmentId = "target-" + segmentId;
        yield {
          kind: "target_transcript",
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId: targetSegmentId,
          revision: 1,
          finality: "final",
          evidenceRef: "two-segment:target:" + segmentId,
          emittedAtMs: performance.now(),
          text: targetSegmentId,
        };
        yield {
          kind: "audio",
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId,
          targetSegmentId,
          revision: 1,
          finality: "final",
          evidenceRef: "two-segment:" + segmentId,
          emittedAtMs: performance.now(),
          playoutSequence: sequence,
          frame: createAudioFrame({
            ...frame,
            sequence,
            generation: request.context.generation,
          }),
        };
      }
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class BurstPlayoutTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      for (let index = 1; index <= 40; index += 1) {
        const segmentId = "burst-segment-" + index;
        const targetSegmentId = "target-" + segmentId;
        const sequence = frame.sequence + index;
        yield {
          kind: "target_transcript",
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId: targetSegmentId,
          revision: 1,
          finality: "final",
          evidenceRef: "burst:target:" + segmentId,
          emittedAtMs: performance.now(),
          text: targetSegmentId,
        };
        yield {
          kind: "audio",
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId,
          targetSegmentId,
          revision: 1,
          finality: "final",
          evidenceRef: "burst:" + segmentId,
          emittedAtMs: performance.now(),
          playoutSequence: sequence,
          frame: createAudioFrame({
            ...frame,
            sequence,
            generation: request.context.generation,
          }),
        };
      }
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class CapabilityTranslation extends FakeTranslation {
  override readonly capabilities: TranslationCapabilities;

  constructor(capabilities: TranslationCapabilities) {
    super();
    this.capabilities = capabilities;
  }
}

class BatchTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  readonly completedBatches: AudioFrame[][] = [];
  readonly prepared: LaneContext[] = [];
  readonly closedSessions: string[] = [];
  readonly contexts: LaneContext[] = [];

  async prepare(context: LaneContext) {
    this.prepared.push(context);
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    this.contexts.push(request.context);
    const batch: AudioFrame[] = [];
    for await (const frame of request.frames) batch.push(frame);
    this.completedBatches.push(batch);
    const last = batch.at(-1);
    if (last !== undefined && !request.signal.aborted) {
      const glossaryHash = request.context.glossary?.hash ?? "test-hash";
      const entryId = request.context.glossary?.entries[0]?.id ?? "term-1";
      yield { kind: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, turnId: request.context.turnId, segmentId: "term-0", revision: 1, finality: "final", evidenceRef: "batch:bound", emittedAtMs: performance.now(), status: "bound", glossaryHash, entryIds: [entryId], text: "bound", guaranteedTargetExact: [] };
      yield { kind: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, turnId: request.context.turnId, segmentId: "term-1", revision: 1, finality: "final", evidenceRef: "batch:authorized", emittedAtMs: performance.now(), status: "authorized", glossaryHash, entryIds: [entryId], text: "target exact", guaranteedTargetExact: ["target exact"] };
      yield {
        kind: "target_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "target-0",
        revision: 1,
        finality: "final",
        evidenceRef: "batch:target",
        emittedAtMs: performance.now(),
        text: "translated batch",
      };
      yield {
        kind: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "audio-0",
        targetSegmentId: "target-0",
        revision: 1,
        finality: "final",
        evidenceRef: "batch:audio",
        emittedAtMs: performance.now(),
        playoutSequence: last.sequence,
        frame: createAudioFrame({ ...last, generation: request.context.generation }),
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
  }

}

class RevisionTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        evidenceRef: "revision:provider",
        emittedAtMs: performance.now(),
      } as const;
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 0, finality: "provisional", text: "hel" };
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 1, finality: "final", text: "hello" };
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 2, finality: "final", text: "must be ignored" };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: "target-1",
        revision: 1,
        finality: "provisional",
        text: "target",
      };
      for (const playoutSequence of [1, 1, 0, 2]) {
        yield {
          ...base,
          kind: "audio",
          segmentId: "audio-1",
          targetSegmentId: "target-1",
          revision: 1,
          finality: "provisional",
          playoutSequence,
          frame: createAudioFrame({ ...frame, generation: request.context.generation }),
        };
      }
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class DiagnosticTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        emittedAtMs: performance.now(),
      } as const;
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: "diagnostic-source",
        revision: 0,
        finality: "provisional",
        evidenceRef: "provider:source-draft",
        text: "draft",
      };
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: "diagnostic-source",
        revision: 1,
        finality: "final",
        evidenceRef: "provider:source-final",
        text: "final",
      };
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: "diagnostic-source",
        revision: 2,
        finality: "final",
        evidenceRef: "provider:terminal-revision",
        text: "must be rejected",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: "diagnostic-target",
        revision: 0,
        finality: "final",
        evidenceRef: "provider:target",
        text: "target",
      };
      for (const evidenceRef of ["provider:audio-accepted", "provider:audio-stale"] as const) {
        yield {
          ...base,
          kind: "audio",
          segmentId: "diagnostic-audio",
          targetSegmentId: "diagnostic-target",
          revision: 0,
          finality: "final",
          evidenceRef,
          playoutSequence: 0,
          frame: createAudioFrame({ ...frame, generation: request.context.generation }),
        };
      }
      yield {
        ...base,
        kind: "diagnostic",
        segmentId: "diagnostic-tombstone",
        revision: 0,
        finality: "final",
        evidenceRef: "provider:tombstone",
        reason: "adapter_tombstone",
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class ProvisionalTerminologyTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      const glossaryHash = request.context.glossary?.hash ?? "test-glossary";
      const entryId = request.context.glossary?.entries[0]?.id ?? "term-1";
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        emittedAtMs: performance.now(),
      } as const;
      yield {
        ...base,
        kind: "terminology",
        segmentId: "provisional-binding",
        revision: 0,
        finality: "provisional",
        evidenceRef: "terminology:bound-provisional",
        status: "bound",
        glossaryHash,
        entryIds: [entryId],
        text: "bound",
        guaranteedTargetExact: [],
      };
      yield {
        ...base,
        kind: "terminology",
        segmentId: "final-authorization",
        revision: 1,
        finality: "final",
        evidenceRef: "terminology:authorized-final",
        status: "authorized",
        glossaryHash,
        entryIds: [entryId],
        text: CONFIDENTIAL_GLOSSARY_TARGET,
        guaranteedTargetExact: [CONFIDENTIAL_GLOSSARY_TARGET],
      };
      yield {
        ...base,
        kind: "terminology",
        segmentId: "final-bypass",
        revision: 2,
        finality: "final",
        evidenceRef: "terminology:bypassed-final",
        status: "bypassed",
        glossaryHash,
        entryIds: [entryId],
        text: CONFIDENTIAL_GLOSSARY_BYPASS_TARGET,
        guaranteedTargetExact: [],
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: "canonical-target-output",
        revision: 0,
        finality: "final",
        evidenceRef: "target:canonical-output",
        text: CONFIDENTIAL_GLOSSARY_TARGET,
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class InvalidTerminologyProvenanceTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        finality: "final" as const,
        emittedAtMs: performance.now(),
      };
      yield {
        ...base,
        kind: "terminology" as const,
        segmentId: "invalid-hash",
        revision: 0,
        evidenceRef: "terminology:invalid-hash",
        status: "authorized" as const,
        glossaryHash: "0".repeat(64),
        entryIds: [request.context.glossary?.entries[0]?.id ?? "term-1"],
        text: "ignored",
        guaranteedTargetExact: [],
      };
      yield {
        ...base,
        kind: "terminology" as const,
        segmentId: "invalid-entry",
        revision: 0,
        evidenceRef: "terminology:invalid-entry",
        status: "authorized" as const,
        glossaryHash: request.context.glossary?.hash ?? "missing-glossary",
        entryIds: ["term-not-in-approved-glossary"],
        text: "ignored",
        guaranteedTargetExact: [],
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class InvalidLaneTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      yield {
        kind: "source_transcript" as const,
        sessionId: request.context.sessionId,
        lane: "INVALID" as unknown as "A_TO_B",
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "invalid-lane",
        revision: 0,
        finality: "final" as const,
        evidenceRef: "translation:invalid-lane",
        emittedAtMs: performance.now(),
        text: "ignored",
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class StructuredAlertTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  #glossaryAlertEmitted = false;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      if (this.#glossaryAlertEmitted) {
        yield {
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          revision: 0,
          finality: "final" as const,
          emittedAtMs: performance.now(),
          kind: "error" as const,
          segmentId: "structured-confidence-alert",
          evidenceRef: "provider:structured-confidence-alert",
          error: {
            code: "TRANSCRIPTION_LOW_CONFIDENCE",
            message: "transcription confidence is low",
            retryable: false,
            confidence: 0.42,
          },
        };
        return;
      }
      this.#glossaryAlertEmitted = true;
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        revision: 0,
        finality: "final" as const,
        emittedAtMs: performance.now(),
      };
      yield {
        ...base,
        kind: "error" as const,
        segmentId: "structured-glossary-alert",
        evidenceRef: "provider:structured-glossary-alert",
        error: {
          code: "GLOSSARY_PLACEHOLDER_MISSING",
          message: "spindle placeholder was lost",
          retryable: false,
          termId: "spindle",
        },
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class SensitiveProviderErrorTranslation extends FakeTranslation {
  override async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      yield {
        kind: "error",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "sensitive-provider-error",
        revision: 0,
        finality: "final",
        evidenceRef: "provider:sensitive-error",
        emittedAtMs: performance.now(),
        error: {
          code: "UPSTREAM_TRANSLATION_FAILURE",
          message: CONFIDENTIAL_PROVIDER_DIAGNOSTIC,
          retryable: false,
        },
      };
      return;
    }
  }
}

class SensitiveProviderFailureTranslation extends FakeTranslation {
  override async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      throw new Error(CONFIDENTIAL_PROVIDER_DIAGNOSTIC);
    }
  }

  override async cancel(_generation: GenerationRef): Promise<void> {
    throw new Error(CONFIDENTIAL_PROVIDER_DIAGNOSTIC);
  }

  override async closeSession(_sessionId: string): Promise<void> {
    throw new Error(CONFIDENTIAL_PROVIDER_DIAGNOSTIC);
  }
}

class BargeOrderingMedia extends FakeMedia {
  readonly #operations: string[];

  constructor(operations: string[]) {
    super();
    this.#operations = operations;
  }

  override async clear(request: MediaClearRequest): Promise<void> {
    this.#operations.push("media.clear");
    await super.clear(request);
  }
}

class StallingCancelTranslation extends FakeTranslation {
  readonly #operations: string[];
  #markCancelStarted!: () => void;
  #releaseCancel!: () => void;
  readonly #cancelStarted = new Promise<void>((resolve) => {
    this.#markCancelStarted = resolve;
  });
  readonly #cancelReleased = new Promise<void>((resolve) => {
    this.#releaseCancel = resolve;
  });

  constructor(operations: string[]) {
    super();
    this.#operations = operations;
  }

  override async cancel(generation: GenerationRef): Promise<void> {
    this.#operations.push("translation.cancel");
    this.#markCancelStarted();
    await this.#cancelReleased;
    await super.cancel(generation);
  }

  async waitForCancel(): Promise<void> {
    await this.#cancelStarted;
  }

  releaseCancel(): void {
    this.#releaseCancel();
  }
}

class DeferredRejectedBurstTranslation extends FakeTranslation {
  emittedRejections = 0;
  readonly #burstCount: number;
  #markFrameReceived!: () => void;
  #releaseBurst!: () => void;
  readonly #frameReceived = new Promise<void>((resolve) => {
    this.#markFrameReceived = resolve;
  });
  readonly #burstReleased = new Promise<void>((resolve) => {
    this.#releaseBurst = resolve;
  });

  constructor(burstCount = 8) {
    super();
    this.#burstCount = burstCount;
  }

  override async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      void frame;
      this.#markFrameReceived();
      await this.#burstReleased;
      for (let index = 0; index < this.#burstCount; index += 1) {
        this.emittedRejections += 1;
        yield {
          kind: "source_transcript",
          sessionId: "wrong-session-for-admission-cap",
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId: "deferred-rejection-" + index,
          revision: index,
          finality: "final",
          evidenceRef: "deferred-rejection-" + index,
          emittedAtMs: performance.now(),
          text: "rejected",
        };
      }
      return;
    }
  }

  async waitForFrame(): Promise<void> {
    await this.#frameReceived;
  }

  releaseBurst(): void {
    this.#releaseBurst();
  }
}

class ThrowingCleanupMedia extends FakeMedia {
  override closeSession(sessionId: string): void {
    super.closeSession(sessionId);
    throw new Error("synchronous media cleanup failed");
  }
}

class SegmentReuseTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  #turn = 0;

  async prepare(_context: LaneContext) {
    return { readiness: "fixture_local", remoteConnection: "not_applicable" } as const;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      this.#turn += 1;
      yield {
        kind: "source_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "adapter-reused-segment",
        revision: 0,
        finality: "final",
        evidenceRef: "segment-reuse:provider",
        emittedAtMs: performance.now(),
        text: "turn " + this.#turn,
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class PrepareFailureTranslation extends FakeTranslation {
  override async prepare(context: LaneContext) {
    if (context.lane === "B_TO_A") throw new Error(CONFIDENTIAL_PROVIDER_DIAGNOSTIC);
    return super.prepare(context);
  }
}

class InvalidPreparationTranslation extends FakeTranslation {
  override async prepare(context: LaneContext): Promise<TranslationPreparation> {
    this.prepared.push(context);
    return {
      readiness: "remote_task_ready",
      remoteConnection: "not_applicable",
    } as unknown as TranslationPreparation;
  }
}

class DeferredPreparationTranslation extends FakeTranslation {
  #preparedCount = 0;
  #markBothPrepared!: () => void;
  #releasePreparation!: () => void;
  readonly #bothPrepared = new Promise<void>((resolve) => {
    this.#markBothPrepared = resolve;
  });
  readonly #preparationReleased = new Promise<void>((resolve) => {
    this.#releasePreparation = resolve;
  });

  override async prepare(context: LaneContext): Promise<TranslationPreparation> {
    this.prepared.push(context);
    this.#preparedCount += 1;
    if (this.#preparedCount === 2) this.#markBothPrepared();
    await this.#preparationReleased;
    return { readiness: "fixture_local", remoteConnection: "not_applicable" };
  }

  async waitForBothPreparations(): Promise<void> {
    await this.#bothPrepared;
  }

  releasePreparation(): void {
    this.#releasePreparation();
  }
}


async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeRelay(
  media: FakeMedia,
  translation: TranslationPort,
  evidence: EvidencePort,
  now?: () => number,
  finalizationTimeoutMs?: number,
  evidenceOperationTimeoutMs?: number,
  adapterCloseTimeoutMs?: number,
) {
  return new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    processingProfile: createSyntheticPocProcessingProfile(),
    createSessionId: () => "session-1",
    ...(now === undefined ? {} : { now }),
    ...(evidenceOperationTimeoutMs === undefined ? {} : { evidenceOperationTimeoutMs }),
    ...(adapterCloseTimeoutMs === undefined ? {} : { adapterCloseTimeoutMs }),
    ...(finalizationTimeoutMs === undefined ? {} : { finalizationTimeoutMs }),
    endpointGrant: (sessionId, side) => ({
      kind: "browser_link",
      side,
      url: `https://demo.test/participant?session=${sessionId}&side=${side}`,
      qrDataUrl: "data:image/png;base64,AA==",
    }),
  });
}

async function encryptedRelayEvidenceStore(name: string): Promise<{
  readonly root: string;
  readonly evidence: SessionArtifactStore;
  readonly lease: EvidenceRootProcessLease;
}> {
  const root = join(process.cwd(), "work", "tmp", `relay-evidence-${name}-${process.pid}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const { SessionArtifactStore } = await import("../src/adapters/evidence/session-artifact-store.js");
  const evidence = new SessionArtifactStore({
    archiveDirectory: join(root, "archive"),
    keyDirectory: join(root, "keys"),
    exportDirectory: join(root, "exports"),
    receiptDirectory: join(root, "receipts"),
    rootKey: Buffer.alloc(32, 13),
    dataOwnerId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
    minimumFreeBytes: 0,
    securityBoundaryDirectory: root,
    strictAncestors: false,
    now: () => Date.parse("2026-08-09T00:00:00.000Z"),
  });
  const lease = await evidence.acquireEvidenceRootLease("server");
  return {
    root,
    evidence,
    lease,
  };
}

const TEST_EVIDENCE_REVIEW_GRANT: EvidenceReviewGrant = Object.freeze({
  dataOwnerId: "test-data-owner",
  bilingualReviewerId: "test-bilingual-reviewer",
});

function testSessionSpec(
  input: Omit<SessionSpec, "processingManifest" | "evidenceReviewGrant"> &
    Readonly<Partial<Pick<SessionSpec, "evidenceReviewGrant">>>,
): SessionSpec {
  const manifest = createSyntheticPocProcessingManifest({
    mode: input.mode,
    ...(input.glossary === undefined ? {} : { glossary: input.glossary }),
  });
  return {
    ...input,
    processingManifest: manifest,
    evidenceReviewGrant: input.evidenceReviewGrant ?? TEST_EVIDENCE_REVIEW_GRANT,
  };
}

async function readySession(
  relay: ModularGuardedDuplexRelay,
  media: FakeMedia,
  mode: "fast" | "accurate" = "fast",
  glossary?: GlossarySpec,
  maxQueueFrames: number | null = 10,
  syntheticReadiness = false,
  timeoutMs = 2_000,
): Promise<{ events: SessionEvent[]; collector: Promise<void> }> {
  const snapshot = await relay.open(testSessionSpec({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode,
    ...(glossary === undefined ? {} : { glossary }),
    ...(maxQueueFrames === null ? {} : { maxQueueFrames }),
  }));
  const events: SessionEvent[] = [];
  const collector = (async () => {
    for await (const event of relay.events(snapshot.sessionId)) events.push(event);
  })();
  for (const side of ["A", "B"] as const) {
    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "ready-consent-" + side,
      side,
      consentId: "ready-consent-id-" + side,
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
  }
  media.push({
    type: "participant_state",
    sessionId: snapshot.sessionId,
    side: "A",
    timestampMonoMs: performance.now(),
    connected: true,
  });
  media.push({
    type: "participant_state",
    sessionId: snapshot.sessionId,
    side: "B",
    timestampMonoMs: performance.now(),
    connected: true,
  });
  await waitUntil(
    () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
    "participants did not connect",
    timeoutMs,
  );
  for (const side of ["A", "B"] as const) {
    media.push({
      type: "participant_readiness",
      sessionId: snapshot.sessionId,
      side,
      timestampMonoMs: performance.now(),
      ...(syntheticReadiness
        ? {
          microphone: "not_applicable" as const,
          headphones: "not_applicable" as const,
          source: "fake_telephony_fixture" as const,
        }
        : {
          microphone: "browser_capture_active" as const,
          headphones: "self_attested" as const,
          source: "participant_browser_self_report" as const,
        }),
    });
  }
  await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "ready-arm-recorder" });
  await waitUntil(
    () => events.some((event) => event.type === "session_state" && event.status === "ready"),
    "session did not become ready",
    timeoutMs,
  );
  return { events, collector };
}

function audioEvent(
  side: Side,
  sequence: number,
  generation = 0,
): Extract<MediaIngressEvent, { type: "audio" }> {
  const lane = side === "A" ? "A_TO_B" : "B_TO_A";
  return {
    type: "audio",
    sessionId: "session-1",
    side,
    timestampMonoMs: performance.now(),
    frame: createAudioFrame({
      sessionId: "session-1",
      lane,
      generation,
      sequence,
      capturedAtMs: performance.now(),
      pcm16le: new Uint8Array(960),
    }),
  };
}

describe("ModularGuardedDuplexRelay", () => {
  it("normalizes, freezes, and durably persists a per-session evidence review grant", async () => {
    const evidence = new FakeEvidence();
    const relay = makeRelay(new FakeMedia(), new FakeTranslation(), evidence);
    const suppliedGrant = {
      dataOwnerId: "  e\u0301vidence-owner  ",
      bilingualReviewerId: "  bilingual-reviewer  ",
    };

    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
      evidenceReviewGrant: suppliedGrant,
    }));
    suppliedGrant.dataOwnerId = "changed-after-open";

    const expectedGrant = {
      dataOwnerId: "évidence-owner",
      bilingualReviewerId: "bilingual-reviewer",
    };
    assert.deepEqual(snapshot.spec.evidenceReviewGrant, expectedGrant);
    assert.equal(Object.isFrozen(snapshot.spec.evidenceReviewGrant), true);
    const opened = evidence.records.find(
      (record): record is Extract<EvidenceRecord, { type: "session_event" }> & Readonly<{
        readonly event: Extract<SessionEvent, { type: "session_opened" }>;
      }> =>
        record.type === "session_event" && record.event.type === "session_opened",
    );
    assert.deepEqual(opened?.event.snapshot.spec.evidenceReviewGrant, expectedGrant);

    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-frozen-review-grant" });
  });

  it("round-trips access-derived NFC reviewer identities through the durable Relay grant", async () => {
    const ownerToken = "owner-token-0123456789abcdef0123456789";
    const reviewerToken = "reviewer-token-0123456789abcdef01234567";
    const access = createServerAccessControl({
      operatorToken: "operator-token-0123456789abcdef0123456789",
      retentionOwner: { id: "cafe\u0301-data-owner", token: ownerToken },
      evidenceReviewer: { id: "re\u0301viewer", token: reviewerToken },
      participantSigningKey: Buffer.alloc(32, 29),
    });
    const owner = access.resolveEvidenceManagementAuthorization("Bearer " + ownerToken);
    const reviewer = access.resolveEvidenceManagementAuthorization("Bearer " + reviewerToken);
    const evidence = new FakeEvidence();
    const relay = makeRelay(new FakeMedia(), new FakeTranslation(), evidence);

    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
      evidenceReviewGrant: access.evidenceReviewGrant(),
    }));

    assert.equal(snapshot.spec.evidenceReviewGrant.dataOwnerId, owner?.actorId);
    assert.equal(snapshot.spec.evidenceReviewGrant.bilingualReviewerId, reviewer?.actorId);
    assert.equal(snapshot.spec.evidenceReviewGrant.dataOwnerId, "café-data-owner");
    assert.equal(snapshot.spec.evidenceReviewGrant.bilingualReviewerId, "réviewer");
    const opened = evidence.records.find(
      (record): record is Extract<EvidenceRecord, { type: "session_event" }> & Readonly<{
        readonly event: Extract<SessionEvent, { type: "session_opened" }>;
      }> => record.type === "session_event" && record.event.type === "session_opened",
    );
    assert.equal(opened?.event.snapshot.spec.evidenceReviewGrant.dataOwnerId, owner?.actorId);
    assert.equal(opened?.event.snapshot.spec.evidenceReviewGrant.bilingualReviewerId, reviewer?.actorId);
    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-access-grant-round-trip" });
  });

  it("rejects absent, oversized, and non-distinct normalized review grants before evidence persistence", async () => {
    for (const evidenceReviewGrant of [
      undefined,
      { dataOwnerId: " same-person ", bilingualReviewerId: "same-person" },
      { dataOwnerId: "", bilingualReviewerId: "reviewer" },
      { dataOwnerId: "o".repeat(129), bilingualReviewerId: "reviewer" },
    ]) {
      const evidence = new FakeEvidence();
      const relay = makeRelay(new FakeMedia(), new FakeTranslation(), evidence);
      const spec = testSessionSpec({
        sideA: { language: "en-US" },
        sideB: { language: "zh-TW" },
        provider: "openai_controlled",
        mode: "fast",
        evidenceReviewGrant: evidenceReviewGrant as unknown as EvidenceReviewGrant,
      });
      if (evidenceReviewGrant === undefined) {
        delete (spec as { evidenceReviewGrant?: EvidenceReviewGrant }).evidenceReviewGrant;
      }

      await assert.rejects(
        relay.open(spec),
        (error: unknown) => error instanceof RelaySessionError && error.code === "invalid_spec",
      );
      assert.equal(evidence.records.length, 0);
    }
  });

  it("does not acknowledge an opened session before its evidence event is durable", async () => {
    const evidence = new DeferredSessionOpenedEvidence(false);
    const relay = makeRelay(new FakeMedia(), new FakeTranslation(), evidence);
    let acknowledged = false;
    const opening = relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    void opening.then(() => {
      acknowledged = true;
    });

    await evidence.waitForSessionOpenedPersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "open acknowledged before session_opened evidence completed");
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" && record.event.type === "session_opened",
      ),
      false,
    );

    evidence.releaseSessionOpenedPersist();
    const snapshot = await opening;
    assert.equal(snapshot.status, "waiting");
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" && record.event.type === "session_opened",
      ),
      true,
    );
    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-delayed-open" });
  });

  it("rejects an opened session when its initial evidence event cannot persist", async () => {
    const evidence = new DeferredSessionOpenedEvidence(true);
    const relay = makeRelay(new FakeMedia(), new FakeTranslation(), evidence);
    const opening = relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));

    await evidence.waitForSessionOpenedPersist();
    evidence.releaseSessionOpenedPersist();
    await assert.rejects(opening, /Evidence rejected session opened event/u);
    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "undurable session opening did not trigger the evidence failure shutdown",
    );
  });

  it("silently discards pre-consent media before it can reach translation or evidence", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();

    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      connected: true,
    });
    media.push(audioEvent("A", 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    assert.equal(
      events.some((event) => event.type === "participant_state"),
      false,
      "a participant cannot attach before its consent is accepted",
    );
    assert.equal(translation.captured.length, 0);
    assert.equal(evidence.records.some((record) => record.type === "audio"), false);

    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "pre-consent-test-consent-" + side,
        side,
        consentId: "pre-consent-test-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "consented participants did not attach",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "pre-consent-test-arm" });
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "provider preparation did not complete for consented participants",
    );
    await relay.command(snapshot.sessionId, { type: "start", commandId: "pre-consent-test-start" });

    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "authorized media did not reach translation");
    assert.deepEqual(translation.captured.map((frame) => frame.sequence), [1]);
    assert.deepEqual(
      evidence.records.reduce<number[]>((sequences, record) => {
        if (record.type === "audio" && record.track === "source_a") {
          sequences.push(record.frame.sequence);
        }
        return sequences;
      }, []),
      [1],
    );

    await relay.command(snapshot.sessionId, { type: "end", commandId: "pre-consent-test-end" });
    await collector;
  });

  it("accepts readiness from a consented side before the opposite side consents, but drops unconsented readiness and media", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    const readinessA = {
      type: "participant_readiness" as const,
      sessionId: snapshot.sessionId,
      side: "A" as const,
      timestampMonoMs: performance.now(),
      microphone: "browser_capture_active" as const,
      headphones: "self_attested" as const,
      source: "participant_browser_self_report" as const,
    };

    media.push({ ...readinessA, timestampMonoMs: performance.now() });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(relay.snapshot(snapshot.sessionId).participantReadiness.A, undefined);

    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "readiness-before-peer-consent-a",
      side: "A",
      consentId: "readiness-before-peer-consent-id-a",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      connected: true,
    });
    await waitUntil(
      () => events.some((event) => event.type === "participant_state" && event.side === "A" && event.connected),
      "A did not connect before reporting readiness",
    );
    media.push({ ...readinessA, timestampMonoMs: performance.now() });
    await waitUntil(
      () => events.some((event) => event.type === "participant_readiness" && event.side === "A"),
      "A readiness was dropped while waiting for B consent",
    );
    assert.deepEqual(relay.snapshot(snapshot.sessionId).participantReadiness.A, {
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });

    media.push({ ...readinessA, side: "B" });
    media.push(audioEvent("A", 0));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(relay.snapshot(snapshot.sessionId).participantReadiness.B, undefined);
    assert.equal(translation.captured.length, 0, "one-sided consent must not admit media");

    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-readiness-before-peer-consent" });
    await collector;
  });

  it("keeps Start unavailable until qualifying participant readiness and durable provider preparation complete", async () => {
    const media = new FakeMedia();
    const translation = new DeferredPreparationTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();

    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "pre-prepare-consent-" + side,
        side,
        consentId: "pre-prepare-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: side === "A" ? "stopped" : "browser_capture_active",
        headphones: side === "A" ? "self_attested" : "not_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2 &&
        events.filter((event) => event.type === "participant_readiness").length === 2,
      "non-provider readiness was not accepted",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "pre-prepare-arm" });

    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    assert.equal(translation.prepared.length, 0, "stopped capture or missing attestation must block preparation");
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await translation.waitForBothPreparations();
    assert.deepEqual(relay.snapshot(snapshot.sessionId).providerReadiness, {
      A_TO_B: undefined,
      B_TO_A: undefined,
    });
    await assert.rejects(
      relay.command(snapshot.sessionId, { type: "start", commandId: "start-before-provider-ready" }),
      (error: unknown) => error instanceof RelaySessionError && error.code === "invalid_command",
    );
    assert.equal(translation.prepared.length, 2);

    translation.releasePreparation();
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "session did not become ready after provider preparation",
    );
    assert.equal(events.filter((event) => event.type === "provider_readiness").length, 2);
    const readyIndex = events.findIndex((event) => event.type === "session_state" && event.status === "ready");
    const lastProviderReadinessIndex = events.reduce(
      (index, event, current) => event.type === "provider_readiness" ? current : index,
      -1,
    );
    assert.ok(lastProviderReadinessIndex < readyIndex);

    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      connected: false,
    });
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "waiting" &&
        relay.snapshot(snapshot.sessionId).participantReadiness.A === undefined,
      "disconnect did not clear participant readiness before Start",
    );
    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      connected: true,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    media.push({
      type: "participant_readiness",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "reconnected participant readiness did not restore ready",
    );
    assert.equal(translation.prepared.length, 2, "reconnect must not prepare providers again");

    await relay.command(snapshot.sessionId, { type: "start", commandId: "start-after-provider-ready" });
    assert.equal(translation.prepared.length, 2, "Start must not prepare providers a second time");
    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-pre-prepare" });
    await collector;
  });

  it("accepts fake telephony fixture readiness for the pre-Start gate", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { events, collector } = await readySession(
      relay,
      media,
      "fast",
      undefined,
      10,
      true,
    );
    assert.deepEqual(relay.snapshot("session-1").participantReadiness, {
      A: {
        microphone: "not_applicable",
        headphones: "not_applicable",
        source: "fake_telephony_fixture",
      },
      B: {
        microphone: "not_applicable",
        headphones: "not_applicable",
        source: "fake_telephony_fixture",
      },
    });
    assert.equal(events.filter((event) => event.type === "provider_readiness").length, 2);
    assert.equal(translation.prepared.length, 2);
    await relay.command("session-1", { type: "end", commandId: "end-fixture-readiness" });
    await collector;
  });

  it("does not acknowledge participant consent before its evidence event is durable", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredConsentEvidence("A", false);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));

    let acknowledged = false;
    const consent = relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "deferred-consent-a",
      side: "A",
      consentId: "deferred-consent-id-a",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    void consent.then(() => {
      acknowledged = true;
    });

    await evidence.waitForConsentPersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "consent command acknowledged before its evidence write completed");
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" && record.event.type === "participant_consent",
      ),
      false,
    );

    evidence.releaseConsentPersist();
    await consent;
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" && record.event.type === "participant_consent",
      ),
      true,
    );
    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-deferred-consent" });
  });

  it("rejects an undurable participant consent without advancing recorder readiness", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredConsentEvidence("B", true);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();

    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "durable-consent-a",
      side: "A",
      consentId: "durable-consent-id-a",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    let acknowledged = false;
    const consent = relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "undurable-consent-b",
      side: "B",
      consentId: "undurable-consent-id-b",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    void consent.then(
      () => {
        acknowledged = true;
      },
      () => {},
    );

    await evidence.waitForConsentPersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "undurable consent was acknowledged before its write settled");
    evidence.releaseConsentPersist();
    await assert.rejects(consent, /Evidence rejected participant consent event/u);

    const afterFailure = relay.snapshot(snapshot.sessionId);
    assert.equal(afterFailure.participantConsent.A.consented, true);
    assert.equal(afterFailure.participantConsent.B.consented, false);
    assert.equal(afterFailure.recorderArmState, "awaiting_consents");
    assert.equal(afterFailure.recordingArmed, false);
    assert.notEqual(afterFailure.status, "ready");
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "undurable consent did not trigger the evidence failure shutdown",
    );
    await collector;
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
    );
  });

  it("serializes distinct consent and withdrawal commands while preserving same-id idempotency", async () => {
    const consentMedia = new FakeMedia();
    const consentEvidence = new FakeEvidence();
    const consentRelay = makeRelay(consentMedia, new FakeTranslation(), consentEvidence);
    const opened = await consentRelay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const firstConsent = {
      type: "participant_consent" as const,
      commandId: "concurrent-consent-a-first",
      side: "A" as const,
      consentId: "concurrent-consent-id-first",
      consentPolicyRef: opened.spec.processingManifest.consentPolicyRef,
      recording: true as const,
      processing: true as const,
    };
    const [firstConsentResult, replayConsentResult, conflictingConsentResult] = await Promise.allSettled([
      consentRelay.command(opened.sessionId, firstConsent),
      consentRelay.command(opened.sessionId, firstConsent),
      consentRelay.command(opened.sessionId, {
        ...firstConsent,
        commandId: "concurrent-consent-a-conflict",
        consentId: "concurrent-consent-id-conflict",
      }),
    ]);
    assert.equal(firstConsentResult.status, "fulfilled");
    assert.equal(replayConsentResult.status, "fulfilled");
    assert.equal(conflictingConsentResult.status, "rejected");
    if (conflictingConsentResult.status === "rejected") {
      assert.match(String(conflictingConsentResult.reason), /immutable/u);
    }
    assert.equal(consentRelay.snapshot(opened.sessionId).participantConsent.A.consentId, firstConsent.consentId);
    assert.equal(
      consentEvidence.records.filter(
        (record) => record.type === "session_event" && record.event.type === "participant_consent" &&
          record.event.side === "A",
      ).length,
      1,
    );
    await consentRelay.command(opened.sessionId, { type: "end", commandId: "end-concurrent-consent" });

    const withdrawalMedia = new FakeMedia();
    const withdrawalEvidence = new FakeEvidence();
    const withdrawalRelay = makeRelay(withdrawalMedia, new FakeTranslation(), withdrawalEvidence);
    const { collector } = await readySession(withdrawalRelay, withdrawalMedia);
    await withdrawalRelay.command("session-1", { type: "start", commandId: "start-concurrent-withdrawal" });
    const consentId = withdrawalRelay.snapshot("session-1").participantConsent.A.consentId!;
    const firstWithdrawal = {
      type: "participant_consent_withdrawal" as const,
      commandId: "concurrent-withdrawal-first",
      side: "A" as const,
      consentId,
      withdrawalId: "concurrent-withdrawal-id-first",
      withdrawnAtMonoMs: 100,
    };
    const [firstWithdrawalResult, replayWithdrawalResult, conflictingWithdrawalResult] = await Promise.allSettled([
      withdrawalRelay.command("session-1", firstWithdrawal),
      withdrawalRelay.command("session-1", firstWithdrawal),
      withdrawalRelay.command("session-1", {
        ...firstWithdrawal,
        commandId: "concurrent-withdrawal-conflict",
        withdrawalId: "concurrent-withdrawal-id-conflict",
      }),
    ]);
    assert.equal(firstWithdrawalResult.status, "fulfilled");
    assert.equal(replayWithdrawalResult.status, "fulfilled");
    assert.equal(conflictingWithdrawalResult.status, "rejected");
    if (conflictingWithdrawalResult.status === "rejected") {
      assert.match(String(conflictingWithdrawalResult.reason), /withdrawal/u);
    }
    assert.equal(withdrawalRelay.snapshot("session-1").participantConsent.A.withdrawalId, firstWithdrawal.withdrawalId);
    assert.equal(
      withdrawalEvidence.records.filter(
        (record) => record.type === "session_event" && record.event.type === "participant_consent_withdrawal",
      ).length,
      1,
    );
    await collector;
  });

  it("does not acknowledge Start before its session state evidence is durable", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredSessionStateEvidence("active", false);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { collector } = await readySession(relay, media);
    let acknowledged = false;
    const start = relay.command("session-1", { type: "start", commandId: "delayed-start" });
    void start.then(() => {
      acknowledged = true;
    });

    await evidence.waitForSessionStatePersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "Start acknowledged before its active state was durable");
    assert.equal(relay.snapshot("session-1").status, "ready");

    evidence.releaseSessionStatePersist();
    await start;
    assert.equal(relay.snapshot("session-1").status, "active");
    await relay.command("session-1", { type: "end", commandId: "end-delayed-start" });
    await collector;
  });

  it("rejects Start when its session state evidence cannot persist", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredSessionStateEvidence("active", true);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { collector } = await readySession(relay, media);
    const start = relay.command("session-1", { type: "start", commandId: "rejected-start" });

    await evidence.waitForSessionStatePersist();
    evidence.releaseSessionStatePersist();
    await assert.rejects(start, /Evidence rejected session state event/u);
    assert.notEqual(relay.snapshot("session-1").status, "active");
    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "undurable Start state did not trigger the evidence failure shutdown",
    );
    await collector;
  });

  it("does not acknowledge Pause before its session state evidence is durable", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredSessionStateEvidence("paused", false);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-before-delayed-pause" });
    let acknowledged = false;
    const pause = relay.command("session-1", { type: "pause", commandId: "delayed-pause" });
    void pause.then(() => {
      acknowledged = true;
    });

    await evidence.waitForSessionStatePersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "Pause acknowledged before its paused state was durable");
    assert.equal(relay.snapshot("session-1").status, "active");

    evidence.releaseSessionStatePersist();
    await pause;
    assert.equal(relay.snapshot("session-1").status, "paused");
    await relay.command("session-1", { type: "end", commandId: "end-delayed-pause" });
    await collector;
  });

  it("closes transports when the terminal closing state evidence never settles", async () => {
    const media = new FakeMedia();
    const evidence = new NeverClosingStateEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence, undefined, undefined, 100);
    const { events, collector } = await readySession(relay, media);

    const ending = relay.command("session-1", { type: "end", commandId: "end-stalled-closing-state" });
    await waitUntil(
      () => media.closedSessions.includes("session-1"),
      "end did not close the media adapter while closing evidence was stalled",
    );
    await ending;
    await collector;

    assert.equal(relay.snapshot("session-1").status, "closed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "FINALIZATION_FAILED");
    assert.equal(events.filter((event) => event.type === "session_closed").length, 1);
    const evidenceFailureIndex = events.findIndex(
      (event) => event.type === "alert" && event.alert.code === "evidence_store_failed",
    );
    const sessionClosedIndex = events.findIndex((event) => event.type === "session_closed");
    assert.ok(evidenceFailureIndex >= 0, "evidence failure alert was suppressed behind the stalled tail");
    assert.ok(evidenceFailureIndex < sessionClosedIndex, "evidence failure alert must precede session_closed");
  });

  it("bounds a clean finalization that never settles", async () => {
    const media = new FakeMedia();
    const evidence = new NeverFinalizationEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence, undefined, 100);
    const { events, collector } = await readySession(relay, media);

    const ending = relay.command("session-1", { type: "end", commandId: "end-stalled-finalization" });
    await evidence.waitForFinalization();
    await ending;
    await collector;

    assert.equal(relay.snapshot("session-1").status, "closed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "FINALIZATION_FAILED");
    assert.equal(events.filter((event) => event.type === "session_closed").length, 1);
    assert.equal(evidence.abortObserved, true, "finalization timeout did not abort the store operation");
  });

  it("clears bounded evidence wait timers when operations settle promptly", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const activeTimers = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((handler: (...args: any[]) => void, timeout?: number, ...args: any[]) => {
      let timer!: ReturnType<typeof setTimeout>;
      timer = nativeSetTimeout(() => {
        activeTimers.delete(timer);
        handler(...args);
      }, timeout);
      activeTimers.add(timer);
      return timer;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      activeTimers.delete(timer);
      return nativeClearTimeout(timer);
    }) as typeof globalThis.clearTimeout;
    try {
      const media = new FakeMedia();
      const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
      const { collector } = await readySession(relay, media);
      await relay.command("session-1", { type: "end", commandId: "end-cleared-bounded-timers" });
      await collector;
      await new Promise<void>((resolve) => nativeSetTimeout(resolve, 0));
      assert.equal(activeTimers.size, 0, "bounded waits retained a settled-operation timeout handle");
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });

  it("allows a slow clean finalization within its configured deadline", async () => {
    const media = new FakeMedia();
    const evidence = new DelayedFinalizationEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence, undefined, 500);
    const { collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "end", commandId: "end-delayed-finalization" });
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "sealed");
    await collector;
  });

  it("allows a slow adapter close without classifying evidence as failed", async () => {
    const media = new DelayedCloseMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence, undefined, undefined, undefined, 3_500);
    const { events, collector } = await readySession(relay, media, "fast", undefined, 10, false, 5_000);

    await relay.command("session-1", { type: "end", commandId: "end-slow-adapter-close" });

    assert.equal(relay.snapshot("session-1").status, "closed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "sealed");
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_store_failed"),
      false,
    );
    await collector;
  });

  it("bounds a never-settling adapter close without failing clean evidence", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new NeverClosingTranslation(), evidence, undefined, undefined, undefined, 300);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "end", commandId: "end-stalled-adapter-close" });

    assert.equal(relay.snapshot("session-1").status, "closed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "sealed");
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "translation_cleanup_timeout"),
      true,
    );
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_store_failed"),
      false,
    );
    await collector;
  });

  it("applies participant connectivity only after its state evidence is durable", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new DeferredParticipantStateEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-before-deferred-participant-state" });

    evidence.blockParticipantState();
    media.push({
      type: "participant_state",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
      connected: false,
    });
    await evidence.waitForParticipantStatePersist();
    await Promise.resolve();
    assert.equal(
      events.some((event) => event.type === "participant_state" && event.side === "A" && !event.connected),
      false,
      "participant disconnect was published before its evidence was durable",
    );
    assert.equal(relay.snapshot("session-1").status, "active");

    evidence.releaseParticipantStatePersist();
    await waitUntil(
      () => events.some((event) => event.type === "participant_state" && event.side === "A" && !event.connected),
      "durable participant disconnect was not published",
    );
    assert.equal(relay.snapshot("session-1").status, "waiting");
    const capturedBefore = translation.captured.length;
    media.push(audioEvent("A", 0));
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "post-disconnect audio was not consumed",
    );
    assert.equal(translation.captured.length, capturedBefore);
    await relay.command("session-1", { type: "end", commandId: "end-deferred-participant-state" });
    await collector;
  });

  it("publishes durable state changes only after their snapshot projections install", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const opened = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const consentProjected: boolean[] = [];
    const readinessProjected: boolean[] = [];
    const providerProjected: boolean[] = [];
    const preflightProjected: boolean[] = [];
    const recorderProjected: boolean[] = [];
    const statusProjected: boolean[] = [];
    const observer = (async () => {
      for await (const event of relay.events(opened.sessionId)) {
        const snapshot = relay.snapshot(opened.sessionId);
        if (event.type === "participant_consent") {
          consentProjected.push(snapshot.participantConsent[event.side].consented);
        } else if (event.type === "participant_readiness") {
          readinessProjected.push(snapshot.participantReadiness[event.side] !== undefined);
        } else if (event.type === "provider_readiness" && event.lane !== null) {
          providerProjected.push(snapshot.providerReadiness[event.lane] !== undefined);
        } else if (event.type === "recorder_preflight") {
          preflightProjected.push(snapshot.recorderPreflight === event.preflight);
        } else if (event.type === "recorder_state") {
          recorderProjected.push(snapshot.recorderArmState === event.state);
        } else if (event.type === "session_state") {
          statusProjected.push(snapshot.status === event.status);
        }
      }
    })();
    await Promise.resolve();

    for (const side of ["A", "B"] as const) {
      await relay.command(opened.sessionId, {
        type: "participant_consent",
        commandId: "projected-consent-" + side,
        side,
        consentId: "projected-consent-id-" + side,
        consentPolicyRef: opened.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: opened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: opened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => relay.snapshot(opened.sessionId).participantReadiness.A !== undefined &&
        relay.snapshot(opened.sessionId).participantReadiness.B !== undefined,
      "participant readiness did not reach the state projection observer",
    );
    await relay.command(opened.sessionId, { type: "arm_recorder", commandId: "projected-arm" });
    await waitUntil(
      () => relay.snapshot(opened.sessionId).status === "ready",
      "ready state did not reach the state projection observer",
    );
    await relay.command(opened.sessionId, { type: "start", commandId: "projected-start" });
    await relay.command(opened.sessionId, { type: "end", commandId: "projected-end" });
    await observer;

    assert.deepEqual(consentProjected, [true, true]);
    assert.deepEqual(readinessProjected, [true, true]);
    assert.deepEqual(providerProjected, [true, true]);
    assert.deepEqual(preflightProjected, [true]);
    assert.ok(recorderProjected.length >= 3);
    assert.equal(recorderProjected.every(Boolean), true);
    assert.ok(statusProjected.length >= 3);
    assert.equal(statusProjected.every(Boolean), true);
  });

  it("keeps rejected readiness and recorder preflight values out of snapshots", async () => {
    const readinessMedia = new FakeMedia();
    const readinessRelay = makeRelay(
      readinessMedia,
      new FakeTranslation(),
      new RejectingParticipantReadinessEvidence(),
    );
    const readinessOpened = await readinessRelay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    for (const side of ["A", "B"] as const) {
      await readinessRelay.command(readinessOpened.sessionId, {
        type: "participant_consent",
        commandId: "rejected-readiness-consent-" + side,
        side,
        consentId: "rejected-readiness-consent-id-" + side,
        consentPolicyRef: readinessOpened.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      readinessMedia.push({
        type: "participant_state",
        sessionId: readinessOpened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
    }
    await waitUntil(
      () => readinessMedia.pendingIngress(readinessOpened.sessionId) === 0,
      "participants did not connect before rejected readiness",
    );
    readinessMedia.push({
      type: "participant_readiness",
      sessionId: readinessOpened.sessionId,
      side: "A",
      timestampMonoMs: performance.now(),
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => readinessRelay.snapshot(readinessOpened.sessionId).status === "closed",
      "rejected participant readiness did not fail closed",
    );
    assert.equal(readinessRelay.snapshot(readinessOpened.sessionId).participantReadiness.A, undefined);

    const preflightMedia = new FakeMedia();
    const preflightRelay = makeRelay(
      preflightMedia,
      new FakeTranslation(),
      new RejectingRecorderPreflightEvidence(),
    );
    const preflightOpened = await preflightRelay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    for (const side of ["A", "B"] as const) {
      await preflightRelay.command(preflightOpened.sessionId, {
        type: "participant_consent",
        commandId: "rejected-preflight-consent-" + side,
        side,
        consentId: "rejected-preflight-consent-id-" + side,
        consentPolicyRef: preflightOpened.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      preflightMedia.push({
        type: "participant_state",
        sessionId: preflightOpened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      preflightMedia.push({
        type: "participant_readiness",
        sessionId: preflightOpened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => preflightRelay.snapshot(preflightOpened.sessionId).participantReadiness.A !== undefined &&
        preflightRelay.snapshot(preflightOpened.sessionId).participantReadiness.B !== undefined,
      "participants were not ready before rejected preflight",
    );
    await assert.rejects(
      preflightRelay.command(preflightOpened.sessionId, { type: "arm_recorder", commandId: "rejected-preflight" }),
      /Evidence rejected recorder preflight record/u,
    );
    await waitUntil(
      () => preflightRelay.snapshot(preflightOpened.sessionId).status === "closed",
      "rejected recorder preflight did not fail closed",
    );
    assert.equal(preflightRelay.snapshot(preflightOpened.sessionId).recorderPreflight, undefined);
  });

  it("does not publish readiness when its session state evidence cannot persist", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredSessionStateEvidence("ready", true);
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "ready-state-consent-" + side,
        side,
        consentId: "ready-state-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2 &&
        events.filter((event) => event.type === "participant_readiness").length === 2,
      "participants were not ready for the readiness durability check",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "ready-state-arm" });

    await evidence.waitForSessionStatePersist();
    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    assert.equal(events.some((event) => event.type === "session_state" && event.status === "ready"), false);
    evidence.releaseSessionStatePersist();
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "undurable ready state did not trigger the evidence failure shutdown",
    );
    await collector;
    assert.equal(events.some((event) => event.type === "session_state" && event.status === "ready"), false);
  });

  it("requires side-bound consent, connections, and a flushed recorder arm before a room is ready", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredFlushEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    assert.equal(relay.snapshot(snapshot.sessionId).recorderArmState, "awaiting_consents");

    await assert.rejects(
      relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "consent-a-wrong-policy",
        side: "A",
        consentId: "consent-id-a",
        consentPolicyRef: {
          ...snapshot.spec.processingManifest.consentPolicyRef,
          sha256: "b".repeat(64),
        },
        recording: true,
        processing: true,
      }),
      /does not match processing manifest/u,
    );

    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "consent-a",
      side: "A",
      consentId: "consent-id-a",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    assert.equal(relay.snapshot(snapshot.sessionId).participantConsent.A.consented, true);
    assert.equal(relay.snapshot(snapshot.sessionId).participantConsent.B.consented, false);

    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "consent-b",
      side: "B",
      consentId: "consent-id-b",
      consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
    assert.equal(relay.snapshot(snapshot.sessionId).recorderArmState, "unarmed");
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    const participantStates: Array<Extract<SessionEvent, { type: "participant_state" }>> = [];
    for await (const event of relay.events(snapshot.sessionId)) {
      if (event.type !== "participant_state" || !event.connected) continue;
      participantStates.push(event);
      if (participantStates.length === 2) break;
    }
    assert.deepEqual(participantStates.map((event) => event.side), ["A", "B"]);
    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    assert.equal(relay.snapshot(snapshot.sessionId).recordingArmed, false);

    const arm = relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "arm-recorder" });
    await evidence.waitForFlush();
    assert.equal(relay.snapshot(snapshot.sessionId).status, "waiting");
    assert.equal(relay.snapshot(snapshot.sessionId).recorderArmState, "arming");
    assert.deepEqual(
      evidence.records
        .filter((record) => record.type === "recorder_track_armed")
        .map((record) => record.track),
      EVIDENCE_AUDIO_TRACKS,
    );
    assert.deepEqual(evidence.flushes, [snapshot.sessionId]);

    evidence.releaseFlush();
    await arm;
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "provider preparation did not complete after recorder arming",
    );
    assert.equal(relay.snapshot(snapshot.sessionId).recorderArmState, "armed");
    assert.equal(relay.snapshot(snapshot.sessionId).recordingArmed, true);

    const consentEvents: Array<Extract<SessionEvent, { type: "participant_consent" }>> = [];
    for await (const event of relay.events(snapshot.sessionId)) {
      if (event.type !== "participant_consent") continue;
      consentEvents.push(event);
      if (consentEvents.length === 2) break;
    }
    assert.deepEqual(consentEvents.map((event) => event.side), ["A", "B"]);
    assert.deepEqual(
      evidence.records
        .filter((record) => record.type === "session_event")
        .map((record) => record.event)
        .filter((event) => event.type === "participant_consent")
        .map((event) => event.side),
      ["A", "B"],
    );

    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-consent" });
  });

  it("bounds incomplete ordinary commands while preserving idempotent joins and priority withdrawal", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredFlushEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const opened = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    for (const side of ["A", "B"] as const) {
      await relay.command(opened.sessionId, {
        type: "participant_consent",
        commandId: "command-cap-consent-" + side,
        side,
        consentId: "command-cap-consent-id-" + side,
        consentPolicyRef: opened.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: opened.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
    }
    await waitUntil(
      () => evidence.records.filter(
        (record) => record.type === "session_event" && record.event.type === "participant_state",
      ).length === 2,
      "participants did not connect before command-cap arm",
    );
    const arm = relay.command(opened.sessionId, { type: "arm_recorder", commandId: "command-cap-arm" });
    await evidence.waitForFlush();

    const queuedPauses = Array.from({ length: 14 }, (_value, index) =>
      relay.command(opened.sessionId, { type: "pause", commandId: "command-cap-pause-" + index }),
    );
    let replaySettled = false;
    const replay = relay.command(opened.sessionId, { type: "pause", commandId: "command-cap-pause-0" });
    void replay.then(
      () => {
        replaySettled = true;
      },
      () => {
        replaySettled = true;
      },
    );
    await Promise.resolve();
    assert.equal(replaySettled, false, "same-id command replay consumed a new admission slot");
    await assert.rejects(
      relay.command(opened.sessionId, { type: "pause", commandId: "command-cap-overflow" }),
      (error: unknown) =>
        error instanceof RelaySessionError &&
        error.code === "invalid_command" &&
        error.message === "Session command queue is busy",
    );

    const withdrawal = relay.command(opened.sessionId, {
      type: "participant_consent_withdrawal",
      commandId: "command-cap-priority-withdrawal",
      side: "A",
      consentId: "command-cap-consent-id-A",
      withdrawalId: "command-cap-withdrawal-id-A",
      withdrawnAtMonoMs: performance.now(),
    });
    const withdrawalReplay = relay.command(opened.sessionId, {
      type: "participant_consent_withdrawal",
      commandId: "command-cap-priority-withdrawal-replay",
      side: "A",
      consentId: "command-cap-consent-id-A",
      withdrawalId: "command-cap-withdrawal-id-A",
      withdrawnAtMonoMs: 0,
    });
    await Promise.resolve();
    assert.equal(relay.snapshot(opened.sessionId).participantConsent.A.consented, false);
    await waitUntil(
      () => media.clears.length >= 2,
      "priority withdrawal did not cut playout while the ordinary command queue was full",
    );

    evidence.releaseFlush();
    await assert.rejects(arm, /Cannot complete recorder arming/u);
    await Promise.allSettled([...queuedPauses, replay, withdrawal, withdrawalReplay]);
    await assert.rejects(
      relay.command(opened.sessionId, { type: "pause", commandId: "command-cap-after-settlement" }),
      (error: unknown) =>
        error instanceof RelaySessionError &&
        error.code === "invalid_command" &&
        error.message !== "Session command queue is busy",
    );
  });

  it("preflights the manifest-bound recorder before arm and seals evidence once for concurrent ends", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredFinalizationEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);

    assert.equal(evidence.preflightRequests.length, 1);
    const preflightRequest = evidence.preflightRequests[0]!;
    assert.equal(preflightRequest.sessionId, "session-1");
    assert.equal(
      preflightRequest.processingManifestSha256,
      relay.snapshot("session-1").spec.processingManifest.manifestSha256,
    );
    assert.equal("minimumFreeBytes" in (preflightRequest as object), false);

    const preflightIndex = evidence.records.findIndex(
      (record) => record.type === "recorder_preflight",
    );
    const armIndex = evidence.records.findIndex(
      (record) => record.type === "recorder_track_armed",
    );
    assert.ok(preflightIndex >= 0);
    assert.ok(preflightIndex < armIndex);

    const firstEnd = relay.command("session-1", {
      type: "end",
      commandId: "concurrent-end-a",
    });
    await evidence.waitForFinalization();
    const secondEnd = relay.command("session-1", {
      type: "end",
      commandId: "concurrent-end-b",
    });
    evidence.releaseFinalization();
    await Promise.all([firstEnd, secondEnd]);
    await collector;

    assert.equal(evidence.finalizeRequests.length, 1);
    const persisted = evidence.records
      .filter((record): record is Extract<EvidenceRecord, { type: "session_event" }> =>
        record.type === "session_event",
      )
      .map((record) => record.event);
    assert.equal(
      evidence.finalizeRequests[0]!.lastPersistedEventCursor,
      persisted.at(-1)?.cursor,
    );
    assert.equal(persisted.some((event) => event.type === "session_closed"), false);
    const closed = events.filter(
      (event): event is Extract<SessionEvent, { type: "session_closed" }> =>
        event.type === "session_closed",
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.finalization.status, "sealed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "sealed");
  });

  it("fails closed when recorder preflight cannot establish authoritative evidence", async () => {
    const media = new FakeMedia();
    const evidence = new FailedPreflightEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "preflight-consent-" + side,
        side,
        consentId: "preflight-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "participants did not connect before recorder preflight",
    );

    await assert.rejects(
      relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "failed-preflight" }),
      /Recorder preflight failed/u,
    );
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "failed recorder preflight did not close the session",
    );
    await collector;

    assert.equal(
      evidence.records.some((record) => record.type === "recorder_track_armed"),
      false,
    );
    assert.equal(evidence.finalizeRequests.length, 1);
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
    );
  });

  it("accepts only a participant's own durable consent withdrawal and ends immediately", async () => {
    const preConsentRelay = makeRelay(new FakeMedia(), new FakeTranslation(), new FakeEvidence());
    const unopened = await preConsentRelay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    await assert.rejects(
      preConsentRelay.command(unopened.sessionId, {
        type: "participant_consent_withdrawal",
        commandId: "withdraw-before-consent",
        side: "A",
        consentId: "not-yet-consented",
        withdrawalId: "withdrawal-before-consent",
        withdrawnAtMonoMs: 1,
      }),
      /consent/u,
    );
    await preConsentRelay.command(unopened.sessionId, { type: "end", commandId: "end-unopened" });

    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-before-withdrawal" });
    const consentA = relay.snapshot("session-1").participantConsent.A;
    const consentB = relay.snapshot("session-1").participantConsent.B;

    await assert.rejects(
      relay.command("session-1", {
        type: "participant_consent_withdrawal",
        commandId: "withdraw-wrong-consent",
        side: "A",
        consentId: "wrong-consent-id",
        withdrawalId: "withdrawal-wrong-consent",
        withdrawnAtMonoMs: 10,
      }),
      /consentId/u,
    );

    const withdrawal = {
      type: "participant_consent_withdrawal" as const,
      side: "A" as const,
      consentId: consentA.consentId!,
      withdrawalId: "withdrawal-a-001",
      withdrawnAtMonoMs: 11,
    };
    await relay.command("session-1", { ...withdrawal, commandId: "withdraw-a" });
    await relay.command("session-1", { ...withdrawal, commandId: "withdraw-a-replay" });
    await assert.rejects(
      relay.command("session-1", {
        ...withdrawal,
        commandId: "withdraw-a-conflict",
        withdrawalId: "withdrawal-a-002",
      }),
      /withdrawal/u,
    );
    await collector;

    const closed = relay.snapshot("session-1");
    assert.equal(closed.status, "closed");
    assert.equal(closed.participantConsent.A.consented, false);
    assert.equal(closed.participantConsent.A.withdrawalId, withdrawal.withdrawalId);
    assert.equal(closed.participantConsent.B.consentId, consentB.consentId);
    assert.equal(closed.participantConsent.B.withdrawalId, undefined);
    const withdrawals = events.filter(
      (event): event is Extract<SessionEvent, { type: "participant_consent_withdrawal" }> =>
        event.type === "participant_consent_withdrawal",
    );
    assert.equal(withdrawals.length, 1);
    assert.equal(withdrawals[0]!.terminal, true);
    const withdrawalIndex = events.findIndex((event) => event.type === "participant_consent_withdrawal");
    const closingIndex = events.findIndex(
      (event) => event.type === "session_state" && event.status === "closing",
    );
    assert.ok(withdrawalIndex >= 0 && withdrawalIndex < closingIndex);
    assert.equal(
      evidence.records.some((record) =>
        record.type === "session_event" && record.event.type === "participant_consent_withdrawal"
      ),
      true,
    );
  });

  it("reserves withdrawal ingress and playout shutdown before its evidence receipt settles", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new DeferredWithdrawalEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-before-deferred-withdrawal" });
    const consentId = relay.snapshot("session-1").participantConsent.A.consentId!;
    let acknowledged = false;
    const withdrawal = relay.command("session-1", {
      type: "participant_consent_withdrawal",
      commandId: "deferred-withdrawal",
      side: "A",
      consentId,
      withdrawalId: "deferred-withdrawal-id",
      withdrawnAtMonoMs: 200,
    });
    void withdrawal.then(() => {
      acknowledged = true;
    });

    await evidence.waitForWithdrawalPersist();
    await Promise.resolve();
    assert.equal(acknowledged, false, "withdrawal was acknowledged before its receipt was durable");
    assert.equal(relay.snapshot("session-1").participantConsent.A.consented, false);
    await waitUntil(
      () => media.clears.length >= 2 && translation.cancelled.length >= 2,
      "withdrawal did not immediately cut both translation directions",
    );
    const capturedBeforeBlockedIngress = translation.captured.length;
    media.push(audioEvent("B", 0));
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "post-withdrawal ingress was not consumed",
    );
    assert.equal(
      translation.captured.length,
      capturedBeforeBlockedIngress,
      "post-withdrawal audio reached translation before the receipt became durable",
    );

    evidence.releaseWithdrawalPersist();
    await withdrawal;
    assert.equal(relay.snapshot("session-1").status, "closed");
    await collector;
  });

  it("fences a terminal withdrawal reservation across participants", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredWithdrawalEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-withdrawal-fence" });
    const snapshot = relay.snapshot("session-1");
    const withdrawalA = relay.command("session-1", {
      type: "participant_consent_withdrawal",
      commandId: "withdrawal-fence-a",
      side: "A",
      consentId: snapshot.participantConsent.A.consentId!,
      withdrawalId: "withdrawal-fence-a-id",
      withdrawnAtMonoMs: 201,
    });
    await evidence.waitForWithdrawalPersist();

    await assert.rejects(
      relay.command("session-1", {
        type: "participant_consent_withdrawal",
        commandId: "withdrawal-fence-b",
        side: "B",
        consentId: snapshot.participantConsent.B.consentId!,
        withdrawalId: "withdrawal-fence-b-id",
        withdrawnAtMonoMs: 202,
      }),
      /withdrawal.*progress|closing|closed/iu,
    );
    assert.equal(relay.snapshot("session-1").participantConsent.B.withdrawalId, undefined);
    assert.equal(
      events.filter((event) => event.type === "participant_consent_withdrawal").length,
      0,
      "the deferred withdrawal was published before durability",
    );

    evidence.releaseWithdrawalPersist();
    await withdrawalA;
    await collector;
    assert.equal(
      events.filter((event) => event.type === "participant_consent_withdrawal").length,
      1,
      "a second participant withdrawal crossed the terminal reservation fence",
    );
    assert.equal(
      events.filter((event) => event.type === "session_closed").at(-1)?.reason,
      "participant_consent_withdrawal",
    );
  });

  it("prioritizes withdrawal ingress shutdown over a blocked ordinary state command", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new DeferredSessionStateEvidence("paused", false);
    const relay = makeRelay(media, translation, evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-before-priority-withdrawal" });
    const pause = relay.command("session-1", { type: "pause", commandId: "blocked-pause" });
    await evidence.waitForSessionStatePersist();

    const consentId = relay.snapshot("session-1").participantConsent.A.consentId!;
    let withdrawalAcknowledged = false;
    const withdrawal = relay.command("session-1", {
      type: "participant_consent_withdrawal",
      commandId: "priority-withdrawal",
      side: "A",
      consentId,
      withdrawalId: "priority-withdrawal-id",
      withdrawnAtMonoMs: 300,
    });
    void withdrawal.then(() => {
      withdrawalAcknowledged = true;
    });

    await Promise.resolve();
    assert.equal(relay.snapshot("session-1").participantConsent.A.consented, false);
    assert.equal(withdrawalAcknowledged, false, "withdrawal bypassed its pending evidence receipt");
    await waitUntil(
      () => media.clears.length >= 2 && translation.cancelled.length >= 2,
      "priority withdrawal did not cut active ingress before the blocked pause completed",
    );
    const capturedBeforeBlockedIngress = translation.captured.length;
    media.push(audioEvent("A", 0));
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "priority withdrawal ingress sample was not consumed",
    );
    assert.equal(
      translation.captured.length,
      capturedBeforeBlockedIngress,
      "audio was accepted while the prior status command still held the command tail",
    );

    evidence.releaseSessionStatePersist();
    await pause;
    await withdrawal;
    assert.equal(relay.snapshot("session-1").status, "closed");
    await collector;
  });

  it("ends the session when authoritative recorder arming records are rejected", async () => {
    const media = new FakeMedia();
    const evidence = new RejectingRecorderArmEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "failed-arm-consent-" + side,
        side,
        consentId: "failed-arm-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
    }
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "participants did not connect before recorder-arm evidence failure",
    );

    await assert.rejects(
      relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "failed-arm" }),
      /Evidence rejected recorder arm records/u,
    );
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "recorder-arm evidence rejection did not close the session",
    );
    await collector;

    assert.equal(relay.snapshot(snapshot.sessionId).status, "closed");
    assert.equal(relay.snapshot(snapshot.sessionId).recordingArmed, false);
    assert.deepEqual(
      evidence.finalizeRequests.map((request) => request.sessionId),
      [snapshot.sessionId],
    );
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_backpressure"),
      false,
    );
  });

  it("ends the session when the authoritative recorder flush fails", async () => {
    const media = new FakeMedia();
    const evidence = new FailingFlushEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "flush-failure-consent-" + side,
        side,
        consentId: "flush-failure-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "participants did not connect before flush failure",
    );

    await assert.rejects(
      relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "flush-failure-arm" }),
      /recorder flush failed/u,
    );
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "recorder flush failure did not close the session",
    );
    await collector;

    assert.equal(relay.snapshot(snapshot.sessionId).status, "closed");
    assert.equal(relay.snapshot(snapshot.sessionId).recordingArmed, false);
    assert.deepEqual(
      evidence.finalizeRequests.map((request) => request.sessionId),
      [snapshot.sessionId],
    );
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
    );
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_backpressure"),
      false,
    );
  });

  it("does not arm a recorder after an end wins a deferred flush race", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredFlushEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "arm-race-consent-" + side,
        side,
        consentId: "arm-race-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "participants did not connect before the recorder race",
    );

    const arm = relay.command(snapshot.sessionId, {
      type: "arm_recorder",
      commandId: "arm-race-arm",
    });
    await evidence.waitForFlush();
    await relay.command(snapshot.sessionId, { type: "end", commandId: "arm-race-end" });
    evidence.releaseFlush();

    await assert.rejects(arm, /Cannot complete recorder arming/u);
    const closed = relay.snapshot(snapshot.sessionId);
    assert.equal(closed.status, "closed");
    assert.equal(closed.recordingArmed, false);
    assert.notEqual(closed.recorderArmState, "armed");
    assert.equal(
      events.some((event) => event.type === "recorder_state" && event.state === "armed"),
      false,
    );
    await collector;
  });

  it("rejects provider, mode, and glossary capability mismatches before opening a session", async () => {
    const media = new FakeMedia();
    const baseSpec = testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    });
    const mismatchRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      providerId: "openai_native",
    }), new FakeEvidence());
    await assert.rejects(mismatchRelay.open(baseSpec), /provider does not match/u);

    const unsupportedRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      modes: [
        {
          mode: "fast",
          behaviorVersion: 1,
          state: "unsupported",
          deterministicGlossary: false,
          reason: "fixture unsupported",
        },
        { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
        { mode: "accurate", behaviorVersion: 1, state: "native", deterministicGlossary: true },
      ],
    }), new FakeEvidence());
    await assert.rejects(unsupportedRelay.open(baseSpec), /fast is unsupported/u);

    const accurateRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      modes: [
        { mode: "fast", behaviorVersion: 1, state: "native", deterministicGlossary: false },
        { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
        { mode: "accurate", behaviorVersion: 1, state: "native", deterministicGlossary: false },
      ],
      supportsDeterministicGlossary: false,
    }), new FakeEvidence());
    const accurateSnapshot = await accurateRelay.open(testSessionSpec({
      sideA: baseSpec.sideA,
      sideB: baseSpec.sideB,
      provider: "openai_controlled",
      mode: "accurate",
    }));
    await accurateRelay.command(accurateSnapshot.sessionId, {
      type: "end",
      commandId: "end-accurate",
    });

    const glossaryRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      modes: [
        { mode: "fast", behaviorVersion: 1, state: "native", deterministicGlossary: false },
        { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
        { mode: "accurate", behaviorVersion: 1, state: "native", deterministicGlossary: false },
      ],
      supportsDeterministicGlossary: false,
    }), new FakeEvidence());
    await assert.rejects(glossaryRelay.open(testSessionSpec({
      sideA: baseSpec.sideA,
      sideB: baseSpec.sideB,
      provider: "openai_controlled",
      mode: "accurate",
      glossary: {
        id: "terms",
        version: "v1",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        entries: [{ id: "part", source: "part", aliases: [], targetExact: "component" }],
      },
    })), /cannot authorize a deterministic glossary/u);
  });

  it("prepares both lanes before ready, then lets Start activate without a second preparation", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    assert.deepEqual(translation.prepared.map((context) => context.lane).sort(), ["A_TO_B", "B_TO_A"]);
    const readyIndex = events.findIndex((event) => event.type === "session_state" && event.status === "ready");
    const lastProviderReadinessIndex = events.reduce(
      (index, event, current) => event.type === "provider_readiness" ? current : index,
      -1,
    );
    assert.ok(lastProviderReadinessIndex < readyIndex);
    await relay.command("session-1", { type: "start", commandId: "start-prepare" });
    await waitUntil(() => events.some((event) => event.type === "session_state" && event.status === "active"), "active event was not observed");
    assert.equal(translation.prepared.length, 2, "Start must not prepare providers twice");
    const activeIndex = events.findIndex((event) => event.type === "session_state" && event.status === "active");
    assert.ok(activeIndex > readyIndex);
    await relay.command("session-1", { type: "end", commandId: "end-prepare" });
    await collector;
    assert.ok(translation.closedSessions.includes("session-1"));
  });

  it("fails closed when automatic lane preparation fails", async () => {
    const media = new FakeMedia();
    const translation = new PrepareFailureTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "prepare-failure-consent-" + side,
        side,
        consentId: "prepare-failure-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2 &&
        events.filter((event) => event.type === "participant_readiness").length === 2,
      "participants were not ready for automatic preparation",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "prepare-failure-arm" });
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "provider preparation failure did not close the session",
    );
    assert.equal(events.some((event) => event.type === "session_state" && event.status === "ready"), false);
    assert.equal(events.some((event) => event.type === "provider_readiness"), false);
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "translation_prepare_failed"),
      true,
    );
    const preparationAlert = evidence.records.find(
      (record): record is Extract<EvidenceRecord, { type: "session_event" }> & {
        event: Extract<SessionEvent, { type: "alert" }>;
      } =>
        record.type === "session_event" &&
        record.event.type === "alert" &&
        record.event.alert.code === "translation_prepare_failed",
    );
    assert.equal(preparationAlert?.event.alert.message, "Translation provider preparation failed");
    assert.equal(JSON.stringify(preparationAlert).includes(CONFIDENTIAL_PROVIDER_NAME), false);
    assert.equal(JSON.stringify(preparationAlert).includes(CONFIDENTIAL_PROVIDER_PATH), false);
    assert.equal(JSON.stringify(preparationAlert).includes(CONFIDENTIAL_PROVIDER_TOKEN), false);
    assert.ok(translation.closedSessions.includes("session-1"));
    await collector;
  });

  it("runs the idempotent operator lifecycle and records state", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "start", commandId: "start-1" });
    await relay.command("session-1", { type: "start", commandId: "start-1" });
    await waitUntil(
      () => events.some((event) => event.type === "session_state" && event.status === "active"),
      "active state was not observed",
    );
    assert.equal(
      events.filter((event) => event.type === "session_state" && event.status === "active").length,
      1,
    );

    await relay.command("session-1", { type: "pause", commandId: "pause-1" });
    await waitUntil(() => media.clears.length === 2, "pause did not clear both playout lanes");
    await relay.command("session-1", { type: "resume", commandId: "resume-1" });
    await relay.command("session-1", { type: "end", commandId: "end-1" });
    await collector;

    assert.equal(events.at(-1)?.type, "session_closed");
    assert.deepEqual(evidence.finalizeRequests.map((request) => request.sessionId), ["session-1"]);
    assert.equal(
      evidence.records.some(
        (record) =>
          record.type === "session_event" &&
          record.event.type === "session_state" &&
          record.event.status === "closed",
      ),
      true,
    );
  });

  it("runs translation cleanup when media cleanup throws synchronously", async () => {
    const media = new ThrowingCleanupMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "end", commandId: "end-sync-media-cleanup" });
    await collector;

    assert.deepEqual(translation.closedSessions, ["session-1"]);
    assert.equal(relay.snapshot("session-1").status, "closed");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "sealed");
    const cleanupAlert = events.find(
      (event): event is Extract<SessionEvent, { type: "alert" }> =>
        event.type === "alert" && event.alert.code === "media_cleanup_failed",
    );
    assert.equal(cleanupAlert?.alert.message, "Media cleanup failed");
  });

  it("ends an active session when authoritative source recording cannot be persisted", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new ThrowingSourceAudioEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-evidence-record-failure" });

    media.push(audioEvent("A", 0));

    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "evidence record failure did not close the active session",
    );
    await collector;

    assert.deepEqual(translation.captured, []);
    assert.deepEqual(media.played.B, []);
    assert.deepEqual(media.closedSessions, ["session-1"]);
    assert.deepEqual(translation.closedSessions, ["session-1"]);
    const alerts = events.filter(
      (event): event is Extract<SessionEvent, { type: "alert" }> => event.type === "alert",
    );
    const evidenceAlerts = alerts.filter(
      (event) => event.alert.code === "evidence_store_failed",
    );
    assert.equal(alerts.length, 1);
    assert.equal(evidenceAlerts.length, 1);
    assert.equal(
      evidenceAlerts[0]!.alert.message,
      "Authoritative evidence storage failed; ending session",
    );
    assert.doesNotMatch(evidenceAlerts[0]!.alert.message, /source audio writer failed/u);
    assert.equal(events.some((event) => event.type === "session_closed"), true);
    assert.equal(
      events.find((event) => event.type === "session_closed")?.finalization.status,
      "FINALIZATION_FAILED",
      "the relay must reject a sealed finalization after evidence persistence fails",
    );
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "FINALIZATION_FAILED");
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_backpressure"),
      false,
    );
    assert.equal(
      evidence.records.some((record) =>
        record.type === "session_event" &&
        record.event.type === "alert" &&
        record.event.alert.code === "evidence_store_failed"
      ),
      false,
    );
  });

  it("waits for source durability before forwarding, advancing the persisted cursor, or claiming success", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new DeferredRejectingSourceAudioEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-delayed-source-durability" });
    await waitUntil(
      () => events.some(
        (event) => event.type === "session_state" && event.status === "active",
      ),
      "active state was not durably published before source ingress",
    );
    const persistedCursorBeforeSource = relay.snapshot("session-1").eventCursor;

    media.push(audioEvent("A", 0));
    await evidence.waitForSourcePersist();
    assert.deepEqual(translation.captured, [], "source reached the provider before durable persistence");
    assert.deepEqual(media.played.B, [], "source reached playout before durable persistence");
    assert.equal(
      evidence.records.some((record) => record.type === "audio" && record.track === "source_a"),
      false,
      "the delayed source record was falsely treated as durable",
    );

    evidence.rejectSourcePersist();
    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "delayed source durability rejection did not fail closed",
    );
    await collector;

    assert.equal(evidence.finalizeRequests.length, 1, "durability rejection must terminate once");
    assert.equal(
      events.find((event) => event.type === "session_closed")?.finalization.status,
      "FINALIZATION_FAILED",
      "a rejecting evidence port must report a failed finalization",
    );
    assert.equal(
      evidence.finalizeRequests[0]?.lastPersistedEventCursor,
      persistedCursorBeforeSource,
      "a rejected source record advanced the persisted evidence cursor",
    );
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
      "durability rejection must produce one fail-closed alert",
    );
  });

  it("does not forward a source frame after its generation changes during durable persistence", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new DeferredSuccessfulSourceAudioEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-stale-source-persist" });

    media.push(audioEvent("A", 0));
    await evidence.waitForSourcePersist();
    await relay.command("session-1", { type: "pause", commandId: "pause-during-source-persist" });
    await relay.command("session-1", { type: "resume", commandId: "resume-after-source-persist" });
    evidence.releaseSourcePersist();

    await waitUntil(
      () => evidence.records.some((record) => record.type === "audio" && record.track === "source_a"),
      "the deferred source record did not become durable",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(translation.captured.length, 0, "the stale source frame reached translation after its generation changed");
    assert.equal(media.played.B.length, 0, "the stale source frame reached playout after its generation changed");

    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "a current-generation source frame was not forwarded");
    assert.deepEqual(
      translation.captured.map((frame) => ({ generation: frame.generation, sequence: frame.sequence })),
      [{ generation: 1, sequence: 1 }],
    );

    await relay.command("session-1", { type: "end", commandId: "end-stale-source-persist" });
    await collector;
  });

  it("retries rejected command IDs and rejects conflicting reuse", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();

    const start = { type: "start", commandId: "retryable-id" } as const;
    await assert.rejects(
      relay.command(snapshot.sessionId, start),
      (error: unknown) =>
        error instanceof RelaySessionError && error.code === "invalid_command",
    );

    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "retry-consent-" + side,
        side,
        consentId: "retry-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
    }
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2,
      "participants did not connect after consent",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "retry-arm-recorder" });
    await waitUntil(
      () => events.some((event) => event.type === "session_state" && event.status === "ready"),
      "session did not become ready after recorder arm",
    );

    await relay.command(snapshot.sessionId, start);
    await assert.rejects(
      relay.command(snapshot.sessionId, {
        type: "pause",
        commandId: start.commandId,
      }),
      (error: unknown) =>
        error instanceof RelaySessionError &&
        error.code === "invalid_command" &&
        /different command/u.test(error.message),
    );

    await relay.command(snapshot.sessionId, {
      type: "end",
      commandId: "end-retry-test",
    });
    await collector;
    assert.equal(
      events.filter((event) =>
        event.type === "session_state" && event.status === "active"
      ).length,
      1,
    );
  });

  it("closes event streams even when evidence finalization fails", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FailingFinalizationEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "start", commandId: "start-close-failure" });
    await relay.command("session-1", { type: "end", commandId: "end-close-failure" });
    await collector;

    assert.deepEqual(evidence.finalizeRequests.map((request) => request.sessionId), ["session-1"]);
    assert.deepEqual(media.closedSessions, ["session-1"]);
    assert.ok(events.some((event) => event.type === "session_closed"));
    const closed = events.find(
      (event): event is Extract<SessionEvent, { type: "session_closed" }> =>
        event.type === "session_closed",
    );
    assert.equal(closed?.finalization.status, "FINALIZATION_FAILED");
    assert.equal(relay.snapshot("session-1").evidenceFinalization?.status, "FINALIZATION_FAILED");
  });

  it("routes each lane independently and captures four-track evidence", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-2" });

    const speechStartedAtMs = performance.now() - 100;
    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: speechStartedAtMs,
    });
    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 1, "A-to-B audio was not played");
    assert.equal(media.played.B[0]?.lane, "A_TO_B");
    const firstAudio = events.find(
      (event) => event.type === "audio_playout" && event.lane === "A_TO_B",
    );
    assert.equal(firstAudio?.type, "audio_playout");
    if (firstAudio?.type === "audio_playout") assert.ok(firstAudio.latencyMs >= 90);
    assert.equal(
      evidence.records.some((record) => record.type === "audio" && record.track === "source_a"),
      true,
    );
    assert.equal(
      evidence.records.some((record) => record.type === "audio" && record.track === "playout_to_b"),
      true,
    );

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(() => media.clears.some((clear) => clear.lane === "A_TO_B"), "barge-in did not clear");
    assert.equal(translation.cancelled.some((cancelled) => cancelled.lane === "A_TO_B"), true);

    media.push(audioEvent("A", 2));
    await waitUntil(() => media.played.B.length === 2, "post-cut audio was not played");
    assert.equal(media.played.B[1]?.generation, 1);

    await relay.command("session-1", { type: "end", commandId: "end-2" });
    await collector;
  });

  it("correlates each segment's first durable audible ACK without repeating generation latency", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new TwoSegmentPlayoutTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-played-segments" });

    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 2, "both segment frames were not played");
    await waitUntil(
      () => events.filter((event) => event.type === "playout_lag").length === 2,
      "both segment played transitions were not durable",
    );
    const played = events.filter(
      (event): event is Extract<SessionEvent, { type: "playout_lag" }> =>
        event.type === "playout_lag" && event.scope === "server_to_audible_ack",
    );
    assert.deepEqual(
      played.map((event) => ({
        turnId: event.turnId,
        segmentId: event.segmentId,
        revision: event.revision,
        lane: event.lane,
        generation: event.generation,
      })),
      [
        {
          turnId: played[0]?.turnId,
          segmentId: "target-segment-one",
          revision: 1,
          lane: "A_TO_B",
          generation: 0,
        },
        {
          turnId: played[1]?.turnId,
          segmentId: "target-segment-two",
          revision: 1,
          lane: "A_TO_B",
          generation: 0,
        },
      ],
    );
    assert.equal(new Set(played.map((event) => event.turnId)).size, 1);
    assert.equal(
      events.filter((event) => event.type === "audio_playout" && event.lane === "A_TO_B").length,
      1,
      "first-audio latency must remain once per generation",
    );

    await relay.command("session-1", { type: "end", commandId: "end-played-segments" });
    await collector;
  });

  it("does not publish an audible played transition after a generation cut overtakes deferred playout durability", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredPlayoutAudioEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-deferred-played" });

    evidence.blockPlayoutAudio();
    media.push(audioEvent("A", 1));
    await evidence.waitForPlayoutPersist();
    assert.equal(events.some((event) => event.type === "playout_lag"), false);

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(
      () => media.clears.some((clear) => clear.lane === "A_TO_B"),
      "deferred playout did not receive a generation cut",
    );
    evidence.releasePlayoutPersist();
    await waitUntil(
      () => evidence.records.some(
        (record) => record.type === "audio" && record.track === "playout_to_b",
      ),
      "deferred playout evidence did not settle",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      events.some((event) => event.type === "playout_lag"),
      false,
      "a stale audible ACK must not publish a played transition",
    );
    assert.equal(
      events.some((event) => event.type === "audio_playout"),
      false,
      "a stale audible ACK must not publish first-audio transition",
    );

    await relay.command("session-1", { type: "end", commandId: "end-deferred-played" });
    await collector;
  });

  it("bounds audible ACK work per generation while allowing a post-cut generation", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredPlayoutAudioEvidence();
    const relay = makeRelay(media, new BurstPlayoutTranslation(), evidence);
    const { events, collector } = await readySession(relay, media, "fast", undefined, 128);
    await relay.command("session-1", { type: "start", commandId: "start-bounded-playout-acks" });

    evidence.blockPlayoutAudio();
    media.push(audioEvent("A", 1));
    await evidence.waitForPlayoutPersist();
    await waitUntil(
      () => media.played.B.length >= 40,
      "playout flood did not reach the media adapter while the first ACK was stalled",
    );

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(
      () => media.clears.some((clear) => clear.lane === "A_TO_B"),
      "post-cut generation was not created while the prior ACK remained blocked",
    );
    evidence.releasePlayoutPersist();
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "playout_evidence_backpressure"),
      "playout evidence cap did not reject excess audible acknowledgements",
    );
    const firstGenerationAlerts = events.filter(
      (event) => event.type === "alert" && event.alert.code === "playout_evidence_backpressure",
    );
    assert.equal(firstGenerationAlerts.length, 1, "backpressure alert must be deduplicated per generation");
    media.push(audioEvent("A", 2));
    await waitUntil(
      () => media.played.B.some((frame) => frame.generation === 1),
      "current-generation audio did not continue after the ACK cut",
    );
    await waitUntil(
      () => events.filter((event) => event.type === "alert" && event.alert.code === "playout_evidence_backpressure").length === 2,
      "current-generation ACK cap did not remain bounded independently",
    );
    const alertsByGeneration = events.filter(
      (event) => event.type === "alert" && event.alert.code === "playout_evidence_backpressure",
    );
    assert.equal(
      new Set(alertsByGeneration.map((event) => `${event.lane}:${event.generation}`)).size,
      2,
    );

    await relay.command("session-1", { type: "end", commandId: "end-bounded-playout-acks" });
    await collector;
  });

  it("records source and playout sequence gaps before accepting the forward frame", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-sequence-gaps" });

    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 1, "initial frame did not reach playout");
    media.push(audioEvent("A", 3));
    await waitUntil(() => media.played.B.length === 2, "forward-jump frame did not reach playout");

    const gaps = events.filter(
      (event): event is Extract<SessionEvent, { type: "sequence_gap" }> => event.type === "sequence_gap",
    );
    assert.deepEqual(
      gaps.map((event) => ({
        stream: event.stream,
        lane: event.lane,
        expectedSequence: event.expectedSequence,
        actualSequence: event.actualSequence,
        missingCount: event.missingCount,
      })),
      [
        {
          stream: "source",
          lane: "A_TO_B",
          expectedSequence: 2,
          actualSequence: 3,
          missingCount: 1,
        },
        {
          stream: "playout",
          lane: "A_TO_B",
          expectedSequence: 2,
          actualSequence: 3,
          missingCount: 1,
        },
      ],
    );
    assert.equal(gaps.some((event) => "text" in event), false);
    assert.equal(
      evidence.records.filter(
        (record) => record.type === "session_event" && record.event.type === "sequence_gap",
      ).length,
      2,
    );

    await relay.command("session-1", { type: "end", commandId: "end-sequence-gaps" });
    await collector;
  });

  it("serializes audible ACK timelines across deferred evidence so a forward jump is recorded once", async () => {
    const media = new FakeMedia();
    const evidence = new DeferredPlayoutAudioEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-serialized-playout-gap" });

    evidence.blockPlayoutAudio();
    media.push(audioEvent("A", 1));
    media.push(audioEvent("A", 3));
    media.push(audioEvent("A", 4));
    await evidence.waitForPlayoutPersist();
    evidence.releasePlayoutPersist();
    await waitUntil(() => media.played.B.length === 3, "serialized playout frames were not played");
    await waitUntil(
      () => events.filter(
        (event) => event.type === "sequence_gap" && event.stream === "playout",
      ).length === 1,
      "serialized playout gap was duplicated or lost",
    );
    const playoutGaps = events.filter(
      (event): event is Extract<SessionEvent, { type: "sequence_gap" }> =>
        event.type === "sequence_gap" && event.stream === "playout",
    );
    assert.deepEqual(
      playoutGaps.map((event) => [event.expectedSequence, event.actualSequence, event.missingCount]),
      [[2, 3, 1]],
    );

    await relay.command("session-1", { type: "end", commandId: "end-serialized-playout-gap" });
    await collector;
  });

  it("commits a controlled utterance at the VAD speech boundary", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media, "accurate", TERMINOLOGY_GLOSSARY);
    await relay.command("session-1", { type: "start", commandId: "start-batch" });

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    media.push(audioEvent("A", 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(media.played.B.length, 0);

    media.push({
      type: "speech_ended",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(() => media.played.B.length === 1, "controlled utterance was not committed");
    assert.equal(translation.completedBatches[0]?.length, 1);
    assert.ok(events.some((event) => event.type === "glossary_bound"));
    assert.ok(events.some((event) => event.type === "glossary_authorized"));

    await relay.command("session-1", { type: "end", commandId: "end-batch" });
    await collector;
  });

  it("uses the accurate behavior buffer budget when no queue limit is explicitly configured", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media, "accurate", undefined, null);
    await relay.command("session-1", { type: "start", commandId: "start-accurate-buffer" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    for (let sequence = 1; sequence <= 26; sequence += 1) media.push(audioEvent("A", sequence));
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    await waitUntil(() => translation.completedBatches.length === 1, "accurate utterance was not committed");
    assert.equal(translation.completedBatches[0]?.length, 26);

    await relay.command("session-1", { type: "end", commandId: "end-accurate-buffer" });
    await collector;
  });

  it("pins the approved glossary pair in both translation directions", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const glossary: GlossarySpec = {
      id: "manufacturing",
      version: "v1",
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
      entries: [{
        id: "spindle",
        source: "spindle",
        aliases: ["main spindle"],
        targetExact: "main shaft",
      }],
    };
    const { collector } = await readySession(
      relay,
      media,
      "accurate",
      glossary,
    );
    await relay.command("session-1", { type: "start", commandId: "start-directions" });

    const speak = async (side: Side, sequence: number, expectedBatches: number) => {
      media.push({
        type: "speech_started",
        sessionId: "session-1",
        side,
        timestampMonoMs: performance.now(),
      });
      media.push(audioEvent(side, sequence));
      media.push({
        type: "speech_ended",
        sessionId: "session-1",
        side,
        timestampMonoMs: performance.now(),
      });
      await waitUntil(
        () => translation.completedBatches.length === expectedBatches,
        "directional utterance was not completed",
      );
    };

    await speak("A", 1, 1);
    await speak("B", 1, 2);
    assert.equal(translation.contexts[0]?.glossary?.sourceLanguage, "en-US");
    assert.equal(translation.contexts[0]?.glossary?.targetLanguage, "zh-TW");
    assert.equal(translation.contexts[1]?.glossary?.sourceLanguage, "zh-TW");
    assert.equal(translation.contexts[1]?.glossary?.targetLanguage, "en-US");
    assert.equal(translation.contexts[1]?.glossary?.entries[0]?.source, "main shaft");
    assert.equal(translation.contexts[1]?.glossary?.entries[0]?.targetExact, "spindle");
    assert.equal(translation.contexts[0]?.glossary?.hash, translation.contexts[1]?.glossary?.hash);
    assert.deepEqual(
      translation.contexts[0]?.glossary?.entries.map((entry) => entry.id),
      translation.contexts[1]?.glossary?.entries.map((entry) => entry.id),
    );

    await relay.command("session-1", { type: "end", commandId: "end-directions" });
    await collector;
  });

  it("rejects terminology events without the lane's approved glossary hash and opaque entry ids", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new InvalidTerminologyProvenanceTranslation(), evidence);
    const { events, collector } = await readySession(relay, media, "accurate", TERMINOLOGY_GLOSSARY);
    await relay.command("session-1", { type: "start", commandId: "start-invalid-terminology" });
    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 0));
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    await waitUntil(
      () => evidence.records.filter((record) => record.type === "translation_rejected").length === 2,
      "invalid terminology provenance was not durably rejected",
    );
    assert.equal(events.some((event) => event.type === "glossary_authorized"), false);
    assert.deepEqual(
      evidence.records
        .filter((record): record is Extract<EvidenceRecord, { type: "translation_rejected" }> =>
          record.type === "translation_rejected",
        )
        .map((record) => [record.reason, record.identity.evidenceRef]),
      [
        ["unknown_identity", "terminology:invalid-hash"],
        ["unknown_identity", "terminology:invalid-entry"],
      ],
    );

    await relay.command("session-1", { type: "end", commandId: "end-invalid-terminology" });
    await collector;

    const missingMedia = new FakeMedia();
    const missingEvidence = new FakeEvidence();
    const missingRelay = makeRelay(missingMedia, new InvalidTerminologyProvenanceTranslation(), missingEvidence);
    const missing = await readySession(missingRelay, missingMedia);
    await missingRelay.command("session-1", { type: "start", commandId: "start-missing-glossary" });
    missingMedia.push(audioEvent("A", 0));
    await waitUntil(
      () => missingEvidence.records.filter((record) => record.type === "translation_rejected").length === 2,
      "terminology without a glossary was not durably rejected",
    );
    assert.equal(missing.events.some((event) => event.type === "glossary_authorized"), false);
    await missingRelay.command("session-1", { type: "end", commandId: "end-missing-glossary" });
    await missing.collector;
  });

  it("fails closed on a translation adapter event with an invalid lane", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new InvalidLaneTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-invalid-lane" });
    media.push(audioEvent("A", 0));
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "invalid_translation_lane"),
      "invalid translation lane was not rejected",
    );
    assert.equal(events.some((event) => event.type === "source_transcript"), false);
    media.push({
      type: "audio",
      sessionId: "session-1",
      side: "INVALID" as unknown as Side,
      timestampMonoMs: performance.now(),
      frame: createAudioFrame({
        ...audioEvent("A", 2).frame,
        lane: "A_TO_B",
        generation: 0,
      }),
    });
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "invalid_media_side"),
      "invalid media side was not rejected",
    );
    assert.equal(media.played.B.length, 0, "invalid media side must not default to destination B");
    await relay.command("session-1", { type: "end", commandId: "end-invalid-lane" });
    await collector;
  });

  it("uses the local generation fence as authority over late provider audio", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation(true);
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-3" });

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "translator did not receive the old frame");
    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(
      () => media.clears.some((clear) => clear.lane === "A_TO_B"),
      "generation was not cut",
    );
    translation.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(media.played.B.length, 0);

    media.push(audioEvent("A", 2));
    await waitUntil(() => media.played.B.length === 1, "new generation did not resume");
    assert.equal(media.played.B[0]?.generation, 1);

    await relay.command("session-1", { type: "end", commandId: "end-3" });
    await collector;
  });

  it("starts a fresh same-generation turn after speech end while the prior adapter is still draining", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation(true);
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-back-to-back" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "first utterance did not reach the adapter");
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 2));
    await waitUntil(() => translation.captured.length === 2, "second utterance was lost behind the closed input");
    translation.release();
    await waitUntil(() => media.played.B.length === 1, "second utterance did not produce playout");
    assert.equal(media.played.B[0]?.sequence, 2);

    await relay.command("session-1", { type: "end", commandId: "end-back-to-back" });
    await collector;
  });

  it("keeps reused adapter segment IDs independent across same-generation turns", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new SegmentReuseTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-segment-reuse" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(
      () => events.some((event) => event.type === "source_transcript" && event.text === "turn 1"),
      "first reused segment was not emitted",
    );
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 2));
    await waitUntil(
      () => events.some((event) => event.type === "source_transcript" && event.text === "turn 2"),
      "second reused segment was suppressed by the first turn finality",
    );
    const source = events.filter(
      (event): event is SessionEvent & { type: "source_transcript"; text: string; turnId: string } =>
        event.type === "source_transcript",
    );
    assert.deepEqual(source.map((event) => event.text), ["turn 1", "turn 2"]);
    assert.notEqual(source[0]?.turnId, source[1]?.turnId);

    await relay.command("session-1", { type: "end", commandId: "end-segment-reuse" });
    await collector;
  });

  it("rejects audio whose target transcript identity is missing or at a terminal revision", async () => {
    for (const [name, targetSegmentId, audioRevision, reason] of [
      ["missing", "target-missing", 1, "unknown_identity"],
      ["wrong-revision", "target-0", 2, "terminal_revision"],
    ] as const) {
      const media = new FakeMedia();
      const evidence = new FakeEvidence();
      const relay = makeRelay(media, new InvalidAudioTargetTranslation(targetSegmentId, audioRevision), evidence);
      const { collector } = await readySession(relay, media);
      await relay.command("session-1", { type: "start", commandId: "start-invalid-audio-target-" + name });
      media.push(audioEvent("A", 1));
      await waitUntil(
        () => evidence.records.some(
          (record) => record.type === "translation_rejected" && record.reason === reason,
        ),
        "invalid audio target identity was not durably rejected",
      );
      assert.equal(media.played.B.length, 0);
      await relay.command("session-1", { type: "end", commandId: "end-invalid-audio-target-" + name });
      await collector;
    }
  });

  it("replaces transcript segments, makes final revisions terminal, and drops stale audio sequences", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new RevisionTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-revisions" });
    media.push(audioEvent("A", 1));

    await waitUntil(() => media.played.B.length === 2, "ordered audio was not played");
    const source = events.filter(
      (event): event is SessionEvent & { type: "source_transcript"; text: string; revision: number } =>
        event.type === "source_transcript",
    );
    assert.deepEqual(source.map((event) => event.text), ["hel", "hello"]);
    assert.deepEqual(source.map((event) => event.revision), [0, 1]);
    assert.deepEqual(media.played.B.map((frame) => frame.sequence), [1, 2]);

    await relay.command("session-1", { type: "end", commandId: "end-revisions" });
    await collector;
  });

  it("keeps provisional transcripts live while persisting final provenance and evidence-only rejections", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new DiagnosticTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-diagnostics" });
    media.push(audioEvent("A", 0));

    await waitUntil(
      () => events.some((event) => event.type === "source_transcript" && event.text === "final") &&
        media.played.B.length === 1,
      "diagnostic provider output was not handled",
    );

    const visibleSource = events.filter(
      (event): event is SessionEvent & {
        type: "source_transcript";
        text: string;
        final: boolean;
        evidenceRef?: string;
      } =>
        event.type === "source_transcript",
    );
    assert.deepEqual(visibleSource.map((event) => event.text), ["draft", "final"]);
    assert.equal(visibleSource[0]?.final, false);
    assert.equal(visibleSource[0]?.evidenceRef, "provider:source-draft");
    assert.equal(visibleSource[1]?.evidenceRef, "provider:source-final");

    const persistedEvents = evidence.records
      .filter((record): record is Extract<EvidenceRecord, { type: "session_event" }> =>
        record.type === "session_event",
      )
      .map((record) => record.event);
    assert.equal(
      persistedEvents.some((event) =>
        event.type === "source_transcript" && event.text === "draft"
      ),
      false,
    );
    assert.equal(
      persistedEvents.some((event) =>
        event.type === "source_transcript" &&
        event.text === "final" &&
        event.evidenceRef === "provider:source-final"
      ),
      true,
    );
    assert.equal(
      persistedEvents.some((event) =>
        event.type === "audio_playout" && event.evidenceRef === "provider:audio-accepted"
      ),
      true,
    );

    const rejected = evidence.records.filter(
      (record): record is Extract<EvidenceRecord, { type: "translation_rejected" }> =>
        record.type === "translation_rejected",
    );
    assert.deepEqual(
      rejected.map((record) => [record.reason, record.identity.evidenceRef]),
      [
        ["terminal_revision", "provider:terminal-revision"],
        ["stale_playout_sequence", "provider:audio-stale"],
        ["adapter_tombstone", "provider:tombstone"],
      ],
    );
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "translation_rejected"),
      false,
    );

    await relay.command("session-1", { type: "end", commandId: "end-diagnostics" });
    await collector;
  });

  it("keeps glossary provenance durable without copying confidential targets into terminology evidence", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new ProvisionalTerminologyTranslation(), evidence);
    const { events, collector } = await readySession(relay, media, "accurate", TERMINOLOGY_GLOSSARY);
    await relay.command("session-1", { type: "start", commandId: "start-provisional-terminology" });
    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 0));
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    await waitUntil(
      () => events.some((event) => event.type === "glossary_bound") &&
        events.some((event) => event.type === "glossary_authorized") &&
        events.some((event) => event.type === "glossary_bypassed") &&
        events.some((event) =>
          event.type === "target_transcript" && event.evidenceRef === "target:canonical-output"
        ),
      "terminology events were not emitted live",
    );
    assert.equal(
      events.some((event) =>
        event.type === "glossary_bound" && event.evidenceRef === "terminology:bound-provisional"
      ),
      true,
    );
    const persisted = evidence.records
      .filter((record): record is Extract<EvidenceRecord, { type: "session_event" }> =>
        record.type === "session_event",
      )
      .map((record) => record.event);
    assert.equal(
      persisted.some((event) =>
        event.type === "glossary_bound" && event.evidenceRef === "terminology:bound-provisional"
      ),
      false,
    );
    assert.equal(
      persisted.some((event) =>
        event.type === "glossary_authorized" && event.evidenceRef === "terminology:authorized-final"
      ),
      true,
    );
    const terminologyEvidence = persisted.filter((event) =>
      event.type === "glossary_authorized" || event.type === "glossary_bypassed",
    );
    assert.equal(terminologyEvidence.length, 2);
    for (const event of terminologyEvidence) {
      assert.equal("text" in event, false);
      assert.equal("guaranteedTargetExact" in event, false);
    }
    assert.equal(JSON.stringify(terminologyEvidence).includes(CONFIDENTIAL_GLOSSARY_TARGET), false);
    assert.equal(JSON.stringify(terminologyEvidence).includes(CONFIDENTIAL_GLOSSARY_BYPASS_TARGET), false);
    assert.equal(
      persisted.some((event) =>
        event.type === "target_transcript" &&
        event.evidenceRef === "target:canonical-output" &&
        event.text === CONFIDENTIAL_GLOSSARY_TARGET
      ),
      true,
    );

    await relay.command("session-1", { type: "end", commandId: "end-provisional-terminology" });
    await collector;
  });

  it("keeps encrypted terminology records free of confidential glossary targets", async () => {
    const { root, evidence, lease } = await encryptedRelayEvidenceStore("terminology-redaction");
    try {
      const media = new FakeMedia();
      const relay = makeRelay(media, new ProvisionalTerminologyTranslation(), evidence);
      const { events, collector } = await readySession(
        relay,
        media,
        "accurate",
        TERMINOLOGY_GLOSSARY,
        10,
        false,
        10_000,
      );
      await relay.command("session-1", { type: "start", commandId: "start-encrypted-terminology" });
      media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
      media.push(audioEvent("A", 0));
      media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

      await waitUntil(
        () => events.some((event) =>
          event.type === "target_transcript" &&
          event.evidenceRef === "target:canonical-output" &&
          event.text === CONFIDENTIAL_GLOSSARY_TARGET
        ),
        "canonical target output was not delivered live",
        10_000,
      );
      await relay.command("session-1", { type: "end", commandId: "end-encrypted-terminology" });
      await collector;

      const descriptor = await evidence.artifact({ sessionId: "session-1" });
      assert.notEqual(descriptor, undefined);
      if (descriptor === undefined) throw new Error("encrypted terminology fixture has no artifact");
      assert.equal(descriptor.status, "sealed");
      const ciphertext = await readFile(descriptor.archivePath, "utf8");
      assert.doesNotMatch(ciphertext, /SENTINEL_CONFIDENTIAL_GLOSSARY_TARGET/u);
      assert.doesNotMatch(ciphertext, /SENTINEL_CONFIDENTIAL_GLOSSARY_BYPASS_TARGET/u);

      const replayedRecords: EvidenceRecord[] = [];
      const review = await evidence.withVerifiedSealedReviewLease({
        kind: "retention_summary",
        sessionId: "session-1",
        actor: {
          role: "retention_owner",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      }, async (lease) => {
        for await (const record of lease.records()) replayedRecords.push(record);
        return { value: null, responseSha256: TEST_SHA256 };
      });
      assert.equal(review.status, "completed");
      const opened = replayedRecords.find(
        (record): record is Extract<EvidenceRecord, { type: "session_event" }> & Readonly<{
          readonly event: Extract<SessionEvent, { type: "session_opened" }>;
        }> => record.type === "session_event" && record.event.type === "session_opened",
      );
      assert.deepEqual(opened?.event.snapshot.spec.evidenceReviewGrant, TEST_EVIDENCE_REVIEW_GRANT);
      const terminologyRecords = replayedRecords
        .filter((record): record is Extract<EvidenceRecord, { type: "session_event" }> =>
          record.type === "session_event",
        )
        .map((record) => record.event)
        .filter((event) => event.type === "glossary_authorized" || event.type === "glossary_bypassed");
      assert.equal(terminologyRecords.length, 2);
      for (const event of terminologyRecords) {
        assert.equal("text" in event, false);
        assert.equal("guaranteedTargetExact" in event, false);
      }
      assert.equal(JSON.stringify(terminologyRecords).includes(CONFIDENTIAL_GLOSSARY_TARGET), false);
      assert.equal(JSON.stringify(terminologyRecords).includes(CONFIDENTIAL_GLOSSARY_BYPASS_TARGET), false);
      assert.equal(
        replayedRecords.some((record) =>
          record.type === "session_event" &&
          record.event.type === "target_transcript" &&
          record.event.evidenceRef === "target:canonical-output" &&
          record.event.text === CONFIDENTIAL_GLOSSARY_TARGET,
        ),
        true,
      );
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps encrypted provider-error evidence free of raw provider diagnostics", async () => {
    const { root, evidence, lease } = await encryptedRelayEvidenceStore("provider-error-redaction");
    try {
      const media = new FakeMedia();
      const relay = makeRelay(media, new SensitiveProviderErrorTranslation(), evidence);
      const { events, collector } = await readySession(
        relay,
        media,
        "fast",
        undefined,
        10,
        false,
        10_000,
      );
      await relay.command("session-1", { type: "start", commandId: "start-encrypted-provider-error" });
      media.push(audioEvent("A", 0));
      await waitUntil(
        () => events.some(
          (event) => event.type === "alert" && event.alert.code === "UPSTREAM_TRANSLATION_FAILURE",
        ),
        "provider error alert was not emitted",
        10_000,
      );
      await relay.command("session-1", { type: "end", commandId: "end-encrypted-provider-error" });
      await collector;

      const descriptor = await evidence.artifact({ sessionId: "session-1" });
      assert.notEqual(descriptor, undefined);
      if (descriptor === undefined) throw new Error("encrypted provider-error fixture has no artifact");
      const ciphertext = await readFile(descriptor.archivePath, "utf8");
      assert.doesNotMatch(ciphertext, /SENTINEL_PROVIDER_NAME/u);
      assert.doesNotMatch(ciphertext, /SENTINEL_PROVIDER_PATH/u);
      assert.doesNotMatch(ciphertext, /SENTINEL_PROVIDER_TOKEN/u);

      const replayedRecords: EvidenceRecord[] = [];
      const review = await evidence.withVerifiedSealedReviewLease({
        kind: "retention_summary",
        sessionId: "session-1",
        actor: {
          role: "retention_owner",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      }, async (lease) => {
        for await (const record of lease.records()) replayedRecords.push(record);
        return { value: null, responseSha256: TEST_SHA256 };
      });
      assert.equal(review.status, "completed");
      const providerAlerts = replayedRecords
        .filter((record): record is Extract<EvidenceRecord, { type: "session_event" }> =>
          record.type === "session_event",
        )
        .map((record) => record.event)
        .filter(
          (event): event is Extract<SessionEvent, { type: "alert" }> =>
            event.type === "alert" && event.alert.code === "UPSTREAM_TRANSLATION_FAILURE",
        );
      assert.equal(providerAlerts.length, 1);
      assert.equal(providerAlerts[0]?.alert.message, "Translation provider reported an error");
      assert.equal(JSON.stringify(providerAlerts).includes(CONFIDENTIAL_PROVIDER_NAME), false);
      assert.equal(JSON.stringify(providerAlerts).includes(CONFIDENTIAL_PROVIDER_PATH), false);
      assert.equal(JSON.stringify(providerAlerts).includes(CONFIDENTIAL_PROVIDER_TOKEN), false);
    } finally {
      await lease.release();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("redacts caught translation, cancellation, and cleanup provider diagnostics", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new SensitiveProviderFailureTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-sensitive-provider-failures" });
    media.push(audioEvent("A", 0));
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "translation_failed"),
      "translation failure was not surfaced",
    );
    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(
      () => events.some(
        (event) => event.type === "barge_lifecycle" && event.stage === "provider_cancel_failed",
      ),
      "provider cancellation failure was not surfaced",
    );
    await relay.command("session-1", { type: "end", commandId: "end-sensitive-provider-failures" });
    await collector;

    const translationFailure = events.find(
      (event): event is Extract<SessionEvent, { type: "alert" }> =>
        event.type === "alert" && event.alert.code === "translation_failed",
    );
    const cancellationFailure = events.find(
      (event): event is Extract<SessionEvent, { type: "barge_lifecycle" }> =>
        event.type === "barge_lifecycle" && event.stage === "provider_cancel_failed",
    );
    const cleanupFailure = events.find(
      (event): event is Extract<SessionEvent, { type: "alert" }> =>
        event.type === "alert" && event.alert.code === "translation_cleanup_failed",
    );
    assert.equal(translationFailure?.alert.message, "Translation stream failed");
    assert.equal(cancellationFailure?.message, "Translation cancellation failed");
    assert.equal(cleanupFailure?.alert.message, "Translation cleanup failed");
    assert.equal(JSON.stringify(events).includes(CONFIDENTIAL_PROVIDER_NAME), false);
    assert.equal(JSON.stringify(events).includes(CONFIDENTIAL_PROVIDER_PATH), false);
    assert.equal(JSON.stringify(events).includes(CONFIDENTIAL_PROVIDER_TOKEN), false);
    assert.equal(JSON.stringify(evidence.records).includes(CONFIDENTIAL_PROVIDER_NAME), false);
    assert.equal(JSON.stringify(evidence.records).includes(CONFIDENTIAL_PROVIDER_PATH), false);
    assert.equal(JSON.stringify(evidence.records).includes(CONFIDENTIAL_PROVIDER_TOKEN), false);
  });

  it("forwards structured terminology metadata without promoting opaque evidence refs into alert payloads", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new StructuredAlertTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-structured-alerts" });
    media.push(audioEvent("A", 0));

    await waitUntil(
      () => events.some((event) =>
        event.type === "alert" && event.alert.code === "GLOSSARY_PLACEHOLDER_MISSING"
      ),
      "structured glossary alert was not forwarded",
    );
    media.push(audioEvent("A", 1));
    await waitUntil(
      () => events.some((event) =>
        event.type === "alert" && event.alert.code === "TRANSCRIPTION_LOW_CONFIDENCE"
      ),
      "structured confidence alert was not forwarded after the lane cut",
    );
    const alerts = events.filter(
      (event): event is Extract<SessionEvent, { type: "alert" }> => event.type === "alert",
    );
    const glossaryAlert = alerts.find((event) => event.alert.code === "GLOSSARY_PLACEHOLDER_MISSING");
    const lowConfidenceAlert = alerts.find((event) => event.alert.code === "TRANSCRIPTION_LOW_CONFIDENCE");
    assert.deepEqual(glossaryAlert?.alert, {
      code: "GLOSSARY_PLACEHOLDER_MISSING",
      message: "Translation provider reported an error",
      retryable: false,
    });
    assert.equal("evidenceRef" in (glossaryAlert?.alert ?? {}), false);
    assert.deepEqual(lowConfidenceAlert?.alert, {
      code: "TRANSCRIPTION_LOW_CONFIDENCE",
      message: "Translation provider reported an error",
      retryable: false,
      confidence: 0.42,
    });
    assert.equal("termId" in (lowConfidenceAlert?.alert ?? {}), false);
    assert.equal("evidenceRef" in (lowConfidenceAlert?.alert ?? {}), false);

    const persistedAlerts = evidence.records.filter(
      (record): record is Extract<EvidenceRecord, { type: "session_event" }> & {
        event: Extract<SessionEvent, { type: "alert" }>;
      } => record.type === "session_event" && record.event.type === "alert",
    );
    assert.deepEqual(
      persistedAlerts
        .filter((record) =>
          record.event.alert.code === "GLOSSARY_PLACEHOLDER_MISSING" ||
          record.event.alert.code === "TRANSCRIPTION_LOW_CONFIDENCE"
        )
        .map((record) => record.event.evidenceRef),
      ["provider:structured-glossary-alert", "provider:structured-confidence-alert"],
    );

    await relay.command("session-1", { type: "end", commandId: "end-structured-alerts" });
    await collector;
  });

  it("ends the session once when translation-rejection evidence cannot be persisted", async () => {
    const media = new FakeMedia();
    const evidence = new RejectingTranslationRejectionEvidence();
    const relay = makeRelay(media, new DiagnosticTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-rejection-backpressure" });
    media.push(audioEvent("A", 0));

    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "translation-rejection evidence failure did not close the session",
    );
    await collector;

    const alerts = events.filter(
      (event): event is Extract<SessionEvent, { type: "alert" }> => event.type === "alert",
    );
    assert.equal(
      alerts.filter((event) => event.alert.code === "evidence_store_failed").length,
      1,
    );
    assert.equal(
      alerts.some((event) => event.alert.code === "translation_rejected"),
      false,
    );
    assert.equal(
      evidence.records.some((record) => record.type === "translation_rejected"),
      false,
    );
    assert.equal(
      evidence.records.some((record) =>
        record.type === "session_event" &&
        record.event.type === "alert" &&
        record.event.alert.code === "evidence_store_failed"
      ),
      false,
    );
    assert.equal(
      alerts.some((event) => event.alert.code === "evidence_backpressure"),
      false,
    );
    assert.equal(relay.snapshot("session-1").status, "closed");
  });

  it("barge-in clears only the interrupted destination while both lanes remain capturable", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-barge-lanes" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 1, "A-to-B audio was not played");
    const beforeBargeIn = media.clears.length;

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(() => media.clears.length === beforeBargeIn + 1, "barge-in clear was not issued");
    assert.equal(media.clears.at(-1)?.lane, "A_TO_B");
    assert.equal(media.clears.at(-1)?.side, "B");

    media.push(audioEvent("A", 2));
    media.push(audioEvent("B", 1));
    await waitUntil(
      () => evidence.records.some((record) => record.type === "audio" && record.track === "source_b"),
      "B ingress was not captured after barge-in",
    );
    assert.equal(evidence.records.some((record) => record.type === "audio" && record.track === "source_a"), true);

    await relay.command("session-1", { type: "end", commandId: "end-barge-lanes" });
    await collector;
  });

  it("returns an active session to waiting on disconnect and requires fresh readiness plus Start after reconnect", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-reconnect-evidence" });

    media.push(audioEvent("A", 0));
    media.push(audioEvent("B", 0));
    await waitUntil(
      () => evidence.records.filter(
        (record) => record.type === "audio" && (record.track === "source_a" || record.track === "source_b"),
      ).length === 2,
      "initial source evidence was not captured",
    );

    media.push({ type: "participant_state", sessionId: "session-1", side: "A", timestampMonoMs: performance.now(), connected: false });
    await waitUntil(
      () => relay.snapshot("session-1").status === "waiting" &&
        relay.snapshot("session-1").participantReadiness.A === undefined &&
        media.clears.length >= 2 &&
        translation.cancelled.length >= 2,
      "active disconnect did not fence translation and return to waiting",
    );
    assert.deepEqual(relay.snapshot("session-1").providerReadiness, {
      A_TO_B: { readiness: "fixture_local", remoteConnection: "not_applicable" },
      B_TO_A: { readiness: "fixture_local", remoteConnection: "not_applicable" },
    });
    assert.equal(translation.prepared.length, 2, "disconnect must retain provider prewarm");
    const capturedBeforeRestart = translation.captured.length;
    media.push(audioEvent("B", 1, 1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(translation.captured.length, capturedBeforeRestart, "waiting session forwarded source audio");

    const reconnectAtMonoMs = performance.now() + 10_000;
    media.push({
      type: "participant_readiness",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: reconnectAtMonoMs - 1,
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    media.push({ type: "participant_state", sessionId: "session-1", side: "A", timestampMonoMs: reconnectAtMonoMs, connected: true });
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.side === "A" && event.connected).length === 2,
      "participant reconnect was not observed",
    );
    assert.equal(relay.snapshot("session-1").status, "waiting", "pre-reconnect readiness incorrectly restored ready");
    assert.equal(relay.snapshot("session-1").participantReadiness.A, undefined);
    const invalidReadinessBeforeDelayedReplay = events.filter(
      (event) => event.type === "alert" && event.alert.code === "invalid_participant_readiness",
    ).length;
    media.push({
      type: "participant_readiness",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: reconnectAtMonoMs - 1,
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => events.filter(
        (event) => event.type === "alert" && event.alert.code === "invalid_participant_readiness",
      ).length === invalidReadinessBeforeDelayedReplay + 1,
      "delayed old-connection readiness was accepted after reconnect",
    );
    assert.equal(relay.snapshot("session-1").status, "waiting");
    assert.equal(relay.snapshot("session-1").participantReadiness.A, undefined);
    media.push({
      type: "participant_readiness",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: reconnectAtMonoMs + 1,
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => relay.snapshot("session-1").status === "ready",
      "fresh reconnect readiness did not restore ready",
    );
    await assert.rejects(
      relay.command("session-1", { type: "resume", commandId: "resume-after-active-disconnect" }),
      (error: unknown) => error instanceof RelaySessionError && error.code === "invalid_command",
    );
    await relay.command("session-1", { type: "start", commandId: "restart-after-active-disconnect" });
    media.push(audioEvent("A", 0, 1));
    await waitUntil(
      () => evidence.records.filter((record) => record.type === "audio" && record.track === "source_a").length === 2,
      "reconnected source frame was not captured as evidence",
    );
    assert.equal(
      events.some(
        (event) => event.type === "alert" &&
          event.lane === "A_TO_B" &&
          event.alert.code === "invalid_source_sequence",
      ),
      false,
    );
    await waitUntil(
      () => translation.captured.length === capturedBeforeRestart + 1,
      "valid restarted source frame was not forwarded",
    );

    const capturedBeforeInvalidSequence = translation.captured.length;
    media.push(audioEvent("B", 0, 1));
    await waitUntil(
      () => evidence.records.filter((record) => record.type === "audio" && record.track === "source_b").length === 2,
      "new-generation B source frame was not captured",
    );
    media.push(audioEvent("B", 0, 1));
    await waitUntil(
      () => events.some(
        (event) => event.type === "alert" &&
          event.lane === "B_TO_A" &&
          event.alert.code === "invalid_source_sequence",
      ),
      "other participant source evidence cursor was reset",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      translation.captured.length,
      capturedBeforeInvalidSequence + 1,
      "a duplicate source sequence reached translation after evidence rejected it",
    );
    assert.equal(
      evidence.records.filter((record) => record.type === "audio" && record.track === "source_b").length,
      2,
    );

    await relay.command("session-1", { type: "end", commandId: "end-reconnect-evidence" });
    await collector;
  });

  it("returns a paused session to waiting and requires fresh readiness plus Start after reconnect", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-paused-reconnect" });
    media.push(audioEvent("A", 0));
    await waitUntil(() => translation.captured.length === 1, "active source frame was not forwarded before pause");

    await relay.command("session-1", { type: "pause", commandId: "pause-before-disconnect" });
    await waitUntil(
      () => relay.snapshot("session-1").status === "paused" && media.clears.length === 2 && translation.cancelled.length === 2,
      "pause did not fence both provider lanes",
    );
    const capturedBeforeDisconnect = translation.captured.length;
    const playedBeforeDisconnect = media.played.A.length + media.played.B.length;
    const providerReadiness = relay.snapshot("session-1").providerReadiness;

    media.push({ type: "participant_state", sessionId: "session-1", side: "B", timestampMonoMs: performance.now(), connected: false });
    await waitUntil(
      () => relay.snapshot("session-1").status === "waiting" &&
        relay.snapshot("session-1").participantReadiness.B === undefined,
      "paused disconnect did not return the session to waiting",
    );
    assert.deepEqual(relay.snapshot("session-1").providerReadiness, providerReadiness);
    assert.equal(translation.prepared.length, 2, "disconnect must retain provider prewarm");
    media.push(audioEvent("A", 1, 1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(translation.captured.length, capturedBeforeDisconnect, "waiting session forwarded paused source audio");
    assert.equal(media.played.A.length + media.played.B.length, playedBeforeDisconnect, "waiting session emitted playout");

    media.push({ type: "participant_state", sessionId: "session-1", side: "B", timestampMonoMs: performance.now(), connected: true });
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.side === "B" && event.connected).length === 2,
      "paused participant reconnect was not observed",
    );
    assert.equal(relay.snapshot("session-1").status, "waiting");
    media.push({
      type: "participant_readiness",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => relay.snapshot("session-1").status === "ready",
      "fresh paused reconnect readiness did not restore ready",
    );
    await assert.rejects(
      relay.command("session-1", { type: "resume", commandId: "resume-after-paused-disconnect" }),
      (error: unknown) => error instanceof RelaySessionError && error.code === "invalid_command",
    );
    await relay.command("session-1", { type: "start", commandId: "restart-after-paused-disconnect" });
    assert.equal(translation.prepared.length, 2, "restarting after reconnect must reuse provider prewarm");

    await relay.command("session-1", { type: "end", commandId: "end-paused-reconnect" });
    await collector;
  });

  it("applies the reconnect gate to both participants in active and paused sessions", async () => {
    for (const scenario of [
      { status: "active" as const, side: "A" as const },
      { status: "active" as const, side: "B" as const },
      { status: "paused" as const, side: "A" as const },
      { status: "paused" as const, side: "B" as const },
    ]) {
      const media = new FakeMedia();
      const translation = new FakeTranslation();
      const relay = makeRelay(media, translation, new FakeEvidence());
      const { events, collector } = await readySession(relay, media);
      await relay.command("session-1", {
        type: "start",
        commandId: "start-opposite-" + scenario.status + "-" + scenario.side,
      });
      if (scenario.status === "paused") {
        await relay.command("session-1", {
          type: "pause",
          commandId: "pause-opposite-" + scenario.side,
        });
      }

      media.push({
        type: "participant_state",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: performance.now(),
        connected: false,
      });
      await waitUntil(
        () => relay.snapshot("session-1").status === "waiting" &&
          relay.snapshot("session-1").participantReadiness[scenario.side] === undefined,
        scenario.status + " disconnect did not return " + scenario.side + " to waiting",
      );
      if (scenario.status === "active") {
        await waitUntil(
          () => media.clears.length === 2 && translation.cancelled.length === 2,
          "active opposite-side disconnect did not fence both lanes",
        );
      }
      assert.equal(translation.prepared.length, 2, "disconnect must retain provider prewarm");

      const reconnectAtMonoMs = performance.now() + 10_000;
      media.push({
        type: "participant_readiness",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: reconnectAtMonoMs - 1,
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
      media.push({
        type: "participant_state",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: reconnectAtMonoMs,
        connected: true,
      });
      await waitUntil(
        () => events.filter(
          (event) => event.type === "participant_state" && event.side === scenario.side && event.connected,
        ).length === 2,
        "reconnect was not observed for " + scenario.status + " " + scenario.side,
      );
      assert.equal(relay.snapshot("session-1").status, "waiting", "reconnect alone restored active availability");
      assert.equal(relay.snapshot("session-1").participantReadiness[scenario.side], undefined);
      const invalidStateBeforeDelayedReplay = events.filter(
        (event) => event.type === "alert" && event.alert.code === "invalid_participant_state",
      ).length;
      media.push({
        type: "participant_state",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: reconnectAtMonoMs - 1,
        connected: true,
      });
      await waitUntil(
        () => events.filter(
          (event) => event.type === "alert" && event.alert.code === "invalid_participant_state",
        ).length === invalidStateBeforeDelayedReplay + 1,
        "old participant state was accepted for " + scenario.status + " " + scenario.side,
      );
      assert.equal(relay.snapshot("session-1").participantReadiness[scenario.side], undefined);
      const invalidReadinessBeforeDelayedReplay = events.filter(
        (event) => event.type === "alert" && event.alert.code === "invalid_participant_readiness",
      ).length;
      media.push({
        type: "participant_readiness",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: reconnectAtMonoMs - 1,
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
      await waitUntil(
        () => events.filter(
          (event) => event.type === "alert" && event.alert.code === "invalid_participant_readiness",
        ).length === invalidReadinessBeforeDelayedReplay + 1,
        "delayed stale readiness was accepted for " + scenario.status + " " + scenario.side,
      );
      assert.equal(relay.snapshot("session-1").participantReadiness[scenario.side], undefined);
      media.push({
        type: "participant_readiness",
        sessionId: "session-1",
        side: scenario.side,
        timestampMonoMs: reconnectAtMonoMs + 1,
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
      await waitUntil(
        () => relay.snapshot("session-1").status === "ready",
        "fresh readiness did not restore ready for " + scenario.status + " " + scenario.side,
      );
      await relay.command("session-1", {
        type: "start",
        commandId: "restart-opposite-" + scenario.status + "-" + scenario.side,
      });
      assert.equal(relay.snapshot("session-1").status, "active");
      assert.equal(translation.prepared.length, 2, "restart must not prepare the opposite side twice");

      await relay.command("session-1", {
        type: "end",
        commandId: "end-opposite-" + scenario.status + "-" + scenario.side,
      });
      await collector;
    }
  });

  it("accepts one replayed ordinary disconnect clear acknowledgement without a barge lifecycle", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-ordinary-clear-replay" });

    media.push({ type: "participant_state", sessionId: "session-1", side: "B", timestampMonoMs: performance.now(), connected: false });
    await waitUntil(
      () => relay.snapshot("session-1").status === "waiting" &&
        media.clears.some((clear) => clear.lane === "A_TO_B" && clear.side === "B"),
      "disconnect did not issue an ordinary destination clear",
    );
    const clear = media.clears.find((candidate) => candidate.lane === "A_TO_B" && candidate.side === "B");
    assert.notEqual(clear, undefined);
    if (clear === undefined) throw new Error("ordinary reconnect clear was absent");

    media.push({ type: "participant_state", sessionId: "session-1", side: "B", timestampMonoMs: performance.now(), connected: true });
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.side === "B" && event.connected).length === 2,
      "destination reconnect was not observed",
    );
    const invalidAcknowledgementsBefore = events.filter(
      (event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack",
    ).length;
    for (const acknowledgement of [
      { lane: "B_TO_A" as const, generation: clear.generation, clearId: clear.clearId },
      { lane: clear.lane, generation: clear.generation + 1, clearId: clear.clearId },
      { lane: clear.lane, generation: clear.generation, clearId: "foreign-reconnect-clear" },
    ] as const) {
      media.push({
        type: "playout_cleared",
        sessionId: "session-1",
        side: "B",
        ...acknowledgement,
        timestampMonoMs: performance.now(),
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack").length ===
        invalidAcknowledgementsBefore + 3,
      "foreign reconnect clear fields were accepted",
    );
    assert.equal(events.some((event) => event.type === "barge_lifecycle"), false);
    media.push({
      type: "playout_cleared",
      sessionId: "session-1",
      side: "B",
      lane: clear.lane,
      generation: clear.generation,
      clearId: clear.clearId,
      timestampMonoMs: performance.now(),
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack").length,
      invalidAcknowledgementsBefore + 3,
      "the exact replayed ordinary clear acknowledgement was rejected",
    );
    assert.equal(events.some((event) => event.type === "barge_lifecycle"), false);

    media.push({
      type: "playout_cleared",
      sessionId: "session-1",
      side: "B",
      lane: clear.lane,
      generation: clear.generation,
      clearId: clear.clearId,
      timestampMonoMs: performance.now(),
    });
    await waitUntil(
      () => events.filter((event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack").length ===
        invalidAcknowledgementsBefore + 4,
      "duplicate replayed clear acknowledgement was not rejected",
    );

    await relay.command("session-1", { type: "end", commandId: "end-ordinary-clear-replay" });
    await collector;
  });

  it("clears a stalled destination and continues valid translation after a barge-in", async () => {
    const media = new StalledMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-stalled-playout" });

    for (let sequence = 1; sequence <= 10; sequence += 1) {
      media.push(audioEvent("A", sequence));
      await waitUntil(() => translation.captured.length >= sequence, "stalled playout did not receive source frames");
    }

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(() => media.clears.some((clear) => clear.lane === "A_TO_B"), "cut did not clear stalled destination");

    for (let sequence = 11; sequence <= 20; sequence += 1) {
      media.push(audioEvent("A", sequence));
      await waitUntil(() => translation.captured.length >= sequence, "post-cut frames were not translated");
    }

    await relay.command("session-1", { type: "end", commandId: "end-stalled-playout" });
    await collector;
  });

  it("records recorder preflight durably before arm proofs and surfaces participant and provider readiness", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    const rawPreflightIndex = evidence.records.findIndex((record) => record.type === "recorder_preflight");
    const emittedPreflightIndex = evidence.records.findIndex(
      (record) => record.type === "session_event" && record.event.type === "recorder_preflight",
    );
    const armProofIndex = evidence.records.findIndex((record) => record.type === "recorder_track_armed");
    assert.ok(rawPreflightIndex >= 0, "the preflight result must be durably recorded");
    assert.ok(emittedPreflightIndex > rawPreflightIndex, "the event follows the durable preflight record");
    assert.ok(armProofIndex > emittedPreflightIndex, "arm proofs follow the emitted preflight event");
    assert.equal(events.some((event) => event.type === "recorder_preflight"), true);

    await waitUntil(
      () => events.filter((event) => event.type === "participant_readiness").length === 2,
      "participant readiness was not emitted",
    );
    assert.deepEqual(relay.snapshot("session-1").participantReadiness.A, {
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
    await waitUntil(
      () => events.filter((event) => event.type === "provider_readiness").length === 2,
      "provider readiness was not emitted for both lanes",
    );
    assert.deepEqual(relay.snapshot("session-1").providerReadiness, {
      A_TO_B: { readiness: "fixture_local", remoteConnection: "not_applicable" },
      B_TO_A: { readiness: "fixture_local", remoteConnection: "not_applicable" },
    });
    const readyIndex = events.findIndex((event) => event.type === "session_state" && event.status === "ready");
    const lastProviderReadinessIndex = events.reduce(
      (index, event, current) => event.type === "provider_readiness" ? current : index,
      -1,
    );
    assert.ok(lastProviderReadinessIndex < readyIndex);

    await relay.command("session-1", { type: "end", commandId: "end-readiness" });
    await collector;
  });

  it("fails closed when a provider returns malformed readiness", async () => {
    const media = new FakeMedia();
    const translation = new InvalidPreparationTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const snapshot = await relay.open(testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    }));
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();
    for (const side of ["A", "B"] as const) {
      await relay.command(snapshot.sessionId, {
        type: "participant_consent",
        commandId: "malformed-preparation-consent-" + side,
        side,
        consentId: "malformed-preparation-consent-id-" + side,
        consentPolicyRef: snapshot.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
      media.push({
        type: "participant_readiness",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
    }
    await waitUntil(
      () => events.filter((event) => event.type === "participant_state" && event.connected).length === 2 &&
        events.filter((event) => event.type === "participant_readiness").length === 2,
      "participants were not ready for malformed preparation",
    );
    await relay.command(snapshot.sessionId, { type: "arm_recorder", commandId: "arm-malformed-preparation" });
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "closed",
      "malformed provider readiness did not close the session",
    );
    assert.equal(relay.snapshot(snapshot.sessionId).providerReadiness.A_TO_B, undefined);
    assert.equal(events.some((event) => event.type === "provider_readiness"), false);
    assert.equal(events.some((event) => event.type === "session_state" && event.status === "ready"), false);
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "translation_prepare_failed"),
      true,
    );
    await collector;
  });

  it("records bounded relay and browser queue telemetry plus server-to-audible playout lag", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-queue-telemetry" });

    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 2,
      capacityFrames: 8,
      bufferedAudioMs: 40,
      oldestQueuedAgeMs: 20,
    });
    media.push(audioEvent("A", 0));

    await waitUntil(
      () => events.some((event) => event.type === "queue_sample" && event.scope === "browser_playout") &&
        events.some((event) => event.type === "queue_sample" && event.scope === "relay_input") &&
        events.some((event) => event.type === "queue_sample" && event.scope === "relay_playout") &&
        events.some((event) => event.type === "playout_lag" && event.scope === "server_to_audible_ack"),
      "queue and playout telemetry was not emitted",
    );
    const browserSample = events.find(
      (event): event is Extract<SessionEvent, { type: "queue_sample" }> =>
        event.type === "queue_sample" && event.scope === "browser_playout",
    );
    assert.deepEqual(
      {
        lane: browserSample?.lane,
        generation: browserSample?.generation,
        side: browserSample?.side,
        depthFrames: browserSample?.depthFrames,
        capacityFrames: browserSample?.capacityFrames,
        bufferedAudioMs: browserSample?.bufferedAudioMs,
      },
      {
        lane: "A_TO_B",
        generation: 0,
        side: "B",
        depthFrames: 2,
        capacityFrames: 8,
        bufferedAudioMs: 40,
      },
    );

    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 0,
      capacityFrames: 8,
      bufferedAudioMs: 0,
    });
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "invalid_queue_sample"),
      "a browser queue sample for the wrong destination was accepted",
    );

    await relay.command("session-1", { type: "end", commandId: "end-queue-telemetry" });
    await collector;
  });

  it("hard-throttles browser queue samples across boundary transitions", async () => {
    let now = 1_000;
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence(), () => now);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-queue-throttle" });

    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 0,
      capacityFrames: 8,
      bufferedAudioMs: 0,
    });
    await waitUntil(
      () => media.pendingIngress("session-1") === 0 &&
        events.some((event) => event.type === "queue_sample" && event.scope === "browser_playout"),
      "initial browser boundary sample was not consumed",
    );
    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 8,
      capacityFrames: 8,
      bufferedAudioMs: 160,
    });
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "alternating boundary sample was not consumed",
    );
    assert.equal(
      events.filter((event) => event.type === "queue_sample" && event.scope === "browser_playout").length,
      1,
      "a full-queue boundary transition bypassed the hard telemetry rate limit",
    );

    now += 1_000;
    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 2,
      capacityFrames: 8,
      bufferedAudioMs: 40,
    });
    await waitUntil(
      () => events.filter((event) => event.type === "queue_sample" && event.scope === "browser_playout").length === 2,
      "the later browser queue state transition was not emitted",
    );

    await relay.command("session-1", { type: "end", commandId: "end-queue-throttle" });
    await collector;
  });

  it("re-emits unchanged queue telemetry after a generation cut", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-queue-generation" });

    const sample = (generation: number): MediaIngressEvent => ({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation,
      depthFrames: 2,
      capacityFrames: 8,
      bufferedAudioMs: 40,
    });
    media.push(sample(0));
    await waitUntil(
      () => events.filter((event) => event.type === "queue_sample" && event.scope === "browser_playout").length === 1,
      "initial browser queue sample was not emitted",
    );

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(
      () => relay.snapshot("session-1").generations.A_TO_B === 1,
      "barge cut did not advance the lane generation",
    );
    media.push(sample(1));
    await waitUntil(
      () => events.filter((event) => event.type === "queue_sample" && event.scope === "browser_playout").length === 2,
      "unchanged browser queue state was suppressed after a generation cut",
    );

    await relay.command("session-1", { type: "end", commandId: "end-queue-generation" });
    await collector;
  });

  it("drops browser queue telemetry when its single durable write is saturated", async () => {
    let now = 1_000;
    const media = new FakeMedia();
    const evidence = new DeferredQueueSampleEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence, () => now);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-queue-saturation" });

    for (let index = 0; index < 96; index += 1) {
      now += 100;
      const depthFrames = index % 2 === 0 ? 0 : 8;
      media.push({
        type: "queue_sample",
        sessionId: "session-1",
        side: "B",
        timestampMonoMs: performance.now(),
        scope: "browser_playout",
        lane: "A_TO_B",
        generation: 0,
        depthFrames,
        capacityFrames: 8,
        bufferedAudioMs: depthFrames * 20,
      });
    }
    await evidence.waitForQueueSamplePersist();
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "malicious browser queue telemetry was not consumed",
    );
    assert.equal(relay.snapshot("session-1").status, "active");
    assert.equal(
      evidence.queueSamplePersistAttempts,
      1,
      "saturated telemetry appended additional durable writes behind the first sample",
    );

    evidence.releaseQueueSamplePersist();
    await relay.command("session-1", { type: "end", commandId: "end-queue-saturation" });
    await collector;
    assert.equal(
      evidence.queueSamplePersistAttempts,
      1,
      "dropped telemetry was retained in the evidence operation backlog",
    );
  });

  it("bounds mixed evidence work and fails closed when persistence admission saturates", async () => {
    const media = new FakeMedia();
    const translation = new DeferredRejectedBurstTranslation();
    const evidence = new DeferredEvidenceOperationEvidence();
    const relay = makeRelay(media, translation, evidence, undefined, undefined, 100);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-evidence-admission-cap" });
    media.push(audioEvent("A", 0));
    await translation.waitForFrame();

    evidence.blockPersistence();
    translation.releaseBurst();
    await evidence.waitForPersist();
    await waitUntil(
      () => translation.emittedRejections === 8,
      "deferred rejected translation work did not reach the evidence admission fixture",
    );
    for (let index = 0; index < 48; index += 1) {
      const timestampMonoMs = performance.now() + index;
      switch (index % 3) {
        case 0:
          media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs });
          media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs });
          break;
        case 1:
          media.push({
            type: "participant_state",
            sessionId: "session-1",
            side: "A",
            timestampMonoMs,
            connected: true,
          });
          break;
        default:
          media.push({
            type: "playout_cleared",
            sessionId: "session-1",
            side: "B",
            timestampMonoMs,
            lane: "A_TO_B",
            generation: 0,
            clearId: "invalid-admission-ack-" + index,
          });
      }
    }
    await waitUntil(
      () => media.pendingIngress("session-1") === 0,
      "mixed ingress flood was not consumed",
    );
    await waitUntil(
      () => relay.snapshot("session-1").status === "closing" || relay.snapshot("session-1").status === "closed",
      "evidence admission saturation did not fail the session closed",
    );
    assert.ok(
      evidence.persistAttempts <= 63,
      "evidence admission accepted more than the bounded normal-operation budget",
    );

    evidence.releasePersistence();
    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "evidence admission failure did not finish terminal cleanup",
      10_000,
    );
    await collector;
    assert.equal(
      evidence.records.some((record) => record.type === "translation_rejected"),
      true,
      "translation rejection persistence was not admitted through the shared bound",
    );
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      1,
    );
    assert.ok(
      evidence.persistAttempts <= 63,
      "release drained more than the bounded normal-operation budget",
    );
  });

  it("admits one durable withdrawal ahead of ancillary cuts at the normal evidence boundary", async () => {
    const media = new FakeMedia();
    const translation = new DeferredRejectedBurstTranslation(62);
    const evidence = new DeferredEvidenceOperationEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-withdrawal-evidence-boundary" });
    media.push(audioEvent("A", 0));
    await translation.waitForFrame();
    evidence.blockPersistence();
    media.push({
      type: "queue_sample",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      scope: "browser_playout",
      lane: "A_TO_B",
      generation: 0,
      depthFrames: 1,
      capacityFrames: 8,
      bufferedAudioMs: 20,
      oldestQueuedAgeMs: 5,
    });
    translation.releaseBurst();
    await evidence.waitForPersist();
    await waitUntil(
      () => translation.emittedRejections === 62,
      "boundary rejection burst did not fill the normal evidence backlog",
    );

    const consentId = relay.snapshot("session-1").participantConsent.A.consentId!;
    let acknowledged = false;
    const withdrawal = relay.command("session-1", {
      type: "participant_consent_withdrawal",
      commandId: "withdrawal-evidence-boundary",
      side: "A",
      consentId,
      withdrawalId: "withdrawal-evidence-boundary-id",
      withdrawnAtMonoMs: 500,
    });
    void withdrawal.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    assert.equal(acknowledged, false, "withdrawal settled before its durable receipt completed");
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" && record.event.type === "participant_consent_withdrawal",
      ),
      false,
      "withdrawal was persisted synchronously instead of waiting for the evidence tail",
    );
    assert.equal(relay.snapshot("session-1").participantConsent.A.consented, false);

    evidence.releasePersistence();
    await withdrawal;
    await collector;
    assert.equal(
      evidence.records.filter(
        (record) => record.type === "session_event" && record.event.type === "participant_consent_withdrawal",
      ).length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "participant_consent_withdrawal").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "generation_cut" && event.reason === "end").length,
      2,
      "terminal withdrawal must retain both end generation cuts",
    );
    assert.equal(
      events.filter((event) => event.type === "session_state" && event.status === "closing").length,
      1,
      "terminal withdrawal must retain its closing state event",
    );
    assert.equal(
      events.filter((event) => event.type === "session_state" && event.status === "closed").length,
      1,
      "terminal withdrawal must retain its closed state event",
    );
    assert.equal(
      events.filter((event) => event.type === "alert" && event.alert.code === "evidence_store_failed").length,
      0,
      "terminal withdrawal must not fail evidence admission",
    );
    assert.equal(relay.snapshot("session-1").status, "closed");
    const cursors = events.map((event) => event.cursor);
    assert.deepEqual(
      [...cursors].sort((left, right) => left - right),
      [...new Set(cursors)].sort((left, right) => left - right),
      "priority and ordinary evidence events must not reuse an event cursor",
    );
  });

  it("dispatches barge playout clear before a stalling provider cancellation", async () => {
    const operations: string[] = [];
    const media = new BargeOrderingMedia(operations);
    const translation = new StallingCancelTranslation(operations);
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-barge-ordering" });
    media.push(audioEvent("A", 0));
    await waitUntil(() => media.played.B.length === 1, "initial A-to-B playout did not start for ordering");

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await translation.waitForCancel();
    assert.deepEqual(operations.slice(0, 2), ["media.clear", "translation.cancel"]);
    assert.equal(
      media.clears.some((clear) => clear.lane === "A_TO_B"),
      true,
      "browser playout clear was delayed behind the stalling provider cancellation",
    );

    translation.releaseCancel();
    await relay.command("session-1", { type: "end", commandId: "end-barge-ordering" });
    await collector;
  });

  it("fails closed when a barge playout clear is rejected", async () => {
    const media = new RejectingClearMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-rejected-clear" });
    media.push(audioEvent("A", 0));
    await waitUntil(() => media.played.B.length === 1, "initial audio did not reach playout");
    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(
      () => relay.snapshot("session-1").status === "closed",
      "rejected playout clear did not fail the session closed",
    );
    assert.equal(
      events.some((event) => event.type === "barge_lifecycle" && event.stage === "valid_output_resumed"),
      false,
      "a lane resumed after its playout clear was rejected",
    );
    const clearFailures = events.filter(
      (event): event is Extract<SessionEvent, { type: "barge_lifecycle" }> =>
        event.type === "barge_lifecycle" && event.stage === "playout_clear_failed",
    );
    assert.equal(clearFailures.length, 1, "clear rejection must have one durable lifecycle failure stage");
    assert.equal(
      events.findIndex((event) => event.type === "barge_lifecycle" && event.stage === "playout_clear_failed") <
        events.findIndex((event) => event.type === "alert" && event.alert.code === "evidence_store_failed"),
      true,
      "clear failure lifecycle must precede the evidence failure alert",
    );
    assert.equal(
      events.some((event) => event.type === "alert" && event.alert.code === "evidence_store_failed"),
      true,
    );
    await collector;
  });

  it("correlates barge-in cancellation, clear acknowledgement, and valid output resumption", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-barge-lifecycle" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 0));
    await waitUntil(() => media.played.B.length === 1, "initial A-to-B playout did not start");

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(
      () => media.clears.some((candidate) => candidate.lane === "A_TO_B"),
      "barge-in did not request a clear for the interrupted destination",
    );
    const clear = media.clears.find((candidate) => candidate.lane === "A_TO_B")!;
    await waitUntil(
      () => events.filter((event) => event.type === "barge_lifecycle").some(
        (event) => event.stage === "provider_cancel_settled",
      ),
      "provider cancellation outcome was not emitted",
    );

    const cut = events.find(
      (event): event is Extract<SessionEvent, { type: "generation_cut" }> =>
        event.type === "generation_cut" && event.clearId === clear.clearId,
    );
    assert.ok(cut?.bargeId, "barge generation cut must carry an opaque barge id");
    assert.match(clear.clearId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu);
    const stagesBeforeAck = events
      .filter(
        (event): event is Extract<SessionEvent, { type: "barge_lifecycle" }> =>
          event.type === "barge_lifecycle" && event.bargeId === cut?.bargeId,
      )
      .map((event) => event.stage);
    assert.deepEqual(stagesBeforeAck, [
      "speech_onset",
      "playout_clear_requested",
      "provider_cancel_requested",
      "provider_cancel_settled",
    ]);

    media.push({
      type: "playout_cleared",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
      lane: clear.lane,
      generation: clear.generation,
      clearId: clear.clearId,
    });
    await waitUntil(
      () => events.some((event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack"),
      "foreign clear acknowledgement was accepted",
    );
    assert.equal(
      events.some(
        (event) => event.type === "barge_lifecycle" &&
          event.bargeId === cut?.bargeId && event.stage === "playout_clear_acknowledged",
      ),
      false,
      "foreign acknowledgement must not settle the pending clear",
    );

    media.push({
      type: "playout_cleared",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      lane: clear.lane,
      generation: clear.generation,
      clearId: clear.clearId,
    });
    await waitUntil(
      () => events.some(
        (event) => event.type === "barge_lifecycle" &&
          event.bargeId === cut?.bargeId && event.stage === "playout_clear_acknowledged",
      ),
      "matching browser clear acknowledgement was not correlated",
    );

    const invalidAcknowledgements = events.filter(
      (event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack",
    ).length;
    media.push({
      type: "playout_cleared",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
      lane: clear.lane,
      generation: clear.generation,
      clearId: clear.clearId,
    });
    await waitUntil(
      () => events.filter(
        (event) => event.type === "alert" && event.alert.code === "invalid_playout_clear_ack",
      ).length === invalidAcknowledgements + 1,
      "duplicate clear acknowledgement was accepted",
    );

    media.push(audioEvent("A", 1));
    await waitUntil(
      () => events.some(
        (event) => event.type === "barge_lifecycle" &&
          event.bargeId === cut?.bargeId && event.stage === "valid_output_resumed",
      ),
      "first accepted new-generation playout did not resume the barge chain",
    );

    const lifecycleCount = events.filter((event) => event.type === "barge_lifecycle").length;
    await relay.command("session-1", { type: "pause", commandId: "pause-no-false-barge" });
    await waitUntil(
      () => events.some((event) => event.type === "generation_cut" && event.reason === "pause"),
      "pause generation cuts were not emitted",
    );
    assert.equal(
      events.filter((event) => event.type === "barge_lifecycle").length,
      lifecycleCount,
      "pause must not manufacture a barge lifecycle",
    );
    assert.equal(
      events.some((event) => event.type === "generation_cut" && event.reason === "pause" && event.clearId.length > 0),
      true,
      "non-barge cuts still carry a clear id",
    );

    await relay.command("session-1", { type: "end", commandId: "end-barge-lifecycle" });
    await collector;
  });

  it("keeps glossary-control bypass fail-open while emitting complete terminology provenance", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new ProvisionalTerminologyTranslation(), evidence);
    const { events, collector } = await readySession(relay, media, "accurate", TERMINOLOGY_GLOSSARY);
    await relay.command("session-1", { type: "start", commandId: "start-terminology-bypass" });
    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 0));
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    await waitUntil(
      () => events.some((event) => event.type === "glossary_bypassed"),
      "glossary bypass was not observable",
    );
    const bypass = events.find(
      (event): event is Extract<SessionEvent, { type: "glossary_bypassed" }> =>
        event.type === "glossary_bypassed",
    );
    assert.deepEqual(
      {
        segmentId: bypass?.segmentId,
        revision: bypass?.revision,
        final: bypass?.final,
        glossaryHash: bypass?.glossaryHash,
        entryIds: bypass?.entryIds,
      },
      {
        segmentId: "final-bypass",
        revision: 2,
        final: true,
        glossaryHash: TERMINOLOGY_COMPILED.hash,
        entryIds: [TERMINOLOGY_COMPILED.entries[0]!.id],
      },
    );
    assert.equal("text" in (bypass ?? {}), false);
    assert.equal("guaranteedTargetExact" in (bypass ?? {}), false);
    assert.equal(typeof bypass?.turnId, "string");
    assert.equal(
      evidence.records.some(
        (record) => record.type === "session_event" &&
          record.event.type === "glossary_bypassed" &&
          record.event.evidenceRef === "terminology:bypassed-final",
      ),
      true,
      "final bypass provenance must be preserved",
    );

    await relay.command("session-1", { type: "end", commandId: "end-terminology-bypass" });
    await collector;
  });

  it("bounds retained closed sessions while keeping the newest event history", async () => {
    const media = new FakeMedia();
    const sessionIds = ["closed-1", "closed-2"];
    const relay = new ModularGuardedDuplexRelay({
      media,
      translation: new FakeTranslation(),
      evidence: new FakeEvidence(),
      processingProfile: createSyntheticPocProcessingProfile(),
      closedSessionHistoryLimit: 1,
      createSessionId: () => sessionIds.shift() ?? "unexpected-session",
      endpointGrant: (sessionId, side) => ({
        kind: "browser_link",
        side,
        url: "https://demo.test/" + sessionId + "/" + side,
        qrDataUrl: "data:image/png;base64,AA==",
      }),
    });
    const spec = testSessionSpec({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "fast",
    });

    const first = await relay.open(spec);
    await relay.command(first.sessionId, { type: "end", commandId: "end-first" });
    const second = await relay.open(spec);
    await relay.command(second.sessionId, { type: "end", commandId: "end-second" });

    assert.throws(
      () => relay.events(first.sessionId),
      (error: unknown) =>
        error instanceof RelaySessionError && error.code === "invalid_session",
    );
    assert.doesNotThrow(() => relay.events(second.sessionId));
  });
});

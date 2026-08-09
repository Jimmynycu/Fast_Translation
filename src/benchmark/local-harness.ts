import { CANONICAL_AUDIO, createAudioFrame, destinationForLane, laneFromSource } from "../core/audio.js";
import { AsyncQueue } from "../core/async-queue.js";
import { compileGlossaryPair, type CompiledGlossary } from "../core/glossary.js";
import { ModularGuardedDuplexRelay } from "../core/relay.js";
import {
  resolveTranslationBehavior,
  type TranslationBehavior,
  type TranslationMode,
  type TranslationProviderId,
} from "../core/translation-behavior.js";
import type {
  AudioFrame,
  EvidenceAudioTrack,
  EvidenceFinalization,
  EvidencePort,
  EvidenceRecord,
  GenerationRef,
  GlossarySpec,
  GlossaryAuthorizedEvent,
  GlossaryBoundEvent,
  Lane,
  MediaClearRequest,
  MediaIngressEvent,
  MediaIngressRequest,
  MediaPlaybackRequest,
  MediaPort,
  SessionEvent,
  TranscriptEvent,
  Side,
  TranslationEvent,
  TranslationCapabilities,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
} from "../core/types.js";
import { InMemoryEvidenceStore } from "../adapters/evidence/in-memory.js";
import { createLocalEvalTranslationAdapter } from "../adapters/translation/local-eval.js";
import { createOpaqueEvidenceRef } from "../adapters/translation/evidence-ref.js";
import {
  validateEvidenceFinalization,
  type EvidenceFinalizationExpectation,
} from "../core/evidence-lifecycle.js";
import {
  createSyntheticPocProcessingManifest,
  createSyntheticPocProcessingProfile,
} from "../local-eval/synthetic-poc-processing-manifest.js";
import type { HealingProfile } from "./healing.js";
import type { ExecutableFixture, ExecutableRun, ExecutableSchedule } from "./executable-manifest.js";
import type { BenchmarkObservation } from "./runner.js";

export type LocalHarnessMediaMode = "acknowledge" | "drop_playout_ack";

export interface LocalHarnessExecutionInput {
  readonly run: ExecutableRun;
  readonly provider: TranslationProviderId;
  readonly mode: TranslationMode;
  readonly behavior: TranslationBehavior;
  readonly fixture?: ExecutableFixture;
  readonly schedule?: ExecutableSchedule;
  /** Owner-approved healing material, carried only as an immutable benchmark input. */
  readonly approvedProfile: HealingProfile;
  readonly approvedProfileHash: string;
  readonly mediaMode?: LocalHarnessMediaMode;
}

export type LocalHarnessExecutor = (
  input: LocalHarnessExecutionInput,
) => Promise<BenchmarkObservation>;

export class TerminalEvidenceIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalEvidenceIntegrityError";
  }
}

/**
 * Sparse positions per direction across the virtual ten-minute timeline.
 * These are the only PCM frames sent to the local relay for this fixture.
 */
const VIRTUAL_SOAK_SAMPLES_PER_LANE = 30;
const LOCAL_FIXTURE_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "fixture_local",
  remoteConnection: "not_applicable",
});

class MonotonicHarnessClock {
  #value = 1_000;

  now = (): number => {
    const value = this.#value;
    this.#value += 1;
    return value;
  };
}

interface PlayedFrame {
  readonly side: Side;
  readonly frame: AudioFrame;
  readonly startedAtMonoMs: number;
}

interface ClearRecord extends MediaClearRequest {
  readonly clearedAtMonoMs: number;
}

class HarnessMedia implements MediaPort {
  readonly #clock: MonotonicHarnessClock;
  readonly #mode: LocalHarnessMediaMode;
  readonly #captureFrames: boolean;
  readonly #queues = new Map<string, AsyncQueue<MediaIngressEvent>>();
  readonly played: PlayedFrame[] = [];
  readonly clears: ClearRecord[] = [];
  readonly playedCounts: Record<Side, number> = { A: 0, B: 0 };
  playbackChecksum = 0;
  maxConcurrentPlayback = 0;
  #concurrentPlayback = 0;
  #holdFirst: boolean;
  #heldUsed = false;
  #held: Readonly<{
    frame: AudioFrame;
    startedAtMonoMs: number;
    acknowledge: () => void;
  }> | undefined;

  constructor(input: Readonly<{
    clock: MonotonicHarnessClock;
    mode?: LocalHarnessMediaMode;
    captureFrames?: boolean;
    holdFirst?: boolean;
  }>) {
    this.#clock = input.clock;
    this.#mode = input.mode ?? "acknowledge";
    this.#captureFrames = input.captureFrames ?? true;
    this.#holdFirst = input.holdFirst ?? false;
  }

  push(event: MediaIngressEvent): void {
    if (!this.#queue(event.sessionId).offer(event)) {
      throw new Error("local Harness ingress queue closed unexpectedly");
    }
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    const queue = this.#queue(request.sessionId);
    request.signal.addEventListener("abort", () => queue.close(), { once: true });
    return queue;
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      this.#concurrentPlayback += 1;
      this.maxConcurrentPlayback = Math.max(
        this.maxConcurrentPlayback,
        this.#concurrentPlayback,
      );
      const startedAtMonoMs = this.#clock.now();
      this.playedCounts[request.side] += 1;
      this.playbackChecksum = (this.playbackChecksum +
        ((frame.sequence + 1) * 31) + (frame.pcm16le[0] ?? 0)
      ) >>> 0;
      if (this.#captureFrames) {
        this.played.push(Object.freeze({
          side: request.side,
          frame,
          startedAtMonoMs,
        }));
      }
      const acknowledge = (): void => {
        request.onPlayoutStarted(frame, startedAtMonoMs);
      };
      if (this.#holdFirst && !this.#heldUsed) {
        this.#heldUsed = true;
        this.#held = Object.freeze({ frame, startedAtMonoMs, acknowledge });
      } else if (this.#mode === "acknowledge") {
        acknowledge();
      }
      this.#concurrentPlayback -= 1;
    }
  }

  async clear(request: MediaClearRequest): Promise<void> {
    this.clears.push(Object.freeze({
      ...request,
      clearedAtMonoMs: this.#clock.now(),
    }));
  }

  closeSession(sessionId: string): void {
    this.#queues.get(sessionId)?.close();
  }

  releaseHeld(): void {
    const held = this.#held;
    if (held === undefined) throw new Error("local Harness has no held playout ACK");
    this.#held = undefined;
    if (this.#mode === "acknowledge") held.acknowledge();
  }

  hasHeld(): boolean {
    return this.#held !== undefined;
  }

  #queue(sessionId: string): AsyncQueue<MediaIngressEvent> {
    const existing = this.#queues.get(sessionId);
    if (existing !== undefined) return existing;
    const queue = new AsyncQueue<MediaIngressEvent>(256);
    this.#queues.set(sessionId, queue);
    return queue;
  }
}

class HarnessEvidence extends InMemoryEvidenceStore<EvidenceRecord> implements EvidencePort {
  readonly audioCounts: Record<EvidenceAudioTrack, number> = {
    source_a: 0,
    source_b: 0,
    playout_to_a: 0,
    playout_to_b: 0,
  };
  readonly #lastTimeline: Partial<Record<EvidenceAudioTrack, number>> = {};
  readonly alertCodes: string[] = [];
  timelineOrderViolation = false;

  override async persist(record: EvidenceRecord): Promise<void> {
    await super.persist(record);
    if (record.type === "audio") {
      this.audioCounts[record.track] += 1;
      const previous = this.#lastTimeline[record.track];
      if (previous !== undefined && record.timelineAtMonoMs < previous) {
        this.timelineOrderViolation = true;
      }
      this.#lastTimeline[record.track] = record.timelineAtMonoMs;
      return;
    }
    if (record.type === "session_event" && record.event.type === "alert") {
      this.alertCodes.push(record.event.alert.code);
    }
  }

  events(): readonly SessionEvent[] {
    return this.records().flatMap((record) =>
      record.type === "session_event" ? [record.event] : []
    );
  }

  audio(
    track: EvidenceAudioTrack,
  ): readonly Extract<EvidenceRecord, { type: "audio" }>[] {
    return this.records().filter(
      (record): record is Extract<EvidenceRecord, { type: "audio" }> =>
        record.type === "audio" && record.track === track,
    );
  }
}

class StreamingEchoTranslation implements TranslationPort {
  readonly capabilities: TranslationCapabilities = Object.freeze({
    providerId: "openai_controlled",
    modes: Object.freeze([
      Object.freeze({
        mode: "fast",
        behaviorVersion: 1,
        state: "locally_controlled",
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "balanced",
        behaviorVersion: 1,
        state: "locally_controlled",
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "accurate",
        behaviorVersion: 1,
        state: "locally_controlled",
        deterministicGlossary: false,
      }),
    ]),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  });

  async prepare(
    _context: import("../core/types.js").LaneContext,
  ): Promise<TranslationPreparation> {
    return LOCAL_FIXTURE_PREPARATION;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const targetSegmentId = request.context.turnId + ":target_transcript";
    const targetRevision = 0;
    // Emit the owning target transcript first, then carry its exact identity
    // and revision on every audio event; audio names are never parsed for
    // correlation.
    let targetTranscriptEmitted = false;
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      if (!targetTranscriptEmitted) {
        targetTranscriptEmitted = true;
        yield {
          kind: "target_transcript",
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
          turnId: request.context.turnId,
          segmentId: targetSegmentId,
          revision: targetRevision,
          finality: "final",
          evidenceRef: createOpaqueEvidenceRef("benchmark_local_harness", [
            request.context.sessionId,
            request.context.lane,
            request.context.generation,
            request.context.turnId,
            "target_transcript",
          ]),
          emittedAtMs: frame.capturedAtMs,
          text: "[local echo target]",
        };
      }
      yield {
        kind: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "echo-audio-" + frame.sequence,
        revision: targetRevision,
        finality: "final",
        targetSegmentId,
        evidenceRef: createOpaqueEvidenceRef("benchmark_local_harness", [
          request.context.sessionId,
          request.context.lane,
          request.context.generation,
          request.context.turnId,
          frame.sequence,
        ]),
        emittedAtMs: frame.capturedAtMs,
        playoutSequence: frame.sequence,
        frame: createAudioFrame({
          ...frame,
          sessionId: request.context.sessionId,
          lane: request.context.lane,
          generation: request.context.generation,
        }),
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}

}

class ObservedTranslation implements TranslationPort {
  readonly capabilities: TranslationCapabilities;
  readonly #delegate: TranslationPort;
  readonly #evidenceRefs: string[] = [];

  constructor(delegate: TranslationPort) {
    this.#delegate = delegate;
    this.capabilities = delegate.capabilities;
  }

  async prepare(
    context: import("../core/types.js").LaneContext,
  ): Promise<TranslationPreparation> {
    await this.#delegate.prepare(context);
    return LOCAL_FIXTURE_PREPARATION;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const event of this.#delegate.translate(request)) {
      this.#evidenceRefs.push(event.evidenceRef);
      yield event;
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    await this.#delegate.cancel(generation);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.#delegate.closeSession(sessionId);
  }

  evidenceRefs(): readonly string[] {
    return Object.freeze([...this.#evidenceRefs]);
  }
}



interface RunningHarness {
  readonly relay: ModularGuardedDuplexRelay;
  readonly media: HarnessMedia;
  readonly evidence: HarnessEvidence;
  readonly translation: ObservedTranslation;
  readonly clock: MonotonicHarnessClock;
  readonly sessionId: string;
  /** Runtime glossary entries keyed by lane; ids are opaque compiled ids. */
  readonly compiledGlossaries?: Readonly<Record<Lane, CompiledGlossary>>;
  readonly evidenceFinalizationExpectation: EvidenceFinalizationExpectation;
}

function approvedGlossary(profile: HealingProfile, profileHash: string): GlossarySpec {
  if (profile.glossary.length === 0) {
    throw new Error("approved profile under test has no glossary entries");
  }
  return Object.freeze({
    id: "approved-profile-" + profileHash.slice(0, 16),
    version: profileHash,
    sourceLanguage: "en-US",
    targetLanguage: "zh-TW",
    entries: Object.freeze(profile.glossary.map((entry) => Object.freeze({
      id: entry.id,
      source: entry.source,
      aliases: Object.freeze([...entry.aliases]),
      targetExact: entry.targetExact,
    }))),
  });
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function startHarness(input: Readonly<{
  translation: TranslationPort;
  provider: TranslationProviderId;
  mode: TranslationMode;
  behavior: TranslationBehavior;
  approvedProfile: HealingProfile;
  approvedProfileHash: string;
  mediaMode?: LocalHarnessMediaMode;
  captureAudio?: boolean;
  holdFirst?: boolean;
  maxQueueFrames?: number;
}>): Promise<RunningHarness> {
  const resolvedBehavior = resolveTranslationBehavior(input.mode);
  if (JSON.stringify(input.behavior) !== JSON.stringify(resolvedBehavior)) {
    throw new Error("local Harness behavior does not match its explicit mode");
  }
  const clock = new MonotonicHarnessClock();
  const media = new HarnessMedia({
    clock,
    ...(input.mediaMode === undefined ? {} : { mode: input.mediaMode }),
    ...(input.captureAudio === undefined
      ? {}
      : { captureFrames: input.captureAudio }),
    ...(input.holdFirst === undefined ? {} : { holdFirst: input.holdFirst }),
  });
  const evidence = new HarnessEvidence();
  const translation = new ObservedTranslation(input.translation);
  const processingProfile = createSyntheticPocProcessingProfile();
  const relay = new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    processingProfile,
    now: clock.now,
    createSessionId: () => "benchmark-local-session",
    endpointGrant: (_sessionId, side) => ({
      kind: "browser_link",
      side,
      url: "local-participant-" + side,
      qrDataUrl: "local-qr",
    }),
  });
  const glossary = input.translation.capabilities.supportsDeterministicGlossary &&
      input.translation.capabilities.modes.some((capability) =>
        capability.mode === input.mode && capability.deterministicGlossary)
    ? approvedGlossary(input.approvedProfile, input.approvedProfileHash)
    : undefined;
  const compiledGlossaryPair = glossary === undefined
    ? undefined
    : compileGlossaryPair(glossary);
  const processingManifest = createSyntheticPocProcessingManifest({
    mode: input.mode,
    ...(glossary === undefined ? {} : { glossary }),
  });
  const snapshot = await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: input.provider,
    mode: input.mode,
    processingManifest,
    evidenceReviewGrant: {
      dataOwnerId: "test-data-owner",
      bilingualReviewerId: "test-bilingual-reviewer",
    },
    ...(glossary === undefined ? {} : { glossary }),
    maxQueueFrames: input.maxQueueFrames ?? 64,
  });
  for (const side of ["A", "B"] as const) {
    await relay.command(snapshot.sessionId, {
      type: "participant_consent",
      commandId: "benchmark-consent-" + side,
      side,
      consentId: "benchmark-consent-id-" + side,
      consentPolicyRef: processingManifest.consentPolicyRef,
      recording: true,
      processing: true,
    });
  }
  const connectedSides = new Set<Side>();
  const connectionAbortController = new AbortController();
  const connectionIterator = relay.events(
    snapshot.sessionId,
    0,
    connectionAbortController.signal,
  )[Symbol.asyncIterator]();
  const waitForConnections = (async (): Promise<void> => {
    while (true) {
      const result = await connectionIterator.next();
      if (result.done) return;
      const event = result.value;
      if (event.type !== "participant_state" || !event.connected) continue;
      connectedSides.add(event.side);
      if (connectedSides.size === 2) return;
    }
  })();
  void waitForConnections.catch(() => undefined);
  for (const side of ["A", "B"] as const) {
    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side,
      timestampMonoMs: clock.now(),
      connected: true,
    });
  }
  try {
    await waitUntil(
      () => connectedSides.size === 2,
      "local Harness participants did not connect",
    );
    await waitForConnections;
  } finally {
    connectionAbortController.abort();
    void Promise.resolve()
      .then(() => connectionIterator.return?.())
      .catch(() => undefined);
  }
  for (const side of ["A", "B"] as const) {
    media.push({
      type: "participant_readiness",
      sessionId: snapshot.sessionId,
      side,
      timestampMonoMs: clock.now(),
      microphone: "browser_capture_active",
      headphones: "self_attested",
      source: "participant_browser_self_report",
    });
  }
  await relay.command(snapshot.sessionId, {
    type: "arm_recorder",
    commandId: "benchmark-arm-recorder",
  });
  await waitUntil(
    () => relay.snapshot(snapshot.sessionId).status === "ready",
    "local Harness participants did not become ready",
  );
  await relay.command(snapshot.sessionId, {
    type: "start",
    commandId: "benchmark-start",
  });
  await waitUntil(
    () => relay.snapshot(snapshot.sessionId).status === "active",
    "local Harness did not become active",
  );
  const evidenceFinalizationExpectation: EvidenceFinalizationExpectation = Object.freeze({
    sessionId: snapshot.sessionId,
    processingManifestSha256: snapshot.spec.processingManifest.manifestSha256,
    retentionPolicy: snapshot.spec.processingManifest.retentionPolicy,
  });
  return Object.freeze({
    relay,
    media,
    evidence,
    translation,
    clock,
    sessionId: snapshot.sessionId,
    ...(compiledGlossaryPair === undefined
      ? {}
      : {
          compiledGlossaries: Object.freeze({
            A_TO_B: compiledGlossaryPair.forward,
            B_TO_A: compiledGlossaryPair.reverse,
          }),
        }),
    evidenceFinalizationExpectation,
  });
}

async function endHarness(harness: RunningHarness): Promise<EvidenceFinalization> {
  await harness.relay.command(harness.sessionId, {
    type: "end",
    commandId: "benchmark-end",
    reason: "local benchmark run complete",
  });
  const finalization = harness.relay.snapshot(harness.sessionId).evidenceFinalization;
  if (finalization === undefined) {
    throw new TerminalEvidenceIntegrityError(
      "local Harness did not produce evidence finalization",
    );
  }
  try {
    validateEvidenceFinalization(finalization, harness.evidenceFinalizationExpectation);
  } catch (error: unknown) {
    throw new TerminalEvidenceIntegrityError(
      error instanceof Error
        ? `local Harness produced invalid evidence finalization: ${error.message}`
        : "local Harness produced invalid evidence finalization",
    );
  }
  if (finalization.status !== "sealed") {
    throw new TerminalEvidenceIntegrityError(
      "local Harness evidence finalization did not seal",
    );
  }
  return finalization;
}

async function withHarnessEnd<T>(
  harness: RunningHarness,
  operation: (end: () => Promise<EvidenceFinalization>) => Promise<T>,
): Promise<T> {
  let endPromise: Promise<EvidenceFinalization> | undefined;
  const end = (): Promise<EvidenceFinalization> => {
    endPromise ??= endHarness(harness);
    return endPromise;
  };
  let primaryFailed = false;
  let primaryError: unknown;
  try {
    return await operation(end);
  } catch (error: unknown) {
    primaryFailed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await end();
    } catch (cleanupError: unknown) {
      if (!primaryFailed) throw cleanupError;
      if (cleanupError === primaryError) throw primaryError;
      throw new AggregateError(
        [primaryError, cleanupError],
        "local Harness operation and cleanup both failed",
      );
    }
  }
}

function pushSpeech(
  harness: RunningHarness,
  side: Side,
  action: "speech_started" | "speech_ended",
): number {
  const timestampMonoMs = harness.clock.now();
  harness.media.push({
    type: action,
    sessionId: harness.sessionId,
    side,
    timestampMonoMs,
  });
  return timestampMonoMs;
}

function pushFrame(
  harness: RunningHarness,
  side: Side,
  sequence: number,
  capturedAtMs = harness.clock.now(),
): void {
  harness.media.push({
    type: "audio",
    sessionId: harness.sessionId,
    side,
    timestampMonoMs: capturedAtMs,
    frame: createAudioFrame({
      sessionId: harness.sessionId,
      lane: laneFromSource(side),
      generation: 0,
      sequence,
      capturedAtMs,
      pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(
        (sequence % 251) + 1,
      ),
    }),
  });
}

function eventForLane(
  events: readonly SessionEvent[],
  lane: Lane,
  type: "target_transcript",
): TranscriptEvent | undefined;
function eventForLane(
  events: readonly SessionEvent[],
  lane: Lane,
  type: "source_transcript",
): TranscriptEvent | undefined;
function eventForLane(
  events: readonly SessionEvent[],
  lane: Lane,
  type: "glossary_bound",
): GlossaryBoundEvent | undefined;
function eventForLane(
  events: readonly SessionEvent[],
  lane: Lane,
  type: "glossary_authorized",
): GlossaryAuthorizedEvent | undefined;
function eventForLane(
  events: readonly SessionEvent[],
  lane: Lane,
  type: SessionEvent["type"],
): SessionEvent | undefined {
  return events.findLast((event) => event.type === type && event.lane === lane);
}

async function liveRelayJournal(harness: RunningHarness): Promise<readonly SessionEvent[]> {
  const cursor = harness.relay.snapshot(harness.sessionId).eventCursor;
  const events: SessionEvent[] = [];
  for await (const event of harness.relay.events(harness.sessionId)) {
    events.push(event);
    if (event.cursor >= cursor) break;
  }
  return Object.freeze(events);
}

function playoutTrack(lane: Lane): EvidenceAudioTrack {
  return destinationForLane(lane) === "A" ? "playout_to_a" : "playout_to_b";
}

function sourceTextsForEntries(
  compiledGlossaries: Readonly<Record<Lane, CompiledGlossary>> | undefined,
  entryIds: readonly string[],
  lane: Lane,
): readonly string[] {
  if (entryIds.length === 0) return Object.freeze([]);
  const compiledGlossary = compiledGlossaries?.[lane];
  if (compiledGlossary === undefined) {
    throw new Error("bound glossary entries are unavailable");
  }
  return Object.freeze(entryIds.map((entryId) => {
    const entry = compiledGlossary.entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) {
      throw new Error("unknown bound glossary entry");
    }
    return entry.source;
  }));
}

function uninterruptedPlayout(
  records: readonly Extract<EvidenceRecord, { type: "audio" }>[],
): boolean {
  return records.length > 0 && records.every((record, index) =>
    index === 0 ||
    record.timelineAtMonoMs ===
      (records[index - 1]?.timelineAtMonoMs ?? 0) + CANONICAL_AUDIO.frameDurationMs
  );
}

function consecutivePlayoutSequence(
  records: readonly Extract<EvidenceRecord, { type: "audio" }>[],
): boolean {
  return records.length > 0 && records.every((record, index) =>
    index === 0 ||
    record.frame.sequence === (records[index - 1]?.frame.sequence ?? -1) + 1
  );
}

function isFinalTranscript(
  event: TranscriptEvent | undefined,
  lane: Lane,
  type: TranscriptEvent["type"],
): event is TranscriptEvent {
  return event !== undefined &&
    event.type === type &&
    event.lane === lane &&
    event.final &&
    event.text.trim().length > 0;
}

async function runFixtureObservation(
  input: LocalHarnessExecutionInput,
  fixture: ExecutableFixture,
): Promise<BenchmarkObservation> {
  if (fixture.scenario === "discovery") {
    throw new Error(input.run.runId + " cannot execute a discovery fixture locally");
  }
  const scenario = fixture.scenario;
  const lane: Lane = fixture.direction;
  const sourceSide: Side = lane === "A_TO_B" ? "A" : "B";
  const targetSide = destinationForLane(lane);
  const translation = createLocalEvalTranslationAdapter({
    transcriptByLane: {
      A_TO_B: lane === "A_TO_B" ? fixture.sourceText : "Unused local fixture.",
      B_TO_A: lane === "B_TO_A" ? fixture.sourceText : "未使用的本機測試。",
    },
    translationMode: "preserve",
  });
  const startedAt = performance.now();
  const harness = await startHarness({
    translation,
    provider: input.provider,
    mode: input.mode,
    behavior: input.behavior,
    approvedProfile: input.approvedProfile,
    approvedProfileHash: input.approvedProfileHash,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  return withHarnessEnd(harness, async (endHarnessOnce) => {
    const speechOnset = pushSpeech(harness, sourceSide, "speech_started");
    pushFrame(harness, sourceSide, 0);
    pushSpeech(harness, sourceSide, "speech_ended");
    await waitUntil(
      () => isFinalTranscript(
        eventForLane(harness.evidence.events(), lane, "target_transcript"),
        lane,
        "target_transcript",
      ),
      input.run.runId + " did not produce a final target transcript",
    );
    await waitUntil(
      () => harness.media.playedCounts[targetSide] >= 3,
      input.run.runId + " did not traverse the local MediaPort",
    );

    const durableEvents = harness.evidence.events();
    // Provisional bindings stay live-only; final transcript and authorization
    // evidence must remain durable before contributing to the release result.
    const liveEvents = await liveRelayJournal(harness);
    const target = eventForLane(durableEvents, lane, "target_transcript");
    const source = eventForLane(durableEvents, lane, "source_transcript");
    const bound = eventForLane(liveEvents, lane, "glossary_bound");
    const authorized = eventForLane(durableEvents, lane, "glossary_authorized");
    const playout = harness.evidence.audio(playoutTrack(lane));
    const playoutSequenceContiguous = consecutivePlayoutSequence(playout);
    const alerts = Object.freeze([...harness.evidence.alertCodes]);
    const actualTargetText = target?.text.normalize("NFKC") ?? "";
    const targetExactSatisfied = actualTargetText.includes(
      fixture.expectedTargetExact.normalize("NFKC"),
    );
    const entryIds = bound?.entryIds ?? [];
    const matchedSourceTexts = sourceTextsForEntries(
      harness.compiledGlossaries,
      entryIds,
      lane,
    );
    const authorizationStatus = authorized !== undefined
      ? "authorized" as const
      : bound !== undefined
        ? "bypassed" as const
        : "not_applicable" as const;
    const uninterrupted = isFinalTranscript(source, lane, "source_transcript") &&
      isFinalTranscript(target, lane, "target_transcript") &&
      uninterruptedPlayout(playout) &&
      playoutSequenceContiguous &&
      !harness.evidence.alertCodes.some((code) =>
        code === "source_queue_trimmed" ||
        code === "playout_queue_trimmed" ||
        code === "translation_failed" ||
        code === "media_playout_failed"
      );
    const glossaryHash = harness.relay.snapshot(harness.sessionId).glossary?.hash;
    if (glossaryHash === undefined) {
      throw new Error(input.run.runId + " did not pin a glossary hash");
    }

    if (input.run.stage === "formal_terminology") {
      const evidenceFinalization = await endHarnessOnce();
      return Object.freeze({
        kind: "formal_terminology",
        fixtureId: fixture.fixtureId,
        scenario,
        actualTargetText,
        targetExactSatisfied,
        termBound: bound !== undefined,
        bindingCount: entryIds.length,
        matchedSourceTexts,
        authorizationStatus,
        glossaryHash,
        playedFrameCount: playout.length,
        uninterrupted,
        normalizedEventEvidence: Object.freeze({
          sourceRevision: source?.revision ?? 0,
          targetRevision: target?.revision ?? 0,
          targetFinal: target?.final === true,
          playoutSequenceContiguous,
        }),
        translationEvidenceRefs: harness.translation.evidenceRefs(),
        evidenceFinalization,
        evidenceFinalizationExpectation: harness.evidenceFinalizationExpectation,
        alerts,
        elapsedMs: Math.max(0, performance.now() - startedAt),
      });
    }
    if (input.run.stage !== "latency") {
      throw new Error(input.run.runId + " has a fixture for the wrong stage");
    }
    if (scenario !== "protected" && scenario !== "ordinary") {
      throw new Error(input.run.runId + " has an invalid latency scenario");
    }
    const firstPlayoutAt = playout[0]?.timelineAtMonoMs;
    if (source === undefined || firstPlayoutAt === undefined) {
      throw new Error(input.run.runId + " has incomplete local timing evidence");
    }
    const evidenceFinalization = await endHarnessOnce();
    return Object.freeze({
      kind: "latency",
      fixtureId: fixture.fixtureId,
      scenario,
      measurementScope: "local_processing_not_acoustic",
      targetExactSatisfied,
      bindingCount: entryIds.length,
      matchedSourceTexts,
      authorizationStatus,
      glossaryHash,
      playedFrameCount: playout.length,
      uninterrupted,
      normalizedEventEvidence: Object.freeze({
        sourceRevision: source.revision,
        targetRevision: target?.revision ?? 0,
        targetFinal: target?.final === true,
        playoutSequenceContiguous,
      }),
      translationEvidenceRefs: harness.translation.evidenceRefs(),
      evidenceFinalization,
      evidenceFinalizationExpectation: harness.evidenceFinalizationExpectation,
      alerts,
      metricsMs: Object.freeze({
        speechToAligned: Math.max(0, firstPlayoutAt - speechOnset),
        stableSourceToPlayable: Math.max(0, firstPlayoutAt - source.timestampMonoMs),
        glossaryOverhead: bound === undefined || authorized === undefined
          ? 0
          : Math.max(0, authorized.timestampMonoMs - bound.timestampMonoMs),
      }),
    });
  });
}

async function runInterruptionObservation(
  input: LocalHarnessExecutionInput,
  schedule: ExecutableSchedule,
): Promise<BenchmarkObservation> {
  if (schedule.kind !== "interruption") {
    throw new Error(input.run.runId + " requires an interruption schedule");
  }
  const starts = schedule.events.filter(
    (event) => event.action === "speech_start" && event.side !== "BOTH",
  );
  const firstSide = starts[0]?.side;
  const interruptingSide = starts.find((event) => event.side !== firstSide)?.side;
  if (firstSide === undefined || firstSide === "BOTH" ||
      interruptingSide === undefined || interruptingSide === "BOTH") {
    throw new Error(input.run.runId + " has no two-sided interruption");
  }
  const harness = await startHarness({
    translation: new StreamingEchoTranslation(),
    provider: input.provider,
    mode: input.mode,
    behavior: input.behavior,
    approvedProfile: input.approvedProfile,
    approvedProfileHash: input.approvedProfileHash,
    holdFirst: true,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  return withHarnessEnd(harness, async (endHarnessOnce) => {
    pushSpeech(harness, firstSide, "speech_started");
    pushFrame(harness, firstSide, 0);
    pushSpeech(harness, firstSide, "speech_ended");
    await waitUntil(
      () => harness.media.hasHeld(),
      input.run.runId + " did not reach held playout",
    );
    const staleFrame = harness.media.played[0]?.frame;
    if (staleFrame === undefined) {
      throw new Error(input.run.runId + " did not capture the pre-interruption frame");
    }
    const interruptionAt = pushSpeech(
      harness,
      interruptingSide,
      "speech_started",
    );
    await waitUntil(
      () => harness.media.clears.some((clear) =>
        clear.lane === staleFrame.lane && clear.generation > staleFrame.generation
      ),
      input.run.runId + " did not clear stale playout",
    );
    harness.media.releaseHeld();
    pushFrame(harness, interruptingSide, 0);
    pushSpeech(harness, interruptingSide, "speech_ended");
    const resumedLane = laneFromSource(interruptingSide);
    const resumedTrack = playoutTrack(resumedLane);
    await waitUntil(
      () => harness.evidence.audioCounts[resumedTrack] > 0 ||
        input.mediaMode === "drop_playout_ack",
      input.run.runId + " did not resume valid output",
    );

    const events = harness.evidence.events();
    const clear = harness.media.clears.find((candidate) =>
      candidate.lane === staleFrame.lane &&
      candidate.generation > staleFrame.generation
    );
    const generationCut = events.some((event) =>
      event.type === "generation_cut" &&
      event.lane === staleFrame.lane &&
      event.reason === "barge_in" &&
      event.previousGeneration === staleFrame.generation
    );
    const staleAccepted = harness.evidence
      .audio(playoutTrack(staleFrame.lane))
      .some((record) =>
        record.frame.generation === staleFrame.generation &&
        record.frame.sequence === staleFrame.sequence
      );
    const validOutputResumed = harness.evidence
      .audio(resumedTrack)
      .some((record) => record.frame.lane === resumedLane);
    const evidenceFinalization = await endHarnessOnce();
    return Object.freeze({
      kind: "interruption",
      scheduleId: schedule.scheduleId,
      measurementScope: "local_state_machine_not_acoustic",
      processedEvents: schedule.events.length,
      generationCut,
      playoutCleared: clear !== undefined,
      staleOutputRejected: !staleAccepted,
      validOutputResumed,
      clearLatencyMs: clear === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, clear.clearedAtMonoMs - interruptionAt),
      translationEvidenceRefs: harness.translation.evidenceRefs(),
      evidenceFinalization,
      evidenceFinalizationExpectation: harness.evidenceFinalizationExpectation,
      alerts: Object.freeze([...harness.evidence.alertCodes]),
    });
  });
}

async function runSoakObservation(
  input: LocalHarnessExecutionInput,
  schedule: ExecutableSchedule,
): Promise<BenchmarkObservation> {
  if (schedule.kind !== "continuous_duplex") {
    throw new Error(input.run.runId + " requires a continuous duplex schedule");
  }
  const framesPerLane = Math.floor(
    schedule.durationMs / CANONICAL_AUDIO.frameDurationMs,
  );
  const virtualFramesRepresented = framesPerLane * 2;
  const samplesPerLane = Math.min(VIRTUAL_SOAK_SAMPLES_PER_LANE, framesPerLane);
  const expectedFrames = samplesPerLane * 2;
  const harness = await startHarness({
    translation: new StreamingEchoTranslation(),
    provider: input.provider,
    mode: input.mode,
    behavior: input.behavior,
    approvedProfile: input.approvedProfile,
    approvedProfileHash: input.approvedProfileHash,
    captureAudio: false,
    maxQueueFrames: 64,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  return withHarnessEnd(harness, async (endHarnessOnce) => {
    // Fast mode accepts frames continuously. Speech lifecycle events would invoke
    // the barge-in fence and turn this sampled duplex fixture into an interruption
    // run; the dedicated interruption schedules cover that behavior separately.
    for (let sample = 0; sample < samplesPerLane; sample += 1) {
      const sequence = samplesPerLane === 1
        ? 0
        : Math.round(sample * (framesPerLane - 1) / (samplesPerLane - 1));
      const capturedAtMs = 10_000 + sequence * CANONICAL_AUDIO.frameDurationMs;
      pushFrame(harness, "A", sequence, capturedAtMs);
      pushFrame(harness, "B", sequence, capturedAtMs);
    }
    if (input.mediaMode !== "drop_playout_ack") {
      await waitUntil(
        () => harness.evidence.audioCounts.playout_to_a +
          harness.evidence.audioCounts.playout_to_b >= expectedFrames,
        input.run.runId + " did not acknowledge all accelerated playout",
        20_000,
      );
    }
    const acceptedPlayout = harness.evidence.audioCounts.playout_to_a +
      harness.evidence.audioCounts.playout_to_b;
    const unacknowledgedSampleFrames = Math.max(0, expectedFrames - acceptedPlayout);
    const trimmed = harness.evidence.alertCodes.some((code) =>
      code === "source_queue_trimmed" || code === "playout_queue_trimmed"
    );
    const evidenceFinalization = await endHarnessOnce();
    return Object.freeze({
      kind: "continuous_duplex",
      scheduleId: schedule.scheduleId,
      executionMode: "sampled_virtual_mechanism",
      coverageScope: "virtual_mechanism_only",
      virtualDurationMs: schedule.durationMs,
      virtualFramesRepresented,
      sampleFramesPerLane: samplesPerLane,
      processedSampleFrames: harness.evidence.audioCounts.source_a +
        harness.evidence.audioCounts.source_b,
      playbackMaximumConcurrency: harness.media.maxConcurrentPlayback,
      unacknowledgedSampleFrames,
      queuePressureDetected: trimmed || unacknowledgedSampleFrames !== 0 ||
        harness.evidence.timelineOrderViolation,
      checksum: harness.media.playbackChecksum,
      translationEvidenceRefs: harness.translation.evidenceRefs(),
      evidenceFinalization,
      evidenceFinalizationExpectation: harness.evidenceFinalizationExpectation,
      alerts: Object.freeze([...harness.evidence.alertCodes]),
    });
  });
}

export async function runLocalHarnessObservation(
  input: LocalHarnessExecutionInput,
): Promise<BenchmarkObservation> {
  switch (input.run.stage) {
    case "formal_terminology":
    case "latency":
      if (input.fixture === undefined) {
        throw new Error(input.run.runId + " is missing its fixture");
      }
      return runFixtureObservation(input, input.fixture);
    case "interruption":
      if (input.schedule === undefined) {
        throw new Error(input.run.runId + " is missing its schedule");
      }
      return runInterruptionObservation(input, input.schedule);
    case "continuous_duplex":
      if (input.schedule === undefined) {
        throw new Error(input.run.runId + " is missing its schedule");
      }
      return runSoakObservation(input, input.schedule);
    case "discovery":
      throw new Error("Discovery is a separate paid command");
  }
}

import { CANONICAL_AUDIO, createAudioFrame, destinationForLane, laneFromSource } from "../core/audio.js";
import { AsyncQueue } from "../core/async-queue.js";
import { ModularGuardedDuplexRelay } from "../core/relay.js";
import type {
  AudioFrame,
  EvidenceAudioTrack,
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
  TranslationPort,
  TranslationRequest,
} from "../core/types.js";
import { createLocalEvalTranslationAdapter } from "../adapters/translation/local-eval.js";
import type { HealingProfile } from "./healing.js";
import type { ExecutableFixture, ExecutableRun, ExecutableSchedule } from "./executable-manifest.js";
import type { BenchmarkObservation } from "./runner.js";

export type LocalHarnessMediaMode = "acknowledge" | "drop_playout_ack";

export interface LocalHarnessExecutionInput {
  readonly run: ExecutableRun;
  readonly fixture?: ExecutableFixture;
  readonly schedule?: ExecutableSchedule;
  readonly profile: HealingProfile;
  readonly profileHash: string;
  readonly mediaMode?: LocalHarnessMediaMode;
}

export type LocalHarnessExecutor = (
  input: LocalHarnessExecutionInput,
) => Promise<BenchmarkObservation>;

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

class HarnessEvidence implements EvidencePort {
  readonly #captureAudio: boolean;
  readonly records: EvidenceRecord[] = [];
  readonly audioCounts: Record<EvidenceAudioTrack, number> = {
    source_a: 0,
    source_b: 0,
    playout_to_a: 0,
    playout_to_b: 0,
  };
  readonly #lastTimeline: Partial<Record<EvidenceAudioTrack, number>> = {};
  readonly alertCodes: string[] = [];
  timelineOrderViolation = false;

  constructor(captureAudio = true) {
    this.#captureAudio = captureAudio;
  }

  record(record: EvidenceRecord): boolean {
    if (record.type === "audio") {
      this.audioCounts[record.track] += 1;
      const previous = this.#lastTimeline[record.track];
      if (previous !== undefined && record.timelineAtMonoMs < previous) {
        this.timelineOrderViolation = true;
      }
      this.#lastTimeline[record.track] = record.timelineAtMonoMs;
      if (this.#captureAudio) this.records.push(structuredClone(record));
      return true;
    }
    if (record.event.type === "alert") {
      this.alertCodes.push(record.event.alert.code);
    }
    this.records.push(structuredClone(record));
    return true;
  }

  async close(_sessionId: string): Promise<void> {}

  events(): readonly SessionEvent[] {
    return this.records.flatMap((record) =>
      record.type === "session_event" ? [record.event] : []
    );
  }

  audio(
    track: EvidenceAudioTrack,
  ): readonly Extract<EvidenceRecord, { type: "audio" }>[] {
    return this.records.filter(
      (record): record is Extract<EvidenceRecord, { type: "audio" }> =>
        record.type === "audio" && record.track === track,
    );
  }
}

class StreamingEchoTranslation implements TranslationPort {
  async prepare(_context: import("../core/types.js").LaneContext): Promise<void> {}

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      yield {
        type: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: frame.capturedAtMs,
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



interface RunningHarness {
  readonly relay: ModularGuardedDuplexRelay;
  readonly media: HarnessMedia;
  readonly evidence: HarnessEvidence;
  readonly clock: MonotonicHarnessClock;
  readonly sessionId: string;
}

function profileGlossary(profile: HealingProfile, profileHash: string): GlossarySpec {
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
  profile: HealingProfile;
  profileHash: string;
  mediaMode?: LocalHarnessMediaMode;
  captureAudio?: boolean;
  holdFirst?: boolean;
  maxQueueFrames?: number;
}>): Promise<RunningHarness> {
  const clock = new MonotonicHarnessClock();
  const media = new HarnessMedia({
    clock,
    ...(input.mediaMode === undefined ? {} : { mode: input.mediaMode }),
    ...(input.captureAudio === undefined
      ? {}
      : { captureFrames: input.captureAudio }),
    ...(input.holdFirst === undefined ? {} : { holdFirst: input.holdFirst }),
  });
  const evidence = new HarnessEvidence(input.captureAudio ?? true);
  const relay = new ModularGuardedDuplexRelay({
    media,
    translation: input.translation,
    evidence,
    now: clock.now,
    createSessionId: () => "benchmark-local-session",
    endpointGrant: (_sessionId, side) => ({
      kind: "browser_link",
      side,
      url: "local-participant-" + side,
      qrDataUrl: "local-qr",
    }),
  });
  const snapshot = await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    profile: "local_eval",
    glossary: profileGlossary(input.profile, input.profileHash),
    maxQueueFrames: input.maxQueueFrames ?? 64,
  });
  for (const side of ["A", "B"] as const) {
    media.push({
      type: "participant_state",
      sessionId: snapshot.sessionId,
      side,
      timestampMonoMs: clock.now(),
      connected: true,
    });
  }
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
  return Object.freeze({
    relay,
    media,
    evidence,
    clock,
    sessionId: snapshot.sessionId,
  });
}

async function endHarness(harness: RunningHarness): Promise<void> {
  await harness.relay.command(harness.sessionId, {
    type: "end",
    commandId: "benchmark-end",
    reason: "local benchmark run complete",
  });
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

function playoutTrack(lane: Lane): EvidenceAudioTrack {
  return destinationForLane(lane) === "A" ? "playout_to_a" : "playout_to_b";
}

function sourceTextsForEntries(
  profile: HealingProfile,
  entryIds: readonly string[],
  lane: Lane,
): readonly string[] {
  return Object.freeze(entryIds.map((entryId) => {
    const entry = profile.glossary.find((candidate) => candidate.id === entryId);
    if (entry === undefined) {
      throw new Error("unknown bound glossary entry " + entryId);
    }
    return lane === "A_TO_B" ? entry.source : entry.targetExact;
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

async function runFixtureObservation(
  input: LocalHarnessExecutionInput,
  fixture: ExecutableFixture,
): Promise<BenchmarkObservation> {
  if (fixture.scenario === "discovery") {
    throw new Error(input.run.runId + " cannot execute a discovery fixture locally");
  }
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
    profile: input.profile,
    profileHash: input.profileHash,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  try {
    const speechOnset = pushSpeech(harness, sourceSide, "speech_started");
    pushFrame(harness, sourceSide, 0);
    pushSpeech(harness, sourceSide, "speech_ended");
    await waitUntil(
      () => eventForLane(
        harness.evidence.events(),
        lane,
        "target_transcript",
      )?.final === true,
      input.run.runId + " did not produce a final target transcript",
    );
    await waitUntil(
      () => harness.media.playedCounts[targetSide] >= 3,
      input.run.runId + " did not traverse the local MediaPort",
    );

    const events = harness.evidence.events();
    const target = eventForLane(events, lane, "target_transcript");
    const source = eventForLane(events, lane, "source_transcript");
    const bound = eventForLane(events, lane, "glossary_bound");
    const authorized = eventForLane(events, lane, "glossary_authorized");
    const playout = harness.evidence.audio(playoutTrack(lane));
    const actualTargetText = target?.text.normalize("NFKC") ?? "";
    const targetExactSatisfied = actualTargetText.includes(
      fixture.expectedTargetExact.normalize("NFKC"),
    );
    const entryIds = bound?.entryIds ?? [];
    const matchedSourceTexts = sourceTextsForEntries(
      input.profile,
      entryIds,
      lane,
    );
    const authorizationStatus = authorized !== undefined
      ? "authorized" as const
      : bound !== undefined
        ? "bypassed" as const
        : "not_applicable" as const;
    const uninterrupted = uninterruptedPlayout(playout) &&
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
      return Object.freeze({
        kind: "formal_terminology",
        fixtureId: fixture.fixtureId,
        scenario: fixture.scenario,
        actualTargetText,
        targetExactSatisfied,
        termBound: bound !== undefined,
        bindingCount: entryIds.length,
        matchedSourceTexts,
        authorizationStatus,
        glossaryHash,
        playedFrameCount: playout.length,
        uninterrupted,
        elapsedMs: Math.max(0, performance.now() - startedAt),
      });
    }
    if (input.run.stage !== "latency") {
      throw new Error(input.run.runId + " has a fixture for the wrong stage");
    }
    if (fixture.scenario !== "protected" && fixture.scenario !== "ordinary") {
      throw new Error(input.run.runId + " has an invalid latency scenario");
    }
    const firstPlayoutAt = playout[0]?.timelineAtMonoMs;
    if (source === undefined || firstPlayoutAt === undefined) {
      throw new Error(input.run.runId + " has incomplete local timing evidence");
    }
    return Object.freeze({
      kind: "latency",
      fixtureId: fixture.fixtureId,
      scenario: fixture.scenario,
      measurementScope: "local_processing_not_acoustic",
      targetExactSatisfied,
      bindingCount: entryIds.length,
      matchedSourceTexts,
      authorizationStatus,
      glossaryHash,
      playedFrameCount: playout.length,
      uninterrupted,
      metricsMs: Object.freeze({
        speechToAligned: Math.max(0, firstPlayoutAt - speechOnset),
        stableSourceToPlayable: Math.max(0, firstPlayoutAt - source.timestampMonoMs),
        glossaryOverhead: bound === undefined || authorized === undefined
          ? 0
          : Math.max(0, authorized.timestampMonoMs - bound.timestampMonoMs),
      }),
    });
  } finally {
    await endHarness(harness);
  }
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
    profile: input.profile,
    profileHash: input.profileHash,
    holdFirst: true,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  try {
    pushSpeech(harness, firstSide, "speech_started");
    pushFrame(harness, firstSide, 0);
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
    const resumedLane = laneFromSource(interruptingSide);
    const resumedTrack = playoutTrack(resumedLane);
    await waitUntil(
      () => harness.evidence.audioCounts[resumedTrack] > 0 ||
        input.mediaMode === "drop_playout_ack",
      input.run.runId + " did not resume valid output",
    );
    pushSpeech(harness, firstSide, "speech_ended");
    pushSpeech(harness, interruptingSide, "speech_ended");

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
    });
  } finally {
    await endHarness(harness);
  }
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
  const expectedFrames = framesPerLane * 2;
  const harness = await startHarness({
    translation: new StreamingEchoTranslation(),
    profile: input.profile,
    profileHash: input.profileHash,
    captureAudio: false,
    maxQueueFrames: 64,
    ...(input.mediaMode === undefined ? {} : { mediaMode: input.mediaMode }),
  });
  try {
    pushSpeech(harness, "A", "speech_started");
    pushSpeech(harness, "B", "speech_started");
    const batchSize = 32;
    for (let sequence = 0; sequence < framesPerLane; sequence += 1) {
      const capturedAtMs = 10_000 + sequence * CANONICAL_AUDIO.frameDurationMs;
      pushFrame(harness, "A", sequence, capturedAtMs);
      pushFrame(harness, "B", sequence, capturedAtMs);
      const submitted = (sequence + 1) * 2;
      if ((sequence + 1) % batchSize === 0 || sequence + 1 === framesPerLane) {
        await waitUntil(
          () => harness.evidence.audioCounts.source_a +
            harness.evidence.audioCounts.source_b >= submitted &&
            harness.media.playedCounts.A + harness.media.playedCounts.B >= submitted,
          input.run.runId + " did not drain an accelerated duplex batch",
          20_000,
        );
      }
    }
    pushSpeech(harness, "A", "speech_ended");
    pushSpeech(harness, "B", "speech_ended");
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
    const queueFinalDepth = Math.max(0, expectedFrames - acceptedPlayout);
    const trimmed = harness.evidence.alertCodes.some((code) =>
      code === "source_queue_trimmed" || code === "playout_queue_trimmed"
    );
    return Object.freeze({
      kind: "continuous_duplex",
      scheduleId: schedule.scheduleId,
      executionMode: "accelerated_virtual_time",
      virtualDurationMs: schedule.durationMs,
      processedFrames: harness.evidence.audioCounts.source_a +
        harness.evidence.audioCounts.source_b,
      queueMaximumDepth: harness.media.maxConcurrentPlayback,
      queueFinalDepth,
      queueGrowthDetected: trimmed || queueFinalDepth !== 0 ||
        harness.evidence.timelineOrderViolation,
      checksum: harness.media.playbackChecksum,
    });
  } finally {
    await endHarness(harness);
  }
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

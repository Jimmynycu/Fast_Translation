import { randomUUID } from "node:crypto";
import { CANONICAL_AUDIO, destinationForLane, laneFromSource } from "./audio.js";
import { AsyncQueue } from "./async-queue.js";
import { GenerationFence } from "./generation-fence.js";
import { compileGlossary, reverseGlossarySpec, type CompiledGlossary } from "./glossary.js";
import type {
  EvidenceAudioTrack,
  EvidencePort,
  EvidenceRecord,
  EventCursor,
  GuardedDuplexRelay,
  Lane,
  LaneContext,
  MediaIngressEvent,
  MediaPort,
  ParticipantEndpointGrant,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
  Side,
  TranslationEvent,
  TranslationPort,
} from "./types.js";

export class RelaySessionError extends Error {
  readonly code:
    | "invalid_command"
    | "invalid_session"
    | "invalid_spec"
    | "session_exists";

  constructor(code: RelaySessionError["code"], message: string) {
    super(message);
    this.name = "RelaySessionError";
    this.code = code;
  }
}

export type EndpointGrantFactory = (
  sessionId: string,
  side: Side,
) => Promise<ParticipantEndpointGrant> | ParticipantEndpointGrant;

export interface GuardedDuplexRelayOptions {
  readonly media: MediaPort;
  readonly translation: TranslationPort;
  readonly evidence: EvidencePort;
  readonly endpointGrant: EndpointGrantFactory;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  readonly eventHistoryLimit?: number;
  readonly closedSessionHistoryLimit?: number;
}

interface LaneRun {
  readonly generation: number;
  readonly input: AsyncQueue<import("./audio.js").AudioFrame>;
  readonly controller: AbortController;
  readonly task: Promise<void>;
}

interface TranscriptAccumulator {
  generation: number;
  source: string;
  target: string;
}

interface SpeechOnset {
  readonly generation: number;
  readonly startedAtMs: number;
}

interface PlayoutEvidenceCursor {
  readonly generation: number;
  readonly sequence: number;
  readonly timelineAtMonoMs: number;
}

interface CommandExecution {
  readonly fingerprint: string;
  readonly completion: Promise<void>;
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly spec: SessionSpec;
  readonly compiledGlossary?: CompiledGlossary;
  readonly compiledGlossaries?: Readonly<Record<Lane, CompiledGlossary>>;
  readonly participants: Readonly<{ A: ParticipantEndpointGrant; B: ParticipantEndpointGrant }>;
  readonly connected: Record<Side, boolean>;
  readonly speaking: Record<Side, boolean>;
  readonly fences: Record<Lane, GenerationFence>;
  readonly laneRuns: Record<Lane, LaneRun | undefined>;
  readonly playout: Record<Side, AsyncQueue<import("./audio.js").AudioFrame>>;
  readonly playoutEvidenceCursors: Record<Side, PlayoutEvidenceCursor | undefined>;
  readonly sourceEvidenceCursors: Record<Side, PlayoutEvidenceCursor | undefined>;
  readonly subscribers: Set<AsyncQueue<SessionEvent>>;
  readonly events: SessionEvent[];
  readonly commands: Map<string, CommandExecution>;
  readonly ingressController: AbortController;
  readonly playoutController: AbortController;
  readonly backgroundTasks: Promise<void>[];
  readonly firstAudio: Set<string>;
  readonly speechOnsets: Record<Lane, SpeechOnset | undefined>;
  readonly transcripts: Record<Lane, TranscriptAccumulator>;
  status: SessionStatus;
  cursor: EventCursor;
  openedAtMs: number;
  closedAtMs: number | undefined;
  evidenceHealthAlerted: boolean;
}

function freezeSessionSpec(spec: SessionSpec): SessionSpec {
  if (spec.sideA.language.trim().length === 0 || spec.sideB.language.trim().length === 0) {
    throw new RelaySessionError("invalid_spec", "Both participant languages are required");
  }
  const maxQueueFrames = spec.maxQueueFrames ?? 25;
  if (!Number.isSafeInteger(maxQueueFrames) || maxQueueFrames < 1) {
    throw new RelaySessionError("invalid_spec", "maxQueueFrames must be a positive safe integer");
  }

  const glossary =
    spec.glossary === undefined
      ? undefined
      : Object.freeze({
          ...spec.glossary,
          entries: Object.freeze(
            spec.glossary.entries.map((entry) =>
              Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]) }),
            ),
          ),
        });

  return Object.freeze({
    sideA: Object.freeze({ ...spec.sideA, language: spec.sideA.language.trim() }),
    sideB: Object.freeze({ ...spec.sideB, language: spec.sideB.language.trim() }),
    profile: spec.profile,
    ...(glossary === undefined ? {} : { glossary }),
    maxQueueFrames,
  });
}

function laneLanguages(spec: SessionSpec, lane: Lane): Readonly<{
  sourceLanguage: string;
  targetLanguage: string;
}> {
  return lane === "A_TO_B"
    ? { sourceLanguage: spec.sideA.language, targetLanguage: spec.sideB.language }
    : { sourceLanguage: spec.sideB.language, targetLanguage: spec.sideA.language };
}

interface SessionGlossaries {
  readonly primary: CompiledGlossary;
  readonly byLane: Readonly<Record<Lane, CompiledGlossary>>;
}

function normalizedLanguage(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function compileSessionGlossaries(spec: SessionSpec): SessionGlossaries | undefined {
  if (spec.glossary === undefined) return undefined;

  let primary: CompiledGlossary;
  let reverse: CompiledGlossary;
  try {
    primary = compileGlossary(spec.glossary);
    reverse = compileGlossary(reverseGlossarySpec(spec.glossary));
  } catch (error: unknown) {
    throw new RelaySessionError(
      "invalid_spec",
      "Glossary compilation failed: " +
        (error instanceof Error ? error.message : "unknown glossary error"),
    );
  }

  const aToB = laneLanguages(spec, "A_TO_B");
  const primaryIsAToB =
    normalizedLanguage(primary.sourceLanguage) === normalizedLanguage(aToB.sourceLanguage) &&
    normalizedLanguage(primary.targetLanguage) === normalizedLanguage(aToB.targetLanguage);
  const primaryIsBToA =
    normalizedLanguage(primary.sourceLanguage) === normalizedLanguage(aToB.targetLanguage) &&
    normalizedLanguage(primary.targetLanguage) === normalizedLanguage(aToB.sourceLanguage);
  if (!primaryIsAToB && !primaryIsBToA) {
    throw new RelaySessionError(
      "invalid_spec",
      "Glossary languages must match the configured participant language pair",
    );
  }

  return Object.freeze({
    primary,
    byLane: Object.freeze(primaryIsAToB
      ? { A_TO_B: primary, B_TO_A: reverse }
      : { A_TO_B: reverse, B_TO_A: primary }),
  });
}

function sourceTrack(side: Side): EvidenceAudioTrack {
  return side === "A" ? "source_a" : "source_b";
}

function playoutTrack(side: Side): EvidenceAudioTrack {
  return side === "A" ? "playout_to_a" : "playout_to_b";
}

function oppositeInboundLane(side: Side): Lane {
  return side === "A" ? "B_TO_A" : "A_TO_B";
}

export class ModularGuardedDuplexRelay implements GuardedDuplexRelay {
  readonly #media: MediaPort;
  readonly #translation: TranslationPort;
  readonly #evidence: EvidencePort;
  readonly #endpointGrant: EndpointGrantFactory;
  readonly #createSessionId: () => string;
  readonly #now: () => number;
  readonly #eventHistoryLimit: number;
  readonly #closedSessionHistoryLimit: number;
  readonly #closedSessionIds: string[] = [];
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: GuardedDuplexRelayOptions) {
    this.#media = options.media;
    this.#translation = options.translation;
    this.#evidence = options.evidence;
    this.#endpointGrant = options.endpointGrant;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#now = options.now ?? (() => performance.now());
    this.#eventHistoryLimit = options.eventHistoryLimit ?? 10_000;
    if (!Number.isSafeInteger(this.#eventHistoryLimit) || this.#eventHistoryLimit < 100) {
      throw new RangeError("eventHistoryLimit must be a safe integer of at least 100");
    }
    this.#closedSessionHistoryLimit = options.closedSessionHistoryLimit ?? 20;
    if (!Number.isSafeInteger(this.#closedSessionHistoryLimit) || this.#closedSessionHistoryLimit < 1) {
      throw new RangeError("closedSessionHistoryLimit must be a positive safe integer");
    }
  }

  async open(specInput: SessionSpec): Promise<SessionSnapshot> {
    const spec = freezeSessionSpec(specInput);
    const sessionId = this.#createSessionId();
    if (this.#sessions.has(sessionId)) {
      throw new RelaySessionError("session_exists", `Session ${sessionId} already exists`);
    }

    const sessionGlossaries = compileSessionGlossaries(spec);
    const [participantA, participantB] = await Promise.all([
      this.#endpointGrant(sessionId, "A"),
      this.#endpointGrant(sessionId, "B"),
    ]);
    if (participantA.side !== "A" || participantB.side !== "B") {
      throw new RelaySessionError("invalid_spec", "Endpoint grants were returned for the wrong side");
    }

    const openedAtMs = this.#now();
    const runtime: SessionRuntime = {
      sessionId,
      spec,
      ...(sessionGlossaries === undefined
        ? {}
        : {
            compiledGlossary: sessionGlossaries.primary,
            compiledGlossaries: sessionGlossaries.byLane,
          }),
      participants: Object.freeze({ A: Object.freeze(participantA), B: Object.freeze(participantB) }),
      connected: { A: false, B: false },
      speaking: { A: false, B: false },
      fences: { A_TO_B: new GenerationFence(), B_TO_A: new GenerationFence() },
      laneRuns: { A_TO_B: undefined, B_TO_A: undefined },
      playout: {
        A: new AsyncQueue(spec.maxQueueFrames ?? 25),
        B: new AsyncQueue(spec.maxQueueFrames ?? 25),
      },
      playoutEvidenceCursors: { A: undefined, B: undefined },
      sourceEvidenceCursors: { A: undefined, B: undefined },
      subscribers: new Set(),
      events: [],
      commands: new Map(),
      ingressController: new AbortController(),
      playoutController: new AbortController(),
      backgroundTasks: [],
      firstAudio: new Set(),
      speechOnsets: { A_TO_B: undefined, B_TO_A: undefined },
      transcripts: {
        A_TO_B: { generation: 0, source: "", target: "" },
        B_TO_A: { generation: 0, source: "", target: "" },
      },
      status: "waiting",
      cursor: 0,
      openedAtMs,
      closedAtMs: undefined,
      evidenceHealthAlerted: false,
    };
    this.#sessions.set(sessionId, runtime);

    const snapshot = this.#snapshot(runtime);
    this.#emit(runtime, { type: "session_opened", snapshot });
    runtime.backgroundTasks.push(this.#runIngress(runtime));
    runtime.backgroundTasks.push(this.#runPlayout(runtime, "A"));
    runtime.backgroundTasks.push(this.#runPlayout(runtime, "B"));
    return this.#snapshot(runtime);
  }

  snapshot(sessionId: string): SessionSnapshot {
    return this.#snapshot(this.#requireSession(sessionId));
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    const runtime = this.#requireSession(sessionId);
    if (command.commandId.trim().length === 0) {
      throw new RelaySessionError("invalid_command", "commandId is required");
    }
    const fingerprint = command.type === "end"
      ? command.type + "\u0000" + (command.reason ?? "")
      : command.type;
    const existing = runtime.commands.get(command.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new RelaySessionError(
          "invalid_command",
          "commandId cannot be reused for a different command",
        );
      }
      await existing.completion;
      return;
    }

    const completion = this.#applyCommand(runtime, command);
    runtime.commands.set(command.commandId, { fingerprint, completion });
    try {
      await completion;
    } catch (error: unknown) {
      if (runtime.commands.get(command.commandId)?.completion === completion) {
        runtime.commands.delete(command.commandId);
      }
      throw error;
    }
  }

  async #applyCommand(runtime: SessionRuntime, command: RelayCommand): Promise<void> {
    switch (command.type) {
      case "start":
        if (runtime.status !== "ready") {
          throw this.#invalidState(runtime, "start");
        }
        try {
          await Promise.all((["A_TO_B", "B_TO_A"] as const).map((lane) =>
            this.#translation.prepare(this.#laneContext(runtime, lane)),
          ));
          if (runtime.status !== "ready") {
            await Promise.allSettled([
              this.#translation.closeSession(runtime.sessionId),
            ]);
            return;
          }
          this.#setStatus(runtime, "active", command.commandId);
        } catch (error: unknown) {
          await Promise.allSettled([this.#translation.closeSession(runtime.sessionId)]);
          throw error;
        }
        return;
      case "pause":
        if (runtime.status !== "active") {
          throw this.#invalidState(runtime, "pause");
        }
        this.#setStatus(runtime, "paused", command.commandId);
        this.#cutLane(runtime, "A_TO_B", "pause");
        this.#cutLane(runtime, "B_TO_A", "pause");
        return;
      case "resume":
        if (runtime.status !== "paused" || !runtime.connected.A || !runtime.connected.B) {
          throw this.#invalidState(runtime, "resume");
        }
        this.#setStatus(runtime, "active", command.commandId);
        return;
      case "end":
        await this.#end(runtime, command.commandId, command.reason ?? "operator_end");
        return;
    }
  }

  events(
    sessionId: string,
    after: EventCursor = 0,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const runtime = this.#requireSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RelaySessionError("invalid_command", "Event cursor must be a non-negative safe integer");
    }
    return this.#eventStream(runtime, after, signal);
  }

  async *#eventStream(
    runtime: SessionRuntime,
    after: number,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const queue = new AsyncQueue<SessionEvent>(this.#eventHistoryLimit);
    const onAbort = (): void => {
      queue.close();
    };
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (const event of runtime.events) {
        if (signal?.aborted) return;
        if (event.cursor > after && !queue.offer(event)) break;
      }
      if (runtime.status !== "closed" && !signal?.aborted) runtime.subscribers.add(queue);
      else queue.close();

      for await (const event of queue) {
        if (signal?.aborted) return;
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      runtime.subscribers.delete(queue);
      queue.close();
    }
  }

  async #runIngress(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const event of this.#media.frames({
        sessionId: runtime.sessionId,
        signal: runtime.ingressController.signal,
      })) {
        this.#handleIngress(runtime, event);
      }
    } catch (error: unknown) {
      if (!runtime.ingressController.signal.aborted) {
        this.#emitAlert(runtime, null, null, "media_ingress_failed", this.#errorMessage(error), true);
      }
    }
  }

  #handleIngress(runtime: SessionRuntime, event: MediaIngressEvent): void {
    if (runtime.status === "closing" || runtime.status === "closed") return;
    if (event.sessionId !== runtime.sessionId) {
      this.#emitAlert(runtime, null, null, "wrong_session_media", "Rejected media for another session", false);
      return;
    }

    switch (event.type) {
      case "alert":
        this.#emitAlert(
          runtime,
          null,
          null,
          event.code,
          event.message,
          event.retryable,
        );
        return;
      case "participant_state":
        runtime.connected[event.side] = event.connected;
        if (!event.connected) this.#finishUtterance(runtime, event.side);
        this.#emit(runtime, {
          type: "participant_state",
          side: event.side,
          connected: event.connected,
        });
        if (runtime.status === "waiting" && runtime.connected.A && runtime.connected.B) {
          this.#setStatus(runtime, "ready");
        } else if (runtime.status === "ready" && (!runtime.connected.A || !runtime.connected.B)) {
          this.#setStatus(runtime, "waiting");
        } else if (!event.connected && (runtime.status === "active" || runtime.status === "paused")) {
          this.#emitAlert(
            runtime,
            null,
            null,
            "participant_disconnected",
            `Participant ${event.side} disconnected`,
            true,
          );
        }
        return;
      case "speech_started":
        if (runtime.status === "active") {
          runtime.speaking[event.side] = true;
          const ownLane = laneFromSource(event.side);
          if (runtime.spec.profile !== "native_live_baseline") {
            this.#cutLane(runtime, ownLane, "operator");
          } else {
            this.#resetTranscripts(runtime, ownLane, runtime.fences[ownLane].generation);
          }
          const generation = runtime.fences[ownLane].generation;
          runtime.firstAudio.delete(`${ownLane}:${generation}`);
          runtime.speechOnsets[ownLane] = Object.freeze({
            generation,
            startedAtMs: event.timestampMonoMs,
          });
          this.#cutLane(runtime, oppositeInboundLane(event.side), "barge_in");
        }
        return;
      case "speech_ended":
        this.#finishUtterance(runtime, event.side);
        return;
      case "audio":
        if (runtime.status !== "active") return;
        if (
          runtime.spec.profile !== "native_live_baseline" &&
          !runtime.speaking[event.side]
        ) {
          return;
        }
        if (event.frame.lane !== laneFromSource(event.side)) {
          this.#emitAlert(runtime, event.frame.lane, event.frame.generation, "wrong_lane_media", "Rejected audio routed to the wrong lane", false);
          return;
        }
        this.#acceptAudio(runtime, event);
        return;
    }
  }

  #finishUtterance(runtime: SessionRuntime, side: Side): void {
    runtime.speaking[side] = false;
    if (runtime.spec.profile === "native_live_baseline") return;
    const lane = laneFromSource(side);
    const run = runtime.laneRuns[lane];
    if (run !== undefined && !run.input.closed) {
      run.input.close();
    }
  }

  #sourceEvidenceTimeline(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
  ): number | undefined {
    const previous = runtime.sourceEvidenceCursors[side];
    if (previous !== undefined &&
        previous.generation === frame.generation &&
        frame.sequence <= previous.sequence) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_source_sequence",
        "Rejected source evidence with a non-increasing frame sequence",
        false,
      );
      return undefined;
    }
    const sequenceDistance = previous?.generation === frame.generation
      ? frame.sequence - previous.sequence
      : 0;
    const timelineAtMonoMs = sequenceDistance === 0
      ? frame.capturedAtMs
      : Math.max(
          frame.capturedAtMs,
          previous!.timelineAtMonoMs +
            sequenceDistance * CANONICAL_AUDIO.frameDurationMs,
        );
    runtime.sourceEvidenceCursors[side] = Object.freeze({
      generation: frame.generation,
      sequence: frame.sequence,
      timelineAtMonoMs,
    });
    return timelineAtMonoMs;
  }
  #acceptAudio(runtime: SessionRuntime, event: Extract<MediaIngressEvent, { type: "audio" }>): void {
    const lane = laneFromSource(event.side);
    const generation = runtime.fences[lane].generation;
    const frame = Object.freeze({
      ...event.frame,
      sessionId: runtime.sessionId,
      lane,
      generation,
    });
    const onset = runtime.speechOnsets[lane];
    if (onset === undefined || onset.generation !== generation) {
      runtime.speechOnsets[lane] = Object.freeze({
        generation,
        startedAtMs: frame.capturedAtMs,
      });
    }
    const timelineAtMonoMs = this.#sourceEvidenceTimeline(
      runtime,
      event.side,
      frame,
    );
    if (timelineAtMonoMs !== undefined) {
      this.#recordEvidence(runtime, {
        type: "audio",
        sessionId: runtime.sessionId,
        track: sourceTrack(event.side),
        timelineAtMonoMs,
        frame,
      });
    }

    const laneRun = this.#ensureLaneRun(runtime, lane);
    if (laneRun.input.offerLatest(frame) === "dropped_oldest") {
      this.#emitAlert(
        runtime,
        lane,
        generation,
        "source_queue_trimmed",
        "Dropped the oldest queued source frame to preserve the latency budget",
        true,
      );
    }
  }

  #laneContext(
    runtime: SessionRuntime,
    lane: Lane,
    generation = runtime.fences[lane].generation,
  ): LaneContext {
    const languages = laneLanguages(runtime.spec, lane);
    const glossary = runtime.compiledGlossaries?.[lane];
    return Object.freeze({
      sessionId: runtime.sessionId,
      lane,
      generation,
      sourceLanguage: languages.sourceLanguage,
      targetLanguage: languages.targetLanguage,
      profile: runtime.spec.profile,
      ...(glossary === undefined ? {} : { glossary }),
    });
  }

  #ensureLaneRun(runtime: SessionRuntime, lane: Lane): LaneRun {
    const existing = runtime.laneRuns[lane];
    const generation = runtime.fences[lane].generation;
    if (existing !== undefined && existing.generation === generation) return existing;

    const input = new AsyncQueue<import("./audio.js").AudioFrame>(runtime.spec.maxQueueFrames ?? 25);
    const controller = new AbortController();
    const context = this.#laneContext(runtime, lane, generation);

    let laneRun!: LaneRun;
    const task = this.#consumeTranslation(runtime, input, context, controller.signal).finally(() => {
      if (runtime.laneRuns[lane] === laneRun) runtime.laneRuns[lane] = undefined;
    });
    laneRun = { generation, input, controller, task };
    runtime.laneRuns[lane] = laneRun;
    runtime.backgroundTasks.push(task);
    return laneRun;
  }

  async #consumeTranslation(
    runtime: SessionRuntime,
    frames: AsyncIterable<import("./audio.js").AudioFrame>,
    context: LaneContext,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of this.#translation.translate({ frames, context, signal })) {
        this.#handleTranslation(runtime, event);
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.#emitAlert(runtime, context.lane, context.generation, "translation_failed", this.#errorMessage(error), true);
      }
    }
  }

  #resetTranscripts(
    runtime: SessionRuntime,
    lane: Lane,
    generation: number,
  ): TranscriptAccumulator {
    const accumulator = runtime.transcripts[lane];
    accumulator.generation = generation;
    accumulator.source = "";
    accumulator.target = "";
    return accumulator;
  }

  #appendTranscript(
    runtime: SessionRuntime,
    lane: Lane,
    generation: number,
    field: "source" | "target",
    delta: string,
  ): string {
    const existing = runtime.transcripts[lane];
    const accumulator = existing.generation === generation
      ? existing
      : this.#resetTranscripts(runtime, lane, generation);
    accumulator[field] += delta;
    return accumulator[field];
  }

  #handleTranslation(runtime: SessionRuntime, event: TranslationEvent): void {
    if (
      runtime.status !== "active" ||
      event.sessionId !== runtime.sessionId ||
      !runtime.fences[event.lane].accepts(event.generation)
    ) {
      return;
    }

    switch (event.type) {
      case "source_transcript_delta": {
        const text = this.#appendTranscript(runtime, event.lane, event.generation, "source", event.delta);
        this.#emit(
          runtime,
          { type: "source_transcript", text, final: false },
          event.lane,
          event.generation,
        );
        return;
      }
      case "target_transcript_delta": {
        const text = this.#appendTranscript(runtime, event.lane, event.generation, "target", event.delta);
        this.#emit(
          runtime,
          { type: "target_transcript", text, final: false },
          event.lane,
          event.generation,
        );
        return;
      }
      case "terminology":
        if (event.status === "bound") {
          this.#emit(runtime, {
            type: "glossary_bound",
            glossaryHash: event.glossaryHash,
            entryIds: event.entryIds,
          }, event.lane, event.generation);
        } else if (event.status === "authorized") {
          this.#emit(runtime, {
            type: "glossary_authorized",
            glossaryHash: event.glossaryHash,
            text: event.text,
            guaranteedTargetExact: event.guaranteedTargetExact,
          }, event.lane, event.generation);
        }
        return;
      case "error":
        this.#emitAlert(
          runtime,
          event.lane,
          event.generation,
          event.error.code,
          event.error.message,
          event.error.retryable,
        );
        return;
      case "completed": {
        const transcript = runtime.transcripts[event.lane];
        if (transcript.generation === event.generation) {
          if (transcript.source.length > 0) {
            this.#emit(runtime, { type: "source_transcript", text: transcript.source, final: true }, event.lane, event.generation);
          }
          if (transcript.target.length > 0) {
            this.#emit(runtime, { type: "target_transcript", text: transcript.target, final: true }, event.lane, event.generation);
          }
        }
        return;
      }
      case "audio": {
        const side = destinationForLane(event.lane);
        const frame = Object.freeze({
          ...event.frame,
          sessionId: runtime.sessionId,
          lane: event.lane,
          generation: event.generation,
        });
        if (runtime.playout[side].offerLatest(frame) === "dropped_oldest") {
          this.#emitAlert(
            runtime,
            event.lane,
            event.generation,
            "playout_queue_trimmed",
            "Dropped the oldest queued playout frame to preserve the latency budget",
            true,
          );
        }
        return;
      }
    }
  }

  async #runPlayout(runtime: SessionRuntime, side: Side): Promise<void> {
    try {
      await this.#media.play({
        sessionId: runtime.sessionId,
        side,
        frames: this.#currentPlayout(runtime, side),
        signal: runtime.playoutController.signal,
        onPlayoutStarted: (frame, startedAtMonoMs) =>
          this.#acceptPlayout(runtime, side, frame, startedAtMonoMs),
      });
    } catch (error: unknown) {
      if (!runtime.playoutController.signal.aborted) {
        this.#emitAlert(runtime, null, null, "media_playout_failed", this.#errorMessage(error), true);
      }
    }
  }

  #playoutEvidenceTimeline(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
    startedAtMonoMs: number,
  ): number | undefined {
    if (!Number.isFinite(startedAtMonoMs) || startedAtMonoMs < 0) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_playout_timeline",
        "Rejected playout evidence with an invalid audible start timestamp",
        false,
      );
      return undefined;
    }
    const previous = runtime.playoutEvidenceCursors[side];
    if (previous !== undefined && previous.generation === frame.generation && frame.sequence <= previous.sequence) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_playout_sequence",
        "Rejected playout evidence with a non-increasing frame sequence",
        false,
      );
      return undefined;
    }
    const sequenceDistance = previous?.generation === frame.generation
      ? frame.sequence - previous.sequence
      : 0;
    const timelineAtMonoMs = sequenceDistance === 0
      ? startedAtMonoMs
      : Math.max(startedAtMonoMs, previous!.timelineAtMonoMs + sequenceDistance * CANONICAL_AUDIO.frameDurationMs);
    runtime.playoutEvidenceCursors[side] = Object.freeze({
      generation: frame.generation,
      sequence: frame.sequence,
      timelineAtMonoMs,
    });
    return timelineAtMonoMs;
  }
  #acceptPlayout(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
    startedAtMonoMs: number,
  ): void {
    if (
      runtime.status !== "active" ||
      frame.sessionId !== runtime.sessionId ||
      destinationForLane(frame.lane) !== side ||
      !runtime.fences[frame.lane].accepts(frame.generation)
    ) {
      return;
    }
    const timelineAtMonoMs = this.#playoutEvidenceTimeline(runtime, side, frame, startedAtMonoMs);
    if (timelineAtMonoMs === undefined) return;

    this.#recordEvidence(runtime, {
      type: "audio",
      sessionId: runtime.sessionId,
      track: playoutTrack(side),
      timelineAtMonoMs,
      frame,
    });
    const firstAudioKey = frame.lane + ":" + frame.generation;
    if (runtime.firstAudio.has(firstAudioKey)) return;
    runtime.firstAudio.add(firstAudioKey);
    const onset = runtime.speechOnsets[frame.lane];
    const latencyMs = onset?.generation === frame.generation
      ? Math.max(0, startedAtMonoMs - onset.startedAtMs)
      : 0;
    this.#emit(
      runtime,
      { type: "audio_playout", frame, latencyMs },
      frame.lane,
      frame.generation,
    );
  }

  async *#currentPlayout(
    runtime: SessionRuntime,
    side: Side,
  ): AsyncIterable<import("./audio.js").AudioFrame> {
    const lane = oppositeInboundLane(side);
    for await (const frame of runtime.playout[side]) {
      if (runtime.fences[lane].accepts(frame.generation)) yield frame;
    }
  }

  #cutLane(
    runtime: SessionRuntime,
    lane: Lane,
    reason: "barge_in" | "pause" | "end" | "operator",
  ): void {
    const fence = runtime.fences[lane];
    const previousGeneration = fence.generation;
    const nextGeneration = previousGeneration + 1;
    fence.cut(nextGeneration);
    this.#resetTranscripts(runtime, lane, nextGeneration);
    runtime.speechOnsets[lane] = undefined;

    const run = runtime.laneRuns[lane];
    if (run !== undefined) {
      run.input.close();
      run.controller.abort();
    }

    this.#emit(
      runtime,
      { type: "generation_cut", previousGeneration, reason },
      lane,
      nextGeneration,
    );
    const side = destinationForLane(lane);
    void Promise.allSettled([
      this.#translation.cancel({ sessionId: runtime.sessionId, lane, generation: previousGeneration }),
      this.#media.clear({
        sessionId: runtime.sessionId,
        lane,
        generation: nextGeneration,
        side,
      }),
    ]);
  }

  async #end(runtime: SessionRuntime, commandId: string, reason: string): Promise<void> {
    if (runtime.status === "closed" || runtime.status === "closing") return;
    this.#setStatus(runtime, "closing", commandId);
    this.#cutLane(runtime, "A_TO_B", "end");
    this.#cutLane(runtime, "B_TO_A", "end");
    runtime.ingressController.abort();
    for (const lane of ["A_TO_B", "B_TO_A"] as const) {
      runtime.laneRuns[lane]?.input.close();
      runtime.laneRuns[lane]?.controller.abort();
    }
    runtime.playout.A.close();
    runtime.playout.B.close();
    runtime.playoutController.abort();

    await Promise.allSettled(runtime.backgroundTasks);
    runtime.closedAtMs = this.#now();
    this.#setStatus(runtime, "closed", commandId);
    this.#emit(runtime, { type: "session_closed", reason });
    const [mediaCleanup, translationCleanup, evidenceCleanup] = await Promise.allSettled([
      Promise.resolve(this.#media.closeSession(runtime.sessionId)),
      this.#translation.closeSession(runtime.sessionId),
      this.#evidence.close(runtime.sessionId),
    ]);
    if (mediaCleanup.status === "rejected") {
      this.#emitAlert(
        runtime,
        null,
        null,
        "media_cleanup_failed",
        this.#errorMessage(mediaCleanup.reason),
        true,
      );
    }
    if (translationCleanup.status === "rejected") {
      this.#emitAlert(
        runtime,
        null,
        null,
        "translation_cleanup_failed",
        this.#errorMessage(translationCleanup.reason),
        true,
      );
    }
    if (evidenceCleanup.status === "rejected") {
      this.#emitAlert(
        runtime,
        null,
        null,
        "evidence_finalize_failed",
        this.#errorMessage(evidenceCleanup.reason),
        true,
      );
    }
    for (const subscriber of runtime.subscribers) {
      subscriber.close();
    }
    runtime.subscribers.clear();
    this.#retainClosedSession(runtime);
  }

  #retainClosedSession(runtime: SessionRuntime): void {
    if (this.#closedSessionIds.includes(runtime.sessionId)) {
      return;
    }
    this.#closedSessionIds.push(runtime.sessionId);
    while (this.#closedSessionIds.length > this.#closedSessionHistoryLimit) {
      const expiredSessionId = this.#closedSessionIds.shift();
      if (expiredSessionId === undefined) break;
      const expiredRuntime = this.#sessions.get(expiredSessionId);
      if (
        expiredRuntime?.status === "closed" &&
        expiredRuntime.subscribers.size === 0
      ) {
        this.#sessions.delete(expiredSessionId);
      }
    }
  }

  #setStatus(runtime: SessionRuntime, status: SessionStatus, commandId?: string): void {
    if (runtime.status === status) return;
    const previousStatus = runtime.status;
    runtime.status = status;
    this.#emit(runtime, {
      type: "session_state",
      previousStatus,
      status,
      ...(commandId === undefined ? {} : { commandId }),
    });
  }

  #emitAlert(
    runtime: SessionRuntime,
    lane: Lane | null,
    generation: number | null,
    code: string,
    message: string,
    retryable: boolean,
  ): void {
    this.#emit(
      runtime,
      {
        type: "alert",
        alert: Object.freeze({ code, message, retryable }),
      },
      lane,
      generation,
    );
  }

  #emit(
    runtime: SessionRuntime,
    payload: Readonly<Record<string, unknown> & { type: SessionEvent["type"] }>,
    lane: Lane | null = null,
    generation: number | null = null,
    persist = true,
  ): SessionEvent {
    const event = Object.freeze({
      ...payload,
      cursor: runtime.cursor + 1,
      sessionId: runtime.sessionId,
      timestampMonoMs: this.#now(),
      lane,
      generation,
    }) as unknown as SessionEvent;
    runtime.cursor = event.cursor;
    runtime.events.push(event);
    if (runtime.events.length > this.#eventHistoryLimit) runtime.events.shift();
    for (const subscriber of runtime.subscribers) subscriber.offer(event);

    if (persist) {
      this.#recordEvidence(runtime, {
        type: "session_event",
        sessionId: runtime.sessionId,
        event,
      });
    }
    return event;
  }

  #recordEvidence(runtime: SessionRuntime, record: EvidenceRecord): void {
    if (this.#evidence.record(record) || runtime.evidenceHealthAlerted) return;
    runtime.evidenceHealthAlerted = true;
    this.#emit(
      runtime,
      {
        type: "alert",
        alert: Object.freeze({
          code: "evidence_backpressure",
          message: "Evidence queue is unhealthy; media continues without interruption",
          retryable: true,
        }),
      },
      null,
      null,
      false,
    );
  }

  #snapshot(runtime: SessionRuntime): SessionSnapshot {
    return Object.freeze({
      sessionId: runtime.sessionId,
      status: runtime.status,
      spec: runtime.spec,
      participants: runtime.participants,
      generations: Object.freeze({
        A_TO_B: runtime.fences.A_TO_B.generation,
        B_TO_A: runtime.fences.B_TO_A.generation,
      }),
      ...(runtime.compiledGlossary === undefined
        ? {}
        : {
            glossary: Object.freeze({
              id: runtime.compiledGlossary.id,
              version: runtime.compiledGlossary.version,
              hash: runtime.compiledGlossary.hash,
            }),
          }),
      eventCursor: runtime.cursor,
      openedAtMs: runtime.openedAtMs,
      ...(runtime.closedAtMs === undefined ? {} : { closedAtMs: runtime.closedAtMs }),
    });
  }

  #requireSession(sessionId: string): SessionRuntime {
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined) {
      throw new RelaySessionError("invalid_session", `Unknown session ${sessionId}`);
    }
    return runtime;
  }

  #invalidState(runtime: SessionRuntime, command: string): RelaySessionError {
    return new RelaySessionError(
      "invalid_command",
      `Cannot ${command} a session in ${runtime.status} state`,
    );
  }

  #errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown adapter failure";
  }
}

import type {
  AudioFrame,
  GenerationRef,
  LaneContext,
  TranslationCapabilities,
  TranslationCompletedEvent,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
  TranslationTranscriptEvent,
} from "../../core/types.js";

/**
 * This is an injection-only capability descriptor. The public provider-id
 * union intentionally has no test-only member, so the fake uses the configured
 * controlled-provider identity when a test needs to provide capabilities to a
 * relay. Composition never constructs this adapter from TRANSLATION_PROVIDER.
 */
export const DETERMINISTIC_TRANSLATION_CAPABILITIES: TranslationCapabilities =
  Object.freeze({
    providerId: "openai_controlled",
    supportedModes: Object.freeze([
      Object.freeze({ mode: "fast" as const, behaviorVersion: 1 as const, deterministicGlossary: true }),
      Object.freeze({ mode: "balanced" as const, behaviorVersion: 1 as const, deterministicGlossary: true }),
      Object.freeze({ mode: "accurate" as const, behaviorVersion: 1 as const, deterministicGlossary: true }),
    ]),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: true,
  });

export interface DeterministicTranslationAdapterOptions {
  readonly now?: () => number;
}

/**
 * Keyless normalized-event fixture for unit and acceptance injection.
 *
 * It deliberately does not appear in production configuration. Its output is
 * predictable, but it still observes the requested behavior so the three
 * product modes exercise their distinct event contracts.
 */
export class DeterministicTranslationAdapter implements TranslationPort {
  readonly capabilities = DETERMINISTIC_TRANSLATION_CAPABILITIES;
  readonly #now: () => number;
  readonly #cancelled = new Set<string>();
  readonly #nextPlayoutSequence = new Map<string, number>();

  constructor(options: DeterministicTranslationAdapterOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  async prepare(context: LaneContext): Promise<void> {
    assertUsableContext(context);
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const { context } = request;
    assertUsableContext(context);
    const key = generationKey(context);
    let playoutSequence = this.#nextPlayoutSequence.get(key) ?? 0;
    let transcriptsEmitted = false;
    const buffered = [];

    for await (const frame of request.frames) {
      if (isCancelled(this.#cancelled, key, request.signal)) {
        this.#nextPlayoutSequence.delete(key);
        yield completed(context, playoutSequence, this.#now());
        return;
      }
      if (context.behavior.inputCommit === "speech_end") {
        buffered.push(frame);
        continue;
      }
      for (const event of eventsForFrame(
        context,
        frame,
        playoutSequence,
        transcriptsEmitted,
        this.#now(),
      )) {
        if (isCancelled(this.#cancelled, key, request.signal)) {
          this.#nextPlayoutSequence.delete(key);
          yield completed(context, playoutSequence, this.#now());
          return;
        }
        if (event.kind === "audio") {
          playoutSequence = event.playoutSequence + 1;
          this.#nextPlayoutSequence.set(key, playoutSequence);
        }
        yield event;
      }
      transcriptsEmitted = true;
    }

    for (const frame of buffered) {
      if (isCancelled(this.#cancelled, key, request.signal)) {
        this.#nextPlayoutSequence.delete(key);
        yield completed(context, playoutSequence, this.#now());
        return;
      }
      for (const event of eventsForFrame(
        context,
        frame,
        playoutSequence,
        transcriptsEmitted,
        this.#now(),
      )) {
        if (isCancelled(this.#cancelled, key, request.signal)) {
          this.#nextPlayoutSequence.delete(key);
          yield completed(context, playoutSequence, this.#now());
          return;
        }
        if (event.kind === "audio") {
          playoutSequence = event.playoutSequence + 1;
          this.#nextPlayoutSequence.set(key, playoutSequence);
        }
        yield event;
      }
      transcriptsEmitted = true;
    }

    yield completed(context, playoutSequence, this.#now());
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const key = generationKey(generation);
    this.#cancelled.add(key);
    this.#nextPlayoutSequence.delete(key);
  }

  async closeSession(sessionId: string): Promise<void> {
    const prefix = sessionId + "\u0000";
    for (const key of this.#cancelled) {
      if (key.startsWith(prefix)) this.#cancelled.delete(key);
    }
    for (const key of this.#nextPlayoutSequence.keys()) {
      if (key.startsWith(prefix)) this.#nextPlayoutSequence.delete(key);
    }
  }
}

function assertUsableContext(context: LaneContext): void {
  if (context.turnId.trim() === "") {
    throw new TypeError("Deterministic translation requires a non-empty turnId");
  }
  if (!DETERMINISTIC_TRANSLATION_CAPABILITIES.supportedModes.some(
    (capability) =>
      capability.mode === context.behavior.mode &&
      capability.behaviorVersion === context.behavior.version,
  )) {
    throw new TypeError("Unsupported deterministic translation behavior");
  }
}

function isCancelled(
  cancelled: ReadonlySet<string>,
  key: string,
  signal: AbortSignal,
): boolean {
  return cancelled.has(key) || signal.aborted;
}

function* eventsForFrame(
  context: LaneContext,
  frame: AudioFrame,
  playoutSequence: number,
  transcriptsEmitted: boolean,
  emittedAtMs: number,
): Iterable<TranslationEvent> {
  if (!transcriptsEmitted) {
    yield* transcriptEvents(context, emittedAtMs);
  }
  yield {
    ...eventBase(
      context,
      context.turnId + ":audio:" + playoutSequence,
      0,
      "final",
      emittedAtMs,
    ),
    kind: "audio",
    frame,
    playoutSequence,
  };
}

function* transcriptEvents(
  context: LaneContext,
  emittedAtMs: number,
): Iterable<TranslationTranscriptEvent> {
  for (const kind of ["source_transcript", "target_transcript"] as const) {
    const transcript = "[deterministic " + context.behavior.mode + " " +
      (kind === "source_transcript" ? "source" : "target") + " " + context.lane + "]";
    const segmentId = context.turnId + ":" + kind;
    if (context.behavior.transcriptPolicy === "provisional_revisions") {
      yield {
        ...eventBase(context, segmentId, 0, "provisional", emittedAtMs),
        kind,
        text: transcript + " draft",
      };
      yield {
        ...eventBase(context, segmentId, 1, "final", emittedAtMs),
        kind,
        text: transcript + " replacement",
      };
      continue;
    }
    yield {
      ...eventBase(context, segmentId, 0, "final", emittedAtMs),
      kind,
      text: transcript,
    };
  }
}

function completed(
  context: LaneContext,
  revision: number,
  emittedAtMs: number,
): TranslationCompletedEvent {
  return {
    ...eventBase(
      context,
      context.turnId + ":completed",
      revision,
      "final",
      emittedAtMs,
    ),
    kind: "completed",
  };
}

function eventBase(
  context: LaneContext,
  segmentId: string,
  revision: number,
  finality: "provisional" | "final",
  emittedAtMs: number,
) {
  return {
    sessionId: context.sessionId,
    lane: context.lane,
    generation: context.generation,
    turnId: context.turnId,
    segmentId,
    revision,
    finality,
    emittedAtMs,
  } as const;
}

function generationKey(generation: GenerationRef): string {
  return generation.sessionId + "\u0000" + generation.lane + "\u0000" +
    generation.generation;
}

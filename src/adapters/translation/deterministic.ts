import type {
  AudioFrame,
  GenerationRef,
  LaneContext,
  TranslationCapabilities,
  TranslationEvent,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";
import { GenerationPlayoutSequence } from "../../core/playout-sequence.js";
import { assertTranslationBehaviorCapability } from "../../core/translation-capabilities.js";
import {
  attachTranslationEvidenceRef,
  type DraftTranslationEvent,
} from "./evidence-ref.js";

/**
 * This is an injection-only capability descriptor. The public provider-id
 * union intentionally has no test-only member, so the fake uses the configured
 * controlled-provider identity when a test needs to provide capabilities to a
 * relay. Production composition is pinned to an approved processing profile;
 * this deterministic adapter is only injected by explicit local fixtures.
 */
export const DETERMINISTIC_TRANSLATION_CAPABILITIES: TranslationCapabilities =
  Object.freeze({
    providerId: "openai_controlled",
    modes: Object.freeze([
      Object.freeze({
        mode: "fast" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "balanced" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "accurate" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: false,
      }),
    ]),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  });

const FIXTURE_LOCAL_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "fixture_local",
  remoteConnection: "not_applicable",
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
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: DeterministicTranslationAdapterOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    assertUsableContext(context);
    return FIXTURE_LOCAL_PREPARATION;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const { context } = request;
    assertUsableContext(context);
    const key = generationKey(context);
    let evidenceOrdinal = 0;
    const withEvidenceRef = (event: DraftTranslationEvent): TranslationEvent =>
      attachTranslationEvidenceRef("deterministic", evidenceOrdinal++, event);
    let playoutSequence = 0;
    let transcriptsEmitted = false;
    const buffered = [];

    for await (const frame of request.frames) {
      if (isCancelled(this.#cancelled, key, request.signal)) {
        this.#playoutSequences.clear(context);
        yield withEvidenceRef(completed(context, playoutSequence, this.#now()));
        return;
      }
      if (context.behavior.inputCommit === "speech_end") {
        buffered.push(frame);
        continue;
      }
      for (const event of eventsForFrame(
        context,
        frame,
        this.#playoutSequences.next(context),
        transcriptsEmitted,
        this.#now(),
      )) {
        if (isCancelled(this.#cancelled, key, request.signal)) {
          this.#playoutSequences.clear(context);
          yield withEvidenceRef(completed(context, playoutSequence, this.#now()));
          return;
        }
        if (event.kind === "audio") {
          playoutSequence = event.playoutSequence + 1;
        }
        yield withEvidenceRef(event);
      }
      transcriptsEmitted = true;
    }

    for (const frame of buffered) {
      if (isCancelled(this.#cancelled, key, request.signal)) {
        this.#playoutSequences.clear(context);
        yield withEvidenceRef(completed(context, playoutSequence, this.#now()));
        return;
      }
      for (const event of eventsForFrame(
        context,
        frame,
        this.#playoutSequences.next(context),
        transcriptsEmitted,
        this.#now(),
      )) {
        if (isCancelled(this.#cancelled, key, request.signal)) {
          this.#playoutSequences.clear(context);
          yield withEvidenceRef(completed(context, playoutSequence, this.#now()));
          return;
        }
        if (event.kind === "audio") {
          playoutSequence = event.playoutSequence + 1;
        }
        yield withEvidenceRef(event);
      }
      transcriptsEmitted = true;
    }

    yield withEvidenceRef(completed(context, playoutSequence, this.#now()));
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const key = generationKey(generation);
    this.#cancelled.add(key);
    this.#playoutSequences.clear(generation);
  }

  async closeSession(sessionId: string): Promise<void> {
    const prefix = sessionId + "\u0000";
    for (const key of this.#cancelled) {
      if (key.startsWith(prefix)) this.#cancelled.delete(key);
    }
    this.#playoutSequences.clearSession(sessionId);
  }
}

function assertUsableContext(context: LaneContext): void {
  if (context.turnId.trim() === "") {
    throw new TypeError("Deterministic translation requires a non-empty turnId");
  }
  assertTranslationBehaviorCapability(
    DETERMINISTIC_TRANSLATION_CAPABILITIES,
    context.behavior,
    { glossaryRequested: context.glossary !== undefined },
  );
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
): Iterable<DraftTranslationEvent> {
  if (!transcriptsEmitted) {
    yield* transcriptEvents(context, emittedAtMs);
  }
  const targetRevision = context.behavior.transcriptPolicy === "provisional_revisions"
    ? 1
    : 0;
  yield {
    ...eventBase(
      context,
      context.turnId + ":audio:" + playoutSequence,
      targetRevision,
      "final",
      emittedAtMs,
    ),
    kind: "audio",
    // The deterministic fixture has one target transcript segment per turn;
    // keep the audio correlation explicit instead of asking downstream code
    // to infer it from the audio segment name.
    targetSegmentId: context.turnId + ":target_transcript",
    frame,
    playoutSequence,
  };
}

function* transcriptEvents(
  context: LaneContext,
  emittedAtMs: number,
): Iterable<DraftTranslationEvent> {
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
): DraftTranslationEvent {
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

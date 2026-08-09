import {
  CANONICAL_AUDIO,
  createAudioFrame,
  type AudioFrame,
  type CanonicalAudioFormat,
} from "../../core/audio.js";
import type { CompiledGlossary, GlossaryAlert } from "../../core/glossary.js";
import { GenerationPlayoutSequence } from "../../core/playout-sequence.js";
import { assertTranslationBehaviorCapability } from "../../core/translation-capabilities.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationCapabilities,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationFallbackPolicy,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";
import {
  attachTranslationEvidenceRef,
  type DraftTranslationEvent,
  type TranslationEvidenceRefSource,
} from "./evidence-ref.js";

export type ControlledTranscriptionInput =
  | Readonly<{ readonly type: "audio"; readonly frame: AudioFrame }>
  | Readonly<GenerationRef & {
      readonly type: "speech_end";
      readonly turnId: string;
    }>;

export interface ControlledTranscriptionRequest {
  readonly events: AsyncIterable<ControlledTranscriptionInput>;
  readonly context: LaneContext;
  readonly keywords?: readonly string[];
  readonly languages?: readonly string[];
  readonly signal: AbortSignal;
}

interface ControlledTranscriptBase extends GenerationRef {
  readonly emittedAtMs: number;
  readonly itemId: string;
  readonly turnId: string;
}

export interface ControlledTranscriptDeltaEvent extends ControlledTranscriptBase {
  readonly type: "transcript_delta";
  readonly delta: string;
}

export interface ControlledTranscriptCompletedEvent extends ControlledTranscriptBase {
  readonly type: "transcript_completed";
  readonly transcript: string;
  readonly confidence?: number;
}

export interface ControlledTranscriptionErrorEvent extends GenerationRef {
  readonly type: "error";
  readonly emittedAtMs: number;
  readonly error: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }>;
}

export type ControlledTranscriptionEvent =
  | ControlledTranscriptDeltaEvent
  | ControlledTranscriptCompletedEvent
  | ControlledTranscriptionErrorEvent;

export interface ControlledTranscriptionPort {
  transcribe(
    request: ControlledTranscriptionRequest,
  ): AsyncIterable<ControlledTranscriptionEvent>;
  cancel(generation: GenerationRef): Promise<void>;
}

export interface ControlledTextTranslationRequest {
  readonly text: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly opaqueTokens?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ControlledTextTranslationPort {
  translate(request: ControlledTextTranslationRequest): Promise<string>;
}

export interface ControlledTtsRequest {
  readonly text: string;
  readonly signal?: AbortSignal;
}

export interface ControlledTtsPort {
  readonly outputFormat: CanonicalAudioFormat;
  synthesize(request: ControlledTtsRequest): AsyncIterable<Uint8Array>;
}

export interface ControlledTranslationAdapterOptions {
  readonly transcriber: ControlledTranscriptionPort;
  readonly translator: ControlledTextTranslationPort;
  readonly tts: ControlledTtsPort;
  /**
   * The wrapper cannot infer whether its injected stages are fixtures, a
   * locally validated route, or an already connected remote task.  Require
   * its owner to state that observation explicitly rather than guessing.
   */
  readonly preparation: TranslationPreparation;
  /**
   * Immutable operational policy projected from the approved processing
   * profile. It governs provider text-translation failure only; successful
   * glossary authorization fail-open remains an independent glossary rule.
   */
  readonly fallback: TranslationFallbackPolicy;
  readonly minimumConfidence?: number;
  readonly now?: () => number;
  readonly evidenceRefSource?: Extract<TranslationEvidenceRefSource, "controlled" | "local_eval">;
}

export const CONTROLLED_TRANSLATION_CAPABILITIES: TranslationCapabilities = Object.freeze({
  providerId: "openai_controlled",
  modes: Object.freeze([
    Object.freeze({
      mode: "fast",
      behaviorVersion: 1,
      state: "unsupported",
      deterministicGlossary: false,
      reason: "Controlled glossary translation only supports accurate behavior.",
    }),
    Object.freeze({
      mode: "balanced",
      behaviorVersion: 1,
      state: "unsupported",
      deterministicGlossary: false,
      reason: "Controlled glossary translation only supports accurate behavior.",
    }),
    Object.freeze({
      mode: "accurate",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: true,
    }),
  ]),
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
});

function isCanonicalTtsFormat(value: unknown): value is CanonicalAudioFormat {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return Object.entries(CANONICAL_AUDIO).every(
    ([key, expected]) => candidate[key] === expected,
  );
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertControlledContext(context: LaneContext): void {
  assertTranslationBehaviorCapability(
    CONTROLLED_TRANSLATION_CAPABILITIES,
    context.behavior,
    { glossaryRequested: context.glossary !== undefined },
  );
}

function freezePreparation(value: TranslationPreparation): TranslationPreparation {
  if (
    value.readiness === "local_route_validated" &&
    value.remoteConnection === "deferred_until_first_turn"
  ) {
    return Object.freeze({
      readiness: "local_route_validated" as const,
      remoteConnection: "deferred_until_first_turn" as const,
    });
  }
  if (
    value.readiness === "remote_task_ready" &&
    value.remoteConnection === "connected"
  ) {
    return Object.freeze({
      readiness: "remote_task_ready" as const,
      remoteConnection: "connected" as const,
    });
  }
  if (
    value.readiness === "fixture_local" &&
    value.remoteConnection === "not_applicable"
  ) {
    return Object.freeze({
      readiness: "fixture_local" as const,
      remoteConnection: "not_applicable" as const,
    });
  }
  throw new TypeError("Controlled translation preparation is not a valid provider-readiness observation");
}

function freezeFallbackPolicy(value: TranslationFallbackPolicy): TranslationFallbackPolicy {
  if (
    typeof value !== "object" ||
    value === null ||
    (value.kind !== "none" && value.kind !== "same_route_fail_open")
  ) {
    throw new TypeError("Controlled translation fallback policy is unsupported");
  }
  return Object.freeze({ kind: value.kind });
}

/**
 * A deep final-turn glossary module: raw provider streaming stays behind the
 * transcriber/translator/TTS adapters, while callers receive only normalized
 * revisions and a target transcript that has passed the target_exact barrier.
 */
export class ControlledTranslationAdapter implements TranslationPort {
  readonly capabilities = CONTROLLED_TRANSLATION_CAPABILITIES;
  readonly #transcriber: ControlledTranscriptionPort;
  readonly #translator: ControlledTextTranslationPort;
  readonly #tts: ControlledTtsPort;
  readonly #minimumConfidence: number;
  readonly #now: () => number;
  readonly #evidenceRefSource: Extract<TranslationEvidenceRefSource, "controlled" | "local_eval">;
  readonly #preparation: TranslationPreparation;
  readonly #fallback: TranslationFallbackPolicy;
  readonly #active = new Map<string, AbortController>();
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: ControlledTranslationAdapterOptions) {
    const minimumConfidence = options.minimumConfidence ?? 0.75;
    if (
      !Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 ||
      minimumConfidence > 1
    ) {
      throw new TypeError("minimumConfidence must be between 0 and 1");
    }
    if (!isCanonicalTtsFormat(options.tts.outputFormat)) {
      throw new TypeError(
        "Controlled TTS must emit 24 kHz mono PCM16LE canonical audio",
      );
    }
    this.#transcriber = options.transcriber;
    this.#translator = options.translator;
    this.#tts = options.tts;
    this.#minimumConfidence = minimumConfidence;
    this.#now = options.now ?? (() => performance.now());
    this.#evidenceRefSource = options.evidenceRefSource ?? "controlled";
    this.#preparation = freezePreparation(options.preparation);
    this.#fallback = freezeFallbackPolicy(options.fallback);
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    assertControlledContext(context);
    return this.#preparation;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    assertControlledContext(request.context);
    const key = generationKey(request.context);
    this.#active.get(key)?.abort();
    const controller = new AbortController();
    this.#active.set(key, controller);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let evidenceOrdinal = 0;
    const withEvidenceRef = (event: DraftTranslationEvent): TranslationEvent =>
      attachTranslationEvidenceRef(this.#evidenceRefSource, evidenceOrdinal++, event);
    let sourceSegmentId: string | undefined;
    let sourceText = "";
    let sourceRevision = 0;

    try {
      const keywords = glossaryKeywords(request.context);
      const transcription = this.#transcriber.transcribe({
        events: transcriptionInput(request, signal),
        context: request.context,
        ...(keywords.length === 0 ? {} : { keywords }),
        languages: [request.context.sourceLanguage],
        signal,
      });
      for await (const event of transcription) {
        if (signal.aborted) break;
        if (event.type === "error") {
          yield withEvidenceRef(errorEvent(
            request.context,
            event.error.code,
            event.error.message,
            event.error.retryable,
            this.#now(),
            "transcription-error",
          ));
          continue;
        }

        const nextSegmentId = "source:" + event.itemId;
        if (sourceSegmentId !== nextSegmentId) {
          sourceSegmentId = nextSegmentId;
          sourceText = "";
          sourceRevision = 0;
        }
        if (event.type === "transcript_delta") {
          sourceText += event.delta;
          yield withEvidenceRef(transcriptEvent(
            request.context,
            "source_transcript",
            sourceSegmentId,
            sourceRevision,
            "provisional",
            sourceText,
            event.emittedAtMs,
          ));
          sourceRevision += 1;
          continue;
        }

        sourceText = event.transcript;
        yield withEvidenceRef(transcriptEvent(
          request.context,
          "source_transcript",
          sourceSegmentId,
          sourceRevision,
          "final",
          sourceText,
          event.emittedAtMs,
        ));
        for await (const translatedEvent of this.#translateTranscript(request, event, signal)) {
          yield withEvidenceRef(translatedEvent);
        }
      }
    } catch {
      if (!signal.aborted) {
        yield withEvidenceRef(errorEvent(
          request.context,
          "TRANSCRIPTION_FAILED",
          "Speech transcription failed; the turn could not be translated.",
          true,
          this.#now(),
          "transcription-failed",
        ));
      }
    } finally {
      if (this.#active.get(key) === controller) {
        this.#active.delete(key);
        if (signal.aborted) this.#playoutSequences.clear(request.context);
      }
    }

    yield withEvidenceRef(completedEvent(request.context, this.#now()));
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const controller = this.#active.get(generationKey(generation));
    controller?.abort();
    this.#playoutSequences.clear(generation);
    try {
      await this.#transcriber.cancel(generation);
    } catch {
      // The local abort fence is authoritative; provider cancellation is best effort.
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.#playoutSequences.clearSession(sessionId);
  }

  async *#translateTranscript(
    request: TranslationRequest,
    event: ControlledTranscriptCompletedEvent,
    signal: AbortSignal,
  ): AsyncIterable<DraftTranslationEvent> {
    const terminologySegmentId = "terminology:" + event.itemId;
    if (
      isUnitInterval(event.confidence) &&
      event.confidence < this.#minimumConfidence
    ) {
      yield errorEvent(
        request.context,
        "TRANSCRIPTION_LOW_CONFIDENCE",
        "Speech transcription confidence was below the configured threshold.",
        false,
        this.#now(),
        terminologySegmentId + ":confidence",
        { confidence: event.confidence },
      );
    }

    const glossary = request.context.glossary;
    const applies = glossary === undefined || (
      normalizeLanguage(glossary.sourceLanguage) ===
        normalizeLanguage(request.context.sourceLanguage) &&
      normalizeLanguage(glossary.targetLanguage) ===
        normalizeLanguage(request.context.targetLanguage)
    );
    if (!applies) {
      yield errorEvent(
        request.context,
        "GLOSSARY_DIRECTION_MISMATCH",
        "The pinned glossary does not match this translation direction.",
        false,
        this.#now(),
        terminologySegmentId + ":direction",
      );
    }

    const activeGlossary = applies ? glossary : undefined;
    const nearMisses = activeGlossary === undefined
      ? []
      : glossaryNearMisses(event.transcript, activeGlossary);
    if (nearMisses.length > 0) {
      yield errorEvent(
        request.context,
        "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM",
        "Possible unknown or ambiguous terminology was detected.",
        false,
        this.#now(),
        terminologySegmentId + ":uncertain",
      );
    }

    const bound = activeGlossary?.bind(event.transcript);
    if (bound !== undefined && bound.bindings.length > 0) {
      yield terminologyEvent(
        request.context,
        terminologySegmentId,
        0,
        "provisional",
        "bound",
        bound.glossaryHash,
        bound.bindings.map((binding) => binding.entryId),
        bound.text,
        [],
        this.#now(),
      );
    }

    let targetText: string;
    try {
      const translated = await this.#translator.translate({
        text: bound?.text ?? event.transcript,
        sourceLanguage: request.context.sourceLanguage,
        targetLanguage: request.context.targetLanguage,
        ...(bound === undefined
          ? {}
          : { opaqueTokens: bound.bindings.map((binding) => binding.placeholder) }),
        signal,
      });
      if (signal.aborted) return;
      if (bound === undefined || activeGlossary === undefined) {
        targetText = translated;
      } else {
        const authorized = activeGlossary.authorize(translated, bound);
        if (bound.bindings.length > 0) {
          // The authorization gate commits the target segment that follows it.
          // Keeping this identity exact (rather than using the terminology
          // segment) lets consumers retain the gate while the target event is
          // still pending and apply it to the matching revision.
          yield terminologyEvent(
            request.context,
            "target:" + event.itemId,
            0,
            "final",
            authorized.status,
            bound.glossaryHash,
            bound.bindings.map((binding) => binding.entryId),
            authorized.text,
            authorized.guaranteedTargetExact,
            this.#now(),
          );
        }
        targetText = authorized.text;
        for (const alert of authorized.alerts) {
          yield glossaryError(
            request.context,
            alert,
            this.#now(),
            terminologySegmentId + ":" + alert.code,
          );
        }
      }
    } catch {
      if (signal.aborted) return;
      // This provider-failure branch is deliberately separate from the
      // successful-response glossary authorization fail-open above.
      if (this.#fallback.kind === "none") {
        const glossaryBound = bound !== undefined && bound.bindings.length > 0;
        yield errorEvent(
          request.context,
          glossaryBound ? "GLOSSARY_TRANSLATION_FAILED" : "TEXT_TRANSLATION_FAILED",
          glossaryBound
            ? "Text translation failed; the approved fallback policy prohibits source substitution, so glossary target_exact output was not released."
            : "Text translation failed; the approved fallback policy prohibits source substitution, so no target transcript or audio was emitted.",
          true,
          this.#now(),
          "translation-failed:" + event.itemId,
        );
        return;
      }
      const glossaryBound = bound !== undefined && bound.bindings.length > 0;
      if (glossaryBound) {
        yield terminologyEvent(
          request.context,
          terminologySegmentId,
          1,
          "final",
          "bypassed",
          bound.glossaryHash,
          bound.bindings.map((binding) => binding.entryId),
          event.transcript,
          [],
          this.#now(),
        );
      }
      yield errorEvent(
        request.context,
        glossaryBound
          ? "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK"
          : "TEXT_TRANSLATION_FALLBACK",
        glossaryBound
          ? "Text translation failed; glossary target_exact authorization could not be completed, so source substitution was blocked."
          : "Text translation failed; the approved same-route fail-open policy released source speech.",
        true,
        this.#now(),
        "translation-fallback:" + event.itemId,
      );
      if (glossaryBound) return;
      targetText = event.transcript;
    }
    if (signal.aborted) return;

    // This final target event is the commit barrier: terminology-bound output
    // is never released to target playout before authorization/reinsertion.
    yield transcriptEvent(
      request.context,
      "target_transcript",
      "target:" + event.itemId,
      0,
      "final",
      targetText,
      this.#now(),
    );

    try {
      yield* this.#synthesize(targetText, request.context, event.itemId, signal);
    } catch {
      if (!signal.aborted) {
        yield errorEvent(
          request.context,
          "TTS_FAILED",
          "Speech synthesis failed after target text was produced.",
          true,
          this.#now(),
          "tts-failed:" + event.itemId,
        );
      }
    }
  }

  async *#synthesize(
    text: string,
    generation: LaneContext,
    itemId: string,
    signal: AbortSignal,
  ): AsyncIterable<DraftTranslationEvent> {
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    for await (const chunk of this.#tts.synthesize({ text, signal })) {
      if (signal.aborted) return;
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("TTS emitted a non-binary chunk");
      }
      pending = concatenate(pending, chunk);
      while (pending.byteLength >= CANONICAL_AUDIO.bytesPerFrame) {
        const pcm16le = pending.slice(0, CANONICAL_AUDIO.bytesPerFrame);
        pending = pending.slice(CANONICAL_AUDIO.bytesPerFrame);
        yield audioEvent(
          generation,
          itemId,
          this.#playoutSequences.next(generation),
          pcm16le,
          this.#now(),
        );
      }
    }
    if (pending.byteLength > 0 && !signal.aborted) {
      const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
      pcm16le.set(pending);
      yield audioEvent(
        generation,
        itemId,
        this.#playoutSequences.next(generation),
        pcm16le,
        this.#now(),
      );
    }
  }
}

async function* transcriptionInput(
  request: TranslationRequest,
  signal: AbortSignal,
): AsyncIterable<ControlledTranscriptionInput> {
  for await (const frame of request.frames) {
    if (signal.aborted) return;
    yield { type: "audio", frame };
  }
  if (!signal.aborted) {
    yield {
      type: "speech_end",
      ...generationFields(request.context),
      turnId: request.context.turnId,
    };
  }
}

function transcriptEvent(
  generation: LaneContext,
  kind: "source_transcript" | "target_transcript",
  segmentId: string,
  revision: number,
  finality: "provisional" | "final",
  text: string,
  emittedAtMs: number,
): DraftTranslationEvent {
  return {
    kind,
    ...eventFields(generation, segmentId, revision, finality, emittedAtMs),
    text,
  };
}

function terminologyEvent(
  generation: LaneContext,
  segmentId: string,
  revision: number,
  finality: "provisional" | "final",
  status: "bound" | "authorized" | "bypassed",
  glossaryHash: string,
  entryIds: readonly string[],
  text: string,
  guaranteedTargetExact: readonly string[],
  emittedAtMs: number,
): DraftTranslationEvent {
  return {
    kind: "terminology",
    ...eventFields(generation, segmentId, revision, finality, emittedAtMs),
    status,
    glossaryHash,
    entryIds: Object.freeze([...entryIds]),
    text,
    guaranteedTargetExact: Object.freeze([...guaranteedTargetExact]),
  };
}

function audioEvent(
  generation: LaneContext,
  itemId: string,
  sequence: number,
  pcm16le: Uint8Array,
  emittedAtMs: number,
): DraftTranslationEvent {
  return {
    kind: "audio",
    ...eventFields(generation, "audio:" + itemId + ":" + sequence, 0, "final", emittedAtMs),
    // TTS is synthesized from the committed target item. Preserve that exact
    // target segment identity on every audio frame so playout/evidence never
    // has to infer the owning transcript from the audio segment name.
    targetSegmentId: "target:" + itemId,
    playoutSequence: sequence,
    frame: createAudioFrame({
      ...generationFields(generation),
      sequence,
      capturedAtMs: emittedAtMs,
      pcm16le,
    }),
  };
}

function completedEvent(generation: LaneContext, emittedAtMs: number): DraftTranslationEvent {
  return {
    kind: "completed",
    ...eventFields(generation, "completed:" + generation.turnId, 0, "final", emittedAtMs),
  };
}

function glossaryError(
  generation: LaneContext,
  alert: GlossaryAlert,
  emittedAtMs: number,
  segmentId: string,
): Omit<TranslationErrorEvent, "evidenceRef"> {
  const metadata = alert.termId === undefined ? {} : { termId: alert.termId };
  return errorEvent(
    generation,
    "GLOSSARY_" + alert.code.toLocaleUpperCase("en-US"),
    alert.message,
    true,
    emittedAtMs,
    segmentId,
    metadata,
  );
}

function errorEvent(
  generation: LaneContext,
  code: string,
  message: string,
  retryable: boolean,
  emittedAtMs: number,
  segmentId: string,
  metadata: Readonly<{ readonly termId?: string; readonly confidence?: number }> = {},
): Omit<TranslationErrorEvent, "evidenceRef"> {
  return {
    kind: "error",
    ...eventFields(generation, "error:" + segmentId, 0, "final", emittedAtMs),
    error: {
      code,
      message,
      retryable,
      ...(metadata.termId === undefined ? {} : { termId: metadata.termId }),
      ...(metadata.confidence === undefined ? {} : { confidence: metadata.confidence }),
    },
  };
}

function eventFields(
  generation: LaneContext,
  segmentId: string,
  revision: number,
  finality: "provisional" | "final",
  emittedAtMs: number,
): Readonly<GenerationRef & {
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly finality: "provisional" | "final";
  readonly emittedAtMs: number;
}> {
  return {
    ...generationFields(generation),
    turnId: generation.turnId,
    segmentId,
    revision,
    finality,
    emittedAtMs,
  };
}

function generationFields(generation: GenerationRef): GenerationRef {
  return {
    sessionId: generation.sessionId,
    lane: generation.lane,
    generation: generation.generation,
  };
}

function generationKey(generation: GenerationRef): string {
  return generation.sessionId + "\u0000" + generation.lane + "\u0000" +
    generation.generation;
}

function normalizeLanguage(language: string): string {
  return language.trim().toLocaleLowerCase("en-US");
}

function glossaryKeywords(context: LaneContext): readonly string[] {
  if (context.glossary === undefined) return Object.freeze([]);
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const entry of context.glossary.entries) {
    for (const candidate of [entry.source, ...entry.aliases]) {
      const keyword = candidate.normalize("NFKC").trim();
      if (
        keyword.length === 0 ||
        /[<>\r\n]/u.test(keyword) ||
        seen.has(keyword.toLocaleLowerCase("en-US"))
      ) continue;
      seen.add(keyword.toLocaleLowerCase("en-US"));
      keywords.push(keyword);
    }
  }
  return Object.freeze(keywords);
}

function glossaryNearMisses(
  transcript: string,
  glossary: CompiledGlossary,
): readonly string[] {
  const transcriptTokens = terminologyTokens(transcript);
  const misses = new Set<string>();
  for (const entry of glossary.entries) {
    const candidateTokensByTerm = [entry.source, ...entry.aliases].map(terminologyTokens);
    if (candidateTokensByTerm.some((candidateTokens) =>
      containsExactTerminologyCandidate(transcriptTokens, candidateTokens)
    )) {
      continue;
    }
    for (const candidateTokens of candidateTokensByTerm) {
      if (candidateTokens.length === 0 || transcriptTokens.length < candidateTokens.length) {
        continue;
      }
      const candidate = candidateTokens.join("");
      if (candidate.length < 4) continue;
      const windows: string[] = [];
      for (
        let index = 0;
        index <= transcriptTokens.length - candidateTokens.length;
        index += 1
      ) {
        windows.push(
          transcriptTokens.slice(index, index + candidateTokens.length).join(""),
        );
      }
      if (windows.includes(candidate)) continue;
      const threshold = Math.min(3, Math.max(1, Math.ceil(candidate.length * 0.25)));
      if (windows.some((window) => editDistance(window, candidate) <= threshold)) {
        misses.add(entry.source);
        break;
      }
    }
    if (misses.size >= 3) break;
  }
  return Object.freeze([...misses]);
}

function containsExactTerminologyCandidate(
  transcriptTokens: readonly string[],
  candidateTokens: readonly string[],
): boolean {
  if (candidateTokens.length === 0 || transcriptTokens.length < candidateTokens.length) {
    return false;
  }
  for (
    let index = 0;
    index <= transcriptTokens.length - candidateTokens.length;
    index += 1
  ) {
    if (candidateTokens.every((token, offset) => transcriptTokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

function terminologyTokens(value: string): readonly string[] {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
  return normalized.length === 0 ? [] : normalized.split(/\s+/u);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return Uint8Array.from(right);
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

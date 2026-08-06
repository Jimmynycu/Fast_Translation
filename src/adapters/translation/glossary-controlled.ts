import {
  CANONICAL_AUDIO,
  createAudioFrame,
  type AudioFrame,
} from "../../core/audio.js";
import type { CompiledGlossary, GlossaryAlert } from "../../core/glossary.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";

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
  synthesize(request: ControlledTtsRequest): AsyncIterable<Uint8Array>;
}

export interface ControlledTranslationAdapterOptions {
  readonly transcriber: ControlledTranscriptionPort;
  readonly translator: ControlledTextTranslationPort;
  readonly tts: ControlledTtsPort;
  readonly minimumConfidence?: number;
  readonly now?: () => number;
}

export class ControlledTranslationAdapter implements TranslationPort {
  readonly #transcriber: ControlledTranscriptionPort;
  readonly #translator: ControlledTextTranslationPort;
  readonly #tts: ControlledTtsPort;
  readonly #minimumConfidence: number;
  readonly #now: () => number;
  readonly #active = new Map<string, AbortController>();

  constructor(options: ControlledTranslationAdapterOptions) {
    const minimumConfidence = options.minimumConfidence ?? 0.75;
    if (
      !Number.isFinite(minimumConfidence) ||
      minimumConfidence < 0 ||
      minimumConfidence > 1
    ) {
      throw new TypeError("minimumConfidence must be between 0 and 1");
    }
    this.#transcriber = options.transcriber;
    this.#translator = options.translator;
    this.#tts = options.tts;
    this.#minimumConfidence = minimumConfidence;
    this.#now = options.now ?? (() => performance.now());
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const key = generationKey(request.context);
    this.#active.get(key)?.abort();
    const controller = new AbortController();
    this.#active.set(key, controller);
    const signal = AbortSignal.any([request.signal, controller.signal]);
    let emittedSourceDelta = false;

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
          yield errorEvent(
            request.context,
            event.error.code,
            event.error.message,
            event.error.retryable,
            this.#now(),
          );
          continue;
        }
        if (event.type === "transcript_delta") {
          emittedSourceDelta = true;
          yield {
            type: "source_transcript_delta",
            ...generationFields(request.context),
            emittedAtMs: event.emittedAtMs,
            delta: event.delta,
          };
          continue;
        }

        if (!emittedSourceDelta) {
          yield {
            type: "source_transcript_delta",
            ...generationFields(request.context),
            emittedAtMs: event.emittedAtMs,
            delta: event.transcript,
          };
        }
        yield* this.#translateTranscript(request, event, signal);
      }
    } catch {
      if (!signal.aborted) {
        yield errorEvent(
          request.context,
          "TRANSCRIPTION_FAILED",
          "Speech transcription failed; the turn could not be translated.",
          true,
          this.#now(),
        );
      }
    } finally {
      if (this.#active.get(key) === controller) this.#active.delete(key);
    }

    yield {
      type: "completed",
      ...generationFields(request.context),
      emittedAtMs: this.#now(),
    };
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const controller = this.#active.get(generationKey(generation));
    controller?.abort();
    try {
      await this.#transcriber.cancel(generation);
    } catch {
      // The local abort fence is authoritative; provider cancellation is best effort.
    }
  }

  async *#translateTranscript(
    request: TranslationRequest,
    event: ControlledTranscriptCompletedEvent,
    signal: AbortSignal,
  ): AsyncIterable<TranslationEvent> {
    if (
      event.confidence !== undefined &&
      event.confidence < this.#minimumConfidence
    ) {
      yield errorEvent(
        request.context,
        "TRANSCRIPTION_LOW_CONFIDENCE",
        "Speech transcription confidence was below the configured threshold.",
        false,
        this.#now(),
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
      );
    }

    const activeGlossary = applies ? glossary : undefined;
    const nearMisses = activeGlossary === undefined
      ? []
      : glossaryNearMisses(event.transcript, activeGlossary);
    if (nearMisses.length > 0) {
      yield errorEvent(
        request.context,
        "TRANSCRIPTION_LOW_CONFIDENCE",
        "Possible terminology near miss: " + nearMisses.join(", "),
        false,
        this.#now(),
      );
    }
    const bound = activeGlossary?.bind(event.transcript);
    if (bound !== undefined && bound.bindings.length > 0) {
      yield {
        type: "terminology",
        ...generationFields(request.context),
        emittedAtMs: this.#now(),
        status: "bound",
        glossaryHash: bound.glossaryHash,
        entryIds: bound.bindings.map((binding) => binding.entryId),
        text: bound.text,
        guaranteedTargetExact: [],
      };
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
      if (bound === undefined || activeGlossary === undefined) {
        targetText = translated;
      } else {
        const authorized = activeGlossary.authorize(translated, bound);
        if (bound.bindings.length > 0) {
          yield {
            type: "terminology",
            ...generationFields(request.context),
            emittedAtMs: this.#now(),
            status: authorized.status,
            glossaryHash: bound.glossaryHash,
            entryIds: bound.bindings.map((binding) => binding.entryId),
            text: authorized.text,
            guaranteedTargetExact: authorized.guaranteedTargetExact,
          };
        }
        targetText = authorized.text;
        for (const alert of authorized.alerts) {
          yield glossaryError(request.context, alert, this.#now());
        }
      }
    } catch {
      targetText = event.transcript;
      yield errorEvent(
        request.context,
        "TEXT_TRANSLATION_FAILED",
        "Text translation failed; source speech is used as the uninterrupted fallback.",
        true,
        this.#now(),
      );
    }

    yield {
      type: "target_transcript_delta",
      ...generationFields(request.context),
      emittedAtMs: this.#now(),
      delta: targetText,
    };

    try {
      yield* this.#synthesize(targetText, request.context, signal);
    } catch {
      if (!signal.aborted) {
        yield errorEvent(
          request.context,
          "TTS_FAILED",
          "Speech synthesis failed after target text was produced.",
          true,
          this.#now(),
        );
      }
    }
  }

  async *#synthesize(
    text: string,
    generation: GenerationRef,
    signal: AbortSignal,
  ): AsyncIterable<TranslationEvent> {
    let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    let sequence = 0;
    for await (const chunk of this.#tts.synthesize({ text, signal })) {
      if (signal.aborted) return;
      if (!(chunk instanceof Uint8Array)) {
        throw new TypeError("TTS emitted a non-binary chunk");
      }
      pending = concatenate(pending, chunk);
      while (pending.byteLength >= CANONICAL_AUDIO.bytesPerFrame) {
        const pcm16le = pending.slice(0, CANONICAL_AUDIO.bytesPerFrame);
        pending = pending.slice(CANONICAL_AUDIO.bytesPerFrame);
        yield {
          type: "audio",
          ...generationFields(generation),
          emittedAtMs: this.#now(),
          frame: createAudioFrame({
            ...generationFields(generation),
            sequence,
            capturedAtMs: this.#now(),
            pcm16le,
          }),
        };
        sequence += 1;
      }
    }
    if (pending.byteLength > 0 && !signal.aborted) {
      const pcm16le = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
      pcm16le.set(pending);
      yield {
        type: "audio",
        ...generationFields(generation),
        emittedAtMs: this.#now(),
        frame: createAudioFrame({
          ...generationFields(generation),
          sequence,
          capturedAtMs: this.#now(),
          pcm16le,
        }),
      };
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
      turnId: "turn-" + request.context.generation,
    };
  }
}

function glossaryError(
  generation: GenerationRef,
  alert: GlossaryAlert,
  emittedAtMs: number,
): TranslationErrorEvent {
  return errorEvent(
    generation,
    "GLOSSARY_" + alert.code.toLocaleUpperCase("en-US"),
    alert.message,
    false,
    emittedAtMs,
  );
}

function errorEvent(
  generation: GenerationRef,
  code: string,
  message: string,
  retryable: boolean,
  emittedAtMs: number,
): TranslationErrorEvent {
  return {
    type: "error",
    ...generationFields(generation),
    emittedAtMs,
    error: { code, message, retryable },
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
    for (const candidateText of [entry.source, ...entry.aliases]) {
      const candidateTokens = terminologyTokens(candidateText);
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

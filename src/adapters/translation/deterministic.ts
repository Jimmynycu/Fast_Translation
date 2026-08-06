import type {
  GenerationRef,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";

export interface DeterministicTranslationAdapterOptions {
  readonly now?: () => number;
  readonly label?: string;
}

export class DeterministicTranslationAdapter implements TranslationPort {
  readonly #now: () => number;
  readonly #label: string;
  readonly #cancelled = new Set<string>();

  constructor(options: DeterministicTranslationAdapterOptions = {}) {
    this.#now = options.now ?? (() => performance.now());
    this.#label = options.label ?? "deterministic";
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const key = generationKey(request.context);
    if (this.#cancelled.has(key) || request.signal.aborted) {
      yield completed(request.context, this.#now());
      return;
    }

    const message = "[" + this.#label + " " + request.context.lane + "]";
    yield {
      type: "source_transcript_delta",
      ...generationFields(request.context),
      emittedAtMs: this.#now(),
      delta: message,
    };
    yield {
      type: "target_transcript_delta",
      ...generationFields(request.context),
      emittedAtMs: this.#now(),
      delta: message,
    };

    for await (const frame of request.frames) {
      if (this.#cancelled.has(key) || request.signal.aborted) break;
      yield {
        type: "audio",
        ...generationFields(request.context),
        emittedAtMs: this.#now(),
        frame,
      };
    }
    yield completed(request.context, this.#now());
  }

  async prepare(_context: import("../../core/types.js").LaneContext): Promise<void> {}

  async cancel(generation: GenerationRef): Promise<void> {
    this.#cancelled.add(generationKey(generation));
  }

  async closeSession(_sessionId: string): Promise<void> {}
}

function completed(
  generation: GenerationRef,
  emittedAtMs: number,
): TranslationEvent {
  return {
    type: "completed",
    ...generationFields(generation),
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

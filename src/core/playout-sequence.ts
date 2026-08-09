import type { GenerationRef } from "./types.js";

/**
 * Allocates playout sequence numbers at the same session/lane/generation
 * scope used by the relay fence. Consecutive turns in one generation must not
 * restart at zero, because destination playout rejects stale sequence values.
 */
export class GenerationPlayoutSequence {
  readonly #nextByGeneration = new Map<string, number>();

  next(ref: GenerationRef): number {
    const key = generationSequenceKey(ref);
    const sequence = this.#nextByGeneration.get(key) ?? 0;
    this.#nextByGeneration.set(key, sequence + 1);
    return sequence;
  }

  clear(ref: GenerationRef): void {
    this.#nextByGeneration.delete(generationSequenceKey(ref));
  }

  clearBefore(ref: GenerationRef): void {
    const prefix = ref.sessionId + "\u0000" + ref.lane + "\u0000";
    for (const key of this.#nextByGeneration.keys()) {
      if (!key.startsWith(prefix)) continue;
      const generation = Number(key.slice(prefix.length));
      if (Number.isSafeInteger(generation) && generation < ref.generation) this.#nextByGeneration.delete(key);
    }
  }

  clearSession(sessionId: string): void {
    const prefix = sessionId + "\u0000";
    for (const key of this.#nextByGeneration.keys()) {
      if (key.startsWith(prefix)) this.#nextByGeneration.delete(key);
    }
  }
}

function generationSequenceKey(ref: GenerationRef): string {
  return ref.sessionId + "\u0000" + ref.lane + "\u0000" + ref.generation.toString(10);
}

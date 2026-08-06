function assertGeneration(generation: number): void {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
}

export class GenerationFence {
  #generation: number;

  constructor(initialGeneration = 0) {
    assertGeneration(initialGeneration);
    this.#generation = initialGeneration;
  }

  get generation(): number {
    return this.#generation;
  }

  accepts(generation: number): boolean {
    assertGeneration(generation);
    return generation === this.#generation;
  }

  cut(generation: number): boolean {
    assertGeneration(generation);
    if (generation <= this.#generation) return false;
    this.#generation = generation;
    return true;
  }
}

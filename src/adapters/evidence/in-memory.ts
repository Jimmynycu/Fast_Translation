import type { SessionEvidence } from "./encrypted-file.js";

export class InMemoryEvidenceStore<T extends SessionEvidence> {
  readonly #records: T[] = [];
  readonly #closed = new Set<string>();
  readonly #capacity: number;

  constructor(capacity = 10_000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("capacity must be a positive safe integer");
    }
    this.#capacity = capacity;
  }

  record(record: T): boolean {
    if (
      record.sessionId.trim().length === 0 ||
      this.#closed.has(record.sessionId) ||
      this.#records.length >= this.#capacity
    ) {
      return false;
    }
    this.#records.push(structuredClone(record));
    return true;
  }

  async close(sessionId: string): Promise<void> {
    this.#closed.add(sessionId);
  }

  records(sessionId?: string): readonly T[] {
    const records =
      sessionId === undefined
        ? this.#records
        : this.#records.filter((record) => record.sessionId === sessionId);
    return Object.freeze(records.map((record) => structuredClone(record)));
  }
}

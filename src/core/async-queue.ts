interface Waiter<T> {
  readonly owner: symbol;
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (reason: unknown) => void;
}

export class QueueClosedError extends Error {
  constructor(message = "queue is closed") {
    super(message);
    this.name = "QueueClosedError";
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #capacity: number;
  readonly #values: T[] = [];
  readonly #waiters: Waiter<T>[] = [];
  #closed = false;
  #failure: unknown;
  #failed = false;

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError("capacity must be a positive safe integer");
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#values.length;
  }

  get pendingConsumers(): number {
    return this.#waiters.length;
  }

  get closed(): boolean {
    return this.#closed;
  }

  offer(value: T): boolean {
    if (this.#closed) return false;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.#values.length >= this.#capacity) return false;
    this.#values.push(value);
    return true;
  }

  offerLatest(value: T): "accepted" | "dropped_oldest" | "closed" {
    if (this.#closed) return "closed";
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return "accepted";
    }
    const dropped = this.#values.length >= this.#capacity;
    if (dropped) this.#values.shift();
    this.#values.push(value);
    return dropped ? "dropped_oldest" : "accepted";
  }

  offerPriority(
    value: T,
    isEvictable: (candidate: T) => boolean,
  ): "accepted" | "evicted" | "full" | "closed" {
    if (this.#closed) return "closed";
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return "accepted";
    }
    if (this.#values.length < this.#capacity) {
      this.#values.push(value);
      return "accepted";
    }
    const evictIndex = this.#values.findIndex(isEvictable);
    if (evictIndex < 0) return "full";
    this.#values.splice(evictIndex, 1);
    this.#values.push(value);
    return "evicted";
  }

  close(error?: unknown): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    if (error !== undefined) {
      this.#failed = true;
      this.#failure = error;
      this.#values.length = 0;
      for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
      return true;
    }
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
    return true;
  }

  #next(owner: symbol): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return Promise.resolve({ value: this.#values.shift() as T, done: false });
    }
    if (this.#failed) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ owner, resolve, reject });
    });
  }

  #cancel(owner: symbol): void {
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter?.owner !== owner) continue;
      this.#waiters.splice(index, 1);
      waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    const owner = Symbol("async-queue-consumer");
    let active = true;
    return {
      next: () => active ? this.#next(owner) : Promise.resolve({ value: undefined, done: true }),
      return: () => {
        active = false;
        this.#cancel(owner);
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (reason?: unknown) => {
        active = false;
        this.#cancel(owner);
        return Promise.reject(reason);
      },
    };
  }
}

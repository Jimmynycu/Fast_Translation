function positiveInteger(value, fallback, label) {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 1) {
    throw new RangeError(label + " must be a positive integer");
  }
  return candidate;
}

function errorFrom(value) {
  return value instanceof Error ? value : new Error(String(value || "Media connection failed"));
}

export class MediaSocketSupervisor {
  #connect;
  #onOpen;
  #onDisconnect;
  #onRetry;
  #setTimer;
  #clearTimer;
  #baseDelayMs;
  #maximumDelayMs;
  #desired = false;
  #attempts = 0;
  #socket = null;
  #timer = null;
  #connecting = null;

  constructor(options) {
    if (!options || typeof options.connect !== "function") {
      throw new TypeError("Media socket supervisor requires connect()");
    }
    this.#connect = options.connect;
    this.#onOpen = typeof options.onOpen === "function" ? options.onOpen : () => {};
    this.#onDisconnect = typeof options.onDisconnect === "function"
      ? options.onDisconnect
      : () => {};
    this.#onRetry = typeof options.onRetry === "function" ? options.onRetry : () => {};
    this.#setTimer = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
    this.#clearTimer = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
    this.#baseDelayMs = positiveInteger(options.baseDelayMs, 500, "baseDelayMs");
    this.#maximumDelayMs = positiveInteger(
      options.maximumDelayMs,
      10_000,
      "maximumDelayMs",
    );
    if (this.#maximumDelayMs < this.#baseDelayMs) {
      throw new RangeError("maximumDelayMs must not be less than baseDelayMs");
    }
  }

  get socket() {
    return this.#socket;
  }

  get running() {
    return this.#desired;
  }

  async start() {
    if (this.#desired) {
      if (this.#socket) return this.#socket;
      if (this.#connecting) {
        await this.#connecting;
        if (this.#socket) return this.#socket;
      }
      throw new Error("Media socket is already reconnecting");
    }

    this.#desired = true;
    try {
      await this.#connectNow(false);
      if (!this.#socket) throw new Error("Media connection ended before it became ready");
      return this.#socket;
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(code = 1000, reason = "Media stopped") {
    this.#desired = false;
    this.#attempts = 0;
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState < 2) socket.close(code, reason);
  }

  async #connectNow(reconnected) {
    if (!this.#desired || this.#connecting) return;
    const operation = Promise.resolve().then(() => this.#connect());
    this.#connecting = operation;
    try {
      const socket = await operation;
      if (!this.#desired) {
        if (socket.readyState < 2) socket.close(1000, "Media no longer required");
        return;
      }
      this.#socket = socket;
      this.#attempts = 0;
      socket.addEventListener("close", () => this.#handleClose(socket), { once: true });
      this.#onOpen(socket, Object.freeze({ reconnected }));
    } catch (error) {
      if (!reconnected) throw error;
      this.#schedule(errorFrom(error));
    } finally {
      if (this.#connecting === operation) this.#connecting = null;
    }
  }

  #handleClose(socket) {
    if (socket !== this.#socket) return;
    this.#socket = null;
    if (!this.#desired) return;
    this.#onDisconnect();
    this.#schedule(new Error("Media socket closed"));
  }

  #schedule(error) {
    if (!this.#desired || this.#timer !== null) return;
    const delayMs = Math.min(
      this.#baseDelayMs * 2 ** this.#attempts,
      this.#maximumDelayMs,
    );
    this.#attempts += 1;
    this.#onRetry(error, delayMs);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#connectNow(true);
    }, delayMs);
  }
}

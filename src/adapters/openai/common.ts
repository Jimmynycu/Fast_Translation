import WebSocket from "ws";

export type OpenAIAdapterErrorCode =
  | "aborted"
  | "configuration_error"
  | "connection_failed"
  | "invalid_input"
  | "invalid_response"
  | "provider_error"
  | "request_failed"
  | "timeout";

/** A deliberately small, provider-neutral error safe to show outside the adapter. */
export class OpenAIAdapterError extends Error {
  readonly code: OpenAIAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: OpenAIAdapterErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "OpenAIAdapterError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
}

export interface WebSocketConnectOptions {
  readonly headers: Readonly<Record<string, string>>;
}

export type WebSocketFactory = (
  url: string,
  options: WebSocketConnectOptions,
) => WebSocketLike;

export const defaultWebSocketFactory: WebSocketFactory = (url, options) =>
  new WebSocket(url, { headers: options.headers }) as WebSocketLike;

export function requireApiKey(apiKey: string): string {
  if (apiKey.trim().length === 0) {
    throw new OpenAIAdapterError(
      "configuration_error",
      "OpenAI credentials are not configured.",
    );
  }
  return apiKey;
}

export function authorizationHeaders(
  apiKey: string,
): Readonly<Record<string, string>> {
  return {
    Authorization: "Bearer " + requireApiKey(apiKey),
    "Content-Type": "application/json",
  };
}

export function appendModel(url: string, model: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("model", model);
  return parsed.toString();
}

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  const text = websocketText(value);
  if (text === null) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function websocketText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("utf8");
  }
  if (value instanceof ArrayBuffer) {
    return Buffer.from(value).toString("utf8");
  }
  if (Array.isArray(value) && value.every((item) => item instanceof Uint8Array)) {
    return Buffer.concat(value).toString("utf8");
  }
  if (isRecord(value) && "data" in value) {
    return websocketText(value.data);
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(
  object: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = object[field];
  return typeof value === "string" ? value : undefined;
}

export function numberField(
  object: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = object[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function encodePcm16(pcm16le: Uint8Array): string {
  if (pcm16le.byteLength === 0 || pcm16le.byteLength % 2 !== 0) {
    throw new OpenAIAdapterError(
      "invalid_input",
      "Audio must contain complete PCM16 samples.",
    );
  }
  return Buffer.from(
    pcm16le.buffer,
    pcm16le.byteOffset,
    pcm16le.byteLength,
  ).toString("base64");
}

export function decodePcm16(encoded: string): Uint8Array {
  try {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0) {
      throw new Error("invalid PCM16 byte count");
    }
    return Uint8Array.from(decoded);
  } catch {
    throw new OpenAIAdapterError(
      "invalid_response",
      "OpenAI returned invalid audio data.",
    );
  }
}

export function sendJson(socket: WebSocketLike, event: unknown): void {
  try {
    socket.send(JSON.stringify(event));
  } catch {
    throw new OpenAIAdapterError(
      "connection_failed",
      "The OpenAI realtime connection could not send data.",
    );
  }
}

export function closeSocket(socket: WebSocketLike): void {
  try {
    socket.close(1000, "client close");
  } catch {
    // Closing is best-effort and idempotent from the adapter perspective.
  }
}

export function abortedError(): OpenAIAdapterError {
  return new OpenAIAdapterError("aborted", "The OpenAI operation was cancelled.");
}

export function timeoutError(message: string): OpenAIAdapterError {
  return new OpenAIAdapterError("timeout", message, true);
}

export function resolveTimeoutMs(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const timeoutMs = value ?? fallback;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  ) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " must be a positive whole number of milliseconds.",
    );
  }
  return timeoutMs;
}

interface DeadlineOptions {
  readonly timeoutMs: number;
  readonly timeoutMessage: string;
  readonly signal?: AbortSignal;
}

type OperationOutcome<T> =
  | Readonly<{ readonly status: "fulfilled"; readonly value: T }>
  | Readonly<{ readonly status: "rejected"; readonly error: unknown }>
  | Readonly<{ readonly status: "stopped" }>;

export async function runWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  if (options.signal?.aborted === true) throw abortedError();

  const controller = new AbortController();
  let stopReason: "aborted" | "timeout" | undefined;
  let wake: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });
  const stop = (reason: "aborted" | "timeout"): void => {
    if (stopReason !== undefined) return;
    stopReason = reason;
    controller.abort(
      reason === "timeout"
        ? timeoutError(options.timeoutMessage)
        : options.signal?.reason,
    );
    wake?.();
  };
  const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
  const onAbort = (): void => stop("aborted");
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const result: Promise<OperationOutcome<T>> = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value): OperationOutcome<T> => ({ status: "fulfilled", value }),
      (error: unknown): OperationOutcome<T> => ({ status: "rejected", error }),
    );

  try {
    const outcome = await Promise.race<OperationOutcome<T>>([
      result,
      stopped.then(() => ({ status: "stopped" })),
    ]);
    if (stopReason === "timeout") {
      throw timeoutError(options.timeoutMessage);
    }
    if (stopReason === "aborted") throw abortedError();
    if (outcome.status === "rejected") throw outcome.error;
    if (outcome.status === "stopped") {
      throw new OpenAIAdapterError(
        "request_failed",
        "The OpenAI operation stopped unexpectedly.",
      );
    }
    return outcome.value;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: OpenAIAdapterError) => void;
  }> = [];
  #ended = false;
  #failure: OpenAIAdapterError | undefined;

  push(value: T): void {
    if (this.#ended || this.#failure !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ done: false, value });
      return;
    }
    this.#values.push(value);
  }

  end(): void {
    if (this.#ended || this.#failure !== undefined) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: OpenAIAdapterError): void {
    if (this.#ended || this.#failure !== undefined) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.#waiters.push({
            resolve,
            reject: (error) => reject(error),
          });
        });
      },
    };
  }
}

export async function waitForOpen(
  socket: WebSocketLike,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) throw abortedError();
  if (socket.readyState === 1) return;

  await runWithDeadline(
    async (stageSignal) =>
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (callback: () => void): void => {
          if (settled) return;
          settled = true;
          stageSignal.removeEventListener("abort", onAbort);
          callback();
        };
        const onAbort = (): void => finish(() => reject(abortedError()));

        stageSignal.addEventListener("abort", onAbort, { once: true });
        socket.on("open", () => finish(resolve));
        socket.on("error", () =>
          finish(() =>
            reject(
              new OpenAIAdapterError(
                "connection_failed",
                "The OpenAI realtime connection could not be established.",
              ),
            ),
          ),
        );
        socket.on("close", () =>
          finish(() =>
            reject(
              new OpenAIAdapterError(
                "connection_failed",
                "The OpenAI realtime connection closed before it was ready.",
              ),
            ),
          ),
        );
      }),
    {
      signal,
      timeoutMs,
      timeoutMessage: "The OpenAI realtime connection timed out.",
    },
  );
}

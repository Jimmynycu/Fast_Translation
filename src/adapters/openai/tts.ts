import { CANONICAL_AUDIO } from "../../core/audio.js";
import {
  authorizationHeaders,
  OpenAIAdapterError,
  requireApiKey,
  resolveTimeoutMs,
  runWithDeadline,
  timeoutError,
  type FetchLike,
} from "./common.js";

const DEFAULT_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 120_000;

export interface OpenAITtsAdapterOptions {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly fetchTimeoutMs?: number;
  readonly bodyTimeoutMs?: number;
}

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

export class OpenAITtsAdapter {
  readonly outputFormat = CANONICAL_AUDIO;
  readonly sampleRateHz = 24_000;
  readonly channels = 1;
  readonly format = "pcm16" as const;

  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #voice: string;
  readonly #fetchTimeoutMs: number;
  readonly #bodyTimeoutMs: number;

  constructor(options: OpenAITtsAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = options.endpoint ?? DEFAULT_SPEECH_URL;
    this.#model = options.model ?? "gpt-4o-mini-tts";
    this.#voice = options.voice ?? "alloy";
    this.#fetchTimeoutMs = resolveTimeoutMs(
      options.fetchTimeoutMs,
      DEFAULT_FETCH_TIMEOUT_MS,
      "OpenAI TTS fetchTimeoutMs",
    );
    this.#bodyTimeoutMs = resolveTimeoutMs(
      options.bodyTimeoutMs,
      DEFAULT_BODY_TIMEOUT_MS,
      "OpenAI TTS bodyTimeoutMs",
    );
  }

  async *synthesize(request: SpeechSynthesisRequest): AsyncIterable<Uint8Array> {
    if (request.text.length === 0) {
      throw new OpenAIAdapterError(
        "invalid_input",
        "Speech synthesis text is required.",
      );
    }
    if (
      request.speed !== undefined &&
      (request.speed < 0.25 || request.speed > 4)
    ) {
      throw new OpenAIAdapterError(
        "invalid_input",
        "Speech speed must be between 0.25 and 4.",
      );
    }

    let response: Response;
    try {
      response = await runWithDeadline(
        async (signal) =>
          await this.#fetch(this.#endpoint, {
            method: "POST",
            headers: authorizationHeaders(this.#apiKey),
            body: JSON.stringify({
              model: this.#model,
              input: request.text,
              voice: request.voice ?? this.#voice,
              response_format: "pcm",
              stream_format: "audio",
              ...(request.instructions === undefined
                ? {}
                : { instructions: request.instructions }),
              ...(request.speed === undefined ? {} : { speed: request.speed }),
            }),
            signal,
          }),
        {
          timeoutMs: this.#fetchTimeoutMs,
          timeoutMessage: "OpenAI speech synthesis timed out.",
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        },
      );
    } catch (error) {
      if (
        error instanceof OpenAIAdapterError &&
        (error.code === "timeout" || error.code === "aborted")
      ) {
        throw error;
      }
      throw new OpenAIAdapterError(
        "request_failed",
        "OpenAI speech synthesis failed.",
      );
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new OpenAIAdapterError(
        "provider_error",
        "OpenAI speech synthesis was rejected.",
      );
    }

    if (response.body === null) {
      throw new OpenAIAdapterError(
        "invalid_response",
        "OpenAI returned no speech audio.",
      );
    }

    const reader = response.body.getReader();
    const bodyDeadlineAtMs = performance.now() + this.#bodyTimeoutMs;
    let completed = false;
    let cancelRequested = false;
    const cancelBody = (reason?: unknown): void => {
      if (cancelRequested) return;
      cancelRequested = true;
      void reader.cancel(reason).catch(() => undefined);
    };

    try {
      while (true) {
        const remainingTimeoutMs = Math.ceil(
          bodyDeadlineAtMs - performance.now(),
        );
        if (remainingTimeoutMs < 1) {
          throw timeoutError("The OpenAI speech audio stream timed out.");
        }
        const result = await runWithDeadline(
          async () => await reader.read(),
          {
            timeoutMs: remainingTimeoutMs,
            timeoutMessage: "The OpenAI speech audio stream timed out.",
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
        if (result.done) {
          completed = true;
          break;
        }
        if (result.value.byteLength > 0) yield Uint8Array.from(result.value);
      }
    } catch (error) {
      cancelBody(error);
      if (
        error instanceof OpenAIAdapterError &&
        (error.code === "timeout" || error.code === "aborted")
      ) {
        throw error;
      }
      throw new OpenAIAdapterError(
        "request_failed",
        "The OpenAI speech audio stream was interrupted.",
      );
    } finally {
      if (!completed) cancelBody();
      try {
        reader.releaseLock();
      } catch {
        // A cancelled pending read releases its lock when cancellation settles.
      }
    }
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  if (response.body === null || response.body.locked) return;
  try {
    await response.body.cancel();
  } catch {
    // Response cleanup is best effort.
  }
}
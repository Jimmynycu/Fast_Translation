import {
  authorizationHeaders,
  OpenAIAdapterError,
  requireApiKey,
  type FetchLike,
} from "./common.js";

const DEFAULT_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

export interface OpenAITtsAdapterOptions {
  readonly apiKey: string;
  readonly fetch?: FetchLike;
  readonly endpoint?: string;
  readonly model?: string;
  readonly voice?: string;
}

export interface SpeechSynthesisRequest {
  readonly text: string;
  readonly voice?: string;
  readonly instructions?: string;
  readonly speed?: number;
  readonly signal?: AbortSignal;
}

export class OpenAITtsAdapter {
  readonly sampleRateHz = 24_000;
  readonly channels = 1;
  readonly format = "pcm16" as const;

  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #voice: string;

  constructor(options: OpenAITtsAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#endpoint = options.endpoint ?? DEFAULT_SPEECH_URL;
    this.#model = options.model ?? "gpt-4o-mini-tts";
    this.#voice = options.voice ?? "alloy";
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
      response = await this.#fetch(this.#endpoint, {
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
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      throw new OpenAIAdapterError(
        "request_failed",
        "OpenAI speech synthesis failed.",
      );
    }

    if (!response.ok) {
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
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value.byteLength > 0) yield Uint8Array.from(result.value);
      }
    } catch {
      throw new OpenAIAdapterError(
        "request_failed",
        "The OpenAI speech audio stream was interrupted.",
      );
    } finally {
      reader.releaseLock();
    }
  }
}

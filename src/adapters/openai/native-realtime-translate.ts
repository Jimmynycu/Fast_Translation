import { CANONICAL_AUDIO, createAudioFrame } from "../../core/audio.js";
import type {
  GenerationRef,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";
import {
  appendModel,
  AsyncQueue,
  authorizationHeaders,
  closeSocket,
  defaultWebSocketFactory,
  encodePcm16,
  numberField,
  OpenAIAdapterError,
  parseJsonObject,
  requireApiKey,
  sendJson,
  stringField,
  waitForOpen,
  type WebSocketFactory,
  type WebSocketLike,
} from "./common.js";

const DEFAULT_TRANSLATION_URL =
  "wss://api.openai.com/v1/realtime/translations";

export interface NativeRealtimeTranslateAdapterOptions {
  readonly apiKey: string;
  readonly webSocketFactory?: WebSocketFactory;
  readonly endpoint?: string;
  readonly model?: string;
  readonly inputTranscriptionModel?: string | null;
  readonly noiseReduction?: "near_field" | "far_field" | null;
  readonly now?: () => number;
}

interface ActiveTranslation {
  stop(): void;
}

export class NativeRealtimeTranslateAdapter implements TranslationPort {
  readonly #apiKey: string;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #inputTranscriptionModel: string | null;
  readonly #noiseReduction: "near_field" | "far_field" | null;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveTranslation>();

  constructor(options: NativeRealtimeTranslateAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultWebSocketFactory;
    this.#endpoint = options.endpoint ?? DEFAULT_TRANSLATION_URL;
    this.#model = options.model ?? "gpt-realtime-translate";
    this.#inputTranscriptionModel =
      options.inputTranscriptionModel === undefined
        ? "gpt-realtime-whisper"
        : options.inputTranscriptionModel;
    this.#noiseReduction = options.noiseReduction ?? null;
    this.#now = options.now ?? (() => performance.now());
  }

  async *translate(
    request: TranslationRequest,
  ): AsyncIterable<TranslationEvent> {
    const ref = request.context;
    const key = generationKey(ref);
    const previous = this.#active.get(key);
    if (previous !== undefined) {
      previous.stop();
      this.#active.delete(key);
    }

    let socket: WebSocketLike;
    try {
      socket = this.#webSocketFactory(
        appendModel(this.#endpoint, this.#model),
        { headers: authorizationHeaders(this.#apiKey) },
      );
    } catch {
      yield this.#errorEvent(
        ref,
        "OPENAI_REALTIME_CONNECT",
        "The translation service connection could not be created.",
        true,
      );
      return;
    }

    const events = new AsyncQueue<TranslationEvent>();
    let lifecycle: "active" | "intentional" | "failed" | "completed" = "active";
    let providerCloseRequested = false;
    let outputSequence = 0;
    let pendingAudio = new Uint8Array(0);

    const emitAudioFrame = (pcm16le: Uint8Array, emittedAtMs: number): void => {
      events.push({
        type: "audio",
        sessionId: ref.sessionId,
        lane: ref.lane,
        generation: ref.generation,
        emittedAtMs,
        frame: createAudioFrame({
          sessionId: ref.sessionId,
          lane: ref.lane,
          generation: ref.generation,
          sequence: outputSequence,
          capturedAtMs: emittedAtMs,
          pcm16le,
        }),
      });
      outputSequence += 1;
    };

    const acceptAudioDelta = (audio: Uint8Array, emittedAtMs: number): void => {
      const combined = concatenateBytes(pendingAudio, audio);
      let offset = 0;
      while (combined.byteLength - offset >= CANONICAL_AUDIO.bytesPerFrame) {
        emitAudioFrame(
          combined.slice(offset, offset + CANONICAL_AUDIO.bytesPerFrame),
          emittedAtMs,
        );
        offset += CANONICAL_AUDIO.bytesPerFrame;
      }
      pendingAudio = combined.slice(offset);
    };

    const finishAudio = (): void => {
      if (pendingAudio.byteLength === 0) return;
      if (pendingAudio.byteLength % 2 !== 0) {
        events.push(
          this.#errorEvent(
            ref,
            "OPENAI_REALTIME_INVALID_AUDIO",
            "The translation service ended with an incomplete PCM16 sample.",
            true,
          ),
        );
        pendingAudio = pendingAudio.slice(0, -1);
        if (pendingAudio.byteLength === 0) return;
      }

      const padded = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
      padded.set(pendingAudio);
      pendingAudio = new Uint8Array(0);
      emitAudioFrame(padded, this.#now());
    };

    const complete = (): void => {
      if (lifecycle !== "active") return;
      finishAudio();
      lifecycle = "completed";
      events.push({
        type: "completed",
        sessionId: ref.sessionId,
        lane: ref.lane,
        generation: ref.generation,
        emittedAtMs: this.#now(),
      });
      events.end();
    };

    const stop = (): void => {
      if (lifecycle !== "active") return;
      lifecycle = "intentional";
      events.end();
      closeSocket(socket);
    };

    const fail = (
      code: string,
      message: string,
      retryable: boolean,
      closeTransport = true,
    ): void => {
      if (lifecycle !== "active") return;
      lifecycle = "failed";
      events.push(this.#errorEvent(ref, code, message, retryable));
      events.end();
      if (closeTransport) closeSocket(socket);
    };

    const active: ActiveTranslation = { stop };
    this.#active.set(key, active);

    const onAbort = (): void => stop();
    request.signal.addEventListener("abort", onAbort, { once: true });

    socket.on("message", (data) => {
      if (lifecycle !== "active") return;
      const providerEvent = parseJsonObject(data);
      if (providerEvent === null) return;
      const type = stringField(providerEvent, "type");

      if (type === "session.output_audio.delta") {
        const sampleRate = numberField(providerEvent, "sample_rate");
        const channels = numberField(providerEvent, "channels");
        const format = stringField(providerEvent, "format");
        if (
          (sampleRate !== undefined &&
            sampleRate !== CANONICAL_AUDIO.sampleRateHz) ||
          (channels !== undefined && channels !== CANONICAL_AUDIO.channels) ||
          (format !== undefined && format !== "pcm16")
        ) {
          events.push(
            this.#errorEvent(
              ref,
              "OPENAI_REALTIME_INVALID_AUDIO",
              "The translation service returned an unsupported audio format.",
              true,
            ),
          );
          return;
        }
        const encoded = stringField(providerEvent, "delta");
        if (encoded === undefined) {
          events.push(
            this.#errorEvent(
              ref,
              "OPENAI_REALTIME_INVALID_AUDIO",
              "The translation service returned invalid audio.",
              true,
            ),
          );
          return;
        }

        let audio: Uint8Array;
        try {
          audio = decodeAudioDelta(encoded);
        } catch {
          events.push(
            this.#errorEvent(
              ref,
              "OPENAI_REALTIME_INVALID_AUDIO",
              "The translation service returned invalid audio.",
              true,
            ),
          );
          return;
        }
        acceptAudioDelta(audio, this.#now());
        return;
      }

      if (
        type === "session.input_transcript.delta" ||
        type === "session.output_transcript.delta"
      ) {
        const delta = stringField(providerEvent, "delta");
        if (delta === undefined) return;
        events.push({
          type:
            type === "session.input_transcript.delta"
              ? "source_transcript_delta"
              : "target_transcript_delta",
          sessionId: ref.sessionId,
          lane: ref.lane,
          generation: ref.generation,
          emittedAtMs: this.#now(),
          delta,
        });
        return;
      }

      if (type === "error") {
        fail(
          "OPENAI_REALTIME_PROVIDER",
          "The translation service reported an error.",
          true,
        );
        return;
      }

      if (type === "session.closed") {
        if (!providerCloseRequested) {
          fail(
            "OPENAI_REALTIME_CONNECTION",
            "The translation service closed unexpectedly.",
            true,
          );
          return;
        }
        complete();
        closeSocket(socket);
      }
    });

    socket.on("error", () =>
      fail(
        "OPENAI_REALTIME_CONNECTION",
        "The translation service connection failed.",
        true,
      ),
    );
    socket.on("close", () => {
      if (lifecycle !== "active") return;
      if (providerCloseRequested) {
        complete();
        return;
      }
      fail(
        "OPENAI_REALTIME_CONNECTION",
        "The translation service connection closed unexpectedly.",
        true,
        false,
      );
    });

    try {
      await waitForOpen(socket, request.signal);
      sendJson(socket, {
        type: "session.update",
        session: {
          audio: {
            input: {
              transcription:
                this.#inputTranscriptionModel === null
                  ? null
                  : { model: this.#inputTranscriptionModel },
              noise_reduction:
                this.#noiseReduction === null
                  ? null
                  : { type: this.#noiseReduction },
            },
            output: { language: ref.targetLanguage },
          },
        },
      });

      void this.#pumpInput(request, socket, events)
        .then(() => {
          if (request.signal.aborted) {
            stop();
            return;
          }
          if (lifecycle !== "active") return;
          providerCloseRequested = true;
          sendJson(socket, { type: "session.close" });
        })
        .catch(() => {
          fail(
            "OPENAI_REALTIME_INPUT",
            "The translation audio stream failed.",
            false,
          );
        });

      for await (const event of events) yield event;
    } catch (error) {
      if (!request.signal.aborted) {
        fail(
          error instanceof OpenAIAdapterError
            ? "OPENAI_REALTIME_CONNECTION"
            : "OPENAI_REALTIME_UNKNOWN",
          "The translation service connection failed.",
          true,
        );
        for await (const event of events) yield event;
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      if (lifecycle === "active") stop();
      if (this.#active.get(key) === active) this.#active.delete(key);
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const key = generationKey(generation);
    const active = this.#active.get(key);
    if (active === undefined) return;
    this.#active.delete(key);
    active.stop();
  }

  async #pumpInput(
    request: TranslationRequest,
    socket: WebSocketLike,
    events: AsyncQueue<TranslationEvent>,
  ): Promise<void> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      if (
        frame.sessionId !== request.context.sessionId ||
        frame.lane !== request.context.lane ||
        frame.generation !== request.context.generation
      ) {
        events.push(
          this.#errorEvent(
            request.context,
            "OPENAI_REALTIME_GENERATION_MISMATCH",
            "An audio frame did not belong to the active translation generation.",
            false,
          ),
        );
        throw new OpenAIAdapterError(
          "invalid_input",
          "Audio generation mismatch.",
        );
      }
      if (
        frame.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame ||
        frame.format.encoding !== CANONICAL_AUDIO.encoding ||
        frame.format.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
        frame.format.channels !== CANONICAL_AUDIO.channels
      ) {
        events.push(
          this.#errorEvent(
            request.context,
            "OPENAI_REALTIME_AUDIO_FORMAT",
            "An audio frame was not canonical 24 kHz mono PCM16.",
            false,
          ),
        );
        throw new OpenAIAdapterError(
          "invalid_input",
          "Unsupported audio format.",
        );
      }
      sendJson(socket, {
        type: "session.input_audio_buffer.append",
        audio: encodePcm16(frame.pcm16le),
      });
    }
  }

  #errorEvent(
    ref: GenerationRef,
    code: string,
    message: string,
    retryable: boolean,
  ): TranslationErrorEvent {
    return {
      type: "error",
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      emittedAtMs: this.#now(),
      error: { code, message, retryable },
    };
  }
}

function generationKey(ref: GenerationRef): string {
  return (
    ref.sessionId +
    "\u0000" +
    ref.lane +
    "\u0000" +
    ref.generation.toString(10)
  );
}

function decodeAudioDelta(encoded: string): Uint8Array {
  const value = encoded.trim();
  if (
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new OpenAIAdapterError(
      "invalid_response",
      "OpenAI returned invalid audio data.",
    );
  }

  const decoded = Buffer.from(value, "base64");
  const withoutPadding = value.replace(/=+$/u, "");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  if (decoded.byteLength === 0 || canonical !== withoutPadding) {
    throw new OpenAIAdapterError(
      "invalid_response",
      "OpenAI returned invalid audio data.",
    );
  }
  return Uint8Array.from(decoded);
}

function concatenateBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return Uint8Array.from(right);
  if (right.byteLength === 0) return Uint8Array.from(left);
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

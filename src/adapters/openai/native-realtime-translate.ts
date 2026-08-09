import {
  CANONICAL_AUDIO,
  createAudioFrame,
  type AudioFrame,
} from "../../core/audio.js";
import { resolveTranslationBehavior } from "../../core/translation-behavior.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationBehavior,
  TranslationCapabilities,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationProviderId,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";
import {
  ControlledTranslationAdapter,
  type ControlledTextTranslationPort,
  type ControlledTranscriptionPort,
  type ControlledTtsPort,
} from "../translation/glossary-controlled.js";
import {
  appendModel,
  authorizationHeaders,
  BoundedAudioWindowQueue,
  closeSocket,
  defaultWebSocketFactory,
  encodePcm16,
  GenerationPlayoutSequence,
  LocalPlayoutQueue,
  OpenAIAdapterError,
  parseJsonObject,
  requireApiKey,
  resolveTimeoutMs,
  sendJson,
  stringField,
  waitForOpen,
  type WebSocketFactory,
  type WebSocketLike,
} from "./common.js";
import {
  OpenAILiveTranscribeAdapter,
} from "./live-transcribe.js";
import {
  OpenAITextTranslator,
} from "./text-translator.js";
import {
  OpenAITtsAdapter,
} from "./tts.js";

const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000;
const DEFAULT_INPUT_APPEND_MS = 200;

/** Static metadata: safe to inspect before a server-side key is available. */
export const OPENAI_NATIVE_TRANSLATION_CAPABILITIES: TranslationCapabilities =
  Object.freeze({
    providerId: "openai_native",
    supportedModes: Object.freeze([
      Object.freeze({
        mode: "fast" as const,
        behaviorVersion: 1 as const,
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "balanced" as const,
        behaviorVersion: 1 as const,
        deterministicGlossary: false,
        degradation:
          "Balanced uses adapter-local holdback; it is not a model-quality claim.",
      }),
    ]),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  });

export const OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES: TranslationCapabilities =
  Object.freeze({
    providerId: "openai_controlled",
    supportedModes: Object.freeze([
      Object.freeze({
        mode: "fast" as const,
        behaviorVersion: 1 as const,
        deterministicGlossary: true,
      }),
      Object.freeze({
        mode: "balanced" as const,
        behaviorVersion: 1 as const,
        deterministicGlossary: true,
      }),
      Object.freeze({
        mode: "accurate" as const,
        behaviorVersion: 1 as const,
        deterministicGlossary: true,
      }),
    ]),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: true,
  });

export type OpenAITranslationProvider = Extract<
  TranslationProviderId,
  "openai_native" | "openai_controlled"
>;

export interface NativeRealtimeTranslateAdapterOptions {
  readonly apiKey: string;
  readonly webSocketFactory?: WebSocketFactory;
  readonly endpoint?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly inputTranscriptionModel?: string | null;
  readonly noiseReduction?: "near_field" | "far_field" | null;
  readonly now?: () => number;
  readonly connectTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
  /** Coalesce canonical 20 ms input frames into Realtime append events. */
  readonly inputAppendMs?: number;
}

interface ActiveTranslation {
  readonly ref: GenerationRef;
  stop(): void;
  isCompleted(): boolean;
}

interface ContinuousInputWindow {
  readonly segmentIndex: number;
  readonly frames: readonly AudioFrame[];
}

class RealtimeInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * A complete native speech-to-speech Realtime path. It owns its socket,
 * source append cadence, output canonicalisation and local playout fence; it
 * deliberately does not depend on the controlled transcript/text/TTS path.
 */
export class NativeRealtimeTranslateAdapter implements TranslationPort {
  readonly capabilities = OPENAI_NATIVE_TRANSLATION_CAPABILITIES;
  readonly #apiKey: string;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #voice: string;
  readonly #inputTranscriptionModel: string | null;
  readonly #noiseReduction: "near_field" | "far_field" | null;
  readonly #now: () => number;
  readonly #connectTimeoutMs: number;
  readonly #responseTimeoutMs: number;
  readonly #inputAppendBytes: number;
  readonly #active = new Map<string, ActiveTranslation>();
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: NativeRealtimeTranslateAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#endpoint = options.endpoint ?? DEFAULT_REALTIME_URL;
    this.#model = options.model ?? "gpt-realtime";
    this.#voice = options.voice ?? "marin";
    this.#inputTranscriptionModel =
      options.inputTranscriptionModel === undefined
        ? "gpt-4o-mini-transcribe"
        : options.inputTranscriptionModel;
    this.#noiseReduction = options.noiseReduction ?? null;
    this.#now = options.now ?? (() => performance.now());
    this.#connectTimeoutMs = resolveTimeoutMs(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "OpenAI realtime connectTimeoutMs",
    );
    this.#responseTimeoutMs = resolveTimeoutMs(
      options.responseTimeoutMs,
      DEFAULT_RESPONSE_TIMEOUT_MS,
      "OpenAI realtime responseTimeoutMs",
    );
    const inputAppendMs = resolveTimeoutMs(
      options.inputAppendMs,
      DEFAULT_INPUT_APPEND_MS,
      "OpenAI realtime inputAppendMs",
    );
    if (inputAppendMs % CANONICAL_AUDIO.frameDurationMs !== 0) {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI realtime inputAppendMs must be a multiple of the canonical frame duration.",
      );
    }
    this.#inputAppendBytes =
      (inputAppendMs / CANONICAL_AUDIO.frameDurationMs) *
      CANONICAL_AUDIO.bytesPerFrame;
  }

  async prepare(context: LaneContext): Promise<void> {
    assertBehaviorSupported(
      context.behavior,
      this.capabilities,
      "OpenAI native Realtime",
    );
    assertGlossarySupported(
      context,
      this.capabilities,
      "OpenAI native Realtime",
    );
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const ref = request.context;
    assertBehaviorSupported(
      ref.behavior,
      this.capabilities,
      "OpenAI native Realtime",
    );
    assertGlossarySupported(ref, this.capabilities, "OpenAI native Realtime");
    const behavior = ref.behavior;
    const maxBufferedAudioFrames = Math.max(
      1,
      Math.floor(behavior.maxBufferedAudioMs / CANONICAL_AUDIO.frameDurationMs),
    );
    const key = generationKey(ref);
    const previous = this.#active.get(key);
    if (previous !== undefined) {
      if (!previous.isCompleted()) {
        previous.stop();
      }
    }
    let errorSequence = 0;
    const eventBase = (
      segmentId: string,
      revision: number,
      finality: "provisional" | "final",
      emittedAtMs = this.#now(),
    ) => ({
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      turnId: ref.turnId,
      segmentId,
      revision,
      finality,
      emittedAtMs,
    });
    const errorEvent = (
      code: string,
      message: string,
      retryable: boolean,
    ): TranslationErrorEvent => {
      const segmentId = "error-" + errorSequence.toString(10);
      errorSequence += 1;
      return {
        kind: "error",
        ...eventBase(segmentId, 1, "final"),
        error: { code, message, retryable },
      };
    };

    let socket: WebSocketLike;
    try {
      socket = this.#webSocketFactory(
        appendModel(this.#endpoint, this.#model),
        { headers: authorizationHeaders(this.#apiKey) },
      );
    } catch {
      yield errorEvent(
        "OPENAI_REALTIME_CONNECT",
        "The translation service connection could not be created.",
        true,
      );
      return;
    }

    const events = new LocalPlayoutQueue<TranslationEvent>(
      maxBufferedAudioFrames,
    );
    const continuousInputWindows = behavior.inputCommit === "continuous"
      ? new BoundedAudioWindowQueue<ContinuousInputWindow>(maxBufferedAudioFrames)
      : undefined;
    let lifecycle: "active" | "cancelled" | "failed" | "completed" = "active";
    let outputSuppressed = false;
    let responseTimer: ReturnType<typeof setTimeout> | undefined;
    let sessionReady = false;
    let inputEnded = false;
    let inputBufferedBytes = 0;
    let responseInFlight = false;
    let pendingOutputAudio = new Uint8Array(0);
    let inputStopRequested = false;
    let inputReturnRequested = false;
    let inputIterator: AsyncIterator<AudioFrame> | undefined;
    let wakeInputStop: (() => void) | undefined;
    let wakeContinuousResponse: (() => void) | undefined;
    const inputStopped = new Promise<void>((resolve) => {
      wakeInputStop = resolve;
    });

    const clearResponseDeadline = (): void => {
      if (responseTimer === undefined) return;
      clearTimeout(responseTimer);
      responseTimer = undefined;
    };
    const finishContinuousResponse = (): void => {
      const wake = wakeContinuousResponse;
      wakeContinuousResponse = undefined;
      wake?.();
    };
    const returnInputIterator = (iterator: AsyncIterator<AudioFrame>): void => {
      if (inputIterator === iterator) inputIterator = undefined;
      if (inputReturnRequested) return;
      inputReturnRequested = true;
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // Upstream iterator cleanup is best effort.
      }
    };
    const registerInputIterator = (iterator: AsyncIterator<AudioFrame>): void => {
      inputIterator = iterator;
      if (inputStopRequested) returnInputIterator(iterator);
    };
    const releaseInputIterator = (iterator: AsyncIterator<AudioFrame>): void => {
      if (inputIterator === iterator) inputIterator = undefined;
    };
    const stopInput = (): void => {
      if (inputStopRequested) return;
      inputStopRequested = true;
      wakeInputStop?.();
      if (inputIterator !== undefined) returnInputIterator(inputIterator);
    };
    const sendBestEffort = (event: unknown): void => {
      if (socket.readyState !== 1) return;
      try {
        sendJson(socket, event);
      } catch {
        // A local cancellation fence is authoritative even if the socket died.
      }
    };
    const queueEvent = (
      event: TranslationEvent,
      options: Readonly<{ readonly audio?: boolean; readonly holdback?: boolean }> = {},
    ): void => {
      if (lifecycle !== "active") return;
      const offer = events.offer(event, {
        audio: options.audio === true,
        holdbackMs: options.holdback === true ? behavior.holdbackMs : 0,
      });
      if (offer === "dropped_oldest") {
        events.offer(
          errorEvent(
            "OPENAI_REALTIME_PLAYOUT_QUEUE_TRIMMED",
            "The oldest queued translation audio was dropped to preserve the latency budget.",
            true,
          ),
        );
      }
    };
    const queueError = (code: string, message: string, retryable: boolean): void => {
      queueEvent(errorEvent(code, message, retryable));
    };
    const transcriptStates = new Map<
      string,
      {
        readonly kind: "source_transcript" | "target_transcript";
        readonly segmentId: string;
        text: string;
        revision: number;
        finalEmitted: boolean;
      }
    >();
    const publishTranscript = (
      kind: "source_transcript" | "target_transcript",
      providerId: string,
      text: string,
      final: boolean,
    ): void => {
      const stateKey = kind + "\u0000" + providerId;
      let state = transcriptStates.get(stateKey);
      if (state === undefined) {
        state = {
          kind,
          segmentId: kind + "-" + providerId,
          text: "",
          revision: 0,
          finalEmitted: false,
        };
        transcriptStates.set(stateKey, state);
      }
      state.text = final ? text : state.text + text;
      if (!final && behavior.transcriptPolicy === "final_only") return;
      state.revision += 1;
      if (final) state.finalEmitted = true;
      queueEvent(
        {
          kind: state.kind,
          ...eventBase(
            state.segmentId,
            state.revision,
            final ? "final" : "provisional",
          ),
          text: state.text,
        },
        { holdback: true },
      );
    };
    const finalizeTranscripts = (): void => {
      for (const state of transcriptStates.values()) {
        if (state.finalEmitted || state.text.length === 0) continue;
        state.revision += 1;
        state.finalEmitted = true;
        queueEvent(
          {
            kind: state.kind,
            ...eventBase(state.segmentId, state.revision, "final"),
            text: state.text,
          },
          { holdback: true },
        );
      }
    };
    const emitAudioFrame = (pcm16le: Uint8Array, emittedAtMs: number): void => {
      const outputSequence = this.#playoutSequences.next(ref);
      queueEvent(
        {
          kind: "audio",
          ...eventBase("audio-" + outputSequence.toString(10), 1, "final", emittedAtMs),
          playoutSequence: outputSequence,
          frame: createAudioFrame({
            sessionId: ref.sessionId,
            lane: ref.lane,
            generation: ref.generation,
            sequence: outputSequence,
            capturedAtMs: emittedAtMs,
            pcm16le,
          }),
        },
        { audio: true, holdback: true },
      );
    };
    const acceptOutputAudio = (audio: Uint8Array): void => {
      const combined = concatenateBytes(pendingOutputAudio, audio);
      let offset = 0;
      while (combined.byteLength - offset >= CANONICAL_AUDIO.bytesPerFrame) {
        emitAudioFrame(
          combined.slice(offset, offset + CANONICAL_AUDIO.bytesPerFrame),
          this.#now(),
        );
        offset += CANONICAL_AUDIO.bytesPerFrame;
      }
      pendingOutputAudio = combined.slice(offset);
    };
    const finishOutputAudio = (): void => {
      if (pendingOutputAudio.byteLength === 0) return;
      if (pendingOutputAudio.byteLength % 2 !== 0) {
        queueError(
          "OPENAI_REALTIME_INVALID_AUDIO",
          "The translation service ended with an incomplete PCM16 sample.",
          true,
        );
        pendingOutputAudio = pendingOutputAudio.slice(0, -1);
      }
      if (pendingOutputAudio.byteLength === 0) return;
      const padded = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
      padded.set(pendingOutputAudio);
      pendingOutputAudio = new Uint8Array(0);
      emitAudioFrame(padded, this.#now());
    };
    const completedEvent = (): TranslationEvent => ({
      kind: "completed",
      ...eventBase("completed", 1, "final"),
    });
    const complete = (): void => {
      if (lifecycle !== "active") return;
      clearResponseDeadline();
      stopInput();
      finishContinuousResponse();
      finalizeTranscripts();
      finishOutputAudio();
      lifecycle = "completed";
      events.closeAfterDrain(completedEvent());
      closeSocket(socket);
    };
    const stop = (): void => {
      if (lifecycle !== "active") return;
      outputSuppressed = true;
      lifecycle = "cancelled";
      clearResponseDeadline();
      stopInput();
      continuousInputWindows?.end({ discardBuffered: true });
      finishContinuousResponse();
      events.discard();
      sendBestEffort({ type: "response.cancel" });
      sendBestEffort({ type: "input_audio_buffer.clear" });
      closeSocket(socket);
    };
    const fail = (code: string, message: string, retryable: boolean): void => {
      if (lifecycle !== "active") return;
      clearResponseDeadline();
      stopInput();
      continuousInputWindows?.end({ discardBuffered: true });
      finishContinuousResponse();
      lifecycle = "failed";
      events.discardWith(errorEvent(code, message, retryable));
      closeSocket(socket);
    };
    const startResponseIfReady = (): void => {
      if (behavior.inputCommit === "continuous") return;
      if (
        lifecycle !== "active" ||
        !sessionReady ||
        responseInFlight ||
        inputBufferedBytes === 0
      ) {
        return;
      }
      if (!inputEnded) return;

      try {
        sendJson(socket, { type: "input_audio_buffer.commit" });
        sendJson(socket, { type: "response.create" });
        inputBufferedBytes = 0;
        responseInFlight = true;
        responseTimer = setTimeout(
          () =>
            fail(
              "OPENAI_REALTIME_RESPONSE_TIMEOUT",
              "The translation service timed out while producing speech.",
              true,
            ),
          this.#responseTimeoutMs,
        );
      } catch {
        fail(
          "OPENAI_REALTIME_INPUT",
          "The translation audio stream could not be committed.",
          true,
        );
      }
    };
    const startContinuousResponse = (
      window: ContinuousInputWindow,
    ): Promise<void> | undefined => {
      if (
        lifecycle !== "active" ||
        !sessionReady ||
        responseInFlight
      ) {
        return undefined;
      }
      const completed = new Promise<void>((resolve) => {
        wakeContinuousResponse = resolve;
      });
      try {
        appendInputWindow(socket, window.frames, this.#inputAppendBytes);
        sendJson(socket, { type: "input_audio_buffer.commit" });
        sendJson(socket, { type: "response.create" });
        responseInFlight = true;
        responseTimer = setTimeout(
          () =>
            fail(
              "OPENAI_REALTIME_RESPONSE_TIMEOUT",
              "The translation service timed out while producing speech.",
              true,
            ),
          this.#responseTimeoutMs,
        );
      } catch {
        fail(
          "OPENAI_REALTIME_INPUT",
          "The translation audio stream could not be committed.",
          true,
        );
      }
      return completed;
    };

    const active: ActiveTranslation = {
      ref,
      stop,
      isCompleted: () => lifecycle === "completed",
    };
    this.#active.set(key, active);
    const onAbort = (): void => {
      this.#playoutSequences.clear(ref);
      stop();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });

    socket.on("message", (data) => {
      if (lifecycle !== "active") return;
      const providerEvent = parseJsonObject(data);
      if (providerEvent === null) return;
      const type = stringField(providerEvent, "type");

      if (type === "response.output_audio.delta") {
        const encoded = stringField(providerEvent, "delta");
        if (encoded === undefined) {
          queueError(
            "OPENAI_REALTIME_INVALID_AUDIO",
            "The translation service returned invalid audio.",
            true,
          );
          return;
        }
        try {
          acceptOutputAudio(decodeAudioDelta(encoded));
        } catch {
          queueError(
            "OPENAI_REALTIME_INVALID_AUDIO",
            "The translation service returned invalid audio.",
            true,
          );
        }
        return;
      }

      if (
        type === "conversation.item.input_audio_transcription.delta" ||
        type === "conversation.item.input_audio_transcription.completed" ||
        type === "response.output_audio_transcript.delta" ||
        type === "response.output_audio_transcript.done"
      ) {
        const source = type.startsWith("conversation.item.");
        const final = type.endsWith(".completed") || type.endsWith(".done");
        const text = stringField(
          providerEvent,
          final ? "transcript" : "delta",
        );
        if (text !== undefined) {
          const providerId =
            stringField(providerEvent, "item_id") ??
            stringField(providerEvent, "response_id") ??
            (source ? "source" : "target");
          publishTranscript(
            source ? "source_transcript" : "target_transcript",
            providerId,
            text,
            final,
          );
        }
        return;
      }

      if (type === "response.done") {
        const response = providerEvent.response;
        const status =
          response !== null && typeof response === "object"
            ? stringField(response as Record<string, unknown>, "status")
            : undefined;
        if (status === undefined || status === "completed") {
          clearResponseDeadline();
          responseInFlight = false;
          if (continuousInputWindows !== undefined) {
            if (inputEnded && continuousInputWindows.size === 0) complete();
            else finishContinuousResponse();
            return;
          }
          startResponseIfReady();
          if (inputEnded && inputBufferedBytes === 0 && !responseInFlight) {
            complete();
          }
        } else {
          fail(
            "OPENAI_REALTIME_RESPONSE",
            "The translation service did not complete its response.",
            true,
          );
        }
        return;
      }

      if (type === "error") {
        fail(
          "OPENAI_REALTIME_PROVIDER",
          "The translation service reported an error.",
          true,
        );
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
      fail(
        "OPENAI_REALTIME_CONNECTION",
        "The translation service connection closed unexpectedly.",
        true,
      );
    });

    try {
      await waitForOpen(socket, request.signal, this.#connectTimeoutMs);
      sendJson(socket, {
        type: "session.update",
        session: {
          type: "realtime",
          instructions: realtimeInstructions(
            ref.sourceLanguage,
            ref.targetLanguage,
          ),
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription:
                this.#inputTranscriptionModel === null
                  ? null
                  : { model: this.#inputTranscriptionModel },
              noise_reduction:
                this.#noiseReduction === null
                  ? null
                  : { type: this.#noiseReduction },
              turn_detection: null,
            },
            output: {
              format: { type: "audio/pcm", rate: 24_000 },
              voice: this.#voice,
            },
          },
        },
      });

      sessionReady = true;

      if (continuousInputWindows !== undefined) {
        void (async (): Promise<void> => {
          try {
            for await (const window of continuousInputWindows) {
              if (lifecycle !== "active" || request.signal.aborted) return;
              const responseCompleted = startContinuousResponse(window);
              if (responseCompleted === undefined) return;
              await responseCompleted;
              if (lifecycle !== "active" || request.signal.aborted) return;
            }
            complete();
          } catch {
            fail(
              "OPENAI_REALTIME_INPUT",
              "The translation audio stream could not be committed.",
              true,
            );
          }
        })();
        void this.#pumpContinuousInput(
          request,
          continuousInputWindows,
          maxBufferedAudioFrames,
          inputStopped,
          () => inputStopRequested,
          registerInputIterator,
          releaseInputIterator,
          returnInputIterator,
          () =>
            queueError(
              "OPENAI_REALTIME_INPUT_QUEUE_TRIMMED",
              "Continuous source audio exceeded the local processing backlog and an older source window was dropped.",
              true,
            ),
          () => {
            inputEnded = true;
          },
        )
          .then(() => {
            if (request.signal.aborted) {
              stop();
            }
          })
          .catch((error: unknown) => {
            if (error instanceof RealtimeInputError) {
              fail(error.code, error.message, false);
              return;
            }
            fail(
              "OPENAI_REALTIME_INPUT",
              "The translation audio stream failed.",
              false,
            );
          });
      } else {
        void this.#pumpInput(
          request,
          socket,
          inputStopped,
          () => inputStopRequested,
          registerInputIterator,
          releaseInputIterator,
          returnInputIterator,
          (appendedBytes) => {
            inputBufferedBytes += appendedBytes;
            startResponseIfReady();
          },
          () => {
            inputEnded = true;
            startResponseIfReady();
            if (inputBufferedBytes === 0 && !responseInFlight) complete();
          },
        )
          .then(() => {
            if (request.signal.aborted) {
              stop();
            }
          })
          .catch((error: unknown) => {
            if (error instanceof RealtimeInputError) {
              fail(error.code, error.message, false);
              return;
            }
            fail(
              "OPENAI_REALTIME_INPUT",
              "The translation audio stream failed.",
              false,
            );
          });
      }

      for await (const event of events) {
        if (outputSuppressed || request.signal.aborted) break;
        yield event;
      }
    } catch (error) {
      if (!request.signal.aborted) {
        const timedOut =
          error instanceof OpenAIAdapterError && error.code === "timeout";
        fail(
          timedOut
            ? "OPENAI_REALTIME_CONNECT_TIMEOUT"
            : "OPENAI_REALTIME_CONNECTION",
          timedOut
            ? "The translation service connection timed out."
            : "The translation service connection failed.",
          true,
        );
        for await (const event of events) {
          if (outputSuppressed || request.signal.aborted) break;
          yield event;
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      const ownsGeneration = this.#active.get(key) === active;
      if (lifecycle === "active" && ownsGeneration) {
        this.#playoutSequences.clear(ref);
        stop();
      }
      if (ownsGeneration) this.#active.delete(key);
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const key = generationKey(generation);
    const active = this.#active.get(key);
    this.#playoutSequences.clear(generation);
    if (active !== undefined) {
      this.#active.delete(key);
      active.stop();
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    for (const [key, active] of this.#active) {
      if (active.ref.sessionId !== sessionId) continue;
      this.#active.delete(key);
      active.stop();
    }
    this.#playoutSequences.clearSession(sessionId);
  }

  async #pumpContinuousInput(
    request: TranslationRequest,
    windows: BoundedAudioWindowQueue<ContinuousInputWindow>,
    maxWindowFrames: number,
    stopPromise: Promise<void>,
    isStopped: () => boolean,
    registerIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    releaseIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    returnIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    onQueueTrimmed: () => void,
    onInputEnded: () => void,
  ): Promise<void> {
    if (request.signal.aborted || isStopped()) return;
    const iterator = request.frames[Symbol.asyncIterator]();
    registerIterator(iterator);
    let naturallyDone = false;
    let segmentIndex = 0;
    let pendingWindow: AudioFrame[] = [];
    const offerWindow = (): boolean => {
      if (pendingWindow.length === 0) return true;
      const offer = windows.offer(
        {
          segmentIndex,
          frames: Object.freeze(pendingWindow),
        },
        pendingWindow.length,
      );
      if (offer === "dropped_oldest") onQueueTrimmed();
      if (offer === "closed") return false;
      segmentIndex += 1;
      pendingWindow = [];
      return true;
    };
    try {
      while (!request.signal.aborted && !isStopped()) {
        const next = await Promise.race<
          | Readonly<{ readonly type: "frame"; readonly result: IteratorResult<AudioFrame> }>
          | Readonly<{ readonly type: "stopped" }>
        >([
          Promise.resolve(iterator.next()).then((result) => ({
            type: "frame" as const,
            result,
          })),
          stopPromise.then(() => ({ type: "stopped" as const })),
        ]);
        if (next.type === "stopped") return;
        if (next.result.done) {
          naturallyDone = true;
          if (!offerWindow()) return;
          windows.end();
          onInputEnded();
          return;
        }
        if (request.signal.aborted || isStopped()) return;
        const frame = next.result.value;
        validateInputFrame(frame, request.context);
        pendingWindow.push(frame);
        if (pendingWindow.length >= maxWindowFrames && !offerWindow()) return;
      }
    } finally {
      if (naturallyDone) releaseIterator(iterator);
      else returnIterator(iterator);
    }
  }

  async #pumpInput(
    request: TranslationRequest,
    socket: WebSocketLike,
    stopPromise: Promise<void>,
    isStopped: () => boolean,
    registerIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    releaseIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    returnIterator: (iterator: AsyncIterator<AudioFrame>) => void,
    onAppended: (byteLength: number) => void,
    onInputEnded: () => void,
  ): Promise<void> {
    if (request.signal.aborted || isStopped()) return;
    const pendingFrames: Uint8Array[] = [];
    let pendingBytes = 0;
    const flushPending = (): void => {
      if (pendingBytes === 0) return;
      const audio = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const pending of pendingFrames) {
        audio.set(pending, offset);
        offset += pending.byteLength;
      }
      pendingFrames.splice(0);
      pendingBytes = 0;
      sendJson(socket, {
        type: "input_audio_buffer.append",
        audio: encodePcm16(audio),
      });
      onAppended(audio.byteLength);
    };
    const iterator = request.frames[Symbol.asyncIterator]();
    registerIterator(iterator);
    let naturallyDone = false;
    try {
      while (!request.signal.aborted && !isStopped()) {
        const next = await Promise.race<
          | Readonly<{ readonly type: "frame"; readonly result: IteratorResult<AudioFrame> }>
          | Readonly<{ readonly type: "stopped" }>
        >([
          Promise.resolve(iterator.next()).then((result) => ({
            type: "frame" as const,
            result,
          })),
          stopPromise.then(() => ({ type: "stopped" as const })),
        ]);
        if (next.type === "stopped") return;
        if (next.result.done) {
          naturallyDone = true;
          flushPending();
          onInputEnded();
          return;
        }
        if (request.signal.aborted || isStopped()) return;
        const frame = next.result.value;
        validateInputFrame(frame, request.context);
        pendingFrames.push(frame.pcm16le);
        pendingBytes += frame.pcm16le.byteLength;
        if (pendingBytes >= this.#inputAppendBytes) flushPending();
      }
      return;
    } finally {
      if (naturallyDone) releaseIterator(iterator);
      else returnIterator(iterator);
    }
  }

}

export interface OpenAIControlledTranslationAdapterOptions {
  /** Required even when test ports are injected; live paths never fake a key. */
  readonly apiKey: string;
  readonly transcriber?: ControlledTranscriptionPort;
  readonly translator?: ControlledTextTranslationPort;
  readonly tts?: ControlledTtsPort;
  readonly transcribeModel?: string;
  readonly textModel?: string;
  readonly ttsModel?: string;
  readonly ttsVoice?: string;
  readonly minimumConfidence?: number;
  readonly now?: () => number;
}

/**
 * OpenAI's controlled path delegates terminology binding/authorization to the
 * deterministic controlled stage, while retaining provider-local input pacing
 * and output playout policy here.  This keeps the provider seam honest: the
 * Realtime native path cannot claim deterministic glossary guarantees.
 */
export class OpenAIControlledTranslationAdapter implements TranslationPort {
  readonly capabilities = OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES;
  readonly #delegate: ControlledTranslationAdapter;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveTranslation>();
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: OpenAIControlledTranslationAdapterOptions) {
    const apiKey = requireApiKey(options.apiKey);
    const transcriber = options.transcriber ?? new OpenAILiveTranscribeAdapter({
      apiKey,
      inputAppendMs: DEFAULT_INPUT_APPEND_MS,
      ...(options.transcribeModel === undefined
        ? {}
        : { model: options.transcribeModel }),
    });
    const translator = options.translator ?? new OpenAITextTranslator({
      apiKey,
      model: options.textModel ?? "gpt-4.1-mini",
    });
    const tts = options.tts ?? new OpenAITtsAdapter({
      apiKey,
      ...(options.ttsModel === undefined ? {} : { model: options.ttsModel }),
      ...(options.ttsVoice === undefined ? {} : { voice: options.ttsVoice }),
    });
    this.#delegate = new ControlledTranslationAdapter({
      transcriber,
      translator,
      tts,
      ...(options.minimumConfidence === undefined
        ? {}
        : { minimumConfidence: options.minimumConfidence }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#now = options.now ?? (() => performance.now());
  }

  async prepare(context: LaneContext): Promise<void> {
    assertBehaviorSupported(
      context.behavior,
      this.capabilities,
      "OpenAI controlled translation",
    );
    assertGlossarySupported(
      context,
      this.capabilities,
      "OpenAI controlled translation",
    );
    if (context.behavior.mode === "accurate") {
      await this.#delegate.prepare(context);
    }
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const ref = request.context;
    assertBehaviorSupported(
      ref.behavior,
      this.capabilities,
      "OpenAI controlled translation",
    );
    assertGlossarySupported(ref, this.capabilities, "OpenAI controlled translation");
    const behavior = ref.behavior;
    const key = generationKey(ref);
    const previous = this.#active.get(key);
    if (previous !== undefined) {
      if (!previous.isCompleted()) {
        previous.stop();
      }
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([request.signal, controller.signal]);
    const maxBufferedAudioFrames = Math.max(
      1,
      Math.floor(
        behavior.maxBufferedAudioMs / CANONICAL_AUDIO.frameDurationMs,
      ),
    );
    const inputWindows = behavior.inputCommit === "continuous"
      ? new BoundedAudioWindowQueue<ContinuousInputWindow>(
        maxBufferedAudioFrames,
      )
      : undefined;
    const events = new LocalPlayoutQueue<TranslationEvent>(
      maxBufferedAudioFrames,
    );
    let stopped = false;
    let settled = false;
    let completed = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      controller.abort();
      inputWindows?.end({ discardBuffered: true });
      events.discard();
      void this.#delegate.cancel(ref).catch(() => undefined);
    };
    const active: ActiveTranslation = {
      ref,
      stop,
      isCompleted: () => completed,
    };
    this.#active.set(key, active);
    const onAbort = (): void => {
      this.#playoutSequences.clear(ref);
      stop();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();

    let errorSequence = 0;
    const controlledError = (
      code: string,
      message: string,
      retryable: boolean,
    ): TranslationErrorEvent => {
      const event = this.#errorEvent(ref, code, message, retryable, errorSequence);
      errorSequence += 1;
      return event;
    };
    const offerEvent = (event: TranslationEvent): void => {
      if (stopped || signal.aborted) return;
      if (
        behavior.transcriptPolicy === "final_only" &&
        (event.kind === "source_transcript" || event.kind === "target_transcript") &&
        event.finality === "provisional"
      ) {
        return;
      }
      const holdback =
        event.kind === "audio" ||
        event.kind === "source_transcript" ||
        event.kind === "target_transcript";
      const offer = events.offer(event, {
        audio: event.kind === "audio",
        holdbackMs: holdback ? behavior.holdbackMs : 0,
      });
      if (offer === "dropped_oldest") {
        events.offer(
          controlledError(
            "OPENAI_CONTROLLED_PLAYOUT_QUEUE_TRIMMED",
            "The oldest queued translation audio was dropped to preserve the latency budget.",
            true,
          ),
        );
      }
    };
    const completePipeline = (): void => {
      if (stopped || signal.aborted || settled) return;
      completed = true;
      settled = true;
      events.closeAfterDrain(this.#completedEvent(ref));
    };
    const failPipeline = (code: string, message: string): void => {
      if (stopped || signal.aborted || settled) return;
      settled = true;
      inputWindows?.end({ discardBuffered: true });
      events.discardWith(controlledError(code, message, true));
    };
    const translateSegment = async (
      frames: AsyncIterable<AudioFrame>,
      segmentIndex: number | undefined,
    ): Promise<void> => {
      for await (const event of this.#delegate.translate({
        frames,
        context: controlledStageContext(ref, segmentIndex),
        signal,
      })) {
        if (stopped || signal.aborted) return;
        if (event.kind === "completed") continue;
        const playoutSequence = event.kind === "audio"
          ? this.#playoutSequences.next(ref)
          : 0;
        offerEvent(
          remapControlledEvent(
            event,
            ref,
            segmentIndex,
            playoutSequence,
          ),
        );
      }
    };
    const processContinuousWindows = async (): Promise<void> => {
      if (inputWindows === undefined) return;
      try {
        for await (const window of inputWindows) {
          if (stopped || signal.aborted || settled) return;
          await translateSegment(framesFromArray(window.frames), window.segmentIndex);
        }
        completePipeline();
      } catch {
        failPipeline(
          "OPENAI_CONTROLLED_PIPELINE",
          "The controlled translation pipeline failed.",
        );
      }
    };
    const pumpContinuousInput = async (): Promise<void> => {
      if (inputWindows === undefined) return;
      let segmentIndex = 0;
      let window: AudioFrame[] = [];
      const iterator = pacedFrames(request.frames, signal)[Symbol.asyncIterator]();
      let naturallyDone = false;
      let wakeAbort: (() => void) | undefined;
      const inputAborted = new Promise<void>((resolve) => {
        wakeAbort = resolve;
      });
      const onSignalAbort = (): void => wakeAbort?.();
      signal.addEventListener("abort", onSignalAbort, { once: true });
      if (signal.aborted) onSignalAbort();
      const offerWindow = (): boolean => {
        if (window.length === 0) return true;
        const offer = inputWindows.offer(
          { segmentIndex, frames: Object.freeze(window) },
          window.length,
        );
        if (offer === "dropped_oldest") {
          offerEvent(
            controlledError(
              "OPENAI_CONTROLLED_INPUT_QUEUE_TRIMMED",
              "Continuous source audio exceeded the local processing backlog and an older source window was dropped.",
              true,
            ),
          );
        }
        if (offer === "closed") return false;
        segmentIndex += 1;
        window = [];
        return true;
      };
      try {
        while (!stopped && !signal.aborted) {
          const next = await Promise.race<
            | Readonly<{ readonly type: "frame"; readonly result: IteratorResult<AudioFrame> }>
            | Readonly<{ readonly type: "stopped" }>
          >([
            Promise.resolve(iterator.next()).then((result) => ({
              type: "frame" as const,
              result,
            })),
            inputAborted.then(() => ({ type: "stopped" as const })),
          ]);
          if (next.type === "stopped") return;
          if (next.result.done) {
            naturallyDone = true;
            if (!offerWindow()) return;
            inputWindows.end();
            return;
          }
          if (stopped || signal.aborted) return;
          const frame = next.result.value;
          window.push(frame);
          if (window.length < maxBufferedAudioFrames) continue;
          if (!offerWindow()) return;
        }
      } catch {
        failPipeline(
          "OPENAI_CONTROLLED_INPUT",
          "The controlled translation source stream failed.",
        );
      } finally {
        signal.removeEventListener("abort", onSignalAbort);
        if (naturallyDone) return;
        try {
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        } catch {
          // Upstream iterator cleanup is best effort after cancellation.
        }
      }
    };
    if (behavior.inputCommit === "continuous") {
      void processContinuousWindows();
      void pumpContinuousInput();
    } else {
      void (async (): Promise<void> => {
        try {
          await translateSegment(pacedFrames(request.frames, signal), undefined);
          completePipeline();
        } catch {
          failPipeline(
            "OPENAI_CONTROLLED_PIPELINE",
            "The controlled translation pipeline failed.",
          );
        }
      })();
    }

    try {
      for await (const event of events) {
        if (stopped || request.signal.aborted) break;
        yield event;
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      const ownsGeneration = this.#active.get(key) === active;
      if (!settled) {
        if (ownsGeneration) this.#playoutSequences.clear(ref);
        stop();
      }
      if (ownsGeneration) this.#active.delete(key);
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const key = generationKey(generation);
    const active = this.#active.get(key);
    this.#playoutSequences.clear(generation);
    if (active !== undefined) {
      this.#active.delete(key);
      active.stop();
    }
    await this.#delegate.cancel(generation);
  }

  async closeSession(sessionId: string): Promise<void> {
    for (const [key, active] of this.#active) {
      if (active.ref.sessionId !== sessionId) continue;
      this.#active.delete(key);
      active.stop();
    }
    this.#playoutSequences.clearSession(sessionId);
    await this.#delegate.closeSession(sessionId);
  }

  #completedEvent(ref: LaneContext): TranslationEvent {
    return {
      kind: "completed",
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      turnId: ref.turnId,
      segmentId: "completed",
      revision: 1,
      finality: "final",
      emittedAtMs: this.#now(),
    };
  }

  #errorEvent(
    ref: LaneContext,
    code: string,
    message: string,
    retryable: boolean,
    sequence: number,
  ): TranslationErrorEvent {
    return {
      kind: "error",
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      turnId: ref.turnId,
      segmentId: "error-" + sequence.toString(10),
      revision: 1,
      finality: "final",
      emittedAtMs: this.#now(),
      error: { code, message, retryable },
    };
  }
}

export interface OpenAITranslationAdapterFactoryOptions {
  readonly provider: OpenAITranslationProvider;
  readonly apiKey: string;
  readonly native?: Omit<NativeRealtimeTranslateAdapterOptions, "apiKey">;
  readonly controlled?: Omit<OpenAIControlledTranslationAdapterOptions, "apiKey">;
}

/**
 * Construct exactly one provider path after preflight has selected it. Missing
 * credentials are deliberately an error here; the caller's preflight/evidence
 * layer is responsible for reporting that live provider as NOT_RUN.
 */
export function createOpenAITranslationAdapter(
  options: OpenAITranslationAdapterFactoryOptions,
): TranslationPort {
  const apiKey = requireApiKey(options.apiKey);
  if (options.provider === "openai_native") {
    return new NativeRealtimeTranslateAdapter({
      ...options.native,
      apiKey,
    });
  }
  return new OpenAIControlledTranslationAdapter({
    ...options.controlled,
    apiKey,
  });
}

function validateInputFrame(frame: AudioFrame, context: GenerationRef): void {
  if (
    frame.sessionId !== context.sessionId ||
    frame.lane !== context.lane ||
    frame.generation !== context.generation
  ) {
    throw new RealtimeInputError(
      "OPENAI_REALTIME_GENERATION_MISMATCH",
      "An audio frame did not belong to the active translation generation.",
    );
  }
  if (
    frame.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame ||
    frame.format.encoding !== CANONICAL_AUDIO.encoding ||
    frame.format.sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
    frame.format.channels !== CANONICAL_AUDIO.channels
  ) {
    throw new RealtimeInputError(
      "OPENAI_REALTIME_AUDIO_FORMAT",
      "An audio frame was not canonical 24 kHz mono PCM16.",
    );
  }
}

function generationKey(ref: GenerationRef): string {
  return ref.sessionId + "\u0000" + ref.lane + "\u0000" + ref.generation.toString(10);
}

function controlledStageContext(
  ref: LaneContext,
  segmentIndex: number | undefined,
): LaneContext {
  return {
    ...ref,
    behavior: resolveTranslationBehavior("accurate"),
    turnId: controlledStageTurnId(ref, segmentIndex),
  };
}

function controlledStageTurnId(
  ref: LaneContext,
  segmentIndex: number | undefined,
): string {
  if (segmentIndex === undefined) return ref.turnId;
  return ref.turnId + "\u0000openai-window-" + segmentIndex.toString(10);
}

/**
 * The controlled glossary stage receives a private per-window turn id so its
 * own finality bookkeeping cannot merge windows.  The public port must remain
 * pinned to the original lane turn, however; downstream relay fencing keys on
 * that id.  Segment identity carries the private window discriminator.
 */
function remapControlledEvent(
  event: TranslationEvent,
  ref: LaneContext,
  segmentIndex: number | undefined,
  playoutSequence: number,
): TranslationEvent {
  const stageTurnId = controlledStageTurnId(ref, segmentIndex);
  const eventSegmentId = stageTurnId === ref.turnId
    ? event.segmentId
    : event.segmentId.replaceAll(stageTurnId, ref.turnId);
  const segmentId = segmentIndex === undefined
    ? eventSegmentId
    : "segment-" + segmentIndex.toString(10) + ":" + eventSegmentId;
  if (event.kind !== "audio") {
    return {
      ...event,
      turnId: ref.turnId,
      segmentId,
    };
  }
  return {
    ...event,
    turnId: ref.turnId,
    segmentId,
    playoutSequence,
    frame: createAudioFrame({
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      sequence: playoutSequence,
      capturedAtMs: event.frame.capturedAtMs,
      pcm16le: event.frame.pcm16le,
    }),
  };
}

function assertBehaviorSupported(
  behavior: TranslationBehavior,
  capabilities: TranslationCapabilities,
  label: string,
): void {
  const mode = capabilities.supportedModes.find(
    (candidate) =>
      candidate.mode === behavior.mode &&
      candidate.behaviorVersion === behavior.version,
  );
  if (mode === undefined) {
    const accurateUnavailable =
      capabilities.providerId === "openai_native" && behavior.mode === "accurate";
    throw new OpenAIAdapterError(
      "configuration_error",
      accurateUnavailable
        ? "OpenAI native Realtime accurate mode is experimental and unavailable until benchmark parity is established."
        : label + " does not support " + behavior.mode + " behavior version " +
          behavior.version.toString(10) + ".",
    );
  }
  if (
    behavior.requirements.revisions &&
    !capabilities.supportsProvisionalRevisions
  ) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " cannot provide required provisional revisions.",
    );
  }
  if (behavior.requirements.cancellation && !capabilities.supportsCancellation) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " cannot provide required cancellation.",
    );
  }
  if (
    behavior.requirements.deterministicGlossary &&
    (!capabilities.supportsDeterministicGlossary || !mode.deterministicGlossary)
  ) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " cannot provide deterministic glossary authorization.",
    );
  }
  if (!capabilities.supportsFinality) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " cannot provide finality markers.",
    );
  }
}

/**
 * A compiled glossary is a product guarantee, not a best-effort prompting
 * hint.  Reject it at the provider edge unless the selected capability can
 * authorize deterministic terminology for that behavior.
 */
function assertGlossarySupported(
  context: LaneContext,
  capabilities: TranslationCapabilities,
  label: string,
): void {
  if (context.glossary === undefined) return;
  const mode = capabilities.supportedModes.find(
    (candidate) =>
      candidate.mode === context.behavior.mode &&
      candidate.behaviorVersion === context.behavior.version,
  );
  if (
    !capabilities.supportsDeterministicGlossary ||
    mode?.deterministicGlossary !== true
  ) {
    throw new OpenAIAdapterError(
      "configuration_error",
      label + " cannot authorize a deterministic glossary for this mode.",
    );
  }
}

function realtimeInstructions(sourceLanguage: string, targetLanguage: string): string {
  return [
    "You are a real-time speech-to-speech interpreter.",
    "Translate spoken " + sourceLanguage + " into " + targetLanguage + ".",
    "Output only the translation, preserving names, numbers, product identifiers, and technical terms exactly.",
    "Do not answer questions, add commentary, or repeat the source language.",
  ].join(" ");
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

function appendInputWindow(
  socket: WebSocketLike,
  frames: readonly AudioFrame[],
  inputAppendBytes: number,
): void {
  const pendingFrames: Uint8Array[] = [];
  let pendingBytes = 0;
  const flushPending = (): void => {
    if (pendingBytes === 0) return;
    const audio = new Uint8Array(pendingBytes);
    let offset = 0;
    for (const pending of pendingFrames) {
      audio.set(pending, offset);
      offset += pending.byteLength;
    }
    pendingFrames.splice(0);
    pendingBytes = 0;
    sendJson(socket, {
      type: "input_audio_buffer.append",
      audio: encodePcm16(audio),
    });
  };
  for (const frame of frames) {
    pendingFrames.push(frame.pcm16le);
    pendingBytes += frame.pcm16le.byteLength;
    if (pendingBytes >= inputAppendBytes) flushPending();
  }
  flushPending();
}

async function* framesFromArray(
  frames: readonly AudioFrame[],
): AsyncIterable<AudioFrame> {
  for (const frame of frames) yield frame;
}

/**
 * Preserve source cadence when an upstream transport releases a burst of
 * already-captured frames.  Real-time sources normally need no delay; this
 * only prevents a local backlog from becoming an artificial provider burst.
 */
async function* pacedFrames(
  frames: AsyncIterable<AudioFrame>,
  signal: AbortSignal,
): AsyncIterable<AudioFrame> {
  if (signal.aborted) return;
  const iterator = frames[Symbol.asyncIterator]();
  let firstCapturedAtMs: number | undefined;
  let firstSentAtMs: number | undefined;
  let naturallyDone = false;
  let returned = false;
  let wakeAbort: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    wakeAbort = resolve;
  });
  const returnSource = (): void => {
    if (returned) return;
    returned = true;
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // Source cleanup is best effort after cancellation.
    }
  };
  const onAbort = (): void => {
    returnSource();
    wakeAbort?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (!signal.aborted) {
      const next = await Promise.race<
        | Readonly<{ readonly type: "frame"; readonly result: IteratorResult<AudioFrame> }>
        | Readonly<{ readonly type: "stopped" }>
      >([
        Promise.resolve(iterator.next()).then((result) => ({
          type: "frame" as const,
          result,
        })),
        aborted.then(() => ({ type: "stopped" as const })),
      ]);
      if (next.type === "stopped") return;
      if (next.result.done) {
        naturallyDone = true;
        return;
      }
      const frame = next.result.value;
      if (firstCapturedAtMs === undefined || firstSentAtMs === undefined) {
        firstCapturedAtMs = frame.capturedAtMs;
        firstSentAtMs = performance.now();
      } else {
        const dueAtMs = firstSentAtMs + Math.max(
          0,
          frame.capturedAtMs - firstCapturedAtMs,
        );
        const remainingMs = Math.ceil(dueAtMs - performance.now());
        if (remainingMs > 0) await waitForPacing(remainingMs, signal);
      }
      if (signal.aborted) return;
      yield frame;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!naturallyDone) returnSource();
  }
}

function waitForPacing(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds < 1 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

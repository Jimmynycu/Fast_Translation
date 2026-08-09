import {
  CANONICAL_AUDIO,
  createAudioFrame,
  type AudioFrame,
} from "../../core/audio.js";
import { GenerationPlayoutSequence } from "../../core/playout-sequence.js";
import { resolveTranslationBehavior } from "../../core/translation-behavior.js";
import { assertTranslationBehaviorCapability } from "../../core/translation-capabilities.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationCapabilities,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationFallbackPolicy,
  TranslationPreparation,
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
import { createOpaqueEvidenceRef } from "../translation/evidence-ref.js";
import {
  appendModel,
  authorizationHeaders,
  BoundedAudioWindowQueue,
  closeSocket,
  defaultWebSocketFactory,
  encodePcm16,
  isRecord,
  LocalPlayoutQueue,
  OpenAIAdapterError,
  requireApiKey,
  resolveTimeoutMs,
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

/** Dedicated GA Realtime Translation WebSocket route. */
const DEFAULT_REALTIME_URL =
  "wss://api.openai.com/v1/realtime/translations";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;
const DEFAULT_INPUT_APPEND_MS = 200;
const MAX_NATIVE_WIRE_PAYLOAD_BYTES = 512 * 1024;
const MAX_NATIVE_OUTBOUND_BUFFERED_BYTES = 512 * 1024;
const MAX_NATIVE_QUEUED_NON_AUDIO_EVENTS = 256;
const MAX_NATIVE_QUEUED_NON_AUDIO_BYTES = 256 * 1024;
const MAX_NATIVE_PROVIDER_EVENT_TEXT_BYTES = 64 * 1024;
const MAX_NATIVE_PROVIDER_EVENT_ID_BYTES = 256;
const MAX_NATIVE_PARSE_VALUE_DEPTH = 8;
const MAX_NATIVE_JSON_NESTING = 64;

const OPENAI_LOCAL_ROUTE_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "local_route_validated",
  remoteConnection: "deferred_until_first_turn",
});

/** Static metadata: safe to inspect before a server-side key is available. */
export const OPENAI_NATIVE_TRANSLATION_CAPABILITIES: TranslationCapabilities =
  Object.freeze({
    providerId: "openai_native",
    modes: Object.freeze([
      Object.freeze({
        mode: "fast" as const,
        behaviorVersion: 1 as const,
        state: "native" as const,
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "balanced" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: false,
      }),
      Object.freeze({
        mode: "accurate" as const,
        behaviorVersion: 1 as const,
        state: "experimental" as const,
        deterministicGlossary: false,
        reason:
          "Native Realtime accurate mode is experimental and unavailable until benchmark parity is established.",
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
    modes: Object.freeze([
      Object.freeze({
        mode: "fast" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: true,
      }),
      Object.freeze({
        mode: "balanced" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
        deterministicGlossary: true,
      }),
      Object.freeze({
        mode: "accurate" as const,
        behaviorVersion: 1 as const,
        state: "locally_controlled" as const,
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
  /** Translation model selected in the dedicated endpoint query string. */
  readonly model?: string;
  /** Optional dedicated-route source transcript model. */
  readonly inputTranscriptionModel?: string | null;
  /** Optional dedicated-route input noise reduction. */
  readonly noiseReduction?: "near_field" | "far_field" | null;
  readonly now?: () => number;
  readonly connectTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
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

class NativePayloadTooLargeError extends Error {
  constructor() {
    super("OpenAI native translation message exceeds the supported size.");
    this.name = "NativePayloadTooLargeError";
  }
}

class NativePayloadDepthError extends Error {
  constructor() {
    super("OpenAI native translation message nesting exceeds the supported depth.");
    this.name = "NativePayloadDepthError";
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
  readonly #inputTranscriptionModel: string | null;
  readonly #noiseReduction: "near_field" | "far_field" | null;
  readonly #now: () => number;
  readonly #connectTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #inputAppendBytes: number;
  readonly #active = new Map<string, ActiveTranslation>();
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: NativeRealtimeTranslateAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    const endpoint = options.endpoint ?? DEFAULT_REALTIME_URL;
    let parsedEndpoint: URL;
    try {
      parsedEndpoint = new URL(endpoint);
    } catch {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI native translation endpoint is not a valid WebSocket URL.",
      );
    }
    const normalizedPath = parsedEndpoint.pathname;
    if (
      parsedEndpoint.protocol !== "wss:" ||
      parsedEndpoint.hostname !== "api.openai.com" ||
      parsedEndpoint.port.length > 0 ||
      normalizedPath !== "/v1/realtime/translations" ||
      parsedEndpoint.toString() !== DEFAULT_REALTIME_URL ||
      parsedEndpoint.username.length > 0 ||
      parsedEndpoint.password.length > 0 ||
      parsedEndpoint.search.length > 0 ||
      parsedEndpoint.hash.length > 0
    ) {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI native translation requires the dedicated /v1/realtime/translations WebSocket endpoint.",
      );
    }
    this.#endpoint = parsedEndpoint.toString();
    const model = options.model ?? "gpt-realtime-translate";
    if (model !== "gpt-realtime-translate") {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI native translation requires the gpt-realtime-translate model.",
      );
    }
    this.#model = model;
    this.#inputTranscriptionModel =
      options.inputTranscriptionModel === undefined
        ? "gpt-realtime-whisper"
        : options.inputTranscriptionModel;
    if (
      this.#inputTranscriptionModel !== null &&
      (this.#inputTranscriptionModel.trim().length === 0 ||
        Buffer.byteLength(this.#inputTranscriptionModel, "utf8") >
          MAX_NATIVE_PROVIDER_EVENT_ID_BYTES)
    ) {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI native translation transcription model is invalid.",
      );
    }
    this.#noiseReduction = options.noiseReduction ?? null;
    this.#now = options.now ?? (() => performance.now());
    this.#connectTimeoutMs = resolveTimeoutMs(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "OpenAI realtime connectTimeoutMs",
    );
    this.#closeTimeoutMs = resolveTimeoutMs(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      "OpenAI realtime closeTimeoutMs",
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

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    assertOpenAICapability(context, this.capabilities);
    return OPENAI_LOCAL_ROUTE_PREPARATION;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const ref = request.context;
    assertOpenAICapability(ref, this.capabilities);
    const behavior = ref.behavior;
    const maxBufferedAudioFrames = Math.max(
      1,
      Math.floor(behavior.maxBufferedAudioMs / CANONICAL_AUDIO.frameDurationMs),
    );
    // Reserve the next append-sized window from the local ingress budget.
    // Once a window is appended synchronously, the provider owns it; until
    // then, the queued windows plus this partial window must fit the behavior
    // budget exactly.
    const continuousInputWindowFrames = Math.min(
      this.#inputAppendBytes / CANONICAL_AUDIO.bytesPerFrame,
      Math.max(1, maxBufferedAudioFrames - 1),
    );
    const continuousInputBacklogFrames =
      maxBufferedAudioFrames - continuousInputWindowFrames;
    if (
      behavior.inputCommit === "continuous" &&
      continuousInputBacklogFrames < 1
    ) {
      throw new OpenAIAdapterError(
        "configuration_error",
        "OpenAI realtime continuous behavior must reserve local backlog capacity after each input window.",
      );
    }
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
      evidenceRef = adapterGeneratedEvidenceRef(
        "openai-native",
        ref,
        segmentId,
        revision,
        finality,
      ),
    ) => ({
      sessionId: ref.sessionId,
      lane: ref.lane,
      generation: ref.generation,
      turnId: ref.turnId,
      segmentId,
      revision,
      finality,
      evidenceRef,
      emittedAtMs,
    });
    const errorEvent = (
      code: string,
      message: string,
      retryable: boolean,
      evidenceRef?: string,
    ): TranslationErrorEvent => {
      const segmentId = "error-" + errorSequence.toString(10);
      errorSequence += 1;
      return {
        kind: "error",
        ...eventBase(segmentId, 1, "final", undefined, evidenceRef),
        error: { code, message, retryable },
      };
    };

    let socket: WebSocketLike;
    try {
      socket = this.#webSocketFactory(
        appendModel(this.#endpoint, this.#model),
        {
          headers: authorizationHeaders(this.#apiKey),
          maxPayload: MAX_NATIVE_WIRE_PAYLOAD_BYTES,
          perMessageDeflate: false,
        },
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
      ? new BoundedAudioWindowQueue<ContinuousInputWindow>(
        continuousInputBacklogFrames,
      )
      : undefined;
    let lifecycle: "active" | "cancelled" | "failed" | "completed" = "active";
    let outputSuppressed = false;
    let sessionReady = false;
    let sessionCloseSent = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingOutputAudio = new Uint8Array(0);
    let pendingOutputAudioProviderId: string | undefined;
    let queuedNonAudioEvents = 0;
    let queuedNonAudioBytes = 0;
    let inputStopRequested = false;
    let inputReturnRequested = false;
    let inputIterator: AsyncIterator<AudioFrame> | undefined;
    let wakeInputStop: (() => void) | undefined;
    const inputStopped = new Promise<void>((resolve) => {
      wakeInputStop = resolve;
    });

    const clearCloseDeadline = (): void => {
      if (closeTimer === undefined) return;
      clearTimeout(closeTimer);
      closeTimer = undefined;
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
        sendNativeJson(socket, event);
      } catch {
        // A local cancellation fence is authoritative even if the socket died.
      }
    };
    const queueEvent = (
      event: TranslationEvent,
      options: Readonly<{ readonly audio?: boolean; readonly holdback?: boolean }> = {},
    ): void => {
      if (lifecycle !== "active") return;
      const isAudio = options.audio === true || event.kind === "audio";
      let eventBytes = 0;
      if (!isAudio) {
        eventBytes = nativeEventBytes(event);
        if (
          eventBytes > MAX_NATIVE_QUEUED_NON_AUDIO_BYTES ||
          queuedNonAudioEvents >= MAX_NATIVE_QUEUED_NON_AUDIO_EVENTS ||
          queuedNonAudioBytes + eventBytes > MAX_NATIVE_QUEUED_NON_AUDIO_BYTES
        ) {
          fail(
            "OPENAI_REALTIME_EVENT_QUEUE_LIMIT",
            "The translation service returned too many queued events.",
            true,
          );
          return;
        }
      }
      const offer = events.offer(event, {
        audio: isAudio,
        holdbackMs: options.holdback === true ? behavior.holdbackMs : 0,
      });
      if (offer === "closed") return;
      if (!isAudio) {
        queuedNonAudioEvents += 1;
        queuedNonAudioBytes += eventBytes;
      }
      if (offer === "dropped_oldest") {
        queueEvent(
          errorEvent(
            "OPENAI_REALTIME_PLAYOUT_QUEUE_TRIMMED",
            "The oldest queued translation audio was dropped to preserve the latency budget.",
            true,
          ),
        );
      }
    };
    const queueError = (
      code: string,
      message: string,
      retryable: boolean,
      evidenceRef?: string,
    ): void => {
      queueEvent(errorEvent(code, message, retryable, evidenceRef));
    };
    const transcriptStates = new Map<
      string,
      {
        readonly kind: "source_transcript" | "target_transcript";
        readonly segmentId: string;
        readonly evidenceRef: string;
        text: string;
        revision: number;
        finalEmitted: boolean;
      }
    >();
    // The dedicated translation route emits audio deltas independently of
    // transcript revisions. Keep the latest emitted target transcript state
    // so every audible frame can be correlated without deriving an identity
    // from an audio event/sequence name.
    let currentTargetSegmentId: string | undefined;
    let currentTargetRevision: number | undefined;
    let missingTargetAudioReported = false;
    const publishTranscript = (
      kind: "source_transcript" | "target_transcript",
      providerId: string,
      evidenceRef: string,
      text: string,
      final: boolean,
    ): void => {
      const stateKey = kind + "\u0000" + providerId;
      let state = transcriptStates.get(stateKey);
      if (state === undefined) {
        state = {
          kind,
          segmentId: kind + "-" + providerId,
          evidenceRef,
          text: "",
          revision: 0,
          finalEmitted: false,
        };
        transcriptStates.set(stateKey, state);
      }
      const nextText = final ? text : state.text + text;
      if (Buffer.byteLength(nextText, "utf8") > MAX_NATIVE_PROVIDER_EVENT_TEXT_BYTES) {
        fail(
          "OPENAI_REALTIME_INVALID_PAYLOAD",
          "The translation service returned an oversized transcript.",
          true,
        );
        return;
      }
      state.text = nextText;
      if (!final && behavior.transcriptPolicy === "final_only") return;
      state.revision += 1;
      if (final) state.finalEmitted = true;
      if (kind === "target_transcript") {
        currentTargetSegmentId = state.segmentId;
        currentTargetRevision = state.revision;
        missingTargetAudioReported = false;
      }
      queueEvent(
        {
          kind: state.kind,
          ...eventBase(
            state.segmentId,
            state.revision,
            final ? "final" : "provisional",
            undefined,
            state.evidenceRef,
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
        if (state.kind === "target_transcript") {
          currentTargetSegmentId = state.segmentId;
          currentTargetRevision = state.revision;
          missingTargetAudioReported = false;
        }
        queueEvent(
          {
            kind: state.kind,
            ...eventBase(
              state.segmentId,
              state.revision,
              "final",
              undefined,
              state.evidenceRef,
            ),
            text: state.text,
          },
          { holdback: true },
        );
      }
    };
    const emitAudioFrame = (
      pcm16le: Uint8Array,
      emittedAtMs: number,
      providerId?: string,
      targetSegmentId?: string,
      targetRevision?: number,
    ): void => {
      if (
        targetSegmentId === undefined ||
        targetSegmentId.trim().length === 0 ||
        targetRevision === undefined ||
        !Number.isSafeInteger(targetRevision) ||
        targetRevision < 0
      ) {
        if (!missingTargetAudioReported) {
          missingTargetAudioReported = true;
          queueError(
            "OPENAI_REALTIME_AUDIO_TARGET_UNKNOWN",
            "The translation service returned audio before a target transcript segment was identified.",
            true,
          );
        }
        return;
      }
      const outputSequence = this.#playoutSequences.next(ref);
      const evidenceRef = providerId === undefined
        ? undefined
        : providerDerivedEvidenceRef(
          "openai-native",
          ref,
          "output_audio",
          providerId,
          outputSequence.toString(10),
        );
      queueEvent(
        {
          kind: "audio",
          ...eventBase(
            "audio-" + outputSequence.toString(10),
            targetRevision,
            "final",
            emittedAtMs,
            evidenceRef,
          ),
          targetSegmentId,
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
    let pendingOutputAudioTargetSegmentId: string | undefined;
    let pendingOutputAudioTargetRevision: number | undefined;
    const acceptOutputAudio = (
      audio: Uint8Array,
      providerId?: string,
      targetSegmentId = currentTargetSegmentId,
      targetRevision = currentTargetRevision,
    ): void => {
      if (
        targetSegmentId === undefined ||
        targetRevision === undefined
      ) {
        if (!missingTargetAudioReported) {
          missingTargetAudioReported = true;
          queueError(
            "OPENAI_REALTIME_AUDIO_TARGET_UNKNOWN",
            "The translation service returned audio before a target transcript segment was identified.",
            true,
          );
        }
        // Do not retain bytes that could later be misattributed to a target
        // transcript arriving after this provider packet.
        pendingOutputAudio = new Uint8Array(0);
        pendingOutputAudioProviderId = undefined;
        pendingOutputAudioTargetSegmentId = undefined;
        pendingOutputAudioTargetRevision = undefined;
        return;
      }
      if (
        pendingOutputAudio.byteLength > 0 &&
        (pendingOutputAudioTargetSegmentId !== targetSegmentId ||
          pendingOutputAudioTargetRevision !== targetRevision)
      ) {
        // A target revision changed while a PCM fragment was buffered.  The
        // fragment cannot be safely attributed across the revision boundary.
        pendingOutputAudio = new Uint8Array(0);
        pendingOutputAudioProviderId = undefined;
        pendingOutputAudioTargetSegmentId = undefined;
        pendingOutputAudioTargetRevision = undefined;
        if (!missingTargetAudioReported) {
          missingTargetAudioReported = true;
          queueError(
            "OPENAI_REALTIME_AUDIO_TARGET_UNKNOWN",
            "The translation service returned audio across target transcript revisions.",
            true,
          );
        }
        return;
      }
      if (pendingOutputAudio.byteLength === 0) {
        pendingOutputAudioTargetSegmentId = targetSegmentId;
        pendingOutputAudioTargetRevision = targetRevision;
      }
      missingTargetAudioReported = false;
      const frameProviderId = pendingOutputAudio.byteLength === 0 ||
        pendingOutputAudioProviderId === providerId
        ? providerId
        : undefined;
      const combined = concatenateBytes(pendingOutputAudio, audio);
      let offset = 0;
      while (combined.byteLength - offset >= CANONICAL_AUDIO.bytesPerFrame) {
        emitAudioFrame(
          combined.slice(offset, offset + CANONICAL_AUDIO.bytesPerFrame),
          this.#now(),
          frameProviderId,
          pendingOutputAudioTargetSegmentId,
          pendingOutputAudioTargetRevision,
        );
        offset += CANONICAL_AUDIO.bytesPerFrame;
      }
      pendingOutputAudio = combined.slice(offset);
      pendingOutputAudioProviderId = pendingOutputAudio.byteLength === 0
        ? undefined
        : frameProviderId;
      if (pendingOutputAudio.byteLength === 0) {
        pendingOutputAudioTargetSegmentId = undefined;
        pendingOutputAudioTargetRevision = undefined;
      }
    };
    const finishOutputAudio = (): void => {
      if (pendingOutputAudio.byteLength === 0) return;
      if (
        currentTargetSegmentId === undefined ||
        currentTargetRevision === undefined
      ) {
        pendingOutputAudio = new Uint8Array(0);
        pendingOutputAudioProviderId = undefined;
        pendingOutputAudioTargetSegmentId = undefined;
        pendingOutputAudioTargetRevision = undefined;
        return;
      }
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
      const targetSegmentId = pendingOutputAudioTargetSegmentId ?? currentTargetSegmentId;
      const targetRevision = pendingOutputAudioTargetRevision ?? currentTargetRevision;
      pendingOutputAudio = new Uint8Array(0);
      emitAudioFrame(
        padded,
        this.#now(),
        pendingOutputAudioProviderId,
        targetSegmentId,
        targetRevision,
      );
      pendingOutputAudioProviderId = undefined;
      pendingOutputAudioTargetSegmentId = undefined;
      pendingOutputAudioTargetRevision = undefined;
    };
    const completedEvent = (evidenceRef?: string): TranslationEvent => ({
      kind: "completed",
      ...eventBase("completed", 1, "final", undefined, evidenceRef),
    });
    const requestSessionClose = (): void => {
      if (
        lifecycle !== "active" ||
        !sessionReady ||
        sessionCloseSent
      ) {
        return;
      }
      sessionCloseSent = true;
      try {
        // Translation sessions flush pending audio and emit session.closed.
        // Do not close the socket until that terminal event arrives.
        sendNativeJson(socket, { type: "session.close" });
        closeTimer = setTimeout(
          () =>
            fail(
              "OPENAI_REALTIME_CLOSE_TIMEOUT",
              "The translation service did not close the session in time.",
              true,
            ),
          this.#closeTimeoutMs,
        );
      } catch {
        fail(
          "OPENAI_REALTIME_INPUT",
          "The translation audio stream could not be closed.",
          true,
        );
      }
    };
    const complete = (evidenceRef?: string): void => {
      if (lifecycle !== "active") return;
      clearCloseDeadline();
      stopInput();
      finalizeTranscripts();
      finishOutputAudio();
      lifecycle = "completed";
      events.closeAfterDrain(completedEvent(evidenceRef));
      closeSocket(socket);
    };
    const stop = (): void => {
      if (lifecycle !== "active") return;
      outputSuppressed = true;
      lifecycle = "cancelled";
      clearCloseDeadline();
      stopInput();
      continuousInputWindows?.end({ discardBuffered: true });
      events.discard();
      if (!sessionCloseSent) {
        sessionCloseSent = true;
        sendBestEffort({ type: "session.close" });
      }
      closeSocket(socket);
    };
    const fail = (
      code: string,
      message: string,
      retryable: boolean,
      evidenceRef?: string,
    ): void => {
      if (lifecycle !== "active") return;
      clearCloseDeadline();
      stopInput();
      continuousInputWindows?.end({ discardBuffered: true });
      lifecycle = "failed";
      events.discardWith(errorEvent(code, message, retryable, evidenceRef));
      closeSocket(socket);
    };
    const appendContinuousWindow = (
      window: ContinuousInputWindow,
    ): Promise<void> | undefined => {
      if (
        lifecycle !== "active" ||
        !sessionReady ||
        sessionCloseSent
      ) {
        return undefined;
      }
      try {
        appendInputWindow(socket, window.frames, this.#inputAppendBytes);
      } catch {
        fail(
          "OPENAI_REALTIME_INPUT",
          "The translation audio stream could not be appended.",
          true,
        );
      }
      // The dedicated translation route has no response lifecycle. Once the
      // append is handed to the socket, the bounded local window is released.
      return Promise.resolve();
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
    const providerEventEvidenceRef = (
      providerEvent: Record<string, unknown>,
      providerEventKind: string,
    ): string | undefined => {
      const providerId =
        stringField(providerEvent, "event_id") ??
        stringField(providerEvent, "item_id");
      return providerId === undefined || providerId.trim().length === 0
        ? undefined
        : providerDerivedEvidenceRef(
          "openai-native",
          ref,
          providerEventKind,
          providerId,
        );
    };
    const outputIterator = events[Symbol.asyncIterator]();
    const nextOutputEvent = async (): Promise<IteratorResult<TranslationEvent>> => {
      const next = await outputIterator.next();
      if (!next.done && next.value.kind !== "audio") {
        queuedNonAudioEvents = Math.max(0, queuedNonAudioEvents - 1);
        queuedNonAudioBytes = Math.max(
          0,
          queuedNonAudioBytes - nativeEventBytes(next.value),
        );
      }
      return next;
    };

    socket.on("message", (data) => {
      if (lifecycle !== "active") return;
      try {
        const providerEvent = parseNativeProviderEvent(data);
        if (providerEvent === null) return;
        const type = stringField(providerEvent, "type");
        if (type === undefined || type.length === 0) {
          fail(
            "OPENAI_REALTIME_INVALID_PAYLOAD",
            "The translation service returned an invalid message.",
            true,
          );
          return;
        }

        const providerEventId = stringField(providerEvent, "event_id") ??
          stringField(providerEvent, "item_id");
        if (
          providerEventId !== undefined &&
          Buffer.byteLength(providerEventId, "utf8") > MAX_NATIVE_PROVIDER_EVENT_ID_BYTES
        ) {
          fail(
            "OPENAI_REALTIME_INVALID_PAYLOAD",
            "The translation service returned an invalid event.",
            true,
          );
          return;
        }

        if (type === "session.output_audio.delta") {
          const encoded = stringField(providerEvent, "delta");
          const providerId = stringField(providerEvent, "event_id");
          if (encoded === undefined) {
            queueError(
              "OPENAI_REALTIME_INVALID_AUDIO",
              "The translation service returned invalid audio.",
              true,
              providerEventEvidenceRef(providerEvent, "invalid_output_audio"),
            );
            return;
          }
          try {
            acceptOutputAudio(decodeAudioDelta(encoded), providerId);
          } catch {
            queueError(
              "OPENAI_REALTIME_INVALID_AUDIO",
              "The translation service returned invalid audio.",
              true,
              providerEventEvidenceRef(providerEvent, "invalid_output_audio"),
            );
          }
          return;
        }

        if (
          type === "session.input_transcript.delta" ||
          type === "session.input_transcript.done" ||
          type === "session.input_transcript.final" ||
          type === "session.output_transcript.delta" ||
          type === "session.output_transcript.done" ||
          type === "session.output_transcript.final"
        ) {
          const source = type === "session.input_transcript.delta" ||
            type === "session.input_transcript.done" ||
            type === "session.input_transcript.final";
          const final = type.endsWith(".done") || type.endsWith(".final");
          const text = final
            ? stringField(providerEvent, "transcript") ??
              stringField(providerEvent, "text") ??
              stringField(providerEvent, "delta")
            : stringField(providerEvent, "delta");
          if (text !== undefined) {
            if (Buffer.byteLength(text, "utf8") > MAX_NATIVE_PROVIDER_EVENT_TEXT_BYTES) {
              fail(
                "OPENAI_REALTIME_INVALID_PAYLOAD",
                "The translation service returned an invalid transcript.",
                true,
                providerEventEvidenceRef(providerEvent, "invalid_transcript"),
              );
              return;
            }
            // Translation server event IDs identify individual deltas, not a
            // transcript segment. Keep one stable state per direction so each
            // revision contains the full accumulated text.
            const providerId = source ? "source" : "target";
            const providerEvidenceId = stringField(providerEvent, "event_id");
            publishTranscript(
              source ? "source_transcript" : "target_transcript",
              providerId,
              providerEvidenceId === undefined || providerEvidenceId.trim().length === 0
                ? adapterGeneratedEvidenceRef(
                  "openai-native",
                  ref,
                  providerId,
                  1,
                  final ? "final" : "provisional",
                )
                : providerDerivedEvidenceRef(
                  "openai-native",
                  ref,
                  source ? "input_transcript" : "output_transcript",
                  providerEvidenceId,
                ),
              text,
              final,
            );
          }
          return;
        }

        if (type === "session.closed") {
          complete(providerEventEvidenceRef(providerEvent, "session_closed"));
          return;
        }

        if (type === "error") {
          fail(
            "OPENAI_REALTIME_PROVIDER",
            "The translation service reported an error.",
            true,
            providerEventEvidenceRef(providerEvent, "provider_error"),
          );
        }
      } catch (error: unknown) {
        fail(
          error instanceof NativePayloadTooLargeError
            ? "OPENAI_REALTIME_PAYLOAD_TOO_LARGE"
            : error instanceof NativePayloadDepthError
              ? "OPENAI_REALTIME_INVALID_PAYLOAD"
              : "OPENAI_REALTIME_INVALID_PAYLOAD",
          error instanceof NativePayloadTooLargeError
            ? "The translation service returned an oversized message."
            : "The translation service returned an invalid message.",
          true,
        );
      }
    });
    socket.on("error", () => {
      try {
        fail(
          "OPENAI_REALTIME_CONNECTION",
          "The translation service connection failed.",
          true,
        );
      } catch {
        closeSocket(socket);
      }
    });
    socket.on("close", () => {
      if (lifecycle !== "active") return;
      try {
        fail(
          "OPENAI_REALTIME_CONNECTION",
          "The translation service connection closed unexpectedly.",
          true,
        );
      } catch {
        closeSocket(socket);
      }
    });

    try {
      await waitForOpen(socket, request.signal, this.#connectTimeoutMs);
      sendNativeJson(socket, {
        type: "session.update",
        session: {
          audio: {
            input: {
              transcription: this.#inputTranscriptionModel === null
                ? null
                : { model: this.#inputTranscriptionModel },
              noise_reduction: this.#noiseReduction === null
                ? null
                : { type: this.#noiseReduction },
            },
            output: {
              language: translationLanguage(ref.targetLanguage),
            },
          },
        },
      });

      sessionReady = true;

      if (continuousInputWindows !== undefined) {
        void (async (): Promise<void> => {
          try {
            const inputWindows = continuousInputWindows[Symbol.asyncIterator]();
            while (true) {
              let exhausted = false;
              let appendCompleted: Promise<void> | undefined;
              {
                const nextWindow = await inputWindows.next();
                if (nextWindow.done) {
                  exhausted = true;
                } else if (lifecycle !== "active" || request.signal.aborted) {
                  return;
                } else {
                  // `appendInputWindow` synchronously hands this audio to the
                  // provider. `nextWindow` goes out of scope before we await
                  // another queue turn, so the sent window is not local
                  // backlog.
                  appendCompleted = appendContinuousWindow(nextWindow.value);
                }
              }
              if (exhausted) break;
              if (appendCompleted === undefined) return;
              await appendCompleted;
              if (lifecycle !== "active" || request.signal.aborted) return;
            }
            requestSessionClose();
          } catch {
            fail(
              "OPENAI_REALTIME_INPUT",
              "The translation audio stream could not be appended.",
              true,
            );
          }
        })();
        void this.#pumpContinuousInput(
          request,
          continuousInputWindows,
          continuousInputWindowFrames,
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
          () => undefined,
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
          () => undefined,
          () => {
            requestSessionClose();
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

      while (true) {
        const next = await nextOutputEvent();
        if (next.done) break;
        const event = next.value;
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
        while (true) {
          const next = await nextOutputEvent();
          if (next.done) break;
          const event = next.value;
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
      sendNativeJson(socket, {
        type: "session.input_audio_buffer.append",
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
  /** Immutable operational policy projected from the approved profile. */
  readonly fallback: TranslationFallbackPolicy;
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
      preparation: OPENAI_LOCAL_ROUTE_PREPARATION,
      fallback: options.fallback,
      ...(options.minimumConfidence === undefined
        ? {}
        : { minimumConfidence: options.minimumConfidence }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#now = options.now ?? (() => performance.now());
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    assertOpenAICapability(context, this.capabilities);
    if (context.behavior.mode === "accurate") {
      await this.#delegate.prepare(context);
    }
    return OPENAI_LOCAL_ROUTE_PREPARATION;
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const ref = request.context;
    assertOpenAICapability(ref, this.capabilities);
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
      evidenceRef: adapterGeneratedEvidenceRef(
        "openai-controlled",
        ref,
        "completed",
        1,
        "final",
      ),
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
      evidenceRef: adapterGeneratedEvidenceRef(
        "openai-controlled",
        ref,
        "error-" + sequence.toString(10),
        1,
        "final",
      ),
      emittedAtMs: this.#now(),
      error: { code, message, retryable },
    };
  }
}

export type OpenAITranslationAdapterFactoryOptions =
  | Readonly<{
      readonly provider: "openai_native";
      readonly apiKey: string;
      readonly native?: Omit<NativeRealtimeTranslateAdapterOptions, "apiKey">;
    }>
  | Readonly<{
      readonly provider: "openai_controlled";
      readonly apiKey: string;
      readonly controlled: Omit<OpenAIControlledTranslationAdapterOptions, "apiKey">;
    }>;

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

function adapterGeneratedEvidenceRef(
  adapter: "openai-native" | "openai-controlled",
  ref: LaneContext,
  segmentId: string,
  revision: number,
  finality: "provisional" | "final",
): string {
  return createOpaqueEvidenceRef(adapter + ":adapter", [
    "adapter",
    ref.sessionId,
    ref.lane,
    ref.generation.toString(10),
    ref.turnId,
    segmentId,
    revision.toString(10),
    finality,
  ]);
}

function providerDerivedEvidenceRef(
  adapter: "openai-native" | "openai-controlled",
  ref: LaneContext,
  providerEventKind: string,
  providerId: string,
  ...parts: readonly string[]
): string {
  return createOpaqueEvidenceRef(adapter + ":provider", [
    "provider",
    ref.sessionId,
    ref.lane,
    ref.generation.toString(10),
    ref.turnId,
    providerEventKind,
    providerId,
    ...parts,
  ]);
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
  const evidenceRef = event.evidenceRef.trim().length === 0
    ? adapterGeneratedEvidenceRef(
      "openai-controlled",
      ref,
      segmentId,
      event.revision,
      event.finality,
    )
    : event.evidenceRef;
  if (event.kind !== "audio") {
    return {
      ...event,
      turnId: ref.turnId,
      segmentId,
      evidenceRef,
    };
  }
  return {
    ...event,
    turnId: ref.turnId,
    segmentId,
    evidenceRef,
    targetSegmentId: segmentIndex === undefined
      ? event.targetSegmentId
      : "segment-" + segmentIndex.toString(10) + ":" + event.targetSegmentId,
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

function assertOpenAICapability(
  context: LaneContext,
  capabilities: TranslationCapabilities,
): void {
  try {
    assertTranslationBehaviorCapability(
      capabilities,
      context.behavior,
      { glossaryRequested: context.glossary !== undefined },
    );
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new OpenAIAdapterError(
      "configuration_error",
      error.message,
    );
  }
}

/** The translation endpoint accepts a base ISO-639-1 output language code. */
function translationLanguage(language: string): string {
  const normalized = language.normalize("NFKC").trim().toLowerCase();
  const [base] = normalized.split(/[-_]/u);
  return base === undefined || base.length === 0 ? normalized : base;
}

function nativeEventBytes(event: TranslationEvent): number {
  try {
    const serialized = JSON.stringify(event);
    return serialized === undefined
      ? MAX_NATIVE_QUEUED_NON_AUDIO_BYTES + 1
      : Buffer.byteLength(serialized, "utf8");
  } catch {
    return MAX_NATIVE_QUEUED_NON_AUDIO_BYTES + 1;
  }
}

function sendNativeJson(socket: WebSocketLike, event: unknown): void {
  let payload: string;
  try {
    payload = JSON.stringify(event);
  } catch {
    throw new OpenAIAdapterError(
      "connection_failed",
      "The OpenAI realtime connection could not send data.",
    );
  }
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  const bufferedAmount = socket.bufferedAmount ?? 0;
  if (
    !Number.isFinite(bufferedAmount) ||
    bufferedAmount < 0 ||
    payloadBytes > MAX_NATIVE_WIRE_PAYLOAD_BYTES ||
    bufferedAmount + payloadBytes > MAX_NATIVE_OUTBOUND_BUFFERED_BYTES
  ) {
    throw new OpenAIAdapterError(
      "connection_failed",
      "The OpenAI realtime outbound buffer limit was exceeded.",
    );
  }
  try {
    socket.send(payload);
  } catch {
    throw new OpenAIAdapterError(
      "connection_failed",
      "The OpenAI realtime connection could not send data.",
    );
  }
}

function parseNativeProviderEvent(raw: unknown): Record<string, unknown> | null {
  let current = raw;
  for (let depth = 0; depth < MAX_NATIVE_PARSE_VALUE_DEPTH; depth += 1) {
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > MAX_NATIVE_WIRE_PAYLOAD_BYTES) {
        throw new NativePayloadTooLargeError();
      }
      assertNativeJsonNesting(current);
      try {
        current = JSON.parse(current) as unknown;
      } catch {
        throw new Error("Invalid OpenAI native translation payload.");
      }
      continue;
    }
    if (current instanceof Uint8Array) {
      if (current.byteLength > MAX_NATIVE_WIRE_PAYLOAD_BYTES) {
        throw new NativePayloadTooLargeError();
      }
      current = Buffer.from(current).toString("utf8");
      continue;
    }
    if (current instanceof ArrayBuffer) {
      if (current.byteLength > MAX_NATIVE_WIRE_PAYLOAD_BYTES) {
        throw new NativePayloadTooLargeError();
      }
      current = Buffer.from(current).toString("utf8");
      continue;
    }
    if (Array.isArray(current)) {
      let byteLength = 0;
      for (const chunk of current) {
        if (!(chunk instanceof Uint8Array)) {
          throw new Error("Invalid OpenAI native translation payload.");
        }
        if (chunk.byteLength > MAX_NATIVE_WIRE_PAYLOAD_BYTES - byteLength) {
          throw new NativePayloadTooLargeError();
        }
        byteLength += chunk.byteLength;
      }
      const joined = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of current) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      current = joined;
      continue;
    }
    if (isRecord(current) && "data" in current && Object.keys(current).length === 1) {
      current = current.data;
      continue;
    }
    if (!isRecord(current)) {
      throw new Error("Invalid OpenAI native translation payload.");
    }
    try {
      const serialized = JSON.stringify(current);
      if (
        serialized !== undefined &&
        Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_WIRE_PAYLOAD_BYTES
      ) {
        throw new NativePayloadTooLargeError();
      }
    } catch (error: unknown) {
      if (error instanceof NativePayloadTooLargeError) throw error;
      throw new NativePayloadDepthError();
    }
    return current;
  }
  throw new NativePayloadDepthError();
}

function assertNativeJsonNesting(value: string): void {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of value) {
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > MAX_NATIVE_JSON_NESTING) {
        throw new NativePayloadDepthError();
      }
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
  }
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
      sendNativeJson(socket, {
        type: "session.input_audio_buffer.append",
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

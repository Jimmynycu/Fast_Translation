import { CANONICAL_AUDIO, type AudioFrame } from "../../core/audio.js";
import type { GenerationRef } from "../../core/types.js";
import {
  appendModel,
  AsyncQueue,
  authorizationHeaders,
  closeSocket,
  defaultWebSocketFactory,
  encodePcm16,
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

const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMIT_TIMEOUT_MS = 10_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 30_000;

export type TranscriptionDelay =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

export interface OpenAILiveTranscribeAdapterOptions {
  readonly apiKey: string;
  readonly webSocketFactory?: WebSocketFactory;
  readonly endpoint?: string;
  readonly model?: string;
  readonly prompt?: string;
  readonly keywords?: readonly string[];
  readonly languages?: readonly string[];
  readonly delay?: TranscriptionDelay;
  readonly connectTimeoutMs?: number;
  readonly commitTimeoutMs?: number;
  readonly completionTimeoutMs?: number;
  readonly now?: () => number;
}

export type LiveTranscriptionInput =
  | Readonly<{ readonly type: "audio"; readonly frame: AudioFrame }>
  | Readonly<
      GenerationRef & {
        readonly type: "speech_end";
        readonly turnId: string;
      }
    >;

export interface LiveTranscriptionRequest {
  readonly events: AsyncIterable<LiveTranscriptionInput>;
  readonly context: GenerationRef;
  readonly keywords?: readonly string[];
  readonly languages?: readonly string[];
  readonly signal: AbortSignal;
}

interface LiveTranscriptionEventBase extends GenerationRef {
  readonly emittedAtMs: number;
  readonly itemId: string;
  readonly turnId: string;
}

export interface LiveTranscriptDeltaEvent
  extends LiveTranscriptionEventBase {
  readonly type: "transcript_delta";
  readonly delta: string;
}

export interface LiveTranscriptCompletedEvent
  extends LiveTranscriptionEventBase {
  readonly type: "transcript_completed";
  readonly transcript: string;
}

export interface LiveTranscriptionErrorEvent extends GenerationRef {
  readonly type: "error";
  readonly emittedAtMs: number;
  readonly error: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  }>;
}

export type LiveTranscriptionEvent =
  | LiveTranscriptDeltaEvent
  | LiveTranscriptCompletedEvent
  | LiveTranscriptionErrorEvent;

type ProviderTranscript =
  | Readonly<{ readonly type: "delta"; readonly itemId: string; readonly text: string }>
  | Readonly<{
      readonly type: "completed";
      readonly itemId: string;
      readonly text: string;
    }>;

interface PendingCommit {
  readonly turnId: string;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface ActiveTranscription {
  stop(): void;
}

export class OpenAILiveTranscribeAdapter {
  readonly #apiKey: string;
  readonly #webSocketFactory: WebSocketFactory;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #prompt: string | undefined;
  readonly #keywords: readonly string[];
  readonly #languages: readonly string[];
  readonly #delay: TranscriptionDelay | undefined;
  readonly #now: () => number;
  readonly #active = new Map<string, ActiveTranscription>();
  readonly #connectTimeoutMs: number;
  readonly #commitTimeoutMs: number;
  readonly #completionTimeoutMs: number;

  constructor(options: OpenAILiveTranscribeAdapterOptions) {
    this.#apiKey = requireApiKey(options.apiKey);
    this.#webSocketFactory =
      options.webSocketFactory ?? defaultWebSocketFactory;
    this.#endpoint = options.endpoint ?? DEFAULT_REALTIME_URL;
    this.#model = options.model ?? "gpt-live-transcribe";
    this.#prompt = options.prompt;
    this.#keywords = [...(options.keywords ?? [])];
    this.#languages = [...(options.languages ?? [])];
    this.#delay = options.delay;
    this.#now = options.now ?? (() => performance.now());
    this.#connectTimeoutMs = resolveTimeoutMs(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "OpenAI transcription connectTimeoutMs",
    );
    this.#commitTimeoutMs = resolveTimeoutMs(
      options.commitTimeoutMs,
      DEFAULT_COMMIT_TIMEOUT_MS,
      "OpenAI transcription commitTimeoutMs",
    );
    this.#completionTimeoutMs = resolveTimeoutMs(
      options.completionTimeoutMs,
      DEFAULT_COMPLETION_TIMEOUT_MS,
      "OpenAI transcription completionTimeoutMs",
    );

    for (const keyword of this.#keywords) {
      if (
        keyword.length === 0 ||
        keyword.includes("<") ||
        keyword.includes(">") ||
        keyword.includes("\r") ||
        keyword.includes("\n")
      ) {
        throw new OpenAIAdapterError(
          "configuration_error",
          "OpenAI transcription keywords contain unsupported characters.",
        );
      }
    }
  }

  async *transcribe(
    request: LiveTranscriptionRequest,
  ): AsyncIterable<LiveTranscriptionEvent> {
    const ref = request.context;
    const keywords = uniqueValues([
      ...this.#keywords,
      ...(request.keywords ?? []).filter(isSupportedKeyword),
    ]);
    const languages = uniqueValues([...this.#languages, ...(request.languages ?? [])]);
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
        "OPENAI_TRANSCRIBE_CONNECT",
        "The transcription service connection could not be created.",
        true,
      );
      return;
    }

    const events = new AsyncQueue<LiveTranscriptionEvent>();
    let lifecycle: "active" | "intentional" | "failed" = "active";
    const waitingTurns: PendingCommit[] = [];
    const turnByItem = new Map<string, string>();
    const incompleteItems = new Set<string>();
    const completionTimers = new Map<
      string,
      ReturnType<typeof setTimeout>
    >();
    const bufferedByItem = new Map<string, ProviderTranscript[]>();
    let inputEnded = false;
    let inputStopRequested = false;
    let inputReturnRequested = false;
    let inputIterator: AsyncIterator<LiveTranscriptionInput> | undefined;
    let wakeInputStop: (() => void) | undefined;
    const inputStopped = new Promise<void>((resolve) => {
      wakeInputStop = resolve;
    });
    const returnInputIterator = (
      iterator: AsyncIterator<LiveTranscriptionInput>,
    ): void => {
      if (inputIterator === iterator) inputIterator = undefined;
      if (inputReturnRequested) return;
      inputReturnRequested = true;
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // Upstream iterator cleanup is best effort.
      }
    };
    const registerInputIterator = (
      iterator: AsyncIterator<LiveTranscriptionInput>,
    ): void => {
      inputIterator = iterator;
      if (inputStopRequested) returnInputIterator(iterator);
    };
    const releaseInputIterator = (
      iterator: AsyncIterator<LiveTranscriptionInput>,
    ): void => {
      if (inputIterator === iterator) inputIterator = undefined;
    };
    const stopInput = (): void => {
      if (inputStopRequested) return;
      inputStopRequested = true;
      wakeInputStop?.();
      const iterator = inputIterator;
      if (iterator !== undefined) returnInputIterator(iterator);
    };

    const clearTurnDeadlines = (): void => {
      for (const pending of waitingTurns.splice(0)) {
        clearTimeout(pending.timer);
      }
      for (const timer of completionTimers.values()) clearTimeout(timer);
      completionTimers.clear();
    };

    const stop = (): void => {
      if (lifecycle !== "active") return;
      stopInput();
      clearTurnDeadlines();
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
      stopInput();
      clearTurnDeadlines();
      lifecycle = "failed";
      events.push(this.#errorEvent(ref, code, message, retryable));
      events.end();
      if (closeTransport) closeSocket(socket);
    };

    const enqueueCommit = (turnId: string): void => {
      waitingTurns.push({
        turnId,
        timer: setTimeout(
          () =>
            fail(
              "OPENAI_TRANSCRIBE_COMMIT_TIMEOUT",
              "The transcription service timed out while committing audio.",
              true,
            ),
          this.#commitTimeoutMs,
        ),
      });
    };

    const active: ActiveTranscription = { stop };
    this.#active.set(key, active);

    const maybeFinish = (): void => {
      if (
        inputEnded &&
        waitingTurns.length === 0 &&
        incompleteItems.size === 0
      ) {
        stop();
      }
    };

    const emitTranscript = (
      providerEvent: ProviderTranscript,
      turnId: string,
    ): void => {
      if (providerEvent.type === "delta") {
        events.push({
          type: "transcript_delta",
          sessionId: ref.sessionId,
          lane: ref.lane,
          generation: ref.generation,
          emittedAtMs: this.#now(),
          itemId: providerEvent.itemId,
          turnId,
          delta: providerEvent.text,
        });
        return;
      }

      events.push({
        type: "transcript_completed",
        sessionId: ref.sessionId,
        lane: ref.lane,
        generation: ref.generation,
        emittedAtMs: this.#now(),
        itemId: providerEvent.itemId,
        turnId,
        transcript: providerEvent.text,
      });
      const completionTimer = completionTimers.get(providerEvent.itemId);
      if (completionTimer !== undefined) clearTimeout(completionTimer);
      completionTimers.delete(providerEvent.itemId);
      incompleteItems.delete(providerEvent.itemId);
      maybeFinish();
    };

    const reconcile = (providerEvent: ProviderTranscript): void => {
      const turnId = turnByItem.get(providerEvent.itemId);
      if (turnId !== undefined) {
        emitTranscript(providerEvent, turnId);
        return;
      }
      const buffered = bufferedByItem.get(providerEvent.itemId) ?? [];
      buffered.push(providerEvent);
      bufferedByItem.set(providerEvent.itemId, buffered);
    };

    socket.on("message", (data) => {
      if (lifecycle !== "active") return;
      const providerEvent = parseJsonObject(data);
      if (providerEvent === null) return;
      const type = stringField(providerEvent, "type");

      if (type === "input_audio_buffer.committed") {
        const itemId = stringField(providerEvent, "item_id");
        const pending = waitingTurns.shift();
        if (pending !== undefined) clearTimeout(pending.timer);
        const turnId = pending?.turnId;
        if (itemId === undefined || turnId === undefined) {
          events.push(
            this.#errorEvent(
              ref,
              "OPENAI_TRANSCRIBE_RECONCILIATION",
              "The transcription service returned an unmatched audio turn.",
              true,
            ),
          );
          return;
        }
        turnByItem.set(itemId, turnId);
        incompleteItems.add(itemId);
        const previousTimer = completionTimers.get(itemId);
        if (previousTimer !== undefined) clearTimeout(previousTimer);
        completionTimers.set(
          itemId,
          setTimeout(
            () =>
              fail(
                "OPENAI_TRANSCRIBE_COMPLETION_TIMEOUT",
                "The transcription service timed out while completing a transcript.",
                true,
              ),
            this.#completionTimeoutMs,
          ),
        );
        const buffered = bufferedByItem.get(itemId);
        if (buffered !== undefined) {
          bufferedByItem.delete(itemId);
          for (const item of buffered) emitTranscript(item, turnId);
        }
        maybeFinish();
        return;
      }

      if (
        type === "conversation.item.input_audio_transcription.delta" ||
        type === "conversation.item.input_audio_transcription.completed"
      ) {
        const itemId = stringField(providerEvent, "item_id");
        const text = stringField(
          providerEvent,
          type.endsWith(".delta") ? "delta" : "transcript",
        );
        if (itemId === undefined || text === undefined) return;
        reconcile({
          type: type.endsWith(".delta") ? "delta" : "completed",
          itemId,
          text,
        });
        return;
      }

      if (type === "error") {
        fail(
          "OPENAI_TRANSCRIBE_PROVIDER",
          "The transcription service reported an error.",
          true,
        );
      }
    });

    socket.on("error", () =>
      fail(
        "OPENAI_TRANSCRIBE_CONNECTION",
        "The transcription service connection failed.",
        true,
      ),
    );
    socket.on("close", () => {
      fail(
        "OPENAI_TRANSCRIBE_CONNECTION",
        "The transcription service connection closed unexpectedly.",
        true,
        false,
      );
    });

    const onAbort = (): void => stop();
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await waitForOpen(socket, request.signal, this.#connectTimeoutMs);
      sendJson(socket, {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: {
                model: this.#model,
                ...(this.#prompt === undefined ? {} : { prompt: this.#prompt }),
                ...(keywords.length === 0
                  ? {}
                  : { keywords }),
                ...(languages.length === 0
                  ? {}
                  : { languages }),
                ...(this.#delay === undefined ? {} : { delay: this.#delay }),
              },
              turn_detection: null,
            },
          },
        },
      });

      void this.#pumpInput(
        request,
        socket,
        enqueueCommit,
        events,
        inputStopped,
        () => inputStopRequested,
        registerInputIterator,
        releaseInputIterator,
        returnInputIterator,
      )
        .then(() => {
          if (request.signal.aborted) {
            stop();
            return;
          }
          if (lifecycle !== "active") return;
          inputEnded = true;
          maybeFinish();
        })
        .catch(() => {
          fail(
            "OPENAI_TRANSCRIBE_INPUT",
            "The transcription audio stream failed.",
            false,
          );
        });

      for await (const event of events) yield event;
    } catch (error) {
      if (!request.signal.aborted) {
        const timedOut =
          error instanceof OpenAIAdapterError && error.code === "timeout";
        fail(
          timedOut
            ? "OPENAI_TRANSCRIBE_CONNECT_TIMEOUT"
            : "OPENAI_TRANSCRIBE_CONNECTION",
          timedOut
            ? "The transcription service connection timed out."
            : "The transcription service connection failed.",
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
    request: LiveTranscriptionRequest,
    socket: WebSocketLike,
    enqueueCommit: (turnId: string) => void,
    events: AsyncQueue<LiveTranscriptionEvent>,
    stopPromise: Promise<void>,
    isStopped: () => boolean,
    registerIterator: (iterator: AsyncIterator<LiveTranscriptionInput>) => void,
    releaseIterator: (iterator: AsyncIterator<LiveTranscriptionInput>) => void,
    returnIterator: (iterator: AsyncIterator<LiveTranscriptionInput>) => void,
  ): Promise<void> {
    let commitSequence = 0;
    if (request.signal.aborted || isStopped()) return;

    const iterator = request.events[Symbol.asyncIterator]();
    registerIterator(iterator);
    let naturallyDone = false;
    try {
      while (!request.signal.aborted && !isStopped()) {
        const next = await Promise.race<
          | Readonly<{
              readonly type: "input";
              readonly result: IteratorResult<LiveTranscriptionInput>;
            }>
          | Readonly<{ readonly type: "stopped" }>
        >([
          Promise.resolve(iterator.next()).then((result) => ({
            type: "input" as const,
            result,
          })),
          stopPromise.then(() => ({ type: "stopped" as const })),
        ]);
        if (next.type === "stopped") return;
        if (next.result.done) {
          naturallyDone = true;
          return;
        }
        if (request.signal.aborted || isStopped()) return;
        const input = next.result.value;

        if (input.type === "audio") {
          const frame = input.frame;
          if (!matchesGeneration(frame, request.context)) {
            events.push(
              this.#errorEvent(
                request.context,
                "OPENAI_TRANSCRIBE_GENERATION_MISMATCH",
                "An audio frame did not belong to the active transcription generation.",
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
                "OPENAI_TRANSCRIBE_AUDIO_FORMAT",
                "An audio frame was not canonical 24 kHz mono PCM16.",
                false,
              ),
            );
            throw new OpenAIAdapterError(
              "invalid_input",
              "Unsupported audio format.",
            );
          }
          if (request.signal.aborted || isStopped()) return;
          sendJson(socket, {
            type: "input_audio_buffer.append",
            audio: encodePcm16(frame.pcm16le),
          });
          continue;
        }

        if (!matchesGeneration(input, request.context)) {
          events.push(
            this.#errorEvent(
              request.context,
              "OPENAI_TRANSCRIBE_GENERATION_MISMATCH",
              "A speech boundary did not belong to the active transcription generation.",
              false,
            ),
          );
          throw new OpenAIAdapterError(
            "invalid_input",
            "Speech boundary generation mismatch.",
          );
        }
        if (input.turnId.length === 0) {
          throw new OpenAIAdapterError(
            "invalid_input",
            "A transcription turn ID is required.",
          );
        }

        if (request.signal.aborted || isStopped()) return;
        enqueueCommit(input.turnId);
        sendJson(socket, {
          type: "input_audio_buffer.commit",
          event_id: "commit_" + commitSequence.toString(10),
        });
        commitSequence += 1;
      }
    } finally {
      if (naturallyDone) releaseIterator(iterator);
      else returnIterator(iterator);
    }
  }
  #errorEvent(
    ref: GenerationRef,
    code: string,
    message: string,
    retryable: boolean,
  ): LiveTranscriptionErrorEvent {
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

function matchesGeneration(
  value: GenerationRef,
  expected: GenerationRef,
): boolean {
  return (
    value.sessionId === expected.sessionId &&
    value.lane === expected.lane &&
    value.generation === expected.generation
  );
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

function isSupportedKeyword(candidate: string): boolean {
  const keyword = candidate.trim();
  return keyword.length > 0 && !/[<>\r\n]/u.test(keyword);
}

function uniqueValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of values) {
    const value = candidate.normalize("NFKC").trim();
    if (value.length === 0) continue;
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  return Object.freeze(unique);
}

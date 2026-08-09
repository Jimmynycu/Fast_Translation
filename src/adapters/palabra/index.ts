import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { CANONICAL_AUDIO, createAudioFrame, type AudioFrame } from "../../core/audio.js";
import { GenerationPlayoutSequence } from "../../core/playout-sequence.js";
import { assertTranslationBehaviorCapability } from "../../core/translation-capabilities.js";
import { createOpaqueEvidenceRef } from "../translation/evidence-ref.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationBehavior,
  TranslationCapabilities,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationPreparation,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";

export interface PalabraWebSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
}
export interface PalabraWebSocketConnectOptions {
  readonly headers: Readonly<Record<string, string>>;
  readonly maxPayload: number;
  readonly perMessageDeflate: false;
}
export type PalabraWebSocketFactory = (url: string, options: PalabraWebSocketConnectOptions) => PalabraWebSocketLike;
export interface PalabraTranslationAdapterOptions {
  readonly apiKey: string;
  readonly webSocketFactory?: PalabraWebSocketFactory;
  readonly endpoint?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomHash?: string | (() => string);
  readonly now?: () => number;
  readonly connectTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly readinessPollIntervalMs?: number;
  readonly turnTimeoutMs?: number;
  readonly settleWindowMs?: number;
  readonly closeTimeoutMs?: number;
  readonly eosTimeoutSec?: number;
}

const DEFAULT_ENDPOINT = "wss://streaming.palabra.ai/streaming-api/{hash}/v1/speech-to-speech/stream";
const PALABRA_HASH_PLACEHOLDER = "{hash}";
const PALABRA_ROUTE_HASH_SENTINEL = "palabra-route-hash-placeholder";
const BALANCED_CONFIRMATION_MS = 700;
const SAMPLE_RATE = CANONICAL_AUDIO.sampleRateHz;
const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
const FIXED_INPUT_CHUNK_MS = 320;
const FIXED_INPUT_CHUNK_BYTES = FIXED_INPUT_CHUNK_MS * BYTES_PER_MS;
const MAX_PALABRA_WIRE_PAYLOAD_BYTES = 512 * 1024;
const MAX_QUEUED_PROVIDER_EVENTS = 256;
const MAX_QUEUED_PROVIDER_EVENT_BYTES = 256 * 1024;
const MAX_PROVIDER_EVENT_TEXT_BYTES = 64 * 1024;
const MAX_PROVIDER_EVENT_ID_BYTES = 256;
const MAX_TURN_SEGMENTS = 256;
const MAX_TURN_PROVIDER_IDS = 256;
const MAX_PARSE_VALUE_UNWRAP_DEPTH = 8;
const DEFAULTS = Object.freeze({ connect: 10000, readiness: 15000, poll: 2000, turn: 45000, settle: 35, close: 2000, eos: 1 });
const MAX_RETIRED_PROVIDER_IDS = 128;

const PALABRA_REMOTE_TASK_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "remote_task_ready",
  remoteConnection: "connected",
});

export const PALABRA_TRANSLATION_CAPABILITIES = Object.freeze({
  providerId: "palabra",
  modes: [
    { mode: "fast", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, state: "native", deterministicGlossary: false },
    {
      mode: "accurate",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
      reason: "Palabra account glossaries cannot provide a deterministic pinned glossary.",
    },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: false,
} satisfies TranslationCapabilities);

interface Envelope { readonly type: string; readonly data: Record<string, unknown>; }
interface TaskWaiter { readonly resolve: (value: "running" | "not_found" | "other") => void; readonly reject: (error: unknown) => void; }
interface PreparedTask {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly behaviorVersion: TranslationBehavior["version"];
  readonly mode: TranslationBehavior["mode"];
}
interface SegmentState {
  readonly segmentId: string;
  revision: number;
  emittedRevision: number | undefined;
  text: string;
  finality: TranslationEvent["finality"];
}
interface QueueWriteResult {
  readonly droppedOldestAudio: boolean;
  readonly overflowed: boolean;
}
interface LaneSession {
  readonly key: string;
  readonly sessionId: string;
  readonly lane: LaneContext["lane"];
  socket: PalabraWebSocketLike | undefined;
  socketEpoch: number;
  opened: boolean;
  closed: boolean;
  intentionalClose: boolean;
  prepared: boolean;
  preparePromise: Promise<TranslationPreparation> | undefined;
  taskWaiters: TaskWaiter[];
  turn: Turn | undefined;
  closePromise: Promise<void> | undefined;
  context: PreparedTask | undefined;
  preparationError: PalabraAdapterError | undefined;
  retiredProviderIds: Set<string>;
  retiredProviderIdOrder: string[];
  playoutGeneration: number | undefined;
}
interface Turn {
  readonly lane: LaneSession;
  readonly context: LaneContext;
  readonly queue: EventQueue;
  readonly segments: Map<string, SegmentState>;
  readonly providerIds: Set<string>;
  readonly validatedProviderIds: Set<string>;
  readonly abortListener: () => void;
  acceptEvents: boolean;
  sawValidated: boolean;
  nextSegmentId: number;
  nextAudioSegmentId: number;
  nextDiagnosticId: number;
  droppedAudioFrames: number;
  queueTrimMetricFinal: boolean;
  queueFailureInProgress: boolean;
  readonly inputStopPromise: Promise<void>;
  readonly signal: AbortSignal;
  wakeInputStop: () => void;
  lifecycle: "active" | "completed" | "failed" | "cancelled";
  inputStopped: boolean;
  inputIterator: AsyncIterator<AudioFrame> | undefined;
  inputReturnRequested: boolean;
  lastInputSequence: number | undefined;
  lastInputCapturedAtMs: number | undefined;
  lastInputSentAtMs: number | undefined;
  pendingAudio: Uint8Array<ArrayBufferLike>;
  pendingAudioTargetSegmentId: string | undefined;
  pendingAudioTargetRevision: number | undefined;
  lastCapturedAtMs: number;
  sawFinalTarget: boolean;
  sawLastAudio: boolean;
  inputFinished: boolean;
  completionTimer: ReturnType<typeof setTimeout> | undefined;
  hardTimer: ReturnType<typeof setTimeout> | undefined;
}

interface CloseLaneOptions { readonly remove?: boolean; readonly graceful?: boolean; }

export class PalabraAdapterError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly evidenceRef: string | undefined;
  constructor(code: string, message: string, retryable: boolean, evidenceRef?: string) {
    super(message);
    this.name = "PalabraAdapterError";
    this.code = code;
    this.retryable = retryable;
    this.evidenceRef = evidenceRef;
  }
}

class PalabraPayloadTooLargeError extends Error {
  constructor() {
    super("Palabra message payload exceeds the supported size.");
    this.name = "PalabraPayloadTooLargeError";
  }
}

export class PalabraTranslationAdapter implements TranslationPort {
  readonly capabilities = PALABRA_TRANSLATION_CAPABILITIES;
  readonly #apiKey: string;
  readonly #factory: PalabraWebSocketFactory;
  readonly #endpoint: string;
  readonly #hash: () => string;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #connectMs: number;
  readonly #readinessMs: number;
  readonly #pollMs: number;
  readonly #turnMs: number;
  readonly #settleMs: number;
  readonly #closeMs: number;
  readonly #eosSec: number;
  readonly #lanes = new Map<string, LaneSession>();
  readonly #playoutSequences = new GenerationPlayoutSequence();

  constructor(options: PalabraTranslationAdapterOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra credentials are not configured.", false);
    this.#apiKey = options.apiKey;
    this.#factory = options.webSocketFactory ?? defaultFactory;
    this.#endpoint = canonicalPalabraEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
    this.#hash = hashFactory(options.randomHash);
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? wait;
    this.#connectMs = positiveMs(options.connectTimeoutMs ?? DEFAULTS.connect, "connectTimeoutMs");
    this.#readinessMs = positiveMs(options.readinessTimeoutMs ?? DEFAULTS.readiness, "readinessTimeoutMs");
    this.#pollMs = positiveMs(options.pollIntervalMs ?? options.readinessPollIntervalMs ?? DEFAULTS.poll, "pollIntervalMs");
    this.#turnMs = positiveMs(options.turnTimeoutMs ?? DEFAULTS.turn, "turnTimeoutMs");
    this.#settleMs = nonNegativeMs(options.settleWindowMs ?? DEFAULTS.settle, "settleWindowMs");
    this.#closeMs = positiveMs(options.closeTimeoutMs ?? DEFAULTS.close, "closeTimeoutMs");
    const eos = options.eosTimeoutSec ?? DEFAULTS.eos;
    if (!Number.isFinite(eos) || eos < 1 || eos > 30) throw new PalabraAdapterError("PALABRA_CONFIGURATION", "eosTimeoutSec must be between 1 and 30 seconds.", false);
    this.#eosSec = eos;
  }

  async prepare(context: LaneContext): Promise<TranslationPreparation> {
    assertPalabraContext(context);
    const lane = this.#lane(context);
    if (lane.prepared && !lane.closed && sameTask(lane.context, context)) {
      return PALABRA_REMOTE_TASK_PREPARATION;
    }
    if (lane.preparePromise) return await lane.preparePromise;
    const operation = this.#prepare(lane, context);
    lane.preparePromise = operation;
    try {
      return await operation;
    } finally {
      if (lane.preparePromise === operation) lane.preparePromise = undefined;
    }
  }

  async #prepareUntil(context: LaneContext, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    let wakeAbort: (() => void) | undefined;
    let abortCleanup: Promise<void> | undefined;
    const preparingLane = this.#lane(context);
    const aborted = new Promise<false>((resolve) => { wakeAbort = () => resolve(false); });
    const onAbort = (): void => {
      wakeAbort?.();
      abortCleanup ??= this.#abortPreparation(preparingLane);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const prepared = this.prepare(context).then(() => true as const);
    try {
      const result = await Promise.race([prepared, aborted]);
      if (!result) {
        await abortCleanup;
        void prepared.catch(() => undefined);
      }
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    const context = request.context;
    if (request.signal.aborted) return;
    try {
      assertPalabraContext(context);
    } catch (error: unknown) {
      yield this.#error(
        context,
        error instanceof PalabraAdapterError ? error.code : "PALABRA_CONFIGURATION",
        error instanceof Error ? error.message : "Palabra configuration is invalid.",
        false,
        error instanceof PalabraAdapterError ? error.evidenceRef : undefined,
      );
      return;
    }
    let lane = this.#lane(context);
    if (lane.turn?.lifecycle === "active") {
      await this.#cancelTurn(lane, lane.turn);
    }
    try { if (!(await this.#prepareUntil(context, request.signal))) return; lane = this.#lane(context); }
    catch (error: unknown) {
      yield this.#error(context, error instanceof PalabraAdapterError ? error.code : "PALABRA_PREPARE", error instanceof PalabraAdapterError ? error.message : "The translation service could not be prepared.", error instanceof PalabraAdapterError ? error.retryable : true, error instanceof PalabraAdapterError ? error.evidenceRef : undefined);
      return;
    }
    const turn = this.#newTurn(lane, context, request.signal);
    lane.turn = turn;
    void this.#pumpInput(lane, turn, request);
    let natural = false;
    try {
      for await (const event of turn.queue) yield event;
      natural = turn.lifecycle === "completed" || turn.lifecycle === "failed";
    } finally {
      if (!natural && turn.lifecycle === "active") await this.#cancelTurn(lane, turn);
      this.#cleanupTurn(lane, turn);
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    const lane = this.#lanes.get(laneKey(generation));
    if (!lane?.turn || lane.turn.context.generation !== generation.generation) return;
    await this.#cancelTurn(lane, lane.turn);
  }

  async closeSession(sessionId: string): Promise<void> {
    const lanes = [...this.#lanes.values()].filter((lane) => lane.sessionId === sessionId);
    await Promise.all(lanes.map((lane) => this.#closeLane(lane, { remove: true, graceful: true })));
    this.#playoutSequences.clearSession(sessionId);
  }

  async #prepare(
    lane: LaneSession,
    context: LaneContext,
  ): Promise<TranslationPreparation> {
    if (lane.closed) throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection is unavailable.", true);
    await this.#ensureSocket(lane);
    if (lane.prepared && sameTask(lane.context, context)) {
      return PALABRA_REMOTE_TASK_PREPARATION;
    }
    lane.preparationError = undefined;
    lane.prepared = false;
    this.#send(lane, { message_type: "set_task", data: taskConfig(context.sourceLanguage, context.targetLanguage, context.behavior) });
    try {
      await this.#waitReady(lane);
      lane.prepared = true;
      lane.context = Object.freeze({
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        behaviorVersion: context.behavior.version,
        mode: context.behavior.mode,
      });
      return PALABRA_REMOTE_TASK_PREPARATION;
    } catch (error) { lane.prepared = false; throw error; }
  }

  async #waitReady(lane: LaneSession): Promise<void> {
    const deadline = Date.now() + this.#readinessMs;
    while (Date.now() < deadline) {
      if (lane.preparationError) throw lane.preparationError;
      const waiter = this.#taskWait(lane, Math.max(1, deadline - Date.now()));
      try { this.#send(lane, { message_type: "get_task", data: { exclude_hidden: true } }); }
      catch (error: unknown) {
        if (error instanceof PalabraAdapterError) throw error;
        throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service could not send a readiness check.", true);
      }
      const status = await waiter;
      if (status === "running") return;
      if (status === "other") throw new PalabraAdapterError("PALABRA_PROVIDER", "The translation service rejected task readiness.", true);
      await wait(Math.min(this.#pollMs, Math.max(0, deadline - Date.now())));
    }
    throw new PalabraAdapterError("PALABRA_READINESS_TIMEOUT", "The translation service did not become ready in time.", true);
  }

  async #abortPreparation(lane: LaneSession): Promise<void> {
    if (this.#lanes.get(lane.key) !== lane || lane.prepared || !lane.preparePromise) return;
    lane.preparePromise = undefined;
    this.#rejectTaskWaiters(lane, new PalabraAdapterError("PALABRA_ABORTED", "Palabra preparation was aborted.", true));
    await this.#closeLane(lane, { remove: true, graceful: false });
  }

  #taskWait(lane: LaneSession, timeoutMs: number): Promise<"running" | "not_found" | "other"> {
    return new Promise((resolve, reject) => {
      let done = false;
      let waiter!: TaskWaiter;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const index = lane.taskWaiters.indexOf(waiter);
        if (index >= 0) lane.taskWaiters.splice(index, 1);
        reject(new PalabraAdapterError("PALABRA_READINESS_TIMEOUT", "The translation service did not become ready in time.", true));
      }, timeoutMs);
      waiter = {
        resolve: (status) => { if (done) return; done = true; clearTimeout(timer); resolve(status); },
        reject: (error) => { if (done) return; done = true; clearTimeout(timer); reject(error); },
      };
      lane.taskWaiters.push(waiter);
    });
  }

  async #ensureSocket(lane: LaneSession): Promise<void> {
    if (lane.socket && lane.opened && !lane.closed) return;
    const hash = this.#hash();
    if (!/^[A-Za-z0-9_-]{32}$/.test(hash)) throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra connection hash must contain 32 URL-safe characters.", false);
    const endpoint = this.#endpoint.replace(PALABRA_HASH_PLACEHOLDER, hash);
    let socket: PalabraWebSocketLike;
    try {
      socket = this.#factory(endpoint, {
        headers: { Authorization: "Bearer " + this.#apiKey },
        maxPayload: MAX_PALABRA_WIRE_PAYLOAD_BYTES,
        perMessageDeflate: false,
      });
    }
    catch { throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection could not be created.", true); }
    lane.socket = socket;
    const socketEpoch = lane.socketEpoch + 1;
    lane.socketEpoch = socketEpoch;
    lane.opened = false;
    lane.closed = false;
    lane.intentionalClose = false;
    this.#bind(lane, socket, socketEpoch);
    const isCurrentAttempt = (): boolean => lane.socket === socket && lane.socketEpoch === socketEpoch;
    const isCurrent = (): boolean => isCurrentAttempt() && !lane.closed;
    if (socket.readyState === 1) { lane.opened = true; return; }
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new PalabraAdapterError("PALABRA_CONNECT_TIMEOUT", "The translation service connection timed out.", true)), this.#connectMs);
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          if (lane.socket === socket && lane.socketEpoch === socketEpoch) {
            lane.socket = undefined;
            lane.opened = false;
            lane.closed = true;
            lane.intentionalClose = true;
            lane.prepared = false;
            try { socket.close(1000, "connect timeout"); } catch { /* best effort */ }
          }
          reject(error);
        } else {
          if (!isCurrent()) return;
          lane.opened = true;
          resolve();
        }
      };
      socket.on("open", () => { if (isCurrent() && !lane.intentionalClose) finish(); });
      socket.on("error", () => { if (isCurrentAttempt()) finish(new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection could not be established.", true)); });
      socket.on("close", () => { if (isCurrentAttempt()) finish(new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection closed unexpectedly.", true)); });
    });
  }

  #bind(lane: LaneSession, socket: PalabraWebSocketLike, socketEpoch: number): void {
    const isCurrent = (): boolean => lane.socket === socket && lane.socketEpoch === socketEpoch && !lane.closed;
    socket.on("message", (raw) => {
      if (!isCurrent() || lane.intentionalClose) return;
      try {
        if (isOversizedPalabraWirePayload(raw)) {
          this.#rejectOversizedPayload(lane, socket);
          return;
        }
        const envelope = parseEnvelope(raw);
        if (!envelope) {
          if (lane.turn?.lifecycle === "active") this.#enqueue(lane.turn, this.#error(lane.turn.context, "PALABRA_INVALID_PAYLOAD", "The translation service returned an invalid message.", true));
          return;
        }
        this.#dispatch(lane, envelope);
      } catch (error: unknown) {
        // A malformed provider object must only take down its own lane. Keep
        // parser/dispatch details out of relay-facing errors.
        if (error instanceof PalabraPayloadTooLargeError) this.#rejectOversizedPayload(lane, socket);
        else this.#rejectMessageException(lane, socket);
      }
    });
    socket.on("error", () => {
      if (isCurrent() && !lane.intentionalClose) {
        lane.closed = true; lane.prepared = false;
        this.#failLane(lane, "PALABRA_CONNECTION", "The translation service connection failed.", true);
        if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
        try { socket.close(1011, "connection error"); } catch { /* best effort */ }
      }
    });
    socket.on("close", () => {
      if (!isCurrent() || lane.intentionalClose) return;
      lane.closed = true; lane.prepared = false;
      this.#failLane(lane, "PALABRA_CONNECTION", "The translation service connection closed unexpectedly.", true);
      if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    });
  }

  #rejectOversizedPayload(lane: LaneSession, socket: PalabraWebSocketLike): void {
    if (lane.closed) return;
    lane.closed = true;
    lane.prepared = false;
    this.#failLane(lane, "PALABRA_PAYLOAD_TOO_LARGE", "The translation service returned an oversized message.", false);
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    try { socket.close(1009, "payload too large"); } catch { /* best effort */ }
  }

  #rejectMessageException(lane: LaneSession, socket: PalabraWebSocketLike): void {
    if (lane.closed) return;
    lane.closed = true;
    lane.prepared = false;
    this.#failLane(lane, "PALABRA_INVALID_PAYLOAD", "The translation service returned an invalid message.", true);
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    try { socket.close(1008, "invalid message"); } catch { /* best effort */ }
  }

  #enqueue(turn: Turn, event: TranslationEvent): QueueWriteResult {
    const result = turn.queue.push(event);
    if (result.overflowed && !turn.queueFailureInProgress) this.#rejectProviderEventQueue(turn.lane);
    return result;
  }

  #upsertQueuedEvent(
    turn: Turn,
    event: TranslationEvent,
    matches: (current: TranslationEvent) => boolean,
  ): QueueWriteResult {
    const result = turn.queue.upsert(event, matches);
    if (result.overflowed && !turn.queueFailureInProgress) this.#rejectProviderEventQueue(turn.lane);
    return result;
  }

  #replaceQueuedEvent(turn: Turn, event: TranslationEvent): void {
    turn.queue.replaceWith(event);
  }

  #rejectProviderEventQueue(lane: LaneSession): void {
    if (lane.closed) return;
    lane.closed = true;
    lane.prepared = false;
    const turn = lane.turn;
    if (turn && turn.lifecycle === "active") {
      this.#failLane(lane, "PALABRA_EVENT_QUEUE_LIMIT", "The Palabra provider event queue limit was exceeded.", true);
    } else if (turn && turn.lifecycle === "completed") {
      turn.lifecycle = "failed";
      if (turn.hardTimer) clearTimeout(turn.hardTimer);
      if (turn.completionTimer) clearTimeout(turn.completionTimer);
      this.#stopInput(turn);
      const failure = this.#error(turn.context, "PALABRA_EVENT_QUEUE_LIMIT", "The Palabra provider event queue limit was exceeded.", true);
      this.#replaceQueuedEvent(turn, failure);
      turn.queue.end();
    }
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    try { lane.socket?.close(1008, "event queue limit"); } catch { /* best effort */ }
  }

  #dispatch(lane: LaneSession, envelope: Envelope): void {
    const data = envelope.data;
    if (envelope.type === "current_task") {
      this.#resolveTask(lane, data.task_status === "running" ? "running" : "not_found");
      return;
    }
    if (envelope.type === "error") {
      const code = typeof data.code === "string" ? data.code : "";
      if (lane.preparePromise && code === "NOT_FOUND") { this.#resolveTask(lane, "not_found"); return; }
      const providerError = new PalabraAdapterError(
        "PALABRA_PROVIDER_ERROR",
        "Palabra provider error.",
        true,
        providerStatusEvidenceRef("error", code),
      );
      if (lane.preparePromise) {
        lane.preparationError = providerError;
        this.#rejectTaskWaiters(lane, providerError);
        return;
      }
      this.#resolveTask(lane, "other");
      if (lane.turn?.lifecycle === "active") {
        this.#failTurn(lane.turn, providerError.code, providerError.message, providerError.retryable, providerError.evidenceRef);
      }
      return;
    }
    if (envelope.type === "warning") {
      if (lane.turn?.lifecycle === "active" && lane.turn.acceptEvents) {
        const code = typeof data.code === "string" ? data.code : "";
        this.#enqueue(lane.turn, this.#error(lane.turn.context, "PALABRA_PROVIDER_WARNING", "Palabra provider warning.", true, providerStatusEvidenceRef("warning", code)));
      }
      return;
    }
    const turn = lane.turn;
    if (!turn || turn.lifecycle !== "active" || !turn.acceptEvents) return;
    if (!this.#validateProviderEvent(lane, turn, data)) return;
    if (envelope.type === "partial_transcription") {
      if (turn.context.behavior.transcriptPolicy === "provisional_revisions" && this.#acceptTranscriptEvent(lane, turn, data)) {
        this.#transcript(turn, data, false, "provisional");
      }
    } else if (envelope.type === "partial_translated_transcription") {
      if (turn.context.behavior.transcriptPolicy === "provisional_revisions" && this.#acceptTranslatedEvent(lane, turn, data)) {
        this.#transcript(turn, data, true, "provisional");
      }
    } else if (envelope.type === "validated_transcription") {
      const providerId = providerEventId(data);
      if (!providerId) {
        this.#unknownIdentityDiagnostic(turn, data);
        return;
      }
      if (providerId && lane.retiredProviderIds.has(providerId)) {
        this.#tombstoneDiagnostic(turn, data);
        return;
      }
      turn.sawValidated = true;
      if (!this.#rememberProviderId(lane, turn, providerId)) return;
      turn.validatedProviderIds.add(providerId);
      this.#transcript(turn, data, false, "final");
    } else if (envelope.type === "translated_transcription") {
      if (this.#acceptTranslatedEvent(lane, turn, data)) this.#transcript(turn, data, true, "final");
    } else if (envelope.type === "output_audio_data") {
      if (this.#acceptAudioEvent(lane, turn, data)) this.#audio(turn, data);
    }
  }

  #resolveTask(lane: LaneSession, status: "running" | "not_found" | "other"): void {
    lane.taskWaiters.shift()?.resolve(status);
  }

  #acceptTranscriptEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    if (!providerId) {
      this.#unknownIdentityDiagnostic(turn, data);
      return false;
    }
    if (providerId && lane.retiredProviderIds.has(providerId)) {
      this.#tombstoneDiagnostic(turn, data);
      return false;
    }
    return this.#rememberProviderId(lane, turn, providerId);
  }

  #acceptTranslatedEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    if (!providerId) {
      this.#unknownIdentityDiagnostic(turn, data);
      return false;
    }
    if (providerId && lane.retiredProviderIds.has(providerId)) {
      this.#tombstoneDiagnostic(turn, data);
      return false;
    }
    if (turn.context.behavior.transcriptPolicy === "final_only") {
      if (!turn.sawValidated || !turn.validatedProviderIds.has(providerId)) {
        this.#unknownIdentityDiagnostic(turn, data);
        return false;
      }
    }
    return this.#rememberProviderId(lane, turn, providerId);
  }

  #acceptAudioEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    // An output packet with no stable provider ID cannot be fenced after flush.
    // Keep local playout safe rather than risk replaying stale speech.
    if (!providerId) {
      this.#unknownIdentityDiagnostic(turn, data);
      return false;
    }
    if (lane.retiredProviderIds.has(providerId)) {
      this.#tombstoneDiagnostic(turn, data);
      return false;
    }
    if (turn.context.behavior.transcriptPolicy === "final_only" && !turn.validatedProviderIds.has(providerId)) {
      this.#unknownIdentityDiagnostic(turn, data);
      return false;
    }
    return this.#rememberProviderId(lane, turn, providerId);
  }

  #validateProviderEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const transcription = asRecord(data.transcription);
    const candidateIds = [
      scalarId(transcription?.transcription_id),
      scalarId(data.transcription_id),
      scalarId(transcription?.translation_part_id),
      scalarId(data.translation_part_id),
    ];
    for (const providerId of candidateIds) {
      if (providerId !== undefined && utf8Bytes(providerId) > MAX_PROVIDER_EVENT_ID_BYTES) {
        this.#rejectProviderEventQueue(lane);
        return false;
      }
    }
    const text = typeof transcription?.text === "string"
      ? transcription.text
      : typeof data.text === "string" ? data.text : undefined;
    if (text !== undefined && utf8Bytes(text) > MAX_PROVIDER_EVENT_TEXT_BYTES) {
      this.#rejectProviderEventQueue(lane);
      return false;
    }
    return turn.lifecycle === "active" && !lane.closed;
  }

  #rememberProviderId(lane: LaneSession, turn: Turn, providerId: string): boolean {
    if (turn.providerIds.has(providerId)) return true;
    if (turn.providerIds.size >= MAX_TURN_PROVIDER_IDS) {
      this.#rejectProviderEventQueue(lane);
      return false;
    }
    turn.providerIds.add(providerId);
    return true;
  }

  #transcript(
    turn: Turn,
    data: Record<string, unknown>,
    target: boolean,
    finality: TranslationEvent["finality"],
  ): void {
    const transcription = asRecord(data.transcription) ?? data;
    const text = typeof transcription.text === "string" ? transcription.text : "";
    const segment = this.#segment(turn, data, target);
    if (!segment || turn.lifecycle !== "active") return;
    if (segment.finality === "final") return;
    if (segment.text === text && segment.finality === finality) return;
    segment.text = text;
    segment.finality = finality;
    segment.revision += 1;
    if (text) {
      const event: TranslationEvent = {
        kind: target ? "target_transcript" : "source_transcript",
        sessionId: turn.context.sessionId,
        lane: turn.context.lane,
        generation: turn.context.generation,
        turnId: turn.context.turnId,
        segmentId: segment.segmentId,
        revision: segment.revision,
        finality,
        evidenceRef: providerEvidenceRef(data) ?? adapterEvidenceRef(
          turn.context,
          "transcript",
          segment.segmentId + ":" + segment.revision,
        ),
        emittedAtMs: this.#now(),
        text,
      };
      const result = finality === "provisional"
        ? this.#upsertQueuedEvent(turn, event, (current) =>
          current.kind === event.kind && current.segmentId === segment.segmentId && current.finality === "provisional",
        )
        : this.#enqueue(turn, event);
      if (result.overflowed) return;
      if (target) segment.emittedRevision = segment.revision;
    } else if (target) {
      // Do not let audio attach to a prior target revision when the provider
      // sends an empty replacement for which no transcript event was emitted.
      segment.emittedRevision = undefined;
    }
    if (target && finality === "final") {
      turn.sawFinalTarget = true;
      this.#maybeComplete(turn);
    }
  }

  #segment(turn: Turn, data: Record<string, unknown>, target: boolean): SegmentState | undefined {
    const key = providerSegmentKey(data, target);
    const existing = turn.segments.get(key);
    if (existing) return existing;
    if (turn.segments.size >= MAX_TURN_SEGMENTS) {
      this.#rejectProviderEventQueue(turn.lane);
      return undefined;
    }
    const segment: SegmentState = {
      segmentId: turn.context.turnId + ":segment:" + turn.nextSegmentId++,
      revision: -1,
      emittedRevision: undefined,
      text: "",
      finality: "provisional",
    };
    turn.segments.set(key, segment);
    return segment;
  }

  #audio(turn: Turn, data: Record<string, unknown>): void {
    // Audio is only safe to expose when the provider packet maps to an
    // already-known target transcript segment.  Never manufacture a target
    // identity from the audio segment/sequence itself: provider IDs and
    // translation-part IDs are the correlation contract at this seam.
    const targetSegment = targetSegmentForAudio(turn, data);
    if (targetSegment === undefined) {
      this.#unknownIdentityDiagnostic(turn, data);
      return;
    }
    if (typeof data.data !== "string") {
      this.#enqueue(turn, this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned invalid audio.", true));
      return;
    }
    let bytes: Uint8Array;
    try { bytes = decodePcm(data.data); }
    catch { this.#enqueue(turn, this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned invalid audio.", true)); return; }
    const evidenceRef = providerEvidenceRef(data) ?? adapterEvidenceRef(
      turn.context,
      "audio",
      "packet:" + turn.nextAudioSegmentId,
    );
    if (
      turn.pendingAudio.byteLength > 0 &&
      (turn.pendingAudioTargetSegmentId !== targetSegment.segmentId ||
        turn.pendingAudioTargetRevision !== targetSegment.emittedRevision)
    ) {
      // A provider target switch with a partial PCM buffer is ambiguous. Drop
      // the partial bytes rather than pad or attribute them to the new target.
      turn.pendingAudio = new Uint8Array(0);
      turn.pendingAudioTargetSegmentId = undefined;
      turn.pendingAudioTargetRevision = undefined;
      this.#unknownIdentityDiagnostic(turn, data);
      return;
    }
    if (turn.pendingAudio.byteLength === 0) {
      turn.pendingAudioTargetSegmentId = targetSegment.segmentId;
      turn.pendingAudioTargetRevision = targetSegment.emittedRevision;
    }
    turn.pendingAudio = join(turn.pendingAudio, bytes);
    while (turn.pendingAudio.byteLength >= CANONICAL_AUDIO.bytesPerFrame) {
      const finality = data.last_chunk === true && turn.pendingAudio.byteLength === CANONICAL_AUDIO.bytesPerFrame
        ? "final"
        : "provisional";
      this.#emitAudio(
        turn,
        turn.pendingAudio.slice(0, CANONICAL_AUDIO.bytesPerFrame),
        finality,
        evidenceRef,
        turn.pendingAudioTargetSegmentId,
        turn.pendingAudioTargetRevision,
      );
      turn.pendingAudio = turn.pendingAudio.slice(CANONICAL_AUDIO.bytesPerFrame);
      if (turn.pendingAudio.byteLength === 0) {
        turn.pendingAudioTargetSegmentId = undefined;
        turn.pendingAudioTargetRevision = undefined;
      }
    }
    if (data.last_chunk === true) {
      turn.sawLastAudio = true;
      this.#flushAudio(turn, "final", evidenceRef);
      this.#maybeComplete(turn);
    }
  }

  #emitAudio(
    turn: Turn,
    pcm: Uint8Array,
    finality: TranslationEvent["finality"],
    evidenceRef: string,
    targetSegmentId: string | undefined,
    targetRevision: number | undefined,
  ): void {
    if (
      targetSegmentId === undefined ||
      targetSegmentId.trim() === "" ||
      targetRevision === undefined ||
      !Number.isSafeInteger(targetRevision) ||
      targetRevision < 0
    ) return;
    const now = this.#now();
    const capturedAtMs = Math.max(Number.isFinite(now) && now >= 0 ? now : 0, turn.lastCapturedAtMs);
    turn.lastCapturedAtMs = capturedAtMs;
    const sequence = this.#playoutSequences.next(turn.context);
    const result = this.#enqueue(turn, {
      kind: "audio",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":audio:" + turn.nextAudioSegmentId++,
      targetSegmentId,
      revision: targetRevision,
      finality,
      evidenceRef,
      emittedAtMs: capturedAtMs,
      playoutSequence: sequence,
      frame: createAudioFrame({ sessionId: turn.context.sessionId, lane: turn.context.lane, generation: turn.context.generation, sequence, capturedAtMs, pcm16le: pcm }),
    });
    if (result.overflowed) return;
    if (result.droppedOldestAudio) {
      turn.droppedAudioFrames += 1;
      this.#upsertQueuedEvent(turn, this.#queueTrimMetric(turn, "provisional"), (event) =>
        event.kind === "error" && event.segmentId === turn.context.turnId + ":local-audio-queue",
      );
    }
  }

  #queueTrimMetric(turn: Turn, finality: TranslationEvent["finality"]): TranslationErrorEvent {
    return {
      kind: "error",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":local-audio-queue",
      revision: turn.droppedAudioFrames - 1 + (finality === "final" ? 1 : 0),
      finality,
      evidenceRef: adapterEvidenceRef(
        turn.context,
        "local-audio-queue",
        String(turn.droppedAudioFrames) + ":" + finality,
      ),
      emittedAtMs: this.#now(),
      error: {
        code: "PALABRA_LOCAL_AUDIO_QUEUE_TRIMMED",
        message: "Dropped " + turn.droppedAudioFrames + " queued audio frame(s) to honor the " + turn.context.behavior.maxBufferedAudioMs + " ms local playout budget.",
        retryable: true,
      },
    };
  }

  #finalizeQueueTrimMetric(turn: Turn): void {
    if (turn.droppedAudioFrames === 0 || turn.queueTrimMetricFinal) return;
    turn.queueTrimMetricFinal = true;
    this.#upsertQueuedEvent(turn, this.#queueTrimMetric(turn, "final"), (event) =>
      event.kind === "error" && event.segmentId === turn.context.turnId + ":local-audio-queue",
    );
  }

  #tombstoneDiagnostic(turn: Turn, data: Record<string, unknown>): void {
    const evidenceRef = providerEvidenceRef(data);
    if (evidenceRef === undefined) return;
    this.#diagnostic(turn, "adapter_tombstone", evidenceRef);
  }

  #unknownIdentityDiagnostic(turn: Turn, data: Record<string, unknown>): void {
    this.#diagnostic(
      turn,
      "unknown_identity",
      providerEvidenceRef(data) ?? providerEnvelopeEvidenceRef(turn.context, data),
    );
  }

  #diagnostic(
    turn: Turn,
    reason: "adapter_tombstone" | "unknown_identity",
    evidenceRef: string,
  ): void {
    this.#enqueue(turn, {
      kind: "diagnostic",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":diagnostic:adapter-tombstone:" + turn.nextDiagnosticId++,
      revision: 0,
      finality: "final",
      evidenceRef,
      emittedAtMs: this.#now(),
      reason,
    });
  }

  #flushAudio(
    turn: Turn,
    finality: TranslationEvent["finality"],
    evidenceRef = adapterEvidenceRef(turn.context, "audio", "flush:" + turn.nextAudioSegmentId),
  ): void {
    if (!turn.pendingAudio.byteLength) return;
    if (turn.pendingAudio.byteLength % 2) {
      this.#enqueue(turn, this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned an incomplete PCM16 sample.", true));
      turn.pendingAudio = new Uint8Array(0);
      turn.pendingAudioTargetSegmentId = undefined;
      turn.pendingAudioTargetRevision = undefined;
      return;
    }
    const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
    pcm.set(turn.pendingAudio);
    const targetSegmentId = turn.pendingAudioTargetSegmentId;
    const targetRevision = turn.pendingAudioTargetRevision;
    turn.pendingAudio = new Uint8Array(0);
    turn.pendingAudioTargetSegmentId = undefined;
    turn.pendingAudioTargetRevision = undefined;
    this.#emitAudio(turn, pcm, finality, evidenceRef, targetSegmentId, targetRevision);
  }

  async #pumpInput(lane: LaneSession, turn: Turn, request: TranslationRequest): Promise<void> {
    if (request.signal.aborted || turn.lifecycle !== "active") return;
    const iterator = request.frames[Symbol.asyncIterator]();
    turn.inputIterator = iterator;
    let natural = false;
    let frameCount = 0;
    let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    try {
      while (!request.signal.aborted && turn.lifecycle === "active") {
        const next = await Promise.race<IteratorResult<AudioFrame> | undefined>([Promise.resolve(iterator.next()), turn.inputStopPromise.then(() => undefined)]);
        if (!next) return;
        if (next.done) { natural = true; break; }
        const inputFrame = next.value;
        frameCount += 1;
        if (frameCount % 16 === 0) await wait(0);
        if (!validFrame(inputFrame, turn.context) || (turn.lastInputSequence !== undefined && inputFrame.sequence <= turn.lastInputSequence) || (turn.lastInputCapturedAtMs !== undefined && inputFrame.capturedAtMs < turn.lastInputCapturedAtMs)) {
          this.#failTurn(turn, "PALABRA_INPUT_FORMAT", "An audio frame was not canonical 24 kHz mono PCM16.", false);
          return;
        }
        turn.lastInputSequence = inputFrame.sequence;
        turn.lastInputCapturedAtMs = inputFrame.capturedAtMs;
        buffer = join(buffer, next.value.pcm16le);
        while (buffer.byteLength >= FIXED_INPUT_CHUNK_BYTES && turn.lifecycle === "active") {
          await this.#sendInput(lane, turn, buffer.slice(0, FIXED_INPUT_CHUNK_BYTES));
          buffer = buffer.slice(FIXED_INPUT_CHUNK_BYTES);
        }
      }
    } catch {
      if (turn.lifecycle === "active") this.#failTurn(turn, "PALABRA_INPUT", "The translation audio stream failed.", false);
      return;
    } finally {
      if (natural) turn.inputIterator = undefined;
      else this.#returnIterator(turn, iterator);
    }
    if (!natural || turn.lifecycle !== "active" || request.signal.aborted) return;
    if (buffer.byteLength) {
      const chunk = new Uint8Array(FIXED_INPUT_CHUNK_BYTES);
      chunk.set(buffer);
      await this.#sendInput(lane, turn, chunk);
    }
    if (turn.lifecycle !== "active" || request.signal.aborted) return;
    await this.#sendInput(lane, turn, new Uint8Array(FIXED_INPUT_CHUNK_BYTES));
    if (turn.lifecycle !== "active" || request.signal.aborted) return;
    turn.inputFinished = true;
    this.#maybeComplete(turn);
  }

  async #sendInput(lane: LaneSession, turn: Turn, pcm: Uint8Array<ArrayBufferLike>): Promise<void> {
    if (turn.lifecycle !== "active" || !lane.socket || lane.closed) return;
    if (pcm.byteLength !== FIXED_INPUT_CHUNK_BYTES) {
      this.#failTurn(turn, "PALABRA_INPUT_FORMAT", "Audio must contain one fixed 320 ms PCM16 chunk.", false);
      return;
    }
    const now = this.#now();
    if (turn.lastInputSentAtMs !== undefined && Number.isFinite(now)) {
      const waitMs = FIXED_INPUT_CHUNK_MS - Math.max(0, now - turn.lastInputSentAtMs);
      if (waitMs > 0) {
        const paced = await Promise.race([
          this.#sleep(waitMs).then(() => true),
          turn.inputStopPromise.then(() => false),
        ]);
        if (!paced) return;
      }
    }
    if (turn.signal.aborted || turn.lifecycle !== "active" || lane.turn !== turn || lane.closed || !lane.socket) return;
    turn.lastInputSentAtMs = this.#now();
    try { turn.acceptEvents = true; this.#send(lane, { message_type: "input_audio_data", data: { data: Buffer.from(pcm).toString("base64") } }); }
    catch { this.#failTurn(turn, "PALABRA_CONNECTION", "The translation service could not accept audio.", true); }
  }

  #newTurn(lane: LaneSession, context: LaneContext, signal: AbortSignal): Turn {
    this.#acceptGeneration(lane, context);
    let wakeInputStop = (): void => undefined;
    const inputStopPromise = new Promise<void>((resolve) => { wakeInputStop = resolve; });
    let turn!: Turn;
    const abortListener = (): void => { if (turn.lifecycle === "active") void this.#cancelTurn(lane, turn); };
    turn = { lane, context, queue: new EventQueue(maximumBufferedAudioFrames(context.behavior)), segments: new Map(), providerIds: new Set(), validatedProviderIds: new Set(), abortListener, acceptEvents: false, sawValidated: false, nextSegmentId: 0, nextAudioSegmentId: 0, nextDiagnosticId: 0, droppedAudioFrames: 0, queueTrimMetricFinal: false, queueFailureInProgress: false, signal, inputStopPromise, wakeInputStop, lifecycle: "active", inputStopped: false, inputIterator: undefined, inputReturnRequested: false, lastInputSequence: undefined, lastInputCapturedAtMs: undefined, lastInputSentAtMs: undefined, pendingAudio: new Uint8Array(0), pendingAudioTargetSegmentId: undefined, pendingAudioTargetRevision: undefined, lastCapturedAtMs: 0, sawFinalTarget: false, sawLastAudio: false, inputFinished: false, completionTimer: undefined, hardTimer: undefined };
    turn.hardTimer = setTimeout(() => { if (turn.lifecycle === "active") this.#failTurn(turn, "PALABRA_TURN_TIMEOUT", "The translation service timed out while finishing the turn.", true); }, this.#turnMs);
    signal.addEventListener("abort", abortListener, { once: true });
    return turn;
  }

  #maybeComplete(turn: Turn): void {
    if (turn.lifecycle !== "active" || !turn.inputFinished || !turn.sawFinalTarget || !turn.sawLastAudio || turn.completionTimer) return;
    turn.completionTimer = setTimeout(() => this.#completeTurn(turn), this.#settleMs);
  }

  #completeTurn(turn: Turn): void {
    if (turn.lifecycle !== "active") return;
    turn.lifecycle = "completed";
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    this.#flushAudio(turn, "final");
    this.#finalizeQueueTrimMetric(turn);
    this.#enqueue(turn, {
      kind: "completed",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":completed",
      revision: 0,
      finality: "final",
      evidenceRef: adapterEvidenceRef(turn.context, "completed", "0"),
      emittedAtMs: this.#now(),
    });
    turn.queue.end();
  }

  #failTurn(turn: Turn, code: string, message: string, retryable: boolean, evidenceRef?: string): void {
    if (turn.lifecycle !== "active") return;
    turn.lifecycle = "failed";
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    this.#stopInput(turn);
    this.#finalizeQueueTrimMetric(turn);
    const failure = this.#error(turn.context, code, message, retryable, evidenceRef);
    turn.queueFailureInProgress = true;
    const result = this.#enqueue(turn, failure);
    if (result.overflowed) this.#replaceQueuedEvent(turn, failure);
    turn.queueFailureInProgress = false;
    turn.queue.end();
  }

  #rejectTaskWaiters(lane: LaneSession, error: unknown): void {
    for (const waiter of lane.taskWaiters.splice(0)) waiter.reject(error);
  }

  #failLane(lane: LaneSession, code: string, message: string, retryable: boolean): void {
    if (lane.turn) this.#failTurn(lane.turn, code, message, retryable);
    for (const waiter of lane.taskWaiters.splice(0)) waiter.reject(new PalabraAdapterError(code, message, retryable));
  }

  async #cancelTurn(lane: LaneSession, turn: Turn): Promise<void> {
    if (turn.lifecycle !== "active") { this.#cleanupTurn(lane, turn); return; }
    turn.lifecycle = "cancelled";
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    this.#stopInput(turn);
    this.#finalizeQueueTrimMetric(turn);
    turn.queue.end();
    let flushed = false;
    if (lane.socket && !lane.closed) {
      try { this.#send(lane, { message_type: "flush_task", data: { languages: ["global"], pause_task: false } }); flushed = true; } catch { /* reconnect below */ }
    }
    if (!flushed) {
      if (lane.closed) return;
      lane.closed = true;
      lane.prepared = false;
      await this.#closeLane(lane, { remove: true, graceful: false });
      return;
    }
    this.#retireTurnIds(lane, turn);
    if (lane.turn === turn) lane.turn = undefined;
  }

  #retireTurnIds(lane: LaneSession, turn: Turn): void {
    for (const providerId of turn.providerIds) {
      if (lane.retiredProviderIds.has(providerId)) continue;
      lane.retiredProviderIds.add(providerId);
      lane.retiredProviderIdOrder.push(providerId);
    }
    while (lane.retiredProviderIdOrder.length > MAX_RETIRED_PROVIDER_IDS) {
      const expired = lane.retiredProviderIdOrder.shift();
      if (expired !== undefined) lane.retiredProviderIds.delete(expired);
    }
  }

  async #closeLane(lane: LaneSession, options: CloseLaneOptions = { graceful: true }): Promise<void> {
    if (lane.closePromise) return await lane.closePromise;
    const operation = (async (): Promise<void> => {
      lane.intentionalClose = true;
      if (lane.turn?.lifecycle === "active") { lane.turn.lifecycle = "cancelled"; this.#stopInput(lane.turn); this.#finalizeQueueTrimMetric(lane.turn); lane.turn.queue.end(); }
      const socket = lane.socket;
       if (!socket) { lane.closed = true; lane.prepared = false; if (options.remove && this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key); return; }
       if (options.graceful && lane.opened && !lane.closed) {
        try { this.#send(lane, { message_type: "end_task", data: { eos_timeout: this.#eosSec, force: false } }); } catch { /* best effort */ }
      }
       if (options.graceful) await wait(this.#closeMs);
      try { socket.close(1000, "client close"); } catch { /* best effort */ }
      lane.closed = true; lane.prepared = false; lane.opened = false; lane.socket = undefined;
       if (options.remove && this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    })();
    lane.closePromise = operation;
    try { await operation; } finally { if (lane.closePromise === operation) lane.closePromise = undefined; }
  }

  #cleanupTurn(lane: LaneSession, turn: Turn): void {
    if (lane.turn === turn && turn.lifecycle !== "active") lane.turn = undefined;
    this.#retireTurnIds(lane, turn);
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    this.#stopInput(turn);
    turn.signal.removeEventListener("abort", turn.abortListener);
  }

  #stopInput(turn: Turn): void {
    if (turn.inputStopped) return;
    turn.inputStopped = true;
    turn.wakeInputStop();
    if (turn.inputIterator) this.#returnIterator(turn, turn.inputIterator);
  }

  #returnIterator(turn: Turn, iterator: AsyncIterator<AudioFrame>): void {
    if (turn.inputIterator === iterator) turn.inputIterator = undefined;
    if (turn.inputReturnRequested) return;
    turn.inputReturnRequested = true;
    try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* best effort */ }
  }

  #send(lane: LaneSession, message: unknown): void {
    const socket = lane.socket;
    if (!socket || lane.closed) throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection is unavailable.", true);
    const payload = JSON.stringify(message);
    const bufferedAmount = socket.bufferedAmount;
    if (!Number.isFinite(bufferedAmount) || bufferedAmount < 0 || bufferedAmount + Buffer.byteLength(payload, "utf8") > MAX_PALABRA_WIRE_PAYLOAD_BYTES) {
      this.#rejectOutboundBackpressure(lane, socket);
      throw new PalabraAdapterError("PALABRA_OUTBOUND_BACKPRESSURE", "The Palabra outbound buffer limit was exceeded.", true);
    }
    try { socket.send(payload); }
    catch {
      this.#rejectSendFailure(lane, socket);
      throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection failed.", true);
    }
  }

  #rejectSendFailure(lane: LaneSession, socket: PalabraWebSocketLike): void {
    if (lane.socket !== socket) return;
    lane.socket = undefined;
    lane.socketEpoch += 1;
    lane.opened = false;
    lane.closed = true;
    lane.intentionalClose = true;
    lane.prepared = false;
    this.#failLane(lane, "PALABRA_CONNECTION", "The translation service connection failed.", true);
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    try { socket.close(1011, "connection error"); } catch { /* best effort */ }
  }

  #rejectOutboundBackpressure(lane: LaneSession, socket: PalabraWebSocketLike): void {
    if (lane.closed) return;
    lane.closed = true;
    lane.prepared = false;
    this.#failLane(lane, "PALABRA_OUTBOUND_BACKPRESSURE", "The Palabra outbound buffer limit was exceeded.", true);
    if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    try { socket.close(1008, "outbound buffer limit"); } catch { /* best effort */ }
  }

  #lane(context: LaneContext): LaneSession {
    const key = laneKey(context);
    const existing = this.#lanes.get(key);
    if (existing && !existing.closed) return existing;
    const lane: LaneSession = { key, sessionId: context.sessionId, lane: context.lane, socket: undefined, socketEpoch: 0, opened: false, closed: false, intentionalClose: false, prepared: false, preparePromise: undefined, taskWaiters: [], turn: undefined, closePromise: undefined, context: undefined, preparationError: undefined, retiredProviderIds: new Set(), retiredProviderIdOrder: [], playoutGeneration: undefined };
    this.#lanes.set(key, lane);
    return lane;
  }

  #acceptGeneration(lane: LaneSession, context: LaneContext): void {
    if (lane.playoutGeneration !== undefined && context.generation <= lane.playoutGeneration) return;
    this.#playoutSequences.clearBefore(context);
    lane.playoutGeneration = context.generation;
  }

  #error(context: LaneContext, code: string, message: string, retryable: boolean, evidenceRef?: string): TranslationErrorEvent {
    return {
      kind: "error",
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      segmentId: context.turnId + ":error:" + safeCode(code),
      revision: 0,
      finality: "final",
      evidenceRef: evidenceRef ?? adapterEvidenceRef(context, "error", safeCode(code)),
      emittedAtMs: this.#now(),
      error: { code, message, retryable },
    };
  }
}

function defaultFactory(url: string, options: PalabraWebSocketConnectOptions): PalabraWebSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
    maxPayload: options.maxPayload,
    perMessageDeflate: options.perMessageDeflate,
  }) as unknown as PalabraWebSocketLike;
}
function canonicalPalabraEndpoint(value: string): string {
  if (value.split(PALABRA_HASH_PLACEHOLDER).length !== 2) {
    throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra socket route must contain exactly one literal {hash} placeholder.", false);
  }
  const candidate = value.replace(PALABRA_HASH_PLACEHOLDER, PALABRA_ROUTE_HASH_SENTINEL);
  let endpoint: URL;
  try {
    endpoint = new URL(candidate);
  } catch {
    throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra socket route must be a canonical WSS URL.", false);
  }
  if (
    endpoint.protocol !== "wss:" ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    endpoint.toString() !== candidate ||
    endpoint.pathname.split("/").filter((segment) => segment === PALABRA_ROUTE_HASH_SENTINEL).length !== 1
  ) {
    throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra socket route must be a canonical WSS URL with a {hash} path segment.", false);
  }
  return value;
}
function hashFactory(value: string | (() => string) | undefined): () => string {
  if (typeof value === "function") return value;
  if (typeof value === "string") return () => value;
  return () => randomBytes(16).toString("hex");
}
function laneKey(ref: GenerationRef): string { return ref.sessionId + "\u0000" + ref.lane; }
function sameTask(
  current: PreparedTask | undefined,
  next: Pick<LaneContext, "sourceLanguage" | "targetLanguage" | "behavior">,
): boolean {
  return current !== undefined &&
    current.sourceLanguage === next.sourceLanguage &&
    current.targetLanguage === next.targetLanguage &&
    current.behaviorVersion === next.behavior.version &&
    current.mode === next.behavior.mode;
}
function positiveMs(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new PalabraAdapterError("PALABRA_CONFIGURATION", field + " must be a positive whole number of milliseconds.", false);
  return value;
}
function nonNegativeMs(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2147483647) throw new PalabraAdapterError("PALABRA_CONFIGURATION", field + " must be a non-negative whole number of milliseconds.", false);
  return value;
}
function assertPalabraContext(context: LaneContext): void {
  try {
    assertTranslationBehaviorCapability(PALABRA_TRANSLATION_CAPABILITIES, context.behavior, {
      glossaryRequested: context.glossary !== undefined,
    });
  } catch (error: unknown) {
    if (context.glossary !== undefined) {
      throw new PalabraAdapterError(
        "PALABRA_GLOSSARY_UNSUPPORTED",
        "Palabra account glossaries cannot represent the pinned local glossary.",
        false,
      );
    }
    throw new PalabraAdapterError(
      "PALABRA_CONFIGURATION",
      error instanceof Error ? error.message : "Palabra configuration is invalid.",
      false,
    );
  }
}
const PALABRA_LANGUAGE_MAP: Readonly<Record<string, string>> = {
  "en-us": "en-us",
  "zh-tw": "zh-hant",
  "zh-cn": "zh-hans",
  "ja-jp": "ja",
  "ko-kr": "ko",
};
function mapPalabraLanguage(value: string): string {
  const trimmed = value.trim();
  return PALABRA_LANGUAGE_MAP[trimmed.toLowerCase()] ?? trimmed;
}
function taskConfig(source: string, target: string, behavior: TranslationBehavior): Record<string, unknown> {
  const settings = modeSettings(behavior);
  return {
    input_stream: { content_type: "audio", source: { type: "ws", format: "pcm_s16le", sample_rate: SAMPLE_RATE, channels: 1 } },
    output_stream: { content_type: "audio", target: { type: "ws", format: "pcm_s16le" } },
    pipeline: {
      transcription: {
        source_language: mapPalabraLanguage(source),
        segment_confirmation_silence_threshold: settings.confirmationMs / 1000,
        sentence_splitter: { enabled: settings.sentenceSplitter },
      },
      translations: [{ target_language: mapPalabraLanguage(target), translate_partial_transcriptions: settings.translatePartials, speech_generation: {} }],
      translation_queue_configs: {
        global: {
          desired_queue_level_ms: settings.desiredProviderQueueMs,
          max_queue_level_ms: settings.maxProviderQueueMs,
          auto_tempo: true,
          min_tempo: 1.15,
          max_tempo: 1.45,
        },
      },
      allowed_message_types: settings.allowedMessageTypes,
    },
  };
}
function modeSettings(behavior: TranslationBehavior): Readonly<{
  confirmationMs: number;
  sentenceSplitter: boolean;
  translatePartials: boolean;
  /** Palabra-managed TTS backlog, not the local playout budget. */
  desiredProviderQueueMs: number;
  maxProviderQueueMs: number;
  allowedMessageTypes: readonly string[];
}> {
  switch (behavior.mode) {
    case "fast":
      return {
        confirmationMs: 400,
        sentenceSplitter: true,
        translatePartials: true,
        desiredProviderQueueMs: 2000,
        maxProviderQueueMs: 5000,
        allowedMessageTypes: ["partial_transcription", "partial_translated_transcription", "validated_transcription", "translated_transcription", "output_audio_data"],
      };
    case "balanced":
      return {
        confirmationMs: BALANCED_CONFIRMATION_MS,
        sentenceSplitter: true,
        translatePartials: false,
        desiredProviderQueueMs: 5000,
        maxProviderQueueMs: 20000,
        allowedMessageTypes: ["validated_transcription", "translated_transcription", "output_audio_data"],
      };
    case "accurate":
      return {
        confirmationMs: 1200,
        sentenceSplitter: false,
        translatePartials: false,
        desiredProviderQueueMs: 10000,
        maxProviderQueueMs: 30000,
        allowedMessageTypes: ["validated_transcription", "translated_transcription", "output_audio_data"],
      };
  }
}
function maximumBufferedAudioFrames(behavior: TranslationBehavior): number {
  return Math.max(1, Math.floor(behavior.maxBufferedAudioMs / CANONICAL_AUDIO.frameDurationMs));
}
function isOversizedPalabraWirePayload(raw: unknown): boolean {
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8") > MAX_PALABRA_WIRE_PAYLOAD_BYTES;
  if (raw instanceof Uint8Array || raw instanceof ArrayBuffer) return raw.byteLength > MAX_PALABRA_WIRE_PAYLOAD_BYTES;
  if (!Array.isArray(raw)) return false;
  let byteLength = 0;
  for (const chunk of raw) {
    if (!(chunk instanceof Uint8Array)) return false;
    if (chunk.byteLength > MAX_PALABRA_WIRE_PAYLOAD_BYTES - byteLength) return true;
    byteLength += chunk.byteLength;
  }
  return false;
}
function parseEnvelope(raw: unknown): Envelope | null {
  const parsed = parseValue(raw);
  if (!record(parsed)) return null;
  const type = typeof parsed.message_type === "string" ? parsed.message_type : typeof parsed.type === "string" ? parsed.type : undefined;
  if (!type) return null;
  const dataValue = parseValue(parsed.data);
  return { type, data: record(dataValue) ? dataValue : typeof dataValue === "string" ? { data: dataValue } : {} };
}
function parseValue(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < MAX_PARSE_VALUE_UNWRAP_DEPTH; depth += 1) {
    if (typeof current === "string") {
      if (utf8Bytes(current) > MAX_PALABRA_WIRE_PAYLOAD_BYTES) throw new PalabraPayloadTooLargeError();
      try { current = JSON.parse(current) as unknown; continue; }
      catch { return current; }
    }
    if (current instanceof Uint8Array) {
      if (current.byteLength > MAX_PALABRA_WIRE_PAYLOAD_BYTES) throw new PalabraPayloadTooLargeError();
      current = Buffer.from(current).toString("utf8");
      continue;
    }
    if (current instanceof ArrayBuffer) {
      if (current.byteLength > MAX_PALABRA_WIRE_PAYLOAD_BYTES) throw new PalabraPayloadTooLargeError();
      current = Buffer.from(current).toString("utf8");
      continue;
    }
    if (Array.isArray(current)) {
      const chunks: Uint8Array[] = [];
      let byteLength = 0;
      for (const chunk of current) {
        if (!(chunk instanceof Uint8Array)) return current;
        if (chunk.byteLength > MAX_PALABRA_WIRE_PAYLOAD_BYTES - byteLength) {
          throw new PalabraPayloadTooLargeError();
        }
        chunks.push(chunk);
        byteLength += chunk.byteLength;
      }
      const joined = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.byteLength;
      }
      current = joined;
      continue;
    }
    if (record(current) && "data" in current && Object.keys(current).length === 1) {
      current = current.data;
      continue;
    }
    return current;
  }
  throw new Error("Palabra message nesting exceeds the supported depth.");
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return record(value) ? value : undefined; }
function scalarId(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function utf8Bytes(value: string): number { return Buffer.byteLength(value, "utf8"); }
function providerEventId(data: Record<string, unknown>): string | undefined {
  const transcription = asRecord(data.transcription);
  return scalarId(transcription?.transcription_id) ?? scalarId(data.transcription_id);
}
function providerEvidenceRef(data: Record<string, unknown>): string | undefined {
  const providerId = providerEventId(data);
  if (providerId === undefined || providerId.trim() === "") return undefined;
  return createOpaqueEvidenceRef("palabra:provider", ["provider", providerId]);
}
function providerStatusEvidenceRef(kind: "error" | "warning", code: string): string {
  return createOpaqueEvidenceRef("palabra:provider", ["provider-status", kind, safeCode(code)]);
}
function providerEnvelopeEvidenceRef(context: LaneContext, data: Record<string, unknown>): string {
  return adapterEvidenceRef(context, "provider-envelope", JSON.stringify(data));
}
function adapterEvidenceRef(context: LaneContext, kind: string, detail: string): string {
  return createOpaqueEvidenceRef("palabra:adapter", [
    "adapter",
    kind,
    context.sessionId,
    context.lane,
    context.generation,
    context.turnId,
    detail,
  ]);
}
function providerSegmentKey(data: Record<string, unknown>, target: boolean): string {
  const providerId = providerEventId(data);
  if (!providerId) return target ? "target\u0000fallback" : "source\u0000fallback";
  if (!target) return "source\u0000" + providerId;
  const partId = providerTranslationPartId(data) ?? "0";
  return "target\u0000" + providerId + "\u0000" + partId;
}

function providerTranslationPartId(data: Record<string, unknown>): string | undefined {
  const transcription = asRecord(data.transcription);
  return scalarId(transcription?.translation_part_id) ?? scalarId(data.translation_part_id);
}

/**
 * Resolve output audio to an existing target transcript segment using only
 * provider identity.  If a packet omits a translation-part ID, it is accepted
 * only when that provider currently has one unambiguous target segment; two
 * segments with the same provider ID are intentionally rejected.
 */
function targetSegmentForAudio(turn: Turn, data: Record<string, unknown>): SegmentState | undefined {
  const providerId = providerEventId(data);
  if (providerId === undefined) return undefined;
  const partId = providerTranslationPartId(data);
  if (partId !== undefined) {
    const segment = turn.segments.get("target\u0000" + providerId + "\u0000" + partId);
    return segment?.emittedRevision === undefined ? undefined : segment;
  }
  let match: SegmentState | undefined;
  const prefix = "target\u0000" + providerId + "\u0000";
  for (const [key, segment] of turn.segments) {
    if (!key.startsWith(prefix)) continue;
    if (match !== undefined) return undefined;
    if (segment.emittedRevision === undefined) return undefined;
    match = segment;
  }
  return match;
}
function safeCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return code || "UNKNOWN";
}
function decodePcm(encoded: string): Uint8Array {
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("invalid base64");
  const decoded = Uint8Array.from(Buffer.from(encoded, "base64"));
  if (!decoded.byteLength || decoded.byteLength % 2 || Buffer.from(decoded).toString("base64") !== encoded) throw new Error("invalid PCM16");
  return decoded;
}
function validFrame(frame: AudioFrame, context: LaneContext): boolean {
  return frame.sessionId === context.sessionId && frame.lane === context.lane && frame.generation === context.generation &&
    frame.format.encoding === CANONICAL_AUDIO.encoding && frame.format.sampleRateHz === SAMPLE_RATE && frame.format.channels === 1 && frame.format.frameDurationMs === CANONICAL_AUDIO.frameDurationMs && frame.format.samplesPerFrame === CANONICAL_AUDIO.samplesPerFrame && frame.format.bytesPerFrame === CANONICAL_AUDIO.bytesPerFrame && Number.isSafeInteger(frame.sequence) && frame.sequence >= 0 && Number.isFinite(frame.capturedAtMs) && frame.capturedAtMs >= 0 &&
    frame.pcm16le.byteLength === CANONICAL_AUDIO.bytesPerFrame;
}
function join(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  if (!left.byteLength) return Uint8Array.from(right);
  if (!right.byteLength) return Uint8Array.from(left);
  const value = new Uint8Array(left.byteLength + right.byteLength); value.set(left); value.set(right, left.byteLength); return value;
}
function wait(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }

class EventQueue implements AsyncIterable<TranslationEvent> {
  readonly #values: TranslationEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<TranslationEvent>) => void> = [];
  readonly #maxBufferedAudioFrames: number;
  #nonAudioBytes = 0;
  #nonAudioCount = 0;
  #ended = false;
  constructor(maxBufferedAudioFrames: number) {
    this.#maxBufferedAudioFrames = maxBufferedAudioFrames;
  }
  push(value: TranslationEvent): QueueWriteResult {
    if (this.#ended) return { droppedOldestAudio: false, overflowed: false };
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return { droppedOldestAudio: false, overflowed: false };
    }
    const droppedOldestAudio = value.kind === "audio" && this.#trimAudio();
    if (value.kind !== "audio") {
      const bytes = eventUtf8Bytes(value);
      if (bytes > MAX_QUEUED_PROVIDER_EVENT_BYTES ||
        this.#nonAudioCount >= MAX_QUEUED_PROVIDER_EVENTS ||
        this.#nonAudioBytes + bytes > MAX_QUEUED_PROVIDER_EVENT_BYTES) {
        return { droppedOldestAudio, overflowed: true };
      }
      this.#nonAudioBytes += bytes;
      this.#nonAudioCount += 1;
    }
    this.#values.push(value);
    return { droppedOldestAudio, overflowed: false };
  }
  upsert(value: TranslationEvent, matches: (current: TranslationEvent) => boolean): QueueWriteResult {
    if (this.#ended) return { droppedOldestAudio: false, overflowed: false };
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return { droppedOldestAudio: false, overflowed: false };
    }
    const index = this.#values.findIndex(matches);
    if (index >= 0) {
      const previous = this.#values[index];
      if (previous === undefined) return { droppedOldestAudio: false, overflowed: true };
      if (previous.kind !== "audio") this.#nonAudioBytes -= eventUtf8Bytes(previous);
      if (value.kind !== "audio") {
        const bytes = eventUtf8Bytes(value);
        if (bytes > MAX_QUEUED_PROVIDER_EVENT_BYTES ||
          this.#nonAudioCount + (previous.kind === "audio" ? 1 : 0) > MAX_QUEUED_PROVIDER_EVENTS ||
          this.#nonAudioBytes + bytes > MAX_QUEUED_PROVIDER_EVENT_BYTES) {
          if (previous.kind !== "audio") this.#nonAudioBytes += eventUtf8Bytes(previous);
          return { droppedOldestAudio: false, overflowed: true };
        }
        this.#nonAudioBytes += bytes;
        if (previous.kind === "audio") this.#nonAudioCount += 1;
      } else if (previous.kind !== "audio") {
        this.#nonAudioCount -= 1;
      }
      this.#values[index] = value;
      return { droppedOldestAudio: false, overflowed: false };
    }
    return this.push(value);
  }
  replaceWith(value: TranslationEvent): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.#values.splice(0, this.#values.length, value);
    this.#nonAudioBytes = value.kind === "audio" ? 0 : eventUtf8Bytes(value);
    this.#nonAudioCount = value.kind === "audio" ? 0 : 1;
  }
  #trimAudio(): boolean {
    let dropped = false;
    while (this.#values.filter((event) => event.kind === "audio").length >= this.#maxBufferedAudioFrames) {
      const oldestAudio = this.#values.findIndex((event) => event.kind === "audio");
      if (oldestAudio < 0) return dropped;
      this.#values.splice(oldestAudio, 1);
      dropped = true;
    }
    return dropped;
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }
  [Symbol.asyncIterator](): AsyncIterator<TranslationEvent> {
    return { next: async (): Promise<IteratorResult<TranslationEvent>> => {
      const value = this.#values.shift();
      if (value !== undefined) {
        if (value.kind !== "audio") {
          this.#nonAudioBytes -= eventUtf8Bytes(value);
          this.#nonAudioCount -= 1;
        }
        return { done: false, value };
      }
      if (this.#ended) return { done: true, value: undefined };
      return await new Promise((resolve) => this.#waiters.push(resolve));
    } };
  }
}

function eventUtf8Bytes(value: TranslationEvent): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? Number.MAX_SAFE_INTEGER : utf8Bytes(serialized);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

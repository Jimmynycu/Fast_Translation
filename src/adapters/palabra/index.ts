import WebSocket from "ws";
import { randomBytes } from "node:crypto";
import { CANONICAL_AUDIO, createAudioFrame, type AudioFrame } from "../../core/audio.js";
import type {
  GenerationRef,
  LaneContext,
  TranslationBehavior,
  TranslationCapabilities,
  TranslationErrorEvent,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../../core/types.js";

export interface PalabraWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
}
export interface PalabraWebSocketConnectOptions { readonly headers: Readonly<Record<string, string>>; }
export type PalabraWebSocketFactory = (url: string, options: PalabraWebSocketConnectOptions) => PalabraWebSocketLike;
export interface PalabraTranslationAdapterOptions {
  readonly apiKey: string;
  readonly webSocketFactory?: PalabraWebSocketFactory;
  readonly endpoint?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomHash?: string | (() => string);
  readonly now?: () => number;
  readonly inputChunkMs?: number;
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
const BALANCED_CONFIRMATION_MS = 700;
const TRAILING_SILENCE_MS = 320;
const SAMPLE_RATE = CANONICAL_AUDIO.sampleRateHz;
const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
const DEFAULTS = Object.freeze({ connect: 10000, readiness: 15000, poll: 2000, turn: 45000, settle: 35, close: 2000, eos: 1 });
const MAX_RETIRED_PROVIDER_IDS = 128;

export const PALABRA_TRANSLATION_CAPABILITIES = Object.freeze({
  providerId: "palabra",
  supportedModes: [
    { mode: "fast", behaviorVersion: 1, deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, deterministicGlossary: false },
    {
      mode: "accurate",
      behaviorVersion: 1,
      deterministicGlossary: false,
      degradation: "Palabra account glossaries cannot provide a deterministic pinned glossary.",
    },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: false,
} satisfies TranslationCapabilities);

interface Envelope { readonly type: string; readonly data: Record<string, unknown>; }
interface TaskWaiter { readonly resolve: (value: "running" | "not_found" | "other") => void; readonly reject: (error: unknown) => void; }
interface LaneOutputSequence { generation: number; next: number; }
interface PreparedTask {
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly behaviorVersion: TranslationBehavior["version"];
  readonly mode: TranslationBehavior["mode"];
}
interface SegmentState {
  readonly segmentId: string;
  revision: number;
  text: string;
  finality: TranslationEvent["finality"];
}
interface LaneSession {
  readonly key: string;
  readonly sessionId: string;
  readonly lane: LaneContext["lane"];
  socket: PalabraWebSocketLike | undefined;
  opened: boolean;
  closed: boolean;
  intentionalClose: boolean;
  prepared: boolean;
  preparePromise: Promise<void> | undefined;
  taskWaiters: TaskWaiter[];
  turn: Turn | undefined;
  closePromise: Promise<void> | undefined;
  context: PreparedTask | undefined;
  preparationError: PalabraAdapterError | undefined;
  retiredProviderIds: Set<string>;
  retiredProviderIdOrder: string[];
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
  droppedAudioFrames: number;
  queueTrimMetricFinal: boolean;
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
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "PalabraAdapterError";
    this.code = code;
    this.retryable = retryable;
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
  readonly #chunkBytes: number;
  readonly #connectMs: number;
  readonly #readinessMs: number;
  readonly #pollMs: number;
  readonly #turnMs: number;
  readonly #settleMs: number;
  readonly #closeMs: number;
  readonly #eosSec: number;
  readonly #lanes = new Map<string, LaneSession>();
  readonly #playoutSequences = new Map<string, LaneOutputSequence>();

  constructor(options: PalabraTranslationAdapterOptions) {
    if (typeof options.apiKey !== "string" || options.apiKey.trim() === "") throw new PalabraAdapterError("PALABRA_CONFIGURATION", "Palabra credentials are not configured.", false);
    const chunkMs = options.inputChunkMs ?? 320;
    if (!Number.isSafeInteger(chunkMs) || chunkMs < 20 || chunkMs > 320 || chunkMs % 20 !== 0) throw new PalabraAdapterError("PALABRA_CONFIGURATION", "inputChunkMs must be a multiple of 20 between 20 and 320 ms.", false);
    this.#apiKey = options.apiKey;
    this.#factory = options.webSocketFactory ?? defaultFactory;
    this.#endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
    this.#hash = hashFactory(options.randomHash);
    this.#now = options.now ?? (() => performance.now());
    this.#sleep = options.sleep ?? wait;
    this.#chunkBytes = chunkMs * BYTES_PER_MS;
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

  async prepare(context: LaneContext): Promise<void> {
    rejectGlossary(context);
    const lane = this.#lane(context);
    if (lane.prepared && !lane.closed && sameTask(lane.context, context)) return;
    if (lane.preparePromise) return await lane.preparePromise;
    const operation = this.#prepare(lane, context);
    lane.preparePromise = operation;
    try { await operation; } finally { if (lane.preparePromise === operation) lane.preparePromise = undefined; }
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
    if (context.glossary !== undefined) {
      yield this.#error(context, "PALABRA_GLOSSARY_UNSUPPORTED", "Palabra account glossaries cannot represent the pinned local glossary.", false);
      return;
    }
    if (request.signal.aborted) return;
    let lane = this.#lane(context);
    if (lane.turn?.lifecycle === "active") {
      await this.#cancelTurn(lane, lane.turn);
    }
    try { if (!(await this.#prepareUntil(context, request.signal))) return; lane = this.#lane(context); }
    catch (error: unknown) {
      yield this.#error(context, error instanceof PalabraAdapterError ? error.code : "PALABRA_PREPARE", error instanceof PalabraAdapterError ? error.message : "The translation service could not be prepared.", error instanceof PalabraAdapterError ? error.retryable : true);
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
    for (const key of this.#playoutSequences.keys()) {
      if (key.startsWith(sessionId + "\u0000")) this.#playoutSequences.delete(key);
    }
  }

  async #prepare(lane: LaneSession, context: LaneContext): Promise<void> {
    if (lane.closed) throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection is unavailable.", true);
    await this.#ensureSocket(lane);
    if (lane.prepared && sameTask(lane.context, context)) return;
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
    } catch (error) { lane.prepared = false; throw error; }
  }

  async #waitReady(lane: LaneSession): Promise<void> {
    const deadline = Date.now() + this.#readinessMs;
    while (Date.now() < deadline) {
      if (lane.preparationError) throw lane.preparationError;
      const waiter = this.#taskWait(lane, Math.max(1, deadline - Date.now()));
      try { this.#send(lane, { message_type: "get_task", data: { exclude_hidden: true } }); }
      catch { throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service could not send a readiness check.", true); }
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
    const endpoint = this.#endpoint.includes("{hash}") ? this.#endpoint.replace("{hash}", hash) : this.#endpoint;
    let socket: PalabraWebSocketLike;
    try { socket = this.#factory(endpoint, { headers: { Authorization: "Bearer " + this.#apiKey } }); }
    catch { throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection could not be created.", true); }
    lane.socket = socket;
    lane.opened = false;
    lane.closed = false;
    lane.intentionalClose = false;
    this.#bind(lane, socket);
    if (socket.readyState === 1) { lane.opened = true; return; }
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => finish(new PalabraAdapterError("PALABRA_CONNECT_TIMEOUT", "The translation service connection timed out.", true)), this.#connectMs);
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(error);
        else { lane.opened = true; resolve(); }
      };
      socket.on("open", () => finish());
      socket.on("error", () => finish(new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection could not be established.", true)));
      socket.on("close", () => finish(new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection closed unexpectedly.", true)));
    });
  }

  #bind(lane: LaneSession, socket: PalabraWebSocketLike): void {
    socket.on("message", (raw) => {
      const envelope = parseEnvelope(raw);
      if (!envelope) {
        if (lane.turn?.lifecycle === "active") lane.turn.queue.push(this.#error(lane.turn.context, "PALABRA_INVALID_PAYLOAD", "The translation service returned an invalid message.", true));
        return;
      }
      this.#dispatch(lane, envelope);
    });
    socket.on("error", () => {
      if (!lane.intentionalClose && !lane.closed) {
        lane.closed = true; lane.prepared = false;
        this.#failLane(lane, "PALABRA_CONNECTION", "The translation service connection failed.", true);
        if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
        try { socket.close(1011, "connection error"); } catch { /* best effort */ }
      }
    });
    socket.on("close", () => {
      if (lane.intentionalClose || lane.closed) return;
      lane.closed = true; lane.prepared = false;
      this.#failLane(lane, "PALABRA_CONNECTION", "The translation service connection closed unexpectedly.", true);
      if (this.#lanes.get(lane.key) === lane) this.#lanes.delete(lane.key);
    });
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
      const providerCodeRaw = safeMessage(code.replace(this.#apiKey, "[redacted]"));
      const providerCode = safeCode(providerCodeRaw);
      const providerDescription = safeMessage(typeof data.description === "string" ? data.description : typeof data.desc === "string" ? data.desc : "The translation service reported an error.").replace(this.#apiKey, "[redacted]");
      const providerParam = safeMessage(typeof data.parameter === "string" ? data.parameter : typeof data.param === "string" ? data.param : "").replace(this.#apiKey, "[redacted]");
      const providerMessage = "Provider error " + providerCodeRaw + (providerDescription ? ": " + providerDescription : "") + (providerParam ? " [param: " + providerParam + "]" : "");
      const providerError = new PalabraAdapterError("PALABRA_PROVIDER_" + providerCode, providerMessage, true);
      if (lane.preparePromise) {
        lane.preparationError = providerError;
        this.#rejectTaskWaiters(lane, providerError);
        return;
      }
      this.#resolveTask(lane, "other");
      if (lane.turn?.lifecycle === "active") {
        this.#failTurn(lane.turn, "PALABRA_PROVIDER_" + providerCode, providerMessage, true);
      }
      return;
    }
    if (envelope.type === "warning") {
      if (lane.turn?.lifecycle === "active" && lane.turn.acceptEvents) {
        const warningCode = safeCode((typeof data.code === "string" ? data.code : "WARNING").replace(this.#apiKey, "REDACTED"));
        const warningMessage = safeMessage(typeof data.message === "string" ? data.message : "The translation service reported a warning.").replace(this.#apiKey, "[redacted]");
        lane.turn.queue.push(this.#error(lane.turn.context, "PALABRA_WARNING_" + warningCode, warningMessage, true));
      }
      return;
    }
    const turn = lane.turn;
    if (!turn || turn.lifecycle !== "active" || !turn.acceptEvents) return;
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
      if (providerId && lane.retiredProviderIds.has(providerId)) return;
      turn.sawValidated = true;
      if (providerId) {
        turn.providerIds.add(providerId);
        turn.validatedProviderIds.add(providerId);
      }
      this.#transcript(turn, data, false, "final");
    } else if (envelope.type === "translated_transcription") {
      if (this.#acceptTranslatedEvent(lane, turn, data)) this.#transcript(turn, data, true, "final");
    } else if (envelope.type === "output_audio_data") {
      if (this.#acceptAudioEvent(lane, turn, data)) this.#audio(lane, turn, data);
    }
  }

  #resolveTask(lane: LaneSession, status: "running" | "not_found" | "other"): void {
    lane.taskWaiters.shift()?.resolve(status);
  }

  #acceptTranscriptEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    if (providerId && lane.retiredProviderIds.has(providerId)) return false;
    if (providerId) turn.providerIds.add(providerId);
    return true;
  }

  #acceptTranslatedEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    if (providerId && lane.retiredProviderIds.has(providerId)) return false;
    if (turn.context.behavior.transcriptPolicy === "final_only") {
      if (!turn.sawValidated || (providerId !== undefined && !turn.validatedProviderIds.has(providerId))) return false;
    }
    if (providerId) turn.providerIds.add(providerId);
    return true;
  }

  #acceptAudioEvent(lane: LaneSession, turn: Turn, data: Record<string, unknown>): boolean {
    const providerId = providerEventId(data);
    // An output packet with no stable provider ID cannot be fenced after flush.
    // Keep local playout safe rather than risk replaying stale speech.
    if (!providerId || lane.retiredProviderIds.has(providerId)) return false;
    if (turn.context.behavior.transcriptPolicy === "final_only" && !turn.validatedProviderIds.has(providerId)) return false;
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
    if (segment.finality === "final") return;
    if (segment.text === text && segment.finality === finality) return;
    segment.text = text;
    segment.finality = finality;
    segment.revision += 1;
    if (text) {
      turn.queue.push({
        kind: target ? "target_transcript" : "source_transcript",
        sessionId: turn.context.sessionId,
        lane: turn.context.lane,
        generation: turn.context.generation,
        turnId: turn.context.turnId,
        segmentId: segment.segmentId,
        revision: segment.revision,
        finality,
        emittedAtMs: this.#now(),
        text,
      });
    }
    if (target && finality === "final") {
      turn.sawFinalTarget = true;
      this.#maybeComplete(turn);
    }
  }

  #segment(turn: Turn, data: Record<string, unknown>, target: boolean): SegmentState {
    const key = providerSegmentKey(data, target);
    const existing = turn.segments.get(key);
    if (existing) return existing;
    const segment: SegmentState = {
      segmentId: turn.context.turnId + ":segment:" + turn.nextSegmentId++,
      revision: -1,
      text: "",
      finality: "provisional",
    };
    turn.segments.set(key, segment);
    return segment;
  }

  #audio(lane: LaneSession, turn: Turn, data: Record<string, unknown>): void {
    if (typeof data.data !== "string") {
      turn.queue.push(this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned invalid audio.", true));
      return;
    }
    let bytes: Uint8Array;
    try { bytes = decodePcm(data.data); }
    catch { turn.queue.push(this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned invalid audio.", true)); return; }
    turn.pendingAudio = join(turn.pendingAudio, bytes);
    while (turn.pendingAudio.byteLength >= CANONICAL_AUDIO.bytesPerFrame) {
      const finality = data.last_chunk === true && turn.pendingAudio.byteLength === CANONICAL_AUDIO.bytesPerFrame
        ? "final"
        : "provisional";
      this.#emitAudio(lane, turn, turn.pendingAudio.slice(0, CANONICAL_AUDIO.bytesPerFrame), finality);
      turn.pendingAudio = turn.pendingAudio.slice(CANONICAL_AUDIO.bytesPerFrame);
    }
    if (data.last_chunk === true) {
      turn.sawLastAudio = true;
      this.#flushAudio(turn, "final");
      this.#maybeComplete(turn);
    }
  }

  #emitAudio(
    lane: LaneSession,
    turn: Turn,
    pcm: Uint8Array,
    finality: TranslationEvent["finality"],
  ): void {
    const now = this.#now();
    const capturedAtMs = Math.max(Number.isFinite(now) && now >= 0 ? now : 0, turn.lastCapturedAtMs);
    turn.lastCapturedAtMs = capturedAtMs;
    let output = this.#playoutSequences.get(lane.key);
    if (!output || output.generation !== turn.context.generation) {
      output = { generation: turn.context.generation, next: 0 };
      this.#playoutSequences.set(lane.key, output);
    }
    const sequence = output.next++;
    const droppedOldest = turn.queue.push({
      kind: "audio",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":audio:" + turn.nextAudioSegmentId++,
      revision: 0,
      finality,
      emittedAtMs: capturedAtMs,
      playoutSequence: sequence,
      frame: createAudioFrame({ sessionId: turn.context.sessionId, lane: turn.context.lane, generation: turn.context.generation, sequence, capturedAtMs, pcm16le: pcm }),
    });
    if (droppedOldest) {
      turn.droppedAudioFrames += 1;
      turn.queue.upsert(this.#queueTrimMetric(turn, "provisional"), (event) =>
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
      evidenceRef: "palabra:local-audio-queue",
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
    turn.queue.upsert(this.#queueTrimMetric(turn, "final"), (event) =>
      event.kind === "error" && event.segmentId === turn.context.turnId + ":local-audio-queue",
    );
  }

  #flushAudio(turn: Turn, finality: TranslationEvent["finality"]): void {
    if (!turn.pendingAudio.byteLength) return;
    if (turn.pendingAudio.byteLength % 2) {
      turn.queue.push(this.#error(turn.context, "PALABRA_INVALID_AUDIO", "The translation service returned an incomplete PCM16 sample.", true));
      turn.pendingAudio = new Uint8Array(0);
      return;
    }
    const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
    pcm.set(turn.pendingAudio);
    turn.pendingAudio = new Uint8Array(0);
    this.#emitAudio(turn.lane, turn, pcm, finality);
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
        while (buffer.byteLength >= this.#chunkBytes && turn.lifecycle === "active") {
          await this.#sendInput(lane, turn, buffer.slice(0, this.#chunkBytes));
          buffer = buffer.slice(this.#chunkBytes);
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
      const chunk = new Uint8Array(this.#chunkBytes);
      chunk.set(buffer);
      await this.#sendInput(lane, turn, chunk);
    }
    const silenceBytes = Math.ceil(BYTES_PER_MS * TRAILING_SILENCE_MS);
    let zeroBytes = buffer.byteLength ? this.#chunkBytes - buffer.byteLength : 0;
    while (turn.lifecycle === "active" && zeroBytes < silenceBytes) {
      const size = Math.min(this.#chunkBytes, silenceBytes - zeroBytes);
      await this.#sendInput(lane, turn, new Uint8Array(size));
      zeroBytes += size;
    }
    turn.inputFinished = true;
    this.#maybeComplete(turn);
  }

  async #sendInput(lane: LaneSession, turn: Turn, pcm: Uint8Array<ArrayBufferLike>): Promise<void> {
    if (turn.lifecycle !== "active" || !lane.socket || lane.closed) return;
    if (!pcm.byteLength || pcm.byteLength % 2) { this.#failTurn(turn, "PALABRA_INPUT_FORMAT", "Audio must contain complete PCM16 samples.", false); return; }
    const now = this.#now();
    if (turn.lastInputSentAtMs !== undefined && Number.isFinite(now)) {
      const waitMs = this.#chunkBytes / BYTES_PER_MS - Math.max(0, now - turn.lastInputSentAtMs);
      if (waitMs > 0) await this.#sleep(waitMs);
    }
    if (turn.signal.aborted || turn.lifecycle !== "active" || lane.turn !== turn || lane.closed || !lane.socket) return;
    turn.lastInputSentAtMs = this.#now();
    try { turn.acceptEvents = true; this.#send(lane, { message_type: "input_audio_data", data: { data: Buffer.from(pcm).toString("base64") } }); }
    catch { this.#failTurn(turn, "PALABRA_CONNECTION", "The translation service could not accept audio.", true); }
  }

  #newTurn(lane: LaneSession, context: LaneContext, signal: AbortSignal): Turn {
    let wakeInputStop = (): void => undefined;
    const inputStopPromise = new Promise<void>((resolve) => { wakeInputStop = resolve; });
    let turn!: Turn;
    const abortListener = (): void => { if (turn.lifecycle === "active") void this.#cancelTurn(lane, turn); };
    turn = { lane, context, queue: new EventQueue(maximumBufferedAudioFrames(context.behavior)), segments: new Map(), providerIds: new Set(), validatedProviderIds: new Set(), abortListener, acceptEvents: false, sawValidated: false, nextSegmentId: 0, nextAudioSegmentId: 0, droppedAudioFrames: 0, queueTrimMetricFinal: false, signal, inputStopPromise, wakeInputStop, lifecycle: "active", inputStopped: false, inputIterator: undefined, inputReturnRequested: false, lastInputSequence: undefined, lastInputCapturedAtMs: undefined, lastInputSentAtMs: undefined, pendingAudio: new Uint8Array(0), lastCapturedAtMs: 0, sawFinalTarget: false, sawLastAudio: false, inputFinished: false, completionTimer: undefined, hardTimer: undefined };
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
    turn.queue.push({
      kind: "completed",
      sessionId: turn.context.sessionId,
      lane: turn.context.lane,
      generation: turn.context.generation,
      turnId: turn.context.turnId,
      segmentId: turn.context.turnId + ":completed",
      revision: 0,
      finality: "final",
      emittedAtMs: this.#now(),
    });
    turn.queue.end();
  }

  #failTurn(turn: Turn, code: string, message: string, retryable: boolean): void {
    if (turn.lifecycle !== "active") return;
    turn.lifecycle = "failed";
    if (turn.hardTimer) clearTimeout(turn.hardTimer);
    if (turn.completionTimer) clearTimeout(turn.completionTimer);
    this.#stopInput(turn);
    this.#finalizeQueueTrimMetric(turn);
    turn.queue.push(this.#error(turn.context, code, message, retryable));
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
    if (!lane.socket || lane.closed) throw new PalabraAdapterError("PALABRA_CONNECTION", "The translation service connection is unavailable.", true);
    lane.socket.send(JSON.stringify(message));
  }

  #lane(context: LaneContext): LaneSession {
    const key = laneKey(context);
    const existing = this.#lanes.get(key);
    if (existing && !existing.closed) return existing;
    const lane: LaneSession = { key, sessionId: context.sessionId, lane: context.lane, socket: undefined, opened: false, closed: false, intentionalClose: false, prepared: false, preparePromise: undefined, taskWaiters: [], turn: undefined, closePromise: undefined, context: undefined, preparationError: undefined, retiredProviderIds: new Set(), retiredProviderIdOrder: [] };
    this.#lanes.set(key, lane);
    return lane;
  }

  #error(context: LaneContext, code: string, message: string, retryable: boolean): TranslationErrorEvent {
    return {
      kind: "error",
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      segmentId: context.turnId + ":error:" + safeCode(code),
      revision: 0,
      finality: "final",
      emittedAtMs: this.#now(),
      error: { code, message, retryable },
    };
  }
}

function defaultFactory(url: string, options: PalabraWebSocketConnectOptions): PalabraWebSocketLike {
  return new WebSocket(url, { headers: options.headers }) as unknown as PalabraWebSocketLike;
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
function rejectGlossary(context: LaneContext): void {
  if (context.glossary !== undefined) throw new PalabraAdapterError("PALABRA_GLOSSARY_UNSUPPORTED", "Palabra account glossaries cannot represent the pinned local glossary.", false);
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
  if (behavior.version !== 1) {
    throw new PalabraAdapterError("PALABRA_CONFIGURATION", "The translation behavior version is not supported by Palabra.", false);
  }
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
function parseEnvelope(raw: unknown): Envelope | null {
  const parsed = parseValue(raw);
  if (!record(parsed)) return null;
  const type = typeof parsed.message_type === "string" ? parsed.message_type : typeof parsed.type === "string" ? parsed.type : undefined;
  if (!type) return null;
  const dataValue = parseValue(parsed.data);
  return { type, data: record(dataValue) ? dataValue : typeof dataValue === "string" ? { data: dataValue } : {} };
}
function parseValue(value: unknown): unknown {
  if (typeof value === "string") { try { return JSON.parse(value) as unknown; } catch { return value; } }
  if (value instanceof Uint8Array) return parseValue(Buffer.from(value).toString("utf8"));
  if (value instanceof ArrayBuffer) return parseValue(Buffer.from(value).toString("utf8"));
  if (record(value) && "data" in value && Object.keys(value).length === 1) return parseValue(value.data);
  return value;
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return record(value) ? value : undefined; }
function scalarId(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
function providerEventId(data: Record<string, unknown>): string | undefined {
  const transcription = asRecord(data.transcription);
  return scalarId(transcription?.transcription_id) ?? scalarId(data.transcription_id);
}
function providerSegmentKey(data: Record<string, unknown>, target: boolean): string {
  const providerId = providerEventId(data);
  if (!providerId) return target ? "target\u0000fallback" : "source\u0000fallback";
  if (!target) return "source\u0000" + providerId;
  const transcription = asRecord(data.transcription);
  const partId = scalarId(transcription?.translation_part_id) ?? scalarId(data.translation_part_id) ?? "0";
  return "target\u0000" + providerId + "\u0000" + partId;
}
function safeCode(value: string): string {
  const code = value.trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return code || "UNKNOWN";
}
function safeMessage(value: string): string {
  return value.replace(/https?:\/\/\S+/gi, "[redacted]").replace(/bearer\s+\S+/gi, "[redacted]").slice(0, 256);
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
  #ended = false;
  constructor(maxBufferedAudioFrames: number) {
    this.#maxBufferedAudioFrames = maxBufferedAudioFrames;
  }
  push(value: TranslationEvent): boolean {
    if (this.#ended) return false;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return false;
    }
    const droppedOldest = value.kind === "audio" && this.#trimAudio();
    this.#values.push(value);
    return droppedOldest;
  }
  upsert(value: TranslationEvent, matches: (current: TranslationEvent) => boolean): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    const index = this.#values.findIndex(matches);
    if (index >= 0) this.#values[index] = value;
    else this.#values.push(value);
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
      if (value !== undefined) return { done: false, value };
      if (this.#ended) return { done: true, value: undefined };
      return await new Promise((resolve) => this.#waiters.push(resolve));
    } };
  }
}

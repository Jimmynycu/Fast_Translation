import { CANONICAL_AUDIO, createAudioFrame, laneFromSource } from "../../core/audio.js";
import { AsyncQueue } from "../../core/async-queue.js";
import type {
  Lane,
  MediaClearRequest,
  MediaIngressEvent,
  MediaIngressRequest,
  MediaPlaybackRequest,
  MediaPort,
  Side,
} from "../../core/types.js";
import { packPlayoutAudio } from "../../server/protocol.js";

export type BrowserSocketListener = (...args: readonly unknown[]) => void;

export interface BrowserSocketLike {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  on(event: string, listener: BrowserSocketListener): unknown;
  off?(event: string, listener: BrowserSocketListener): unknown;
  send(data: string | Uint8Array): void;
  close?(code?: number, reason?: string): void;
}

export interface BrowserMediaProtocolContext {
  readonly sessionId: string;
  readonly side: Side;
}

export class BrowserMediaProtocolError extends Error {
  readonly code:
    | "invalid_audio"
    | "invalid_control"
    | "ingress_overflow"
    | "playout_overflow"
    | "side_in_use"
    | "socket_error";

  constructor(code: BrowserMediaProtocolError["code"], message: string) {
    super(message);
    this.name = "BrowserMediaProtocolError";
    this.code = code;
  }
}

export interface BrowserWebSocketMediaPortOptions {
  readonly queueCapacity?: number;
  readonly maximumBufferedBytes?: number;
  readonly playoutAckTimeoutMs?: number;
  readonly closedSessionLimit?: number;
  readonly now?: () => number;
  readonly onProtocolError?: (
    error: BrowserMediaProtocolError,
    context: BrowserMediaProtocolContext,
  ) => void;
}

interface SocketAttachment {
  readonly socket: BrowserSocketLike;
  readonly onMessage: BrowserSocketListener;
  readonly onClose: BrowserSocketListener;
  readonly onError: BrowserSocketListener;
}

interface PendingPlayback {
  readonly frame: import("../../core/audio.js").AudioFrame;
  readonly sentAtMs: number;
}

interface BrowserPlayback {
  readonly pending: Map<string, PendingPlayback>;
  readonly onPlayoutStarted: MediaPlaybackRequest["onPlayoutStarted"];
}

interface BrowserSession {
  readonly ingress: AsyncQueue<MediaIngressEvent>;
  readonly attachments: Partial<Record<Side, SocketAttachment>>;
  readonly playback: Partial<Record<Side, BrowserPlayback>>;
  readonly inputSequence: Record<Side, number>;
  readonly generations: Record<Lane, number>;
  closed: boolean;
}

function assertIdentity(sessionId: string, side: Side): void {
  if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
  if (side !== "A" && side !== "B") throw new TypeError("side must be A or B");
}

function bytesFromMessage(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data) && data.every((part) => part instanceof Uint8Array)) {
    const parts = data as Uint8Array[];
    const total = parts.reduce((size, part) => size + part.byteLength, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    return joined;
  }
  return undefined;
}

function controlText(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  const bytes = bytesFromMessage(data);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function isOpen(socket: BrowserSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function playoutKey(generation: number, sequence: number): string {
  return generation + ":" + sequence;
}

export class BrowserWebSocketMediaPort implements MediaPort {
  readonly #queueCapacity: number;
  readonly #maximumBufferedBytes: number;
  readonly #playoutAckTimeoutMs: number;
  readonly #closedSessionLimit: number;
  readonly #closedSessions = new Set<string>();
  readonly #closedSessionOrder: string[] = [];
  readonly #now: () => number;
  readonly #onProtocolError: (
    error: BrowserMediaProtocolError,
    context: BrowserMediaProtocolContext,
  ) => void;
  readonly #sessions = new Map<string, BrowserSession>();

  constructor(options: BrowserWebSocketMediaPortOptions = {}) {
    this.#queueCapacity = options.queueCapacity ?? 50;
    if (!Number.isSafeInteger(this.#queueCapacity) || this.#queueCapacity < 1) {
      throw new RangeError("queueCapacity must be a positive safe integer");
    }
    this.#maximumBufferedBytes = options.maximumBufferedBytes ?? 24 * 1024;
    if (!Number.isSafeInteger(this.#maximumBufferedBytes) || this.#maximumBufferedBytes < 960) {
      throw new RangeError("maximumBufferedBytes must be a safe integer of at least 960");
    }
    this.#playoutAckTimeoutMs = options.playoutAckTimeoutMs ?? 2_000;
    if (!Number.isSafeInteger(this.#playoutAckTimeoutMs) || this.#playoutAckTimeoutMs < 20) {
      throw new RangeError("playoutAckTimeoutMs must be a safe integer of at least 20");
    }
    this.#closedSessionLimit = options.closedSessionLimit ?? 1_000;
    if (!Number.isSafeInteger(this.#closedSessionLimit) || this.#closedSessionLimit < 1) {
      throw new RangeError("closedSessionLimit must be a positive safe integer");
    }
    this.#now = options.now ?? (() => performance.now());
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
  }

  attach(sessionId: string, side: Side, socket: BrowserSocketLike): () => void {
    assertIdentity(sessionId, side);
    const session = this.#session(sessionId);
    if (session.closed) throw new Error("Cannot attach to a closed media session");

    const existing = session.attachments[side];
    if (existing?.socket === socket) {
      return () => this.detach(sessionId, side, socket);
    }
    if (existing !== undefined) {
      throw new BrowserMediaProtocolError(
        "side_in_use",
        `Participant ${side} is already attached to this session`,
      );
    }

    const onMessage: BrowserSocketListener = (...args) => {
      if (session.attachments[side]?.socket !== socket) return;
      this.#receive(sessionId, side, args[0], args[1] === true);
    };
    const onClose: BrowserSocketListener = () => {
      const current = session.attachments[side];
      if (current?.socket === socket) this.#detach(sessionId, side, current, true);
    };
    const onError: BrowserSocketListener = (...args) => {
      const detail = args[0] instanceof Error ? args[0].message : "browser media socket failed";
      this.#onProtocolError(
        new BrowserMediaProtocolError("socket_error", detail),
        { sessionId, side },
      );
    };
    const attachment = { socket, onMessage, onClose, onError };
    session.attachments[side] = attachment;
    session.inputSequence[side] = 0;
    socket.on("message", onMessage);
    socket.on("close", onClose);
    socket.on("error", onError);
    this.#offer(session, {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: true,
    });
    return () => this.detach(sessionId, side, socket);
  }

  detach(sessionId: string, side: Side, socket?: BrowserSocketLike): void {
    assertIdentity(sessionId, side);
    const session = this.#sessions.get(sessionId);
    const attachment = session?.attachments[side];
    if (session === undefined || attachment === undefined) return;
    if (socket !== undefined && attachment.socket !== socket) return;
    this.#detach(sessionId, side, attachment, true);
  }

  closeSession(sessionId: string): void {
    if (this.#closedSessions.has(sessionId)) return;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) {
      this.#rememberClosedSession(sessionId);
      return;
    }
    for (const side of ["A", "B"] as const) {
      const attachment = session.attachments[side];
      if (attachment !== undefined) {
        this.#detach(sessionId, side, attachment, false);
        attachment.socket.close?.(1000, "Session closed");
      }
    }
    session.closed = true;
    session.ingress.close();
    this.#sessions.delete(sessionId);
    this.#rememberClosedSession(sessionId);
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    const session = this.#session(request.sessionId);
    return this.#withAbort(session.ingress, request.signal);
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    assertIdentity(request.sessionId, request.side);
    const session = this.#session(request.sessionId);
    const playback: BrowserPlayback = {
      pending: new Map(),
      onPlayoutStarted: request.onPlayoutStarted,
    };
    session.playback[request.side] = playback;
    try {
      for await (const frame of request.frames) {
        if (request.signal.aborted || session.closed) break;
        const attachment = session.attachments[request.side];
        if (attachment === undefined || !isOpen(attachment.socket)) continue;
        this.#expirePending(playback, request.sessionId, request.side);
        if (
          (attachment.socket.bufferedAmount ?? 0) > this.#maximumBufferedBytes ||
          playback.pending.size >= this.#queueCapacity
        ) {
          this.#reject(
            "playout_overflow",
            "Browser playout exceeded its latency budget; the newest frame was dropped",
            request.sessionId,
            request.side,
          );
          continue;
        }
        const key = playoutKey(frame.generation, frame.sequence);
        playback.pending.set(key, { frame, sentAtMs: this.#now() });
        try {
          attachment.socket.send(
            packPlayoutAudio(frame.generation, frame.sequence, frame.pcm16le),
          );
        } catch (error: unknown) {
          playback.pending.delete(key);
          throw error;
        }
      }
    } finally {
      if (session.playback[request.side] === playback) delete session.playback[request.side];
      playback.pending.clear();
    }
  }

  async clear(request: MediaClearRequest): Promise<void> {
    assertIdentity(request.sessionId, request.side);
    if (!Number.isSafeInteger(request.generation) || request.generation < 0) {
      throw new RangeError("generation must be a non-negative safe integer");
    }
    const session = this.#session(request.sessionId);
    session.generations[request.lane] = request.generation;
    const playback = session.playback[request.side];
    if (playback !== undefined) {
      for (const [key, pending] of playback.pending) {
        if (pending.frame.generation < request.generation) playback.pending.delete(key);
      }
    }
    const attachment = session.attachments[request.side];
    if (attachment !== undefined && isOpen(attachment.socket)) {
      attachment.socket.send(JSON.stringify({
        type: "clear",
        generation: request.generation,
      }));
    }
  }

  #session(sessionId: string): BrowserSession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#closedSessions.has(sessionId)) {
      throw new Error("Cannot reopen a closed media session");
    }
    if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
    const created: BrowserSession = {
      ingress: new AsyncQueue<MediaIngressEvent>(this.#queueCapacity),
      attachments: {},
      playback: {},
      inputSequence: { A: 0, B: 0 },
      generations: { A_TO_B: 0, B_TO_A: 0 },
      closed: false,
    };
    this.#sessions.set(sessionId, created);
    return created;
  }

  #rememberClosedSession(sessionId: string): void {
    if (this.#closedSessions.has(sessionId)) return;
    this.#closedSessions.add(sessionId);
    this.#closedSessionOrder.push(sessionId);
    while (this.#closedSessionOrder.length > this.#closedSessionLimit) {
      const expiredSessionId = this.#closedSessionOrder.shift();
      if (expiredSessionId === undefined) break;
      this.#closedSessions.delete(expiredSessionId);
    }
  }

  #receive(sessionId: string, side: Side, data: unknown, isBinary: boolean): void {
    const session = this.#session(sessionId);
    if (isBinary) {
      const bytes = bytesFromMessage(data);
      if (bytes === undefined || bytes.byteLength !== CANONICAL_AUDIO.bytesPerFrame) {
        this.#reject(
          "invalid_audio",
          "Browser audio must contain exactly 960 bytes of 24 kHz PCM16LE",
          sessionId,
          side,
        );
        return;
      }
      const lane = laneFromSource(side);
      const sequence = session.inputSequence[side];
      const frame = createAudioFrame({
        sessionId,
        lane,
        generation: session.generations[lane],
        sequence,
        capturedAtMs: this.#now(),
        pcm16le: bytes,
      });
      if (this.#offer(session, {
        type: "audio",
        sessionId,
        side,
        timestampMonoMs: frame.capturedAtMs,
        frame,
      })) {
        session.inputSequence[side] = sequence + 1;
      } else {
        this.#reject(
          "ingress_overflow",
          "Browser ingress queue is full; the media frame was dropped",
          sessionId,
          side,
        );
      }
      return;
    }

    const text = controlText(data);
    let control: unknown;
    try {
      control = text === undefined ? undefined : JSON.parse(text);
    } catch {
      control = undefined;
    }
    if (
      typeof control !== "object" ||
      control === null ||
      !(("type") in control) ||
      typeof control.type !== "string"
    ) {
      this.#reject(
        "invalid_control",
        "Browser control must contain a string type",
        sessionId,
        side,
      );
      return;
    }

    if (
      control.type === "playout_started" ||
      control.type === "playout_dropped"
    ) {
      const candidate = control as Record<string, unknown>;
      const generation = Number(candidate.generation);
      const sequence = Number(candidate.sequence);
      if (
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0
      ) {
        this.#reject(
          "invalid_control",
          "playout control requires non-negative generation and sequence integers",
          sessionId,
          side,
        );
        return;
      }
      const playback = session.playback[side];
      if (playback === undefined) return;
      const key = playoutKey(generation, sequence);
      const pending = playback.pending.get(key);
      if (control.type === "playout_dropped") {
        if (pending !== undefined) playback.pending.delete(key);
        this.#reject(
          "playout_overflow",
          "Browser trimmed stale playout before it reached the audio device",
          sessionId,
          side,
        );
        return;
      }
      if (pending === undefined) return;
      playback.pending.delete(key);
      playback.onPlayoutStarted(pending.frame, this.#now());
      return;
    }

    if (control.type !== "speech_start" && control.type !== "speech_end") {
      this.#reject(
        "invalid_control",
        "Browser control must be speech_start, speech_end, playout_started, or playout_dropped JSON",
        sessionId,
        side,
      );
      return;
    }

    this.#offer(session, {
      type: control.type === "speech_start" ? "speech_started" : "speech_ended",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
    });
  }

  #expirePending(playback: BrowserPlayback, sessionId: string, side: Side): void {
    const cutoffMs = this.#now() - this.#playoutAckTimeoutMs;
    let expired = 0;
    for (const [key, pending] of playback.pending) {
      if (pending.sentAtMs <= cutoffMs) {
        playback.pending.delete(key);
        expired += 1;
      }
    }
    if (expired === 0) return;
    this.#reject(
      "playout_overflow",
      expired + " unacknowledged browser playout frames expired",
      sessionId,
      side,
    );
  }

  #offer(session: BrowserSession, event: MediaIngressEvent): boolean {
    return !session.closed && session.ingress.offer(event);
  }

  #reject(
    code: BrowserMediaProtocolError["code"],
    message: string,
    sessionId: string,
    side: Side,
  ): void {
    const error = new BrowserMediaProtocolError(code, message);
    this.#onProtocolError(error, { sessionId, side });
    const session = this.#sessions.get(sessionId);
    if (session !== undefined && !session.closed) {
      session.ingress.offer({
        type: "alert",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        code: error.code,
        message: error.message,
        retryable: code === "ingress_overflow" || code === "playout_overflow" ||
          code === "socket_error",
      });
    }
  }

  #detach(
    sessionId: string,
    side: Side,
    attachment: SocketAttachment,
    notify: boolean,
  ): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.attachments[side] !== attachment) return;
    attachment.socket.off?.("message", attachment.onMessage);
    attachment.socket.off?.("close", attachment.onClose);
    attachment.socket.off?.("error", attachment.onError);
    delete session.attachments[side];
    session.playback[side]?.pending.clear();
    if (notify) {
      this.#offer(session, {
        type: "participant_state",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        connected: false,
      });
    }
  }

  async *#withAbort<T>(queue: AsyncQueue<T>, signal: AbortSignal): AsyncIterable<T> {
    const iterator = queue[Symbol.asyncIterator]();
    const abort = () => {
      void iterator.return?.();
    };
    if (signal.aborted) {
      await iterator.return?.();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (!signal.aborted) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await iterator.return?.();
    }
  }
}

import {
  CANONICAL_AUDIO,
  createAudioFrame,
  destinationForLane,
  laneFromSource,
} from "../../core/audio.js";
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

const MAX_CONTROL_MESSAGE_BYTES = 4 * 1024;
const MAX_TERMINAL_PENDING_PER_SIDE = 2;

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

interface BrowserClearState {
  readonly clearId: string;
  readonly generation: number;
  acknowledged: boolean;
}

interface BrowserSession {
  readonly ingress: AsyncQueue<MediaIngressEvent>;
  readonly attachments: Partial<Record<Side, SocketAttachment>>;
  readonly playback: Partial<Record<Side, BrowserPlayback>>;
  readonly inputSequence: Record<Side, number>;
  readonly generations: Record<Lane, number>;
  readonly clears: Record<Lane, BrowserClearState | undefined>;
  readonly readiness: Record<Side, boolean>;
  readonly terminalAnchors: Partial<Record<Side, MediaIngressEvent>>;
  readonly terminalPending: Array<{ readonly side: Side; readonly event: MediaIngressEvent }>;
  readonly terminalPendingReady: Set<Side>;
  closed: boolean;
}

function assertIdentity(sessionId: string, side: Side): void {
  if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
  if (side !== "A" && side !== "B") throw new TypeError("side must be A or B");
}

function bytesFromMessage(data: unknown, maximumBytes?: number): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    if (maximumBytes !== undefined && data.byteLength > maximumBytes) return undefined;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    if (maximumBytes !== undefined && data.byteLength > maximumBytes) return undefined;
    return new Uint8Array(data);
  }
  if (Array.isArray(data)) {
    let total = 0;
    for (const part of data) {
      if (!(part instanceof Uint8Array)) return undefined;
      if (
        maximumBytes !== undefined &&
        (part.byteLength > maximumBytes || total > maximumBytes - part.byteLength)
      ) {
        return undefined;
      }
      total += part.byteLength;
    }
    const parts = data as Uint8Array[];
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
  if (typeof data === "string") {
    const probe = new Uint8Array(MAX_CONTROL_MESSAGE_BYTES + 1);
    const encoded = new TextEncoder().encodeInto(data, probe);
    if (encoded.written > MAX_CONTROL_MESSAGE_BYTES || encoded.read !== data.length) {
      return undefined;
    }
    return data;
  }
  const bytes = bytesFromMessage(data, MAX_CONTROL_MESSAGE_BYTES);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

function isOpen(socket: BrowserSocketLike): boolean {
  return socket.readyState === undefined || socket.readyState === 1;
}

function playoutKey(generation: number, sequence: number): string {
  return generation + ":" + sequence;
}

function assertClearId(clearId: string): void {
  if (typeof clearId !== "string" || clearId.trim().length === 0 || clearId.length > 256) {
    throw new TypeError("clearId must be a non-empty string of at most 256 characters");
  }
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
    const connected = this.#offer(session, {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: true,
    });
    if (!connected) {
      try {
        this.#onProtocolError(
          new BrowserMediaProtocolError(
            "ingress_overflow",
            "Browser connected participant state could not be recorded",
          ),
          { sessionId, side },
        );
      } catch {
        // Protocol-error observers cannot prevent replacement cleanup.
      }
      const failedSides = new Set<Side>();
      try {
        this.#detach(sessionId, side, attachment, true, failedSides);
      } catch {
        failedSides.add(side);
      }
      try {
        socket.close?.(1013, "Browser media ingress backpressure");
      } catch {
        failedSides.add(side);
      }
    } else {
      if (session.terminalAnchors[side] !== undefined && session.terminalPending.length > 0) {
        delete session.terminalAnchors[side];
        session.terminalPendingReady.add(side);
      }
      this.#replayOutstandingClear(session, sessionId, side, socket);
    }
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
    const failedSides = new Set<Side>();
    try {
      for (const side of ["A", "B"] as const) {
        const attachment = session.attachments[side];
        if (attachment === undefined) continue;
        try {
          this.#detach(sessionId, side, attachment, true, failedSides);
        } catch {
          failedSides.add(side);
        }
        try {
          attachment.socket.close?.(1000, "Session closed");
        } catch {
          failedSides.add(side);
        }
      }
    } finally {
      session.closed = true;
      session.ingress.close();
      this.#sessions.delete(sessionId);
      this.#rememberClosedSession(sessionId);
    }
    for (const side of failedSides) {
      try {
        this.#onProtocolError(
          new BrowserMediaProtocolError("socket_error", "Browser media session teardown failed"),
          { sessionId, side },
        );
      } catch {
        // Protocol-error observers cannot prevent the session tombstone.
      }
    }
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    const session = this.#session(request.sessionId);
    return this.#withAbort(session, request.signal);
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
    assertClearId(request.clearId);
    if (request.lane !== "A_TO_B" && request.lane !== "B_TO_A") {
      throw new RangeError("lane must be A_TO_B or B_TO_A");
    }
    if (destinationForLane(request.lane) !== request.side) {
      throw new RangeError("clear side must be the destination for its lane");
    }
    const session = this.#session(request.sessionId);
    const previous = session.clears[request.lane];
    if (previous !== undefined) {
      if (request.generation < previous.generation) {
        throw new RangeError("clear generation must not move backward");
      }
      if (request.generation === previous.generation && request.clearId !== previous.clearId) {
        throw new RangeError("clearId must match an existing generation clear");
      }
      if (request.generation === previous.generation && previous.acknowledged) return;
    }
    session.generations[request.lane] = request.generation;
    if (previous === undefined || request.generation > previous.generation) {
      session.clears[request.lane] = {
        clearId: request.clearId,
        generation: request.generation,
        acknowledged: false,
      };
    }
    const playback = session.playback[request.side];
    if (playback !== undefined) {
      for (const [key, pending] of playback.pending) {
        if (pending.frame.generation < request.generation) playback.pending.delete(key);
      }
    }
    const attachment = session.attachments[request.side];
    if (attachment !== undefined && isOpen(attachment.socket)) {
      try {
        this.#sendClear(
          request.sessionId,
          request.side,
          attachment.socket,
          request.lane,
          request.generation,
          request.clearId,
        );
      } catch {
        const current = session.clears[request.lane];
        if (
          current !== undefined &&
          current.generation === request.generation &&
          current.clearId === request.clearId
        ) {
          delete session.clears[request.lane];
        }
        try {
          this.#reject(
            "socket_error",
            "Browser clear delivery failed",
            request.sessionId,
            request.side,
          );
        } catch {
          // Keep teardown best effort even if the observer fails.
        }
        const currentAttachment = session.attachments[request.side];
        if (currentAttachment?.socket === attachment.socket) {
          const failedSides = new Set<Side>();
          try {
            this.#detach(request.sessionId, request.side, currentAttachment, true, failedSides);
          } catch {
            failedSides.add(request.side);
          }
          try {
            currentAttachment.socket.close?.(1008, "Browser clear delivery failed");
          } catch {
            failedSides.add(request.side);
          }
        }
        throw new BrowserMediaProtocolError("socket_error", "Browser clear delivery failed");
      }
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
      clears: { A_TO_B: undefined, B_TO_A: undefined },
      readiness: { A: false, B: false },
      terminalAnchors: {},
      terminalPending: [],
      terminalPendingReady: new Set<Side>(),
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

  #sendClear(
    sessionId: string,
    side: Side,
    socket: BrowserSocketLike,
    lane: Lane,
    generation: number,
    clearId: string,
  ): void {
    if ((socket.bufferedAmount ?? 0) > this.#maximumBufferedBytes) {
      this.#reject(
        "playout_overflow",
        "Browser playout exceeded its latency budget; the pending clear will be replayed on reconnect",
        sessionId,
        side,
      );
      const attachment = this.#sessions.get(sessionId)?.attachments[side];
      if (attachment?.socket === socket) {
        this.#detach(sessionId, side, attachment, true);
      }
      socket.close?.(1008, "Browser playout backpressure");
      return;
    }
    socket.send(JSON.stringify({ type: "clear", lane, generation, clearId }));
  }

  #replayOutstandingClear(
    session: BrowserSession,
    sessionId: string,
    side: Side,
    socket: BrowserSocketLike,
  ): void {
    if (!isOpen(socket)) return;
    for (const lane of ["A_TO_B", "B_TO_A"] as const) {
      const clear = session.clears[lane];
      if (
        clear === undefined ||
        clear.acknowledged ||
        destinationForLane(lane) !== side
      ) {
        continue;
      }
      try {
        this.#sendClear(sessionId, side, socket, lane, clear.generation, clear.clearId);
      } catch {
        const current = session.clears[lane];
        if (
          current !== undefined &&
          current.generation === clear.generation &&
          current.clearId === clear.clearId
        ) {
          delete session.clears[lane];
        }
        try {
          this.#reject("socket_error", "Browser clear replay failed", sessionId, side);
        } catch {
          // Keep the attachment teardown best effort.
        }
        const attachment = session.attachments[side];
        if (attachment?.socket === socket) {
          const failedSides = new Set<Side>();
          try {
            this.#detach(sessionId, side, attachment, true, failedSides);
          } catch {
            failedSides.add(side);
          }
          try {
            socket.close?.(1008, "Browser clear replay failed");
          } catch {
            failedSides.add(side);
          }
        }
      }
    }
  }

  #receive(sessionId: string, side: Side, data: unknown, isBinary: boolean): void {
    const session = this.#session(sessionId);
    if (isBinary) {
      const bytes = bytesFromMessage(data, CANONICAL_AUDIO.bytesPerFrame);
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

    if (control.type === "participant_readiness") {
      const candidate = control as Record<string, unknown>;
      const microphone = candidate.microphone;
      const headphones = candidate.headphones;
      if (microphone === "stopped" && headphones === "not_attested") {
        if (!session.readiness[side]) return;
        const recorded = this.#offer(session, {
          type: "participant_readiness",
          sessionId,
          side,
          timestampMonoMs: this.#now(),
          microphone: "stopped",
          headphones: "not_attested",
          source: "participant_browser_self_report",
        });
      if (recorded) {
        session.readiness[side] = false;
      } else {
        this.#reject(
          "ingress_overflow",
            "Browser participant readiness could not be recorded",
            sessionId,
            side,
          );
        }
        return;
      }
      if (microphone !== "browser_capture_active" || headphones !== "self_attested") {
        this.#reject(
          "invalid_control",
          "participant_readiness requires active browser capture and headphone self-attestation",
          sessionId,
          side,
        );
        return;
      }
      if (session.readiness[side]) return;
      const recorded = this.#offer(session, {
        type: "participant_readiness",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      });
      if (recorded) {
        session.readiness[side] = true;
      } else {
        this.#reject(
          "ingress_overflow",
          "Browser participant readiness could not be recorded",
          sessionId,
          side,
        );
        const attachment = session.attachments[side];
        if (attachment !== undefined) {
          const failedSides = new Set<Side>();
          try {
            this.#detach(sessionId, side, attachment, true, failedSides);
          } catch {
            failedSides.add(side);
          }
          try {
            attachment.socket.close?.(1013, "Browser media ingress backpressure");
          } catch {
            failedSides.add(side);
          }
        }
      }
      return;
    }

    if (control.type === "queue_sample") {
      const candidate = control as Record<string, unknown>;
      const lane = candidate.lane;
      const generation = candidate.generation;
      const depthFrames = candidate.depthFrames;
      const capacityFrames = candidate.capacityFrames;
      const bufferedAudioMs = candidate.bufferedAudioMs;
      const oldestQueuedAgeMs = candidate.oldestQueuedAgeMs;
      if (
        (lane !== "A_TO_B" && lane !== "B_TO_A") ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        typeof depthFrames !== "number" ||
        !Number.isSafeInteger(depthFrames) ||
        depthFrames < 0 ||
        typeof capacityFrames !== "number" ||
        !Number.isSafeInteger(capacityFrames) ||
        capacityFrames < 1 ||
        depthFrames > capacityFrames ||
        typeof bufferedAudioMs !== "number" ||
        !Number.isFinite(bufferedAudioMs) ||
        bufferedAudioMs < 0 ||
        (oldestQueuedAgeMs !== undefined &&
          (typeof oldestQueuedAgeMs !== "number" ||
            !Number.isFinite(oldestQueuedAgeMs) ||
            oldestQueuedAgeMs < 0)) ||
        destinationForLane(lane) !== side ||
        session.generations[lane] !== generation
      ) {
        this.#reject(
          "invalid_control",
          "queue_sample must describe the current destination lane with bounded non-negative telemetry",
          sessionId,
          side,
        );
        return;
      }
      const recorded = this.#offer(session, {
        type: "queue_sample",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        scope: "browser_playout",
        lane,
        generation,
        depthFrames,
        capacityFrames,
        bufferedAudioMs,
        ...(oldestQueuedAgeMs === undefined ? {} : { oldestQueuedAgeMs }),
      });
      if (!recorded) {
        this.#reject(
          "ingress_overflow",
          "Browser playout queue telemetry could not be recorded",
          sessionId,
          side,
        );
      }
      return;
    }

    if (control.type === "clear_applied") {
      const candidate = control as Record<string, unknown>;
      const lane = candidate.lane;
      const generation = candidate.generation;
      const clearId = candidate.clearId;
      if (
        (lane !== "A_TO_B" && lane !== "B_TO_A") ||
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation < 0 ||
        typeof clearId !== "string" ||
        clearId.trim().length === 0 ||
        clearId.length > 256
      ) {
        this.#reject(
          "invalid_control",
          "clear_applied requires a lane, non-negative generation, and clearId",
          sessionId,
          side,
        );
        return;
      }
      const expected = session.clears[lane];
      if (
        destinationForLane(lane) !== side ||
        expected === undefined ||
        expected.acknowledged ||
        expected.generation !== generation ||
        expected.clearId !== clearId
      ) {
        this.#reject(
          "invalid_control",
          "clear_applied does not match a pending browser playout clear",
          sessionId,
          side,
        );
        return;
      }
      const applied = this.#offer(session, {
        type: "playout_cleared",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        lane,
        generation,
        clearId,
      });
      if (!applied) {
        this.#reject(
          "ingress_overflow",
          "Browser playout clear acknowledgement could not be recorded",
          sessionId,
          side,
        );
        const attachment = session.attachments[side];
        if (attachment !== undefined) {
          const failedSides = new Set<Side>();
          try {
            this.#detach(sessionId, side, attachment, true, failedSides);
          } catch {
            failedSides.add(side);
          }
          try {
            attachment.socket.close?.(1013, "Browser media ingress backpressure");
          } catch {
            failedSides.add(side);
          }
        }
        return;
      }
      expected.acknowledged = true;
      return;
    }

    if (control.type === "playout_started" || control.type === "playout_dropped") {
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
        "Browser control must be participant_readiness, queue_sample, speech_start, speech_end, clear_applied, playout_started, or playout_dropped JSON",
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
    if (session.closed) return false;
    if (event.type === "audio") return session.ingress.offer(event);
    const terminal =
      (event.type === "participant_state" && !event.connected) ||
      (event.type === "participant_readiness" && event.microphone === "stopped");
    const stateful =
      event.type === "playout_cleared" ||
      (event.type === "participant_readiness" &&
        event.microphone === "browser_capture_active");
    const result = session.ingress.offerPriority(
      event,
      (candidate) => {
        if (candidate.type === "audio") return true;
        if (terminal) {
          return !(
            (candidate.type === "participant_state" && !candidate.connected) ||
            (candidate.type === "participant_readiness" && candidate.microphone === "stopped")
          );
        }
        if (event.type === "participant_state" && event.connected) {
          if (candidate.type === "participant_state" && !candidate.connected) return false;
          if (candidate.type === "participant_readiness" && candidate.microphone === "stopped") {
            return candidate.side === event.side;
          }
          return true;
        }
        if (stateful) {
          return candidate.type === "speech_started" ||
            candidate.type === "speech_ended" ||
            candidate.type === "queue_sample" ||
            candidate.type === "alert";
        }
        if (event.type !== "alert") return false;
        return candidate.type === "queue_sample" || candidate.type === "alert";
      },
    );
    return result === "accepted" || result === "evicted";
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
      this.#offer(session, {
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
    failedSides?: Set<Side>,
  ): void {
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.attachments[side] !== attachment) return;
    const wasReady = session.readiness[side];
    if (session.terminalPendingReady.has(side)) {
      for (let index = session.terminalPending.length - 1; index >= 0; index -= 1) {
        if (session.terminalPending[index]?.side === side) session.terminalPending.splice(index, 1);
      }
      session.terminalPendingReady.delete(side);
    }
    if (notify) {
      const terminalEvents: MediaIngressEvent[] = [];
      if (wasReady) {
        terminalEvents.push({
          type: "participant_readiness",
          sessionId,
          side,
          timestampMonoMs: this.#now(),
          microphone: "stopped",
          headphones: "not_attested",
          source: "participant_browser_self_report",
        });
      }
      terminalEvents.push({
        type: "participant_state",
        sessionId,
        side,
        timestampMonoMs: this.#now(),
        connected: false,
      });
      let previousAccepted: MediaIngressEvent | undefined;
      for (const event of terminalEvents) {
        const recorded = this.#offer(session, event);
        if (recorded) {
          previousAccepted = event;
          continue;
        }
        const sameTypeIndex = session.terminalPending.findIndex(
          (pending) => pending.side === side && pending.event.type === event.type,
        );
        const sidePendingCount = session.terminalPending.filter((pending) => pending.side === side).length;
        if (sameTypeIndex >= 0) {
          session.terminalPending[sameTypeIndex] = { side, event };
        } else if (sidePendingCount < MAX_TERMINAL_PENDING_PER_SIDE) {
          session.terminalPending.push({ side, event });
        } else {
          const sideIndex = session.terminalPending.findIndex((pending) => pending.side === side);
          if (sideIndex >= 0) session.terminalPending[sideIndex] = { side, event };
        }
        if (previousAccepted !== undefined && session.terminalAnchors[side] === undefined) {
          session.terminalAnchors[side] = previousAccepted;
        }
      }
    }
    for (const [event, listener] of [
      ["message", attachment.onMessage],
      ["close", attachment.onClose],
      ["error", attachment.onError],
    ] as const) {
      try {
        attachment.socket.off?.(event, listener);
      } catch {
        if (failedSides === undefined) throw new Error("Browser media socket listener removal failed");
        failedSides.add(side);
      }
    }
    delete session.attachments[side];
    session.playback[side]?.pending.clear();
    session.readiness[side] = false;
  }

  async *#withAbort(session: BrowserSession, signal: AbortSignal): AsyncIterable<MediaIngressEvent> {
    const iterator = session.ingress[Symbol.asyncIterator]();
    const takePending = (side?: Side): MediaIngressEvent | undefined => {
      const index = side === undefined
        ? 0
        : session.terminalPending.findIndex((pending) => pending.side === side);
      if (index < 0) return undefined;
      const pending = session.terminalPending.splice(index, 1)[0];
      return pending?.event;
    };
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
        if (session.terminalPendingReady.size > 0) {
          const readySides = [...session.terminalPendingReady];
          session.terminalPendingReady.clear();
          for (const side of readySides) {
            let pending = takePending(side);
            while (pending !== undefined) {
              yield pending;
              pending = takePending(side);
            }
          }
          continue;
        }
        if (Object.keys(session.terminalAnchors).length === 0 &&
          session.terminalPending.length > 0 && session.ingress.size === 0) {
          const pending = takePending();
          if (pending !== undefined) {
            yield pending;
            continue;
          }
        }
        const next = await iterator.next();
        if (next.done) {
          let pending = takePending();
          while (pending !== undefined) {
            yield pending;
            pending = takePending();
          }
          return;
        }
        yield next.value;
        for (const side of ["A", "B"] as const) {
          if (session.terminalAnchors[side] !== next.value) continue;
          delete session.terminalAnchors[side];
          let pending = takePending(side);
          while (pending !== undefined) {
            yield pending;
            pending = takePending(side);
          }
          break;
        }
      }
    } finally {
      signal.removeEventListener("abort", abort);
      await iterator.return?.();
    }
  }
}

import { createAudioFrame, destinationForLane, laneFromSource } from "../../core/audio.js";
import { AsyncQueue } from "../../core/async-queue.js";
import type {
  Lane,
  MediaAlertEvent,
  MediaClearRequest,
  MediaIngressEvent,
  MediaIngressRequest,
  MediaPlaybackRequest,
  MediaPort,
  Side,
} from "../../core/types.js";
import {
  assertTelephonyFrame,
  decodeMulaw8kToPcm16le24k,
  encodePcm16le24kToMulaw8k,
} from "./telephony-codec.js";

export class TelephonyConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelephonyConnectionError";
  }
}

export class TelephonySequenceError extends Error {
  readonly expected: number;
  readonly received: number;

  constructor(expected: number, received: number) {
    super("Expected telephony sequence " + expected + ", received " + received);
    this.name = "TelephonySequenceError";
    this.expected = expected;
    this.received = received;
  }
}

export const TELEPHONY_DTMF_DIGITS = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "#", "A", "B", "C", "D",
] as const;
export type TelephonyDtmfDigit = (typeof TELEPHONY_DTMF_DIGITS)[number];

export interface FakeTelephonyAudio {
  readonly type: "audio";
  readonly generation: number;
  readonly sequence: number;
  readonly mulaw8k: Uint8Array;
}

export interface FakeTelephonyClear {
  readonly type: "clear";
  readonly lane: Lane;
  readonly generation: number;
  readonly clearId: string;
}

export type FakeTelephonyOutbound = FakeTelephonyAudio | FakeTelephonyClear;

export interface FakeTelephonyMediaPortOptions {
  readonly queueCapacity?: number;
  /**
   * Number of future 20 ms PCMU packets retained while waiting for a missing
   * sequence. The default is a deterministic 60 ms window.
   */
  readonly jitterBufferFrames?: number;
  /** Retained closed-session IDs that cannot be reopened by stale fixtures. */
  readonly closedSessionLimit?: number;
  readonly now?: () => number;
}

interface BufferedTelephonyPacket {
  readonly sequence: number;
  readonly mulaw8k: Uint8Array;
  readonly capturedAtMs: number;
}

interface FakeSideState {
  connected: boolean;
  expectedInputSequence: number | undefined;
  readonly jitter: Map<number, BufferedTelephonyPacket>;
  outputSequence: number;
  readonly outbound: FakeTelephonyOutbound[];
}

interface FakeClearState {
  readonly clearId: string;
  readonly generation: number;
  acknowledged: boolean;
}

interface FakeTelephonySession {
  readonly ingress: AsyncQueue<MediaIngressEvent>;
  readonly sides: Record<Side, FakeSideState>;
  readonly generations: Record<Lane, number>;
  readonly clears: Record<Lane, FakeClearState | undefined>;
  closed: boolean;
}

function sideState(): FakeSideState {
  return {
    connected: false,
    expectedInputSequence: undefined,
    jitter: new Map(),
    outputSequence: 0,
    outbound: [],
  };
}

function assertIdentity(sessionId: string, side: Side): void {
  if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
  if (side !== "A" && side !== "B") throw new TypeError("side must be A or B");
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new RangeError("sequence must fit an unsigned 32-bit integer");
  }
}

function assertCapturedAtMs(capturedAtMs: number): void {
  if (!Number.isFinite(capturedAtMs) || capturedAtMs < 0) {
    throw new RangeError("capturedAtMs must be finite and non-negative");
  }
}

function assertDtmfDigit(digit: string): asserts digit is TelephonyDtmfDigit {
  if (!(TELEPHONY_DTMF_DIGITS as readonly string[]).includes(digit)) {
    throw new RangeError("digit must be a DTMF digit (0-9, *, #, or A-D)");
  }
}

function assertAlert(code: string, message: string, retryable: boolean): void {
  if (code.trim().length === 0) throw new TypeError("alert code must not be empty");
  if (message.trim().length === 0) throw new TypeError("alert message must not be empty");
  if (typeof retryable !== "boolean") throw new TypeError("alert retryable must be boolean");
}

function assertClearId(clearId: string): void {
  if (typeof clearId !== "string" || clearId.trim().length === 0 || clearId.length > 256) {
    throw new TypeError("clearId must be a non-empty string of at most 256 characters");
  }
}

export class FakeTelephonyMediaPort implements MediaPort {
  readonly #queueCapacity: number;
  readonly #jitterBufferFrames: number;
  readonly #closedSessionLimit: number;
  readonly #closedSessions = new Set<string>();
  readonly #closedSessionOrder: string[] = [];
  readonly #now: () => number;
  readonly #sessions = new Map<string, FakeTelephonySession>();

  constructor(options: FakeTelephonyMediaPortOptions = {}) {
    this.#queueCapacity = options.queueCapacity ?? 500;
    if (!Number.isSafeInteger(this.#queueCapacity) || this.#queueCapacity < 1) {
      throw new RangeError("queueCapacity must be a positive safe integer");
    }
    this.#jitterBufferFrames = options.jitterBufferFrames ?? 3;
    if (!Number.isSafeInteger(this.#jitterBufferFrames) || this.#jitterBufferFrames < 0) {
      throw new RangeError("jitterBufferFrames must be a non-negative safe integer");
    }
    this.#closedSessionLimit = options.closedSessionLimit ?? 1_000;
    if (!Number.isSafeInteger(this.#closedSessionLimit) || this.#closedSessionLimit < 1) {
      throw new RangeError("closedSessionLimit must be a positive safe integer");
    }
    this.#now = options.now ?? (() => performance.now());
  }

  connect(sessionId: string, side: Side): void {
    assertIdentity(sessionId, side);
    const session = this.#session(sessionId);
    if (session.closed) throw new TelephonyConnectionError("Cannot connect a closed session");
    const state = session.sides[side];
    if (state.connected) return;
    const availableCapacity =
      session.ingress.pendingConsumers + session.ingress.capacity - session.ingress.size;
    if (availableCapacity < 2) {
      throw new TelephonyConnectionError("Telephony ingress queue is closed or full");
    }
    const connected = {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: true,
    } as const;
    const readiness = {
      type: "participant_readiness",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      microphone: "not_applicable",
      headphones: "not_applicable",
      source: "fake_telephony_fixture",
    } as const;
    this.#requireOffer(session, connected);
    this.#requireOffer(session, readiness);
    state.connected = true;
    this.#resetIngress(state);
    state.outputSequence = 0;
  }

  hangup(sessionId: string, side: Side): void {
    assertIdentity(sessionId, side);
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    const state = session.sides[side];
    if (!state.connected) return;
    const disconnected = {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: false,
    } as const;
    this.#requireOffer(session, disconnected, true);
    state.connected = false;
    this.#resetIngress(state);
  }

  reconnect(sessionId: string, side: Side): void {
    assertIdentity(sessionId, side);
    const session = this.#session(sessionId);
    if (session.sides[side].connected) this.hangup(sessionId, side);
    this.connect(sessionId, side);
  }

  speechStarted(sessionId: string, side: Side): void {
    this.#speech(sessionId, side, "speech_started");
  }

  speechEnded(sessionId: string, side: Side): void {
    this.#speech(sessionId, side, "speech_ended");
  }

  ingestMulaw(
    sessionId: string,
    side: Side,
    sequence: number,
    mulaw8k: Uint8Array,
    capturedAtMs = this.#now(),
  ): void {
    assertIdentity(sessionId, side);
    assertSequence(sequence);
    assertTelephonyFrame(mulaw8k);
    assertCapturedAtMs(capturedAtMs);
    const session = this.#session(sessionId);
    const state = session.sides[side];
    if (!state.connected) {
      throw new TelephonyConnectionError("Participant " + side + " is not connected");
    }

    const expected = state.expectedInputSequence;
    if (expected === undefined) {
      state.expectedInputSequence = sequence;
    } else if (sequence < expected || state.jitter.has(sequence)) {
      throw new TelephonySequenceError(expected, sequence);
    } else if (sequence - expected > this.#jitterBufferFrames) {
      this.#offerAlert(
        session,
        sessionId,
        side,
        "telephony_jitter_overflow",
        "Dropped PCMU frame sequence " + sequence +
          "; it exceeds the " + this.#jitterBufferFrames +
          "-frame jitter window while waiting for sequence " + expected,
        true,
        capturedAtMs,
      );
      return;
    }

    state.jitter.set(sequence, Object.freeze({
      sequence,
      mulaw8k: Uint8Array.from(mulaw8k),
      capturedAtMs,
    }));
    this.#drainJitter(session, sessionId, side, state);
  }

  ingestDtmf(
    sessionId: string,
    side: Side,
    digit: TelephonyDtmfDigit,
    capturedAtMs = this.#now(),
  ): void {
    assertIdentity(sessionId, side);
    assertDtmfDigit(digit);
    assertCapturedAtMs(capturedAtMs);
    const session = this.#session(sessionId);
    this.#requireConnected(session, side);
    this.#offerAlert(
      session,
      sessionId,
      side,
      "telephony_dtmf_received",
      "Received DTMF " + digit + " from participant " + side,
      false,
      capturedAtMs,
    );
  }

  emitAlert(
    sessionId: string,
    side: Side,
    code: string,
    message: string,
    retryable: boolean,
    capturedAtMs = this.#now(),
  ): void {
    assertIdentity(sessionId, side);
    assertAlert(code, message, retryable);
    assertCapturedAtMs(capturedAtMs);
    const session = this.#session(sessionId);
    this.#requireConnected(session, side);
    this.#offerAlert(session, sessionId, side, code, message, retryable, capturedAtMs);
  }

  outbound(sessionId: string, side: Side): readonly FakeTelephonyOutbound[] {
    assertIdentity(sessionId, side);
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return Object.freeze([]);
    return Object.freeze(
      session.sides[side].outbound.map((event) =>
        event.type === "audio"
          ? Object.freeze({ ...event, mulaw8k: Uint8Array.from(event.mulaw8k) })
          : Object.freeze({ ...event }),
      ),
    );
  }

  closeSession(sessionId: string): void {
    if (this.#closedSessions.has(sessionId)) return;
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) {
      this.#rememberClosedSession(sessionId);
      return;
    }
    for (const side of ["A", "B"] as const) {
      if (!session.sides[side].connected) continue;
      try {
        this.hangup(sessionId, side);
      } catch {
        // Session closure must still release/tombstone the fixture if a
        // terminal ingress event cannot be admitted.
        session.sides[side].connected = false;
        this.#resetIngress(session.sides[side]);
      }
    }
    session.closed = true;
    session.ingress.close();
    this.#sessions.delete(sessionId);
    this.#rememberClosedSession(sessionId);
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    return this.#withAbort(this.#session(request.sessionId).ingress, request.signal);
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    assertIdentity(request.sessionId, request.side);
    const session = this.#session(request.sessionId);
    const state = session.sides[request.side];
    for await (const frame of request.frames) {
      if (request.signal.aborted || session.closed) break;
      if (!state.connected) continue;
      const output: FakeTelephonyAudio = Object.freeze({
        type: "audio",
        generation: frame.generation,
        sequence: state.outputSequence,
        mulaw8k: encodePcm16le24kToMulaw8k(frame.pcm16le),
      });
      state.outputSequence += 1;
      state.outbound.push(output);
      request.onPlayoutStarted(frame, this.#now());
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
    const connected = session.sides[request.side].connected;
    if (connected) {
      const result = session.ingress.offerPriority(
        {
          type: "playout_cleared",
          sessionId: request.sessionId,
          side: request.side,
          timestampMonoMs: this.#now(),
          lane: request.lane,
          generation: request.generation,
          clearId: request.clearId,
        },
        (candidate) => candidate.type === "audio",
      );
      if (result !== "accepted" && result !== "evicted") {
        throw new TelephonyConnectionError("Telephony ingress queue is closed or full");
      }
    }
    session.generations[request.lane] = request.generation;
    if (previous === undefined || request.generation > previous.generation) {
      session.clears[request.lane] = {
        clearId: request.clearId,
        generation: request.generation,
        acknowledged: false,
      };
    }
    if (connected) {
      session.sides[request.side].outbound.push(Object.freeze({
        type: "clear",
        lane: request.lane,
        generation: request.generation,
        clearId: request.clearId,
      }));
      const current = session.clears[request.lane];
      if (current !== undefined && current.clearId === request.clearId) current.acknowledged = true;
    }
  }

  #session(sessionId: string): FakeTelephonySession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#closedSessions.has(sessionId)) {
      throw new TelephonyConnectionError("Cannot reopen a closed media session");
    }
    if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
    const created: FakeTelephonySession = {
      ingress: new AsyncQueue<MediaIngressEvent>(this.#queueCapacity),
      sides: { A: sideState(), B: sideState() },
      generations: { A_TO_B: 0, B_TO_A: 0 },
      clears: { A_TO_B: undefined, B_TO_A: undefined },
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
      const expired = this.#closedSessionOrder.shift();
      if (expired === undefined) break;
      this.#closedSessions.delete(expired);
    }
  }

  #resetIngress(state: FakeSideState): void {
    state.expectedInputSequence = undefined;
    state.jitter.clear();
  }

  #requireConnected(session: FakeTelephonySession, side: Side): void {
    if (!session.sides[side].connected) {
      throw new TelephonyConnectionError("Participant " + side + " is not connected");
    }
  }

  #drainJitter(
    session: FakeTelephonySession,
    sessionId: string,
    side: Side,
    state: FakeSideState,
  ): void {
    while (state.expectedInputSequence !== undefined) {
      const packet = state.jitter.get(state.expectedInputSequence);
      if (packet === undefined) return;
      const lane = laneFromSource(side);
      const frame = createAudioFrame({
        sessionId,
        lane,
        generation: session.generations[lane],
        sequence: packet.sequence,
        capturedAtMs: packet.capturedAtMs,
        pcm16le: decodeMulaw8kToPcm16le24k(packet.mulaw8k),
      });
      this.#requireOffer(session, {
        type: "audio",
        sessionId,
        side,
        timestampMonoMs: packet.capturedAtMs,
        frame,
      });
      state.jitter.delete(packet.sequence);
      state.expectedInputSequence += 1;
    }
  }

  #speech(
    sessionId: string,
    side: Side,
    type: "speech_started" | "speech_ended",
  ): void {
    assertIdentity(sessionId, side);
    const session = this.#session(sessionId);
    if (!session.sides[side].connected) {
      throw new TelephonyConnectionError("Participant " + side + " is not connected");
    }
    this.#requireOffer(session, {
      type,
      sessionId,
      side,
      timestampMonoMs: this.#now(),
    });
  }

  #offerAlert(
    session: FakeTelephonySession,
    sessionId: string,
    side: Side,
    code: string,
    message: string,
    retryable: boolean,
    timestampMonoMs: number,
  ): void {
    const event: MediaAlertEvent = {
      type: "alert",
      sessionId,
      side,
      timestampMonoMs,
      code,
      message,
      retryable,
    };
    this.#requireOffer(session, event);
  }

  #requireOffer(
    session: FakeTelephonySession,
    event: MediaIngressEvent,
    preserveTeardown = false,
  ): void {
    if (session.closed) {
      throw new TelephonyConnectionError("Telephony ingress queue is closed or full");
    }
    let result: "accepted" | "evicted" | "full" | "closed";
    if (event.type === "audio") {
      result = session.ingress.offer(event) ? "accepted" : "full";
    } else {
      result = session.ingress.offerPriority(event, (candidate) => candidate.type === "audio");
      if (preserveTeardown && result === "full") {
        result = session.ingress.offerPriority(event, (candidate) => {
          if (candidate.type === "participant_state") return candidate.connected;
          if (candidate.type === "participant_readiness") {
            return candidate.microphone !== "stopped";
          }
          return candidate.type !== "audio";
        });
      }
    }
    if (result !== "accepted" && result !== "evicted") {
      throw new TelephonyConnectionError("Telephony ingress queue is closed or full");
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

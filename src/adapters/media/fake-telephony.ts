import { createAudioFrame, laneFromSource } from "../../core/audio.js";
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

export interface FakeTelephonyAudio {
  readonly type: "audio";
  readonly generation: number;
  readonly sequence: number;
  readonly mulaw8k: Uint8Array;
}

export interface FakeTelephonyClear {
  readonly type: "clear";
  readonly generation: number;
}

export type FakeTelephonyOutbound = FakeTelephonyAudio | FakeTelephonyClear;

export interface FakeTelephonyMediaPortOptions {
  readonly queueCapacity?: number;
  readonly now?: () => number;
}

interface FakeSideState {
  connected: boolean;
  lastInputSequence: number | undefined;
  outputSequence: number;
  readonly outbound: FakeTelephonyOutbound[];
}

interface FakeTelephonySession {
  readonly ingress: AsyncQueue<MediaIngressEvent>;
  readonly sides: Record<Side, FakeSideState>;
  readonly generations: Record<Lane, number>;
  closed: boolean;
}

function sideState(): FakeSideState {
  return {
    connected: false,
    lastInputSequence: undefined,
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

export class FakeTelephonyMediaPort implements MediaPort {
  readonly #queueCapacity: number;
  readonly #now: () => number;
  readonly #sessions = new Map<string, FakeTelephonySession>();

  constructor(options: FakeTelephonyMediaPortOptions = {}) {
    this.#queueCapacity = options.queueCapacity ?? 500;
    if (!Number.isSafeInteger(this.#queueCapacity) || this.#queueCapacity < 1) {
      throw new RangeError("queueCapacity must be a positive safe integer");
    }
    this.#now = options.now ?? (() => performance.now());
  }

  connect(sessionId: string, side: Side): void {
    assertIdentity(sessionId, side);
    const session = this.#session(sessionId);
    if (session.closed) throw new TelephonyConnectionError("Cannot connect a closed session");
    const state = session.sides[side];
    if (state.connected) return;
    state.connected = true;
    state.lastInputSequence = undefined;
    state.outputSequence = 0;
    this.#requireOffer(session, {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: true,
    });
  }

  hangup(sessionId: string, side: Side): void {
    assertIdentity(sessionId, side);
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    const state = session.sides[side];
    if (!state.connected) return;
    state.connected = false;
    state.lastInputSequence = undefined;
    this.#requireOffer(session, {
      type: "participant_state",
      sessionId,
      side,
      timestampMonoMs: this.#now(),
      connected: false,
    });
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
    const session = this.#session(sessionId);
    const state = session.sides[side];
    if (!state.connected) {
      throw new TelephonyConnectionError("Participant " + side + " is not connected");
    }
    const expected =
      state.lastInputSequence === undefined ? sequence : state.lastInputSequence + 1;
    if (sequence !== expected) throw new TelephonySequenceError(expected, sequence);

    const lane = laneFromSource(side);
    const frame = createAudioFrame({
      sessionId,
      lane,
      generation: session.generations[lane],
      sequence,
      capturedAtMs,
      pcm16le: decodeMulaw8kToPcm16le24k(mulaw8k),
    });
    this.#requireOffer(session, {
      type: "audio",
      sessionId,
      side,
      timestampMonoMs: capturedAtMs,
      frame,
    });
    state.lastInputSequence = sequence;
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
    const session = this.#sessions.get(sessionId);
    if (session === undefined || session.closed) return;
    for (const side of ["A", "B"] as const) {
      if (session.sides[side].connected) this.hangup(sessionId, side);
    }
    session.closed = true;
    session.ingress.close();
    this.#sessions.delete(sessionId);
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
    const session = this.#session(request.sessionId);
    session.generations[request.lane] = request.generation;
    if (session.sides[request.side].connected) {
      session.sides[request.side].outbound.push(Object.freeze({
        type: "clear",
        generation: request.generation,
      }));
    }
  }

  #session(sessionId: string): FakeTelephonySession {
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (sessionId.trim().length === 0) throw new TypeError("sessionId must not be empty");
    const created: FakeTelephonySession = {
      ingress: new AsyncQueue<MediaIngressEvent>(this.#queueCapacity),
      sides: { A: sideState(), B: sideState() },
      generations: { A_TO_B: 0, B_TO_A: 0 },
      closed: false,
    };
    this.#sessions.set(sessionId, created);
    return created;
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

  #requireOffer(session: FakeTelephonySession, event: MediaIngressEvent): void {
    if (session.closed || !session.ingress.offer(event)) {
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

import type { Lane, Side } from "./types.js";

export const CANONICAL_AUDIO = Object.freeze({
  encoding: "pcm16le" as const,
  sampleRateHz: 24_000,
  channels: 1 as const,
  frameDurationMs: 20,
  samplesPerFrame: 480,
  bytesPerFrame: 960,
});

export type CanonicalAudioFormat = typeof CANONICAL_AUDIO;

export interface AudioFrame {
  readonly sessionId: string;
  readonly lane: Lane;
  readonly generation: number;
  readonly sequence: number;
  readonly capturedAtMs: number;
  readonly pcm16le: Uint8Array;
  readonly format: CanonicalAudioFormat;
}

export type AudioFrameInput = Omit<AudioFrame, "format" | "pcm16le"> & {
  readonly pcm16le: Uint8Array<ArrayBufferLike>;
};

export class AudioFrameValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "AudioFrameValidationError";
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AudioFrameValidationError(`${field} must be a non-negative safe integer`);
  }
}

export function createAudioFrame(input: AudioFrameInput): AudioFrame {
  if (input.sessionId.trim().length === 0) {
    throw new AudioFrameValidationError("sessionId must not be empty");
  }
  if (input.lane !== "A_TO_B" && input.lane !== "B_TO_A") {
    throw new AudioFrameValidationError("lane must be A_TO_B or B_TO_A");
  }
  assertNonNegativeSafeInteger(input.generation, "generation");
  assertNonNegativeSafeInteger(input.sequence, "sequence");
  if (!Number.isFinite(input.capturedAtMs) || input.capturedAtMs < 0) {
    throw new AudioFrameValidationError("capturedAtMs must be finite and non-negative");
  }
  if (!(input.pcm16le instanceof Uint8Array) || input.pcm16le.byteLength !== CANONICAL_AUDIO.bytesPerFrame) {
    throw new AudioFrameValidationError(
      `pcm16le must contain exactly ${CANONICAL_AUDIO.bytesPerFrame} bytes`,
    );
  }

  return Object.freeze({
    sessionId: input.sessionId,
    lane: input.lane,
    generation: input.generation,
    sequence: input.sequence,
    capturedAtMs: input.capturedAtMs,
    pcm16le: Uint8Array.from(input.pcm16le),
    format: CANONICAL_AUDIO,
  });
}

export function laneFromSource(side: Side): Lane {
  return side === "A" ? "A_TO_B" : "B_TO_A";
}

export function sourceForLane(lane: Lane): Side {
  return lane === "A_TO_B" ? "A" : "B";
}

export function destinationForLane(lane: Lane): Side {
  return lane === "A_TO_B" ? "B" : "A";
}

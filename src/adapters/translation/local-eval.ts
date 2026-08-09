import { createHash } from "node:crypto";
import { CANONICAL_AUDIO, type AudioFrame } from "../../core/audio.js";
import type {
  GenerationRef,
  Lane,
  TranslationFallbackPolicy,
  TranslationPreparation,
  TranslationPort,
} from "../../core/types.js";
import {
  ControlledTranslationAdapter,
  type ControlledTranscriptionEvent,
  type ControlledTranscriptionPort,
  type ControlledTranscriptionRequest,
  type ControlledTtsPort,
  type ControlledTtsRequest,
  type ControlledTextTranslationPort,
  type ControlledTextTranslationRequest,
} from "./glossary-controlled.js";

export const LOCAL_EVAL_PCM_CONTRACT = CANONICAL_AUDIO;

const FIXTURE_LOCAL_PREPARATION: TranslationPreparation = Object.freeze({
  readiness: "fixture_local",
  remoteConnection: "not_applicable",
});
const NO_SOURCE_SUBSTITUTION: TranslationFallbackPolicy = Object.freeze({
  kind: "none",
});

export type LocalEvalTranslationMode = "preserve" | "drop_placeholders";

export interface LocalEvalTranslationOptions {
  readonly transcriptByLane: Readonly<Record<Lane, string>>;
  readonly confidence?: number;
  readonly translationMode?: LocalEvalTranslationMode;
  readonly audioFixture?: readonly Uint8Array[];
  readonly minimumConfidence?: number;
  readonly now?: () => number;
}

/**
 * Builds the provider-free controlled terminology profile. The transcript and
 * PCM output are deterministic fixtures: this proves Harness, glossary, alert,
 * and playout behavior, but deliberately makes no acoustic STT or TTS claim.
 */
export function createLocalEvalTranslationAdapter(
  options: LocalEvalTranslationOptions,
): TranslationPort {
  const transcriptByLane = Object.freeze({
    A_TO_B: requiredTranscript(options.transcriptByLane.A_TO_B, "A_TO_B"),
    B_TO_A: requiredTranscript(options.transcriptByLane.B_TO_A, "B_TO_A"),
  });
  const confidence = options.confidence ?? 0.99;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new RangeError("local_eval confidence must be between 0 and 1");
  }
  const translationMode = options.translationMode ?? "preserve";
  const now = options.now ?? (() => performance.now());

  return new ControlledTranslationAdapter({
    transcriber: new TranscriptFixtureAdapter(transcriptByLane, confidence, now),
    translator: new TranslationFixtureAdapter(translationMode),
    tts: new PcmFixtureAdapter(options.audioFixture),
    preparation: FIXTURE_LOCAL_PREPARATION,
    fallback: NO_SOURCE_SUBSTITUTION,
    evidenceRefSource: "local_eval",
    ...(options.minimumConfidence === undefined
      ? {}
      : { minimumConfidence: options.minimumConfidence }),
    now,
  });
}

class TranscriptFixtureAdapter implements ControlledTranscriptionPort {
  readonly #transcriptByLane: Readonly<Record<Lane, string>>;
  readonly #confidence: number;
  readonly #now: () => number;

  constructor(
    transcriptByLane: Readonly<Record<Lane, string>>,
    confidence: number,
    now: () => number,
  ) {
    this.#transcriptByLane = transcriptByLane;
    this.#confidence = confidence;
    this.#now = now;
  }

  async *transcribe(
    request: ControlledTranscriptionRequest,
  ): AsyncIterable<ControlledTranscriptionEvent> {
    let sawAudio = false;
    let turnId = request.context.turnId;
    for await (const event of request.events) {
      if (request.signal.aborted) return;
      if (event.type === "speech_end") {
        turnId = event.turnId;
        continue;
      }
      sawAudio = true;
      if (!isCanonicalFrame(event.frame)) {
        yield fixtureError(
          request.context,
          "LOCAL_EVAL_NON_CANONICAL_AUDIO",
          "local_eval accepts only 24 kHz mono PCM16LE in 20 ms frames.",
          this.#now(),
        );
        return;
      }
    }
    if (request.signal.aborted) return;
    if (!sawAudio) {
      yield fixtureError(
        request.context,
        "LOCAL_EVAL_NO_AUDIO",
        "local_eval did not receive an audio frame for this turn.",
        this.#now(),
      );
      return;
    }

    const transcript = this.#transcriptByLane[request.context.lane];
    const eventBase = {
      sessionId: request.context.sessionId,
      lane: request.context.lane,
      generation: request.context.generation,
      itemId: "local-eval-item-" + request.context.generation,
      turnId,
    } as const;
    yield {
      ...eventBase,
      type: "transcript_delta",
      emittedAtMs: this.#now(),
      delta: transcript,
    };
    yield {
      ...eventBase,
      type: "transcript_completed",
      emittedAtMs: this.#now(),
      transcript,
      confidence: this.#confidence,
    };
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
}

class TranslationFixtureAdapter implements ControlledTextTranslationPort {
  readonly #mode: LocalEvalTranslationMode;

  constructor(mode: LocalEvalTranslationMode) {
    this.#mode = mode;
  }

  async translate(request: ControlledTextTranslationRequest): Promise<string> {
    if (request.signal?.aborted === true) throw request.signal.reason;
    if (this.#mode === "preserve") return request.text;

    let text = request.text;
    for (const token of request.opaqueTokens ?? []) {
      text = text.replaceAll(token, "");
    }
    return text;
  }
}

class PcmFixtureAdapter implements ControlledTtsPort {
  readonly outputFormat = CANONICAL_AUDIO;
  readonly #audioFixture?: readonly Uint8Array[];

  constructor(audioFixture: readonly Uint8Array[] | undefined) {
    if (audioFixture === undefined) return;
    this.#audioFixture = Object.freeze(audioFixture.map((frame, index) => {
      if (!(frame instanceof Uint8Array) || frame.byteLength !== CANONICAL_AUDIO.bytesPerFrame) {
        throw new TypeError(
          `local_eval audioFixture[${index}] must be one canonical ${CANONICAL_AUDIO.bytesPerFrame}-byte frame`,
        );
      }
      return Uint8Array.from(frame);
    }));
  }

  async *synthesize(request: ControlledTtsRequest): AsyncIterable<Uint8Array> {
    const fixture = this.#audioFixture ?? deterministicPcm(request.text);
    for (const frame of fixture) {
      if (request.signal?.aborted === true) return;
      yield Uint8Array.from(frame);
    }
  }
}

function requiredTranscript(value: string, lane: Lane): string {
  const transcript = value.normalize("NFKC").trim();
  if (transcript.length === 0) throw new TypeError(`local_eval ${lane} transcript must not be empty`);
  return transcript;
}

function isCanonicalFrame(frame: AudioFrame): boolean {
  return frame.format.encoding === CANONICAL_AUDIO.encoding &&
    frame.format.sampleRateHz === CANONICAL_AUDIO.sampleRateHz &&
    frame.format.channels === CANONICAL_AUDIO.channels &&
    frame.format.frameDurationMs === CANONICAL_AUDIO.frameDurationMs &&
    frame.format.samplesPerFrame === CANONICAL_AUDIO.samplesPerFrame &&
    frame.format.bytesPerFrame === CANONICAL_AUDIO.bytesPerFrame &&
    frame.pcm16le.byteLength === CANONICAL_AUDIO.bytesPerFrame;
}

function fixtureError(
  generation: GenerationRef,
  code: string,
  message: string,
  emittedAtMs: number,
): ControlledTranscriptionEvent {
  return {
    type: "error",
    sessionId: generation.sessionId,
    lane: generation.lane,
    generation: generation.generation,
    emittedAtMs,
    error: { code, message, retryable: false },
  };
}

function deterministicPcm(text: string): readonly Uint8Array[] {
  const digest = createHash("sha256").update(text, "utf8").digest();
  const frequencyHz = 360 + (digest[0] ?? 0);
  const frames: Uint8Array[] = [];
  let sampleOffset = 0;
  for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
    const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
    const view = new DataView(pcm.buffer);
    for (let sample = 0; sample < CANONICAL_AUDIO.samplesPerFrame; sample += 1) {
      const phase = 2 * Math.PI * frequencyHz * (sampleOffset + sample) /
        CANONICAL_AUDIO.sampleRateHz;
      view.setInt16(sample * 2, Math.round(Math.sin(phase) * 2_000), true);
    }
    sampleOffset += CANONICAL_AUDIO.samplesPerFrame;
    frames.push(pcm);
  }
  return Object.freeze(frames);
}

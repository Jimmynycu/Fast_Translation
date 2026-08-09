import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FakeTelephonyMediaPort } from "../../src/adapters/media/fake-telephony.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../../src/core/audio.js";
import { ModularGuardedDuplexRelay } from "../../src/core/relay.js";
import { resolveTranslationBehavior } from "../../src/core/translation-behavior.js";
import { createMediaRuntime } from "../../src/media-runtime.js";
import { createServerAccessControl } from "../../src/server/access.js";
import {
  createServerApp,
  type GlossaryRegistry,
} from "../../src/server/app.js";
import type {
  AudioFrame,
  EvidencePort,
  EvidenceRecord,
  EvidenceAudioTrack,
  GenerationRef,
  Lane,
  LaneContext,
  TranslationCapabilities,
  TranslationEvent,
  TranslationPort,
  TranslationRequest,
} from "../../src/core/types.js";

/**
 * The product modes are exercised against the same deterministic adapter. This
 * is intentionally a mechanism test surface, never a claim about a live
 * provider.
 */
export const ACCEPTANCE_MODES = ["fast", "balanced", "accurate"] as const;
export type AcceptanceMode = (typeof ACCEPTANCE_MODES)[number];

interface DeferredGate {
  readonly reached: Promise<void>;
  readonly markReached: () => void;
  readonly release: () => void;
  readonly wait: Promise<void>;
}

function deferredGate(): DeferredGate {
  let markReached!: () => void;
  let openGate!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return {
    reached,
    markReached,
    release: openGate,
    wait,
  };
}

function acceptanceCapabilities(): TranslationCapabilities {
  return Object.freeze({
    providerId: "openai_controlled",
    supportedModes: Object.freeze(ACCEPTANCE_MODES.map((mode) => {
      const behavior = resolveTranslationBehavior(mode);
      return Object.freeze({
        mode,
        behaviorVersion: behavior.version,
        deterministicGlossary: behavior.requirements.deterministicGlossary,
      });
    })),
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: true,
  });
}

export function acceptanceServerTranslation(
  defaultMode: AcceptanceMode = "balanced",
): TranslationCapabilities & Readonly<{ defaultMode: AcceptanceMode }> {
  return Object.freeze({ ...acceptanceCapabilities(), defaultMode });
}

const emptyGlossaries: GlossaryRegistry = Object.freeze({
  async importFile() {
    throw new Error("The keyless acceptance harness does not import glossaries");
  },
  async get() {
    return undefined;
  },
});

/**
 * Deterministic test-only adapter. It deliberately emits a post-cancellation
 * event when held so acceptance tests prove that the relay, not an adapter,
 * owns the generation fence.
 */
export class DeterministicAcceptanceTranslation implements TranslationPort {
  readonly capabilities = acceptanceCapabilities();
  readonly prepared: LaneContext[] = [];
  readonly requests: LaneContext[] = [];
  readonly receivedFrames: AudioFrame[] = [];
  readonly cancelled: GenerationRef[] = [];
  readonly closedSessionIds: string[] = [];
  readonly #nextFrameGate = new Map<Lane, DeferredGate>();
  readonly #heldFrameGate = new Map<Lane, DeferredGate>();

  holdNextFrame(lane: Lane): void {
    if (this.#nextFrameGate.has(lane)) {
      throw new Error("A deterministic acceptance gate is already armed for " + lane);
    }
    this.#nextFrameGate.set(lane, deferredGate());
  }

  async waitForHeldFrame(lane: Lane): Promise<void> {
    const gate = this.#heldFrameGate.get(lane) ?? this.#nextFrameGate.get(lane);
    if (gate === undefined) throw new Error("No deterministic acceptance gate is armed for " + lane);
    await gate.reached;
  }

  releaseHeldFrame(lane: Lane): void {
    const gate = this.#heldFrameGate.get(lane) ?? this.#nextFrameGate.get(lane);
    if (gate === undefined) throw new Error("No deterministic acceptance gate is armed for " + lane);
    this.#heldFrameGate.delete(lane);
    this.#nextFrameGate.delete(lane);
    gate.release();
  }

  async prepare(context: LaneContext): Promise<void> {
    this.prepared.push(structuredClone(context));
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    this.requests.push(structuredClone(request.context));
    const buffered: AudioFrame[] = [];
    let ordinal = 0;

    for await (const frame of request.frames) {
      const canonical = createAudioFrame({
        ...frame,
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
      });
      this.receivedFrames.push(canonical);
      const gate = this.#nextFrameGate.get(request.context.lane);
      if (gate !== undefined) {
        this.#nextFrameGate.delete(request.context.lane);
        this.#heldFrameGate.set(request.context.lane, gate);
        // The gate is intentionally released after relay cancellation in the
        // stale-generation test, so this adapter may emit a late provider event.
        // That verifies the relay fence rather than adapter co-operation.
        gate.markReached();
        await gate.wait;
        this.#heldFrameGate.delete(request.context.lane);
      }
      if (request.context.behavior.inputCommit === "speech_end") {
        buffered.push(canonical);
        continue;
      }
      yield* this.#eventsForFrame(request.context, canonical, ordinal);
      ordinal += 1;
    }

    for (const frame of buffered) {
      yield* this.#eventsForFrame(request.context, frame, ordinal);
      ordinal += 1;
    }
    yield this.#completed(request.context, ordinal);
  }

  async cancel(generation: GenerationRef): Promise<void> {
    this.cancelled.push(structuredClone(generation));
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closedSessionIds.push(sessionId);
  }

  *#eventsForFrame(
    context: LaneContext,
    frame: AudioFrame,
    ordinal: number,
  ): Iterable<TranslationEvent> {
    const prefix = context.turnId + ":" + ordinal;
    const source = "[" + context.behavior.mode + " source " + context.lane + " " + ordinal + "]";
    const target = "[" + context.behavior.mode + " target " + context.lane + " " + ordinal + "]";
    const base = {
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      emittedAtMs: performance.now(),
    } as const;

    if (context.behavior.transcriptPolicy === "provisional_revisions") {
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 0,
        finality: "provisional",
        text: source + " draft",
      };
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 1,
        finality: "final",
        text: source + " replacement",
      };
      // A provider must not be able to revise a terminal segment. The relay
      // must discard this deliberately invalid late revision.
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 2,
        finality: "provisional",
        text: source + " rejected-after-final",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 0,
        finality: "provisional",
        text: target + " draft",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 1,
        finality: "final",
        text: target + " replacement",
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 2,
        finality: "provisional",
        text: target + " rejected-after-final",
      };
    } else {
      yield {
        ...base,
        kind: "source_transcript",
        segmentId: prefix + ":source",
        revision: 0,
        finality: "final",
        text: source,
      };
      yield {
        ...base,
        kind: "target_transcript",
        segmentId: prefix + ":target",
        revision: 0,
        finality: "final",
        text: target,
      };
    }

    yield {
      ...base,
      kind: "audio",
      segmentId: prefix + ":audio",
      revision: 0,
      finality: "final",
      playoutSequence: ordinal,
      frame,
    };
  }

  #completed(context: LaneContext, ordinal: number): TranslationEvent {
    return {
      kind: "completed",
      sessionId: context.sessionId,
      lane: context.lane,
      generation: context.generation,
      turnId: context.turnId,
      segmentId: context.turnId + ":completed",
      revision: ordinal,
      finality: "final",
      emittedAtMs: performance.now(),
    };
  }
}

export class AcceptanceEvidence implements EvidencePort {
  readonly records: EvidenceRecord[] = [];
  readonly closedSessionIds: string[] = [];

  record(record: EvidenceRecord): boolean {
    this.records.push(structuredClone(record));
    return true;
  }

  async close(sessionId: string): Promise<void> {
    this.closedSessionIds.push(sessionId);
  }

  audioTracks(sessionId: string): readonly EvidenceAudioTrack[] {
    return Object.freeze([
      ...new Set(this.records
        .filter((record): record is Extract<EvidenceRecord, { type: "audio" }> =>
          record.type === "audio" && record.sessionId === sessionId
        )
        .map((record) => record.track)),
    ].sort());
  }
}

/**
 * Direct-port fixture for deterministic relay acceptance. It keeps the
 * provider, evidence, and media entirely in-process so no live provider key
 * or encrypted evidence key is needed.
 */
export function createKeylessTelephonyAcceptanceFixture(): Readonly<{
  readonly media: FakeTelephonyMediaPort;
  readonly translation: DeterministicAcceptanceTranslation;
  readonly evidence: AcceptanceEvidence;
  readonly relay: ModularGuardedDuplexRelay;
}> {
  const media = new FakeTelephonyMediaPort();
  const translation = new DeterministicAcceptanceTranslation();
  const evidence = new AcceptanceEvidence();
  const relay = new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    endpointGrant: (sessionId, side) => ({
      kind: "telephony_test",
      side,
      address: "acceptance-telephony://" + encodeURIComponent(sessionId) + "/" + side,
    }),
  });
  return Object.freeze({ media, translation, evidence, relay });
}

/**
 * Real HTTP/WebSocket fixture backed by the same deterministic translation
 * port. The generated token authenticates only this process and is never a
 * provider credential.
 */
export async function createKeylessBrowserAcceptanceApplication(
  origin: string,
  defaultMode: AcceptanceMode = "fast",
) {
  const operatorToken = "acceptance-" + randomUUID() + randomUUID();
  const access = createServerAccessControl({ operatorToken });
  const mediaRuntime = createMediaRuntime({
    profile: "browser_pair",
    publicBaseUrl: new URL(origin),
    access,
  });
  if (mediaRuntime.browserGateway === undefined) {
    throw new Error("The browser acceptance fixture requires a browser media gateway");
  }
  const translation = new DeterministicAcceptanceTranslation();
  const evidence = new AcceptanceEvidence();
  const relay = new ModularGuardedDuplexRelay({
    media: mediaRuntime.port,
    translation,
    evidence,
    endpointGrant: mediaRuntime.endpointGrant,
  });
  const app = await createServerApp({
    relay,
    glossaries: emptyGlossaries,
    mediaProfile: "browser_pair",
    browserMedia: mediaRuntime.browserGateway,
    access,
    translation: acceptanceServerTranslation(defaultMode),
    logger: false,
  });
  return Object.freeze({
    app,
    access,
    operatorToken,
    media: mediaRuntime.browserGateway,
    translation,
    evidence,
    relay,
  });
}

export async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

export function acceptanceTemporaryDirectory(name: string): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "acceptance-harness",
    name + "-" + randomUUID(),
  );
}

export function canonicalWav(frameCount = 2): Uint8Array {
  const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * frameCount);
  const pcmView = new DataView(pcm.buffer);
  for (let sample = 0; sample < pcm.byteLength / 2; sample += 1) {
    pcmView.setInt16(sample * 2, Math.round(Math.sin(sample / 12) * 3_000), true);
  }

  const wav = new Uint8Array(44 + pcm.byteLength);
  const buffer = Buffer.from(wav.buffer);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + pcm.byteLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz, 24);
  buffer.writeUInt32LE(CANONICAL_AUDIO.sampleRateHz * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

export function localEvalManifest(wav: Uint8Array): Readonly<Record<string, unknown>> {
  const wavSha256 = createHash("sha256").update(wav).digest("hex");
  const sourceGlossary = "id,source,target_exact\nacceptance-term,acceptance term,驗收術語\n";
  return Object.freeze({
    schemaVersion: 3,
    generatedAtUtc: "2026-08-09T00:00:00.000Z",
    generator: "acceptance-harness",
    voice: "deterministic test tone",
    language: "en-US",
    audio: {
      container: "wav",
      encoding: "pcm_s16le",
      sampleRateHz: CANONICAL_AUDIO.sampleRateHz,
      channels: CANONICAL_AUDIO.channels,
      bitsPerSample: 16,
    },
    sourceGlossary: "acceptance-terms.csv",
    sourceGlossarySha256: createHash("sha256").update(sourceGlossary).digest("hex"),
    fixtures: [{
      fixtureId: "acceptance-source-public",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "source",
      visibility: "public",
      expectation: "target_exact_present",
      phrase: "acceptance term",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-reverse-public",
      entryId: "acceptance-term",
      direction: "B_TO_A",
      phraseKind: "source",
      visibility: "public",
      expectation: "target_exact_present",
      phrase: "驗收術語",
      targetExact: "acceptance term",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-alias-holdout",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "alias",
      visibility: "holdout",
      expectation: "target_exact_present",
      phrase: "acceptance expression",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }, {
      fixtureId: "acceptance-confuser-holdout",
      entryId: "acceptance-term",
      direction: "A_TO_B",
      phraseKind: "confuser",
      visibility: "holdout",
      expectation: "target_exact_absent",
      phrase: "unrelated expression",
      targetExact: "驗收術語",
      wavPath: "acceptance.wav",
      wavSha256,
    }],
  });
}

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { InMemoryEvidenceStore } from "../adapters/evidence/in-memory.js";
import { FakeTelephonyMediaPort } from "../adapters/media/fake-telephony.js";
import { encodePcm16le24kToMulaw8k } from "../adapters/media/telephony-codec.js";
import { createLocalEvalTranslationAdapter } from "../adapters/translation/local-eval.js";
import { CANONICAL_AUDIO } from "../core/audio.js";
import type { GlossarySpec } from "../core/glossary.js";
import { ModularGuardedDuplexRelay } from "../core/relay.js";
import { assertManifestFixturePath } from "./path-safety.js";
import type {
  EvidenceRecord,
  SessionEvent,
} from "../core/types.js";

const MAX_WAV_BYTES = 50 * 1024 * 1024;
const OUTCOME_TIMEOUT_MS = 5_000;

const fixtureSchema = z.object({
  fixtureId: z.string().trim().min(1).max(200),
  entryId: z.string().trim().min(1).max(200),
  phraseKind: z.enum(["source", "alias"]),
  phrase: z.string().trim().min(1).max(4_096),
  targetExact: z.string().trim().min(1).max(4_096),
  wavPath: z.string().trim().min(1).max(255).refine(
    (value) => basename(value) === value && value.toLowerCase().endsWith(".wav"),
    "wavPath must be a WAV filename in the manifest directory",
  ),
  wavSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAtUtc: z.string().min(1),
  generator: z.string().min(1),
  voice: z.string().min(1),
  language: z.string().min(1),
  audio: z.object({
    container: z.literal("wav"),
    encoding: z.literal("pcm_s16le"),
    sampleRateHz: z.literal(CANONICAL_AUDIO.sampleRateHz),
    channels: z.literal(CANONICAL_AUDIO.channels),
    bitsPerSample: z.literal(16),
  }),
  sourceGlossary: z.string().min(1),
  fixtures: z.array(fixtureSchema).min(1).max(500),
});

type CorpusManifest = z.infer<typeof manifestSchema>;
type CorpusFixture = CorpusManifest["fixtures"][number];

export interface LocalEvalReplayOptions {
  readonly manifestPath: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
}

export interface LocalEvalReplayAlert {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface LocalEvalReplayFixtureResult {
  readonly fixtureId: string;
  readonly entryId: string;
  readonly phraseKind: "source" | "alias";
  readonly fixtureTranscript: string;
  readonly expectedTargetExact: string;
  readonly observedSourceFinal?: string;
  readonly observedTargetFinal?: string;
  readonly sourceTranscriptMatched: boolean;
  readonly targetExactMatched: boolean;
  readonly glossaryAuthorized: boolean;
  readonly sourceAudioFrames: number;
  readonly playoutAudioFrames: number;
  readonly telephonyOutputFrames: number;
  readonly alerts: readonly LocalEvalReplayAlert[];
  readonly timedOut: boolean;
  readonly passed: boolean;
}

export interface LocalEvalReplayReport {
  readonly schemaVersion: 1;
  readonly generatedAtUtc: string;
  readonly mode: "fixture_transcript_harness_replay";
  readonly claims: Readonly<{
    readonly transcriptSource: "manifest_fixture_text";
    readonly fixtureTranscriptInjected: true;
    readonly acousticSttEvaluated: false;
    readonly providerCalls: 0;
    readonly mediaPath: "wav_pcm16le24k_to_mulaw8k_to_fake_telephony_to_harness";
    readonly outputSpeech: "deterministic_local_pcm_fixture";
  }>;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly glossary: Readonly<{
    readonly id: string;
    readonly version: string;
    readonly entries: number;
  }>;
  readonly summary: Readonly<{
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  }>;
  readonly fixtures: readonly LocalEvalReplayFixtureResult[];
}

interface LoadedFixture {
  readonly fixture: CorpusFixture;
  readonly frames: readonly Uint8Array[];
}

interface ObservedOutcome {
  readonly sourceFinal?: string;
  readonly targetFinal?: string;
  readonly glossaryAuthorized: boolean;
  readonly sourceAudioFrames: number;
  readonly playoutAudioFrames: number;
  readonly telephonyOutputFrames: number;
  readonly alerts: readonly LocalEvalReplayAlert[];
}

function requiredLanguage(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0) throw new TypeError(label + " must not be empty");
  return normalized;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function chunkName(bytes: Uint8Array, offset: number): string {
  return Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii");
}

export function parseCanonicalWav(bytes: Uint8Array): readonly Uint8Array[] {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
    throw new TypeError("WAV fixture is missing or too short");
  }
  if (bytes.byteLength > MAX_WAV_BYTES) {
    throw new RangeError("WAV fixture exceeds the 50 MiB local evaluation limit");
  }
  if (chunkName(bytes, 0) !== "RIFF" || chunkName(bytes, 8) !== "WAVE") {
    throw new TypeError("WAV fixture must use a RIFF/WAVE container");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffSize = uint32(view, 4);
  if (riffSize + 8 > bytes.byteLength) {
    throw new TypeError("WAV RIFF size exceeds the file length");
  }

  let formatSeen = false;
  let pcm: Uint8Array | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const name = chunkName(bytes, offset);
    const size = uint32(view, offset + 4);
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + size;
    if (dataEnd > bytes.byteLength) {
      throw new TypeError("WAV chunk exceeds the file length");
    }

    if (name === "fmt ") {
      if (size < 16) throw new TypeError("WAV fmt chunk is too short");
      const audioFormat = view.getUint16(dataOffset, true);
      const channels = view.getUint16(dataOffset + 2, true);
      const sampleRateHz = view.getUint32(dataOffset + 4, true);
      const byteRate = view.getUint32(dataOffset + 8, true);
      const blockAlign = view.getUint16(dataOffset + 12, true);
      const bitsPerSample = view.getUint16(dataOffset + 14, true);
      if (
        audioFormat !== 1 ||
        channels !== CANONICAL_AUDIO.channels ||
        sampleRateHz !== CANONICAL_AUDIO.sampleRateHz ||
        byteRate !== CANONICAL_AUDIO.sampleRateHz * 2 ||
        blockAlign !== 2 ||
        bitsPerSample !== 16
      ) {
        throw new TypeError(
          "WAV fixture must be 24 kHz mono 16-bit little-endian PCM",
        );
      }
      formatSeen = true;
    } else if (name === "data") {
      if (pcm !== undefined) throw new TypeError("WAV fixture has multiple data chunks");
      pcm = bytes.slice(dataOffset, dataEnd);
    }
    offset = dataEnd + (size % 2);
  }

  if (!formatSeen || pcm === undefined || pcm.byteLength === 0) {
    throw new TypeError("WAV fixture requires non-empty fmt and data chunks");
  }
  if (pcm.byteLength % 2 !== 0) {
    throw new TypeError("WAV PCM data must contain complete 16-bit samples");
  }

  const frames: Uint8Array[] = [];
  for (let frameOffset = 0; frameOffset < pcm.byteLength; frameOffset += CANONICAL_AUDIO.bytesPerFrame) {
    const frame = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
    frame.set(pcm.subarray(
      frameOffset,
      Math.min(frameOffset + CANONICAL_AUDIO.bytesPerFrame, pcm.byteLength),
    ));
    frames.push(frame);
  }
  return Object.freeze(frames);
}

function glossaryFromManifest(
  manifest: CorpusManifest,
  sourceLanguage: string,
  targetLanguage: string,
  version: string,
): GlossarySpec {
  const grouped = new Map<string, {
    source?: string;
    readonly aliases: string[];
    targetExact: string;
  }>();
  const fixtureIds = new Set<string>();

  for (const fixture of manifest.fixtures) {
    if (fixtureIds.has(fixture.fixtureId)) {
      throw new TypeError("Duplicate fixtureId " + fixture.fixtureId);
    }
    fixtureIds.add(fixture.fixtureId);
    const current = grouped.get(fixture.entryId) ?? {
      aliases: [],
      targetExact: fixture.targetExact,
    };
    if (current.targetExact !== fixture.targetExact) {
      throw new TypeError("Conflicting targetExact values for " + fixture.entryId);
    }
    if (fixture.phraseKind === "source") {
      if (current.source !== undefined) {
        throw new TypeError("Multiple source fixtures for " + fixture.entryId);
      }
      current.source = fixture.phrase;
    } else {
      current.aliases.push(fixture.phrase);
    }
    grouped.set(fixture.entryId, current);
  }

  return Object.freeze({
    id: "local-eval-corpus",
    version,
    sourceLanguage,
    targetLanguage,
    entries: Object.freeze([...grouped].map(([id, entry]) => {
      if (entry.source === undefined) {
        throw new TypeError("Missing source fixture for " + id);
      }
      return Object.freeze({
        id,
        source: entry.source,
        aliases: Object.freeze([...entry.aliases]),
        targetExact: entry.targetExact,
      });
    })),
  });
}

async function loadFixture(
  manifestDirectory: string,
  fixture: CorpusFixture,
): Promise<LoadedFixture> {
  const wavPath = await assertManifestFixturePath(
    resolve(manifestDirectory, fixture.wavPath),
    manifestDirectory,
    "WAV fixture path",
  );
  const bytes = new Uint8Array(await readFile(wavPath));
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== fixture.wavSha256) {
    throw new TypeError(
      "WAV hash mismatch for " + fixture.fixtureId +
        ": expected " + fixture.wavSha256 + ", received " + actualSha256,
    );
  }
  return Object.freeze({
    fixture,
    frames: parseCanonicalWav(bytes),
  });
}

function observe(
  evidence: InMemoryEvidenceStore<EvidenceRecord>,
  media: FakeTelephonyMediaPort,
  sessionId: string,
): ObservedOutcome {
  let sourceFinal: string | undefined;
  let targetFinal: string | undefined;
  let glossaryAuthorized = false;
  let sourceAudioFrames = 0;
  let playoutAudioFrames = 0;
  const alerts: LocalEvalReplayAlert[] = [];

  for (const record of evidence.records(sessionId)) {
    if (record.type === "audio") {
      if (record.track === "source_a") sourceAudioFrames += 1;
      if (record.track === "playout_to_b") playoutAudioFrames += 1;
      continue;
    }
    const event: SessionEvent = record.event;
    if (event.lane !== "A_TO_B") continue;
    if (event.type === "source_transcript" && event.final) sourceFinal = event.text;
    if (event.type === "target_transcript" && event.final) targetFinal = event.text;
    if (event.type === "glossary_authorized") glossaryAuthorized = true;
    if (event.type === "alert") {
      alerts.push(Object.freeze({
        code: event.alert.code,
        message: event.alert.message,
        retryable: "retryable" in event.alert
          ? event.alert.retryable
          : false,
      }));
    }
  }

  const telephonyOutputFrames = media.outbound(sessionId, "B")
    .filter((event) => event.type === "audio").length;
  return Object.freeze({
    ...(sourceFinal === undefined ? {} : { sourceFinal }),
    ...(targetFinal === undefined ? {} : { targetFinal }),
    glossaryAuthorized,
    sourceAudioFrames,
    playoutAudioFrames,
    telephonyOutputFrames,
    alerts: Object.freeze(alerts),
  });
}

async function waitForReady(
  relay: ModularGuardedDuplexRelay,
  sessionId: string,
): Promise<void> {
  const deadline = performance.now() + OUTCOME_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (relay.snapshot(sessionId).status === "ready") return;
    await delay(1);
  }
  throw new Error("Timed out waiting for fake telephony participants");
}

async function waitForOutcome(
  evidence: InMemoryEvidenceStore<EvidenceRecord>,
  media: FakeTelephonyMediaPort,
  sessionId: string,
): Promise<Readonly<{ outcome: ObservedOutcome; timedOut: boolean }>> {
  const deadline = performance.now() + OUTCOME_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const outcome = observe(evidence, media, sessionId);
    if (outcome.targetFinal !== undefined && outcome.telephonyOutputFrames > 0) {
      return Object.freeze({ outcome, timedOut: false });
    }
    await delay(1);
  }
  return Object.freeze({
    outcome: observe(evidence, media, sessionId),
    timedOut: true,
  });
}

async function replayFixture(
  loaded: LoadedFixture,
  glossary: GlossarySpec,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<LocalEvalReplayFixtureResult> {
  const evidence = new InMemoryEvidenceStore<EvidenceRecord>();
  const media = new FakeTelephonyMediaPort({
    queueCapacity: Math.max(500, loaded.frames.length + 20),
  });
  const translation = createLocalEvalTranslationAdapter({
    transcriptByLane: {
      A_TO_B: loaded.fixture.phrase,
      B_TO_A: loaded.fixture.targetExact,
    },
    confidence: 0.99,
  });
  const relay = new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    endpointGrant: (sessionId, side) => ({
      kind: "telephony_test",
      side,
      address: "fake-telephony://" + encodeURIComponent(sessionId) + "/" + side,
    }),
  });
  const snapshot = await relay.open({
    sideA: { language: sourceLanguage },
    sideB: { language: targetLanguage },
    profile: "local_eval",
    glossary,
    maxQueueFrames: Math.max(25, loaded.frames.length + 1),
  });
  const sessionId = snapshot.sessionId;
  let ended = false;

  try {
    media.connect(sessionId, "A");
    media.connect(sessionId, "B");
    await waitForReady(relay, sessionId);
    await relay.command(sessionId, {
      type: "start",
      commandId: "start-" + loaded.fixture.fixtureId,
    });

    media.speechStarted(sessionId, "A");
    for (let index = 0; index < loaded.frames.length; index += 1) {
      const frame = loaded.frames[index];
      if (frame === undefined) continue;
      media.ingestMulaw(
        sessionId,
        "A",
        index,
        encodePcm16le24kToMulaw8k(frame),
      );
      if (index % 32 === 31) await nextTurn();
    }
    media.speechEnded(sessionId, "A");

    const { outcome, timedOut } = await waitForOutcome(evidence, media, sessionId);
    const sourceTranscriptMatched = outcome.sourceFinal === loaded.fixture.phrase;
    const targetExactMatched = outcome.targetFinal === loaded.fixture.targetExact;
    const passed =
      !timedOut &&
      sourceTranscriptMatched &&
      targetExactMatched &&
      outcome.glossaryAuthorized &&
      outcome.sourceAudioFrames > 0 &&
      outcome.playoutAudioFrames > 0 &&
      outcome.telephonyOutputFrames > 0;

    await relay.command(sessionId, {
      type: "end",
      commandId: "end-" + loaded.fixture.fixtureId,
      reason: "local_eval_replay_complete",
    });
    ended = true;

    return Object.freeze({
      fixtureId: loaded.fixture.fixtureId,
      entryId: loaded.fixture.entryId,
      phraseKind: loaded.fixture.phraseKind,
      fixtureTranscript: loaded.fixture.phrase,
      expectedTargetExact: loaded.fixture.targetExact,
      ...(outcome.sourceFinal === undefined
        ? {}
        : { observedSourceFinal: outcome.sourceFinal }),
      ...(outcome.targetFinal === undefined
        ? {}
        : { observedTargetFinal: outcome.targetFinal }),
      sourceTranscriptMatched,
      targetExactMatched,
      glossaryAuthorized: outcome.glossaryAuthorized,
      sourceAudioFrames: outcome.sourceAudioFrames,
      playoutAudioFrames: outcome.playoutAudioFrames,
      telephonyOutputFrames: outcome.telephonyOutputFrames,
      alerts: outcome.alerts,
      timedOut,
      passed,
    });
  } finally {
    if (!ended) {
      await relay.command(sessionId, {
        type: "end",
        commandId: "cleanup-" + loaded.fixture.fixtureId,
        reason: "local_eval_replay_cleanup",
      }).catch(() => undefined);
    }
  }
}

export async function replayLocalEvalCorpus(
  options: LocalEvalReplayOptions,
): Promise<LocalEvalReplayReport> {
  const sourceLanguage = requiredLanguage(options.sourceLanguage, "sourceLanguage");
  const targetLanguage = requiredLanguage(options.targetLanguage, "targetLanguage");
  const manifestPath = resolve(options.manifestPath);
  const manifestBytes = new Uint8Array(await readFile(manifestPath));
  const manifest = manifestSchema.parse(JSON.parse(Buffer.from(manifestBytes).toString("utf8")));
  const manifestSha256 = sha256(manifestBytes);
  const glossary = glossaryFromManifest(
    manifest,
    sourceLanguage,
    targetLanguage,
    "sha256-" + manifestSha256,
  );
  const loaded: LoadedFixture[] = [];
  for (const fixture of manifest.fixtures) {
    loaded.push(await loadFixture(dirname(manifestPath), fixture));
  }

  const fixtures: LocalEvalReplayFixtureResult[] = [];
  for (const fixture of loaded) {
    fixtures.push(await replayFixture(
      fixture,
      glossary,
      sourceLanguage,
      targetLanguage,
    ));
  }
  const passed = fixtures.filter((fixture) => fixture.passed).length;

  return Object.freeze({
    schemaVersion: 1,
    generatedAtUtc: new Date().toISOString(),
    mode: "fixture_transcript_harness_replay",
    claims: Object.freeze({
      transcriptSource: "manifest_fixture_text",
      fixtureTranscriptInjected: true,
      acousticSttEvaluated: false,
      providerCalls: 0,
      mediaPath: "wav_pcm16le24k_to_mulaw8k_to_fake_telephony_to_harness",
      outputSpeech: "deterministic_local_pcm_fixture",
    }),
    manifestPath,
    manifestSha256,
    sourceLanguage,
    targetLanguage,
    glossary: Object.freeze({
      id: glossary.id,
      version: glossary.version,
      entries: glossary.entries.length,
    }),
    summary: Object.freeze({
      total: fixtures.length,
      passed,
      failed: fixtures.length - passed,
    }),
    fixtures: Object.freeze(fixtures),
  });
}

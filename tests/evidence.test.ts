import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EncryptedFileEvidenceStore,
  readEncryptedEvidence,
  readVerifiedEncryptedEvidence,
} from "../src/adapters/evidence/encrypted-file.js";
import { InMemoryEvidenceStore } from "../src/adapters/evidence/in-memory.js";
import { exportEncryptedEvidence } from "../src/adapters/evidence/export.js";
import { ControlledTranslationAdapter } from "../src/adapters/translation/glossary-controlled.js";
import { createLocalEvalTranslationAdapter } from "../src/adapters/translation/local-eval.js";
import { AsyncQueue } from "../src/core/async-queue.js";
import { ModularGuardedDuplexRelay } from "../src/core/relay.js";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import {
  EVIDENCE_AUDIO_TRACKS,
  type AudioFrame,
  type EvidenceAudioTrack,
  type EvidenceRecord,
  type MediaClearRequest,
  type MediaIngressEvent,
  type MediaIngressRequest,
  type MediaPlaybackRequest,
  type MediaPort,
} from "../src/core/types.js";

interface TestRecord {
  readonly sessionId: string;
  readonly type: "transcript" | "audio";
  readonly secret?: string;
  readonly pcm16le?: Uint8Array;
}

const taskTemp = join(process.cwd(), "work", "tmp", "evidence-tests");

async function isolatedDirectory(name: string): Promise<string> {
  const directory = join(taskTemp, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

class BatchedTimelineMedia implements MediaPort {
  readonly #ingress = new AsyncQueue<MediaIngressEvent>(32);
  readonly played: AudioFrame[] = [];

  push(event: MediaIngressEvent): void {
    if (!this.#ingress.offer(event)) throw new Error("test media queue closed");
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    request.signal.addEventListener("abort", () => this.#ingress.close(), { once: true });
    return this.#ingress;
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      this.played.push(frame);
      request.onPlayoutStarted(frame, 2_000);
    }
  }

  async clear(_request: MediaClearRequest): Promise<void> {}

  closeSession(_sessionId: string): void {
    this.#ingress.close();
  }
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("encrypted evidence store", () => {
  it("never writes transcript or PCM evidence in plaintext", async () => {
    const directory = await isolatedDirectory("encrypted");
    const key = Buffer.alloc(32, 9);
    const store = new EncryptedFileEvidenceStore<TestRecord>({ directory, key });

    assert.equal(store.record({ sessionId: "session-one", type: "transcript", secret: "Abbe error" }), true);
    assert.equal(
      store.record({ sessionId: "session-one", type: "audio", pcm16le: Uint8Array.from([1, 2, 3, 4]) }),
      true,
    );
    await store.close("session-one");

    const path = store.filePath("session-one");
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /Abbe error/);
    const decrypted = await readEncryptedEvidence<TestRecord>(path, key);
    assert.equal(decrypted[0]?.secret, "Abbe error");
    assert.deepEqual(decrypted[1]?.pcm16le, Uint8Array.from([1, 2, 3, 4]));
    const verified = await readVerifiedEncryptedEvidence<TestRecord>(path, key);
    assert.deepEqual(verified.seal, {
      schemaVersion: 2,
      recordCount: 2,
      finalChainSha256: verified.seal.finalChainSha256,
      sealSha256: verified.seal.sealSha256,
    });
  });

  it("authenticates every record and rejects the wrong key", async () => {
    const directory = await isolatedDirectory("wrong-key");
    const store = new EncryptedFileEvidenceStore<TestRecord>({
      directory,
      key: Buffer.alloc(32, 1),
    });
    store.record({ sessionId: "session-two", type: "transcript", secret: "private" });
    await store.close("session-two");
    await assert.rejects(
      readEncryptedEvidence<TestRecord>(store.filePath("session-two"), Buffer.alloc(32, 2)),
    );
  });

  it("rejects a truncated or reordered record chain even with the correct key", async () => {
    const directory = await isolatedDirectory("immutable-seal");
    const key = Buffer.alloc(32, 11);
    const store = new EncryptedFileEvidenceStore<TestRecord>({ directory, key });
    store.record({ sessionId: "session-sealed", type: "transcript", secret: "first" });
    store.record({ sessionId: "session-sealed", type: "transcript", secret: "second" });
    await store.close("session-sealed");
    const path = store.filePath("session-sealed");
    const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/u);
    assert.equal(lines.length, 3, "two records plus the final seal");

    await writeFile(path, [lines[0], lines[2]].join("\n") + "\n", "utf8");
    await assert.rejects(
      readVerifiedEncryptedEvidence<TestRecord>(path, key),
      /Evidence seal validation failed/u,
    );

    await writeFile(path, [lines[1], lines[0], lines[2]].join("\n") + "\n", "utf8");
    await assert.rejects(
      readVerifiedEncryptedEvidence<TestRecord>(path, key),
      /Evidence seal validation failed/u,
    );
  });

  it("derives the same immutable seal from the same ordered evidence", async () => {
    const key = Buffer.alloc(32, 12);
    const [leftDirectory, rightDirectory] = await Promise.all([
      isolatedDirectory("deterministic-seal-left"),
      isolatedDirectory("deterministic-seal-right"),
    ]);
    const left = new EncryptedFileEvidenceStore<TestRecord>({ directory: leftDirectory, key });
    const right = new EncryptedFileEvidenceStore<TestRecord>({ directory: rightDirectory, key });
    const records: readonly TestRecord[] = [
      { sessionId: "repeatable-seal", type: "transcript", secret: "first" },
      { sessionId: "repeatable-seal", type: "audio", pcm16le: Uint8Array.from([1, 2, 3]) },
    ];
    for (const record of records) {
      assert.equal(left.record(record), true);
      assert.equal(right.record(record), true);
    }
    await Promise.all([left.close("repeatable-seal"), right.close("repeatable-seal")]);
    const [leftVerified, rightVerified] = await Promise.all([
      readVerifiedEncryptedEvidence<TestRecord>(left.filePath("repeatable-seal"), key),
      readVerifiedEncryptedEvidence<TestRecord>(right.filePath("repeatable-seal"), key),
    ]);
    assert.deepEqual(leftVerified.seal, rightVerified.seal);
  });

  it("fails open at its bounded non-blocking queue instead of stalling media", async () => {
    const directory = await isolatedDirectory("bounded");
    const store = new EncryptedFileEvidenceStore<TestRecord>({
      directory,
      key: Buffer.alloc(32, 3),
      maxPendingRecords: 1,
    });
    assert.equal(store.record({ sessionId: "session-three", type: "transcript", secret: "first" }), true);
    assert.equal(store.record({ sessionId: "session-three", type: "transcript", secret: "overflow" }), false);
    await store.close("session-three");
  });
});

describe("in-memory evidence store", () => {
  it("clones records and rejects writes after close", async () => {
    const store = new InMemoryEvidenceStore<TestRecord>();
    const pcm = Uint8Array.from([7, 8]);
    assert.equal(store.record({ sessionId: "test", type: "audio", pcm16le: pcm }), true);
    pcm[0] = 99;
    assert.deepEqual(store.records("test")[0]?.pcm16le, Uint8Array.from([7, 8]));
    await store.close("test");
    assert.equal(store.record({ sessionId: "test", type: "transcript" }), false);
  });
});

describe("controlled fallback evidence", () => {
  it("records a nonfatal glossary-bypass fallback alert before source playout", async () => {
    const media = new BatchedTimelineMedia();
    const evidence = new InMemoryEvidenceStore<EvidenceRecord>();
    const translation = new ControlledTranslationAdapter({
      transcriber: {
        async *transcribe(input) {
          for await (const _event of input.events) {
            // Consume the committed turn before returning the deterministic fixture.
          }
          yield {
            type: "transcript_completed" as const,
            sessionId: input.context.sessionId,
            lane: input.context.lane,
            generation: input.context.generation,
            itemId: "fallback-item",
            turnId: input.context.turnId,
            emittedAtMs: 1,
            transcript: "Inspect the spindle.",
          };
        },
        async cancel() {},
      },
      translator: {
        async translate() {
          throw new Error("provider unavailable");
        },
      },
      tts: {
        outputFormat: CANONICAL_AUDIO,
        async *synthesize() {
          yield new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(7);
        },
      },
      now: () => 10,
    });
    const relay = new ModularGuardedDuplexRelay({
      media,
      evidence,
      translation,
      createSessionId: () => "controlled-fallback-evidence",
      endpointGrant: (_sessionId, side) => ({
        kind: "browser_link",
        side,
        url: "local-" + side,
        qrDataUrl: "local-qr",
      }),
    });
    const snapshot = await relay.open({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "accurate",
      glossary: {
        id: "factory-terms",
        version: "v1",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        entries: [{
          id: "spindle",
          source: "spindle",
          aliases: [],
          targetExact: "主軸",
        }],
      },
    });
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: 1,
        connected: true,
      });
    }
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "controlled fallback session did not become ready",
    );
    await relay.command(snapshot.sessionId, { type: "start", commandId: "start-fallback" });
    media.push({
      type: "speech_started",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: 2,
    });
    media.push({
      type: "audio",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: 3,
      frame: createAudioFrame({
        sessionId: snapshot.sessionId,
        lane: "A_TO_B",
        generation: 0,
        sequence: 0,
        capturedAtMs: 3,
        pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame),
      }),
    });
    media.push({
      type: "speech_ended",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: 4,
    });
    await waitUntil(() => media.played.length === 1, "fallback audio did not play");

    const sessionEvents = evidence.records(snapshot.sessionId)
      .filter((record) => record.type === "session_event")
      .map((record) => record.event);
    const fallbackAlertIndex = sessionEvents.findIndex((event) =>
      event.type === "alert" && event.alert.code === "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK"
    );
    const fallbackTargetIndex = sessionEvents.findIndex((event) =>
      event.type === "target_transcript" && event.text === "Inspect the spindle."
    );
    assert.ok(fallbackAlertIndex >= 0, "fallback alert must be recorded as evidence");
    assert.ok(fallbackTargetIndex > fallbackAlertIndex, "alert evidence must precede fallback text");
    assert.equal(
      sessionEvents.some((event) => event.type === "glossary_authorized"),
      false,
    );

    await relay.command(snapshot.sessionId, { type: "end", commandId: "end-fallback" });
  });
});

describe("encrypted evidence export", () => {
  it("decrypts authenticated records and exports synchronized mono plus four-channel WAV files", async () => {
    const encryptedDirectory = await isolatedDirectory("export-source");
    const outputDirectory = join(taskTemp, "export-output");
    await rm(outputDirectory, { recursive: true, force: true });
    const key = Buffer.alloc(32, 7);
    const store = new EncryptedFileEvidenceStore<EvidenceRecord>({
      directory: encryptedDirectory,
      key,
    });
    const sessionId = "export-session";
    const laneByTrack: Readonly<Record<EvidenceAudioTrack, "A_TO_B" | "B_TO_A">> = {
      source_a: "A_TO_B",
      source_b: "B_TO_A",
      playout_to_a: "B_TO_A",
      playout_to_b: "A_TO_B",
    };
    EVIDENCE_AUDIO_TRACKS.forEach((track, index) => {
      assert.equal(store.record({
        type: "audio",
        sessionId,
        track,
        timelineAtMonoMs: 1_000,
        frame: createAudioFrame({
          sessionId,
          lane: laneByTrack[track],
          generation: 0,
          sequence: index,
          capturedAtMs: 1_000,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index + 1),
        }),
      }), true);
    });
    assert.equal(store.record({
      type: "session_event",
      sessionId,
      event: {
        type: "session_closed",
        cursor: 1,
        sessionId,
        timestampMonoMs: 1_020,
        lane: null,
        generation: null,
        reason: "test complete",
      },
    }), true);
    await store.close(sessionId);

    const exported = await exportEncryptedEvidence({
      encryptedPath: store.filePath(sessionId),
      key,
      outputDirectory,
    });
    assert.equal(exported.sessionId, sessionId);
    assert.equal(exported.recordCount, 5);
    assert.equal(exported.eventCount, 1);
    assert.deepEqual(exported.trackFrameCounts, {
      source_a: 1,
      source_b: 1,
      playout_to_a: 1,
      playout_to_b: 1,
    });
    assert.equal(exported.schemaVersion, 2);
    assert.equal(exported.evidenceSeal.recordCount, 5);
    assert.match(exported.evidenceSeal.finalChainSha256, /^[a-f0-9]{64}$/u);
    assert.equal(exported.fourTrack.channels, 4);
    assert.match(exported.exportSha256, /^[a-f0-9]{64}$/u);

    const events = await readFile(join(outputDirectory, "events.jsonl"), "utf8");
    assert.match(events, /session_closed/u);
    assert.doesNotMatch(events, /pcm16le|base64/u);

    const mono = await readFile(join(outputDirectory, "source_a.wav"));
    assert.equal(mono.toString("ascii", 0, 4), "RIFF");
    assert.equal(mono.readUInt16LE(22), 1);
    assert.equal(mono.readUInt32LE(24), 24_000);
    assert.equal(mono.readUInt16LE(34), 16);
    assert.equal(mono.readUInt32LE(40), CANONICAL_AUDIO.bytesPerFrame);

    const mux = await readFile(join(outputDirectory, "four-track.wav"));
    assert.equal(mux.readUInt16LE(22), 4);
    assert.equal(mux.readUInt32LE(40), CANONICAL_AUDIO.bytesPerFrame * 4);
    assert.deepEqual(
      [...mux.subarray(44, 52)],
      [1, 1, 2, 2, 3, 3, 4, 4],
    );
  });

  it("normalizes batched source and multi-frame playout timelines before WAV export", async () => {
    const encryptedDirectory = await isolatedDirectory("batched-relay-source");
    const outputDirectory = join(taskTemp, "batched-relay-output");
    await rm(outputDirectory, { recursive: true, force: true });
    const key = Buffer.alloc(32, 8);
    const store = new EncryptedFileEvidenceStore<EvidenceRecord>({
      directory: encryptedDirectory,
      key,
    });
    const media = new BatchedTimelineMedia();
    let now = 100;
    const relay = new ModularGuardedDuplexRelay({
      media,
      evidence: store,
      translation: createLocalEvalTranslationAdapter({
        transcriptByLane: {
          A_TO_B: "Verify the Abbe offset.",
          B_TO_A: "請檢查阿貝偏移。",
        },
      }),
      now: () => now += 1,
      createSessionId: () => "batched-evidence-session",
      endpointGrant: (_sessionId, side) => ({
        kind: "browser_link",
        side,
        url: "local-" + side,
        qrDataUrl: "local-qr",
      }),
    });
    const snapshot = await relay.open({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "accurate",
      glossary: {
        id: "batched-terms",
        version: "1",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        entries: [{
          id: "abbe-offset",
          source: "Abbe offset",
          aliases: [],
          targetExact: "阿貝偏移",
        }],
      },
      maxQueueFrames: 16,
    });
    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: 900,
        connected: true,
      });
    }
    await waitUntil(
      () => relay.snapshot(snapshot.sessionId).status === "ready",
      "batched evidence session did not become ready",
    );
    await relay.command(snapshot.sessionId, { type: "start", commandId: "start" });
    media.push({
      type: "speech_started",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: 1_000,
    });
    for (let sequence = 0; sequence < 3; sequence += 1) {
      media.push({
        type: "audio",
        sessionId: snapshot.sessionId,
        side: "A",
        timestampMonoMs: 1_000,
        frame: createAudioFrame({
          sessionId: snapshot.sessionId,
          lane: "A_TO_B",
          generation: 0,
          sequence,
          capturedAtMs: 1_000,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(sequence + 1),
        }),
      });
    }
    media.push({
      type: "speech_ended",
      sessionId: snapshot.sessionId,
      side: "A",
      timestampMonoMs: 1_000,
    });
    await waitUntil(() => media.played.length === 3, "local_eval did not play three frames");
    await relay.command(snapshot.sessionId, { type: "end", commandId: "end" });

    const records = await readEncryptedEvidence<EvidenceRecord>(
      store.filePath(snapshot.sessionId),
      key,
    );
    const timeline = (track: EvidenceAudioTrack): number[] => records
      .filter((record) => record.type === "audio" && record.track === track)
      .map((record) => record.type === "audio" ? record.timelineAtMonoMs : -1);
    assert.deepEqual(timeline("source_a"), [1_000, 1_020, 1_040]);
    assert.deepEqual(timeline("playout_to_b"), [2_000, 2_020, 2_040]);

    const exported = await exportEncryptedEvidence({
      encryptedPath: store.filePath(snapshot.sessionId),
      key,
      outputDirectory,
    });
    assert.equal(exported.trackFrameCounts.source_a, 3);
    assert.equal(exported.trackFrameCounts.playout_to_b, 3);
  });
  it("rejects the wrong key before exporting plaintext artifacts", async () => {
    const encryptedDirectory = await isolatedDirectory("export-wrong-key-source");
    const outputDirectory = join(taskTemp, "export-wrong-key-output");
    await rm(outputDirectory, { recursive: true, force: true });
    const store = new EncryptedFileEvidenceStore<TestRecord>({
      directory: encryptedDirectory,
      key: Buffer.alloc(32, 4),
    });
    store.record({ sessionId: "wrong-key-export", type: "transcript", secret: "private" });
    await store.close("wrong-key-export");

    await assert.rejects(
      exportEncryptedEvidence({
        encryptedPath: store.filePath("wrong-key-export"),
        key: Buffer.alloc(32, 5),
        outputDirectory,
      }),
    );
    await assert.rejects(readFile(join(outputDirectory, "export-manifest.json")));
  });
});

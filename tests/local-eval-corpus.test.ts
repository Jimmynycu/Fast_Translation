import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { CANONICAL_AUDIO } from "../src/core/audio.js";
import {
  parseCanonicalWav,
  replayLocalEvalCorpus,
} from "../src/local-eval/corpus-replay.js";

function temporaryDirectory(name: string): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "local-eval-corpus-tests",
    name + "-" + randomUUID(),
  );
}

function canonicalWave(frameCount = 2): Uint8Array {
  const pcm = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame * frameCount);
  const pcmView = new DataView(pcm.buffer);
  for (let sample = 0; sample < pcm.byteLength / 2; sample += 1) {
    pcmView.setInt16(sample * 2, Math.round(Math.sin(sample / 12) * 3_000), true);
  }

  const wave = new Uint8Array(44 + pcm.byteLength);
  const buffer = Buffer.from(wave.buffer);
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
  wave.set(pcm, 44);
  return wave;
}

function manifest(wavSha256: string, wavPath = "mistake-proofing.wav"): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 2,
    generatedAtUtc: "2026-08-06T00:00:00.000Z",
    generator: "test fixture",
    voice: "deterministic test tone",
    language: "en-US",
    audio: {
      container: "wav",
      encoding: "pcm_s16le",
      sampleRateHz: 24_000,
      channels: 1,
      bitsPerSample: 16,
    },
    sourceGlossary: "terms.csv",
    fixtures: [
      {
        fixtureId: "mistake-proofing-source",
        entryId: "mistake-proofing",
        phraseKind: "source",
        phrase: "mistake proofing",
        targetExact: "防呆",
        wavPath,
        wavSha256,
      },
      {
        fixtureId: "mistake-proofing-alias",
        entryId: "mistake-proofing",
        phraseKind: "alias",
        phrase: "poka yoke",
        targetExact: "防呆",
        wavPath,
        wavSha256,
      },
    ],
  };
}

describe("keyless local evaluation corpus replay", () => {
  it("hash-validates TTS WAV fixtures and replays them through telephony, relay, glossary, and evidence", async () => {
    const directory = temporaryDirectory("replay");
    await mkdir(directory, { recursive: true });
    const wav = canonicalWave();
    const wavSha256 = createHash("sha256").update(wav).digest("hex");
    const manifestPath = resolve(directory, "manifest.json");
    await Promise.all([
      writeFile(resolve(directory, "mistake-proofing.wav"), wav),
      writeFile(manifestPath, JSON.stringify(manifest(wavSha256)), "utf8"),
    ]);

    try {
      assert.equal(parseCanonicalWav(wav).length, 2);
      const report = await replayLocalEvalCorpus({
        manifestPath,
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
      });

      assert.deepEqual(report.summary, { total: 2, passed: 2, failed: 0 });
      assert.deepEqual(report.claims, {
        transcriptSource: "manifest_fixture_text",
        fixtureTranscriptInjected: true,
        acousticSttEvaluated: false,
        providerCalls: 0,
        mediaPath: "wav_pcm16le24k_to_mulaw8k_to_fake_telephony_to_harness",
        outputSpeech: "deterministic_local_pcm_fixture",
      });
      for (const fixture of report.fixtures) {
        assert.equal(fixture.observedSourceFinal, fixture.fixtureTranscript);
        assert.equal(fixture.observedTargetFinal, "防呆");
        assert.equal(fixture.targetExactMatched, true);
        assert.equal(fixture.glossaryAuthorized, true);
        assert.ok(fixture.sourceAudioFrames > 0);
        assert.ok(fixture.playoutAudioFrames > 0);
        assert.ok(fixture.telephonyOutputFrames > 0);
        assert.equal(fixture.timedOut, false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a WAV symlink that escapes the manifest directory", async (testContext) => {
    const directory = temporaryDirectory("symlink");
    const outside = temporaryDirectory("symlink-target");
    await mkdir(directory, { recursive: true });
    await mkdir(outside, { recursive: true });
    const wav = canonicalWave(1);
    const outsideWav = resolve(outside, "outside.wav");
    const linkedWav = resolve(directory, "linked.wav");
    const manifestPath = resolve(directory, "manifest.json");
    await writeFile(outsideWav, wav);
    try {
      try {
        await symlink(outside, linkedWav, process.platform === "win32" ? "junction" : "dir");
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error &&
          ((error as NodeJS.ErrnoException).code === "EPERM" ||
            (error as NodeJS.ErrnoException).code === "EACCES")) {
          testContext.skip("symlink creation is unavailable on this host");
          return;
        }
        throw error;
      }
      const wavSha256 = createHash("sha256").update(wav).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest(wavSha256, "linked.wav")), "utf8");
      await assert.rejects(
        replayLocalEvalCorpus({
          manifestPath,
          sourceLanguage: "en-US",
          targetLanguage: "zh-TW",
        }),
        /must not traverse a symlink or junction/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("rejects a modified WAV before opening a Harness session", async () => {
    const directory = temporaryDirectory("hash-mismatch");
    await mkdir(directory, { recursive: true });
    const wav = canonicalWave(1);
    const manifestPath = resolve(directory, "manifest.json");
    await Promise.all([
      writeFile(resolve(directory, "mistake-proofing.wav"), wav),
      writeFile(manifestPath, JSON.stringify(manifest("0".repeat(64))), "utf8"),
    ]);

    try {
      await assert.rejects(
        replayLocalEvalCorpus({
          manifestPath,
          sourceLanguage: "en-US",
          targetLanguage: "zh-TW",
        }),
        /WAV hash mismatch/u,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANONICAL_AUDIO,
  AudioFrameValidationError,
  createAudioFrame,
  destinationForLane,
  laneFromSource,
  sourceForLane,
} from "../src/core/audio.js";

test("canonical audio is PCM16LE mono at 24 kHz in 20 ms frames", () => {
  assert.deepEqual(CANONICAL_AUDIO, {
    encoding: "pcm16le",
    sampleRateHz: 24_000,
    channels: 1,
    frameDurationMs: 20,
    samplesPerFrame: 480,
    bytesPerFrame: 960,
  });
});

test("createAudioFrame validates metadata and takes ownership of PCM bytes", () => {
  const source = new Uint8Array(CANONICAL_AUDIO.bytesPerFrame);
  source[0] = 12;
  const frame = createAudioFrame({
    sessionId: "session-1",
    lane: "A_TO_B",
    generation: 2,
    sequence: 7,
    capturedAtMs: 42.5,
    pcm16le: source,
  });
  source[0] = 99;
  assert.equal(frame.pcm16le[0], 12);
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(frame.format, CANONICAL_AUDIO);
});

test("createAudioFrame rejects malformed canonical frames", () => {
  const valid = {
    sessionId: "session-1",
    lane: "B_TO_A" as const,
    generation: 0,
    sequence: 0,
    capturedAtMs: 0,
    pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame),
  };
  assert.throws(() => createAudioFrame({ ...valid, pcm16le: new Uint8Array(959) }), AudioFrameValidationError);
  assert.throws(() => createAudioFrame({ ...valid, generation: -1 }), AudioFrameValidationError);
  assert.throws(() => createAudioFrame({ ...valid, sequence: 1.5 }), AudioFrameValidationError);
  assert.throws(() => createAudioFrame({ ...valid, capturedAtMs: Number.NaN }), AudioFrameValidationError);
});

test("lane helpers map the duplex sides without ambiguity", () => {
  assert.equal(laneFromSource("A"), "A_TO_B");
  assert.equal(laneFromSource("B"), "B_TO_A");
  assert.equal(sourceForLane("A_TO_B"), "A");
  assert.equal(sourceForLane("B_TO_A"), "B");
  assert.equal(destinationForLane("A_TO_B"), "B");
  assert.equal(destinationForLane("B_TO_A"), "A");
});

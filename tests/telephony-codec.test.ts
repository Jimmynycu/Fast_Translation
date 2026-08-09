import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TELEPHONY_PCMU_FORMAT,
  assertCanonicalFrame,
  assertTelephonyFrame,
  createPcmuSilenceFrame,
  decodeMulaw8kToPcm16le24k,
  decodeMulawSample,
  encodeMulawSample,
  encodePcm16le24kToMulaw8k,
} from "../src/adapters/media/telephony-codec.js";

describe("G.711 mu-law phone adapter codec", () => {
  it("pins a keyless PCMU fixture to 8 kHz mono 20 ms packets", () => {
    assert.deepEqual(TELEPHONY_PCMU_FORMAT, {
      codec: "PCMU",
      sampleRateHz: 8_000,
      channels: 1,
      frameDurationMs: 20,
      samplesPerFrame: 160,
      bytesPerFrame: 160,
    });
    const silence = createPcmuSilenceFrame();
    assertTelephonyFrame(silence);
    assert.equal(silence.byteLength, TELEPHONY_PCMU_FORMAT.bytesPerFrame);
    assert.equal(silence.every((sample) => sample === 0xff), true);
  });

  it("uses the standard positive and negative zero codes", () => {
    assert.equal(decodeMulawSample(0xff), 0);
    assert.equal(decodeMulawSample(0x7f), 0);
    assert.equal(encodeMulawSample(0), 0xff);
  });

  it("preserves polarity and stays within mu-law quantization error", () => {
    for (const sample of [-30_000, -10_000, -1_000, 1_000, 10_000, 30_000]) {
      const decoded = decodeMulawSample(encodeMulawSample(sample));
      assert.equal(Math.sign(decoded), Math.sign(sample));
      assert.ok(Math.abs(decoded - sample) < Math.max(40, Math.abs(sample) * 0.06));
    }
  });

  it("expands one 20 ms phone frame into one canonical frame", () => {
    const phone = new Uint8Array(160).fill(encodeMulawSample(4_000));
    assertTelephonyFrame(phone);

    const canonical = decodeMulaw8kToPcm16le24k(phone);

    assert.equal(canonical.byteLength, 960);
    assertCanonicalFrame(canonical);
    const view = new DataView(canonical.buffer, canonical.byteOffset, canonical.byteLength);
    assert.equal(view.getInt16(0, true), view.getInt16(2, true));
    assert.equal(view.getInt16(2, true), view.getInt16(4, true));
  });

  it("averages each canonical triplet into one phone sample", () => {
    const pcm = new Uint8Array(960);
    const view = new DataView(pcm.buffer);
    for (let index = 0; index < 480; index += 1) {
      view.setInt16(index * 2, 8_000, true);
    }

    const phone = encodePcm16le24kToMulaw8k(pcm);

    assert.equal(phone.byteLength, 160);
    assert.ok(Math.abs(decodeMulawSample(phone[0] ?? 0) - 8_000) < 500);
  });

  it("rejects packets that are not exactly one 20 ms transport or canonical frame", () => {
    assert.throws(() => decodeMulaw8kToPcm16le24k(new Uint8Array(159)), /PCMU frame/u);
    assert.throws(() => encodePcm16le24kToMulaw8k(new Uint8Array(8)), /24 kHz PCM16LE frame/u);
  });
});

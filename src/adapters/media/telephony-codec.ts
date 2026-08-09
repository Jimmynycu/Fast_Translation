const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32_635;

/**
 * Fixed, provider-free transport format used by the telephony fixture.
 * PCMU is the RTP name for G.711 mu-law; every fixture packet is exactly one
 * 20 ms mono frame and carries no credentials or provider metadata.
 */
export const TELEPHONY_PCMU_FORMAT = Object.freeze({
  codec: "PCMU" as const,
  sampleRateHz: 8_000,
  channels: 1 as const,
  frameDurationMs: 20,
  samplesPerFrame: 160,
  bytesPerFrame: 160,
});

export const TELEPHONY_SAMPLE_RATE_HZ = TELEPHONY_PCMU_FORMAT.sampleRateHz;
export const CANONICAL_SAMPLE_RATE_HZ = 24_000;

export function createPcmuSilenceFrame(): Uint8Array {
  return new Uint8Array(TELEPHONY_PCMU_FORMAT.bytesPerFrame).fill(0xff);
}

export function decodeMulawSample(value: number): number {
  const encoded = (~value) & 0xff;
  const sign = encoded & 0x80;
  const exponent = (encoded >> 4) & 0x07;
  const mantissa = encoded & 0x0f;
  const magnitude = ((mantissa << 3) + MULAW_BIAS) * (1 << exponent) - MULAW_BIAS;
  if (magnitude === 0) return 0;
  return sign === 0 ? magnitude : -magnitude;
}

export function encodeMulawSample(sample: number): number {
  const clamped = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, Math.round(sample)));
  const sign = clamped < 0 ? 0x80 : 0;
  const magnitude = Math.abs(clamped) + MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (magnitude & mask) === 0; mask >>= 1) {
    exponent -= 1;
  }

  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

/**
 * Converts a 20 ms G.711 mu-law frame (160 samples) into the canonical
 * 24 kHz PCM16LE frame (480 samples). The simple 3x hold is deterministic and
 * intentionally belongs to the phone adapter seam, never to the relay core.
 */
export function decodeMulaw8kToPcm16le24k(input: Uint8Array): Uint8Array {
  assertTelephonyFrame(input);
  const output = new Uint8Array(input.byteLength * 3 * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  let outputSample = 0;
  for (const encoded of input) {
    const decoded = decodeMulawSample(encoded);
    for (let repeat = 0; repeat < 3; repeat += 1) {
      view.setInt16(outputSample * 2, decoded, true);
      outputSample += 1;
    }
  }

  return output;
}

/**
 * Converts canonical PCM16LE back to 8 kHz mu-law. Each group of three input
 * samples is averaged before companding so constant and slowly varying speech
 * survives the adapter round trip without a provider-specific dependency.
 */
export function encodePcm16le24kToMulaw8k(input: Uint8Array): Uint8Array {
  assertCanonicalFrame(input);

  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const output = new Uint8Array(input.byteLength / 6);

  for (let outputSample = 0; outputSample < output.byteLength; outputSample += 1) {
    const firstInputSample = outputSample * 3;
    let sum = 0;
    for (let offset = 0; offset < 3; offset += 1) {
      sum += inputView.getInt16((firstInputSample + offset) * 2, true);
    }
    output[outputSample] = encodeMulawSample(sum / 3);
  }

  return output;
}

export function assertTelephonyFrame(input: Uint8Array): void {
  if (input.byteLength !== TELEPHONY_PCMU_FORMAT.bytesPerFrame) {
    throw new RangeError(
      `Expected one ${TELEPHONY_PCMU_FORMAT.frameDurationMs} ms ` +
      `${TELEPHONY_PCMU_FORMAT.sampleRateHz / 1_000} kHz ` +
      `${TELEPHONY_PCMU_FORMAT.codec} frame ` +
      `(${TELEPHONY_PCMU_FORMAT.bytesPerFrame} bytes), received ${input.byteLength}`,
    );
  }
}

export function assertCanonicalFrame(input: Uint8Array): void {
  if (input.byteLength !== 960) {
    throw new RangeError(`Expected one 20 ms 24 kHz PCM16LE frame (960 bytes), received ${input.byteLength}`);
  }
}

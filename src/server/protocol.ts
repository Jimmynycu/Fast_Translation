import { z } from "zod";

export const sideSchema = z.enum(["A", "B"]);
export const laneSchema = z.enum(["A_TO_B", "B_TO_A"]);
export const translationProfileSchema = z.enum([
  "native_live_baseline",
  "glossary_controlled",
  "deterministic_test",
]);

export const createSessionRequestSchema = z.object({
  languages: z.object({
    A: z.string().trim().min(2).max(64),
    B: z.string().trim().min(2).max(64),
  }),
  translationProfileId: translationProfileSchema,
  glossaryVersion: z.string().trim().min(1).max(256).optional(),
  recordingConsent: z.literal(true),
}).refine(
  (value) => value.languages.A.toLocaleLowerCase("en-US") !== value.languages.B.toLocaleLowerCase("en-US"),
  { path: ["languages", "B"], message: "participant languages must be different" },
);

export const importGlossaryRequestSchema = z.object({
  name: z.string().trim().min(1).max(128),
  csv: z.string().min(1).max(5_000_000),
  sourceLanguage: z.string().trim().min(2).max(64),
  targetLanguage: z.string().trim().min(2).max(64),
  approvedBy: z.string().trim().min(1).max(128),
}).refine(
  (value) => value.sourceLanguage.toLocaleLowerCase("en-US") !== value.targetLanguage.toLocaleLowerCase("en-US"),
  { path: ["targetLanguage"], message: "glossary languages must be different" },
);

const commandBase = z.object({
  commandId: z.string().uuid(),
});

export const sessionCommandSchema = z.discriminatedUnion("kind", [
  commandBase.extend({ kind: z.literal("start") }),
  commandBase.extend({ kind: z.literal("pause") }),
  commandBase.extend({ kind: z.literal("resume") }),
  commandBase.extend({ kind: z.literal("end") }),
]);

export const mediaControlSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("speech_start") }),
  z.object({ type: z.literal("speech_end") }),
]);

export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type ImportGlossaryRequest = z.infer<typeof importGlossaryRequestSchema>;
export type SessionCommandRequest = z.infer<typeof sessionCommandSchema>;
export type MediaControl = z.infer<typeof mediaControlSchema>;

export const PLAYOUT_HEADER_BYTES = 8;

export function packPlayoutAudio(
  generation: number,
  sequence: number,
  pcm16le: Uint8Array,
): Uint8Array {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("generation must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new RangeError("sequence must fit an unsigned 32-bit integer");
  }

  const output = new Uint8Array(PLAYOUT_HEADER_BYTES + pcm16le.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, generation, true);
  view.setUint32(4, sequence, true);
  output.set(pcm16le, PLAYOUT_HEADER_BYTES);
  return output;
}

export function unpackPlayoutAudio(value: Uint8Array): Readonly<{
  generation: number;
  sequence: number;
  pcm16le: Uint8Array;
}> {
  if (value.byteLength <= PLAYOUT_HEADER_BYTES || (value.byteLength - PLAYOUT_HEADER_BYTES) % 2 !== 0) {
    throw new RangeError("playout packet must contain an 8-byte header and complete PCM16 samples");
  }
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Object.freeze({
    generation: view.getUint32(0, true),
    sequence: view.getUint32(4, true),
    pcm16le: value.slice(PLAYOUT_HEADER_BYTES),
  });
}

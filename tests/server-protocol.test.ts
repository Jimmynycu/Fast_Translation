import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionRequestSchema,
  importGlossaryRequestSchema,
  mediaControlSchema,
  packPlayoutAudio,
  sessionCommandSchema,
  unpackPlayoutAudio,
} from "../src/server/protocol.js";

describe("HTTP and media protocol", () => {
  it("requires explicit recording consent to create a session", () => {
    const valid = createSessionRequestSchema.parse({
      languages: { A: "en-US", B: "zh-TW" },
      translationProfileId: "deterministic_test",
      recordingConsent: true,
    });
    assert.equal(valid.recordingConsent, true);
    assert.throws(
      () =>
        createSessionRequestSchema.parse({
          languages: { A: "en-US", B: "zh-TW" },
          translationProfileId: "deterministic_test",
          recordingConsent: false,
        }),
      /recordingConsent/,
    );
  });

  it("accepts the keyless controlled local evaluation profile", () => {
    const parsed = createSessionRequestSchema.parse({
      languages: { A: "en-US", B: "zh-TW" },
      translationProfileId: "local_eval",
      glossaryVersion: "factory-v1",
      recordingConsent: true,
    });

    assert.equal(parsed.translationProfileId, "local_eval");
    assert.equal(parsed.glossaryVersion, "factory-v1");
  });

  it("accepts the browser CSV glossary file contract", () => {
    const csv = "id,source,aliases,target_exact";
    const request = importGlossaryRequestSchema.parse({
      name: "factory",
      fileName: "factory.csv",
      contentsBase64: Buffer.from(csv).toString("base64"),
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
      approvedBy: "Glossary owner",
    });
    assert.equal(request.name, "factory");
    assert.equal(request.fileName, "factory.csv");
    assert.equal(Buffer.from(request.contentsBase64, "base64").toString(), csv);
  });

  it("accepts an XLSX glossary file contract", () => {
    const request = importGlossaryRequestSchema.parse({
      name: "factory",
      fileName: "factory.xlsx",
      contentsBase64: Buffer.from([1, 2, 3]).toString("base64"),
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
      approvedBy: "Glossary owner",
    });
    assert.equal(request.fileName, "factory.xlsx");
  });

  it("rejects malformed base64 glossary contents", () => {
    assert.throws(
      () => importGlossaryRequestSchema.parse({
        name: "factory",
        fileName: "factory.csv",
        contentsBase64: "%%%not-base64%%%",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        approvedBy: "Glossary owner",
      }),
      /contentsBase64/u,
    );
  });

  it("accepts idempotent commands with UUID command IDs", () => {
    const command = sessionCommandSchema.parse({
      kind: "start",
      commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
    });
    assert.equal(command.kind, "start");
    assert.throws(() => sessionCommandSchema.parse({ kind: "start", commandId: "same" }));
  });

  it("only admits speech boundary media controls", () => {
    assert.deepEqual(mediaControlSchema.parse({ type: "speech_start" }), { type: "speech_start" });
    assert.throws(() => mediaControlSchema.parse({ type: "clear", generation: 2 }));
  });

  it("round-trips generation-aware binary playout packets", () => {
    const pcm = Uint8Array.from([1, 2, 3, 4]);
    const unpacked = unpackPlayoutAudio(packPlayoutAudio(7, 42, pcm));
    assert.equal(unpacked.generation, 7);
    assert.equal(unpacked.sequence, 42);
    assert.deepEqual(unpacked.pcm16le, pcm);
  });

  it("rejects malformed binary packets", () => {
    assert.throws(() => unpackPlayoutAudio(new Uint8Array(8)), /complete PCM16/);
    assert.throws(() => packPlayoutAudio(-1, 0, new Uint8Array(2)), /generation/);
  });
});

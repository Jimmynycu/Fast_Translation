import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSessionRequestSchema,
  importGlossaryRequestSchema,
  mediaControlSchema,
  packPlayoutAudio,
  participantRecordingProcessingConsentRequestSchema,
  participantRecordingProcessingWithdrawalRequestSchema,
  sessionCommandSchema,
  unpackPlayoutAudio,
} from "../src/server/protocol.js";

describe("HTTP and media protocol", () => {
  it("creates a room without an operator recording attestation and rejects the obsolete field", () => {
    const valid = createSessionRequestSchema.parse({
      languages: { A: "en-US", B: "zh-TW" },
      translationMode: "balanced",
    });
    assert.equal("recordingConsent" in valid, false);
    assert.throws(
      () =>
        createSessionRequestSchema.parse({
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
          recordingConsent: true,
        }),
      /unrecognized key/i,
    );
    assert.throws(
      () =>
        createSessionRequestSchema.parse({
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
          dataAdmission: "synthetic_only",
        }),
      /unrecognized key/i,
    );
  });

  it("accepts only the English and Traditional Chinese POC pair in either direction", () => {
    for (const languages of [
      { A: "en-US", B: "zh-TW" },
      { A: "zh-TW", B: "en-US" },
    ]) {
      const request = createSessionRequestSchema.parse({
        languages,
        translationMode: "balanced",
      });
      assert.deepEqual(request.languages, languages);
    }

    for (const unsupportedLanguage of ["ja-JP", "ko-KR", "es-ES", "fr-FR", "de-DE"]) {
      assert.throws(() => createSessionRequestSchema.parse({
        languages: { A: unsupportedLanguage, B: "zh-TW" },
        translationMode: "balanced",
      }));
      assert.throws(() => createSessionRequestSchema.parse({
        languages: { A: "en-US", B: unsupportedLanguage },
        translationMode: "balanced",
      }));
    }

    for (const languages of [
      { A: "en-US", B: "en-US" },
      { A: "zh-TW", B: "zh-TW" },
    ]) {
      assert.throws(() => createSessionRequestSchema.parse({
        languages,
        translationMode: "balanced",
      }));
    }
  });

  it("accepts glossary imports only for the English and Traditional Chinese POC pair", () => {
    const requestBase = {
      name: "factory",
      fileName: "factory.csv",
      contentsBase64: Buffer.from("id,source,aliases,target_exact").toString("base64"),
      approvedBy: "Glossary owner",
    };

    for (const languages of [
      { sourceLanguage: "en-US", targetLanguage: "zh-TW" },
      { sourceLanguage: "zh-TW", targetLanguage: "en-US" },
    ]) {
      const request = importGlossaryRequestSchema.parse({ ...requestBase, ...languages });
      assert.deepEqual(
        { sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage },
        languages,
      );
    }

    for (const unsupportedLanguage of ["ja-JP", "ko-KR", "es-ES", "fr-FR", "de-DE"]) {
      assert.throws(() => importGlossaryRequestSchema.parse({
        ...requestBase,
        sourceLanguage: unsupportedLanguage,
        targetLanguage: "zh-TW",
      }));
      assert.throws(() => importGlossaryRequestSchema.parse({
        ...requestBase,
        sourceLanguage: "en-US",
        targetLanguage: unsupportedLanguage,
      }));
    }

    for (const languages of [
      { sourceLanguage: "en-US", targetLanguage: "en-US" },
      { sourceLanguage: "zh-TW", targetLanguage: "zh-TW" },
    ]) {
      assert.throws(() => importGlossaryRequestSchema.parse({ ...requestBase, ...languages }));
    }
  });

  it("accepts only an explicit participant recording and processing consent", () => {
    const consent = participantRecordingProcessingConsentRequestSchema.parse({
      accepted: true,
      consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
    });
    assert.deepEqual(consent, {
      accepted: true,
      consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
    });
    assert.throws(
      () => participantRecordingProcessingConsentRequestSchema.parse({
        accepted: false,
        consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
      }),
      /accepted/i,
    );
    assert.throws(
      () => participantRecordingProcessingConsentRequestSchema.parse({
        accepted: true,
        consentId: "not-a-uuid",
      }),
      /uuid/i,
    );
    assert.throws(
      () => participantRecordingProcessingConsentRequestSchema.parse({
        accepted: true,
        consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
        noticeVersion: "client-controlled",
      }),
      /unrecognized key/i,
    );
  });

  it("accepts a participant withdrawal id without letting the client choose the consent receipt", () => {
    const withdrawal = participantRecordingProcessingWithdrawalRequestSchema.parse({
      withdrawalId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
    });
    assert.deepEqual(withdrawal, {
      withdrawalId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
    });
    assert.throws(
      () => participantRecordingProcessingWithdrawalRequestSchema.parse({
        withdrawalId: "not-a-uuid",
      }),
      /uuid/i,
    );
    assert.throws(
      () => participantRecordingProcessingWithdrawalRequestSchema.parse({
        withdrawalId: "78db594d-f8ac-4e08-bb36-2c0d8184f4a2",
        consentId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
      }),
      /unrecognized key/i,
    );
  });

  it("accepts an explicit supported speed mode", () => {
    const parsed = createSessionRequestSchema.parse({
      languages: { A: "en-US", B: "zh-TW" },
      translationMode: "accurate",
      glossaryVersion: "factory-v1",
    });

    assert.equal(parsed.translationMode, "accurate");
    assert.equal(parsed.glossaryVersion, "factory-v1");
  });

  it("rejects profile names and unknown translation modes", () => {
    assert.throws(() => createSessionRequestSchema.parse({
      languages: { A: "en-US", B: "zh-TW" },
      translationMode: "palabra_live",
    }));
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
    assert.deepEqual(sessionCommandSchema.parse({
      kind: "arm_recorder",
      commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
    }), {
      kind: "arm_recorder",
      commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7",
    });
    assert.throws(() => sessionCommandSchema.parse({ kind: "start", commandId: "same" }));
  });

  it("only admits speech boundary media controls", () => {
    assert.deepEqual(mediaControlSchema.parse({ type: "speech_start" }), { type: "speech_start" });
    assert.throws(() => mediaControlSchema.parse({ type: "clear", generation: 2 }));
  });

  it("encodes generation-aware binary playout packets against a fixed little-endian vector", () => {
    const expected = Uint8Array.from([
      0x04, 0x03, 0x02, 0x01,
      0xd0, 0xc0, 0xb0, 0xa0,
      0x34, 0x12,
    ]);
    assert.deepEqual(packPlayoutAudio(0x01020304, 0xa0b0c0d0, Uint8Array.from([0x34, 0x12])), expected);

    const prefixed = Uint8Array.from([0xff, 0xee, ...expected]);
    const unpacked = unpackPlayoutAudio(prefixed.subarray(2));
    assert.equal(unpacked.generation, 0x01020304);
    assert.equal(unpacked.sequence, 0xa0b0c0d0);
    assert.deepEqual(unpacked.pcm16le, Uint8Array.from([0x34, 0x12]));
  });

  it("rejects malformed binary packets", () => {
    assert.throws(() => unpackPlayoutAudio(new Uint8Array(8)), /complete PCM16/);
    assert.throws(() => packPlayoutAudio(-1, 0, new Uint8Array(2)), /generation/);
  });
});

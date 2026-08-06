import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import { loadConfig } from "../src/config.js";

const validKey = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig", () => {
  it("loads a deterministic in-memory profile without provider credentials", () => {
    const config = loadConfig(
      {
        TRANSLATION_PROFILE: "deterministic_test",
        EVIDENCE_PROFILE: "in_memory",
      },
      "C:/workspace",
    );

    assert.equal(config.port, 4207);
    assert.equal(config.translationProfile, "deterministic_test");
    assert.equal(config.evidenceProfile, "in_memory");
    assert.equal(config.openaiApiKey, undefined);
    assert.match(config.operatorToken, /^[A-Za-z0-9_-]{43}$/u);
  });

  it("loads the controlled local evaluation profile without provider credentials", () => {
    const config = loadConfig({
      TRANSLATION_PROFILE: "local_eval",
      LOCAL_EVAL_TRANSCRIPT_A_TO_B: "Verify the mistake proofing fixture.",
      LOCAL_EVAL_TRANSCRIPT_B_TO_A: "請確認防呆治具。",
      LOCAL_EVAL_CONFIDENCE: "0.91",
      LOCAL_EVAL_TRANSLATION_MODE: "preserve",
      EVIDENCE_PROFILE: "in_memory",
    });

    assert.equal(config.translationProfile, "local_eval");
    assert.equal(config.openaiApiKey, undefined);
    assert.equal(config.localEvalTranscriptAToB, "Verify the mistake proofing fixture.");
    assert.equal(config.localEvalTranscriptBToA, "請確認防呆治具。");
    assert.equal(config.localEvalConfidence, 0.91);
    assert.equal(config.localEvalTranslationMode, "preserve");
  });

  it("accepts a strong configured operator token and rejects weak values", () => {
    const operatorToken = "operator-" + "x".repeat(32);
    const config = loadConfig({
      OPERATOR_TOKEN: operatorToken,
      TRANSLATION_PROFILE: "deterministic_test",
      EVIDENCE_PROFILE: "in_memory",
    });

    assert.equal(config.operatorToken, operatorToken);
    assert.throws(
      () =>
        loadConfig({
          OPERATOR_TOKEN: "too-short",
          TRANSLATION_PROFILE: "deterministic_test",
          EVIDENCE_PROFILE: "in_memory",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /32/u);
        return true;
      },
    );
  });
  it("loads the Palabra profile only with its server key and validates chunk pacing", () => {
    const config = loadConfig({
      TRANSLATION_PROFILE: "palabra_live",
      PALABRA_API_KEY: "palabra-test-key",
      PALABRA_INPUT_CHUNK_MS: "280",
      EVIDENCE_PROFILE: "in_memory",
    });
    assert.equal(config.translationProfile, "palabra_live");
    assert.equal(config.palabraApiKey, "palabra-test-key");
    assert.equal(config.palabraInputChunkMs, 280);
    assert.throws(
      () => loadConfig({
        TRANSLATION_PROFILE: "palabra_live",
        PALABRA_API_KEY: "palabra-test-key",
        PALABRA_INPUT_CHUNK_MS: "21",
        EVIDENCE_PROFILE: "in_memory",
      }),
      /multiple of 20/u,
    );
    assert.throws(
      () => loadConfig({ TRANSLATION_PROFILE: "palabra_live", EVIDENCE_PROFILE: "in_memory" }),
      /PALABRA_API_KEY/u,
    );
  });

  it("requires an OpenAI key for live profiles", () => {
    assert.throws(
      () =>
        loadConfig({
          TRANSLATION_PROFILE: "glossary_controlled",
          EVIDENCE_PROFILE: "in_memory",
        }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /OPENAI_API_KEY/);
        return true;
      },
    );
  });

  it("requires a 32-byte evidence key for encrypted recording", () => {
    assert.throws(
      () =>
        loadConfig({
          TRANSLATION_PROFILE: "deterministic_test",
          EVIDENCE_PROFILE: "encrypted_local",
          EVIDENCE_KEY_BASE64: Buffer.alloc(16).toString("base64"),
        }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /exactly 32 bytes/);
        return true;
      },
    );
  });

  it("decodes the evidence key without exposing it in other config fields", () => {
    const config = loadConfig({
      TRANSLATION_PROFILE: "deterministic_test",
      EVIDENCE_PROFILE: "encrypted_local",
      EVIDENCE_KEY_BASE64: validKey,
    });

    assert.equal(config.evidenceKey?.byteLength, 32);
    assert.equal(config.evidenceKey?.equals(Buffer.alloc(32, 7)), true);
  });

  it("requires the TLS certificate and key as a pair", () => {
    assert.throws(
      () =>
        loadConfig({
          TRANSLATION_PROFILE: "deterministic_test",
          EVIDENCE_PROFILE: "in_memory",
          TLS_CERT_PATH: "cert.pem",
        }),
      /TLS_CERT_PATH and TLS_KEY_PATH/,
    );
  });

  it("resolves optional TLS files for a secure two-phone LAN demo", () => {
    const config = loadConfig(
      {
        TRANSLATION_PROFILE: "deterministic_test",
        EVIDENCE_PROFILE: "in_memory",
        TLS_CERT_PATH: "certs/lan.pem",
        TLS_KEY_PATH: "certs/lan-key.pem",
      },
      "C:/workspace",
    );
    assert.match(config.tlsCertPath ?? "", /workspace[\\/]certs[\\/]lan\.pem$/u);
    assert.match(config.tlsKeyPath ?? "", /workspace[\\/]certs[\\/]lan-key\.pem$/u);
  });
});

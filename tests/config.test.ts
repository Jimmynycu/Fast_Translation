import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import { loadConfig } from "../src/config.js";

const validKey = Buffer.alloc(32, 7).toString("base64");

describe("loadConfig", () => {
  it("loads the selected provider and its default session mode", () => {
    const config = loadConfig(
      {
        TRANSLATION_PROVIDER: "palabra",
        TRANSLATION_MODE: "accurate",
        PALABRA_API_KEY: "palabra-test-key",
        EVIDENCE_PROFILE: "in_memory",
      },
      "C:/workspace",
    );

    assert.equal(config.port, 4207);
    assert.equal(config.translationProvider, "palabra");
    assert.equal(config.translationMode, "accurate");
    assert.equal(config.translationBehavior.mode, "accurate");
    assert.equal(config.translationBehavior.version, 1);
    assert.equal(config.palabraApiKey, "palabra-test-key");
    assert.equal(config.openaiApiKey, undefined);
    assert.equal("translationProfile" in config, false);
    assert.match(config.operatorToken, /^[A-Za-z0-9_-]{43}$/u);
  });

  it("defaults to the balanced OpenAI controlled provider", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "in_memory",
    });

    assert.equal(config.translationProvider, "openai_controlled");
    assert.equal(config.translationMode, "balanced");
  });

  it("requires only the selected provider's server-side key", () => {
    assert.throws(
      () => loadConfig({
        TRANSLATION_PROVIDER: "palabra",
        EVIDENCE_PROFILE: "in_memory",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /PALABRA_API_KEY/u);
        return true;
      },
    );

    assert.throws(
      () => loadConfig({
        TRANSLATION_PROVIDER: "openai_native",
        EVIDENCE_PROFILE: "in_memory",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /OPENAI_API_KEY/u);
        return true;
      },
    );

    const config = loadConfig({
      TRANSLATION_PROVIDER: "palabra",
      PALABRA_API_KEY: "palabra-test-key",
      EVIDENCE_PROFILE: "in_memory",
    });
    assert.equal(config.openaiApiKey, undefined);
  });

  it("admits only the approved provider and mode values", () => {
    assert.throws(
      () => loadConfig({
        TRANSLATION_PROVIDER: "deterministic_test",
        EVIDENCE_PROFILE: "in_memory",
      }),
      /Invalid option/u,
    );
    assert.throws(
      () => loadConfig({
        TRANSLATION_PROVIDER: "openai_controlled",
        TRANSLATION_MODE: "instant",
        OPENAI_API_KEY: "openai-test-key",
        EVIDENCE_PROFILE: "in_memory",
      }),
      /Invalid option/u,
    );
  });

  it("keeps media selection independent from translation provider selection", () => {
    const config = loadConfig({
      TRANSLATION_PROVIDER: "openai_native",
      TRANSLATION_MODE: "fast",
      OPENAI_API_KEY: "openai-test-key",
      MEDIA_PROFILE: "fake_telephony",
      EVIDENCE_PROFILE: "in_memory",
    });

    assert.equal(config.mediaProfile, "fake_telephony");
    assert.equal(config.translationProvider, "openai_native");
    assert.equal(config.translationMode, "fast");
  });

  it("validates Palabra input chunk pacing", () => {
    const config = loadConfig({
      TRANSLATION_PROVIDER: "palabra",
      PALABRA_API_KEY: "palabra-test-key",
      PALABRA_INPUT_CHUNK_MS: "280",
      EVIDENCE_PROFILE: "in_memory",
    });
    assert.equal(config.palabraInputChunkMs, 280);
    assert.throws(
      () => loadConfig({
        TRANSLATION_PROVIDER: "palabra",
        PALABRA_API_KEY: "palabra-test-key",
        PALABRA_INPUT_CHUNK_MS: "21",
        EVIDENCE_PROFILE: "in_memory",
      }),
      /multiple of 20/u,
    );
  });

  it("accepts a strong configured operator token and rejects weak values", () => {
    const operatorToken = "operator-" + "x".repeat(32);
    const config = loadConfig({
      OPERATOR_TOKEN: operatorToken,
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "in_memory",
    });

    assert.equal(config.operatorToken, operatorToken);
    assert.throws(
      () => loadConfig({
        OPERATOR_TOKEN: "too-short",
        OPENAI_API_KEY: "openai-test-key",
        EVIDENCE_PROFILE: "in_memory",
      }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /32/u);
        return true;
      },
    );
  });

  it("requires a 32-byte evidence key for encrypted recording", () => {
    assert.throws(
      () => loadConfig({
        OPENAI_API_KEY: "openai-test-key",
        EVIDENCE_PROFILE: "encrypted_local",
        EVIDENCE_KEY_BASE64: Buffer.alloc(16).toString("base64"),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ZodError);
        assert.match(error.message, /exactly 32 bytes/u);
        return true;
      },
    );
  });

  it("decodes the evidence key without exposing it in other config fields", () => {
    const config = loadConfig({
      OPENAI_API_KEY: "openai-test-key",
      EVIDENCE_PROFILE: "encrypted_local",
      EVIDENCE_KEY_BASE64: validKey,
    });

    assert.equal(config.evidenceKey?.byteLength, 32);
    assert.equal(config.evidenceKey?.equals(Buffer.alloc(32, 7)), true);
  });

  it("requires the TLS certificate and key as a pair", () => {
    assert.throws(
      () => loadConfig({
        OPENAI_API_KEY: "openai-test-key",
        EVIDENCE_PROFILE: "in_memory",
        TLS_CERT_PATH: "cert.pem",
      }),
      /TLS_CERT_PATH and TLS_KEY_PATH/u,
    );
  });

  it("resolves optional TLS files for a secure two-phone LAN demo", () => {
    const config = loadConfig(
      {
        OPENAI_API_KEY: "openai-test-key",
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

import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { MEDIA_PROFILES, type MediaProfile } from "./core/types.js";

const optionalSecret = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(1).optional(),
);

const optionalOperatorToken = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().min(32).max(512).regex(/^\S+$/u, "must not contain whitespace").optional(),
);

const environmentSchema = z
  .object({
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(4207),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:4207"),
    TLS_CERT_PATH: optionalSecret,
    TLS_KEY_PATH: optionalSecret,
    OPENAI_API_KEY: optionalSecret,
    OPERATOR_TOKEN: optionalOperatorToken,
    OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-translate"),
    OPENAI_TRANSCRIBE_MODEL: z.string().min(1).default("gpt-live-transcribe"),
    OPENAI_TEXT_MODEL: z.string().min(1).default("gpt-5.4-mini"),
    OPENAI_TTS_MODEL: z.string().min(1).default("gpt-4o-mini-tts"),
    OPENAI_TTS_VOICE: z.string().min(1).default("marin"),
    LOCAL_EVAL_TRANSCRIPT_A_TO_B: z.string().trim().min(1).max(4_096)
      .default("Verify the mistake proofing fixture."),
    LOCAL_EVAL_TRANSCRIPT_B_TO_A: z.string().trim().min(1).max(4_096)
      .default("請確認防呆治具。"),
    LOCAL_EVAL_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.99),
    LOCAL_EVAL_TRANSLATION_MODE: z.enum(["preserve", "drop_placeholders"]).default("preserve"),
    MEDIA_PROFILE: z.enum(MEDIA_PROFILES).default("browser_pair"),
    TRANSLATION_PROFILE: z
      .enum(["native_live_baseline", "glossary_controlled", "local_eval", "deterministic_test"])
      .default("glossary_controlled"),
    EVIDENCE_PROFILE: z.enum(["encrypted_local", "in_memory"]).default("encrypted_local"),
    EVIDENCE_DIRECTORY: z.string().min(1).default("./data/evidence"),
    GLOSSARY_DIRECTORY: z.string().min(1).default("./data/glossaries"),
    EVIDENCE_KEY_BASE64: optionalSecret,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  })
  .superRefine((value, context) => {
    if ((value.TLS_CERT_PATH === undefined) !== (value.TLS_KEY_PATH === undefined)) {
      context.addIssue({
        code: "custom",
        path: [value.TLS_CERT_PATH === undefined ? "TLS_CERT_PATH" : "TLS_KEY_PATH"],
        message: "TLS_CERT_PATH and TLS_KEY_PATH must be configured together",
      });
    }

    if (
      (value.TRANSLATION_PROFILE === "native_live_baseline" ||
        value.TRANSLATION_PROFILE === "glossary_controlled") &&
      value.OPENAI_API_KEY === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: `OPENAI_API_KEY is required for ${value.TRANSLATION_PROFILE}`,
      });
    }

    if (value.EVIDENCE_PROFILE === "encrypted_local") {
      if (value.EVIDENCE_KEY_BASE64 === undefined) {
        context.addIssue({
          code: "custom",
          path: ["EVIDENCE_KEY_BASE64"],
          message: "EVIDENCE_KEY_BASE64 is required for encrypted_local evidence",
        });
      } else {
        let byteLength = 0;
        try {
          byteLength = Buffer.from(value.EVIDENCE_KEY_BASE64, "base64").byteLength;
        } catch {
          byteLength = 0;
        }
        if (byteLength !== 32) {
          context.addIssue({
            code: "custom",
            path: ["EVIDENCE_KEY_BASE64"],
            message: "EVIDENCE_KEY_BASE64 must decode to exactly 32 bytes",
          });
        }
      }
    }
  });

export type AppConfig = Readonly<{
  host: string;
  port: number;
  publicBaseUrl: URL;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  openaiApiKey?: string;
  operatorToken: string;
  openaiRealtimeModel: string;
  openaiTranscribeModel: string;
  openaiTextModel: string;
  openaiTtsModel: string;
  openaiTtsVoice: string;
  localEvalTranscriptAToB: string;
  localEvalTranscriptBToA: string;
  localEvalConfidence: number;
  localEvalTranslationMode: "preserve" | "drop_placeholders";
  mediaProfile: MediaProfile;
  translationProfile: "native_live_baseline" | "glossary_controlled" | "local_eval" | "deterministic_test";
  evidenceProfile: "encrypted_local" | "in_memory";
  evidenceDirectory: string;
  glossaryDirectory: string;
  evidenceKey?: Buffer;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
}>;

export function loadConfig(environment: NodeJS.ProcessEnv, cwd = process.cwd()): AppConfig {
  const parsed = environmentSchema.parse(environment);

  return {
    host: parsed.HOST,
    port: parsed.PORT,
    publicBaseUrl: new URL(parsed.PUBLIC_BASE_URL),
    ...(parsed.TLS_CERT_PATH === undefined
      ? {}
      : { tlsCertPath: resolve(cwd, parsed.TLS_CERT_PATH) }),
    ...(parsed.TLS_KEY_PATH === undefined ? {} : { tlsKeyPath: resolve(cwd, parsed.TLS_KEY_PATH) }),
    ...(parsed.OPENAI_API_KEY === undefined ? {} : { openaiApiKey: parsed.OPENAI_API_KEY }),
    operatorToken: parsed.OPERATOR_TOKEN ?? randomBytes(32).toString("base64url"),
    openaiRealtimeModel: parsed.OPENAI_REALTIME_MODEL,
    openaiTranscribeModel: parsed.OPENAI_TRANSCRIBE_MODEL,
    openaiTextModel: parsed.OPENAI_TEXT_MODEL,
    openaiTtsModel: parsed.OPENAI_TTS_MODEL,
    openaiTtsVoice: parsed.OPENAI_TTS_VOICE,
    localEvalTranscriptAToB: parsed.LOCAL_EVAL_TRANSCRIPT_A_TO_B,
    localEvalTranscriptBToA: parsed.LOCAL_EVAL_TRANSCRIPT_B_TO_A,
    localEvalConfidence: parsed.LOCAL_EVAL_CONFIDENCE,
    localEvalTranslationMode: parsed.LOCAL_EVAL_TRANSLATION_MODE,
    mediaProfile: parsed.MEDIA_PROFILE,
    translationProfile: parsed.TRANSLATION_PROFILE,
    evidenceProfile: parsed.EVIDENCE_PROFILE,
    evidenceDirectory: resolve(cwd, parsed.EVIDENCE_DIRECTORY),
    glossaryDirectory: resolve(cwd, parsed.GLOSSARY_DIRECTORY),
    ...(parsed.EVIDENCE_KEY_BASE64 === undefined
      ? {}
      : { evidenceKey: Buffer.from(parsed.EVIDENCE_KEY_BASE64, "base64") }),
    logLevel: parsed.LOG_LEVEL,
  };
}

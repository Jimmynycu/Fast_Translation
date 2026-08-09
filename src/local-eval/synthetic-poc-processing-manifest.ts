import { compileGlossary, type GlossarySpec } from "../core/glossary.js";
import {
  canonicalJsonSha256,
  createSessionProcessingManifest,
  validateApprovedSessionProcessingProfile,
  type ApprovedSessionProcessingProfile,
  type ContractEvidenceReference,
  type ExternalAssurance,
  type SessionProcessingManifest,
} from "../core/processing-profile.js";
import type { TranslationMode } from "../core/translation-behavior.js";

const SYNTHETIC_SHA256 = "a".repeat(64);
const SYNTHETIC_APPROVED_AT_UTC = "2026-08-09T00:00:00.000Z";

function contractReference(id: string): ContractEvidenceReference {
  return {
    id,
    revision: "synthetic-poc-v1",
    sha256: SYNTHETIC_SHA256,
    approvedBy: "synthetic-poc-harness@example.test",
    approvedAtUtc: SYNTHETIC_APPROVED_AT_UTC,
  };
}

function unverified<T>(reason: string): ExternalAssurance<T> {
  return {
    status: "unverified",
    reason,
    acceptanceImpact: "NOT_RUN",
  };
}

const SYNTHETIC_POC_PROFILE_BODY = {
  schemaVersion: 1,
  kind: "approved_session_processing_profile",
  id: "synthetic-keyless-poc",
  version: "2026-08-09",
  operationScope: "poc",
  translation: {
    provider: "openai_controlled",
    allowedModes: ["fast", "balanced", "accurate"],
    defaultMode: "balanced",
    behaviorVersion: 1,
  },
  services: [{
    id: "synthetic-transcription",
    role: "transcription",
    provider: "openai",
    category: "managed_transcription",
    dataCategories: ["canonical_audio", "source_language", "source_terms", "aliases"],
    endpoint: { origin: "https://synthetic.invalid", pathTemplate: "/v1/audio/transcriptions" },
    model: { kind: "named", value: "synthetic-local-eval-stt" },
    voice: { kind: "not_applicable" },
    region: unverified<string>("Synthetic keyless harness does not verify an external processing region."),
    trainingUse: unverified<"no_training">("Synthetic keyless harness does not verify provider training use."),
    serviceRetention: unverified<{ readonly kind: "zero_retention" }>(
      "Synthetic keyless harness does not verify provider retention.",
    ),
    dpa: unverified<ContractEvidenceReference>("Synthetic keyless harness has no external DPA evidence."),
  }, {
    id: "synthetic-text-translation",
    role: "text_translation",
    provider: "openai",
    category: "managed_text_translation",
    dataCategories: ["source_transcript", "source_language", "target_language", "opaque_placeholders"],
    endpoint: { origin: "https://synthetic.invalid", pathTemplate: "/v1/responses" },
    model: { kind: "named", value: "synthetic-local-eval-translation" },
    voice: { kind: "not_applicable" },
    region: unverified<string>("Synthetic keyless harness does not verify an external processing region."),
    trainingUse: unverified<"no_training">("Synthetic keyless harness does not verify provider training use."),
    serviceRetention: unverified<{ readonly kind: "zero_retention" }>(
      "Synthetic keyless harness does not verify provider retention.",
    ),
    dpa: unverified<ContractEvidenceReference>("Synthetic keyless harness has no external DPA evidence."),
  }, {
    id: "synthetic-tts",
    role: "tts",
    provider: "openai",
    category: "managed_tts",
    dataCategories: ["authorized_target_text"],
    endpoint: { origin: "https://synthetic.invalid", pathTemplate: "/v1/audio/speech" },
    model: { kind: "named", value: "synthetic-local-eval-tts" },
    voice: { kind: "named", value: "synthetic" },
    region: unverified<string>("Synthetic keyless harness does not verify an external processing region."),
    trainingUse: unverified<"no_training">("Synthetic keyless harness does not verify provider training use."),
    serviceRetention: unverified<{ readonly kind: "zero_retention" }>(
      "Synthetic keyless harness does not verify provider retention.",
    ),
    dpa: unverified<ContractEvidenceReference>("Synthetic keyless harness has no external DPA evidence."),
  }],
  glossaryEgress: {
    harnessPinnedGlossary: "local_pinned",
    stages: [{
      role: "transcription",
      fields: ["source_terms", "aliases"],
    }, {
      role: "text_translation",
      fields: ["opaque_placeholders"],
    }, {
      role: "tts",
      fields: ["authorized_target_text"],
    }],
    providerAccountGlossary: unverified<"disabled">(
      "Synthetic keyless harness does not verify provider account glossary state.",
    ),
  },
  fallback: {
    kind: "none",
    approval: contractReference("synthetic-fallback-approval"),
  },
  evidence: {
    storage: "local_encrypted_file",
    encryption: "aes_256_gcm",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    providerEvents: "final_only",
    provisionalEvents: "live_only",
    browserEvidenceRefs: "redacted",
    plaintextExport: "explicit_owner_acknowledgement",
    minimumFreeBytes: "1048576",
  },
  retentionPolicy: {
    policyRef: contractReference("synthetic-retention-policy"),
    mode: "scheduled_delete",
    defaultDays: 14,
    maximumDays: 30,
    verificationMaximumHours: 24,
  },
  consentPolicy: {
    ...contractReference("synthetic-consent-policy"),
    noticeVersion: "synthetic-poc-v1",
    recordingRequired: true,
    processingRequired: true,
    withdrawalTerminatesSession: true,
  },
  approval: {
    approvalId: "synthetic-poc-approval",
    approvedBy: "synthetic-poc-harness@example.test",
    approvedAtUtc: SYNTHETIC_APPROVED_AT_UTC,
  },
} as const satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;

const SYNTHETIC_POC_PROCESSING_PROFILE: ApprovedSessionProcessingProfile = Object.freeze({
  ...SYNTHETIC_POC_PROFILE_BODY,
  sha256: canonicalJsonSha256(SYNTHETIC_POC_PROFILE_BODY),
});

const SYNTHETIC_POC_VALIDATION = validateApprovedSessionProcessingProfile(
  SYNTHETIC_POC_PROCESSING_PROFILE,
);

if (SYNTHETIC_POC_VALIDATION.acceptanceImpact !== "NOT_RUN") {
  throw new Error("Synthetic POC profile must retain NOT_RUN external acceptance");
}

/**
 * Test/tooling-only profile for keyless local evaluation. Production
 * composition and server startup must load an independently approved profile.
 */
export function createSyntheticPocProcessingProfile(): ApprovedSessionProcessingProfile {
  return SYNTHETIC_POC_PROCESSING_PROFILE;
}

/**
 * Creates the immutable per-session projection used only by synthetic local
 * evaluation and acceptance harnesses.
 */
export function createSyntheticPocProcessingManifest(input: Readonly<{
  mode: TranslationMode;
  glossary?: GlossarySpec;
}>): SessionProcessingManifest {
  const compiledGlossary = input.glossary === undefined
    ? undefined
    : compileGlossary(input.glossary);
  return createSessionProcessingManifest({
    profile: SYNTHETIC_POC_PROCESSING_PROFILE,
    mode: input.mode,
    ...(compiledGlossary === undefined ? {} : {
      glossary: {
        id: compiledGlossary.id,
        version: compiledGlossary.version,
        hash: compiledGlossary.hash,
      },
    }),
  });
}

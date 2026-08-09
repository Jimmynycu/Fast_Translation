import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertParticipantConsentForManifest,
  canonicalJsonSha256,
  createSessionProcessingManifest,
  validateApprovedSessionProcessingProfile,
  validateSessionProcessingManifest,
  validateSessionSpecAgainstProcessingProfile,
  validateSessionSpecProcessingManifest,
  type ApprovedSessionProcessingProfile,
  type SessionProcessingManifest,
} from "../src/core/processing-profile.js";
import {
  validateEvidenceFinalization,
  validateEvidenceFinalizeRequest,
  validateEvidenceRecorderPreflightRecord,
  validateRecorderPreflightRequest,
  validateRecorderPreflightResult,
  type EvidenceFinalization,
  type EvidenceFinalizeRequest,
  type RecorderPreflightFailureCode,
  type RecorderPreflightRequest,
  type RecorderPreflightResult,
} from "../src/core/evidence-lifecycle.js";
import { compileGlossary, type GlossarySpec } from "../src/core/glossary.js";
import type {
  EvidenceRecorderPreflightRecord,
  ParticipantConsentCommand,
  SessionSpec,
} from "../src/core/types.js";

const APPROVAL_EVIDENCE = {
  id: "processing-contract-approval",
  revision: "2026-08-09",
  sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  approvedBy: "compliance@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
} as const;

const RETENTION_EVIDENCE = {
  id: "processing-contract-retention",
  revision: "2026-08-09",
  sha256: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
  approvedBy: "records@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
} as const;

const DPA_EVIDENCE = {
  id: "processing-contract-dpa",
  revision: "2026-08-09",
  sha256: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  approvedBy: "legal@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
} as const;

const UNVERIFIED_REGION = {
  status: "unverified",
  reason: "POC region assurance is pending independent verification.",
  acceptanceImpact: "NOT_RUN",
} as const;

const VERIFIED_REGION = {
  status: "verified",
  value: "us-east-1",
  evidenceRef: APPROVAL_EVIDENCE,
} as const;

const VERIFIED_TRAINING = {
  status: "verified",
  value: "no_training",
  evidenceRef: APPROVAL_EVIDENCE,
} as const;

const VERIFIED_RETENTION = {
  status: "verified",
  value: { kind: "zero_retention" },
  evidenceRef: RETENTION_EVIDENCE,
} as const;

const VERIFIED_DPA = {
  status: "verified",
  value: DPA_EVIDENCE,
  evidenceRef: DPA_EVIDENCE,
} as const;

const VERIFIED_GLOSSARY = {
  status: "verified",
  value: "disabled",
  evidenceRef: APPROVAL_EVIDENCE,
} as const;

const EVIDENCE_REVIEW_GRANT = {
  dataOwnerId: "owner-001",
  bilingualReviewerId: "reviewer-002",
} as const;

const POC_PROFILE = {
  schemaVersion: 1,
  kind: "approved_session_processing_profile",
  id: "processing-contract-poc",
  version: "2026-08-09",
  sha256: "57257df16f189af71f615480dd9ea14cf4dfee9a1bc6fc7097f86c1b7dd3fe34",
  operationScope: "poc",
  translation: {
    provider: "openai_controlled",
    allowedModes: ["fast", "balanced"],
    defaultMode: "balanced",
    behaviorVersion: 1,
  },
  services: [
    {
      id: "openai-transcription",
      role: "transcription",
      provider: "openai",
      category: "managed_transcription",
      dataCategories: ["canonical_audio", "source_language", "source_terms", "aliases"],
      endpoint: { origin: "https://api.openai.example", pathTemplate: "/v1/realtime" },
      model: { kind: "named", value: "gpt-live-transcribe" },
      voice: { kind: "not_applicable" },
      region: UNVERIFIED_REGION,
      trainingUse: VERIFIED_TRAINING,
      serviceRetention: VERIFIED_RETENTION,
      dpa: VERIFIED_DPA,
    },
    {
      id: "openai-text-translation",
      role: "text_translation",
      provider: "openai",
      category: "managed_text_translation",
      dataCategories: ["source_transcript", "source_language", "target_language", "opaque_placeholders"],
      endpoint: { origin: "https://api.openai.example", pathTemplate: "/v1/responses" },
      model: { kind: "named", value: "gpt-4.1-mini" },
      voice: { kind: "not_applicable" },
      region: VERIFIED_REGION,
      trainingUse: VERIFIED_TRAINING,
      serviceRetention: VERIFIED_RETENTION,
      dpa: VERIFIED_DPA,
    },
    {
      id: "openai-tts",
      role: "tts",
      provider: "openai",
      category: "managed_tts",
      dataCategories: ["authorized_target_text"],
      endpoint: { origin: "https://api.openai.example", pathTemplate: "/v1/audio/speech" },
      model: { kind: "named", value: "gpt-4o-mini-tts" },
      voice: { kind: "named", value: "alloy" },
      region: VERIFIED_REGION,
      trainingUse: VERIFIED_TRAINING,
      serviceRetention: VERIFIED_RETENTION,
      dpa: VERIFIED_DPA,
    },
  ],
  glossaryEgress: {
    harnessPinnedGlossary: "local_pinned",
    stages: [
      { role: "transcription", fields: ["source_terms", "aliases"] },
      { role: "text_translation", fields: ["opaque_placeholders"] },
      { role: "tts", fields: ["authorized_target_text"] },
    ],
    providerAccountGlossary: VERIFIED_GLOSSARY,
  },
  fallback: { kind: "none", approval: APPROVAL_EVIDENCE },
  evidence: {
    storage: "local_encrypted_file",
    encryption: "aes_256_gcm",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    providerEvents: "final_only",
    provisionalEvents: "live_only",
    browserEvidenceRefs: "redacted",
    plaintextExport: "explicit_owner_acknowledgement",
    minimumFreeBytes: "67108864",
  },
  retentionPolicy: {
    policyRef: RETENTION_EVIDENCE,
    mode: "scheduled_delete",
    defaultDays: 14,
    maximumDays: 30,
    verificationMaximumHours: 24,
  },
  consentPolicy: {
    id: "processing-contract-consent",
    revision: "2026-08-09",
    sha256: "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    approvedBy: "privacy@example.test",
    approvedAtUtc: "2026-08-09T00:00:00.000Z",
    noticeVersion: "processing-contract-notice-v1",
    recordingRequired: true,
    processingRequired: true,
    withdrawalTerminatesSession: true,
  },
  approval: {
    approvalId: "processing-contract-approval-001",
    approvedBy: "compliance@example.test",
    approvedAtUtc: "2026-08-09T00:00:00.000Z",
  },
} as const satisfies ApprovedSessionProcessingProfile;

function rehashedPalabraProfile(pathTemplate: string): ApprovedSessionProcessingProfile {
  const { sha256: _sha256, ...base } = POC_PROFILE;
  const body = {
    ...base,
    id: "processing-contract-palabra-poc",
    translation: {
      provider: "palabra",
      allowedModes: ["fast", "balanced"],
      defaultMode: "balanced",
      behaviorVersion: 1,
    },
    services: [{
      id: "palabra-speech",
      role: "speech_to_speech",
      provider: "palabra",
      category: "managed_realtime_speech_translation",
      dataCategories: ["canonical_audio", "source_language", "target_language"],
      endpoint: { origin: "https://streaming.palabra.example", pathTemplate },
      model: { kind: "vendor_managed", reason: "Provider selects its approved model." },
      voice: { kind: "provider_managed", reason: "Provider selects its approved voice." },
      region: UNVERIFIED_REGION,
      trainingUse: VERIFIED_TRAINING,
      serviceRetention: VERIFIED_RETENTION,
      dpa: VERIFIED_DPA,
    }],
    glossaryEgress: {
      harnessPinnedGlossary: "disallowed",
      stages: [],
      providerAccountGlossary: VERIFIED_GLOSSARY,
    },
  };
  return {
    ...body,
    sha256: canonicalJsonSha256(body),
  } as unknown as ApprovedSessionProcessingProfile;
}

function rehashedOpenaiNativeProfile(
  dataCategories: readonly ["canonical_audio", "target_language"] | readonly [
    "canonical_audio",
    "source_language",
    "target_language",
  ],
): ApprovedSessionProcessingProfile {
  const { sha256: _sha256, ...base } = POC_PROFILE;
  const firstService = POC_PROFILE.services[0];
  if (firstService === undefined) throw new Error("POC profile must include a service");
  const body = {
    ...base,
    id: "processing-contract-openai-native-poc",
    translation: {
      provider: "openai_native",
      allowedModes: ["fast", "balanced"],
      defaultMode: "balanced",
      behaviorVersion: 1,
    },
    services: [{
      ...firstService,
      id: "openai-native-speech",
      role: "speech_to_speech",
      provider: "openai",
      category: "managed_realtime_speech_translation",
      dataCategories,
      endpoint: { origin: "https://api.openai.com", pathTemplate: "/v1/realtime/translations" },
      model: { kind: "named", value: "gpt-realtime-translate" },
      voice: { kind: "provider_managed", reason: "OpenAI selects the translation voice." },
    }],
    glossaryEgress: {
      harnessPinnedGlossary: "disallowed",
      stages: [],
      providerAccountGlossary: POC_PROFILE.glossaryEgress.providerAccountGlossary,
    },
  };
  return {
    ...body,
    sha256: canonicalJsonSha256(body),
  } as unknown as ApprovedSessionProcessingProfile;
}

const GLOSSARY_SPEC = {
  id: "processing-contract-glossary",
  version: "2026-08-09",
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  entries: [{
    id: "bolt",
    source: "bolt",
    aliases: ["fastener"],
    targetExact: "bolt-target",
  }],
} as const satisfies GlossarySpec;

const GLOSSARY_REFERENCE = {
  id: "processing-contract-glossary",
  version: "2026-08-09",
  hash: "bb7c77e0a3f7ab1862ba6e91ee9a3f8b8b9b2cdf3e895a53fea04eb45d0af8a0",
} as const;

const FULLY_VERIFIED_POC_PROFILE = {
  ...POC_PROFILE,
  services: [
    { ...POC_PROFILE.services[0], region: VERIFIED_REGION },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "d19eef9039f5f17f51535222d0f201d341ac227b933a902abbb41b7a71f79597",
} as const satisfies ApprovedSessionProcessingProfile;

const PRODUCTION_PROFILE_WITH_UNVERIFIED_ASSURANCE = {
  ...POC_PROFILE,
  operationScope: "production",
  sha256: "e08297b0af899eac1c862cdf7484218d0785f60632dc231f11789806f21065fc",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_PROFILE_SHA256 = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

const INVALID_OPERATION_SCOPE_PROFILE = {
  ...POC_PROFILE,
  operationScope: "staging",
  sha256: "087dd976c49da41449fc4517bdca443cedee52b296ebb424ba0faf2bf883c506",
} as const as unknown as ApprovedSessionProcessingProfile;

const INVALID_ASSURANCE_DISCRIMINANT_PROFILE = {
  ...POC_PROFILE,
  services: [
    { ...POC_PROFILE.services[0], region: { ...UNVERIFIED_REGION, status: "pending" } },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "d9dd1beac2e7b850072afdf06e7de57dad5b5243aaf25b3631a78ebb05858d64",
} as const as unknown as ApprovedSessionProcessingProfile;

const INVALID_UNVERIFIED_ASSURANCE_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      region: { status: "unverified", reason: "", acceptanceImpact: "PASS" },
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "1446666cbbf9cd7333796015ae462715ba8befb2179ccb9f93d7aacab4c6bd6f",
} as const as unknown as ApprovedSessionProcessingProfile;

const INVALID_ASSURANCE_EVIDENCE_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      trainingUse: {
        ...VERIFIED_TRAINING,
        evidenceRef: { ...APPROVAL_EVIDENCE, sha256: "not-a-sha" },
      },
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "7d4124914d5c169e6bc9713de02b6ae25b851f80f0f5ead991fa884db1153f97",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_VERIFIED_VALUE_PROFILE = {
  ...POC_PROFILE,
  services: [
    POC_PROFILE.services[0],
    {
      ...POC_PROFILE.services[1],
      region: { ...VERIFIED_REGION, value: "" },
    },
    POC_PROFILE.services[2],
  ],
  sha256: "686beaa2ffd4223ffcd4a2918f64556c1d5a97734147287d34ddc1bb2b165f8b",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_BOUNDED_RETENTION_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      serviceRetention: {
        status: "verified",
        value: { kind: "bounded", maximumDays: 0 },
        evidenceRef: RETENTION_EVIDENCE,
      },
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "a246f17eb7fd43e7bb24e261fc8e41edfc95178e84bb65f14dfa90694d55161a",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_SERVICE_PROVIDER_PROFILE = {
  ...POC_PROFILE,
  services: [
    { ...POC_PROFILE.services[0], provider: "palabra" },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "b77038fe16cab4a82f3f0ecba0e9e808f75b4df16927e48eca26addbcfff3be2",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_SERVICE_CATEGORY_PROFILE = {
  ...POC_PROFILE,
  services: [
    { ...POC_PROFILE.services[0], category: "managed_tts" },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "a16461e1deeec27edf4462710ff32c02674411d46d494f4a669d20a4c5b01574",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_DATA_CATEGORY_ROUTE_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      dataCategories: ["canonical_audio", "source_language", "aliases", "source_terms"],
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "c60bac6bb35e214140d54035211b30ae9d14da53c92d33a19dbfa433a7994624",
} as const satisfies ApprovedSessionProcessingProfile;

const UNKNOWN_DATA_CATEGORY_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      dataCategories: ["canonical_audio", "source_language", "source_terms", "vendor_secret"],
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "5affccbf48f51c8818c1c35a9083e42ae8aabb41568d73cff7b3835dbd6eb151",
} as const as unknown as ApprovedSessionProcessingProfile;

const DUPLICATE_DATA_CATEGORY_PROFILE = {
  ...POC_PROFILE,
  services: [
    {
      ...POC_PROFILE.services[0],
      dataCategories: ["canonical_audio", "source_language", "source_terms", "aliases", "aliases"],
    },
    POC_PROFILE.services[1],
    POC_PROFILE.services[2],
  ],
  sha256: "8fea5e8f076e031d8efb762b84a5831895c89ce9417305d207e3f90ed5011217",
} as const satisfies ApprovedSessionProcessingProfile;

const REVIEWER_PLAINTEXT_EXPORT_PROFILE = {
  ...POC_PROFILE,
  evidence: {
    ...POC_PROFILE.evidence,
    plaintextExport: "explicit_reviewer_acknowledgement",
  },
  sha256: "f5508f29a6557f3d3e30652bc40a39422981ba6553665608de8bb2c0072eb65a",
} as const as unknown as ApprovedSessionProcessingProfile;

const HTTP_ORIGIN_PROFILE = {
  ...POC_PROFILE,
  services: [
    POC_PROFILE.services[0],
    {
      ...POC_PROFILE.services[1],
      endpoint: { ...POC_PROFILE.services[1].endpoint, origin: "http://api.openai.example" },
    },
    POC_PROFILE.services[2],
  ],
  sha256: "198081a1a3255313285b5b0b57e6eddbdb54dcea77a0f21be7e41ba52873f1f9",
} as const satisfies ApprovedSessionProcessingProfile;

const QUERY_PATH_PROFILE = {
  ...POC_PROFILE,
  services: [
    POC_PROFILE.services[0],
    {
      ...POC_PROFILE.services[1],
      endpoint: { ...POC_PROFILE.services[1].endpoint, pathTemplate: "/v1/responses?tenant=wrong" },
    },
    POC_PROFILE.services[2],
  ],
  sha256: "3defc6b1582609eaef626e67e3d2b324a33c9e6736a673b4b5a410fc70ace8bd",
} as const satisfies ApprovedSessionProcessingProfile;

const FRAGMENT_PATH_PROFILE = {
  ...POC_PROFILE,
  services: [
    POC_PROFILE.services[0],
    {
      ...POC_PROFILE.services[1],
      endpoint: { ...POC_PROFILE.services[1].endpoint, pathTemplate: "/v1/responses#fragment" },
    },
    POC_PROFILE.services[2],
  ],
  sha256: "8b0a55739655b62f1871ab9a67a00b99d79a6e2962d3a5c6b563f814b540ef6d",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_GLOSSARY_STAGE_ROLE_PROFILE = {
  ...POC_PROFILE,
  glossaryEgress: {
    ...POC_PROFILE.glossaryEgress,
    stages: [
      { role: "speech_to_speech", fields: [] },
      POC_PROFILE.glossaryEgress.stages[1],
      POC_PROFILE.glossaryEgress.stages[2],
    ],
  },
  sha256: "4d92469b7ca24e67d57b371aa03bd92175c02c50a323330f580da96cc9e8282c",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_GLOSSARY_STAGE_FIELDS_PROFILE = {
  ...POC_PROFILE,
  glossaryEgress: {
    ...POC_PROFILE.glossaryEgress,
    stages: [
      POC_PROFILE.glossaryEgress.stages[0],
      { ...POC_PROFILE.glossaryEgress.stages[1], fields: ["authorized_target_text"] },
      POC_PROFILE.glossaryEgress.stages[2],
    ],
  },
  sha256: "f8cbd754af0092b323ba19a0b7a71141e10e41840744bebb232cfcfc4ebd02d2",
} as const satisfies ApprovedSessionProcessingProfile;

const INVALID_PINNED_GLOSSARY_POLICY_PROFILE = {
  ...POC_PROFILE,
  glossaryEgress: {
    ...POC_PROFILE.glossaryEgress,
    harnessPinnedGlossary: "disallowed",
  },
  sha256: "0569b67e9af9230ac95fdde846d894e45443f32746775a2f985c5ce879410ef7",
} as const satisfies ApprovedSessionProcessingProfile;

const SESSION_MANIFEST_SHA256 = "18086e75862cc36e7fa8cf6db44a8e72424c3a9e27e072ddcd859eebfc0198ac";
const SERVICE_PROJECTION_SHA256 = "f6dd1205ea3c2cb8eabab462dd2be1dc40ab331bc37248b773b352a38ed1a2ef";
const FORGED_SERVICE_PROJECTION_SHA256 = "a56c7c394258b51ad6e338f6a4303abbd011bf2e153e2a4ce90899b0c3bc9db7";
const FORGED_MANIFEST_SHA256 = "a2f93d8be7c60e3efbdba8cec4d2936165e2572e18544cf17b54056bee686764";

const RECORDER_PREFLIGHT_FAILURE_VECTORS = {
  free_space_unavailable: true,
  insufficient_evidence_disk: true,
  evidence_preflight_failed: true,
  evidence_preflight_integrity_failed: true,
} as const satisfies Readonly<Record<RecorderPreflightFailureCode, true>>;

test("canonical public hash matches the fixed independently calculated vector", () => {
  assert.equal(
    canonicalJsonSha256({ z: 0, a: ["x", true] }),
    "2d7ad572f55665984804fb244676728f84152fd0c2f55d1524002356c25649d3",
  );
});

test("POC profile pins its hash and exposes an explicit unverified assurance as NOT_RUN", () => {
  assert.deepEqual(validateApprovedSessionProcessingProfile(POC_PROFILE), {
    acceptanceImpact: "NOT_RUN",
    unverifiedAssurances: ["services.openai-transcription.region"],
  });
  assert.deepEqual(validateApprovedSessionProcessingProfile(FULLY_VERIFIED_POC_PROFILE), {
    acceptanceImpact: "PASS",
    unverifiedAssurances: [],
  });
  assert.throws(
    () => validateApprovedSessionProcessingProfile({ ...POC_PROFILE, sha256: INVALID_PROFILE_SHA256 }),
    /Processing profile SHA-256 mismatch/u,
  );
});

test("production rejects a hash-pinned profile with an unverified external assurance", () => {
  assert.throws(
    () => validateApprovedSessionProcessingProfile(PRODUCTION_PROFILE_WITH_UNVERIFIED_ASSURANCE),
    /Production processing profile has unverified external assurances/u,
  );
});

test("profile rejects hash-consistent invalid operation scopes and assurance discriminants", () => {
  for (const [name, profile] of [
    ["operation scope", INVALID_OPERATION_SCOPE_PROFILE],
    ["assurance discriminant", INVALID_ASSURANCE_DISCRIMINANT_PROFILE],
    ["unverified assurance payload", INVALID_UNVERIFIED_ASSURANCE_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " must be rejected",
    );
  }
});

test("profile validates verified assurance evidence references and bounded retention values", () => {
  for (const [name, profile] of [
    ["assurance evidence reference", INVALID_ASSURANCE_EVIDENCE_PROFILE],
    ["verified assurance value", INVALID_VERIFIED_VALUE_PROFILE],
    ["bounded retention", INVALID_BOUNDED_RETENTION_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " must be rejected",
    );
  }
});

test("profile rejects hash-consistent service provider and category route mismatches", () => {
  for (const [name, profile] of [
    ["provider", INVALID_SERVICE_PROVIDER_PROFILE],
    ["category", INVALID_SERVICE_CATEGORY_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " mismatch must be rejected",
    );
  }
});

test("profile rejects hash-consistent unknown, duplicate, and route-mismatched data categories", () => {
  for (const [name, profile] of [
    ["route order", INVALID_DATA_CATEGORY_ROUTE_PROFILE],
    ["unknown category", UNKNOWN_DATA_CATEGORY_PROFILE],
    ["duplicate category", DUPLICATE_DATA_CATEGORY_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " data categories must be rejected",
    );
  }
});

test("profile requires an explicit owner acknowledgement for plaintext exports", () => {
  const { sha256, ...body } = REVIEWER_PLAINTEXT_EXPORT_PROFILE;
  assert.equal(canonicalJsonSha256(body), sha256);
  assert.throws(
    () => validateApprovedSessionProcessingProfile(REVIEWER_PLAINTEXT_EXPORT_PROFILE),
    TypeError,
  );
});

test("profile rejects hash-consistent non-HTTPS origins and query or fragment path templates", () => {
  for (const [name, profile] of [
    ["http origin", HTTP_ORIGIN_PROFILE],
    ["query path", QUERY_PATH_PROFILE],
    ["fragment path", FRAGMENT_PATH_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " must be rejected",
    );
  }
});

test("Palabra profiles require exactly one literal whole-segment route hash", () => {
  assert.doesNotThrow(() => validateApprovedSessionProcessingProfile(
    rehashedPalabraProfile("/streaming-api/{hash}/v1/speech-to-speech/stream"),
  ));

  for (const pathTemplate of [
    "/streaming-api/v1/speech-to-speech/stream",
    "/streaming-api/{hash}/{hash}/v1/speech-to-speech/stream",
    "/streaming-api/%7Bhash%7D/v1/speech-to-speech/stream",
    "/streaming-api/{hash}/%7Bhash%7D/v1/speech-to-speech/stream",
    "/streaming-api/prefix{hash}/v1/speech-to-speech/stream",
  ]) {
    assert.throws(
      () => validateApprovedSessionProcessingProfile(rehashedPalabraProfile(pathTemplate)),
      /Palabra service endpoint pathTemplate must contain exactly one literal \{hash\} whole path segment/i,
      pathTemplate,
    );
  }
});

test("speech-to-speech data categories reflect each provider's actual wire", () => {
  const openaiNative = rehashedOpenaiNativeProfile(["canonical_audio", "target_language"]);
  assert.doesNotThrow(() => validateApprovedSessionProcessingProfile(openaiNative));

  const openaiNativeWithSourceLanguage = rehashedOpenaiNativeProfile([
    "canonical_audio",
    "source_language",
    "target_language",
  ]);
  assert.throws(
    () => validateApprovedSessionProcessingProfile(openaiNativeWithSourceLanguage),
    /dataCategories.*approved provider route/u,
  );

  assert.doesNotThrow(() => validateApprovedSessionProcessingProfile(
    rehashedPalabraProfile("/streaming-api/{hash}/v1/speech-to-speech/stream"),
  ));
});

test("profile rejects hash-consistent glossary stages and pinned-glossary policies outside its route", () => {
  for (const [name, profile] of [
    ["stage role", INVALID_GLOSSARY_STAGE_ROLE_PROFILE],
    ["stage fields", INVALID_GLOSSARY_STAGE_FIELDS_PROFILE],
    ["pinned glossary policy", INVALID_PINNED_GLOSSARY_POLICY_PROFILE],
  ] as const) {
    const { sha256, ...body } = profile;
    assert.equal(canonicalJsonSha256(body), sha256, name + " fixture must remain hash-consistent");
    assert.throws(
      () => validateApprovedSessionProcessingProfile(profile),
      TypeError,
      name + " must be rejected",
    );
  }
});

test("profile rejects hash-consistent unknown keys at the root and service boundaries", () => {
  const { sha256: _sha256, ...body } = POC_PROFILE;
  const withUnknownRootBody = { ...body, unexpected: true };
  const withUnknownRoot = {
    ...withUnknownRootBody,
    sha256: canonicalJsonSha256(withUnknownRootBody),
  } as unknown as ApprovedSessionProcessingProfile;
  assert.equal(canonicalJsonSha256(withUnknownRootBody), withUnknownRoot.sha256);
  assert.throws(
    () => validateApprovedSessionProcessingProfile(withUnknownRoot),
    /profile contains unknown key: unexpected/u,
  );

  const firstService = POC_PROFILE.services[0];
  if (firstService === undefined) throw new Error("POC profile must include a service");
  const withUnknownServiceBody = {
    ...body,
    services: [{ ...firstService, unexpectedServiceField: "must-not-enter-manifest" }, ...body.services.slice(1)],
  };
  const withUnknownService = {
    ...withUnknownServiceBody,
    sha256: canonicalJsonSha256(withUnknownServiceBody),
  } as unknown as ApprovedSessionProcessingProfile;
  assert.equal(canonicalJsonSha256(withUnknownServiceBody), withUnknownService.sha256);
  assert.throws(
    () => validateApprovedSessionProcessingProfile(withUnknownService),
    /profile\.services\[0\] contains unknown key: unexpectedServiceField/u,
  );

  const unknownGlossary = {
    ...GLOSSARY_REFERENCE,
    unexpectedGlossaryField: "must-not-enter-manifest",
  };
  assert.throws(
    () => createSessionProcessingManifest({ profile: POC_PROFILE, mode: "fast", glossary: unknownGlossary }),
    /glossary contains unknown key: unexpectedGlossaryField/u,
  );
});

test("session manifest freezes a deep clone instead of freezing caller-owned nested objects", () => {
  const callerProfile = structuredClone(POC_PROFILE) as ApprovedSessionProcessingProfile;
  const callerGlossary: { id: string; version: string; hash: string } = { ...GLOSSARY_REFERENCE };
  const manifest = createSessionProcessingManifest({
    profile: callerProfile,
    mode: "fast",
    glossary: callerGlossary,
  });

  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.services), true);
  assert.equal(Object.isFrozen(manifest.services[0]), true);
  assert.equal(Object.isFrozen(manifest.glossary), true);
  assert.equal(Object.isFrozen(callerProfile), false);
  assert.equal(Object.isFrozen(callerProfile.services), false);
  assert.equal(Object.isFrozen(callerProfile.services[0]), false);
  assert.equal(Object.isFrozen(callerGlossary), false);

  const callerServices = callerProfile.services as unknown as Array<unknown>;
  callerServices.push(callerServices[0]);
  callerGlossary.id = "caller-mutated-after-manifest";
  assert.equal(manifest.services.length, 3);
  assert.equal(manifest.glossary?.id, GLOSSARY_REFERENCE.id);
});

test("manifest validation rejects hash-consistent unknown root and nested keys", () => {
  const manifest = createSessionProcessingManifest({ profile: POC_PROFILE, mode: "fast" });

  const unknownRootBody = { ...manifest, unexpected: true, manifestSha256: undefined };
  const unknownRoot = {
    ...unknownRootBody,
    manifestSha256: canonicalJsonSha256(unknownRootBody),
  } as unknown as SessionProcessingManifest;
  assert.throws(
    () => validateSessionProcessingManifest(unknownRoot),
    /processingManifest contains unknown key: unexpected/u,
  );

  const unknownProfileBody = {
    ...manifest,
    profile: { ...manifest.profile, unexpected: true },
    manifestSha256: undefined,
  };
  const unknownProfile = {
    ...unknownProfileBody,
    manifestSha256: canonicalJsonSha256(unknownProfileBody),
  } as unknown as SessionProcessingManifest;
  assert.throws(
    () => validateSessionProcessingManifest(unknownProfile),
    /processingManifest\.profile contains unknown key: unexpected/u,
  );
});

test("manifest pins profile, provider, mode, and service projection while consent is policy-bound", () => {
  const manifest = createSessionProcessingManifest({ profile: POC_PROFILE, mode: "fast" });
  assert.deepEqual(manifest.profile, {
    id: "processing-contract-poc",
    version: "2026-08-09",
    sha256: "57257df16f189af71f615480dd9ea14cf4dfee9a1bc6fc7097f86c1b7dd3fe34",
  });
  assert.deepEqual(manifest.selectedTranslation, {
    provider: "openai_controlled",
    mode: "fast",
    behaviorVersion: 1,
    servicesSha256: SERVICE_PROJECTION_SHA256,
  });
  assert.deepEqual(manifest.services, POC_PROFILE.services);
  assert.deepEqual(manifest.consentPolicyRef, POC_PROFILE.consentPolicy);
  assert.equal(manifest.manifestSha256, SESSION_MANIFEST_SHA256);
  assert.doesNotThrow(() => validateSessionProcessingManifest(manifest));

  const spec = {
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode: "fast",
    processingManifest: manifest,
    evidenceReviewGrant: EVIDENCE_REVIEW_GRANT,
  } as const satisfies SessionSpec;
  assert.doesNotThrow(() => validateSessionSpecProcessingManifest(spec));
  assert.doesNotThrow(() => validateSessionSpecAgainstProcessingProfile(spec, POC_PROFILE));
  assert.throws(
    () => validateSessionSpecProcessingManifest({ ...spec, provider: "palabra" }),
    /Provider does not match processing manifest/u,
  );
  assert.throws(
    () => validateSessionSpecProcessingManifest({ ...spec, mode: "balanced" }),
    /Mode does not match processing manifest/u,
  );

  const consent = {
    type: "participant_consent",
    commandId: "consent-A-001",
    side: "A",
    consentId: "consent-id-A",
    consentPolicyRef: manifest.consentPolicyRef,
    recording: true,
    processing: true,
  } as const satisfies ParticipantConsentCommand;
  assert.doesNotThrow(() => assertParticipantConsentForManifest(consent, manifest));
  assert.throws(
    () => assertParticipantConsentForManifest({
      ...consent,
      consentPolicyRef: { ...consent.consentPolicyRef, sha256: INVALID_PROFILE_SHA256 },
    }, manifest),
    /Consent policy does not match processing manifest/u,
  );

  const forgedManifest: SessionProcessingManifest = {
    ...manifest,
    selectedTranslation: {
      ...manifest.selectedTranslation,
      servicesSha256: FORGED_SERVICE_PROJECTION_SHA256,
    },
    services: [
      { ...POC_PROFILE.services[0], provider: "palabra" },
      POC_PROFILE.services[1],
      POC_PROFILE.services[2],
    ],
    manifestSha256: FORGED_MANIFEST_SHA256,
  };
  const { manifestSha256, ...forgedManifestBody } = forgedManifest;
  assert.equal(canonicalJsonSha256(forgedManifest.services), FORGED_SERVICE_PROJECTION_SHA256);
  assert.equal(canonicalJsonSha256(forgedManifestBody), manifestSha256);
  assert.throws(
    () => validateSessionProcessingManifest(forgedManifest),
    TypeError,
    "a hash-consistent manifest must still reject an invalid service projection",
  );
  assert.throws(
    () => validateSessionSpecAgainstProcessingProfile({
      ...spec,
      processingManifest: forgedManifest,
    }, POC_PROFILE),
    TypeError,
    "profile comparison must reject a forged hash-consistent immutable projection",
  );
});

test("session glossary must match its manifest reference by id, version, and compiled hash", () => {
  const compiledGlossary = compileGlossary(GLOSSARY_SPEC);
  assert.deepEqual({
    id: compiledGlossary.id,
    version: compiledGlossary.version,
    hash: compiledGlossary.hash,
  }, GLOSSARY_REFERENCE);

  const manifest = createSessionProcessingManifest({
    profile: POC_PROFILE,
    mode: "fast",
    glossary: GLOSSARY_REFERENCE,
  });
  const spec = {
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode: "fast",
    processingManifest: manifest,
    evidenceReviewGrant: EVIDENCE_REVIEW_GRANT,
    glossary: GLOSSARY_SPEC,
  } as const satisfies SessionSpec;
  assert.doesNotThrow(() => validateSessionSpecProcessingManifest(spec));
  for (const [name, glossary] of [
    ["id", { ...GLOSSARY_SPEC, id: "foreign-glossary" }],
    ["version", { ...GLOSSARY_SPEC, version: "2026-08-10" }],
    ["compiled hash", {
      ...GLOSSARY_SPEC,
      entries: [{ ...GLOSSARY_SPEC.entries[0], targetExact: "different-target" }],
    }],
  ] as const) {
    assert.throws(
      () => validateSessionSpecProcessingManifest({ ...spec, glossary }),
      TypeError,
      "glossary " + name + " mismatch must be rejected",
    );
  }
});

test("recorder preflight validates its request, ready result, and persisted session binding", () => {
  const request = {
    sessionId: "session-processing-contract-001",
    processingManifestSha256: SESSION_MANIFEST_SHA256,
    checkedAtMonoMs: 100,
  } as const satisfies RecorderPreflightRequest;
  assert.doesNotThrow(() => validateRecorderPreflightRequest(request));
  assert.throws(
    () => validateRecorderPreflightRequest({ ...request, processingManifestSha256: "not-a-sha" }),
    /processingManifestSha256 must be a lowercase SHA-256/u,
  );

  const readyResult = {
    ...request,
    status: "ready",
    preflightId: "preflight-001",
    requiredFreeBytes: "67108864",
    availableFreeBytes: "134217728",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    manifestSha256: "1111111111111111111111111111111111111111111111111111111111111111",
    encryptedSpoolSha256: "2222222222222222222222222222222222222222222222222222222222222222",
    sealedRecordCount: 3,
    sealSha256: "3333333333333333333333333333333333333333333333333333333333333333",
  } as const satisfies RecorderPreflightResult;
  assert.doesNotThrow(() => validateRecorderPreflightResult(readyResult));
  assert.throws(
    () => validateRecorderPreflightResult({ ...readyResult, availableFreeBytes: "67108863" }),
    TypeError,
    "ready preflight must reject less available than required storage",
  );
  assert.throws(
    () => validateRecorderPreflightResult({
      ...readyResult,
      status: "unknown",
    } as unknown as RecorderPreflightResult),
    TypeError,
    "preflight status must be a known discriminant",
  );

  const record = {
    type: "recorder_preflight",
    sessionId: request.sessionId,
    timestampMonoMs: 101,
    preflight: readyResult,
  } as const satisfies EvidenceRecorderPreflightRecord;
  assert.doesNotThrow(() => validateEvidenceRecorderPreflightRecord(record));
  assert.throws(
    () => validateEvidenceRecorderPreflightRecord({
      ...record,
      preflight: {
        ...readyResult,
        tracks: ["source_a", "source_b", "playout_to_a"],
      },
    }),
    /Recorder preflight must verify exactly the four required tracks/u,
  );
  assert.throws(
    () => validateEvidenceRecorderPreflightRecord({ ...record, sessionId: "other-session" }),
    /Preflight sessionId does not match record sessionId/u,
  );
});

test("recorder preflight failure results allowlist fixed failure-code vectors", () => {
  const failedResult = {
    status: "failed",
    sessionId: "session-processing-contract-001",
    processingManifestSha256: SESSION_MANIFEST_SHA256,
    checkedAtMonoMs: 100,
    failureCode: "evidence_preflight_failed",
  } as const satisfies RecorderPreflightResult;

  for (const failureCode of Object.keys(RECORDER_PREFLIGHT_FAILURE_VECTORS)) {
    assert.doesNotThrow(
      () => validateRecorderPreflightResult({
        ...failedResult,
        failureCode,
      } as unknown as RecorderPreflightResult),
      failureCode + " must be an accepted recorder preflight failure code",
    );
  }

  const { failureCode: _failureCode, ...failedWithoutCode } = failedResult;
  assert.throws(
    () => validateRecorderPreflightResult(failedWithoutCode as unknown as RecorderPreflightResult),
    /Recorder preflight failure is invalid/u,
    "a failed preflight must require its failure code",
  );

  for (const [name, failureCode] of [
    ["arbitrary string", "unrecognized_preflight_failure"],
    ["empty string", ""],
    ["combined codes", "evidence_preflight_failed,free_space_unavailable"],
    ["explicitly undefined", undefined],
    ["null value", null],
    ["numeric value", 1],
    ["non-string value", { code: "evidence_preflight_failed" }],
  ] as const) {
    assert.throws(
      () => validateRecorderPreflightResult({
        ...failedResult,
        failureCode,
      } as unknown as RecorderPreflightResult),
      /Recorder preflight failure is invalid/u,
      name + " must not reach recorder preflight persistence or projection",
    );
  }
});

test("evidence finalization validates the request boundary and sealed result", () => {
  const request = {
    sessionId: "session-processing-contract-001",
    processingManifestSha256: SESSION_MANIFEST_SHA256,
    finalizedAtMonoMs: 200,
    reason: "operator_end",
    lastPersistedEventCursor: 17,
  } as const satisfies EvidenceFinalizeRequest;
  assert.doesNotThrow(() => validateEvidenceFinalizeRequest(request));
  assert.throws(
    () => validateEvidenceFinalizeRequest({
      ...request,
      retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    } as unknown as EvidenceFinalizeRequest),
    /Retention deadline is created only during finalization/u,
  );

  const expectation = {
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    retentionPolicy: POC_PROFILE.retentionPolicy,
  } as const;

  const finalization = {
    status: "sealed",
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    manifestSha256: "4444444444444444444444444444444444444444444444444444444444444444",
    encryptedLedgerSha256: "5555555555555555555555555555555555555555555555555555555555555555",
    finalChainSha256: "6666666666666666666666666666666666666666666666666666666666666666",
    recordCount: 5,
    finalizedAtUtc: "2026-08-09T00:00:00.000Z",
    retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    tracks: {
      source_a: {
        sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        frameCount: 10,
        byteCount: 1024,
      },
      source_b: {
        sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        frameCount: 11,
        byteCount: 2048,
      },
      playout_to_a: {
        sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        frameCount: 12,
        byteCount: 4096,
      },
      playout_to_b: {
        sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        frameCount: 13,
        byteCount: 8192,
      },
    },
  } as const satisfies EvidenceFinalization;
  assert.doesNotThrow(() => validateEvidenceFinalization(finalization, expectation));
  assert.throws(
    () => validateEvidenceFinalization({
      ...finalization,
      tracks: {
        ...finalization.tracks,
        source_a: { ...finalization.tracks.source_a, sha256: "not-a-sha" },
      },
    }, expectation),
    /tracks.source_a.sha256 must be a lowercase SHA-256/u,
  );
  assert.throws(
    () => validateEvidenceFinalization({
      ...finalization,
      retentionDeadlineAt: "2026-08-22T00:00:00.000Z",
    }, expectation),
    TypeError,
    "sealed receipt must use the profile retention duration",
  );
  assert.throws(
    () => validateEvidenceFinalization({
      ...finalization,
      sessionId: "foreign-session",
      processingManifestSha256: INVALID_PROFILE_SHA256,
    }, expectation),
    TypeError,
    "sealed receipt must bind to the expected session and processing manifest",
  );

  const failedFinalization = {
    status: "FINALIZATION_FAILED",
    sessionId: request.sessionId,
    processingManifestSha256: request.processingManifestSha256,
    failureCode: "integrity_verification_failed",
    recovery: "rebuild_from_spool",
  } as const satisfies EvidenceFinalization;
  assert.doesNotThrow(() => validateEvidenceFinalization(failedFinalization, expectation));
  assert.throws(
    () => validateEvidenceFinalization({
      ...failedFinalization,
      sessionId: "foreign-session",
    }, expectation),
    TypeError,
    "failed receipt must still bind to the expected session and processing manifest",
  );
});

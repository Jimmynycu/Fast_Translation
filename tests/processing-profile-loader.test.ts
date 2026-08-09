import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import {
  loadApprovedSessionProcessingProfile,
  MAX_PROCESSING_PROFILE_BYTES,
} from "../src/adapters/config/processing-profile.js";
import {
  canonicalJsonSha256,
  createSessionProcessingManifest,
  type ApprovedSessionProcessingProfile,
  validateSessionProcessingManifest,
} from "../src/core/processing-profile.js";

const policyReference = {
  id: "policy-001",
  revision: "2026-08-09",
  sha256: "a".repeat(64),
  approvedBy: "compliance@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
} as const;

const unverified = {
  status: "unverified",
  reason: "POC external assurance has not been independently verified.",
  acceptanceImpact: "NOT_RUN",
} as const;

function approvedProfile(): ApprovedSessionProcessingProfile {
  const body = {
    schemaVersion: 1,
    kind: "approved_session_processing_profile",
    id: "manufacturing-poc",
    version: "2026-08-09",
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
        region: unverified,
        trainingUse: unverified,
        serviceRetention: unverified,
        dpa: unverified,
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
        region: unverified,
        trainingUse: unverified,
        serviceRetention: unverified,
        dpa: unverified,
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
        region: unverified,
        trainingUse: unverified,
        serviceRetention: unverified,
        dpa: unverified,
      },
    ],
    glossaryEgress: {
      harnessPinnedGlossary: "local_pinned",
      stages: [
        { role: "transcription", fields: ["source_terms", "aliases"] },
        { role: "text_translation", fields: ["opaque_placeholders"] },
        { role: "tts", fields: ["authorized_target_text"] },
      ],
      providerAccountGlossary: unverified,
    },
    fallback: { kind: "same_route_fail_open", approval: policyReference },
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
      policyRef: policyReference,
      mode: "scheduled_delete",
      defaultDays: 14,
      maximumDays: 30,
      verificationMaximumHours: 24,
    },
    consentPolicy: {
      ...policyReference,
      id: "consent-policy-001",
      noticeVersion: "manufacturing-notice-v1",
      recordingRequired: true,
      processingRequired: true,
      withdrawalTerminatesSession: true,
    },
    approval: {
      approvalId: "approval-001",
      approvedBy: "compliance@example.test",
      approvedAtUtc: "2026-08-09T00:00:00.000Z",
    },
  } as const satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;
  return { ...body, sha256: canonicalJsonSha256(body) };
}

function temporaryProfilePath(): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "processing-profile-loader-tests",
    randomUUID(),
    "profile.json",
  );
}

async function writeProfile(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

test("loads a schema-valid profile through its canonical deployment hash pin", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  try {
    const renderedWithDifferentRootKeyOrder = {
      approval: profile.approval,
      consentPolicy: profile.consentPolicy,
      retentionPolicy: profile.retentionPolicy,
      evidence: profile.evidence,
      fallback: profile.fallback,
      glossaryEgress: profile.glossaryEgress,
      services: profile.services,
      translation: profile.translation,
      operationScope: profile.operationScope,
      sha256: profile.sha256,
      version: profile.version,
      id: profile.id,
      kind: profile.kind,
      schemaVersion: profile.schemaVersion,
    };
    await writeProfile(path, renderedWithDifferentRootKeyOrder);

    const loaded = await loadApprovedSessionProcessingProfile({
      path,
      expectedSha256: profile.sha256,
    });

    assert.deepEqual(loaded, profile);
    assert.equal(Object.isFrozen(loaded), true);
    assert.equal(Object.isFrozen(loaded.services[0]?.dataCategories), true);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("bounds deployment profile reads at exactly one MiB and rejects larger inputs", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const serialized = JSON.stringify(profile);
  const exactContents = serialized + " ".repeat(MAX_PROCESSING_PROFILE_BYTES - Buffer.byteLength(serialized));
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, exactContents, "utf8");
    const loaded = await loadApprovedSessionProcessingProfile({
      path,
      expectedSha256: profile.sha256,
    });
    assert.equal(loaded.sha256, profile.sha256);

    await writeFile(path, exactContents + " ", "utf8");
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: profile.sha256 }),
      /input_read_failed/i,
    );

  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("rejects symlinked deployment profile inputs before reading", async (testContext) => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  try {
    const target = resolve(dirname(path), "target.json");
    await mkdir(dirname(path), { recursive: true });
    await writeProfile(target, profile);
    const linked = resolve(dirname(path), "linked.json");
    try {
      await symlink(target, linked);
    } catch {
      testContext.skip("symlink creation is unavailable on this host");
      return;
    }
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path: linked, expectedSha256: profile.sha256 }),
      /input_read_failed/i,
    );
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("redacts profile input paths and JSON parser details", async () => {
  const directory = resolve(process.cwd(), "work", "tmp", "SENTINEL_PROFILE_PATH", randomUUID());
  const path = resolve(directory, "sentinel-profile.json");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, "{ invalid json", "utf8");

    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: "0".repeat(64) }),
      (error: unknown) => {
        assert(error instanceof TypeError);
        assert.equal(error.message, "invalid JSON");
        assert.doesNotMatch(error.message, /SENTINEL_PROFILE_PATH|Unexpected token|JSON at position/iu);
        return true;
      },
    );

    await writeProfile(path, approvedProfile());
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: "0".repeat(64) }),
      (error: unknown) => {
        assert(error instanceof TypeError);
        assert.equal(error.message, "PROCESSING_PROFILE_SHA256 does not match canonical profile hash");
        assert.doesNotMatch(error.message, /SENTINEL_PROFILE_PATH|sentinel-profile\.json/iu);
        return true;
      },
    );

    const missingPath = resolve(directory, "missing-profile.json");
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path: missingPath, expectedSha256: "0".repeat(64) }),
      (error: unknown) => {
        assert(error instanceof TypeError);
        assert.equal(error.message, "input_read_failed");
        assert.doesNotMatch(error.message, /SENTINEL_PROFILE_PATH|missing-profile\.json/iu);
        return true;
      },
    );
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("rejects an unreadable deployment hash pin and an invalid profile artifact", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  try {
    await writeProfile(path, profile);

    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: "0".repeat(64) }),
      /PROCESSING_PROFILE_SHA256 does not match/i,
    );
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: "A".repeat(64) }),
      /expectedSha256/i,
    );

    await writeProfile(path, { ...profile, version: "tampered" });
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: profile.sha256 }),
      /Processing profile SHA-256 mismatch/i,
    );

    const { sha256: _sha256, ...invalidBody } = profile;
    const invalid = {
      ...invalidBody,
      translation: { ...profile.translation, defaultMode: "accurate" as const },
    } as const satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;
    const invalidProfile: ApprovedSessionProcessingProfile = {
      ...invalid,
      sha256: canonicalJsonSha256(invalid),
    };
    await writeProfile(path, invalidProfile);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({
        path,
        expectedSha256: invalidProfile.sha256,
      }),
      /include the default mode/i,
    );
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("rejects missing, unknown, duplicate, and route-forged service data categories", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const asProfile = (body: object): ApprovedSessionProcessingProfile => ({
    ...body,
    sha256: canonicalJsonSha256(body),
  }) as ApprovedSessionProcessingProfile;
  const withRouteDataCategories = (value: ApprovedSessionProcessingProfile): ApprovedSessionProcessingProfile =>
    asProfile({
      ...value,
      sha256: undefined,
      services: value.services.map((service) => ({
        ...service,
        dataCategories: service.role === "transcription"
          ? ["canonical_audio", "source_language", "source_terms", "aliases"]
          : service.role === "text_translation"
            ? ["source_transcript", "source_language", "target_language", "opaque_placeholders"]
            : ["authorized_target_text"],
      })),
    });
  try {
    const firstService = profile.services[0];
    if (firstService === undefined) throw new Error("Approved profile must include transcription service");
    const { dataCategories: _dataCategories, ...serviceWithoutDataCategories } = firstService;
    const missing = asProfile({
      ...profile,
      sha256: undefined,
      services: [serviceWithoutDataCategories, ...profile.services.slice(1)],
    });
    await writeProfile(path, missing);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: missing.sha256 }),
      /dataCategories is required/i,
    );

    const unknown = asProfile({
      ...profile,
      sha256: undefined,
      services: profile.services.map((service, index) => index === 0
        ? { ...service, dataCategories: ["not_a_data_category"] }
        : service),
    });
    await writeProfile(path, unknown);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: unknown.sha256 }),
      /dataCategories.*unsupported/i,
    );

    const duplicate = asProfile({
      ...profile,
      sha256: undefined,
      services: profile.services.map((service, index) => index === 0
        ? { ...service, dataCategories: ["canonical_audio", "canonical_audio"] }
        : service),
    });
    await writeProfile(path, duplicate);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: duplicate.sha256 }),
      /dataCategories.*unique/i,
    );

    const routeForged = asProfile({
      ...profile,
      sha256: undefined,
      services: profile.services.map((service, index) => index === 0
        ? { ...service, dataCategories: ["source_transcript"] }
        : service),
    });
    await writeProfile(path, routeForged);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: routeForged.sha256 }),
      /dataCategories.*approved provider route/i,
    );

    const valid = withRouteDataCategories(profile);
    const manifest = createSessionProcessingManifest({
      profile: valid,
      mode: valid.translation.defaultMode,
    });
    const forgedServices = valid.services.map((service, index) => index === 0
      ? { ...service, dataCategories: ["canonical_audio"] as const }
      : service);
    assert.notEqual(
      canonicalJsonSha256(forgedServices),
      manifest.selectedTranslation.servicesSha256,
      "service data categories must contribute to the manifest service projection hash",
    );
    const forgedManifestBody = {
      ...manifest,
      manifestSha256: undefined,
      services: forgedServices,
      selectedTranslation: {
        ...manifest.selectedTranslation,
        servicesSha256: canonicalJsonSha256(forgedServices),
      },
    };
    const forgedManifest = {
      ...forgedManifestBody,
      manifestSha256: canonicalJsonSha256(forgedManifestBody),
    };
    assert.throws(
      () => validateSessionProcessingManifest(forgedManifest),
      /dataCategories.*approved provider route/i,
    );
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("rejects path templates that can escape or non-canonically resolve outside the approved HTTPS origin", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const { sha256: _sha256, ...base } = profile;
  const maliciousTemplates = [
    "//provider.invalid/collect",
    "/\\provider.invalid\\collect",
    "/%5c%5cprovider.invalid/collect",
    "https://provider.invalid/collect",
    "/https://provider.invalid/collect",
    "/v1/realtime?redirect=provider.invalid",
    "/v1/realtime#provider.invalid",
    "/v1/../realtime",
  ];
  try {
    for (const pathTemplate of maliciousTemplates) {
      const body = {
        ...base,
        services: profile.services.map((service, index) => index === 0
          ? { ...service, endpoint: { ...service.endpoint, pathTemplate } }
          : service),
      };
      const malicious = {
        ...body,
        sha256: canonicalJsonSha256(body),
      } as ApprovedSessionProcessingProfile;
      await writeProfile(path, malicious);
      await assert.rejects(
        () => loadApprovedSessionProcessingProfile({ path, expectedSha256: malicious.sha256 }),
        /pathTemplate/i,
        pathTemplate,
      );
    }
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("permits only the sanctioned Palabra whole-segment hash placeholder", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const firstService = profile.services[0];
  if (firstService === undefined) throw new Error("Approved profile must include a service");
  const { sha256: _sha256, ...base } = profile;
  const baseService = {
    ...firstService,
    id: "palabra-speech",
    role: "speech_to_speech",
    provider: "palabra",
    category: "managed_realtime_speech_translation",
    dataCategories: ["canonical_audio", "source_language", "target_language"],
    endpoint: {
      origin: "https://streaming.palabra.example",
      pathTemplate: "/streaming-api/{hash}/v1/speech-to-speech/stream",
    },
    model: { kind: "vendor_managed", reason: "The provider selects its managed model." },
    voice: { kind: "provider_managed", reason: "The provider selects its managed voice." },
  };
  const body = {
    ...base,
    translation: {
      provider: "palabra",
      allowedModes: ["fast", "balanced"],
      defaultMode: "fast",
      behaviorVersion: 1,
    },
    services: [baseService],
    glossaryEgress: {
      harnessPinnedGlossary: "disallowed",
      stages: [],
      providerAccountGlossary: profile.glossaryEgress.providerAccountGlossary,
    },
  };
  const palabraProfile = {
    ...body,
    sha256: canonicalJsonSha256(body),
  } as ApprovedSessionProcessingProfile;
  try {
    await writeProfile(path, palabraProfile);
    await assert.doesNotReject(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: palabraProfile.sha256 }),
    );

    const invalidTemplates = [
      "/streaming-api/v1/speech-to-speech/stream",
      "/streaming-api/{hash}/{hash}/v1/speech-to-speech/stream",
      "/streaming-api/%7Bhash%7D/v1/speech-to-speech/stream",
      "/streaming-api/{hash}/%7Bhash%7D/v1/speech-to-speech/stream",
      "/streaming-api/prefix{hash}/v1/speech-to-speech/stream",
    ];
    for (const pathTemplate of invalidTemplates) {
      const malformedBody = {
        ...body,
        services: [{
          ...baseService,
          endpoint: { ...baseService.endpoint, pathTemplate },
        }],
      };
      const malformed = {
        ...malformedBody,
        sha256: canonicalJsonSha256(malformedBody),
      } as ApprovedSessionProcessingProfile;
      await writeProfile(path, malformed);
      await assert.rejects(
        () => loadApprovedSessionProcessingProfile({ path, expectedSha256: malformed.sha256 }),
        /Palabra service endpoint pathTemplate must contain exactly one literal \{hash\} whole path segment/i,
        pathTemplate,
      );
    }
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("uses only the canonical owner acknowledgement for plaintext exports in profile and manifest contracts", async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const { sha256: _sha256, ...base } = profile;
  const ownerBody = {
    ...base,
    evidence: {
      ...profile.evidence,
      plaintextExport: "explicit_owner_acknowledgement",
    },
  };
  const ownerProfile = {
    ...ownerBody,
    sha256: canonicalJsonSha256(ownerBody),
  } as ApprovedSessionProcessingProfile;
  try {
    await writeProfile(path, ownerProfile);
    const loaded = await loadApprovedSessionProcessingProfile({
      path,
      expectedSha256: ownerProfile.sha256,
    });
    assert.equal(loaded.evidence.plaintextExport, "explicit_owner_acknowledgement");

    const legacyBody = {
      ...base,
      evidence: {
        ...profile.evidence,
        plaintextExport: "explicit_reviewer_acknowledgement",
      },
    };
    const legacyProfile = {
      ...legacyBody,
      sha256: canonicalJsonSha256(legacyBody),
    } as ApprovedSessionProcessingProfile;
    await writeProfile(path, legacyProfile);
    await assert.rejects(
      () => loadApprovedSessionProcessingProfile({ path, expectedSha256: legacyProfile.sha256 }),
      /evidence controls are invalid/i,
    );

    const manifest = createSessionProcessingManifest({
      profile: ownerProfile,
      mode: ownerProfile.translation.defaultMode,
    });
    const legacyManifestBody = {
      ...manifest,
      manifestSha256: undefined,
      evidence: legacyProfile.evidence,
    };
    const legacyManifest = {
      ...legacyManifestBody,
      manifestSha256: canonicalJsonSha256(legacyManifestBody),
    };
    assert.throws(
      () => validateSessionProcessingManifest(legacyManifest),
      /evidence controls are invalid/i,
    );
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import {
  canonicalJsonSha256,
  type ApprovedSessionProcessingProfile,
} from "../src/core/processing-profile.js";
import { MAX_PROCESSING_PROFILE_BYTES } from "../src/adapters/config/processing-profile.js";

const UNVERIFIED = {
  status: "unverified",
  reason: "External POC assurances have not yet been independently verified.",
  acceptanceImpact: "NOT_RUN",
} as const;

const POLICY_REFERENCE = {
  id: "policy-001",
  revision: "2026-08-09",
  sha256: "a".repeat(64),
  approvedBy: "compliance@example.test",
  approvedAtUtc: "2026-08-09T00:00:00.000Z",
} as const;

function approvedProfile(): ApprovedSessionProcessingProfile {
  const body = {
    schemaVersion: 1 as const,
    kind: "approved_session_processing_profile" as const,
    id: "validation-cli-poc",
    version: "2026-08-09",
    operationScope: "poc" as const,
    translation: {
      provider: "palabra" as const,
      allowedModes: ["fast", "balanced"] as const,
      defaultMode: "fast" as const,
      behaviorVersion: 1 as const,
    },
    services: [{
      id: "palabra-speech",
      role: "speech_to_speech" as const,
      provider: "palabra" as const,
      category: "managed_realtime_speech_translation" as const,
      dataCategories: ["canonical_audio", "source_language", "target_language"] as const,
      endpoint: {
        origin: "https://streaming.palabra.example",
        pathTemplate: "/streaming-api/{hash}/v1/speech-to-speech/stream",
      },
      model: { kind: "vendor_managed" as const, reason: "Provider selects the approved model." },
      voice: { kind: "provider_managed" as const, reason: "Provider selects the approved voice." },
      region: UNVERIFIED,
      trainingUse: UNVERIFIED,
      serviceRetention: UNVERIFIED,
      dpa: UNVERIFIED,
    }],
    glossaryEgress: {
      harnessPinnedGlossary: "disallowed" as const,
      stages: [],
      providerAccountGlossary: UNVERIFIED,
    },
    fallback: { kind: "none" as const, approval: POLICY_REFERENCE },
    evidence: {
      storage: "local_encrypted_file" as const,
      encryption: "aes_256_gcm" as const,
      tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const,
      providerEvents: "final_only" as const,
      provisionalEvents: "live_only" as const,
      browserEvidenceRefs: "redacted" as const,
      plaintextExport: "explicit_owner_acknowledgement" as const,
      minimumFreeBytes: "1",
    },
    retentionPolicy: {
      policyRef: POLICY_REFERENCE,
      mode: "scheduled_delete" as const,
      defaultDays: 14 as const,
      maximumDays: 30 as const,
      verificationMaximumHours: 24 as const,
    },
    consentPolicy: {
      ...POLICY_REFERENCE,
      id: "consent-policy-001",
      noticeVersion: "validation-cli-notice-v1",
      recordingRequired: true as const,
      processingRequired: true as const,
      withdrawalTerminatesSession: true as const,
    },
    approval: {
      approvalId: "approval-001",
      approvedBy: "compliance@example.test",
      approvedAtUtc: "2026-08-09T00:00:00.000Z",
    },
  } satisfies Omit<ApprovedSessionProcessingProfile, "sha256">;
  return { ...body, sha256: canonicalJsonSha256(body) };
}

function temporaryProfilePath(): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "processing-profile-cli-tests",
    randomUUID(),
    "profile.json",
  );
}

const CLI_ENTRY = resolve(
  process.cwd(),
  "dist-test",
  "src",
  "adapters",
  "config",
  "processing-profile-cli.js",
);

function runValidation(input: string) {
  const localTemp = resolve(process.cwd(), "work", "tmp");
  return spawnSync(
    process.execPath,
    [CLI_ENTRY, "--input", input],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: localTemp,
        TMP: localTemp,
        TMPDIR: localTemp,
        OPENAI_API_KEY: "must-not-be-read-or-printed",
        PROCESSING_PROFILE_PATH: resolve(localTemp, "not-an-input.json"),
      },
    },
  );
}

function assertExactJson(output: string, expected: unknown): void {
  assert.equal(output, JSON.stringify(expected) + "\n");
}

test("processing-profile validation CLI reports the canonical body hash and unverified paths", {
  timeout: 60_000,
}, async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(profile, null, 2) + "\n", "utf8");

    const result = runValidation(path);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /must-not-be-read-or-printed/u);
    assertExactJson(result.stdout, {
      kind: "approved_session_processing_profile_validation",
      status: "valid",
      canonicalBodySha256: profile.sha256,
      acceptanceImpact: "NOT_RUN",
      unverifiedAssurancePaths: [
        "services.palabra-speech.region",
        "services.palabra-speech.trainingUse",
        "services.palabra-speech.serviceRetention",
        "services.palabra-speech.dpa",
        "glossaryEgress.providerAccountGlossary",
      ],
    });
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("processing-profile validation CLI enforces the exact bounded regular-file input", {
  timeout: 60_000,
}, async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const serialized = JSON.stringify(profile);
  const exactContents = serialized + " ".repeat(MAX_PROCESSING_PROFILE_BYTES - Buffer.byteLength(serialized));
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, exactContents, "utf8");
    const exactResult = runValidation(path);
    assert.equal(exactResult.status, 0, exactResult.stderr || exactResult.stdout);
    assert.equal(exactResult.stderr, "");
    assertExactJson(exactResult.stdout, {
      kind: "approved_session_processing_profile_validation",
      status: "valid",
      canonicalBodySha256: profile.sha256,
      acceptanceImpact: "NOT_RUN",
      unverifiedAssurancePaths: [
        "services.palabra-speech.region",
        "services.palabra-speech.trainingUse",
        "services.palabra-speech.serviceRetention",
        "services.palabra-speech.dpa",
        "glossaryEgress.providerAccountGlossary",
      ],
    });

    await writeFile(path, exactContents + " ", "utf8");
    const oversizedResult = runValidation(path);
    assert.equal(oversizedResult.status, 1, oversizedResult.stderr || oversizedResult.stdout);
    assert.equal(oversizedResult.stdout, "");
    assertExactJson(oversizedResult.stderr, {
      kind: "approved_session_processing_profile_validation",
      status: "invalid",
      code: "input_read_failed",
    });
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("processing-profile validation CLI redacts input paths and JSON parser details", {
  timeout: 60_000,
}, async () => {
  const directory = resolve(process.cwd(), "work", "tmp", "SENTINEL_PROFILE_PATH", randomUUID());
  const path = resolve(directory, "sentinel-profile.json");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, "{ invalid json", "utf8");

    const result = runValidation(path);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assertExactJson(result.stderr, {
      kind: "approved_session_processing_profile_validation",
      status: "invalid",
      code: "invalid_json",
    });
    assert.doesNotMatch(result.stderr, /SENTINEL_PROFILE_PATH|Unexpected token|JSON at position/iu);
  } finally {
    await rm(directory, {
      recursive: true,
      force: true,
    });
  }
});

test("processing-profile validation CLI reports a mismatched embedded hash without changing the input", {
  timeout: 60_000,
}, async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const tampered = { ...profile, sha256: "0".repeat(64) };
  const contents = JSON.stringify(tampered, null, 2) + "\n";
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");

    const result = runValidation(path);

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(result.stdout, "");
    assertExactJson(result.stderr, {
      kind: "approved_session_processing_profile_validation",
      status: "invalid",
      code: "embedded_hash_mismatch",
      expectedCanonicalBodySha256: profile.sha256,
    });
    const unchanged = await readFile(path, "utf8");
    assert.equal(unchanged, contents);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

test("processing-profile validation CLI rejects a Palabra route without its literal hash segment", {
  timeout: 60_000,
}, async () => {
  const path = temporaryProfilePath();
  const profile = approvedProfile();
  const firstService = profile.services[0];
  if (firstService === undefined) throw new Error("Approved profile must include a Palabra service");
  const { sha256: _sha256, ...base } = profile;
  try {
    await mkdir(dirname(path), { recursive: true });
    for (const pathTemplate of [
      "/streaming-api/v1/speech-to-speech/stream",
      "/streaming-api/{hash}/{hash}/v1/speech-to-speech/stream",
      "/streaming-api/%7Bhash%7D/v1/speech-to-speech/stream",
      "/streaming-api/{hash}/%7Bhash%7D/v1/speech-to-speech/stream",
      "/streaming-api/prefix{hash}/v1/speech-to-speech/stream",
    ]) {
      const body = {
        ...base,
        services: [{
          ...firstService,
          endpoint: { ...firstService.endpoint, pathTemplate },
        }],
      };
      const malformed = { ...body, sha256: canonicalJsonSha256(body) };
      await writeFile(path, JSON.stringify(malformed, null, 2) + "\n", "utf8");

      const result = runValidation(path);

      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(result.stdout, "");
      assertExactJson(result.stderr, {
        kind: "approved_session_processing_profile_validation",
        status: "invalid",
        code: "invalid_profile",
      });
    }
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

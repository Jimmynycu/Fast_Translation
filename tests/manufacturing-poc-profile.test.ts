import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { loadApprovedSessionProcessingProfile } from "../src/adapters/config/processing-profile.js";
import {
  canonicalJsonSha256,
  validateApprovedSessionProcessingProfile,
  type ApprovedSessionProcessingProfile,
} from "../src/core/processing-profile.js";

const PROFILE_PATH = resolve(process.cwd(), "profiles", "manufacturing-poc.json");
const EXPECTED_PROFILE_SHA256 = "48ccc7bd514c92c11d6d6e448fb714daf720b87891536d96efacc239e8948294";

test("the checked-in manufacturing POC profile is hash-pinned and keeps external acceptance NOT_RUN", async () => {
  const profile = JSON.parse(
    await readFile(PROFILE_PATH, "utf8"),
  ) as ApprovedSessionProcessingProfile;
  const { sha256, ...body } = profile;

  assert.equal(sha256, EXPECTED_PROFILE_SHA256);
  assert.equal(canonicalJsonSha256(body), sha256);
  assert.deepEqual(validateApprovedSessionProcessingProfile(profile), {
    acceptanceImpact: "NOT_RUN",
    unverifiedAssurances: [
      "services.openai-realtime-transcription.region",
      "services.openai-realtime-transcription.trainingUse",
      "services.openai-realtime-transcription.serviceRetention",
      "services.openai-realtime-transcription.dpa",
      "services.openai-text-translation.region",
      "services.openai-text-translation.trainingUse",
      "services.openai-text-translation.serviceRetention",
      "services.openai-text-translation.dpa",
      "services.openai-tts.region",
      "services.openai-tts.trainingUse",
      "services.openai-tts.serviceRetention",
      "services.openai-tts.dpa",
      "glossaryEgress.providerAccountGlossary",
    ],
  });

  const loaded = await loadApprovedSessionProcessingProfile({
    path: PROFILE_PATH,
    expectedSha256: EXPECTED_PROFILE_SHA256,
  });
  assert.equal(loaded.sha256, EXPECTED_PROFILE_SHA256);
  assert.equal(loaded.operationScope, "poc");
  assert.equal(loaded.translation.provider, "openai_controlled");
  assert.deepEqual(
    loaded.services.map((service) => ({
      role: service.role,
      origin: service.endpoint.origin,
      pathTemplate: service.endpoint.pathTemplate,
      dataCategories: service.dataCategories,
      model: service.model,
      voice: service.voice,
    })),
    [
      {
        role: "transcription",
        origin: "https://api.openai.com",
        pathTemplate: "/v1/realtime",
        dataCategories: ["canonical_audio", "source_language", "source_terms", "aliases"],
        model: { kind: "named", value: "gpt-live-transcribe" },
        voice: { kind: "not_applicable" },
      },
      {
        role: "text_translation",
        origin: "https://api.openai.com",
        pathTemplate: "/v1/responses",
        dataCategories: ["source_transcript", "source_language", "target_language", "opaque_placeholders"],
        model: { kind: "named", value: "gpt-4.1-mini" },
        voice: { kind: "not_applicable" },
      },
      {
        role: "tts",
        origin: "https://api.openai.com",
        pathTemplate: "/v1/audio/speech",
        dataCategories: ["authorized_target_text"],
        model: { kind: "named", value: "gpt-4o-mini-tts" },
        voice: { kind: "named", value: "alloy" },
      },
    ],
  );
});

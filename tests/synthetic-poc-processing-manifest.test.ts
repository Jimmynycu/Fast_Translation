import assert from "node:assert/strict";
import { test } from "node:test";
import { validateApprovedSessionProcessingProfile } from "../src/core/processing-profile.js";
import {
  createSyntheticPocProcessingManifest,
  createSyntheticPocProcessingProfile,
} from "../src/local-eval/synthetic-poc-processing-manifest.js";
import { createTestOnlyVerifiedHumanSessionProcessingProfile } from "./support/acceptance.js";

test("synthetic POC manifests explicitly retain unverified external assurances", () => {
  const profile = createSyntheticPocProcessingProfile();
  const profileValidation = validateApprovedSessionProcessingProfile(profile);
  const manifest = createSyntheticPocProcessingManifest({ mode: "accurate" });

  assert.equal(profile.operationScope, "poc");
  assert.equal(profileValidation.acceptanceImpact, "NOT_RUN");
  assert.ok(profileValidation.unverifiedAssurances.length > 0);
  assert.ok(profile.services.every((service) =>
    [service.region, service.trainingUse, service.serviceRetention, service.dpa]
      .every((assurance) => assurance.status === "unverified")
  ));
  assert.equal(profile.glossaryEgress.providerAccountGlossary.status, "unverified");
  assert.deepEqual(profile.services.map((service) => service.dataCategories), [
    ["canonical_audio", "source_language", "source_terms", "aliases"],
    ["source_transcript", "source_language", "target_language", "opaque_placeholders"],
    ["authorized_target_text"],
  ]);
  assert.equal(profile.evidence.plaintextExport, "explicit_owner_acknowledgement");
  assert.equal(manifest.operationScope, "poc");
  assert.equal(manifest.acceptanceImpact, "NOT_RUN");
  assert.equal(manifest.selectedTranslation.mode, "accurate");
  assert.equal(Object.isFrozen(manifest), true);
});

test("test-only verified human-session fixture is isolated from synthetic POC assurances", () => {
  const profile = createTestOnlyVerifiedHumanSessionProcessingProfile();
  const validation = validateApprovedSessionProcessingProfile(profile);

  assert.equal(profile.id, "test-only-verified-human-session");
  assert.ok(profile.services.every((service) =>
    service.trainingUse.status === "verified" &&
    service.trainingUse.evidenceRef.id.startsWith("urn:test-only:") &&
    service.serviceRetention.status === "verified" &&
    service.serviceRetention.evidenceRef.id.startsWith("urn:test-only:")
  ));
  assert.equal(validation.acceptanceImpact, "NOT_RUN");
  assert.ok(validation.unverifiedAssurances.length > 0);
});

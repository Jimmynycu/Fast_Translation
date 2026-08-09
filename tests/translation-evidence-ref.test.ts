import assert from "node:assert/strict";
import { test } from "node:test";
import { createOpaqueEvidenceRef } from "../src/adapters/translation/evidence-ref.js";

test("creates a canonical SHA-256 opaque evidence reference", () => {
  assert.equal(
    createOpaqueEvidenceRef("palabra:provider", [
      "provider",
      "opaque-provider-id:7",
    ]),
    "palabra:provider:v1:sha256:06a532a66072d1d73d5f531b8cab8bb00a0a32194c532fc4f47c446d52565b75",
  );
});

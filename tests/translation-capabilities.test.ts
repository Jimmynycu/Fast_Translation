import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveTranslationBehavior,
  type TranslationBehavior,
} from "../src/core/translation-behavior.js";
import {
  assertTranslationBehaviorCapability,
  isSelectableTranslationMode,
  modeCapability,
  validateTranslationCapabilities,
} from "../src/core/translation-capabilities.js";
import type { TranslationCapabilities } from "../src/core/types.js";

test("requires every provider capability table to declare fast, balanced, and accurate", () => {
  assert.throws(
    () => validateTranslationCapabilities({
      providerId: "openai_native",
      modes: [{
        mode: "fast",
        behaviorVersion: 1,
        state: "native",
        deterministicGlossary: false,
      }],
      supportsProvisionalRevisions: true,
      supportsFinality: true,
      supportsCancellation: true,
      supportsDeterministicGlossary: false,
    }),
    /fast, balanced, and accurate exactly once/u,
  );
});

test("allows only native and locally controlled modes while retaining an experimental reason", () => {
  const capabilities = {
    providerId: "openai_native",
    modes: [{
      mode: "fast",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "balanced",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
      reason: "Adapter-local holdback preserves the balanced contract.",
    }, {
      mode: "accurate",
      behaviorVersion: 1,
      state: "experimental",
      deterministicGlossary: false,
      reason: "Accurate benchmark parity is not established.",
    }],
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  } satisfies TranslationCapabilities;

  const fast = modeCapability(capabilities, "fast");
  const balanced = modeCapability(capabilities, "balanced");
  const accurate = modeCapability(capabilities, "accurate");
  assert.ok(fast);
  assert.ok(balanced);
  assert.ok(accurate);
  assert.equal(isSelectableTranslationMode(fast), true);
  assert.equal(isSelectableTranslationMode(balanced), true);
  assert.equal(isSelectableTranslationMode(accurate), false);
  assert.throws(
    () => assertTranslationBehaviorCapability(
      capabilities,
      resolveTranslationBehavior("accurate"),
      { glossaryRequested: false },
    ),
    /experimental: Accurate benchmark parity is not established/u,
  );
});

test("requires a reason for every nonselectable mode", () => {
  assert.throws(
    () => validateTranslationCapabilities({
      providerId: "openai_native",
      modes: [{
        mode: "fast",
        behaviorVersion: 1,
        state: "native",
        deterministicGlossary: false,
      }, {
        mode: "balanced",
        behaviorVersion: 1,
        state: "locally_controlled",
        deterministicGlossary: false,
      }, {
        mode: "accurate",
        behaviorVersion: 1,
        state: "unsupported",
        deterministicGlossary: false,
      }],
      supportsProvisionalRevisions: true,
      supportsFinality: true,
      supportsCancellation: true,
      supportsDeterministicGlossary: false,
    }),
    /openai_native accurate unsupported requires a reason/u,
  );
});

test("retains an experimental row in the capability table", () => {
  const capabilities = {
    providerId: "openai_native",
    modes: [{
      mode: "fast",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "balanced",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
    }, {
      mode: "accurate",
      behaviorVersion: 1,
      state: "experimental",
      deterministicGlossary: false,
      reason: "Accurate benchmark parity is not established.",
    }],
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  } satisfies TranslationCapabilities;

  assert.equal(modeCapability(capabilities, "accurate")?.state, "experimental");
});

test("checks deterministic glossary support only when a glossary is requested", () => {
  const capabilities = {
    providerId: "palabra",
    modes: [{
      mode: "fast",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "balanced",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "accurate",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
      reason: "Account glossaries cannot provide deterministic pinned enforcement.",
    }],
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  } satisfies TranslationCapabilities;

  assert.equal(
    assertTranslationBehaviorCapability(
      capabilities,
      resolveTranslationBehavior("accurate"),
      { glossaryRequested: false },
    ).mode,
    "accurate",
  );
  assert.throws(
    () => assertTranslationBehaviorCapability(
      capabilities,
      resolveTranslationBehavior("accurate"),
      { glossaryRequested: true },
    ),
    /cannot authorize a deterministic glossary/u,
  );
});

test("derives support requirements from transcript and interruption policy", () => {
  const capabilities: TranslationCapabilities = {
    providerId: "openai_native",
    modes: [{
      mode: "fast",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "balanced",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
    }, {
      mode: "accurate",
      behaviorVersion: 1,
      state: "experimental",
      deterministicGlossary: false,
      reason: "Accurate benchmark parity is not established.",
    }],
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  };
  const provisionalBehavior = {
    version: 1,
    mode: "fast",
    inputCommit: "continuous",
    transcriptPolicy: "provisional_revisions",
    holdbackMs: 0,
    maxBufferedAudioMs: 800,
    interruption: "cut_destination",
  } satisfies TranslationBehavior;
  const finalOnlyBehavior = resolveTranslationBehavior("balanced");

  assert.throws(
    () => assertTranslationBehaviorCapability(
      { ...capabilities, supportsProvisionalRevisions: false },
      provisionalBehavior,
      { glossaryRequested: false },
    ),
    /cannot satisfy provisional revisions/u,
  );
  assert.doesNotThrow(
    () => assertTranslationBehaviorCapability(
      { ...capabilities, supportsProvisionalRevisions: false },
      finalOnlyBehavior,
      { glossaryRequested: false },
    ),
  );
  assert.throws(
    () => assertTranslationBehaviorCapability(
      { ...capabilities, supportsFinality: false },
      provisionalBehavior,
      { glossaryRequested: false },
    ),
    /cannot satisfy finality/u,
  );
  assert.throws(
    () => assertTranslationBehaviorCapability(
      { ...capabilities, supportsCancellation: false },
      finalOnlyBehavior,
      { glossaryRequested: false },
    ),
    /cannot satisfy interruption cancellation/u,
  );
});

test("rejects an unrecognized capability state", () => {
  const malformed = {
    providerId: "openai_native",
    modes: [{
      mode: "fast",
      behaviorVersion: 1,
      state: "native",
      deterministicGlossary: false,
    }, {
      mode: "balanced",
      behaviorVersion: 1,
      state: "locally_controlled",
      deterministicGlossary: false,
    }, {
      mode: "accurate",
      behaviorVersion: 1,
      state: "degraded",
      deterministicGlossary: false,
      reason: "Not a capability state.",
    }],
    supportsProvisionalRevisions: true,
    supportsFinality: true,
    supportsCancellation: true,
    supportsDeterministicGlossary: false,
  } as unknown as TranslationCapabilities;

  assert.throws(
    () => validateTranslationCapabilities(malformed),
    /openai_native accurate has an unrecognized state/u,
  );
});

test("rejects a per-mode glossary guarantee the provider does not support", () => {
  assert.throws(
    () => validateTranslationCapabilities({
      providerId: "palabra",
      modes: [{
        mode: "fast",
        behaviorVersion: 1,
        state: "native",
        deterministicGlossary: false,
      }, {
        mode: "balanced",
        behaviorVersion: 1,
        state: "native",
        deterministicGlossary: false,
      }, {
        mode: "accurate",
        behaviorVersion: 1,
        state: "native",
        deterministicGlossary: true,
      }],
      supportsProvisionalRevisions: true,
      supportsFinality: true,
      supportsCancellation: true,
      supportsDeterministicGlossary: false,
    }),
    /palabra accurate advertises deterministic glossary support inconsistently/u,
  );
});

import type {
  TranslationBehavior,
  TranslationCapabilities,
  TranslationModeCapability,
} from "./types.js";

const TRANSLATION_MODES = ["fast", "balanced", "accurate"] as const;
const TRANSLATION_MODE_STATES = new Set([
  "native",
  "locally_controlled",
  "experimental",
  "unsupported",
]);

export function validateTranslationCapabilities(
  capabilities: TranslationCapabilities,
): void {
  const declared = new Set(capabilities.modes.map((capability) => capability.mode));
  if (
    capabilities.modes.length !== TRANSLATION_MODES.length ||
    TRANSLATION_MODES.some((mode) => !declared.has(mode))
  ) {
    throw new TypeError(
      capabilities.providerId + " capabilities must declare fast, balanced, and accurate exactly once",
    );
  }
  for (const capability of capabilities.modes) {
    if (!TRANSLATION_MODE_STATES.has(capability.state)) {
      throw new TypeError(
        capabilities.providerId + " " + capability.mode + " has an unrecognized state",
      );
    }
    if (
      capability.deterministicGlossary &&
      !capabilities.supportsDeterministicGlossary
    ) {
      throw new TypeError(
        capabilities.providerId + " " + capability.mode +
          " advertises deterministic glossary support inconsistently",
      );
    }
    if (
      !isSelectableTranslationMode(capability) &&
      (capability.reason === undefined || capability.reason.trim().length === 0)
    ) {
      throw new TypeError(
        capabilities.providerId + " " + capability.mode + " " +
          capability.state + " requires a reason",
      );
    }
  }
}

export function isSelectableTranslationMode(
  capability: TranslationModeCapability,
): boolean {
  return capability.state === "native" || capability.state === "locally_controlled";
}

export function modeCapability(
  capabilities: TranslationCapabilities,
  mode: TranslationBehavior["mode"],
): TranslationModeCapability | undefined {
  return capabilities.modes.find((candidate) => candidate.mode === mode);
}

export function assertTranslationBehaviorCapability(
  capabilities: TranslationCapabilities,
  behavior: TranslationBehavior,
  options: Readonly<{ glossaryRequested: boolean }>,
): TranslationModeCapability {
  validateTranslationCapabilities(capabilities);
  const capability = modeCapability(capabilities, behavior.mode);
  if (capability === undefined) {
    throw new TypeError(
      capabilities.providerId + " does not declare " + behavior.mode + " capabilities",
    );
  }
  if (!isSelectableTranslationMode(capability)) {
    throw new TypeError(
      capabilities.providerId + " " + behavior.mode + " is " + capability.state +
        (capability.reason === undefined ? "" : ": " + capability.reason),
    );
  }
  if (capability.behaviorVersion !== behavior.version) {
    throw new TypeError(
      capabilities.providerId + " " + behavior.mode +
        " is incompatible with translation behavior version " + behavior.version,
    );
  }
  if (
    behavior.transcriptPolicy === "provisional_revisions" &&
    !capabilities.supportsProvisionalRevisions
  ) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy provisional revisions for " + behavior.mode,
    );
  }
  if (!capabilities.supportsFinality) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy finality for " + behavior.mode,
    );
  }
  if (!capabilities.supportsCancellation) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy interruption cancellation for " + behavior.mode,
    );
  }
  if (
    options.glossaryRequested &&
    (!capabilities.supportsDeterministicGlossary || !capability.deterministicGlossary)
  ) {
    throw new TypeError(
      capabilities.providerId + " cannot authorize a deterministic glossary for " + behavior.mode,
    );
  }
  return capability;
}

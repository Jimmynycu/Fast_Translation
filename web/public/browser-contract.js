const GLOSSARY_EXTENSIONS = new Set([".csv", ".xlsx"]);
const TRANSLATION_MODES = new Set(["fast", "balanced", "accurate"]);
const ACTIVE_SESSION_STATES = new Set(["active", "running", "started"]);

function requireObject(value, label) {
  if (!value || typeof value !== "object") {
    throw new TypeError(label + " must be an object");
  }
  return value;
}

export function shouldSendSpeechStartForActiveTransition(previousState, nextState, vadActive) {
  const wasActive = ACTIVE_SESSION_STATES.has(String(previousState || "").toLowerCase());
  const isActive = ACTIVE_SESSION_STATES.has(String(nextState || "").toLowerCase());
  return Boolean(vadActive) && !wasActive && isActive;
}

export function endpointGrantPresentation(grantValue, baseHref) {
  const grant = requireObject(grantValue, "Endpoint grant");
  const side = grant.side === "A" || grant.side === "B" ? grant.side : null;
  if (!side) throw new TypeError("Endpoint grant side must be A or B");

  if (grant.kind === "browser_link") {
    if (typeof grant.url !== "string" || grant.url.length === 0) {
      throw new TypeError("Browser endpoint grant requires a URL");
    }
    const href = new URL(grant.url, baseHref).toString();
    return Object.freeze({
      kind: grant.kind,
      side,
      href,
      copyValue: href,
      ...(typeof grant.qrDataUrl === "string" && grant.qrDataUrl.length > 0
        ? { qrDataUrl: grant.qrDataUrl }
        : {}),
    });
  }

  if (grant.kind === "telephony_test") {
    if (typeof grant.address !== "string" || grant.address.length === 0) {
      throw new TypeError("Telephony test endpoint grant requires an address");
    }
    return Object.freeze({
      kind: grant.kind,
      side,
      address: grant.address,
      copyValue: grant.address,
    });
  }

  throw new TypeError("Unsupported endpoint grant kind");
}

export function arrayBufferToBase64(buffer) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError("Glossary contents must be an ArrayBuffer");
  }
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function glossaryUploadContents(fileName, buffer) {
  if (typeof fileName !== "string" || fileName.trim().length === 0) {
    throw new TypeError("Glossary filename is required");
  }
  const normalized = fileName.trim();
  const dot = normalized.lastIndexOf(".");
  const extension = dot < 0 ? "" : normalized.slice(dot).toLowerCase();
  if (!GLOSSARY_EXTENSIONS.has(extension)) {
    throw new TypeError("Glossary file must be CSV or XLSX");
  }
  return Object.freeze({
    fileName: normalized,
    contentsBase64: arrayBufferToBase64(buffer),
  });
}

export function applySegmentRevision(segments, updateValue) {
  if (!(segments instanceof Map)) {
    throw new TypeError("Segment state must be a Map");
  }
  const update = requireObject(updateValue, "Segment update");
  if (!Number.isSafeInteger(update.generation) || update.generation < 0) {
    throw new TypeError("Segment update generation must be a non-negative integer");
  }
  if (typeof update.turnId !== "string" || update.turnId.trim().length === 0) {
    throw new TypeError("Segment update requires a turnId");
  }
  if (typeof update.segmentId !== "string" || update.segmentId.trim().length === 0) {
    throw new TypeError("Segment update requires a segmentId");
  }
  if (!Number.isSafeInteger(update.revision) || update.revision < 0) {
    throw new TypeError("Segment update revision must be a non-negative integer");
  }
  if (typeof update.text !== "string") {
    throw new TypeError("Segment update text must be a string");
  }
  if (typeof update.final !== "boolean") {
    throw new TypeError("Segment update final must be a boolean");
  }

  const generation = update.generation;
  const turnId = update.turnId.trim();
  const segmentId = update.segmentId.trim();
  const key = JSON.stringify([generation, turnId, segmentId]);
  const previous = segments.get(key);
  if (
    previous &&
    (previous.final || update.revision <= previous.revision)
  ) {
    return Object.freeze({ applied: false, key, segment: previous });
  }

  const segment = Object.freeze({
    generation,
    turnId,
    segmentId,
    revision: update.revision,
    text: update.text,
    final: update.final,
  });
  segments.set(key, segment);
  return Object.freeze({ applied: true, key, segment });
}

export function normalizeTranslationCapabilities(value) {
  const translation = requireObject(value, "Translation capabilities");
  if (typeof translation.provider !== "string" || translation.provider.trim().length === 0) {
    throw new TypeError("Translation capabilities require a provider");
  }
  if (!Array.isArray(translation.supportedModes) || translation.supportedModes.length === 0) {
    throw new TypeError("Translation capabilities require supported modes");
  }

  const modes = new Set();
  const supportedModes = translation.supportedModes.map((value) => {
    const capability = requireObject(value, "Translation mode capability");
    if (typeof capability.mode !== "string" || !TRANSLATION_MODES.has(capability.mode)) {
      throw new TypeError("Translation mode capability has an invalid mode");
    }
    if (modes.has(capability.mode)) {
      throw new TypeError("Translation capabilities must not repeat a mode");
    }
    modes.add(capability.mode);

    const behavior = requireObject(capability.behavior, "Translation mode behavior");
    if (!Number.isSafeInteger(behavior.version) || behavior.version < 1) {
      throw new TypeError("Translation mode behavior requires a positive integer version");
    }
    if (typeof capability.deterministicGlossary !== "boolean") {
      throw new TypeError("Translation mode capability requires deterministicGlossary");
    }

    const degradation = requireObject(capability.degradation, "Translation mode degradation");
    if (degradation.state === "full") {
      return Object.freeze({
        mode: capability.mode,
        behavior: Object.freeze({ version: behavior.version }),
        deterministicGlossary: capability.deterministicGlossary,
        degradation: Object.freeze({ state: "full" }),
      });
    }
    if (
      degradation.state !== "degraded" ||
      typeof degradation.reason !== "string" ||
      degradation.reason.trim().length === 0
    ) {
      throw new TypeError("Degraded translation modes require a reason");
    }
    return Object.freeze({
      mode: capability.mode,
      behavior: Object.freeze({ version: behavior.version }),
      deterministicGlossary: capability.deterministicGlossary,
      degradation: Object.freeze({ state: "degraded", reason: degradation.reason.trim() }),
    });
  });

  if (typeof translation.defaultMode !== "string" || !modes.has(translation.defaultMode)) {
    throw new TypeError("Translation capabilities require a supported default mode");
  }
  return Object.freeze({
    provider: translation.provider.trim(),
    supportedModes: Object.freeze(supportedModes),
    defaultMode: translation.defaultMode,
  });
}

const GLOSSARY_EXTENSIONS = new Set([".csv", ".xlsx"]);
const TRANSLATION_MODES = new Set(["fast", "balanced", "accurate"]);
const TRANSLATION_MODE_STATES = new Set([
  "native",
  "locally_controlled",
  "experimental",
  "unsupported",
]);
const SELECTABLE_TRANSLATION_MODE_STATES = new Set(["native", "locally_controlled"]);
const DATA_ADMISSIONS = new Set(["approved_poc_content", "synthetic_only"]);
const ACTIVE_SESSION_STATES = new Set(["active", "running", "started"]);
const SIDES = new Set(["A", "B"]);
const PROCESSING_DATA_CATEGORIES = new Set([
  "canonical_audio",
  "source_language",
  "target_language",
  "source_transcript",
  "source_terms",
  "aliases",
  "opaque_placeholders",
  "authorized_target_text",
]);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(label + " must be an object");
  }
  return value;
}

function requireOnlyKeys(value, label, keys, allowedLabel = "immutable identity fields") {
  const object = requireObject(value, label);
  for (const key of Object.keys(object)) {
    if (!keys.has(key)) {
      throw new TypeError(label + " may contain only " + allowedLabel);
    }
  }
  return object;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(label + " must be a lowercase SHA-256 hash");
  }
  return value;
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(label + " is required");
  }
  return value.trim();
}

function requireNonNegativeFinite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative finite number");
  }
  return value;
}

function requireNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(label + " must be a non-negative safe integer");
  }
  return value;
}

function requireOptionalSide(value, label) {
  if (value === undefined) return undefined;
  if (!SIDES.has(value)) throw new TypeError(label + " must be A or B");
  return value;
}

function requireCorrelationId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) {
    throw new TypeError(label + " must be an opaque correlation id");
  }
  return value;
}

function requireDecimalString(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new TypeError(label + " must be a decimal string");
  }
  return value;
}

export function normalizeDataAdmission(value) {
  if (!DATA_ADMISSIONS.has(value)) {
    throw new TypeError("Data admission must be approved_poc_content or synthetic_only");
  }
  return value;
}

export function normalizeEvidenceIdentity(value) {
  const identity = requireOnlyKeys(value, "Evidence identity", new Set([
    "deploymentBuildSha256",
    "processingProfile",
    "processingManifestSha256",
    "servicesSha256",
  ]));
  const profile = requireOnlyKeys(identity.processingProfile, "Processing profile identity", new Set([
    "id",
    "version",
    "sha256",
  ]));
  return Object.freeze({
    deploymentBuildSha256: requireSha256(
      identity.deploymentBuildSha256,
      "Deployment build SHA-256",
    ),
    processingProfile: Object.freeze({
      id: requireNonEmptyString(profile.id, "Processing profile id"),
      version: requireNonEmptyString(profile.version, "Processing profile version"),
      sha256: requireSha256(profile.sha256, "Processing profile SHA-256"),
    }),
    processingManifestSha256: requireSha256(
      identity.processingManifestSha256,
      "Processing manifest SHA-256",
    ),
    servicesSha256: requireSha256(identity.servicesSha256, "Services SHA-256"),
  });
}

export function normalizeParticipantReadiness(value) {
  const readiness = requireOnlyKeys(value, "Participant readiness", new Set([
    "side",
    "microphone",
    "headphones",
    "source",
  ]));
  if (!SIDES.has(readiness.side)) {
    throw new TypeError("Participant readiness side must be A or B");
  }
  const microphone = readiness.microphone;
  const headphones = readiness.headphones;
  const source = readiness.source;
  if (source === "participant_browser_self_report") {
    if (!["browser_capture_active", "stopped"].includes(microphone)) {
      throw new TypeError("Browser participant readiness has an invalid microphone state");
    }
    if (!["self_attested", "not_attested"].includes(headphones)) {
      throw new TypeError("Browser participant readiness has an invalid headphone state");
    }
    if (microphone === "browser_capture_active" && headphones !== "self_attested") {
      throw new TypeError("Active browser capture requires self-attested headphones");
    }
    if (microphone === "stopped" && headphones !== "not_attested") {
      throw new TypeError("Stopped browser capture must clear headphone attestation");
    }
  } else if (source === "fake_telephony_fixture") {
    if (microphone !== "not_applicable" || headphones !== "not_applicable") {
      throw new TypeError("Telephony fixture readiness must be not applicable");
    }
  } else {
    throw new TypeError("Participant readiness has an invalid source");
  }
  return Object.freeze({
    side: readiness.side,
    microphone,
    headphones,
    source,
  });
}

export function normalizeProviderReadiness(value) {
  const readiness = requireOnlyKeys(value, "Provider readiness", new Set([
    "readiness",
    "remoteConnection",
  ]));
  const route = readiness.readiness;
  const remoteConnection = readiness.remoteConnection;
  const valid =
    (route === "local_route_validated" && remoteConnection === "deferred_until_first_turn") ||
    (route === "remote_task_ready" && remoteConnection === "connected") ||
    (route === "fixture_local" && remoteConnection === "not_applicable");
  if (!valid) {
    throw new TypeError(
      "Provider readiness must pair local validation with deferred connection, remote readiness with connected, or fixture readiness with not applicable",
    );
  }
  return Object.freeze({ readiness: route, remoteConnection });
}

function hasQualifyingParticipantStartReadiness(side, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const readiness = normalizeParticipantReadiness({ ...value, side });
    return (
      (readiness.source === "participant_browser_self_report" &&
        readiness.microphone === "browser_capture_active" &&
        readiness.headphones === "self_attested") ||
      (readiness.source === "fake_telephony_fixture" &&
        readiness.microphone === "not_applicable" &&
        readiness.headphones === "not_applicable")
    );
  } catch {
    return false;
  }
}

function hasProviderStartReadiness(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    normalizeProviderReadiness(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors the server's admission prerequisites without treating a joined
 * websocket as proof of browser capture or headphone use. The relay remains
 * authoritative: callers still require its session state to be `ready`.
 */
export function isOperatorStartGateSatisfied(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const gate = value;
  const consent = gate.participantConsent;
  const connected = gate.connected;
  const participantReadiness = gate.participantReadiness;
  const providerReadiness = gate.providerReadiness;
  if (
    !consent || typeof consent !== "object" || Array.isArray(consent) ||
    !connected || typeof connected !== "object" || Array.isArray(connected) ||
    !participantReadiness || typeof participantReadiness !== "object" ||
      Array.isArray(participantReadiness) ||
    !providerReadiness || typeof providerReadiness !== "object" ||
      Array.isArray(providerReadiness) ||
    consent.A !== true || consent.B !== true ||
    connected.A !== true || connected.B !== true ||
    gate.recorderArmState !== "armed" || gate.recordingArmed !== true
  ) {
    return false;
  }
  return (
    hasQualifyingParticipantStartReadiness("A", participantReadiness.A) &&
    hasQualifyingParticipantStartReadiness("B", participantReadiness.B) &&
    hasProviderStartReadiness(providerReadiness.A_TO_B) &&
    hasProviderStartReadiness(providerReadiness.B_TO_A)
  );
}

function normalizeClearCorrelation(value, label) {
  const receipt = requireOnlyKeys(value, label, new Set([
    "lane",
    "generation",
    "clearId",
  ]), "exact clear correlation fields");
  if (receipt.lane !== "A_TO_B" && receipt.lane !== "B_TO_A") {
    throw new TypeError(label + " lane must be A_TO_B or B_TO_A");
  }
  return Object.freeze({
    lane: receipt.lane,
    generation: requireNonNegativeSafeInteger(
      receipt.generation,
      label + " generation",
    ),
    clearId: requireCorrelationId(receipt.clearId, label + " clearId"),
  });
}

function retainClearCorrelations(correlations, correlationValue, maximum, label) {
  if (!Array.isArray(correlations)) {
    throw new TypeError(label + " must be an array");
  }
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) {
    throw new RangeError(label + " maximum must be 1 through 256");
  }
  const correlation = normalizeClearCorrelation(correlationValue, label);
  const retained = [];
  const known = new Map();
  for (const candidateValue of correlations) {
    const candidate = normalizeClearCorrelation(candidateValue, label);
    const previous = known.get(candidate.clearId);
    if (previous) {
      if (previous.lane !== candidate.lane || previous.generation !== candidate.generation) {
        throw new TypeError(label + " clearId already belongs to another correlation");
      }
      continue;
    }
    known.set(candidate.clearId, candidate);
    retained.push(candidate);
  }
  const existing = known.get(correlation.clearId);
  if (existing) {
    if (existing.lane !== correlation.lane || existing.generation !== correlation.generation) {
      throw new TypeError(label + " clearId already belongs to another correlation");
    }
    const index = retained.findIndex((candidate) => candidate.clearId === correlation.clearId);
    if (index >= 0) retained.splice(index, 1);
  }
  retained.push(correlation);
  return Object.freeze(retained.slice(-maximum));
}

/**
 * Maintains a small, ordered receipt history for exact clearId correlation.
 * A matching replay moves to the newest position; a reused ID for another
 * lane or generation is rejected instead of being deduplicated by generation.
 */
export function retainTerminalClearReceipts(receipts, receiptValue, maximum = 256) {
  return retainClearCorrelations(receipts, receiptValue, maximum, "Terminal clear receipt");
}

/**
 * Bounds unacknowledged clear work independently of terminal ACK receipts.
 * An evicted request is deliberately absent from the return value: callers
 * must drop it without fabricating a clear_applied acknowledgement.
 */
export function retainOutstandingClearRequests(requests, requestValue, maximum = 256) {
  return retainClearCorrelations(requests, requestValue, maximum, "Outstanding clear request");
}

export function normalizeQueueSample(value) {
  const sample = requireOnlyKeys(value, "Queue sample", new Set([
    "scope",
    "side",
    "depthFrames",
    "capacityFrames",
    "oldestQueuedAgeMs",
    "bufferedAudioMs",
    "sourceSide",
    "targetSide",
  ]));
  if (!["relay_input", "relay_playout", "browser_playout"].includes(sample.scope)) {
    throw new TypeError("Queue sample has an invalid scope");
  }
  const side = sample.side;
  if (side !== null && !SIDES.has(side)) {
    throw new TypeError("Queue sample side must be A, B, or null");
  }
  const depthFrames = requireNonNegativeSafeInteger(sample.depthFrames, "Queue depthFrames");
  const capacityFrames = requireNonNegativeSafeInteger(sample.capacityFrames, "Queue capacityFrames");
  if (capacityFrames < 1) throw new TypeError("Queue capacityFrames must be positive");
  if (depthFrames > capacityFrames) {
    throw new TypeError("Queue depthFrames cannot exceed capacityFrames");
  }
  const oldestQueuedAgeMs = sample.oldestQueuedAgeMs === undefined
    ? undefined
    : requireNonNegativeFinite(sample.oldestQueuedAgeMs, "Queue oldestQueuedAgeMs");
  const bufferedAudioMs = sample.bufferedAudioMs === undefined
    ? undefined
    : requireNonNegativeFinite(sample.bufferedAudioMs, "Queue bufferedAudioMs");
  if (sample.scope === "browser_playout" && bufferedAudioMs === undefined) {
    throw new TypeError("Browser queue samples require bufferedAudioMs");
  }
  const sourceSide = requireOptionalSide(sample.sourceSide, "Queue sourceSide");
  const targetSide = requireOptionalSide(sample.targetSide, "Queue targetSide");
  return Object.freeze({
    scope: sample.scope,
    side,
    depthFrames,
    capacityFrames,
    ...(oldestQueuedAgeMs === undefined ? {} : { oldestQueuedAgeMs }),
    ...(bufferedAudioMs === undefined ? {} : { bufferedAudioMs }),
    ...(sourceSide === undefined ? {} : { sourceSide }),
    ...(targetSide === undefined ? {} : { targetSide }),
  });
}

export function normalizeBargeLifecycle(value) {
  const lifecycle = requireOnlyKeys(value, "Barge lifecycle", new Set([
    "stage",
    "bargeId",
    "clearId",
    "sourceSide",
    "destinationSide",
    "message",
  ]), "immutable causal fields");
  const stages = new Set([
    "speech_onset",
    "provider_cancel_requested",
    "provider_cancel_settled",
    "provider_cancel_failed",
    "playout_clear_requested",
    "playout_clear_acknowledged",
    "playout_clear_failed",
    "valid_output_resumed",
  ]);
  if (!stages.has(lifecycle.stage)) throw new TypeError("Barge lifecycle has an invalid stage");
  if (!SIDES.has(lifecycle.sourceSide) || !SIDES.has(lifecycle.destinationSide)) {
    throw new TypeError("Barge lifecycle sides must be A or B");
  }
  const message = lifecycle.message;
  if (message !== undefined && (typeof message !== "string" || message.trim().length === 0)) {
    throw new TypeError("Barge lifecycle message must be a non-empty string");
  }
  return Object.freeze({
    stage: lifecycle.stage,
    bargeId: requireCorrelationId(lifecycle.bargeId, "Barge lifecycle bargeId"),
    clearId: requireCorrelationId(lifecycle.clearId, "Barge lifecycle clearId"),
    sourceSide: lifecycle.sourceSide,
    destinationSide: lifecycle.destinationSide,
    ...(message === undefined ? {} : { message: message.trim() }),
  });
}

export function normalizeRecorderPreflight(value) {
  const preflight = requireObject(value, "Recorder preflight");
  if (preflight.status === "failed") {
    const failed = requireOnlyKeys(preflight, "Recorder preflight", new Set([
      "status",
      "checkedAtMonoMs",
      "failureCode",
    ]), "safe preflight fields");
    if (
      typeof failed.failureCode !== "string" ||
      ![
        "free_space_unavailable",
        "insufficient_evidence_disk",
        "evidence_preflight_failed",
        "evidence_preflight_integrity_failed",
      ].includes(failed.failureCode)
    ) {
      throw new TypeError("Recorder preflight failureCode is invalid");
    }
    return Object.freeze({
      status: "failed",
      checkedAtMonoMs: requireNonNegativeFinite(failed.checkedAtMonoMs, "Recorder preflight checkedAtMonoMs"),
      failureCode: failed.failureCode,
    });
  }
  const ready = requireOnlyKeys(preflight, "Recorder preflight", new Set([
    "status",
    "checkedAtMonoMs",
    "requiredFreeBytes",
    "availableFreeBytes",
    "tracks",
    "manifestSha256",
    "encryptedSpoolSha256",
    "sealedRecordCount",
    "sealSha256",
  ]), "safe preflight fields");
  if (ready.status !== "ready") throw new TypeError("Recorder preflight status is invalid");
  const tracks = ready.tracks;
  const requiredTracks = ["source_a", "source_b", "playout_to_a", "playout_to_b"];
  if (!Array.isArray(tracks) || JSON.stringify(tracks) !== JSON.stringify(requiredTracks)) {
    throw new TypeError("Recorder preflight tracks must be the four evidence tracks");
  }
  const requiredFreeBytes = requireDecimalString(ready.requiredFreeBytes, "Recorder preflight requiredFreeBytes");
  const availableFreeBytes = requireDecimalString(ready.availableFreeBytes, "Recorder preflight availableFreeBytes");
  if (BigInt(availableFreeBytes) < BigInt(requiredFreeBytes)) {
    throw new TypeError("Recorder preflight availableFreeBytes is below requiredFreeBytes");
  }
  const sealedRecordCount = requireNonNegativeSafeInteger(
    ready.sealedRecordCount,
    "Recorder preflight sealedRecordCount",
  );
  if (sealedRecordCount < 1) throw new TypeError("Recorder preflight sealedRecordCount must be positive");
  return Object.freeze({
    status: "ready",
    checkedAtMonoMs: requireNonNegativeFinite(ready.checkedAtMonoMs, "Recorder preflight checkedAtMonoMs"),
    requiredFreeBytes,
    availableFreeBytes,
    tracks: Object.freeze([...tracks]),
    manifestSha256: requireSha256(ready.manifestSha256, "Recorder preflight manifestSha256"),
    encryptedSpoolSha256: requireSha256(
      ready.encryptedSpoolSha256,
      "Recorder preflight encryptedSpoolSha256",
    ),
    sealedRecordCount,
    sealSha256: requireSha256(ready.sealSha256, "Recorder preflight sealSha256"),
  });
}

function requireCanonicalUtc(value, label) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    throw new TypeError(label + " must be a canonical UTC timestamp");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TypeError(label + " must be a canonical UTC timestamp");
  }
  return value;
}

function normalizeFinalizationTrack(value, track) {
  const digest = requireOnlyKeys(value, "Finalization track " + track, new Set([
    "sha256",
    "frameCount",
    "byteCount",
  ]), "safe finalization fields");
  return Object.freeze({
    sha256: requireSha256(digest.sha256, "Finalization track " + track + " SHA-256"),
    frameCount: requireNonNegativeSafeInteger(
      digest.frameCount,
      "Finalization track " + track + " frameCount",
    ),
    byteCount: requireNonNegativeSafeInteger(
      digest.byteCount,
      "Finalization track " + track + " byteCount",
    ),
  });
}

export function normalizeEvidenceFinalization(value) {
  const candidate = requireObject(value, "Evidence finalization");
  if (candidate.status === "FINALIZATION_FAILED") {
    const failure = requireOnlyKeys(candidate, "Evidence finalization", new Set([
      "status",
      "failureCode",
      "recovery",
    ]), "safe finalization fields");
    if (
      ![
        "seal_write_failed",
        "integrity_verification_failed",
        "manifest_write_failed",
      ].includes(failure.failureCode) ||
      !["rebuild_from_spool", "quarantine_delete_rerun"].includes(failure.recovery)
    ) {
      throw new TypeError("Evidence finalization failure has an invalid code or recovery");
    }
    return Object.freeze({
      status: "FINALIZATION_FAILED",
      failureCode: failure.failureCode,
      recovery: failure.recovery,
    });
  }
  const sealed = requireOnlyKeys(candidate, "Evidence finalization", new Set([
    "status",
    "manifestSha256",
    "encryptedLedgerSha256",
    "finalChainSha256",
    "retentionDeadlineAt",
    "tracks",
  ]), "safe finalization fields");
  if (sealed.status !== "sealed") {
    throw new TypeError("Evidence finalization has an invalid status");
  }
  const tracks = requireOnlyKeys(sealed.tracks, "Evidence finalization tracks", new Set([
    "source_a",
    "source_b",
    "playout_to_a",
    "playout_to_b",
  ]), "safe finalization track fields");
  for (const track of ["source_a", "source_b", "playout_to_a", "playout_to_b"]) {
    if (tracks[track] === undefined) {
      throw new TypeError("Evidence finalization is missing track " + track);
    }
  }
  return Object.freeze({
    status: "sealed",
    manifestSha256: requireSha256(sealed.manifestSha256, "Finalization manifest SHA-256"),
    encryptedLedgerSha256: requireSha256(
      sealed.encryptedLedgerSha256,
      "Finalization encrypted ledger SHA-256",
    ),
    finalChainSha256: requireSha256(sealed.finalChainSha256, "Finalization chain SHA-256"),
    retentionDeadlineAt: requireCanonicalUtc(sealed.retentionDeadlineAt, "Finalization retention deadline"),
    tracks: Object.freeze({
      source_a: normalizeFinalizationTrack(tracks.source_a, "source_a"),
      source_b: normalizeFinalizationTrack(tracks.source_b, "source_b"),
      playout_to_a: normalizeFinalizationTrack(tracks.playout_to_a, "playout_to_a"),
      playout_to_b: normalizeFinalizationTrack(tracks.playout_to_b, "playout_to_b"),
    }),
  });
}

export function normalizeTerminologyGate(value) {
  const gate = requireOnlyKeys(value, "Terminology gate", new Set([
    "status",
    "turnId",
    "segmentId",
    "revision",
    "final",
    "glossaryHash",
    "entryIds",
    "sourceSide",
    "targetSide",
    "type",
    "code",
    "message",
    "retryable",
    "termId",
    "confidence",
    "glossaryId",
    "glossaryVersion",
    "expectedPlaceholders",
    "observedPlaceholders",
  ]), "safe terminology fields");
  if (!["bound", "authorized", "bypassed"].includes(gate.status)) {
    throw new TypeError("Terminology gate has an invalid status");
  }
  const entryIds = gate.entryIds === undefined ? [] : gate.entryIds;
  if (
    !Array.isArray(entryIds) ||
    entryIds.some((entryId) => typeof entryId !== "string" || entryId.trim().length === 0)
  ) {
    throw new TypeError("Terminology gate entryIds must be non-empty strings");
  }
  const termId = gate.termId === undefined
    ? undefined
    : requireNonEmptyString(gate.termId, "Terminology gate termId");
  const confidence = gate.confidence === undefined
    ? undefined
    : requireNonNegativeFinite(gate.confidence, "Terminology gate confidence");
  if (confidence !== undefined && confidence > 1) {
    throw new TypeError("Terminology gate confidence must be at most one");
  }
  const code = gate.code === undefined ? undefined : requireNonEmptyString(gate.code, "Terminology gate code");
  const message = gate.message === undefined
    ? undefined
    : requireNonEmptyString(gate.message, "Terminology gate message");
  const sourceSide = requireOptionalSide(gate.sourceSide, "Terminology gate sourceSide");
  const targetSide = requireOptionalSide(gate.targetSide, "Terminology gate targetSide");
  return Object.freeze({
    status: gate.status,
    glossaryHash: requireSha256(gate.glossaryHash, "Terminology gate glossaryHash"),
    entryIds: Object.freeze(entryIds.map((entryId) => entryId.trim())),
    ...(termId === undefined ? {} : { termId }),
    ...(confidence === undefined ? {} : { confidence }),
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
    ...(sourceSide === undefined ? {} : { sourceSide }),
    ...(targetSide === undefined ? {} : { targetSide }),
  });
}

export function normalizePlayoutLag(value) {
  const lag = requireOnlyKeys(value, "Playout lag", new Set([
    "scope",
    "side",
    "sequence",
    "audibleStartLagMs",
    "turnId",
    "segmentId",
    "revision",
    "sourceSide",
    "targetSide",
  ]), "safe playout-lag fields");
  if (lag.scope !== "server_to_audible_ack") {
    throw new TypeError("Playout lag scope must be server_to_audible_ack");
  }
  if (!SIDES.has(lag.side)) throw new TypeError("Playout lag side must be A or B");
  const turnId = lag.turnId === undefined
    ? undefined
    : requireNonEmptyString(lag.turnId, "Playout lag turnId");
  const segmentId = lag.segmentId === undefined
    ? undefined
    : requireNonEmptyString(lag.segmentId, "Playout lag segmentId");
  const revision = lag.revision === undefined
    ? undefined
    : requireNonNegativeSafeInteger(lag.revision, "Playout lag revision");
  const identityProvided = turnId !== undefined || segmentId !== undefined || revision !== undefined;
  if (identityProvided && (turnId === undefined || segmentId === undefined || revision === undefined)) {
    throw new TypeError("Playout lag identity must include turnId, segmentId, and revision");
  }
  const sourceSide = requireOptionalSide(lag.sourceSide, "Playout lag sourceSide");
  const targetSide = requireOptionalSide(lag.targetSide, "Playout lag targetSide");
  return Object.freeze({
    scope: "server_to_audible_ack",
    side: lag.side,
    sequence: requireNonNegativeSafeInteger(lag.sequence, "Playout lag sequence"),
    audibleStartLagMs: requireNonNegativeFinite(lag.audibleStartLagMs, "Playout lag audibleStartLagMs"),
    ...(turnId === undefined ? {} : { turnId }),
    ...(segmentId === undefined ? {} : { segmentId }),
    ...(revision === undefined ? {} : { revision }),
    ...(sourceSide === undefined ? {} : { sourceSide }),
    ...(targetSide === undefined ? {} : { targetSide }),
  });
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
  if (!Array.isArray(translation.modes) || translation.modes.length !== TRANSLATION_MODES.size) {
    throw new TypeError("Translation capabilities must declare fast, balanced, and accurate exactly once");
  }

  const modes = new Set();
  const capabilities = translation.modes.map((value) => {
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
    if (!TRANSLATION_MODE_STATES.has(capability.state)) {
      throw new TypeError("Translation mode capability has an invalid state");
    }
    const reason = capability.reason;
    if (
      reason !== undefined &&
      (typeof reason !== "string" || reason.trim().length === 0)
    ) {
      throw new TypeError("Translation mode capability reason must be a non-empty string");
    }
    if (
      !SELECTABLE_TRANSLATION_MODE_STATES.has(capability.state) &&
      reason === undefined
    ) {
      throw new TypeError("Experimental and unsupported translation modes require a reason");
    }
    return Object.freeze({
      mode: capability.mode,
      behavior: Object.freeze({ version: behavior.version }),
      state: capability.state,
      deterministicGlossary: capability.deterministicGlossary,
      ...(reason === undefined ? {} : { reason: reason.trim() }),
    });
  });

  if (modes.size !== TRANSLATION_MODES.size) {
    throw new TypeError("Translation capabilities must declare fast, balanced, and accurate exactly once");
  }
  const defaultMode = capabilities.find((capability) => capability.mode === translation.defaultMode);
  if (typeof translation.defaultMode !== "string" || !defaultMode) {
    throw new TypeError("Translation capabilities require a declared default mode");
  }
  if (!SELECTABLE_TRANSLATION_MODE_STATES.has(defaultMode.state)) {
    throw new TypeError("Translation capabilities require a selectable default mode");
  }
  return Object.freeze({
    provider: translation.provider.trim(),
    modes: Object.freeze(capabilities),
    defaultMode: translation.defaultMode,
  });
}

export function isSelectableTranslationMode(capability) {
  return Boolean(
    capability &&
      typeof capability === "object" &&
      SELECTABLE_TRANSLATION_MODE_STATES.has(capability.state),
  );
}

export function normalizeProcessingDisclosure(value) {
  const disclosure = requireObject(value, "Processing disclosure");
  if (typeof disclosure.noticeVersion !== "string" || disclosure.noticeVersion.trim().length === 0) {
    throw new TypeError("Processing disclosure requires a notice version");
  }
  if (disclosure.recording !== true) {
    throw new TypeError("Processing disclosure must explicitly require recording");
  }
  if (disclosure.processing !== true) {
    throw new TypeError("Processing disclosure must explicitly require processing");
  }
  if (disclosure.withdrawalTerminatesSession !== true) {
    throw new TypeError("Processing disclosure must state that withdrawal ends the session");
  }
  if (typeof disclosure.provider !== "string" || disclosure.provider.trim().length === 0) {
    throw new TypeError("Processing disclosure requires a configured provider");
  }
  if (!Array.isArray(disclosure.services) || disclosure.services.length === 0) {
    throw new TypeError("Processing disclosure requires one or more configured services");
  }
  const serviceIds = new Set();
  const services = disclosure.services.map((value) => {
    const service = requireOnlyKeys(value, "Processing service", new Set([
      "id",
      "provider",
      "role",
      "category",
      "dataCategories",
    ]), "processing disclosure fields");
    for (const field of ["id", "provider", "role", "category"]) {
      if (typeof service[field] !== "string" || service[field].trim().length === 0) {
        throw new TypeError("Processing service requires " + field);
      }
    }
    const id = service.id.trim();
    if (serviceIds.has(id)) throw new TypeError("Processing disclosure must not repeat a service");
    serviceIds.add(id);
    if (!Array.isArray(service.dataCategories) || service.dataCategories.length === 0) {
      throw new TypeError("Processing service requires one or more data categories");
    }
    const dataCategories = [];
    const seenCategories = new Set();
    for (const category of service.dataCategories) {
      if (!PROCESSING_DATA_CATEGORIES.has(category)) {
        throw new TypeError("Processing service has an unsupported data category");
      }
      if (seenCategories.has(category)) {
        throw new TypeError("Processing service data categories must be unique");
      }
      seenCategories.add(category);
      dataCategories.push(category);
    }
    return Object.freeze({
      id,
      provider: service.provider.trim(),
      role: service.role.trim(),
      category: service.category.trim(),
      dataCategories: Object.freeze(dataCategories),
    });
  });
  return Object.freeze({
    noticeVersion: disclosure.noticeVersion.trim(),
    recording: true,
    processing: true,
    withdrawalTerminatesSession: true,
    provider: disclosure.provider.trim(),
    services: Object.freeze(services),
  });
}

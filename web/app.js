import {
  applySegmentRevision,
  endpointGrantPresentation,
  glossaryUploadContents,
  isOperatorStartGateSatisfied,
  isSelectableTranslationMode,
  normalizeBargeLifecycle,
  normalizeDataAdmission,
  normalizeEvidenceIdentity,
  normalizeEvidenceFinalization,
  normalizeParticipantReadiness,
  normalizePlayoutLag,
  normalizeProviderReadiness,
  normalizeProcessingDisclosure,
  normalizeQueueSample,
  normalizeRecorderPreflight,
  normalizeTerminologyGate,
  normalizeTranslationCapabilities,
  retainOutstandingClearRequests,
  retainTerminalClearReceipts,
  shouldSendSpeechStartForActiveTransition,
} from "./public/browser-contract.js";
import { MediaSocketSupervisor } from "./public/media-socket-supervisor.js";

const $ = (id) => document.getElementById(id);
const MAX_OUTSTANDING_CLEAR_REQUESTS = 256;
const MAX_BARGE_FEED_ITEMS = 40;
const MAX_PENDING_VALIDATION_ITEMS = 256;
const MAX_PENDING_PLAYED_ITEMS = 256;

const params = new URLSearchParams(window.location.search);
const fragmentParams = new URLSearchParams(window.location.hash.slice(1));
const route = {
  role: params.get("role") === "participant" ? "participant" : "operator",
  sessionId: params.get("sessionId") || "",
  side: params.get("side") === "B" ? "B" : "A",
  access: fragmentParams.get("access") || "",
};

const state = {
  glossaryVersion: null,
  glossaryDirection: null,
  glossaryHash: null,
  capabilitiesReady: false,
  dataAdmission: null,
  translation: null,
  session: null,
  roomStatus: "waiting",
  eventSocket: null,
  eventSessionId: null,
  eventEpoch: 0,
  eventReconnectTimer: null,
  eventAttempts: 0,
  eventsClosed: false,
  lastCursor: 0,
  seenCursors: new Set(),
  participants: new Set(),
  participantConsent: { A: false, B: false },
  recorderArmState: "awaiting_consents",
  recordingArmed: false,
  participantConsentId: null,
  participantWithdrawalId: null,
  processingDisclosure: null,
  evidenceIdentity: null,
  evidence: {
    recorderPreflight: null,
    participantReadiness: { A: null, B: null },
    providerReadiness: { A_TO_B: null, B_TO_A: null },
    queues: new Map(),
    latestPlayoutLag: null,
    bargeStages: new Map(),
    finalization: null,
  },
  participantCanAttemptCapture: false,
  participantTransportSecure: false,
  segmentStates: {
    source: { A: new Map(), B: new Map() },
    target: { A: new Map(), B: new Map() },
  },
  segmentLines: {
    source: { A: new Map(), B: new Map() },
    target: { A: new Map(), B: new Map() },
  },
  pendingValidation: new Map(),
  pendingPlayed: new Map(),
  laneGenerations: new Map(),
  latencySamples: [],
  cutCount: 0,
  alertCount: 0,
  audio: null,
  mediaEpoch: 0,
  vadActive: false,
  captureBackpressureAlerted: false,
  capturePreroll: [],
};

const MODE_LABELS = {
  fast: "Fast — streaming",
  balanced: "Balanced — stable phrases",
  accurate: "Accurate — whole sentences",
};

const PROVIDER_LABELS = {
  palabra: "Palabra",
  openai_native: "OpenAI native",
  openai_controlled: "OpenAI controlled",
  deterministic: "Deterministic test",
};

function uniqueId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (window.crypto && window.crypto.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.random() * 256;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function participantConsentId() {
  if (state.participantConsentId) return state.participantConsentId;
  const key = "recording-processing-consent:" + route.sessionId + ":" + route.side;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(existing || "")) {
      state.participantConsentId = existing;
      return existing;
    }
    const consentId = uniqueId();
    window.sessionStorage.setItem(key, consentId);
    state.participantConsentId = consentId;
    return consentId;
  } catch {
    state.participantConsentId = uniqueId();
    return state.participantConsentId;
  }
}

function participantWithdrawalId() {
  if (state.participantWithdrawalId) return state.participantWithdrawalId;
  const key = "recording-processing-withdrawal:" + route.sessionId + ":" + route.side;
  try {
    const existing = window.sessionStorage.getItem(key);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(existing || "")) {
      state.participantWithdrawalId = existing;
      return existing;
    }
    const withdrawalId = uniqueId();
    window.sessionStorage.setItem(key, withdrawalId);
    state.participantWithdrawalId = withdrawalId;
    return withdrawalId;
  } catch {
    state.participantWithdrawalId = uniqueId();
    return state.participantWithdrawalId;
  }
}

const loopbackParticipantHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isParticipantTransportSecure() {
  return window.isSecureContext === true ||
    loopbackParticipantHosts.has(window.location.hostname.toLowerCase());
}

function websocketUrl(path) {
  const url = new URL(path, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(route.access ? { authorization: "Bearer " + route.access } : {}),
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = { message: raw };
    }
  }
  if (!response.ok) {
    const detail =
      (data.error && data.error.message) ||
      data.message ||
      data.error ||
      "Request failed with status " + response.status;
    throw new Error(String(detail));
  }
  return data;
}

async function getJson(path) {
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      ...(route.access ? { authorization: "Bearer " + route.access } : {}),
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("The server returned an invalid JSON response.");
  }
  if (!response.ok) {
    const detail =
      (data.error && data.error.message) ||
      data.message ||
      "Request failed with status " + response.status;
    throw new Error(String(detail));
  }
  return data;
}

function setLoading(button, loading, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.classList.toggle("is-loading", loading);
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
  if (text !== undefined) button.textContent = loading ? text : button.dataset.label;
}

function showError(element, error) {
  element.textContent = error instanceof Error ? error.message : String(error);
  element.hidden = false;
}

function clearError(element) {
  element.hidden = true;
  element.textContent = "";
}

function textFrom(data) {
  if (!data || typeof data !== "object") return typeof data === "string" ? data : "";
  const value =
    data.text ??
    data.transcript ??
    data.sourceText ??
    data.targetText ??
    data.translatedText ??
    data.delta ??
    data.value;
  return typeof value === "string" ? value : "";
}

function titleCase(value) {
  return String(value || "event")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayTime() {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date());
}

function normaliseSide(value) {
  const side = String(value || "").toUpperCase();
  if (side === "A" || side.startsWith("A_") || side.startsWith("A-")) return "A";
  if (side === "B" || side.startsWith("B_") || side.startsWith("B-")) return "B";
  return null;
}

function eventSides(envelope) {
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const lane = String(envelope.lane || data.lane || "").toUpperCase();
  const match = lane.match(/^([AB])(?:_TO_|->|_)([AB])$/);
  const source =
    normaliseSide(data.sourceSide || data.source_side) ||
    (match ? match[1] : null) ||
    normaliseSide(data.side || envelope.lane);
  const target =
    normaliseSide(data.targetSide || data.target_side) ||
    (match ? match[2] : null) ||
    (source ? (source === "A" ? "B" : "A") : null);
  return { source, target };
}

function eventSummary(data, envelope) {
  if (!data || typeof data !== "object") return String(data || "");
  const direct =
    data.message ??
    data.reason ??
    data.term ??
    data.state ??
    data.status ??
    textFrom(data);
  if (direct !== undefined && direct !== "") return String(direct).slice(0, 120);
  if (envelope.generation !== undefined) return "Generation " + envelope.generation;
  const keys = Object.keys(data);
  return keys.length ? keys.slice(0, 3).join(", ") : "";
}

function canonicalEventSessionId(value) {
  if (typeof value !== "string") return null;
  const canonical = value.normalize("NFC").trim();
  if (
    canonical.length === 0 ||
    canonical !== value ||
    canonical.length > 256
  ) return null;
  return canonical;
}

function eventBelongsToSession(envelope, expectedSessionId) {
  if (!envelope || typeof envelope !== "object") return false;
  const expected = canonicalEventSessionId(expectedSessionId);
  const actual = canonicalEventSessionId(envelope.sessionId);
  return expected !== null && actual === expected;
}

function isTerminalEvidenceFinalization(envelope) {
  if (
    route.role !== "operator" ||
    !envelope ||
    typeof envelope !== "object" ||
    envelope.type !== "session_state"
  ) {
    return false;
  }
  const data = envelope.data;
  if (
    !data ||
    typeof data !== "object" ||
    data.state !== "closed" ||
    data.status !== "closed" ||
    !Object.hasOwn(data, "evidenceFinalization")
  ) {
    return false;
  }
  try {
    normalizeEvidenceFinalization(data.evidenceFinalization);
    return true;
  } catch {
    return false;
  }
}

function addFeedItem(container, title, summary, warning) {
  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  const item = document.createElement("article");
  item.className = "event-item" + (warning ? " is-warning" : "");

  const top = document.createElement("div");
  top.className = "event-item-top";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const time = document.createElement("time");
  time.textContent = displayTime();
  top.append(strong, time);
  item.append(top);

  if (summary) {
    const detail = document.createElement("small");
    detail.textContent = summary;
    item.append(detail);
  }
  container.prepend(item);
  while (container.children.length > 40) container.lastElementChild.remove();
  return item;
}

function upsertFeedItem(container, key, title, summary, warning) {
  const existing = Array.from(container.querySelectorAll(".event-item")).find(
    (item) => item.dataset.consoleKey === key,
  );
  if (!existing) {
    const created = addFeedItem(container, title, summary, warning);
    created.dataset.consoleKey = key;
    return created;
  }
  existing.classList.toggle("is-warning", Boolean(warning));
  const titleElement = existing.querySelector("strong");
  const timeElement = existing.querySelector("time");
  if (titleElement) titleElement.textContent = title;
  if (timeElement) timeElement.textContent = displayTime();
  let detail = existing.querySelector("small");
  if (summary && !detail) {
    detail = document.createElement("small");
    existing.append(detail);
  }
  if (detail) detail.textContent = summary || "";
  return existing;
}

function updateGlobalStatus(label, online) {
  $("global-status").textContent = label;
  $("global-status-dot").classList.toggle("is-offline", !online);
}

function updateParticipantConnection(label, online) {
  const element = $("participant-connection");
  element.classList.toggle("is-offline", !online);
  const dot = document.createElement("span");
  element.replaceChildren(dot, document.createTextNode(" " + label));
}

function updateParticipantLiveStatus(message, warning = false) {
  if (route.role !== "participant") return;
  const element = $("participant-live-status");
  if (!element) return;
  element.textContent = message;
  element.classList.toggle("is-warning", warning);
}

function setPreflight(id, outcome) {
  const element = $(id);
  element.classList.toggle("is-pass", outcome === true);
  element.classList.toggle("is-fail", outcome === false);
  element.querySelector("span").textContent =
    outcome === true ? "\u2713" : outcome === false ? "!" : "...";
}

function renderJoinCards(grants) {
  const container = $("join-cards");
  container.replaceChildren();
  const languages = {
    A: $("language-a").selectedOptions[0].textContent,
    B: $("language-b").selectedOptions[0].textContent,
  };

  ["A", "B"].forEach((side) => {
    const grant = grants.find((item) => item.side === side);
    if (!grant) return;
    let endpoint;
    try {
      endpoint = endpointGrantPresentation(grant, window.location.href);
    } catch (error) {
      addFeedItem(
        $("pipeline-feed"),
        "Endpoint unavailable",
        error instanceof Error ? error.message : String(error),
        true,
      );
      return;
    }
    const fragment = $("join-card-template").content.cloneNode(true);
    const card = fragment.querySelector(".join-card");
    const sideBadge = card.querySelector(".side");
    sideBadge.textContent = side;
    sideBadge.classList.add(side === "A" ? "side-a" : "side-b");
    card.querySelector(".join-copy strong").textContent =
      endpoint.kind === "browser_link" ? "Phone " + side : "Telephony test " + side;
    card.querySelector(".join-language").textContent =
      endpoint.kind === "browser_link"
        ? languages[side]
        : languages[side] + " - " + endpoint.address;

    const image = card.querySelector(".qr-code");
    if (endpoint.qrDataUrl) {
      image.src = endpoint.qrDataUrl;
      image.alt = "QR code for Phone " + side;
    } else {
      image.hidden = true;
    }

    const link = card.querySelector(".join-link");
    if (endpoint.href) {
      link.href = endpoint.href;
      link.setAttribute("aria-label", "Open participant link for Phone " + side);
    } else {
      link.hidden = true;
    }

    const copy = card.querySelector(".copy-link");
    const copyLabel = endpoint.kind === "browser_link" ? "Copy link" : "Copy address";
    copy.textContent = copyLabel;
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(endpoint.copyValue);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = endpoint.kind === "browser_link" ? "Open link to copy" : "Copy failed";
      }
      window.setTimeout(() => {
        copy.textContent = copyLabel;
      }, 1600);
    });
    container.append(fragment);
  });
}

function resetSegmentRendering() {
  for (const kind of ["source", "target"]) {
    for (const side of ["A", "B"]) {
      state.segmentStates[kind][side].clear();
      state.segmentLines[kind][side].clear();
    }
  }
  state.laneGenerations.clear();
  state.pendingValidation.clear();
  state.pendingPlayed.clear();
  if (route.role === "operator") {
    for (const side of ["A", "B"]) {
      const container = $("transcript-" + side.toLowerCase());
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Waiting for Phone " + side + "…";
      container.replaceChildren(empty);
    }
  }
}

function segmentUpdate(data) {
  if (!data || typeof data !== "object") return null;
  if (
    typeof data.turnId !== "string" ||
    data.turnId.trim().length === 0 ||
    typeof data.segmentId !== "string" ||
    data.segmentId.trim().length === 0 ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0 ||
    typeof data.final !== "boolean"
  ) {
    return null;
  }
  if (typeof data.text !== "string") return null;
  return {
    turnId: data.turnId.trim(),
    segmentId: data.segmentId.trim(),
    revision: data.revision,
    text: data.text,
    final: data.final,
  };
}

function segmentIdentity(data) {
  if (!data || typeof data !== "object") return null;
  const turnId = typeof data.turnId === "string" ? data.turnId.trim() : "";
  const segmentId = typeof data.segmentId === "string" ? data.segmentId.trim() : "";
  if (!turnId || !segmentId) return null;
  return { turnId, segmentId };
}

function segmentCorrelation(data) {
  const identity = segmentIdentity(data);
  if (!identity) return null;
  const prefixed = identity.segmentId.match(/^(source|target|terminology|audio):(.+)$/u);
  let itemId = prefixed ? prefixed[2] : identity.segmentId;
  if (prefixed?.[1] === "audio") {
    const sequenceSeparator = itemId.lastIndexOf(":");
    if (sequenceSeparator > 0) itemId = itemId.slice(0, sequenceSeparator);
  }
  if (!itemId) return null;
  return { turnId: identity.turnId, itemId };
}

function validationKey(envelope, data) {
  const identity = segmentCorrelation(data);
  const lane = typeof envelope?.lane === "string" ? envelope.lane : data?.lane;
  const generation = Number(envelope?.generation ?? data?.generation);
  const revision = Number(data?.revision);
  if (
    !identity ||
    typeof lane !== "string" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) return null;
  return JSON.stringify([lane, generation, identity.turnId, identity.itemId, revision]);
}

function clearPendingValidation(lane, generation) {
  for (const key of state.pendingValidation.keys()) {
    try {
      const parsed = JSON.parse(key);
      if (parsed[0] === lane && parsed[1] === generation) state.pendingValidation.delete(key);
    } catch {
      state.pendingValidation.delete(key);
    }
  }
}

function retainPendingValidation(key) {
  const parsed = JSON.parse(key);
  state.pendingValidation.delete(key);
  state.pendingValidation.set(key, parsed[4]);
  while (state.pendingValidation.size > MAX_PENDING_VALIDATION_ITEMS) {
    const oldest = state.pendingValidation.keys().next().value;
    if (oldest === undefined) break;
    state.pendingValidation.delete(oldest);
  }
}

function playedKey(envelope, data) {
  const sessionId = canonicalEventSessionId(envelope?.sessionId);
  const identity = segmentCorrelation(data);
  const lane = typeof envelope?.lane === "string" ? envelope.lane : data?.lane;
  const generation = Number(envelope?.generation ?? data?.generation);
  const revision = Number(data?.revision);
  if (
    sessionId === null ||
    !identity ||
    typeof lane !== "string" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) return null;
  return JSON.stringify([
    sessionId,
    lane,
    generation,
    identity.turnId,
    identity.itemId,
    revision,
  ]);
}

function retainPendingPlayed(key) {
  const parsed = JSON.parse(key);
  state.pendingPlayed.delete(key);
  state.pendingPlayed.set(key, parsed[5]);
  while (state.pendingPlayed.size > MAX_PENDING_PLAYED_ITEMS) {
    const oldest = state.pendingPlayed.keys().next().value;
    if (oldest === undefined) break;
    state.pendingPlayed.delete(oldest);
  }
}

function clearPendingPlayed(lane, generation) {
  for (const key of state.pendingPlayed.keys()) {
    try {
      const parsed = JSON.parse(key);
      if (
        (lane === undefined || parsed[1] === lane) &&
        (generation === undefined || parsed[2] === generation)
      ) state.pendingPlayed.delete(key);
    } catch {
      state.pendingPlayed.delete(key);
    }
  }
}

function clearSupersededPendingPlayed(lane, generation, identity, revision) {
  if (!identity) return;
  for (const key of state.pendingPlayed.keys()) {
    try {
      const parsed = JSON.parse(key);
      if (
        parsed[1] === lane &&
        parsed[2] === generation &&
        parsed[3] === identity.turnId &&
        parsed[4] === identity.itemId &&
        Number.isSafeInteger(parsed[5]) &&
        parsed[5] < revision
      ) state.pendingPlayed.delete(key);
    } catch {
      state.pendingPlayed.delete(key);
    }
  }
}

function consumePendingPlayed(envelope, data) {
  const key = playedKey(envelope, data);
  if (!key || !state.pendingPlayed.has(key)) return false;
  state.pendingPlayed.delete(key);
  return true;
}

function findPendingValidation(envelope, data) {
  const key = validationKey(envelope, data);
  if (key && state.pendingValidation.has(key)) return key;
  const correlation = segmentCorrelation(data);
  const lane = typeof envelope?.lane === "string" ? envelope.lane : data?.lane;
  const generation = Number(envelope?.generation ?? data?.generation);
  const revision = Number(data?.revision);
  if (
    !correlation ||
    typeof lane !== "string" ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) return null;
  let candidate = null;
  let candidateRevision = Number.POSITIVE_INFINITY;
  for (const [pendingKey, pendingRevision] of state.pendingValidation) {
    try {
      const parsed = JSON.parse(pendingKey);
      if (
        parsed[0] === lane &&
        parsed[1] === generation &&
        parsed[2] === correlation.turnId &&
        parsed[3] === correlation.itemId &&
        Number.isSafeInteger(pendingRevision) &&
        pendingRevision >= revision &&
        pendingRevision < candidateRevision
      ) {
        candidate = pendingKey;
        candidateRevision = pendingRevision;
      }
    } catch {
      state.pendingValidation.delete(pendingKey);
    }
  }
  return candidate;
}

function acceptedSegmentGeneration(envelope) {
  if (typeof envelope.lane !== "string" || !Number.isSafeInteger(envelope.generation)) {
    return null;
  }
  const lane = envelope.lane;
  const generation = envelope.generation;
  const current = state.laneGenerations.get(lane);
  if (current !== undefined && generation < current) return null;
  if (current === undefined || generation > current) {
    state.laneGenerations.set(lane, generation);
  }
  return { lane, generation };
}

function renderTranscriptSegment(kind, sourceSide, data, envelope) {
  if (!sourceSide) return;
  const update = segmentUpdate(data);
  const generationRef = acceptedSegmentGeneration(envelope);
  if (!update || !generationRef) return;

  const container = $("transcript-" + sourceSide.toLowerCase());
  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  const result = applySegmentRevision(state.segmentStates[kind][sourceSide], {
    ...update,
    generation: generationRef.generation,
  });
  if (!result.applied) return;
  if (kind === "target") {
    clearSupersededPendingPlayed(
      generationRef.lane,
      generationRef.generation,
      segmentCorrelation(update),
      update.revision,
    );
  }
  const renderKey = result.key;

  let line = state.segmentLines[kind][sourceSide].get(renderKey);
  if (!line) {
    line = document.createElement("article");
    line.className = "transcript-line";
    line.dataset.lane = generationRef.lane;
    line.dataset.generation = String(generationRef.generation);
    line.dataset.turnId = update.turnId;
    line.dataset.segmentId = update.segmentId;
    line.dataset.itemId = segmentCorrelation(update)?.itemId || update.segmentId;
    line.dataset.kind = kind;
    line.dataset.sourceSide = sourceSide;
    line.dataset.validated = "false";
    line.dataset.played = "false";
    line.dataset.cut = "false";
    const text = document.createElement("p");
    text.className = kind === "source" ? "source" : "translation";
    const label = document.createElement("small");
    line.append(text, label);
    state.segmentLines[kind][sourceSide].set(renderKey, line);
    container.append(line);
  }

  const revision = String(update.revision);
  if (line.dataset.revision !== undefined && line.dataset.revision !== revision) {
    line.dataset.validated = "false";
    line.dataset.played = "false";
    line.dataset.cut = "false";
    line.classList.toggle("is-validated", false);
    line.classList.toggle("is-played", false);
    line.classList.toggle("is-cut", false);
  }
  line.dataset.revision = revision;
  line.dataset.stateKey = JSON.stringify([
    generationRef.generation,
    update.turnId,
    update.segmentId,
    update.revision,
  ]);
  line.querySelector("p").textContent = update.text;
  line.dataset.final = String(update.final);
  line.classList.toggle("is-partial", !update.final);
  const pendingValidationKey = kind === "target" ? findPendingValidation(envelope, update) : null;
  if (
    kind === "target" &&
    (data.validated === true || (pendingValidationKey && state.pendingValidation.has(pendingValidationKey)))
  ) {
    line.dataset.validated = "true";
    line.classList.add("is-validated");
    if (pendingValidationKey) state.pendingValidation.delete(pendingValidationKey);
  }
  if (kind === "target" && consumePendingPlayed(envelope, update)) {
    line.dataset.played = "true";
    line.classList.add("is-played");
  }
  renderTranscriptLineLabel(line);
  container.scrollTop = container.scrollHeight;
}

function renderTranscriptLineLabel(line) {
  const kind = line.dataset.kind;
  const sourceSide = line.dataset.sourceSide;
  if (!kind || !sourceSide) return;
  const label = line.querySelector("small");
  if (!label) return;
  const statuses = [];
  if (line.dataset.validated === "true") statuses.push("validated");
  if (line.dataset.played === "true") statuses.push("played");
  if (line.dataset.cut === "true") statuses.push("cut/cancelled");
  const base = kind === "source"
    ? "Phone " + sourceSide + (line.dataset.final === "true" ? " - source" : " - hearing")
    : "Phone " + sourceSide + " - AI translation";
  label.textContent = base + (statuses.length ? " - " + statuses.join(" · ") : "");
}

function matchingTargetLines(envelope, data, allowNewerRevision = false) {
  const correlation = segmentCorrelation(data);
  if (!correlation) return [];
  const lane = typeof envelope.lane === "string" ? envelope.lane : data.lane;
  const generation = Number(envelope.generation ?? data.generation);
  const revision = Number(data.revision);
  if (typeof lane !== "string" || !Number.isSafeInteger(generation) || generation < 0) return [];
  const sourceSide = eventSides({ ...envelope, data }).source;
  const sides = sourceSide ? [sourceSide] : ["A", "B"];
  const matches = [];
  for (const side of sides) {
    for (const line of state.segmentLines.target[side].values()) {
      if (
        line.dataset.lane === lane &&
        Number(line.dataset.generation) === generation &&
        line.dataset.turnId === correlation.turnId &&
        line.dataset.itemId === correlation.itemId &&
        (!Number.isSafeInteger(revision) ||
          line.dataset.revision === String(revision) ||
          (allowNewerRevision && Number(line.dataset.revision) <= revision))
      ) matches.push(line);
    }
  }
  return matches;
}

function markTargetSegmentValidated(envelope, data) {
  if (route.role !== "operator" || data.status !== "authorized") return;
  const key = validationKey(envelope, data);
  if (!key) return;
  const lines = matchingTargetLines(envelope, data, true);
  if (!lines.length) {
    retainPendingValidation(key);
    return;
  }
  state.pendingValidation.delete(key);
  for (const line of lines) {
    line.dataset.validated = "true";
    line.classList.add("is-validated");
    renderTranscriptLineLabel(line);
  }
}

function markTargetSegmentPlayed(envelope, data) {
  if (route.role !== "operator") return;
  const lines = matchingTargetLines(envelope, data);
  if (!lines.length) {
    const key = playedKey(envelope, data);
    if (key) retainPendingPlayed(key);
    return;
  }
  for (const line of lines) {
    line.dataset.played = "true";
    line.classList.add("is-played");
    renderTranscriptLineLabel(line);
  }
}

function clearSupersededSegments(envelope, data) {
  if (typeof envelope.lane !== "string") return;
  const generation = Number(envelope.generation ?? data.generation);
  const previousGeneration = Number(data.previousGeneration);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    !Number.isSafeInteger(previousGeneration) ||
    previousGeneration < 0 ||
    previousGeneration >= generation
  ) return;
  const current = state.laneGenerations.get(envelope.lane);
  if (current !== undefined && generation < current) return;
  state.laneGenerations.set(envelope.lane, generation);
  clearPendingValidation(envelope.lane, previousGeneration);
  clearPendingPlayed(envelope.lane, previousGeneration);

  for (const kind of ["source", "target"]) {
    for (const side of ["A", "B"]) {
      const lines = state.segmentLines[kind][side];
      for (const [key, line] of lines) {
        if (
          line.dataset.lane === envelope.lane &&
          Number(line.dataset.generation) === previousGeneration &&
          line.dataset.final !== "true"
        ) {
          line.remove();
          lines.delete(key);
          state.segmentStates[kind][side].delete(key);
        } else if (
          line.dataset.lane === envelope.lane &&
          Number(line.dataset.generation) === previousGeneration &&
          line.dataset.final === "true"
        ) {
          line.dataset.cut = "true";
          line.classList.add("is-cut");
          renderTranscriptLineLabel(line);
        }
      }
    }
  }

}

function updateLatency(data, envelope) {
  const raw =
    data.firstAudioMs ??
    data.first_audio_ms ??
    data.latencyMs ??
    data.latency_ms ??
    data.ms ??
    data.value;
  const latency = Number(raw);
  if (!Number.isFinite(latency)) return;
  state.latencySamples.push(latency);
  if (state.latencySamples.length > 100) state.latencySamples.shift();
  const latencyValue = $("latency-value");
  if (latencyValue) latencyValue.textContent = Math.round(latency) + " ms";
  const lane = envelope.lane || data.lane;
  const latencyDetail = $("latency-detail");
  if (latencyDetail) latencyDetail.textContent = lane ? String(lane).replaceAll("_", " ") : "Latest sample";
}

function updateRoomState(value) {
  const roomState = String(value || "unknown");
  const normal = roomState.toLowerCase();
  const previousStatus = state.roomStatus;
  state.roomStatus = normal;
  $("room-state").textContent = titleCase(roomState);
  const start = $("start-session");
  const pause = $("pause-session");
  const end = $("end-session");
  if (normal === "ended" || normal === "closed" || normal === "failed") {
    start.disabled = true;
    pause.disabled = true;
    end.disabled = true;
    state.eventsClosed = true;
    if (route.role === "participant") {
      $("start-microphone").disabled = true;
      updateParticipantConnection("Session " + normal, false);
      if (state.audio) void stopParticipantAudio(false);
    } else {
      updateGlobalStatus("Session " + normal, false);
    }
  } else if (normal === "closing") {
    start.disabled = true;
    pause.disabled = true;
    end.disabled = true;
    if (route.role === "operator") updateGlobalStatus("Finalizing evidence", true);
  } else if (normal === "active" || normal === "running" || normal === "started") {
    start.disabled = true;
    pause.disabled = false;
    pause.textContent = "Pause";
    end.disabled = false;
    if (route.role === "participant") {
      updateParticipantConnection(state.audio ? "Live" : "Room live", true);
      if (
        state.audio &&
        shouldSendSpeechStartForActiveTransition(previousStatus, normal, state.vadActive)
      ) {
        sendMediaControl("speech_start");
      }
    } else {
      updateGlobalStatus("Session live", true);
    }
  } else if (normal === "paused") {
    start.disabled = true;
    pause.disabled = false;
    pause.textContent = "Resume";
    end.disabled = false;
    if (route.role === "participant" && state.audio && state.vadActive) {
      sendMediaControl("speech_end");
    } else if (route.role === "operator") {
      updateGlobalStatus("Session paused", true);
    }
  } else {
    start.disabled = normal !== "ready" || !operatorStartGateSatisfied();
    pause.disabled = true;
    pause.textContent = "Pause";
    end.disabled = false;
  }
  updateRecorderControls();
}

function operatorStartGateSatisfied() {
  return isOperatorStartGateSatisfied({
    participantConsent: state.participantConsent,
    connected: {
      A: state.participants.has("A"),
      B: state.participants.has("B"),
    },
    recorderArmState: state.recorderArmState,
    recordingArmed: state.recordingArmed,
    participantReadiness: state.evidence.participantReadiness,
    providerReadiness: state.evidence.providerReadiness,
  });
}

function updateRecording(data) {
  const armed = data && data.state === "armed";
  const badge = $("recording-badge");
  if (badge) badge.classList.toggle("is-off", !armed);
  const label = $("recording-label");
  if (label) {
    label.textContent = armed
      ? "Recorder armed"
      : data && data.state === "arming"
        ? "Arming recorder"
        : "Recorder off";
  }
  renderEvidenceRecorderArm(data);
}

function renderEvidenceIdentity(value) {
  if (route.role !== "operator") return;
  const identity = normalizeEvidenceIdentity(value);
  state.evidenceIdentity = identity;
  $("evidence-build-sha256").textContent = identity.deploymentBuildSha256;
  $("evidence-profile-reference").textContent =
    identity.processingProfile.id + "@" + identity.processingProfile.version;
  $("evidence-profile-sha256").textContent = identity.processingProfile.sha256;
  $("evidence-manifest-sha256").textContent = identity.processingManifestSha256;
  $("evidence-services-sha256").textContent = identity.servicesSha256;
}

function renderEvidenceRecorderPreflight(value) {
  if (route.role !== "operator") return;
  const preflight = normalizeRecorderPreflight(value);
  state.evidence.recorderPreflight = preflight;
  if (preflight.status === "failed") {
    $("evidence-recorder-preflight").textContent = "Preflight failed";
    $("evidence-recorder-preflight-detail").textContent = preflight.failureCode.replaceAll("_", " ");
    return;
  }
  $("evidence-recorder-preflight").textContent = "Preflight passed (not armed)";
  $("evidence-recorder-preflight-detail").textContent =
    preflight.tracks.length + " tracks · " + preflight.availableFreeBytes +
    " available / " + preflight.requiredFreeBytes + " required bytes";
}

function renderEvidenceRecorderArm(data) {
  if (route.role !== "operator") return;
  const armState = data && typeof data.state === "string" ? data.state : "unknown";
  const labels = {
    awaiting_consents: "Awaiting consents",
    unarmed: "Unarmed",
    arming: "Arming",
    armed: "Armed",
    failed: "Arm failed",
  };
  if (!Object.hasOwn(labels, armState)) return;
  $("evidence-recorder-arm").textContent = labels[armState];
  const tracks = Array.isArray(data.armedTracks)
    ? data.armedTracks.filter((track) => typeof track === "string")
    : [];
  $("evidence-recorder-arm-detail").textContent = armState === "armed"
    ? (tracks.length ? tracks.join(", ") : "Armed track report pending.")
    : "Recorder arm is separate from preflight.";
}

function finalizationTrackItem(track, digest) {
  const item = document.createElement("article");
  const label = document.createElement("strong");
  label.textContent = track.replaceAll("_", " ");
  const detail = document.createElement("small");
  detail.textContent =
    digest.sha256 + " · " + digest.frameCount + " frames · " + digest.byteCount + " bytes";
  item.append(label, detail);
  return item;
}

function renderEvidenceFinalization(value) {
  if (route.role !== "operator") return;
  const finalization = normalizeEvidenceFinalization(value);
  state.evidence.finalization = finalization;
  const status = $("evidence-finalization-status");
  const detail = $("evidence-finalization-detail");
  const record = $("evidence-finalization-record");
  const tracks = $("evidence-finalization-tracks");
  if (finalization.status === "FINALIZATION_FAILED") {
    status.textContent = "Finalization failed — verdict blocked";
    detail.textContent =
      "Failure code: " + finalization.failureCode + " · Recovery: " + finalization.recovery;
    record.textContent = "No sealed review verdict is available. Follow the bounded recovery route.";
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No sealed track digests after finalization failure.";
    tracks.replaceChildren(empty);
    return;
  }
  status.textContent = "Sealed — review ready";
  detail.textContent = "Verified seal published; the evidence package is ready for operator review.";
  record.textContent =
    "Manifest " + finalization.manifestSha256 + " · Encrypted ledger " +
    finalization.encryptedLedgerSha256 + " · Final chain " + finalization.finalChainSha256 +
    " · Retention deadline " + finalization.retentionDeadlineAt;
  tracks.replaceChildren(
    ...["source_a", "source_b", "playout_to_a", "playout_to_b"].map((track) =>
      finalizationTrackItem(track, finalization.tracks[track]),
    ),
  );
}

function renderEvidenceParticipantReadiness(value) {
  if (route.role !== "operator") return;
  const readiness = normalizeParticipantReadiness(value);
  state.evidence.participantReadiness[readiness.side] = readiness;
  const suffix = readiness.side.toLowerCase();
  const capture = readiness.microphone === "browser_capture_active"
    ? "Browser microphone capture active"
    : readiness.microphone === "stopped"
      ? "Browser microphone capture stopped"
      : "Capture not applicable (fixture)";
  const headphones = readiness.headphones === "self_attested"
    ? "Headphones self-attested (not device-verified)"
    : readiness.headphones === "not_attested"
      ? "Headphones not attested"
      : "Headphones not applicable (fixture)";
  $("evidence-capture-" + suffix).textContent = capture;
  $("evidence-headphones-" + suffix).textContent = headphones;
  updateRecorderControls();
}

function evidenceLane(envelope) {
  const lane = String(envelope && envelope.lane || "");
  return lane === "A_TO_B" || lane === "B_TO_A" ? lane : null;
}

function evidenceLaneLabel(lane) {
  return lane === "A_TO_B" ? "A to B" : lane === "B_TO_A" ? "B to A" : "Unscoped";
}

function renderEvidenceProviderReadiness(envelope, value) {
  if (route.role !== "operator") return;
  const lane = evidenceLane(envelope);
  if (!lane) throw new TypeError("Provider readiness requires an A_TO_B or B_TO_A lane");
  const readiness = normalizeProviderReadiness(value);
  state.evidence.providerReadiness[lane] = readiness;
  const suffix = lane === "A_TO_B" ? "a-to-b" : "b-to-a";
  const labels = {
    local_route_validated: "Local route validated",
    remote_task_ready: "Remote task ready",
    fixture_local: "Fixture-local preparation",
  };
  const details = {
    deferred_until_first_turn: "Remote connection is deferred until the first turn.",
    connected: "Remote task connection is confirmed.",
    not_applicable: "No remote connection applies to this fixture.",
  };
  $("evidence-provider-" + suffix).textContent = labels[readiness.readiness];
  $("evidence-provider-" + suffix + "-detail").textContent =
    details[readiness.remoteConnection];
  updateRecorderControls();
}

function renderEvidenceQueueSample(value) {
  if (route.role !== "operator") return;
  const sample = normalizeQueueSample(value);
  const lane = sample.sourceSide && sample.targetSide
    ? sample.sourceSide + "_TO_" + sample.targetSide
    : sample.side ? "TO_" + sample.side : "unscoped";
  const key = sample.scope + ":" + lane;
  state.evidence.queues.set(key, sample);
  const scope = sample.scope.replaceAll("_", " ");
  const destination = sample.side ? " · Phone " + sample.side : "";
  const age = sample.oldestQueuedAgeMs === undefined
    ? "oldest age not reported"
    : "oldest " + Math.round(sample.oldestQueuedAgeMs) + " ms";
  const buffered = sample.bufferedAudioMs === undefined
    ? "buffered audio not reported"
    : (sample.scope === "browser_playout" ? "browser buffered " : "buffered ") +
      Math.round(sample.bufferedAudioMs) + " ms";
  upsertFeedItem(
    $("evidence-queue-feed"),
    key,
    titleCase(scope) + destination,
    sample.depthFrames + " / " + sample.capacityFrames + " frames · " + age + " · " + buffered,
    sample.depthFrames >= sample.capacityFrames,
  );
}

function renderEvidencePlayoutLag(value, envelope) {
  if (route.role !== "operator") return;
  const lag = normalizePlayoutLag({
    scope: value.scope,
    side: value.side,
    sequence: value.sequence,
    audibleStartLagMs: value.audibleStartLagMs,
    ...(value.turnId === undefined ? {} : { turnId: value.turnId }),
    ...(value.segmentId === undefined ? {} : { segmentId: value.segmentId }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.sourceSide === undefined ? {} : { sourceSide: value.sourceSide }),
    ...(value.targetSide === undefined ? {} : { targetSide: value.targetSide }),
  });
  state.evidence.latestPlayoutLag = lag;
  $("evidence-audible-lag").textContent =
    "Phone " + lag.side + " · sequence " + lag.sequence + " · audible-start acknowledgement " +
    Math.round(lag.audibleStartLagMs) + " ms";
  // A playout-lag event can identify a segment in addition to the generation-wide
  // acknowledgement fields. Only correlated events are allowed to mark a row played.
  markTargetSegmentPlayed(envelope, value);
}

function renderEvidenceBargeLifecycle(value) {
  if (route.role !== "operator") return;
  const lifecycle = normalizeBargeLifecycle(value);
  const stages = state.evidence.bargeStages.get(lifecycle.bargeId) ?? [];
  if (!stages.includes(lifecycle.stage)) stages.push(lifecycle.stage);
  state.evidence.bargeStages.set(lifecycle.bargeId, stages);
  while (state.evidence.bargeStages.size > MAX_BARGE_FEED_ITEMS) {
    const oldest = state.evidence.bargeStages.keys().next().value;
    if (oldest === undefined) break;
    state.evidence.bargeStages.delete(oldest);
  }
  const routeSummary = lifecycle.sourceSide === lifecycle.destinationSide
    ? "Phone " + lifecycle.sourceSide + " · local playout interruption"
    : "Phone " + lifecycle.sourceSide + " → Phone " + lifecycle.destinationSide;
  const summary =
    routeSummary +
    " · barge " + lifecycle.bargeId + " · clear " + lifecycle.clearId +
    " · " + stages.map(titleCase).join(" → ") +
    (lifecycle.message ? " · " + lifecycle.message : "");
  upsertFeedItem(
    $("evidence-barge-feed"),
    lifecycle.bargeId,
    "Barge causal chain",
    summary,
    stages.some((stage) => stage.endsWith("failed")),
  );
}

function renderEvidenceGenerationCut(envelope, data) {
  if (route.role !== "operator" || data.reason !== "barge_in") return;
  if (typeof data.bargeId !== "string" || typeof data.clearId !== "string") return;
  const lane = evidenceLane(envelope);
  const summary =
    evidenceLaneLabel(lane) + " · generation " + String(data.previousGeneration) + " → " +
    String(data.generation) + " · barge " + data.bargeId + " · clear " + data.clearId;
  addFeedItem($("evidence-barge-feed"), "Generation cut", summary, false);
}

function renderEvidenceTerminologyGate(value, envelope) {
  if (route.role !== "operator") return;
  const gate = normalizeTerminologyGate(value);
  state.glossaryHash = gate.glossaryHash;
  const glossaryVersion = typeof value.glossaryVersion === "string" && value.glossaryVersion.trim()
    ? value.glossaryVersion.trim()
    : state.glossaryVersion;
  if (glossaryVersion) state.glossaryVersion = glossaryVersion;
  const facts = [
    gate.entryIds.length ? gate.entryIds.length + " glossary entr" + (gate.entryIds.length === 1 ? "y" : "ies") : "no entry id",
    ...(glossaryVersion ? ["glossary " + glossaryVersion] : []),
    "hash " + gate.glossaryHash,
    ...(gate.termId === undefined ? [] : ["termId " + gate.termId]),
    ...(gate.confidence === undefined ? [] : ["confidence " + Math.round(gate.confidence * 100) + "%"]),
    ...(gate.code === undefined ? [] : [gate.code]),
    ...(gate.message === undefined ? [] : [gate.message]),
  ];
  const direction = gate.sourceSide && gate.targetSide
    ? "Phone " + gate.sourceSide + " → Phone " + gate.targetSide + " · "
    : "";
  addFeedItem(
    $("evidence-terminology-feed"),
    "Terminology " + titleCase(gate.status),
    direction + facts.join(" · "),
    gate.status === "bypassed",
  );
  markTargetSegmentValidated(envelope, value);
}

function renderEvidenceTerminologyAlert(data) {
  if (route.role !== "operator" || !data || typeof data !== "object") return;
  const code = typeof data.code === "string" && data.code.trim() ? data.code.trim() : "Terminology alert";
  const termId = typeof data.termId === "string" && data.termId.trim() ? data.termId.trim() : null;
  const confidence = typeof data.confidence === "number" && Number.isFinite(data.confidence) &&
    data.confidence >= 0 && data.confidence <= 1 ? data.confidence : null;
  const message = typeof data.message === "string" && data.message.trim() ? data.message.trim() : "Review required";
  const facts = [message, ...(termId ? ["termId " + termId] : []), ...(confidence === null ? [] : ["confidence " + Math.round(confidence * 100) + "%"])];
  addFeedItem($("evidence-terminology-feed"), code, facts.join(" · "), true);
}

function renderGlossarySnapshot(value) {
  if (route.role !== "operator" || !value || typeof value !== "object") return;
  const version = typeof value.glossaryVersion === "string" && value.glossaryVersion.trim()
    ? value.glossaryVersion.trim()
    : null;
  const hash = typeof value.glossaryHash === "string" && value.glossaryHash.trim()
    ? value.glossaryHash.trim()
    : null;
  if (!version && !hash) return;
  if (version) state.glossaryVersion = version;
  if (hash) state.glossaryHash = hash;
  const summary = [
    ...(version ? ["version " + version] : []),
    ...(hash ? ["hash " + hash] : []),
  ].join(" · ");
  upsertFeedItem($("evidence-terminology-feed"), "glossary-snapshot", "Glossary snapshot", summary, false);
}

function hydrateEvidenceConsole(value) {
  if (route.role !== "operator" || !value || typeof value !== "object") return;
  renderGlossarySnapshot(value);
  if (value.evidenceIdentity !== undefined) renderEvidenceIdentity(value.evidenceIdentity);
  if (value.recorderPreflight !== undefined) renderEvidenceRecorderPreflight(value.recorderPreflight);
  if (value.evidenceFinalization !== undefined) renderEvidenceFinalization(value.evidenceFinalization);
  if (value.participantReadiness && typeof value.participantReadiness === "object") {
    for (const side of ["A", "B"]) {
      const readiness = value.participantReadiness[side];
      if (readiness !== undefined) renderEvidenceParticipantReadiness({ side, ...readiness });
    }
  }
  if (value.providerReadiness && typeof value.providerReadiness === "object") {
    for (const lane of ["A_TO_B", "B_TO_A"]) {
      const readiness = value.providerReadiness[lane];
      if (readiness !== undefined) renderEvidenceProviderReadiness({ lane }, readiness);
    }
  }
}

function safelyRenderEvidence(label, action) {
  if (route.role !== "operator") return;
  try {
    action();
  } catch (errorValue) {
    addFeedItem(
      $("pipeline-feed"),
      label + " rejected",
      errorValue instanceof Error ? errorValue.message : String(errorValue),
      true,
    );
  }
}

function updateParticipantConsentStatus() {
  if (route.role !== "operator") return;
  const consented = ["A", "B"].filter((side) => state.participantConsent[side]).length;
  $("participant-consent-status").textContent = consented + " / 2 consented";
}

function updateRecorderControls() {
  if (route.role !== "operator") return;
  const bothConsented = state.participantConsent.A && state.participantConsent.B;
  const joined = state.participants.size === 2;
  $("arm-recorder").disabled =
    !bothConsented ||
    !joined ||
    state.recorderArmState !== "unarmed";
  if (state.roomStatus === "ready") {
    $("start-session").disabled = !operatorStartGateSatisfied();
  }
}

function updateParticipantConsentControls() {
  if (route.role !== "participant") return;
  const disclosureReady = state.processingDisclosure !== null;
  const canStart =
    state.participantCanAttemptCapture &&
    disclosureReady &&
    !state.eventsClosed &&
    state.audio === null;
  $("start-microphone").disabled = !canStart;
  $("withdraw-recording-processing-consent").disabled =
    !state.participantConsent[route.side] || state.eventsClosed;
}

function renderParticipantProcessingDisclosure(value) {
  if (route.role !== "participant") return;
  const disclosure = normalizeProcessingDisclosure(value);
  state.processingDisclosure = disclosure;
  $("participant-notice-version").textContent = disclosure.noticeVersion;
  const services = disclosure.services.map((service) =>
    service.provider + " " + service.role.replaceAll("_", " "),
  );
  const dataCategories = disclosure.services.map((service) =>
    service.role.replaceAll("_", " ") + " (" +
    service.dataCategories.map((category) => category.replaceAll("_", " ")).join(", ") + ")",
  );
  $("participant-processing-services").textContent =
    "Configured cloud processing: " + services.join("; ") + ". Data categories by service: " +
    dataCategories.join("; ") + ".";
  $("participant-withdrawal-status").textContent =
    "Recording and transcript processing are required by this notice. Withdrawal ends the session immediately.";
  updateParticipantConsentControls();
}

function endSessionAfterConsentWithdrawal() {
  state.eventsClosed = true;
  updateRoomState("closed");
  if (route.role === "participant") {
    $("participant-withdrawal-status").textContent =
      "Recording and processing consent was withdrawn. This session has ended.";
    updateParticipantConnection("Consent withdrawn — session ended", false);
    updateParticipantConsentControls();
    if (state.audio) void stopParticipantAudio(false);
  } else {
    updateGlobalStatus("Participant consent withdrawn — session ended", false);
  }
}

function handleParticipantCaptions(envelope, type, data) {
  if (route.role !== "participant") return;
  if (type !== "source_segment" && type !== "target_segment") return;
  const sides = eventSides(envelope);
  const update = segmentUpdate(data);
  const generationRef = acceptedSegmentGeneration(envelope);
  const sourceSide = sides.source;
  if (!update || !generationRef || !sourceSide) return;
  const kind = type === "source_segment" ? "source" : "target";
  const result = applySegmentRevision(state.segmentStates[kind][sourceSide], {
    ...update,
    generation: generationRef.generation,
  });
  if (!result.applied) return;

  if (type === "source_segment" && sourceSide === route.side) {
    const caption = $("participant-source-caption");
    if (caption) {
      caption.textContent = update.text;
      caption.dataset.cut = "false";
      caption.classList.toggle("is-cut", false);
    }
  }
  if (type === "target_segment" && sides.target === route.side) {
    const caption = $("participant-target-caption");
    if (caption) {
      caption.textContent = update.text;
      caption.dataset.cut = "false";
      caption.classList.toggle("is-cut", false);
    }
  }
}

function markParticipantTargetCut() {
  if (route.role !== "participant") return;
  const caption = $("participant-target-caption");
  if (!caption) return;
  caption.textContent = "Translation cut/cancelled. Keep speaking normally.";
  caption.dataset.cut = "true";
  caption.classList.toggle("is-cut", true);
}

function handleEvent(envelope) {
  if (!envelope || typeof envelope !== "object") return;
  if (envelope.cursor !== undefined) {
    const cursor = String(envelope.cursor);
    const numericCursor = Number(envelope.cursor);
    if (Number.isSafeInteger(numericCursor) && numericCursor <= state.lastCursor) return;
    if (state.seenCursors.has(cursor)) return;
    state.seenCursors.add(cursor);
    if (Number.isSafeInteger(numericCursor) && numericCursor > state.lastCursor) {
      state.lastCursor = numericCursor;
    }
    if (state.seenCursors.size > 5000) state.seenCursors.clear();
  }

  const type = String(envelope.type || "event");
  const data = envelope.data && typeof envelope.data === "object" ? envelope.data : {};
  const sides = eventSides(envelope);
  const summary = eventSummary(data, envelope);
  const isWarning = type === "error" || type === "terminology_alert";

  if (route.role === "operator" && type !== "source_segment") {
    addFeedItem($("pipeline-feed"), titleCase(type), summary, isWarning);
  }

  if (type === "session_state") {
    safelyRenderEvidence("Evidence snapshot", () => hydrateEvidenceConsole(data));
    if (data.processingDisclosure !== undefined && route.role === "participant") {
      try {
        renderParticipantProcessingDisclosure(data.processingDisclosure);
      } catch (errorValue) {
        state.processingDisclosure = null;
        updateParticipantConsentControls();
        showError($("participant-error"), errorValue);
      }
    }
    updateRoomState(data.state ?? data.status ?? data.value);
    if (route.role === "participant") {
      updateParticipantLiveStatus("Room " + String(data.state ?? data.status ?? "updated") + ".");
    }
  } else if (type === "participant_joined") {
    const side = normaliseSide(data.side || envelope.lane);
    if (side) state.participants.add(side);
    const participantCount = $("participant-count");
    if (participantCount) participantCount.textContent = state.participants.size + " / 2 joined";
    updateRecorderControls();
  } else if (type === "participant_left") {
    const side = normaliseSide(data.side || envelope.lane);
    if (side) state.participants.delete(side);
    const participantCount = $("participant-count");
    if (participantCount) participantCount.textContent = state.participants.size + " / 2 joined";
    updateRecorderControls();
  } else if (type === "participant_consent") {
    const side = normaliseSide(data.side);
    if (side && data.accepted === true && data.recording === true && data.processing === true) {
      state.participantConsent[side] = true;
      updateParticipantConsentStatus();
      updateRecorderControls();
      updateParticipantConsentControls();
    }
  } else if (type === "participant_consent_withdrawal") {
    const side = normaliseSide(data.side);
    if (side) state.participantConsent[side] = false;
    endSessionAfterConsentWithdrawal();
  } else if (type === "recorder_preflight") {
    safelyRenderEvidence("Recorder preflight", () => renderEvidenceRecorderPreflight(data));
  } else if (type === "participant_readiness") {
    safelyRenderEvidence("Participant readiness", () => renderEvidenceParticipantReadiness(data));
  } else if (type === "provider_readiness") {
    safelyRenderEvidence("Provider readiness", () => renderEvidenceProviderReadiness(envelope, data));
  } else if (type === "queue_sample") {
    safelyRenderEvidence("Queue sample", () => renderEvidenceQueueSample(data));
  } else if (type === "playout_lag") {
    safelyRenderEvidence("Playout lag", () => renderEvidencePlayoutLag(data, envelope));
  } else if (type === "audio_playout") {
    updateLatency(data, envelope);
  } else if (type === "barge_lifecycle") {
    safelyRenderEvidence("Barge lifecycle", () => renderEvidenceBargeLifecycle(data));
  } else if (type === "source_segment") {
    if (route.role === "operator") {
      renderTranscriptSegment("source", sides.source, data, envelope);
    }
  } else if (type === "target_segment") {
    if (route.role === "operator") {
      renderTranscriptSegment("target", sides.source, data, envelope);
    }
  } else if (type === "terminology_gate") {
    safelyRenderEvidence("Terminology gate", () => renderEvidenceTerminologyGate(data, envelope));
  } else if (type === "terminology_alert") {
    state.alertCount += 1;
    const alertCount = $("alert-count");
    const alertDetail = $("alert-detail");
    if (alertCount) alertCount.textContent = String(state.alertCount);
    if (alertDetail) alertDetail.textContent = summary || "Review required";
    if (route.role === "operator") {
      addFeedItem($("terminology-feed"), data.term || "Terminology alert", summary, true);
      renderEvidenceTerminologyAlert(data);
    } else {
      updateParticipantLiveStatus(summary || "Terminology needs review.", true);
    }
  } else if (type === "error") {
    if (route.role === "operator" && data.code === "translation_prepare_failed") {
      updateGlobalStatus("Provider preparation failed", false);
    }
    updateParticipantLiveStatus(summary || "The translation service reported an issue.", true);
  } else if (type === "latency") {
    updateLatency(data, envelope);
  } else if (type === "generation_cut") {
    state.cutCount += 1;
    const cutCount = $("cut-count");
    if (cutCount) cutCount.textContent = String(state.cutCount);
    clearSupersededSegments(envelope, data);
    safelyRenderEvidence("Generation cut", () => renderEvidenceGenerationCut(envelope, data));
    if (route.role === "participant" && sides.target === route.side) {
      markParticipantTargetCut();
      updateParticipantLiveStatus("Previous translation was cleared. Keep speaking normally.");
    }
  } else if (type === "recorder_state") {
    state.recorderArmState = typeof data.state === "string" ? data.state : state.recorderArmState;
    state.recordingArmed = data.state === "armed";
    updateRecording(data);
    updateRecorderControls();
  }

  handleParticipantCaptions(envelope, type, data);
}

async function parseEventMessage(message, sourceSocket, eventEpoch, sessionId) {
  try {
    const raw = message instanceof Blob ? await message.text() : String(message);
    if (
      state.eventSocket !== sourceSocket ||
      state.eventEpoch !== eventEpoch ||
      state.eventSessionId !== sessionId
    ) {
      return;
    }
    const envelope = JSON.parse(raw);
    if (!eventBelongsToSession(envelope, sessionId)) return;
    if (state.eventsClosed && !isTerminalEvidenceFinalization(envelope)) return;
    handleEvent(envelope);
  } catch {
    if (
      route.role === "operator" &&
      state.eventSocket === sourceSocket &&
      state.eventEpoch === eventEpoch &&
      state.eventSessionId === sessionId &&
      !state.eventsClosed
    ) {
      addFeedItem($("pipeline-feed"), "Invalid event", "Could not parse server message", true);
    }
  }
}

function connectEventStream(sessionId) {
  if (route.role === "participant" && !state.participantTransportSecure) return;
  clearPendingPlayed();
  if (state.eventSessionId !== null && state.eventSessionId !== sessionId) {
    state.lastCursor = 0;
    state.seenCursors.clear();
    resetSegmentRendering();
  }
  state.eventSessionId = sessionId;
  state.eventsClosed = false;
  const eventEpoch = ++state.eventEpoch;
  if (state.eventReconnectTimer) window.clearTimeout(state.eventReconnectTimer);
  state.eventReconnectTimer = null;
  if (
    state.eventSocket &&
    (state.eventSocket.readyState === WebSocket.OPEN ||
      state.eventSocket.readyState === WebSocket.CONNECTING)
  ) {
    state.eventSocket.close(1000, "Switch session");
  }

  const eventQuery = new URLSearchParams();
  if (state.lastCursor > 0) eventQuery.set("after", String(state.lastCursor));
  if (route.access) eventQuery.set("access", route.access);
  const eventPath =
    "/ws/events/" + encodeURIComponent(sessionId) +
    (eventQuery.size > 0 ? "?" + eventQuery.toString() : "");
  const socket = new WebSocket(websocketUrl(eventPath));
  state.eventSocket = socket;

  socket.addEventListener("open", () => {
    if (
      state.eventSocket !== socket ||
      state.eventEpoch !== eventEpoch ||
      state.eventSessionId !== sessionId
    ) return;
    state.eventAttempts = 0;
    if (route.role === "participant") {
      updateParticipantConnection(state.audio ? "Live" : "Room connected", true);
    } else {
      updateGlobalStatus("Event stream connected", true);
    }
  });

  socket.addEventListener("message", (event) => {
    void parseEventMessage(event.data, socket, eventEpoch, sessionId);
  });

  socket.addEventListener("close", () => {
    if (
      state.eventSocket !== socket ||
      state.eventEpoch !== eventEpoch ||
      state.eventSessionId !== sessionId
    ) return;
    state.eventSocket = null;
    if (state.eventsClosed) return;
    if (route.role === "participant") {
      updateParticipantConnection("Reconnecting", false);
    } else {
      updateGlobalStatus("Event stream reconnecting", false);
    }
    const delay = Math.min(1000 * 2 ** state.eventAttempts, 10000);
    state.eventAttempts += 1;
    state.eventReconnectTimer = window.setTimeout(() => {
      state.eventReconnectTimer = null;
      if (
        state.eventsClosed ||
        state.eventEpoch !== eventEpoch ||
        state.eventSessionId !== sessionId
      ) return;
      connectEventStream(sessionId);
    }, delay);
  });

  socket.addEventListener("error", () => {
    if (
      route.role === "operator" &&
      state.eventSocket === socket &&
      state.eventEpoch === eventEpoch &&
      state.eventSessionId === sessionId &&
      !state.eventsClosed
    ) {
      addFeedItem($("pipeline-feed"), "Connection issue", "Event stream unavailable", true);
    }
  });
}

function updateCreateAvailability() {
  $("create-session").disabled =
    !state.capabilitiesReady ||
    state.dataAdmission !== "approved_poc_content" ||
    $("translation-mode").disabled;
}

function updateDataAdmissionPresentation() {
  if (state.dataAdmission !== "synthetic_only") return;
  const detail = $("translation-mode-detail");
  if (detail) {
    detail.textContent =
      "Synthetic benchmark only: this profile is not approved for human sessions.";
  }
  updateGlobalStatus("Synthetic benchmark only", false);
}

function selectedModeCapability() {
  if (!state.translation) return null;
  const selectedMode = $("translation-mode").value;
  return state.translation.modes.find((capability) =>
    capability.mode === selectedMode,
  ) ?? null;
}

function updateModeDetail() {
  const detail = $("translation-mode-detail");
  const capability = selectedModeCapability();
  if (!capability || !state.translation) {
    detail.textContent = "This server has no selectable translation mode.";
    updateGlossaryControls();
    return;
  }
  const capabilityState = titleCase(capability.state);
  detail.textContent =
    (PROVIDER_LABELS[state.translation.provider] ?? titleCase(state.translation.provider)) +
    " · behavior " + capability.behavior.version + " · " + capabilityState;
  if (capability.reason) detail.textContent += ": " + capability.reason;
  if (capability.deterministicGlossary) {
    detail.textContent += " · pinned glossary supported";
  }
  const unavailable = state.translation.modes
    .filter((mode) => !isSelectableTranslationMode(mode))
    .map((mode) => MODE_LABELS[mode.mode] + " is " + titleCase(mode.state) + ": " + mode.reason);
  if (unavailable.length > 0) detail.textContent += " · " + unavailable.join("; ");
  updateDataAdmissionPresentation();
  updateGlossaryControls();
}

function glossaryImportAllowed() {
  const capability = selectedModeCapability();
  return Boolean(
    capability?.deterministicGlossary === true &&
      capability.state !== "native" &&
      capability.state !== "unsupported",
  );
}

function clearImportedGlossary() {
  state.glossaryVersion = null;
  state.glossaryDirection = null;
  state.glossaryHash = null;
  const status = $("glossary-status");
  if (status) {
    status.textContent = "Not imported";
    status.classList.remove?.("state-pill");
  }
  const file = $("glossary-file");
  if (file) file.value = "";
  const label = $("file-label");
  if (label) label.textContent = "Choose a glossary";
  const drop = $("file-drop");
  if (drop) drop.classList.toggle("has-file", false);
  updateGlossaryControls();
}

function updateGlossaryControls() {
  const allowed = glossaryImportAllowed();
  const file = $("glossary-file");
  const importButton = $("import-glossary");
  const clearButton = $("clear-glossary");
  if (file) file.disabled = !allowed;
  if (importButton) {
    importButton.disabled = !allowed;
    importButton.hidden = !allowed;
  }
  if (clearButton) clearButton.disabled = state.glossaryVersion === null;
  if (!allowed) {
    if (state.glossaryVersion !== null) {
      clearImportedGlossary();
    } else {
      const status = $("glossary-status");
      if (status) {
        status.textContent = "Not imported";
        status.classList.remove?.("state-pill");
      }
      const file = $("glossary-file");
      if (file) file.value = "";
      const label = $("file-label");
      if (label) label.textContent = "Choose a glossary";
      const drop = $("file-drop");
      if (drop) drop.classList.toggle("has-file", false);
    }
  }
}

async function loadCapabilities() {
  const capabilities = await getJson("/api/capabilities");
  state.dataAdmission = normalizeDataAdmission(capabilities.dataAdmission);
  const translation = normalizeTranslationCapabilities(capabilities.translation);
  const selectableModes = translation.modes.filter(isSelectableTranslationMode);
  state.translation = translation;
  const select = $("translation-mode");
  select.replaceChildren();
  for (const capability of selectableModes) {
    const option = document.createElement("option");
    option.value = capability.mode;
    option.textContent = MODE_LABELS[capability.mode];
    select.append(option);
  }
  select.value = translation.defaultMode;
  select.disabled = false;
  $("translation-provider").textContent =
    PROVIDER_LABELS[translation.provider] ?? titleCase(translation.provider);
  updateModeDetail();
  state.capabilitiesReady = true;
  updateCreateAvailability();
  updateGlossaryControls();
}

function currentGlossaryDirection() {
  return $("language-a").value + "->" + $("language-b").value;
}

function invalidateGlossaryIfDirectionChanged() {
  if (
    (state.glossaryVersion === null && state.glossaryHash === null) ||
    state.glossaryDirection === currentGlossaryDirection()
  ) {
    return;
  }
  state.glossaryVersion = null;
  state.glossaryDirection = null;
  state.glossaryHash = null;
  $("glossary-status").textContent = "Re-import required";
  updateGlossaryControls();
}

async function importGlossary(event) {
  event.preventDefault();
  const button = $("import-glossary");
  const error = $("glossary-error");
  clearError(error);
  if (!glossaryImportAllowed()) {
    showError(error, "Choose a glossary-capable translation mode before importing terminology.");
    updateGlossaryControls();
    return;
  }
  const file = $("glossary-file").files[0];
  if (!file) {
    showError(error, "Choose a CSV or XLSX file first.");
    return;
  }

  setLoading(button, true, "Importing...");
  try {
    const upload = glossaryUploadContents(file.name, await file.arrayBuffer());
    const response = await postJson("/api/glossaries", {
      name: $("glossary-name").value.trim(),
      ...upload,
      sourceLanguage: $("language-a").value,
      targetLanguage: $("language-b").value,
      approvedBy: $("glossary-approved-by").value.trim(),
    });
    const version =
      response.glossaryVersion ??
      response.version ??
      response.hash ??
      response.id ??
      (response.glossary &&
        (response.glossary.version || response.glossary.hash || response.glossary.id));
    if (!version) throw new Error("The server did not return a glossary version.");
    state.glossaryVersion = String(version);
    state.glossaryDirection = currentGlossaryDirection();
    $("glossary-status").textContent = "Imported";
    $("glossary-status").classList.add("state-pill");
    updateGlossaryControls();
  } catch (errorValue) {
    showError(error, errorValue);
  } finally {
    setLoading(button, false, "Importing...");
  }
}

function showOperatorSession(snapshot, updateHistory) {
  if (!snapshot || !snapshot.sessionId) {
    throw new Error("The server did not return a session ID.");
  }
  if (
    typeof snapshot.provider !== "string" ||
    !Object.hasOwn(MODE_LABELS, snapshot.translationMode) ||
    !Number.isSafeInteger(snapshot.behaviorVersion) ||
    snapshot.behaviorVersion < 1 ||
    typeof snapshot.deterministicGlossary !== "boolean" ||
    !["native", "locally_controlled", "experimental", "unsupported"].includes(snapshot.translationState) ||
    (["experimental", "unsupported"].includes(snapshot.translationState) &&
      (typeof snapshot.reason !== "string" || snapshot.reason.length === 0))
  ) {
    throw new Error("The server did not return the pinned translation behavior.");
  }
  state.session = snapshot;
  const snapshotGlossaryHash = typeof snapshot.glossaryHash === "string" && snapshot.glossaryHash.trim()
    ? snapshot.glossaryHash.trim()
    : null;
  const snapshotGlossaryVersion = typeof snapshot.glossaryVersion === "string" && snapshot.glossaryVersion.trim()
    ? snapshot.glossaryVersion.trim()
    : null;
  if (snapshotGlossaryHash === null && snapshotGlossaryVersion === null) {
    state.glossaryHash = null;
    state.glossaryVersion = null;
    state.glossaryDirection = null;
  } else {
    state.glossaryHash = snapshotGlossaryHash;
    if (snapshotGlossaryVersion !== null) state.glossaryVersion = snapshotGlossaryVersion;
  }
  try {
    hydrateEvidenceConsole(snapshot);
  } catch (errorValue) {
    throw new Error(
      "The server did not return a safe evidence snapshot: " +
        (errorValue instanceof Error ? errorValue.message : String(errorValue)),
    );
  }
  $("session-id").textContent = snapshot.sessionId;
  const modeLabel = MODE_LABELS[snapshot.translationMode];
  const providerLabel = PROVIDER_LABELS[snapshot.provider] ?? titleCase(snapshot.provider);
  const reason = snapshot.reason ? " · " + snapshot.reason : "";
  const glossary = state.glossaryVersion
    ? " · glossary " + state.glossaryVersion + (state.glossaryHash ? " · hash " + state.glossaryHash : "")
    : state.glossaryHash ? " · glossary hash " + state.glossaryHash : "";
  $("session-translation").textContent =
    "Pinned " + providerLabel + " · " + modeLabel + " · behavior " +
    String(snapshot.behaviorVersion || "unknown") + " · " + titleCase(snapshot.translationState) + reason + glossary;
  state.participantConsent = {
    A: snapshot.participantConsent?.A?.consented === true,
    B: snapshot.participantConsent?.B?.consented === true,
  };
  state.recorderArmState = typeof snapshot.recorderArmState === "string"
    ? snapshot.recorderArmState
    : "awaiting_consents";
  state.recordingArmed = snapshot.recordingArmed === true;
  updateRecording({ state: state.recorderArmState });
  updateParticipantConsentStatus();
  renderJoinCards(Array.isArray(snapshot.endpointGrants) ? snapshot.endpointGrants : []);
  $("setup-section").hidden = true;
  $("operator-dashboard").hidden = false;
  updateRoomState(snapshot.state || "created");
  updateRecorderControls();
  connectEventStream(snapshot.sessionId);
  if (updateHistory) {
    window.history.replaceState(
      {},
      "",
      "?sessionId=" + encodeURIComponent(snapshot.sessionId) + window.location.hash,
    );
  }
  $("operator-dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function createSession(event) {
  event.preventDefault();
  const button = $("create-session");
  const error = $("session-form-error");
  clearError(error);

  if (!state.capabilitiesReady) {
    showError(error, "Wait for the Harness configuration check to complete.");
    return;
  }
  if (state.dataAdmission !== "approved_poc_content") {
    showError(
      error,
      "Synthetic benchmark only: this profile is not approved for human sessions.",
    );
    updateCreateAvailability();
    return;
  }
  if ($("language-a").value === $("language-b").value) {
    showError(error, "Choose two different spoken languages.");
    return;
  }
  const translationMode = selectedModeCapability();
  if (!translationMode) {
    showError(error, "Choose one of the modes advertised by this server.");
    return;
  }
  if (state.glossaryVersion !== null && !translationMode.deterministicGlossary) {
    showError(
      error,
      "The selected mode cannot guarantee a pinned glossary. Choose a glossary-capable mode or remove the glossary.",
    );
    return;
  }

  setLoading(button, true, "Creating...");
  try {
    const response = await postJson("/api/sessions", {
      languages: {
        A: $("language-a").value,
        B: $("language-b").value,
      },
      translationMode: translationMode.mode,
      glossaryVersion: state.glossaryVersion || undefined,
    });
    const snapshot = response.session || response;
    showOperatorSession(snapshot, true);
  } catch (errorValue) {
    showError(error, errorValue);
    setLoading(button, false, "Creating...");
  }
}

async function sendSessionCommand(kind) {
  if (!state.session) return;
  const buttons = {
    arm_recorder: $("arm-recorder"),
    start: $("start-session"),
    pause: $("pause-session"),
    resume: $("pause-session"),
    end: $("end-session"),
  };
  const loadingLabels = {
    arm_recorder: "Arming recorder...",
    start: "Starting...",
    pause: "Pausing...",
    resume: "Resuming...",
    end: "Ending...",
  };
  const button = buttons[kind];
  button.dataset.label = button.textContent.trim();
  setLoading(button, true, loadingLabels[kind]);
  try {
    await postJson(
      "/api/sessions/" + encodeURIComponent(state.session.sessionId) + "/commands",
      { kind, commandId: uniqueId() },
    );
    setLoading(button, false, "");
    if (kind === "start" || kind === "resume") updateRoomState("active");
    if (kind === "pause") updateRoomState("paused");
    if (kind === "end") updateGlobalStatus("Finalizing evidence", true);
  } catch (errorValue) {
    addFeedItem($("pipeline-feed"), "Command failed", errorValue.message, true);
    setLoading(button, false, "");
  }
}

async function initialiseOperator() {
  $("operator-view").hidden = false;
  $("participant-view").hidden = true;
  updateGlossaryControls();
  $("glossary-form").addEventListener("submit", importGlossary);
  $("clear-glossary").addEventListener("click", clearImportedGlossary);
  $("session-form").addEventListener("submit", createSession);
  $("arm-recorder").addEventListener("click", () => void sendSessionCommand("arm_recorder"));
  $("start-session").addEventListener("click", () => void sendSessionCommand("start"));
  $("pause-session").addEventListener("click", () => {
    void sendSessionCommand(state.roomStatus === "paused" ? "resume" : "pause");
  });
  $("end-session").addEventListener("click", () => void sendSessionCommand("end"));
  $("clear-events").addEventListener("click", () => {
    $("pipeline-feed").replaceChildren();
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "The event stream will appear here.";
    $("pipeline-feed").append(empty);
  });

  $("translation-mode").addEventListener("change", updateModeDetail);
  $("language-a").addEventListener("change", invalidateGlossaryIfDirectionChanged);
  $("language-b").addEventListener("change", invalidateGlossaryIfDirectionChanged);

  $("glossary-file").addEventListener("change", (event) => {
    const file = event.currentTarget.files[0];
    $("file-label").textContent = file ? file.name : "Choose a glossary";
    $("file-drop").classList.toggle("has-file", Boolean(file));
  });

  try {
    if (route.sessionId) {
      const recovered = await getJson(
        "/api/sessions/" + encodeURIComponent(route.sessionId),
      );
      showOperatorSession(recovered, false);
      updateGlobalStatus("Session recovered", true);
      return;
    }
    await loadCapabilities();
    if (state.dataAdmission === "synthetic_only") {
      updateDataAdmissionPresentation();
    } else {
      updateGlobalStatus("Harness ready", true);
    }
  } catch (error) {
    state.capabilitiesReady = false;
    updateCreateAvailability();
    showError($("session-form-error"), error);
    updateGlobalStatus("Harness configuration error", false);
  }
}

function participantPlayoutLane() {
  return route.side === "A" ? "B_TO_A" : "A_TO_B";
}

function isOpenMediaSocket(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function sendMediaPayload(payload, socket = currentMediaSocket()) {
  if (!isOpenMediaSocket(socket)) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function rememberTerminalClearReceipt(audio, clearId, pending) {
  const retained = retainTerminalClearReceipts(
    Array.from(audio.terminalClearReceipts.values(), (receipt) => ({
      lane: receipt.lane,
      generation: receipt.generation,
      clearId: receipt.clearId,
    })),
    { lane: pending.lane, generation: pending.generation, clearId },
  );
  const retainedIds = new Set(retained.map((receipt) => receipt.clearId));
  audio.pendingClears.delete(clearId);
  audio.terminalClearReceipts.delete(clearId);
  audio.terminalClearReceipts.set(clearId, {
    lane: pending.lane,
    generation: pending.generation,
    clearId,
    deliverySocket: pending.deliverySocket,
  });
  for (const terminalClearId of audio.terminalClearReceipts.keys()) {
    if (!retainedIds.has(terminalClearId)) {
      audio.terminalClearReceipts.delete(terminalClearId);
    }
  }
}

function retainOutstandingClearRequest(audio, clearId, pending) {
  const retained = retainOutstandingClearRequests(
    Array.from(audio.pendingClears, ([pendingClearId, value]) => ({
      lane: value.lane,
      generation: value.generation,
      clearId: pendingClearId,
    })),
    { lane: pending.lane, generation: pending.generation, clearId },
    MAX_OUTSTANDING_CLEAR_REQUESTS,
  );
  const previous = new Map(audio.pendingClears);
  audio.pendingClears.clear();
  for (const request of retained) {
    const retainedPending = request.clearId === clearId
      ? pending
      : previous.get(request.clearId);
    if (retainedPending) audio.pendingClears.set(request.clearId, retainedPending);
  }
}

function sendParticipantReadiness(audio, socket = currentMediaSocket()) {
  if (
    state.audio !== audio ||
    state.mediaEpoch !== audio.epoch ||
    !audio.captureReady ||
    audio.context.state !== "running" ||
    !isOpenMediaSocket(socket) ||
    audio.readinessSockets.has(socket)
  ) {
    return;
  }
  if (sendMediaPayload({
    type: "participant_readiness",
    microphone: "browser_capture_active",
    headphones: "self_attested",
    source: "participant_browser_self_report",
  }, socket)) {
    audio.stoppedReadinessSockets.delete(socket);
    audio.readinessSockets.add(socket);
  }
}

function sendParticipantStoppedReadiness(audio, socket = currentMediaSocket()) {
  if (
    state.audio !== audio ||
    state.mediaEpoch !== audio.epoch ||
    !isOpenMediaSocket(socket) ||
    audio.stoppedReadinessSockets.has(socket)
  ) return;
  audio.readinessSockets.delete(socket);
  if (sendMediaPayload({
    type: "participant_readiness",
    microphone: "stopped",
    headphones: "not_attested",
    source: "participant_browser_self_report",
  }, socket)) {
    audio.stoppedReadinessSockets.add(socket);
  }
}

function updateParticipantCaptureReadiness(audio, active, status) {
  if (state.audio !== audio || state.mediaEpoch !== audio.epoch) return;
  const track = audio.stream.getAudioTracks?.()[0];
  const trackLive = !track || (track.readyState === "live" && track.muted !== true);
  const running = audio.context.state === "running";
  const ready = active && running && trackLive;
  audio.captureReady = ready;
  if (ready) {
    sendParticipantReadiness(audio);
    const connected = isOpenMediaSocket(currentMediaSocket());
    updateParticipantConnection(connected ? "Live" : "Audio reconnecting", connected);
  } else {
    if (state.vadActive) {
      state.vadActive = false;
      sendMediaControl("speech_end");
    }
    sendParticipantStoppedReadiness(audio);
    updateParticipantConnection(status || "Microphone stopped", false);
  }
}

function installParticipantReadinessListeners(audio) {
  for (const track of audio.stream.getAudioTracks?.() ?? []) {
    track.addEventListener?.("ended", () => {
      updateParticipantCaptureReadiness(audio, false, "Microphone stopped");
    });
    track.addEventListener?.("mute", () => {
      updateParticipantCaptureReadiness(audio, false, "Microphone muted");
    });
    track.addEventListener?.("unmute", () => {
      updateParticipantCaptureReadiness(audio, true, "Live");
    });
  }
  audio.context.addEventListener?.("statechange", () => {
    updateParticipantCaptureReadiness(
      audio,
      audio.context.state === "running",
      audio.context.state === "running" ? "Live" : "Audio paused",
    );
  });
}

function clearParticipantPlayout(lane, generation, clearId, label, deliverySocket) {
  const audio = state.audio;
  const socket = deliverySocket ?? currentMediaSocket();
  if (
    !audio ||
    audio.socketSupervisor.socket !== socket ||
    !isOpenMediaSocket(socket) ||
    lane !== participantPlayoutLane() ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof clearId !== "string" ||
    clearId.trim().length === 0 ||
    clearId.length > 256
  ) {
    return;
  }
  const existing = audio.pendingClears.get(clearId);
  if (existing) {
    if (existing.lane !== lane || existing.generation !== generation) return;
  } else {
    const terminal = audio.terminalClearReceipts.get(clearId);
    if (terminal) {
      if (terminal.lane !== lane || terminal.generation !== generation) return;
      if (terminal.deliverySocket === socket) return;
      audio.terminalClearReceipts.delete(clearId);
    }
  }
  const alreadyDeliveredToSocket = existing?.deliverySocket === socket;
  const pending = existing ?? { lane, generation, deliverySocket: socket };
  pending.deliverySocket = socket;
  retainOutstandingClearRequest(audio, clearId, pending);
  if (alreadyDeliveredToSocket) return;
  audio.playoutNode.port.postMessage({ type: "clear", lane, generation, clearId });
  $("playback-label").textContent = label;
}

function forwardPlayoutWorkletMessage(audio, message) {
  if (
    state.audio !== audio ||
    state.mediaEpoch !== audio.epoch ||
    !message ||
    typeof message !== "object"
  ) return;
  if (message.type === "clear_applied") {
    const clearId = message.clearId;
    const pending = typeof clearId === "string" ? audio.pendingClears.get(clearId) : undefined;
    if (
      !pending ||
      message.lane !== pending.lane ||
      message.generation !== pending.generation
    ) {
      return;
    }
    const socket = currentMediaSocket();
    if (socket !== pending.deliverySocket) return;
    if (sendMediaPayload({
      type: "clear_applied",
      lane: pending.lane,
      generation: pending.generation,
      clearId,
    }, socket)) {
      rememberTerminalClearReceipt(audio, clearId, pending);
    }
    return;
  }
  if (message.type === "queue_sample") {
    const lane = message.lane;
    const generation = message.generation;
    if (
      lane !== participantPlayoutLane() ||
      !Number.isSafeInteger(generation) ||
      generation < 0
    ) {
      return;
    }
    try {
      const sample = normalizeQueueSample({
        scope: "browser_playout",
        side: route.side,
        depthFrames: message.depthFrames,
        capacityFrames: message.capacityFrames,
        bufferedAudioMs: message.bufferedAudioMs,
        ...(message.oldestQueuedAgeMs === undefined
          ? {}
          : { oldestQueuedAgeMs: message.oldestQueuedAgeMs }),
      });
      sendMediaPayload({
        type: "queue_sample",
        lane,
        generation,
        depthFrames: sample.depthFrames,
        capacityFrames: sample.capacityFrames,
        bufferedAudioMs: sample.bufferedAudioMs,
        ...(sample.oldestQueuedAgeMs === undefined
          ? {}
          : { oldestQueuedAgeMs: sample.oldestQueuedAgeMs }),
      });
    } catch {
      // Local worklet telemetry is discarded if it does not meet the browser protocol.
    }
    return;
  }
  if (
    !["playout_started", "playout_dropped"].includes(message.type) ||
    !Number.isSafeInteger(message.generation) ||
    !Number.isSafeInteger(message.sequence)
  ) {
    return;
  }
  sendMediaPayload({
    type: message.type,
    generation: message.generation,
    sequence: message.sequence,
  });
}

async function handleMediaMessage(message, sourceSocket) {
  const audio = state.audio;
  const epoch = audio?.epoch;
  if (
    !audio ||
    !Number.isSafeInteger(epoch) ||
    state.mediaEpoch !== epoch ||
    audio.socketSupervisor.socket !== sourceSocket ||
    !isOpenMediaSocket(sourceSocket)
  ) return;
  if (typeof message === "string") {
    try {
      const control = JSON.parse(message);
      if (control.type === "clear") {
        const lane = control.lane;
        const generation = Number(control.generation);
        const clearId = control.clearId;
        clearParticipantPlayout(lane, generation, clearId, "Audio queue cleared", sourceSocket);
      }
    } catch {
      showError($("participant-error"), "Received an invalid media control message.");
    }
    return;
  }

  const buffer = message instanceof Blob ? await message.arrayBuffer() : message;
  if (
    state.audio !== audio ||
    state.mediaEpoch !== epoch ||
    audio.socketSupervisor.socket !== sourceSocket ||
    !isOpenMediaSocket(sourceSocket) ||
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 8
  ) return;
  const view = new DataView(buffer);
  const generation = view.getUint32(0, true);
  const sequence = view.getUint32(4, true);
  const count = Math.floor((buffer.byteLength - 8) / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(8 + index * 2, true) / 32768;
  }
  if (
    state.audio !== audio ||
    state.mediaEpoch !== epoch ||
    audio.socketSupervisor.socket !== sourceSocket ||
    !isOpenMediaSocket(sourceSocket)
  ) return;
  audio.playoutNode.port.postMessage(
    { type: "push", lane: participantPlayoutLane(), generation, sequence, samples },
    [samples.buffer],
  );
  $("playback-label").textContent = "Playing AI voice - generation " + generation;
}

function openMediaSocket(sessionId, side) {
  if (route.role === "participant" && !state.participantTransportSecure) {
    return Promise.reject(new Error("Participant media requires a secure connection."));
  }
  return new Promise((resolve, reject) => {
    const mediaQuery = new URLSearchParams();
    if (route.access) mediaQuery.set("access", route.access);
    const socket = new WebSocket(
      websocketUrl(
        "/ws/media/" + encodeURIComponent(sessionId) + "/" + encodeURIComponent(side) +
          (mediaQuery.size > 0 ? "?" + mediaQuery.toString() : ""),
      ),
    );
    socket.binaryType = "arraybuffer";
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error("Timed out while connecting live audio."));
    }, 10000);

    socket.addEventListener("open", () => {
      window.clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Could not connect the live audio channel."));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      void handleMediaMessage(event.data, socket);
    });
  });
}

function currentMediaSocket() {
  return state.audio ? state.audio.socketSupervisor.socket : null;
}

async function requestParticipantWakeLock(audio) {
  if (
    !navigator.wakeLock ||
    typeof navigator.wakeLock.request !== "function" ||
    document.visibilityState === "hidden" ||
    audio.wakeLock
  ) return;
  try {
    const sentinel = await navigator.wakeLock.request("screen");
    if (state.audio !== audio) {
      await sentinel.release();
      return;
    }
    audio.wakeLock = sentinel;
    sentinel.addEventListener("release", () => {
      if (audio.wakeLock === sentinel) audio.wakeLock = null;
    }, { once: true });
  } catch {
    // Wake Lock is optional and may be denied by device power policy.
  }
}

async function releaseParticipantWakeLock(audio) {
  const sentinel = audio.wakeLock;
  audio.wakeLock = null;
  if (sentinel) await sentinel.release().catch(() => {});
}

function sendMediaControl(type) {
  sendMediaPayload({ type });
}

async function stopParticipantAudio(reportStopped) {
  const audio = state.audio;
  if (audio) sendParticipantStoppedReadiness(audio, audio.socketSupervisor.socket);
  state.mediaEpoch += 1;
  state.audio = null;
  if (!audio) {
    updateParticipantConsentControls();
    return;
  }

  const socket = audio.socketSupervisor.socket;
  if (state.vadActive && socket && socket.readyState === WebSocket.OPEN) {
    sendMediaPayload({ type: "speech_end" }, socket);
  }
  state.vadActive = false;
  state.capturePreroll = [];
  state.captureBackpressureAlerted = false;
  try {
    audio.socketSupervisor.stop(1000, "Microphone stopped");
  } catch {
    // A close race must not prevent local capture resources from being released.
  }
  try {
    await releaseParticipantWakeLock(audio);
  } catch {
    // Wake-lock release is best effort during teardown.
  }
  try {
    for (const track of audio.stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Continue releasing the remaining tracks.
      }
    }
  } catch {
    // Continue tearing down graph resources if the stream has already failed.
  }
  for (const node of [audio.captureNode, audio.source, audio.playoutNode, audio.silentGain]) {
    try {
      node.disconnect();
    } catch {
      // A node may already be disconnected by the browser.
    }
  }
  try {
    await audio.context.close();
  } catch {
    // Context closure is best effort after the graph is disconnected.
  }

  $("call-live").hidden = true;
  $("call-idle").hidden = false;
  $("audio-meter").style.height = "0%";
  if (reportStopped) {
    updateParticipantConnection(
      state.eventSocket && state.eventSocket.readyState === WebSocket.OPEN
        ? "Room connected"
        : "Offline",
      Boolean(state.eventSocket && state.eventSocket.readyState === WebSocket.OPEN),
    );
  }
  updateParticipantConsentControls();
}

async function withdrawParticipantRecordingProcessingConsent() {
  const button = $("withdraw-recording-processing-consent");
  const error = $("participant-error");
  clearError(error);
  if (!route.sessionId || !route.access) {
    showError(error, "This participant link is missing the session access needed to withdraw consent.");
    return;
  }
  if (!state.participantConsent[route.side]) {
    showError(error, "Recording and processing consent is not active for this participant.");
    return;
  }

  setLoading(button, true, "Withdrawing consent...");
  try {
    await postJson(
      "/api/sessions/" + encodeURIComponent(route.sessionId) +
        "/participants/" + encodeURIComponent(route.side) +
        "/recording-processing-withdrawal",
      { withdrawalId: participantWithdrawalId() },
    );
    state.participantConsent[route.side] = false;
    endSessionAfterConsentWithdrawal();
  } catch (errorValue) {
    showError(error, errorValue);
  } finally {
    setLoading(button, false, "Withdrawing consent...");
    updateParticipantConsentControls();
  }
}

async function startParticipantAudio() {
  const button = $("start-microphone");
  const error = $("participant-error");
  clearError(error);

  if (!state.participantCanAttemptCapture) {
    showError(error, "Participant audio requires a secure connection and supported browser.");
    return;
  }
  if (!state.processingDisclosure) {
    showError(error, "Wait for the recording and processing disclosure before starting your microphone.");
    return;
  }
  if (!$("headphones-confirmed").checked) {
    showError(error, "Confirm that you are wearing headphones before starting.");
    return;
  }
  if (!$("recording-processing-consent").checked) {
    showError(error, "Accept recording and processing before starting your microphone.");
    return;
  }
  if (!route.sessionId || !route.access) {
    showError(
      error,
      !route.sessionId
        ? "This participant link is missing a session ID."
        : "This participant link is missing its access grant.",
    );
    return;
  }

  setLoading(button, true, "Requesting microphone...");
  let stream;
  let context;
  let socketSupervisor;
  let participantAudio;
  try {
    setLoading(button, true, "Confirming consent...");
    await postJson(
      "/api/sessions/" + encodeURIComponent(route.sessionId) +
        "/participants/" + encodeURIComponent(route.side) +
        "/recording-processing-consent",
      { accepted: true, consentId: participantConsentId() },
    );
    state.participantConsent[route.side] = true;
    updateParticipantConsentControls();
    setLoading(button, true, "Requesting microphone...");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("This browser does not support microphone capture.");
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    setPreflight("check-mic", true);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    context = new AudioContextClass({ latencyHint: "interactive" });
    await Promise.all([
      context.audioWorklet.addModule(
        new URL("./public/capture-worklet.js", import.meta.url),
      ),
      context.audioWorklet.addModule(
        new URL("./public/playout-worklet.js", import.meta.url),
      ),
    ]);

    socketSupervisor = new MediaSocketSupervisor({
      connect: () => openMediaSocket(route.sessionId, route.side),
      onOpen: (connectedSocket, detail) => {
        if (!participantAudio) return;
        if (state.audio !== participantAudio) {
          connectedSocket.close(1000, "Audio session replaced");
          return;
        }
        state.captureBackpressureAlerted = false;
        clearError(error);
        if (state.vadActive && connectedSocket.readyState === WebSocket.OPEN) {
          connectedSocket.send(JSON.stringify({ type: "speech_start" }));
        }
        if (participantAudio.captureReady) {
          sendParticipantReadiness(participantAudio, connectedSocket);
        } else {
          sendParticipantStoppedReadiness(participantAudio, connectedSocket);
        }
        updateParticipantConnection(detail.reconnected ? "Live - reconnected" : "Live", true);
      },
      onDisconnect: () => {
        if (state.audio === participantAudio) {
          updateParticipantConnection("Audio reconnecting", false);
        }
      },
      onRetry: (_connectionError, delayMs) => {
        if (state.audio === participantAudio) {
          updateParticipantConnection("Retrying audio in " + Math.ceil(delayMs / 1000) + "s", false);
        }
      },
    });
    await socketSupervisor.start();
    const captureNode = new AudioWorkletNode(context, "relay-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        inputSampleRate: context.sampleRate,
        targetSampleRate: 24000,
        frameSamples: 480,
      },
    });
    const playoutNode = new AudioWorkletNode(context, "relay-pcm-playout", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceSampleRate: 24000 },
    });
    const source = context.createMediaStreamSource(stream);
    const silentGain = context.createGain();
    silentGain.gain.value = 0;

    source.connect(captureNode);
    captureNode.connect(silentGain);
    silentGain.connect(context.destination);
    playoutNode.connect(context.destination);

    const epoch = ++state.mediaEpoch;
    participantAudio = {
      epoch,
      context,
      stream,
      socketSupervisor,
      source,
      captureNode,
      playoutNode,
      silentGain,
      wakeLock: null,
      captureReady: false,
      readinessSockets: new WeakSet(),
      stoppedReadinessSockets: new WeakSet(),
      pendingClears: new Map(),
      terminalClearReceipts: new Map(),
    };
    state.audio = participantAudio;
    installParticipantReadinessListeners(participantAudio);

    state.capturePreroll = [];
    const sendPcmFrame = (pcm) => {
      const socket = currentMediaSocket();
      if (state.audio !== participantAudio || !participantAudio.captureReady) return;
      if (!socket || socket.readyState !== WebSocket.OPEN || !(pcm instanceof ArrayBuffer)) return;
      if (socket.bufferedAmount <= 24 * 1024) {
        socket.send(pcm);
        if (state.captureBackpressureAlerted) {
          state.captureBackpressureAlerted = false;
          clearError(error);
          updateParticipantConnection("Live", true);
        }
      } else if (!state.captureBackpressureAlerted) {
        state.captureBackpressureAlerted = true;
        showError(error, "Network congestion detected; stale microphone frames are being dropped.");
        updateParticipantConnection("Network congested", false);
      }
    };

    captureNode.port.addEventListener("message", (event) => {
      const message = event.data;
      if (state.audio !== participantAudio || !participantAudio.captureReady) return;
      if (message.type === "frame") {
        const level = Math.min(100, Math.max(2, Number(message.rms || 0) * 500));
        $("audio-meter").style.height = level + "%";
        if (!state.vadActive) {
          if (message.pcm instanceof ArrayBuffer) {
            state.capturePreroll.push(message.pcm);
            if (state.capturePreroll.length > 8) state.capturePreroll.shift();
          }
          return;
        }
        sendPcmFrame(message.pcm);
      } else if (message.type === "vad") {
        const active = Boolean(message.active);
        if (active === state.vadActive) return;
        state.vadActive = active;
        sendMediaControl(active ? "speech_start" : "speech_end");
        if (active) {
          const preroll = state.capturePreroll.splice(0);
          for (const frame of preroll) sendPcmFrame(frame);
        }
      }
    });
    captureNode.port.start();

    playoutNode.port.addEventListener("message", (event) => {
      const message = event.data || {};
      forwardPlayoutWorkletMessage(participantAudio, message);
    });
    playoutNode.port.start();

    await context.resume();
    updateParticipantCaptureReadiness(participantAudio, true, "Live");
    await requestParticipantWakeLock(participantAudio);
    setLoading(button, false, "");
    $("call-idle").hidden = true;
    $("call-live").hidden = false;
    const connected = Boolean(
      socketSupervisor.socket && socketSupervisor.socket.readyState === WebSocket.OPEN,
    );
    updateParticipantConnection(connected ? "Live" : "Audio reconnecting", connected);
  } catch (errorValue) {
    state.audio = null;
    if (socketSupervisor) socketSupervisor.stop();
    if (participantAudio) await releaseParticipantWakeLock(participantAudio);
    if (stream) stream.getTracks().forEach((track) => track.stop());
    if (context) await context.close().catch(() => {});
    setPreflight("check-mic", false);
    showError(error, errorValue);
    setLoading(button, false, "Requesting microphone...");
    updateParticipantConsentControls();
  }
}

async function initialiseParticipant() {
  $("operator-view").hidden = true;
  $("participant-view").hidden = false;
  $("participant-side").textContent = route.side;
  document.title = "Phone " + route.side + " - Relay";

  const secure = isParticipantTransportSecure();
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioSupported = Boolean(
    AudioContextClass &&
      window.AudioWorkletNode &&
      window.WebSocket &&
      navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia,
  );
  state.participantCanAttemptCapture = Boolean(
    secure && audioSupported && route.sessionId && route.access,
  );
  state.participantTransportSecure = secure;
  setPreflight("check-secure", secure);
  setPreflight("check-audio", audioSupported);
  setPreflight("check-mic", null);

  if (!secure) {
    showError(
      $("participant-error"),
      "This participant link requires HTTPS outside local loopback.",
    );
    $("start-microphone").disabled = true;
    updateParticipantConnection("Secure connection required", false);
    updateParticipantConsentControls();
    return;
  }

  if (navigator.permissions && navigator.permissions.query) {
    try {
      const permission = await navigator.permissions.query({ name: "microphone" });
      if (permission.state === "granted") setPreflight("check-mic", true);
      if (permission.state === "denied") setPreflight("check-mic", false);
      permission.addEventListener("change", () => {
        setPreflight(
          "check-mic",
          permission.state === "prompt" ? null : permission.state === "granted",
        );
      });
    } catch {
      setPreflight("check-mic", null);
    }
  }

  if (!route.sessionId || !route.access) {
    showError(
      $("participant-error"),
      !route.sessionId
        ? "This participant link is missing a session ID."
        : "This participant link is missing its access grant.",
    );
    $("start-microphone").disabled = true;
    updateParticipantConnection("Invalid link", false);
  } else {
    connectEventStream(route.sessionId);
  }
  if (!audioSupported) {
    showError(
      $("participant-error"),
      "Use a current Chrome, Edge, or Safari browser for live audio.",
    );
    $("start-microphone").disabled = true;
  }
  updateParticipantConsentControls();

  $("start-microphone").addEventListener("click", () => void startParticipantAudio());
  $("stop-microphone").addEventListener("click", () => void stopParticipantAudio(true));
  $("withdraw-recording-processing-consent").addEventListener(
    "click",
    () => void withdrawParticipantRecordingProcessingConsent(),
  );
}

document.addEventListener("visibilitychange", () => {
  const audio = state.audio;
  if (route.role !== "participant" || !audio || document.visibilityState !== "visible") {
    return;
  }
  void audio.context.resume().catch(() => {});
  void requestParticipantWakeLock(audio);
});

window.addEventListener("beforeunload", () => {
  state.eventsClosed = true;
  if (state.eventReconnectTimer) window.clearTimeout(state.eventReconnectTimer);
  if (state.eventSocket) state.eventSocket.close();
  if (state.audio) {
    const audio = state.audio;
    sendParticipantStoppedReadiness(audio, audio.socketSupervisor.socket);
    state.mediaEpoch += 1;
    state.audio = null;
    audio.socketSupervisor.stop(1000, "Page closed");
    audio.stream.getTracks().forEach((track) => track.stop());
    if (audio.wakeLock) void audio.wakeLock.release().catch(() => {});
  }
});

if (route.role === "participant") {
  void initialiseParticipant();
} else {
  void initialiseOperator();
}

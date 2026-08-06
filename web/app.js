import {
  endpointGrantPresentation,
  glossaryUploadContents,
} from "./public/browser-contract.js";
import { MediaSocketSupervisor } from "./public/media-socket-supervisor.js";

const $ = (id) => document.getElementById(id);

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
  capabilitiesReady: false,
  session: null,
  roomStatus: "waiting",
  eventSocket: null,
  eventSessionId: null,
  eventReconnectTimer: null,
  eventAttempts: 0,
  eventsClosed: false,
  lastCursor: 0,
  seenCursors: new Set(),
  participants: new Set(),
  partialLines: { A: null, B: null },
  targetLines: { A: null, B: null },
  lastLines: { A: null, B: null },
  latencySamples: [],
  cutCount: 0,
  alertCount: 0,
  audio: null,
  vadActive: false,
  captureBackpressureAlerted: false,
  capturePreroll: [],
  pendingMediaMessages: [],
};

const PROFILE_LABELS = {
  glossary_controlled: "Glossary controlled",
  local_eval: "Local glossary evaluation",
  native_live_baseline: "Native live baseline",
  deterministic_test: "Deterministic test",
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

function appendSourceTranscript(side, text, partial, generation) {
  if (!side || !text) return;
  const container = $("transcript-" + side.toLowerCase());
  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  let line = state.partialLines[side];
  const generationKey = String(generation ?? "");
  if (line && line.dataset.generation !== generationKey) line = null;
  if (!line) {
    line = document.createElement("article");
    line.className = "transcript-line";
    line.dataset.generation = generationKey;
    const source = document.createElement("p");
    source.className = "source";
    const label = document.createElement("small");
    label.textContent = "Phone " + side + (partial ? " - hearing" : " - source");
    line.append(source, label);
    container.append(line);
  }

  line.querySelector(".source").textContent = text;
  line.classList.toggle("is-partial", partial);
  line.querySelector("small").textContent =
    "Phone " + side + (partial ? " - hearing" : " - source");

  if (partial) {
    state.partialLines[side] = line;
  } else {
    state.partialLines[side] = null;
    state.lastLines[side] = line;
  }
  container.scrollTop = container.scrollHeight;
}

function appendTargetTranscript(sourceSide, text, validated, final, generation) {
  if (!sourceSide || !text) return;
  const container = $("transcript-" + sourceSide.toLowerCase());
  const empty = container.querySelector(".empty-state");
  if (empty) empty.remove();

  const generationKey = String(generation ?? "");
  const candidates = [
    state.targetLines[sourceSide],
    state.partialLines[sourceSide],
    state.lastLines[sourceSide],
  ];
  let line = candidates.find(
    (candidate) => candidate && candidate.dataset.generation === generationKey,
  );
  if (!line) {
    line = document.createElement("article");
    line.className = "transcript-line";
    line.dataset.generation = generationKey;
    const placeholder = document.createElement("p");
    placeholder.className = "source";
    placeholder.textContent = "Translation";
    const label = document.createElement("small");
    label.textContent = "Phone " + sourceSide + " lane";
    line.append(placeholder, label);
    container.append(line);
  }

  let translated = line.querySelector(".translation");
  if (!translated) {
    translated = document.createElement("p");
    translated.className = "translation";
    line.append(translated);
  }
  translated.textContent = text;
  line.dataset.target = text;
  if (validated) line.dataset.validated = "true";
  const isValidated = line.dataset.validated === "true";
  line.querySelector("small").textContent =
    "Phone " + sourceSide + " - AI translation" + (isValidated ? " - validated" : "");
  state.lastLines[sourceSide] = line;
  state.targetLines[sourceSide] = final ? null : line;
  container.scrollTop = container.scrollHeight;
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
  $("latency-value").textContent = Math.round(latency) + " ms";
  const lane = envelope.lane || data.lane;
  $("latency-detail").textContent = lane ? String(lane).replaceAll("_", " ") : "Latest sample";
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
  } else if (normal === "active" || normal === "running" || normal === "started") {
    start.disabled = true;
    pause.disabled = false;
    pause.textContent = "Pause";
    end.disabled = false;
    if (route.role === "participant") {
      updateParticipantConnection(state.audio ? "Live" : "Room live", true);
      if (previousStatus === "paused" && state.audio && state.vadActive) {
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
    start.disabled = normal !== "ready";
    pause.disabled = true;
    pause.textContent = "Pause";
    end.disabled = false;
  }
}

function updateRecording(data) {
  const value = data.active ?? data.recording ?? data.state ?? data.status;
  const active =
    value === true ||
    ["active", "recording", "started", "open"].includes(String(value).toLowerCase());
  $("recording-badge").classList.toggle("is-off", !active);
  $("recording-label").textContent = active ? "Recording" : "Recording off";
}

function handleParticipantCaptions(envelope, type, data) {
  if (route.role !== "participant") return;
  const sides = eventSides(envelope);
  const text = textFrom(data);
  if (!text) return;

  if ((type === "source_partial" || type === "source_stable") && sides.source === route.side) {
    $("participant-source-caption").textContent = text;
  }
  if (
    (type === "target_committed" || type === "target_validated") &&
    sides.target === route.side
  ) {
    $("participant-target-caption").textContent = text;
  }
}

function handleEvent(envelope) {
  if (!envelope || typeof envelope !== "object") return;
  if (envelope.cursor !== undefined) {
    const cursor = String(envelope.cursor);
    if (state.seenCursors.has(cursor)) return;
    state.seenCursors.add(cursor);
    const numericCursor = Number(envelope.cursor);
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

  if (route.role === "operator" && type !== "source_partial") {
    addFeedItem($("pipeline-feed"), titleCase(type), summary, isWarning);
  }

  if (type === "session_state") {
    updateRoomState(data.state ?? data.status ?? data.value);
  } else if (type === "participant_joined") {
    const side = normaliseSide(data.side || envelope.lane);
    if (side) state.participants.add(side);
    $("participant-count").textContent = state.participants.size + " / 2 joined";
  } else if (type === "participant_left") {
    const side = normaliseSide(data.side || envelope.lane);
    if (side) state.participants.delete(side);
    $("participant-count").textContent = state.participants.size + " / 2 joined";
  } else if (type === "source_partial") {
    if (route.role === "operator") {
      appendSourceTranscript(sides.source, textFrom(data), true, envelope.generation);
    }
  } else if (type === "source_stable") {
    if (route.role === "operator") {
      appendSourceTranscript(sides.source, textFrom(data), false, envelope.generation);
    }
  } else if (type === "target_committed" || type === "target_validated") {
    if (route.role === "operator") {
      appendTargetTranscript(
        sides.source,
        textFrom(data),
        type === "target_validated",
        data.final === true,
        envelope.generation,
      );
    }
  } else if (type === "terminology_alert") {
    state.alertCount += 1;
    $("alert-count").textContent = String(state.alertCount);
    $("alert-detail").textContent = summary || "Review required";
    if (route.role === "operator") {
      addFeedItem($("terminology-feed"), data.term || "Terminology alert", summary, true);
    }
  } else if (type === "latency") {
    updateLatency(data, envelope);
  } else if (type === "generation_cut") {
    state.cutCount += 1;
    $("cut-count").textContent = String(state.cutCount);
    const generation = Number(envelope.generation ?? data.generation);
    if (state.audio && Number.isFinite(generation) && sides.target === route.side) {
      state.audio.playoutNode.port.postMessage({ type: "clear", generation });
    }
  } else if (type === "recording_state") {
    updateRecording(data);
  }

  handleParticipantCaptions(envelope, type, data);
}

async function parseEventMessage(message) {
  try {
    const raw = message instanceof Blob ? await message.text() : String(message);
    handleEvent(JSON.parse(raw));
  } catch {
    if (route.role === "operator") {
      addFeedItem($("pipeline-feed"), "Invalid event", "Could not parse server message", true);
    }
  }
}

function connectEventStream(sessionId) {
  if (state.eventSessionId !== null && state.eventSessionId !== sessionId) {
    state.lastCursor = 0;
    state.seenCursors.clear();
  }
  state.eventSessionId = sessionId;
  state.eventsClosed = false;
  if (state.eventReconnectTimer) window.clearTimeout(state.eventReconnectTimer);
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
    if (state.eventSocket !== socket) return;
    state.eventAttempts = 0;
    if (route.role === "participant") {
      updateParticipantConnection(state.audio ? "Live" : "Room connected", true);
    } else {
      updateGlobalStatus("Event stream connected", true);
    }
  });

  socket.addEventListener("message", (event) => {
    void parseEventMessage(event.data);
  });

  socket.addEventListener("close", () => {
    if (state.eventSocket !== socket) return;
    state.eventSocket = null;
    if (route.role === "participant") {
      updateParticipantConnection("Reconnecting", false);
    } else {
      updateGlobalStatus("Event stream reconnecting", false);
    }
    if (state.eventsClosed) return;
    const delay = Math.min(1000 * 2 ** state.eventAttempts, 10000);
    state.eventAttempts += 1;
    state.eventReconnectTimer = window.setTimeout(() => {
      connectEventStream(sessionId);
    }, delay);
  });

  socket.addEventListener("error", () => {
    if (route.role === "operator") {
      addFeedItem($("pipeline-feed"), "Connection issue", "Event stream unavailable", true);
    }
  });
}

function updateCreateAvailability() {
  $("create-session").disabled =
    !$("recording-consent").checked || !state.capabilitiesReady;
}

async function loadCapabilities() {
  const capabilities = await getJson("/api/capabilities");
  const profiles = Array.isArray(capabilities.translationProfiles)
    ? capabilities.translationProfiles.filter((profile) => PROFILE_LABELS[profile])
    : [];
  if (profiles.length === 0) {
    throw new Error("This server has no browser-selectable translation profile.");
  }

  const select = $("translation-profile");
  select.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile;
    option.textContent = PROFILE_LABELS[profile];
    select.append(option);
  }
  select.value = profiles.includes(capabilities.defaultTranslationProfile)
    ? capabilities.defaultTranslationProfile
    : profiles[0];
  state.capabilitiesReady = true;
  updateCreateAvailability();
}

function currentGlossaryDirection() {
  return $("language-a").value + "->" + $("language-b").value;
}

function invalidateGlossaryIfDirectionChanged() {
  if (
    state.glossaryVersion === null ||
    state.glossaryDirection === currentGlossaryDirection()
  ) {
    return;
  }
  state.glossaryVersion = null;
  state.glossaryDirection = null;
  $("glossary-status").textContent = "Re-import required";
}

async function importGlossary(event) {
  event.preventDefault();
  const button = $("import-glossary");
  const error = $("glossary-error");
  clearError(error);
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
  state.session = snapshot;
  $("session-id").textContent = snapshot.sessionId;
  renderJoinCards(Array.isArray(snapshot.endpointGrants) ? snapshot.endpointGrants : []);
  $("setup-section").hidden = true;
  $("operator-dashboard").hidden = false;
  updateRoomState(snapshot.state || "created");
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
  if (!$("recording-consent").checked) {
    showError(error, "Confirm recording consent before creating the room.");
    return;
  }
  if ($("language-a").value === $("language-b").value) {
    showError(error, "Choose two different spoken languages.");
    return;
  }
  const translationProfileId = $("translation-profile").value;
  if (
    state.glossaryVersion !== null &&
    !["glossary_controlled", "local_eval"].includes(translationProfileId)
  ) {
    showError(error, "Select Glossary controlled or Local glossary evaluation to use the glossary.");
    return;
  }

  setLoading(button, true, "Creating...");
  try {
    const response = await postJson("/api/sessions", {
      languages: {
        A: $("language-a").value,
        B: $("language-b").value,
      },
      translationProfileId,
      glossaryVersion: state.glossaryVersion || undefined,
      recordingConsent: true,
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
    start: $("start-session"),
    pause: $("pause-session"),
    resume: $("pause-session"),
    end: $("end-session"),
  };
  const loadingLabels = {
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
    if (kind === "end") updateRoomState("ended");
  } catch (errorValue) {
    addFeedItem($("pipeline-feed"), "Command failed", errorValue.message, true);
    setLoading(button, false, "");
  }
}

async function initialiseOperator() {
  $("operator-view").hidden = false;
  $("participant-view").hidden = true;
  $("glossary-form").addEventListener("submit", importGlossary);
  $("session-form").addEventListener("submit", createSession);
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

  $("recording-consent").addEventListener("change", updateCreateAvailability);
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
    updateGlobalStatus("Harness ready", true);
  } catch (error) {
    state.capabilitiesReady = false;
    updateCreateAvailability();
    showError($("session-form-error"), error);
    updateGlobalStatus("Harness configuration error", false);
  }
}

async function handleMediaMessage(message) {
  if (!state.audio) {
    state.pendingMediaMessages.push(message);
    return;
  }
  if (typeof message === "string") {
    try {
      const control = JSON.parse(message);
      if (control.type === "clear") {
        const generation = Number(control.generation);
        if (Number.isFinite(generation)) {
          state.audio.playoutNode.port.postMessage({ type: "clear", generation });
          $("playback-label").textContent = "Audio queue cleared";
        }
      }
    } catch {
      showError($("participant-error"), "Received an invalid media control message.");
    }
    return;
  }

  const buffer = message instanceof Blob ? await message.arrayBuffer() : message;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 8) return;
  const view = new DataView(buffer);
  const generation = view.getUint32(0, true);
  const sequence = view.getUint32(4, true);
  const count = Math.floor((buffer.byteLength - 8) / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = view.getInt16(8 + index * 2, true) / 32768;
  }
  state.audio.playoutNode.port.postMessage(
    { type: "push", generation, sequence, samples },
    [samples.buffer],
  );
  $("playback-label").textContent = "Playing AI voice - generation " + generation;
}

function openMediaSocket(sessionId, side) {
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
      void handleMediaMessage(event.data);
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
  const socket = currentMediaSocket();
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type }));
  }
}

async function stopParticipantAudio(reportStopped) {
  const audio = state.audio;
  state.audio = null;
  if (!audio) return;

  const socket = audio.socketSupervisor.socket;
  if (state.vadActive && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "speech_end" }));
  }
  state.vadActive = false;
  state.capturePreroll = [];
  state.pendingMediaMessages = [];
  state.captureBackpressureAlerted = false;
  audio.socketSupervisor.stop(1000, "Microphone stopped");
  await releaseParticipantWakeLock(audio);
  audio.stream.getTracks().forEach((track) => track.stop());
  audio.captureNode.disconnect();
  audio.source.disconnect();
  audio.playoutNode.disconnect();
  audio.silentGain.disconnect();
  await audio.context.close().catch(() => {});

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
}

async function startParticipantAudio() {
  const button = $("start-microphone");
  const error = $("participant-error");
  clearError(error);

  if (!$("headphones-confirmed").checked) {
    showError(error, "Confirm that you are wearing headphones before starting.");
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
    state.pendingMediaMessages = [];
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

    participantAudio = {
      context,
      stream,
      socketSupervisor,
      source,
      captureNode,
      playoutNode,
      silentGain,
      wakeLock: null,
    };
    state.audio = participantAudio;

    const queuedMedia = state.pendingMediaMessages.splice(0);
    for (const queuedMessage of queuedMedia) await handleMediaMessage(queuedMessage);

    state.capturePreroll = [];
    const sendPcmFrame = (pcm) => {
      const socket = currentMediaSocket();
      if (state.audio !== participantAudio) return;
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
      if (state.audio !== participantAudio) return;
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
      if (state.audio !== participantAudio) return;
      if (
        !["playout_started", "playout_dropped"].includes(message.type) ||
        !Number.isSafeInteger(message.generation) ||
        !Number.isSafeInteger(message.sequence)
      ) return;
      const socket = currentMediaSocket();
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({
        type: message.type,
        generation: message.generation,
        sequence: message.sequence,
      }));
    });
    playoutNode.port.start();

    await context.resume();
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
  }
}

async function initialiseParticipant() {
  $("operator-view").hidden = true;
  $("participant-view").hidden = false;
  $("participant-side").textContent = route.side;
  document.title = "Phone " + route.side + " - Relay";

  const secure =
    window.isSecureContext ||
    ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const audioSupported = Boolean(
    AudioContextClass &&
      window.AudioWorkletNode &&
      window.WebSocket &&
      navigator.mediaDevices &&
      navigator.mediaDevices.getUserMedia,
  );
  setPreflight("check-secure", secure);
  setPreflight("check-audio", audioSupported);
  setPreflight("check-mic", null);

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
  if (!secure || !audioSupported) {
    showError(
      $("participant-error"),
      !secure
        ? "Microphone access requires HTTPS on a phone."
        : "Use a current Chrome, Edge, or Safari browser for live audio.",
    );
    $("start-microphone").disabled = true;
  }

  $("start-microphone").addEventListener("click", () => void startParticipantAudio());
  $("stop-microphone").addEventListener("click", () => void stopParticipantAudio(true));
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

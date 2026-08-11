import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

interface BrowserContract {
  normalizeDataAdmission(value: unknown): "approved_poc_content" | "synthetic_only";
  isOperatorStartGateSatisfied(value: unknown): boolean;
  retainTerminalClearReceipts(
    receipts: readonly Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>[],
    receipt: Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>,
    maximum?: number,
  ): readonly Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>[];
  retainOutstandingClearRequests(
    requests: readonly Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>[],
    request: Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>,
    maximum?: number,
  ): readonly Readonly<{ lane: "A_TO_B" | "B_TO_A"; generation: number; clearId: string }>[];
  normalizeEvidenceFinalization(value: unknown): Readonly<
    | {
        status: "sealed";
        manifestSha256: string;
        encryptedLedgerSha256: string;
        finalChainSha256: string;
        retentionDeadlineAt: string;
        tracks: Readonly<Record<
          "source_a" | "source_b" | "playout_to_a" | "playout_to_b",
          Readonly<{ sha256: string; frameCount: number; byteCount: number }>
        >>;
      }
    | {
        status: "FINALIZATION_FAILED";
        failureCode:
          | "seal_write_failed"
          | "integrity_verification_failed"
          | "manifest_write_failed";
        recovery: "rebuild_from_spool" | "quarantine_delete_rerun";
      }
  >;
  normalizePlayoutLag(value: unknown): Readonly<{
    scope: "server_to_audible_ack";
    side: "A" | "B";
    sequence: number;
    audibleStartLagMs: number;
    sourceSide?: "A" | "B";
    targetSide?: "A" | "B";
  }>;
  normalizeTerminologyGate(value: unknown): Readonly<{
    status: "bound" | "authorized" | "bypassed";
    glossaryHash: string;
    entryIds: readonly string[];
    termId?: string;
    confidence?: number;
    code?: string;
    message?: string;
    sourceSide?: "A" | "B";
    targetSide?: "A" | "B";
  }>;
  normalizeRecorderPreflight(value: unknown): Readonly<
    | {
        status: "ready";
        checkedAtMonoMs: number;
        requiredFreeBytes: string;
        availableFreeBytes: string;
        tracks: readonly string[];
        manifestSha256: string;
        encryptedSpoolSha256: string;
        sealedRecordCount: number;
        sealSha256: string;
      }
    | {
        status: "failed";
        checkedAtMonoMs: number;
        failureCode: string;
      }
  >;
  normalizeBargeLifecycle(value: unknown): Readonly<{
    stage:
      | "speech_onset"
      | "provider_cancel_requested"
      | "provider_cancel_settled"
      | "provider_cancel_failed"
      | "playout_clear_requested"
      | "playout_clear_acknowledged"
      | "playout_clear_failed"
      | "valid_output_resumed";
    bargeId: string;
    clearId: string;
    sourceSide: "A" | "B";
    destinationSide: "A" | "B";
    message?: string;
  }>;
  normalizeQueueSample(value: unknown): Readonly<{
    scope: "relay_input" | "relay_playout" | "browser_playout";
    side: "A" | "B" | null;
    depthFrames: number;
    capacityFrames: number;
    oldestQueuedAgeMs?: number;
    bufferedAudioMs?: number;
    sourceSide?: "A" | "B";
    targetSide?: "A" | "B";
  }>;
  normalizeProviderReadiness(value: unknown): Readonly<{
    readiness: "local_route_validated" | "remote_task_ready" | "fixture_local";
    remoteConnection: "deferred_until_first_turn" | "connected" | "not_applicable";
  }>;
  normalizeParticipantReadiness(value: unknown): Readonly<{
    side: "A" | "B";
    microphone: "browser_capture_active" | "stopped" | "not_applicable";
    headphones: "self_attested" | "not_attested" | "not_applicable";
    source: "participant_browser_self_report" | "fake_telephony_fixture";
  }>;
  normalizeEvidenceIdentity(value: unknown): Readonly<{
    deploymentBuildSha256: string;
    processingProfile: Readonly<{
      id: string;
      version: string;
      sha256: string;
    }>;
    processingManifestSha256: string;
    servicesSha256: string;
  }>;
  endpointGrantPresentation(grant: unknown, baseHref: string): Readonly<{
    kind: string;
    side: string;
    href?: string;
    address?: string;
    qrDataUrl?: string;
    copyValue: string;
  }>;
  arrayBufferToBase64(buffer: ArrayBuffer): string;
  glossaryUploadContents(fileName: string, buffer: ArrayBuffer): Readonly<{
    fileName: string;
    contentsBase64: string;
  }>;
  shouldSendSpeechStartForActiveTransition(
    previousState: unknown,
    nextState: unknown,
    vadActive: boolean,
  ): boolean;
  applySegmentRevision(
    segments: Map<string, unknown>,
    update: Readonly<{
      generation: number;
      turnId: string;
      segmentId: string;
      revision: number;
      text: string;
      final: boolean;
    }>,
  ): Readonly<{
    applied: boolean;
    key: string;
    segment: Readonly<{
      generation: number;
      turnId: string;
      segmentId: string;
      revision: number;
      text: string;
      final: boolean;
    }>;
  }>;
  normalizeTranslationCapabilities(value: unknown): Readonly<{
    provider: string;
    modes: readonly Readonly<{
      mode: string;
      behavior: Readonly<{ version: number }>;
      state: "native" | "locally_controlled" | "experimental" | "unsupported";
      deterministicGlossary: boolean;
      reason?: string;
    }>[];
    defaultMode: string;
  }>;
  normalizeProcessingDisclosure(value: unknown): Readonly<{
    noticeVersion: string;
    recording: true;
    processing: true;
    withdrawalTerminatesSession: true;
    provider: string;
    services: readonly Readonly<{
      id: string;
      provider: string;
      role: string;
      category: string;
      dataCategories: readonly (
        | "canonical_audio"
        | "source_language"
        | "target_language"
        | "source_transcript"
        | "source_terms"
        | "aliases"
        | "opaque_placeholders"
        | "authorized_target_text"
      )[];
    }>[];
  }>;
}

interface ParticipantBootstrapProbe {
  readonly accessWrites: readonly (readonly [string, string])[];
  readonly constructedUrls: readonly string[];
  readonly error: string;
  readonly errorVisible: boolean;
  readonly sockets: readonly string[];
  readonly startDisabled: boolean;
  readonly latencyValue: string;
  readonly targetCaption: string;
}

function probeParticipantBootstrap(
  hostname: string,
  isSecureContext: boolean,
  recorderStateProbe = false,
  cursorProbe = false,
  participantCutProbe = false,
  wrongSessionProbe = false,
): ParticipantBootstrapProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("participant-bootstrap-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const script = `
const fixture = ${JSON.stringify({ hostname, isSecureContext, recorderStateProbe, cursorProbe, participantCutProbe, wrongSessionProbe })};
const elements = new Map();
const operatorOnlyIds = new Set(["recording-badge", "recording-label"]);
if (fixture.participantCutProbe) {
  for (const id of ["cut-count", "alert-count", "alert-detail", "participant-count", "latency-value", "latency-detail"]) {
    operatorOnlyIds.add(id);
  }
}
function element() {
  const span = { textContent: "" };
  return {
    hidden: true,
    disabled: false,
    textContent: "",
    dataset: {},
    classList: { toggle() {} },
    querySelector(selector) { return selector === "span" ? span : null; },
    replaceChildren() {},
    addEventListener() {},
  };
}
const document = {
  title: "",
  getElementById(id) {
    if (operatorOnlyIds.has(id)) return null;
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  addEventListener() {},
  createElement() { return element(); },
  createTextNode(textContent) { return { textContent }; },
};
const sockets = [];
const socketInstances = [];
const reconnectTimers = [];
class RecordingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    sockets.push(String(url));
    socketInstances.push(this);
    this.readyState = RecordingWebSocket.CONNECTING;
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
  close() {}
}
const accessWrites = [];
const NativeURLSearchParams = globalThis.URLSearchParams;
class TrackingSearchParams extends NativeURLSearchParams {
  set(name, value) {
    accessWrites.push([String(name), String(value)]);
    return super.set(name, value);
  }
}
const constructedUrls = [];
const NativeURL = globalThis.URL;
class TrackingURL extends NativeURL {
  constructor(input, base) {
    super(input, base);
    constructedUrls.push(this.toString());
  }
}
const href = "http://" + fixture.hostname + ":4207/?role=participant&sessionId=session-1&side=A#access=participant-grant";
globalThis.window = {
  location: {
    search: "?role=participant&sessionId=session-1&side=A",
    hash: "#access=participant-grant",
    hostname: fixture.hostname,
    href,
  },
  isSecureContext: fixture.isSecureContext,
  WebSocket: RecordingWebSocket,
  AudioContext: class {},
  AudioWorkletNode: class {},
  addEventListener() {},
  clearTimeout() {},
  setTimeout(callback) {
    if (typeof callback === "function") reconnectTimers.push(callback);
    return reconnectTimers.length;
  },
};
globalThis.document = document;
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia() {} } },
});
globalThis.WebSocket = RecordingWebSocket;
globalThis.URLSearchParams = TrackingSearchParams;
globalThis.URL = TrackingURL;
await import(${JSON.stringify(appUrl.href)});
await Promise.resolve();
if (fixture.recorderStateProbe && socketInstances[0]) {
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 1, type: "recorder_state", data: { state: "armed" } }),
  });
  await Promise.resolve();
}
if (fixture.cursorProbe && socketInstances[0]) {
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 1, type: "latency", data: { latencyMs: 10 } }),
  });
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 0, type: "latency", data: { latencyMs: 99 } }),
  });
  await Promise.resolve();
}
if (fixture.participantCutProbe && socketInstances[0]) {
  socketInstances[0].emit("message", {
    data: JSON.stringify({
      sessionId: "session-1",
      cursor: 1,
      type: "generation_cut",
      lane: "B_TO_A",
      generation: 1,
      data: {
        previousGeneration: 0,
        generation: 1,
        sourceSide: "B",
        targetSide: "A",
        reason: "barge_in",
      },
    }),
  });
  await Promise.resolve();
}
if (fixture.wrongSessionProbe && socketInstances[0]) {
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-evil", cursor: 99, type: "latency", data: { latencyMs: 99 } }),
  });
  socketInstances[0].emit("message", {
    data: JSON.stringify({ cursor: 98, type: "latency", data: { latencyMs: 98 } }),
  });
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 1, type: "latency", data: { latencyMs: 10 } }),
  });
  const delayedWrongSession = new Blob([JSON.stringify({
    sessionId: "session-evil", cursor: 88, type: "latency", data: { latencyMs: 88 },
  })], { type: "application/json" });
  socketInstances[0].emit("message", { data: delayedWrongSession });
  socketInstances[0].emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 2, type: "latency", data: { latencyMs: 11 } }),
  });
  await Promise.resolve();
  await Promise.resolve();
  socketInstances[0].emit("close", {});
  reconnectTimers.shift()?.();
  const delayedRetiredSession = new Blob([JSON.stringify({
    sessionId: "session-evil", cursor: 97, type: "latency", data: { latencyMs: 97 },
  })], { type: "application/json" });
  socketInstances[0].emit("message", { data: delayedRetiredSession });
  socketInstances[1]?.emit("message", {
    data: JSON.stringify({ sessionId: "session-1", cursor: 3, type: "latency", data: { latencyMs: 12 } }),
  });
  await Promise.resolve();
  await Promise.resolve();
}
const error = elements.get("participant-error") || element();
const start = elements.get("start-microphone") || element();
const latency = elements.get("latency-value") || element();
const targetCaption = elements.get("participant-target-caption") || element();
process.stdout.write(JSON.stringify({
  accessWrites,
  constructedUrls,
  error: error.textContent,
  errorVisible: !error.hidden,
  sockets,
  startDisabled: start.disabled,
  latencyValue: latency.textContent,
  targetCaption: targetCaption.textContent,
}));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as ParticipantBootstrapProbe;
}

interface SegmentRenderProbe {
  readonly socketUrls: readonly string[];
  readonly lines: readonly Readonly<{
    readonly text: string;
    readonly turnId: string;
    readonly segmentId: string;
    readonly validated: string;
    readonly played: string;
    readonly stateKey: string;
    readonly label: string;
  }>[];
}

interface EventResyncFenceProbe {
  readonly afterLateASessionId: string;
  readonly finalSessionId: string;
  readonly resyncGetCount: number;
}

function probeOperatorSegmentLifecycle(eventGapProbe?: boolean, staleResyncProbe?: false): SegmentRenderProbe;
function probeOperatorSegmentLifecycle(eventGapProbe: false, staleResyncProbe: true): EventResyncFenceProbe;
function probeOperatorSegmentLifecycle(eventGapProbe = false, staleResyncProbe = false): SegmentRenderProbe | EventResyncFenceProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("operator-segment-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const gapScenario = eventGapProbe
    ? `
globalThis.eventSocket.emit("message", { data: JSON.stringify({ sessionId: "session-1", cursor: 0, type: "error", data: { code: "event_cursor_gap" } }) });
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
`
    : "";
  const setup = staleResyncProbe
    ? `
const response = (payload) => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) });
const capabilities = {
  provider: "deterministic",
  modes: [
    { mode: "fast", behavior: { version: 1 }, state: "locally_controlled", deterministicGlossary: true },
    { mode: "balanced", behavior: { version: 1 }, state: "native", deterministicGlossary: false },
    { mode: "accurate", behavior: { version: 1 }, state: "experimental", deterministicGlossary: false, reason: "Unavailable" },
  ],
  defaultMode: "fast",
};
const snapshotA = {
  sessionId: "session-a", languages: { A: "en-US", B: "zh-TW" }, eventCursor: 0,
  provider: "deterministic", translationMode: "fast", behaviorVersion: 1,
  deterministicGlossary: false, translationState: "native", state: "created",
  participantConsent: { A: { consented: false }, B: { consented: false } },
  recorderArmState: "awaiting_consents", recordingArmed: false, endpointGrants: [],
};
const snapshotB = { ...snapshotA, sessionId: "session-b" };
const pendingGets = [];
let postCount = 0;
globalThis.window = {
  location: { search: "", hash: "", hostname: "localhost", href: "http://localhost:4207/" },
  isSecureContext: false, WebSocket: RecordingWebSocket, addEventListener() {},
  clearTimeout() {}, setTimeout() { return 0; }, history: { replaceState() {} },
};
globalThis.document = document;
globalThis.WebSocket = RecordingWebSocket;
globalThis.fetch = async (url, options = {}) => {
  const path = String(url);
  if (path.endsWith("/api/capabilities")) return response({ dataAdmission: "approved_poc_content", translation: capabilities });
  if (path.endsWith("/api/sessions") && options.method === "POST") {
    postCount += 1;
    return response(postCount === 1 ? snapshotA : snapshotB);
  }
  if (path.endsWith("/api/sessions/session-a")) {
    return new Promise((resolve) => pendingGets.push({ sessionId: "session-a", resolve }));
  }
  if (path.endsWith("/api/sessions/session-b")) {
    return new Promise((resolve) => pendingGets.push({ sessionId: "session-b", resolve }));
  }
  return response({});
};
`
    : `
const snapshot = {
  sessionId: "session-1",
  languages: { A: "en-US", B: "zh-TW" },
  eventCursor: ${eventGapProbe ? 7 : 0},
  provider: "deterministic",
  translationMode: "fast",
  behaviorVersion: 1,
  deterministicGlossary: false,
  translationState: "native",
  state: "created",
  participantConsent: { A: { consented: false }, B: { consented: false } },
  recorderArmState: "awaiting_consents",
  recordingArmed: false,
  endpointGrants: [],
};
globalThis.window = {
  location: { search: "?sessionId=session-1", hash: "", hostname: "localhost", href: "http://localhost:4207/?sessionId=session-1" },
  isSecureContext: false,
  WebSocket: RecordingWebSocket,
  addEventListener() {},
  clearTimeout() {},
  setTimeout() { return 0; },
  history: { replaceState() {} },
};
globalThis.document = document;
globalThis.WebSocket = RecordingWebSocket;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => snapshot, text: async () => JSON.stringify(snapshot) });
`;
  const staleResyncScenario = staleResyncProbe
    ? `
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const submit = document.getElementById("session-form").listeners.get("submit")?.[0];
await submit?.({ preventDefault() {} });
await new Promise((resolve) => setImmediate(resolve));
const socketA = globalThis.eventSocket;
if (!socketA) throw new Error("session-a create failed: " + document.getElementById("session-form-error").textContent);
socketA.emit("message", { data: JSON.stringify({ sessionId: "session-a", cursor: 0, type: "error", data: { code: "event_cursor_gap" } }) });
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
await submit?.({ preventDefault() {} });
await new Promise((resolve) => setImmediate(resolve));
const socketB = globalThis.eventSocket;
socketB.emit("message", { data: JSON.stringify({ sessionId: "session-b", cursor: 0, type: "error", data: { code: "event_cursor_gap" } }) });
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
const getA = pendingGets.find((entry) => entry.sessionId === "session-a");
getA?.resolve(response(snapshotA));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const afterLateASessionId = document.getElementById("session-id").textContent;
await submit?.({ preventDefault() {} });
await new Promise((resolve) => setImmediate(resolve));
const socketB2 = globalThis.eventSocket;
socketB2.emit("message", { data: JSON.stringify({ sessionId: "session-b", cursor: 0, type: "error", data: { code: "event_cursor_gap" } }) });
await Promise.resolve();
await new Promise((resolve) => setImmediate(resolve));
const getB = pendingGets.find((entry) => entry.sessionId === "session-b");
getB?.resolve(response(snapshotB));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(JSON.stringify({ afterLateASessionId, finalSessionId: document.getElementById("session-id").textContent, resyncGetCount: pendingGets.length }));
process.exit(0);
`
    : "";
  const script = `
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = true;
    this.disabled = false;
    this.textContent = "";
    this.value = id === "language-a" ? "en-US" : id === "language-b" ? "zh-TW" : "";
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.files = [];
    this.selectedOptions = [{ textContent: this.value }];
    this.classList = {
      add: (...names) => names.forEach((name) => this.classList._set.add(name)),
      remove: (...names) => names.forEach((name) => this.classList._set.delete(name)),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList._set.has(name) : Boolean(force);
        if (next) this.classList._set.add(name); else this.classList._set.delete(name);
        return next;
      },
      contains: (name) => this.classList._set.has(name),
      _set: new Set(),
    };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    if (selector === "span") return this._span || (this._span = new FakeElement("span"));
    if (selector === "p" || selector === "small" || selector === "strong" || selector === "time") {
      return this.children.find((child) => child.tagName === selector) || null;
    }
    if (selector === ".empty-state") {
      return this.children.find((child) => child.className === "empty-state") || null;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ".event-item") return this.children.filter((child) => child.className?.includes("event-item"));
    return this.children.filter((child) => child.tagName === selector);
  }
  setAttribute() {}
  scrollIntoView() {}
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
}
const elements = new Map();
const document = {
  title: "",
  getElementById(id) {
    if (!elements.has(id)) {
      const created = new FakeElement(id);
      created.tagName = "div";
      if (id.startsWith("transcript-")) {
        const empty = new FakeElement("empty");
        empty.tagName = "p";
        empty.className = "empty-state";
        created.append(empty);
      }
      elements.set(id, created);
    }
    return elements.get(id);
  },
  addEventListener() {},
  createElement(tagName) {
    const created = new FakeElement();
    created.tagName = tagName;
    return created;
  },
  createTextNode(textContent) { return { textContent }; },
};
const socketUrls = [];
class RecordingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    this.url = String(url);
    this.readyState = RecordingWebSocket.OPEN;
    this.listeners = new Map();
    socketUrls.push(this.url);
    globalThis.eventSocket = this;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
  close() { this.readyState = 3; }
}
${setup}
await import(${JSON.stringify(appUrl.href)});
await Promise.resolve();
${staleResyncScenario}
${gapScenario}
const emit = (event) => globalThis.eventSocket.emit("message", {
  data: JSON.stringify({ sessionId: "session-1", ...event }),
});
// Provider audio IDs are deliberately different from target IDs.  The relay's
// public playout projection carries the canonical target ID in segmentId.
emit({ cursor: 1, type: "terminology_gate", lane: "B_TO_A", generation: 1, data: {
  status: "authorized", turnId: "turn-det", segmentId: "turn-det:target_transcript", revision: 0,
  glossaryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", entryIds: ["entry-1"],
  sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 2, type: "target_segment", lane: "B_TO_A", generation: 1, data: {
  turnId: "turn-det", segmentId: "turn-det:target_transcript", revision: 0, text: "deterministic", final: false, sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 3, type: "playout_lag", lane: "B_TO_A", generation: 1, data: {
  scope: "server_to_audible_ack", side: "A", sequence: 1, audibleStartLagMs: 10,
  turnId: "turn-det", segmentId: "turn-det:target_transcript", frame: { segmentId: "turn-det:audio:0" },
  revision: 0, sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 4, type: "target_segment", lane: "B_TO_A", generation: 1, data: {
  turnId: "turn-det", segmentId: "turn-det:target_transcript", revision: 1, text: "deterministic revised", final: false, sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 5, type: "terminology_gate", lane: "B_TO_A", generation: 1, data: {
  status: "authorized", turnId: "turn-pal", segmentId: "turn-pal:segment:0", revision: 0,
  glossaryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", entryIds: ["entry-1"],
  sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 6, type: "playout_lag", lane: "B_TO_A", generation: 1, data: {
  scope: "server_to_audible_ack", side: "A", sequence: 1, audibleStartLagMs: 11,
  turnId: "turn-pal", segmentId: "turn-pal:segment:0", frame: { segmentId: "turn-pal:audio:0" },
  revision: 0, sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 7, type: "target_segment", lane: "B_TO_A", generation: 1, data: {
  turnId: "turn-pal", segmentId: "turn-pal:segment:0", revision: 0, text: "palabra", final: false, sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 8, type: "terminology_gate", lane: "B_TO_A", generation: 1, data: {
  status: "authorized", turnId: "turn-native", segmentId: "target_transcript-provider-7", revision: 1,
  glossaryHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", entryIds: ["entry-1"],
  sourceSide: "B", targetSide: "A",
} });
emit({ cursor: 9, type: "target_segment", lane: "B_TO_A", generation: 1, data: {
  turnId: "turn-native", segmentId: "target_transcript-provider-7", revision: 1, text: "native", final: false, sourceSide: "B", targetSide: "A",
} });
// Latency/audio-playout projection has no revision and is metrics-only; it
// must not mark this newer target row played after a delayed old event.
emit({ cursor: 10, type: "latency", lane: "B_TO_A", generation: 1, data: {
  firstAudioMs: 12, turnId: "turn-native", segmentId: "target_transcript-provider-7",
  frame: { segmentId: "audio-7" }, sourceSide: "B", targetSide: "A",
} });
await Promise.resolve();
const transcript = elements.get("transcript-b");
  process.stdout.write(JSON.stringify({ socketUrls, lines: transcript.children.filter((line) => line.dataset?.kind === "target").map((line) => ({
  text: line.querySelector("p")?.textContent || "",
  turnId: line.dataset.turnId || "",
  segmentId: line.dataset.segmentId || "",
  validated: line.dataset.validated,
  played: line.dataset.played,
  stateKey: line.dataset.stateKey,
  label: line.querySelector("small")?.textContent || "",
})) }));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as SegmentRenderProbe | EventResyncFenceProbe;
}

function probeOperatorResyncFence(): EventResyncFenceProbe {
  return probeOperatorSegmentLifecycle(false, true) as EventResyncFenceProbe;
}

interface StopCleanupProbe {
  readonly socketClosed: number;
  readonly supervisorStop: boolean;
  readonly trackStops: number;
  readonly disconnects: number;
  readonly contextClosed: number;
  readonly playoutMessages: readonly Readonly<Record<string, unknown>>[];
  readonly error: string;
}

interface OfflineRecoveryProbe {
  readonly recoverySpeechControls: readonly string[];
  readonly secondRecoverySpeechControls: readonly string[];
  readonly clearAppliedCount: number;
}

interface PauseReconnectProbe {
  readonly pausedTrackEnabled: boolean;
  readonly pausedReadiness: readonly string[];
  readonly pausedConnection: string;
  readonly resumedTrackEnabled: boolean;
  readonly resumedReadiness: readonly string[];
  readonly resumedConnection: string;
}

interface EventGapParticipantProbe {
  readonly trackStops: number;
  readonly socketClosed: number;
  readonly connection: string;
  readonly liveStatus: string;
  readonly reconnectTimers: number;
}

interface CaptureStartProbe {
  readonly activeReadiness: boolean;
  readonly liveVisible: boolean;
  readonly connection: string;
  readonly error: string;
  readonly trackStops: number;
  readonly socketClosed: number;
}

function probeParticipantStopCleanup(): StopCleanupProbe;
function probeParticipantStopCleanup(offlineRecovery: true): OfflineRecoveryProbe;
function probeParticipantStopCleanup(offlineRecovery: false, pauseReconnect: true): PauseReconnectProbe;
function probeParticipantStopCleanup(offlineRecovery: false, pauseReconnect: false, eventGapProbe: true): EventGapParticipantProbe;
function probeParticipantStopCleanup(offlineRecovery: false, pauseReconnect: false, eventGapProbe: false, trackMode: "empty" | "muted"): CaptureStartProbe;
function probeParticipantStopCleanup(offlineRecovery = false, pauseReconnect = false, eventGapProbe = false, trackMode: "normal" | "empty" | "muted" = "normal"): StopCleanupProbe | OfflineRecoveryProbe | PauseReconnectProbe | EventGapParticipantProbe | CaptureStartProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("participant-stop-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const scenario = trackMode !== "normal"
    ? `
await new Promise((resolve) => setImmediate(resolve));
const activeReadiness = mediaPayloads.some((entry) => entry.payload.type === "participant_readiness" && entry.payload.microphone === "browser_capture_active");
process.stdout.write(JSON.stringify({ activeReadiness, liveVisible: !(elements.get("call-live")?.hidden ?? true), connection: elements.get("participant-connection")?.textContent || "", error: elements.get("participant-error")?.textContent || "", trackStops, socketClosed }));
`
    : eventGapProbe
      ? `
eventSocket.emit("message", { data: JSON.stringify({ sessionId: "session-1", cursor: 0, type: "error", data: { code: "event_stream_overflow" } }) });
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(JSON.stringify({ trackStops, socketClosed, connection: elements.get("participant-connection").textContent, liveStatus: elements.get("participant-live-status").textContent, reconnectTimers: reconnectTimers.length }));
`
      : offlineRecovery
    ? `
const firstMediaSocket = mediaSockets[0];
firstMediaSocket.close();
captureNodes[0].port.emit({ type: "vad", active: false });
await new Promise((resolve) => setImmediate(resolve));
reconnectTimers.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const recoveredSocket = mediaSockets[1];
playoutNodes[0].port.emit({ type: "clear_applied", lane: "B_TO_A", generation: 0, clearId: "clear-recovery" });
await Promise.resolve();
const speechControls = (socketIndex) => mediaPayloads
  .filter((entry) => entry.socketIndex === socketIndex && ["speech_start", "speech_end"].includes(entry.payload.type))
  .map((entry) => entry.payload.type);
const recoverySpeechControls = speechControls(1);
recoveredSocket.close();
reconnectTimers.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(JSON.stringify({ recoverySpeechControls, secondRecoverySpeechControls: speechControls(2), clearAppliedCount: mediaPayloads.filter((entry) => entry.payload.type === "clear_applied").length }));
  `
    : pauseReconnect
      ? `
eventSocket.emit("message", { data: JSON.stringify({ sessionId: "session-1", cursor: 2, type: "session_state", data: { state: "paused" } }) });
await Promise.resolve();
const readinessFor = (socketIndex) => mediaPayloads
  .filter((entry) => entry.socketIndex === socketIndex && entry.payload.type === "participant_readiness")
  .map((entry) => entry.payload.microphone);
const pausedTrackEnabled = track.enabled;
const pausedReadiness = readinessFor(0);
mediaSockets[0].close();
await new Promise((resolve) => setImmediate(resolve));
reconnectTimers.shift()?.();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const pausedConnection = elements.get("participant-connection").textContent;
eventSocket.emit("message", { data: JSON.stringify({ sessionId: "session-1", cursor: 3, type: "session_state", data: { state: "active" } }) });
await Promise.resolve();
const resumedTrackEnabled = track.enabled;
const resumedReadiness = readinessFor(1);
const resumedConnection = elements.get("participant-connection").textContent;
process.stdout.write(JSON.stringify({ pausedTrackEnabled, pausedReadiness, pausedConnection, resumedTrackEnabled, resumedReadiness, resumedConnection }));
`
      : `
const stopListeners = document.getElementById("stop-microphone").listeners.get("click") || [];
for (const listener of stopListeners) listener();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const error = elements.get("participant-error");
process.stdout.write(JSON.stringify({ socketClosed, supervisorStop: socketClosed > 0, trackStops, disconnects, contextClosed, playoutMessages, error: error.textContent }));
`;
  const script = `
const recoveryMode = ${offlineRecovery || pauseReconnect || eventGapProbe ? "true" : "false"};
const startupRaceMode = ${offlineRecovery ? "true" : "false"};
const trackMode = ${JSON.stringify(trackMode)};
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = true;
    this.disabled = false;
    this.checked = false;
    this.textContent = "";
    this.dataset = {};
    this.style = {};
    this.classList = { toggle() {}, add() {}, remove() {} };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append() {}
  prepend() {}
  replaceChildren(...nodes) { this.textContent = nodes.map((node) => node?.textContent || "").join(""); }
  querySelector(selector) { return selector === "span" ? new FakeElement("span") : null; }
  querySelectorAll() { return []; }
  setAttribute() {}
}
const elements = new Map();
const document = {
  title: "",
  visibilityState: "visible",
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  addEventListener() {},
  createElement() { return new FakeElement(); },
  createTextNode(textContent) { return { textContent }; },
};
const captureNodes = [];
const playoutNodes = [];
const mediaSockets = [];
const reconnectTimers = [];
const mediaPayloads = [];
const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
function scheduleTimer(callback, delay) {
  if (recoveryMode && delay >= 500 && delay < 10000) {
    reconnectTimers.push(callback);
    return reconnectTimers.length;
  }
  return nativeSetTimeout(callback, delay);
}
function clearTimer(id) { nativeClearTimeout(id); }
if (recoveryMode) {
  globalThis.setTimeout = scheduleTimer;
  globalThis.clearTimeout = clearTimer;
}
let socketClosed = 0;
let trackStops = 0;
let disconnects = 0;
let contextClosed = 0;
const playoutMessages = [];
class Port {
  constructor(name = "") { this.name = name; this.listeners = []; }
  addEventListener(_type, listener) { this.listeners.push(listener); }
  start() {}
  postMessage(message) {
    if (this.name === "relay-pcm-playout") playoutMessages.push(message);
  }
  emit(data) { for (const listener of this.listeners) listener({ data }); }
}
class Node {
  constructor(name = "") { this.port = new Port(name); this.gain = { value: 1 }; }
  connect() {}
  disconnect() { disconnects += 1; }
}
class FakeAudioContext {
  constructor() {
    this.state = "suspended";
    this.sampleRate = 24_000;
    this.destination = {};
    this.audioWorklet = { addModule: async () => {} };
  }
  createMediaStreamSource() { return new Node(); }
  createGain() { return new Node(); }
  addEventListener() {}
  async resume() { this.state = "running"; }
  async close() { contextClosed += 1; this.state = "closed"; }
}
class FakeTrack {
  readyState = "live";
  constructor(muted = false) { this.muted = muted; }
  addEventListener() {}
  stop() { trackStops += 1; this.readyState = "ended"; }
}
const track = trackMode === "empty" ? null : new FakeTrack(trackMode === "muted");
const stream = { getAudioTracks: () => track ? [track] : [], getTracks: () => track ? [track] : [] };
class RecordingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor(url) {
    this.url = String(url);
    this.readyState = RecordingWebSocket.CONNECTING;
    this.bufferedAmount = 0;
    this.listeners = new Map();
    this.isMedia = this.url.includes("/ws/media/");
    if (this.isMedia) mediaSockets.push(this);
    if (this.isMedia) queueMicrotask(() => {
      this.readyState = RecordingWebSocket.OPEN;
      this.emit("open", {});
      if (startupRaceMode && mediaSockets.length === 1) {
        this.emit("message", { data: JSON.stringify({ type: "clear", lane: "B_TO_A", generation: 0, clearId: "clear-recovery" }) });
        queueMicrotask(() => this.close());
      }
    });
    else this.readyState = RecordingWebSocket.OPEN;
    globalThis.lastSocket = this;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event) { for (const listener of this.listeners.get(type) || []) listener.call(this, event); }
  send(value) {
    if (!this.isMedia) return;
    if (typeof value === "string") {
      try { mediaPayloads.push({ socketIndex: mediaSockets.indexOf(this), payload: JSON.parse(value) }); } catch { /* binary */ }
    }
    if (!recoveryMode) throw new Error("socket closed during speech_end");
  }
  close() { socketClosed += 1; this.readyState = 3; this.emit("close", {}); }
}
const disclosure = {
  noticeVersion: "notice-1", recording: true, processing: true, withdrawalTerminatesSession: true,
  provider: "fixture", services: [{ id: "relay", provider: "fixture", role: "translation", category: "cloud", dataCategories: ["canonical_audio"] }],
};
globalThis.window = {
  location: { search: "?role=participant&sessionId=session-1&side=A", hash: "#access=participant-grant", hostname: "localhost", href: "http://localhost:4207/?role=participant&sessionId=session-1&side=A#access=participant-grant" },
  isSecureContext: false,
  WebSocket: RecordingWebSocket,
  AudioContext: FakeAudioContext,
  AudioWorkletNode: class extends Node { constructor(context, name) { super(name); if (name === "relay-pcm-capture") captureNodes.push(this); if (name === "relay-pcm-playout") playoutNodes.push(this); } },
  addEventListener() {},
  clearTimeout: clearTimer,
  setTimeout: scheduleTimer,
};
globalThis.document = document;
globalThis.WebSocket = RecordingWebSocket;
globalThis.AudioWorkletNode = window.AudioWorkletNode;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => stream } } });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}" });
await import(${JSON.stringify(appUrl.href)});
await new Promise((resolve) => setImmediate(resolve));
const eventSocket = globalThis.lastSocket;
eventSocket.emit("message", { data: JSON.stringify({ sessionId: "session-1", cursor: 1, type: "session_state", data: { state: "active", processingDisclosure: disclosure } }) });
await new Promise((resolve) => setImmediate(resolve));
document.getElementById("headphones-confirmed").checked = true;
document.getElementById("recording-processing-consent").checked = true;
const startListeners = document.getElementById("start-microphone").listeners.get("click") || [];
for (const listener of startListeners) listener();
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
  if (captureNodes[0]) captureNodes[0].port.emit({ type: "vad", active: true });
  ${scenario}
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as StopCleanupProbe;
}

interface GlossaryModeProbe {
  readonly status: string;
  readonly fileValue: string;
  readonly importHidden: boolean;
  readonly importDisabled: boolean;
  readonly clearDisabled: boolean;
}

function probeGlossaryModeControls(): GlossaryModeProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("glossary-mode-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const script = `
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = id === "translation-mode" ? "" : "";
    this.value = id === "language-a" ? "en-US" : id === "language-b" ? "zh-TW" : "";
    this.files = [];
    this.dataset = {};
    this.classList = { toggle() {}, add() {} };
    this.listeners = new Map();
    this.selectedOptions = [{ textContent: this.value }];
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...nodes) { this.children = [...(this.children || []), ...nodes]; }
  replaceChildren(...nodes) { this.children = nodes; }
  querySelector(selector) { return selector === "span" ? new FakeElement("span") : null; }
  setAttribute() {}
}
const elements = new Map();
const document = {
  title: "",
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  addEventListener() {},
  createElement() { return new FakeElement(); },
  createTextNode(textContent) { return { textContent }; },
};
const capabilities = {
  provider: "deterministic",
  modes: [
    { mode: "fast", behavior: { version: 1 }, state: "locally_controlled", deterministicGlossary: true },
    { mode: "balanced", behavior: { version: 1 }, state: "native", deterministicGlossary: false },
    { mode: "accurate", behavior: { version: 1 }, state: "experimental", deterministicGlossary: false, reason: "Not enabled" },
  ],
  defaultMode: "fast",
};
globalThis.window = {
  location: { search: "", hash: "", hostname: "localhost", href: "http://localhost:4207/" },
  WebSocket: class {},
  addEventListener() {},
  clearTimeout() {},
  setTimeout() {},
  history: { replaceState() {} },
};
globalThis.document = document;
globalThis.fetch = async (url) => {
  if (String(url).endsWith("/api/capabilities")) {
    return { ok: true, status: 200, json: async () => ({ dataAdmission: "approved_poc_content", translation: capabilities }), text: async () => JSON.stringify({ dataAdmission: "approved_poc_content", translation: capabilities }) };
  }
  return { ok: true, status: 200, json: async () => ({ glossaryVersion: "v1" }), text: async () => JSON.stringify({ glossaryVersion: "v1" }) };
};
await import(${JSON.stringify(appUrl.href)});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const file = document.getElementById("glossary-file");
file.files = [{ name: "terms.csv", arrayBuffer: async () => new TextEncoder().encode("id,source,target\\n").buffer }];
const submit = document.getElementById("glossary-form").listeners.get("submit")?.[0];
await submit?.({ preventDefault() {} });
document.getElementById("translation-mode").value = "balanced";
const change = document.getElementById("translation-mode").listeners.get("change")?.[0];
change?.({});
await new Promise((resolve) => setImmediate(resolve));
const status = document.getElementById("glossary-status");
const importButton = document.getElementById("import-glossary");
const clearButton = document.getElementById("clear-glossary");
process.stdout.write(JSON.stringify({ status: status.textContent, fileValue: file.value, importHidden: importButton.hidden, importDisabled: importButton.disabled, clearDisabled: clearButton.disabled }));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as GlossaryModeProbe;
}

interface GlossarySnapshotTransitionProbe {
  readonly importedHeader: string;
  readonly clearedHeader: string;
  readonly status: string;
  readonly terminalStatus: string;
}

function probeGlossarySnapshotTransition(): GlossarySnapshotTransitionProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("glossary-snapshot-transition-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const script = `
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.textContent = "";
    this.value = id === "language-a" ? "en-US" : id === "language-b" ? "zh-TW" : "";
    this.files = [];
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.selectedOptions = [{ textContent: this.value }];
    this.classList = {
      _set: new Set(),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList._set.has(name) : Boolean(force);
        if (next) this.classList._set.add(name); else this.classList._set.delete(name);
        return next;
      },
      add: (...names) => names.forEach((name) => this.classList._set.add(name)),
      remove: (...names) => names.forEach((name) => this.classList._set.delete(name)),
    };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(...nodes) {
    for (const node of nodes.reverse()) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.unshift(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    if (selector === "span") return this._span || (this._span = new FakeElement("span"));
    if (["p", "small", "strong", "time"].includes(selector)) {
      return this.children.find((child) => child.tagName === selector) || null;
    }
    if (selector === ".empty-state") {
      return this.children.find((child) => child.className === "empty-state") || null;
    }
    return null;
  }
  querySelectorAll(selector) {
    if (selector === ".event-item") return this.children.filter((child) => child.className?.includes("event-item"));
    return this.children.filter((child) => child.tagName === selector);
  }
  setAttribute() {}
  scrollIntoView() {}
}
const elements = new Map();
const document = {
  title: "",
  getElementById(id) {
    if (!elements.has(id)) {
      const created = new FakeElement(id);
      created.tagName = "div";
      elements.set(id, created);
    }
    return elements.get(id);
  },
  addEventListener() {},
  createElement(tagName) {
    const created = new FakeElement();
    created.tagName = tagName;
    return created;
  },
  createTextNode(textContent) { return { textContent }; },
};
class RecordingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    this.readyState = RecordingWebSocket.OPEN;
    this.listeners = new Map();
    socketInstances.push(this);
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
  close() { this.readyState = 3; }
}
const socketInstances = [];
const capabilities = {
  provider: "deterministic",
  modes: [
    { mode: "fast", behavior: { version: 1 }, state: "locally_controlled", deterministicGlossary: true },
    { mode: "balanced", behavior: { version: 1 }, state: "native", deterministicGlossary: false },
    { mode: "accurate", behavior: { version: 1 }, state: "experimental", deterministicGlossary: false, reason: "Not enabled" },
  ],
  defaultMode: "fast",
};
const importedSnapshot = {
  sessionId: "session-imported",
  languages: { A: "en-US", B: "zh-TW" },
  eventCursor: 0,
  provider: "deterministic",
  translationMode: "fast",
  behaviorVersion: 1,
  deterministicGlossary: true,
  translationState: "locally_controlled",
  state: "created",
  participantConsent: { A: { consented: false }, B: { consented: false } },
  recorderArmState: "awaiting_consents",
  recordingArmed: false,
  endpointGrants: [],
  glossaryHash: "old-hash",
};
const emptySnapshot = { ...importedSnapshot, sessionId: "session-empty", glossaryHash: undefined };
let sessionRequests = 0;
globalThis.window = {
  location: { search: "", hash: "", hostname: "localhost", href: "http://localhost:4207/" },
  WebSocket: RecordingWebSocket,
  addEventListener() {},
  clearTimeout() {},
  setTimeout() { return 0; },
  history: { replaceState() {} },
};
globalThis.document = document;
globalThis.WebSocket = RecordingWebSocket;
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.endsWith("/api/capabilities")) {
    return { ok: true, status: 200, json: async () => ({ dataAdmission: "approved_poc_content", translation: capabilities }), text: async () => JSON.stringify({ dataAdmission: "approved_poc_content", translation: capabilities }) };
  }
  if (path.endsWith("/api/glossaries")) {
    return { ok: true, status: 200, json: async () => ({ glossaryVersion: "v1" }), text: async () => JSON.stringify({ glossaryVersion: "v1" }) };
  }
const snapshot = sessionRequests++ === 0 ? importedSnapshot : emptySnapshot;
  return { ok: true, status: 200, json: async () => snapshot, text: async () => JSON.stringify(snapshot) };
};
await import(${JSON.stringify(appUrl.href)});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const file = document.getElementById("glossary-file");
file.files = [{ name: "terms.csv", arrayBuffer: async () => new TextEncoder().encode("id,source,target\\n").buffer }];
const importListener = document.getElementById("glossary-form").listeners.get("submit")?.[0];
await importListener?.({ preventDefault() {} });
const createListener = document.getElementById("session-form").listeners.get("submit")?.[0];
await createListener?.({ preventDefault() {} });
const importedHeader = document.getElementById("session-translation").textContent;
const eventSocket = socketInstances[0];
eventSocket?.emit("message", {
  data: JSON.stringify({
    sessionId: "session-imported",
    cursor: 1,
    type: "session_state",
    data: { state: "closed", status: "closed" },
  }),
});
eventSocket?.emit("message", {
  data: JSON.stringify({
    sessionId: "session-imported",
    cursor: 2,
    type: "session_state",
    data: {
      state: "closed",
      status: "closed",
      evidenceFinalization: {
        status: "FINALIZATION_FAILED",
        failureCode: "integrity_verification_failed",
        recovery: "rebuild_from_spool",
      },
    },
  }),
});
const terminalStatus = document.getElementById("evidence-finalization-status").textContent;
document.getElementById("language-a").value = "fr-FR";
document.getElementById("language-a").listeners.get("change")?.[0]?.({});
document.getElementById("clear-glossary").listeners.get("click")?.[0]?.({});
await createListener?.({ preventDefault() {} });
const clearedHeader = document.getElementById("session-translation").textContent;
const status = document.getElementById("glossary-status").textContent;
process.stdout.write(JSON.stringify({ importedHeader, clearedHeader, status, terminalStatus }));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as GlossarySnapshotTransitionProbe;
}

interface DataAdmissionGateProbe {
  readonly createDisabled: boolean;
  readonly detail: string;
  readonly globalStatus: string;
  readonly postCount: number;
  readonly error: string;
}

function probeDataAdmissionGate(
  admission: "approved_poc_content" | "synthetic_only",
): DataAdmissionGateProbe {
  const appUrl = pathToFileURL(resolve(process.cwd(), "web", "app.js"));
  appUrl.searchParams.set("data-admission-gate-test", randomUUID());
  const temporaryDirectory = resolve(process.cwd(), "work", "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  const script = `
const admission = ${JSON.stringify(admission)};
class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.value = id === "language-a" ? "en-US" : id === "language-b" ? "zh-TW" : "";
    this.files = [];
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.selectedOptions = [{ textContent: this.value }];
    this.classList = {
      _set: new Set(),
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList._set.has(name) : Boolean(force);
        if (next) this.classList._set.add(name); else this.classList._set.delete(name);
        return next;
      },
      add: (...names) => names.forEach((name) => this.classList._set.add(name)),
      remove: (...names) => names.forEach((name) => this.classList._set.delete(name)),
    };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  append(...nodes) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  querySelector(selector) {
    if (selector === "span") return this._span || (this._span = new FakeElement("span"));
    if (selector === ".empty-state") return this.children.find((child) => child.className === "empty-state") || null;
    return null;
  }
  querySelectorAll() { return []; }
  setAttribute() {}
  scrollIntoView() {}
}
const elements = new Map();
const document = {
  title: "",
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  addEventListener() {},
  createElement() { return new FakeElement(); },
  createTextNode(textContent) { return { textContent }; },
};
class RecordingWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() { this.readyState = RecordingWebSocket.OPEN; this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  close() { this.readyState = 3; }
}
const capabilities = {
  provider: "deterministic",
  modes: [
    { mode: "fast", behavior: { version: 1 }, state: "locally_controlled", deterministicGlossary: true },
    { mode: "balanced", behavior: { version: 1 }, state: "native", deterministicGlossary: false },
    { mode: "accurate", behavior: { version: 1 }, state: "experimental", deterministicGlossary: false, reason: "Not enabled" },
  ],
  defaultMode: "fast",
};
const snapshot = {
  sessionId: "session-approved",
  languages: { A: "en-US", B: "zh-TW" },
  eventCursor: 0,
  provider: "deterministic",
  translationMode: "fast",
  behaviorVersion: 1,
  deterministicGlossary: true,
  translationState: "locally_controlled",
  state: "created",
  participantConsent: { A: { consented: false }, B: { consented: false } },
  recorderArmState: "awaiting_consents",
  recordingArmed: false,
  endpointGrants: [],
};
let postCount = 0;
function response(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}
globalThis.window = {
  location: { search: "", hash: "", hostname: "localhost", href: "http://localhost:4207/" },
  WebSocket: RecordingWebSocket,
  addEventListener() {},
  clearTimeout() {},
  setTimeout() { return 0; },
  history: { replaceState() {} },
};
globalThis.document = document;
globalThis.WebSocket = RecordingWebSocket;
globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.endsWith("/api/capabilities")) return response({ dataAdmission: admission, translation: capabilities });
  if (path.endsWith("/api/sessions")) {
    postCount += 1;
    return response(snapshot);
  }
  return response({});
};
await import(${JSON.stringify(appUrl.href)});
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
await new Promise((resolve) => setImmediate(resolve));
const create = document.getElementById("create-session");
const initialCreateDisabled = create.disabled;
const submit = document.getElementById("session-form").listeners.get("submit")?.[0];
await submit?.({ preventDefault() {} });
process.stdout.write(JSON.stringify({
  createDisabled: initialCreateDisabled,
  detail: document.getElementById("translation-mode-detail").textContent,
  globalStatus: document.getElementById("global-status").textContent,
  postCount,
  error: document.getElementById("session-form-error").textContent,
}));
`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        TMPDIR: temporaryDirectory,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout) as DataAdmissionGateProbe;
}

test("operator language selectors expose only the English and Traditional Chinese POC pair", async () => {
  const html = await readFile(resolve(process.cwd(), "web", "index.html"), "utf8");
  assert.match(html, /id="clear-glossary"/u);
  const optionValues = (id: string): string[] => {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`, "u"));
    if (select === null) assert.fail(`missing ${id} selector`);
    const selectContents = select[1];
    if (selectContents === undefined) assert.fail(`missing ${id} options`);
    return Array.from(
      selectContents.matchAll(/<option value="([^"]+)"/gu),
      (match) => {
        const value = match[1];
        if (value === undefined) assert.fail(`missing option value in ${id}`);
        return value;
      },
    );
  };

  assert.deepEqual(optionValues("language-a"), ["en-US", "zh-TW"]);
  assert.deepEqual(optionValues("language-b"), ["zh-TW", "en-US"]);
});

test("an insecure remote participant bootstrap blocks before constructing or connecting grant-bearing transports", () => {
  const probe = probeParticipantBootstrap("relay.example.test", false);

  assert.deepEqual(probe.constructedUrls, []);
  assert.deepEqual(probe.accessWrites, []);
  assert.deepEqual(probe.sockets, []);
  assert.equal(probe.errorVisible, true);
  assert.match(probe.error, /HTTPS/u);
  assert.equal(probe.startDisabled, true);
});

test("loopback participant bootstrap remains a trusted local transport", () => {
  const probe = probeParticipantBootstrap("localhost", false);

  assert.deepEqual(probe.accessWrites, [["access", "participant-grant"]]);
  assert.deepEqual(probe.constructedUrls, [
    "http://localhost:4207/ws/events/session-1?access=participant-grant",
  ]);
  assert.deepEqual(probe.sockets, [
    "ws://localhost:4207/ws/events/session-1?access=participant-grant",
  ]);
  assert.equal(probe.errorVisible, false);
});

test("participant recorder-state events do not dereference operator-only DOM", () => {
  const probe = probeParticipantBootstrap("localhost", false, true);
  assert.equal(probe.errorVisible, false);
});

test("participant event streams reject stale numeric cursors", () => {
  const probe = probeParticipantBootstrap("localhost", false, false, true);
  assert.equal(probe.latencyValue, "10 ms");
});

test("current event sockets reject wrong-session envelopes, including delayed blobs", () => {
  const probe = probeParticipantBootstrap("localhost", false, false, false, false, true);
  assert.equal(probe.latencyValue, "12 ms");
  assert.match(probe.sockets[1] || "", /[?&]after=2(?:&|$)/u);
});

test("participant generation cuts mark the destination caption immediately", () => {
  const probe = probeParticipantBootstrap("localhost", false, false, false, true);
  assert.match(probe.targetCaption, /cut\/cancelled/iu);
});

test("target lifecycle correlates projected provider playout IDs without sibling bleed", () => {
  const probe = probeOperatorSegmentLifecycle();
  assert.equal(probe.lines.length, 3);
  const first = probe.lines.find((line) => line.segmentId === "turn-det:target_transcript");
  const second = probe.lines.find((line) => line.segmentId === "turn-pal:segment:0");
  const third = probe.lines.find((line) => line.segmentId === "target_transcript-provider-7");
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.equal(first.text, "deterministic revised");
  assert.equal(second.text, "palabra");
  assert.equal(third.text, "native");
  assert.equal(first.validated, "false");
  assert.equal(first.played, "false");
  assert.equal(second.played, "true");
  assert.equal(third.played, "false");
  assert.match(first.stateKey, /\[1,"turn-det","turn-det:target_transcript",1\]/u);
  assert.match(second.label, /validated.*played/iu);
  assert.match(third.label, /validated/iu);
  assert.doesNotMatch(third.label, /played/iu);
});

test("operator event-gap resync seeds the authoritative cursor without reconnect looping", () => {
  const probe = probeOperatorSegmentLifecycle(true);
  assert.equal(probe.socketUrls.length, 2);
  assert.ok(probe.socketUrls.every((url) => /[?&]after=7(?:&|$)/u.test(url)));
});

test("late event-gap snapshots cannot clobber a newer session or resync promise", () => {
  const probe = probeOperatorResyncFence();
  assert.equal(probe.afterLateASessionId, "session-b");
  assert.equal(probe.finalSessionId, "session-b");
  assert.equal(probe.resyncGetCount, 2);
});

test("active VAD interrupts local playout before close-race cleanup", () => {
  const probe = probeParticipantStopCleanup();
  assert.deepEqual(probe.playoutMessages, [{ type: "interrupt", lane: "B_TO_A" }]);
  assert.equal(probe.supervisorStop, true);
  assert.equal(probe.trackStops, 1);
  assert.equal(probe.disconnects, 4);
  assert.equal(probe.contextClosed, 1);
});

test("offline VAD recovery sends one authoritative pair and does not replay it after clear", () => {
  const probe = probeParticipantStopCleanup(true);
  assert.deepEqual(probe.recoverySpeechControls, ["speech_start", "speech_end"]);
  assert.deepEqual(probe.secondRecoverySpeechControls, []);
  assert.equal(probe.clearAppliedCount, 1);
});

test("pause reconnect keeps capture stopped until resume re-advertises active capture", () => {
  const probe = probeParticipantStopCleanup(false, true);
  assert.equal(probe.pausedTrackEnabled, false);
  assert.equal(probe.pausedReadiness.at(-1), "stopped");
  assert.match(probe.pausedConnection, /Microphone stopped/u);
  assert.equal(probe.resumedTrackEnabled, true);
  assert.equal(probe.resumedReadiness.at(-1), "browser_capture_active");
  assert.match(probe.resumedConnection, /Live/u);
});

test("participant event-history gaps stop audio and fail closed without reconnect", () => {
  const probe = probeParticipantStopCleanup(false, false, true);
  assert.equal(probe.trackStops, 1);
  assert.equal(probe.reconnectTimers, 0);
  assert.match(probe.connection, /reload\/rejoin/iu);
  assert.match(probe.liveStatus, /event history is incomplete/iu);
});

test("missing or muted microphone tracks never advertise active capture", () => {
  for (const mode of ["empty", "muted"] as const) {
    const probe = probeParticipantStopCleanup(false, false, false, mode);
    assert.equal(probe.activeReadiness, false, mode);
    assert.equal(probe.liveVisible, false, mode);
    assert.match(probe.error, /no active microphone track/iu, mode);
    assert.equal(probe.socketClosed > 0, true, mode);
  }
});

test("switching to a non-glossary-capable mode clears imported terminology", () => {
  const probe = probeGlossaryModeControls();
  assert.equal(probe.status, "Not imported");
  assert.equal(probe.fileValue, "");
  assert.equal(probe.importHidden, true);
  assert.equal(probe.importDisabled, true);
  assert.equal(probe.clearDisabled, true);
});

test("glossary snapshot transitions do not retain a removed hash in the session header", () => {
  const probe = probeGlossarySnapshotTransition();
  assert.match(probe.importedHeader, /old-hash/u);
  assert.doesNotMatch(probe.clearedHeader, /old-hash/u);
  assert.equal(probe.status, "Not imported");
  assert.equal(probe.terminalStatus, "Finalization failed — verdict blocked");
});

test("synthetic-only data admission disables human room creation before POST", () => {
  const synthetic = probeDataAdmissionGate("synthetic_only");
  assert.equal(synthetic.createDisabled, true);
  assert.equal(synthetic.postCount, 0);
  assert.match(synthetic.detail, /Synthetic benchmark only/u);
  assert.match(synthetic.detail, /not approved for human sessions/u);
  assert.equal(synthetic.globalStatus, "Synthetic benchmark only");
  assert.match(synthetic.error, /Synthetic benchmark only/u);

  const approved = probeDataAdmissionGate("approved_poc_content");
  assert.equal(approved.createDisabled, false);
  assert.equal(approved.postCount, 1);
  assert.doesNotMatch(approved.detail, /Synthetic benchmark only/u);
  assert.equal(approved.error, "");
});

test("web UI fences retired streams and bounds operator lifecycle state", async () => {
  const app = await readFile(resolve(process.cwd(), "web", "app.js"), "utf8");
  assert.match(app, /state\.eventEpoch\s*!==\s*eventEpoch/u);
  assert.match(app, /state\.eventSessionId\s*!==\s*sessionId/u);
  assert.match(app, /parseEventMessage\(event\.data, socket, eventEpoch, sessionId\)/u);
  assert.match(app, /canonicalEventSessionId\(envelope\.sessionId\)/u);
  assert.match(app, /if \(!eventBelongsToSession\(envelope, sessionId\)\) return/u);
  assert.match(app, /normalizeDataAdmission\(capabilities\.dataAdmission\)/u);
  assert.match(app, /state\.dataAdmission !== "approved_poc_content"/u);
  assert.match(app, /Synthetic benchmark only: this profile is not approved for human sessions/u);
  assert.match(app, /function isTerminalEvidenceFinalization\(envelope\)/u);
  assert.match(app, /route\.role !== "operator"/u);
  assert.match(app, /data\.state !== "closed"/u);
  assert.match(app, /data\.status !== "closed"/u);
  assert.match(app, /normalizeEvidenceFinalization\(data\.evidenceFinalization\)/u);
  assert.match(app, /if \(state\.eventsClosed && !isTerminalEvidenceFinalization\(envelope\)\) return/u);
  assert.match(app, /audio\.socketSupervisor\.socket\s*!==\s*sourceSocket/u);
  assert.match(app, /state\.mediaEpoch\s*!==\s*epoch/u);
  assert.doesNotMatch(app, /state\.pendingMediaMessages/u);
  assert.match(app, /MAX_BARGE_FEED_ITEMS\s*=\s*40/u);
  assert.match(app, /state\.evidence\.bargeStages\.size\s*>\s*MAX_BARGE_FEED_ITEMS/u);
  assert.match(app, /microphone:\s*"stopped"/u);
  assert.match(app, /line\.dataset\.turnId\s*=\s*update\.turnId/u);
  assert.match(app, /line\.dataset\.generation\s*=\s*String\(generationRef\.generation\)/u);
  assert.match(app, /line\.dataset\.itemId\s*=\s*segmentCorrelation\(update\)/u);
  assert.match(app, /segmentId\.match\(\/\^\(source\|target\|terminology\|audio\)/u);
  assert.match(app, /line\.dataset\.validated\s*=\s*"true"/u);
  assert.match(app, /line\.dataset\.played\s*=\s*"true"/u);
  assert.match(app, /line\.dataset\.cut\s*=\s*"true"/u);
  assert.match(app, /line\.dataset\.stateKey\s*=\s*JSON\.stringify\(\[[\s\S]*update\.revision/u);
  assert.match(app, /pendingValidation\s*:\s*new Map\(\)/u);
  assert.match(app, /MAX_PENDING_VALIDATION_ITEMS\s*=\s*256/u);
  assert.match(app, /retainPendingValidation\(key\)/u);
  assert.match(app, /pendingPlayed\s*:\s*new Map\(\)/u);
  assert.match(app, /MAX_PENDING_PLAYED_ITEMS\s*=\s*256/u);
  assert.match(app, /retainPendingPlayed\(key\)/u);
  assert.match(app, /consumePendingPlayed\(envelope, update\)/u);
  assert.match(app, /clearPendingPlayed\(envelope\.lane, previousGeneration\)/u);
  assert.match(app, /JSON\.stringify\(\[\s*sessionId,\s*lane,\s*generation,\s*identity\.turnId,\s*identity\.itemId,\s*revision/u);
  assert.match(app, /JSON\.stringify\(\[lane, generation, identity\.turnId, identity\.itemId, revision\]\)/u);
  assert.match(app, /markTargetSegmentPlayed\(envelope, value\)/u);
  const latencyBlock = app.slice(app.indexOf("function updateLatency"), app.indexOf("function updateRoomState"));
  assert.doesNotMatch(latencyBlock, /markTargetSegmentPlayed/u);
  assert.match(app, /Translation cut\/cancelled/u);
  assert.match(app, /glossary " \+ glossaryVersion/u);
  assert.match(app, /function clearImportedGlossary\(\)/u);
  assert.match(app, /importButton\.hidden = !allowed/u);
  assert.match(app, /clear-glossary/u);
  assert.match(app, /const badge = \$\("recording-badge"\)/u);
  assert.match(app, /if \(badge\) badge\.classList\.toggle/u);
  assert.match(app, /const cutCount = \$\("cut-count"\)/u);
  assert.match(app, /if \(cutCount\) cutCount\.textContent/u);
  assert.match(app, /numericCursor\) && numericCursor <= state\.lastCursor/u);
  assert.match(app, /track\.addEventListener\?\.\("ended"/u);
  assert.match(app, /track\.addEventListener\?\.\("mute"/u);
  assert.match(app, /audio\.context\.addEventListener\?\.\("statechange"/u);
  assert.match(app, /track\.enabled = false/u, "pause must disable microphone tracks");
  assert.match(app, /track\.enabled = true/u, "resume must re-enable microphone tracks");
  assert.match(app, /track\.enabled === false/u, "muted or disabled tracks cannot report active capture");
  assert.match(app, /track\.muted !== true/u, "muted tracks cannot report active capture");
  assert.match(app, /The browser returned no active microphone track/u);
  assert.match(app, /pendingMediaClears/u, "early media clears must survive worklet initialization");
  assert.match(app, /pendingSpeechRecovery/u, "offline VAD interruption recovery must wait for server controls");
  assert.doesNotMatch(app, /type:\s*["']resume["']/u, "client must not self-authorize playout recovery");
  assert.match(app, /event_cursor_gap/u);
  assert.match(app, /event_stream_overflow/u);
  assert.match(app, /snapshot\.languages/u);
  assert.match(app, /snapshot\.eventCursor/u);
  assert.match(app, /authoritative event cursor/u);
  assert.match(app, /state\.glossaryImportEpoch \+= 1;\s+if \(!snapshot/u);
  assert.match(app, /authoritative session languages/u);
  assert.match(app, /speechRecoveryAttempted/u);
  assert.match(app, /state\.roomStatus !== "paused"/u);
  assert.match(app, /updateParticipantCaptureReadiness\(state\.audio, true, "Live"\)/u);
  assert.match(app, /if \(!participantAudio \|\| state\.audio !== participantAudio\) return/u);
});

test("operator start gate requires actual capture, headphone attestation, and both provider preparations", async () => {
  const contract = await loadContract();
  const ready = {
    participantConsent: { A: true, B: true },
    connected: { A: true, B: true },
    recorderArmState: "armed",
    recordingArmed: true,
    participantReadiness: {
      A: {
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      },
      B: {
        microphone: "browser_capture_active",
        headphones: "self_attested",
        source: "participant_browser_self_report",
      },
    },
    providerReadiness: {
      A_TO_B: {
        readiness: "local_route_validated",
        remoteConnection: "deferred_until_first_turn",
      },
      B_TO_A: {
        readiness: "remote_task_ready",
        remoteConnection: "connected",
      },
    },
  };

  assert.equal(contract.isOperatorStartGateSatisfied(ready), true);
  assert.equal(contract.isOperatorStartGateSatisfied({
    ...ready,
    participantReadiness: {
      ...ready.participantReadiness,
      B: undefined,
    },
  }), false, "a joined socket is not a microphone/headphone report");
  assert.equal(contract.isOperatorStartGateSatisfied({
    ...ready,
    participantReadiness: {
      ...ready.participantReadiness,
      A: {
        microphone: "browser_capture_active",
        headphones: "not_attested",
        source: "participant_browser_self_report",
      },
    },
  }), false, "active capture without a headphone self-attestation is insufficient");
  assert.equal(contract.isOperatorStartGateSatisfied({
    ...ready,
    participantReadiness: {
      A: {
        microphone: "not_applicable",
        headphones: "not_applicable",
        source: "fake_telephony_fixture",
      },
      B: ready.participantReadiness.B,
    },
  }), true, "the explicitly modeled fake-telephony fixture remains a qualifying capture source");
  assert.equal(contract.isOperatorStartGateSatisfied({
    ...ready,
    providerReadiness: {
      ...ready.providerReadiness,
      B_TO_A: undefined,
    },
  }), false, "a provider route that is not prepared blocks Start");
  assert.equal(contract.isOperatorStartGateSatisfied({
    ...ready,
    connected: { A: true, B: false },
  }), false, "both endpoint connections remain required");
});

test("evidence finalization permits only a verified sealed projection or a bounded blocking failure", async () => {
  const contract = await loadContract();
  const tracks = {
    source_a: { sha256: "a".repeat(64), frameCount: 1, byteCount: 960 },
    source_b: { sha256: "b".repeat(64), frameCount: 2, byteCount: 1920 },
    playout_to_a: { sha256: "c".repeat(64), frameCount: 3, byteCount: 2880 },
    playout_to_b: { sha256: "d".repeat(64), frameCount: 4, byteCount: 3840 },
  };
  assert.deepEqual(contract.normalizeEvidenceFinalization({
    status: "sealed",
    manifestSha256: "e".repeat(64),
    encryptedLedgerSha256: "f".repeat(64),
    finalChainSha256: "1".repeat(64),
    retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    tracks,
  }), {
    status: "sealed",
    manifestSha256: "e".repeat(64),
    encryptedLedgerSha256: "f".repeat(64),
    finalChainSha256: "1".repeat(64),
    retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    tracks,
  });
  assert.deepEqual(contract.normalizeEvidenceFinalization({
    status: "FINALIZATION_FAILED",
    failureCode: "integrity_verification_failed",
    recovery: "quarantine_delete_rerun",
  }), {
    status: "FINALIZATION_FAILED",
    failureCode: "integrity_verification_failed",
    recovery: "quarantine_delete_rerun",
  });
  assert.throws(() => contract.normalizeEvidenceFinalization({
    status: "sealed",
    manifestSha256: "e".repeat(64),
    encryptedLedgerSha256: "f".repeat(64),
    finalChainSha256: "1".repeat(64),
    retentionDeadlineAt: "2026-08-23T00:00:00.000Z",
    tracks,
    sessionId: "must-never-reach-operator-ui",
  }), /safe finalization fields/u);
  assert.throws(() => contract.normalizeEvidenceFinalization({
    status: "sealed",
    manifestSha256: "e".repeat(64),
    encryptedLedgerSha256: "f".repeat(64),
    finalChainSha256: "1".repeat(64),
    retentionDeadlineAt: "not-a-canonical-utc-time",
    tracks,
  }), /UTC/u);
});

test("terminal clear receipts are bounded by clearId and retain exact recent replay correlations", async () => {
  const contract = await loadContract();
  const first = contract.retainTerminalClearReceipts([], {
    lane: "A_TO_B",
    generation: 3,
    clearId: "clear-3-a",
  }, 2);
  const second = contract.retainTerminalClearReceipts(first, {
    lane: "A_TO_B",
    generation: 4,
    clearId: "clear-4-a",
  }, 2);
  const bounded = contract.retainTerminalClearReceipts(second, {
    lane: "A_TO_B",
    generation: 5,
    clearId: "clear-5-a",
  }, 2);
  assert.deepEqual(bounded, [
    { lane: "A_TO_B", generation: 4, clearId: "clear-4-a" },
    { lane: "A_TO_B", generation: 5, clearId: "clear-5-a" },
  ]);
  const replayed = contract.retainTerminalClearReceipts(bounded, {
    lane: "A_TO_B",
    generation: 4,
    clearId: "clear-4-a",
  }, 2);
  assert.deepEqual(replayed, [
    { lane: "A_TO_B", generation: 5, clearId: "clear-5-a" },
    { lane: "A_TO_B", generation: 4, clearId: "clear-4-a" },
  ]);
  const distinctSameGeneration = contract.retainTerminalClearReceipts(replayed, {
    lane: "B_TO_A",
    generation: 4,
    clearId: "clear-4-b",
  }, 2);
  assert.equal(
    distinctSameGeneration.some((receipt) => receipt.clearId === "clear-4-b"),
    true,
    "a distinct clearId must not be collapsed solely because generation matches",
  );
  assert.throws(() => contract.retainTerminalClearReceipts(replayed, {
    lane: "B_TO_A",
    generation: 4,
    clearId: "clear-4-a",
  }, 2), /already belongs to/u);
  let longRunning: readonly Readonly<{
    lane: "A_TO_B" | "B_TO_A";
    generation: number;
    clearId: string;
  }>[] = [];
  for (let generation = 0; generation < 300; generation += 1) {
    longRunning = contract.retainTerminalClearReceipts(longRunning, {
      lane: "A_TO_B",
      generation,
      clearId: "clear-cycle-" + generation,
    });
  }
  assert.equal(longRunning.length, 256, "terminal clear history must remain bounded across many cycles");
  const recentRetry = contract.retainTerminalClearReceipts(longRunning, {
    lane: "A_TO_B",
    generation: 299,
    clearId: "clear-cycle-299",
  });
  assert.equal(recentRetry.length, 256);
  assert.deepEqual(recentRetry.at(-1), {
    lane: "A_TO_B",
    generation: 299,
    clearId: "clear-cycle-299",
  }, "a recent exact clear correlation remains retryable after bounded eviction");
});

test("outstanding clear requests stay bounded without converting evicted work into ACK receipts", async () => {
  const contract = await loadContract();
  const first = contract.retainOutstandingClearRequests([], {
    lane: "A_TO_B",
    generation: 1,
    clearId: "pending-1",
  }, 2);
  const second = contract.retainOutstandingClearRequests(first, {
    lane: "A_TO_B",
    generation: 2,
    clearId: "pending-2",
  }, 2);
  const bounded = contract.retainOutstandingClearRequests(second, {
    lane: "A_TO_B",
    generation: 3,
    clearId: "pending-3",
  }, 2);
  assert.deepEqual(bounded, [
    { lane: "A_TO_B", generation: 2, clearId: "pending-2" },
    { lane: "A_TO_B", generation: 3, clearId: "pending-3" },
  ], "the oldest unacknowledged request is dropped rather than acknowledged");
  const replayed = contract.retainOutstandingClearRequests(bounded, {
    lane: "A_TO_B",
    generation: 2,
    clearId: "pending-2",
  }, 2);
  assert.deepEqual(replayed, [
    { lane: "A_TO_B", generation: 3, clearId: "pending-3" },
    { lane: "A_TO_B", generation: 2, clearId: "pending-2" },
  ], "an exact pending replay remains the newest retry");
  assert.throws(() => contract.retainOutstandingClearRequests(replayed, {
    lane: "B_TO_A",
    generation: 2,
    clearId: "pending-2",
  }, 2), /already belongs to/u);

  let longRunning: readonly Readonly<{
    lane: "A_TO_B" | "B_TO_A";
    generation: number;
    clearId: string;
  }>[] = [];
  for (let generation = 0; generation < 300; generation += 1) {
    longRunning = contract.retainOutstandingClearRequests(longRunning, {
      lane: "A_TO_B",
      generation,
      clearId: "pending-cycle-" + generation,
    });
  }
  assert.equal(longRunning.length, 256, "unacknowledged clear work must remain hard-bounded");
  assert.equal(longRunning.some((request) => request.clearId === "pending-cycle-0"), false);
  const recentRetry = contract.retainOutstandingClearRequests(longRunning, {
    lane: "A_TO_B",
    generation: 299,
    clearId: "pending-cycle-299",
  });
  assert.equal(recentRetry.length, 256);
  assert.deepEqual(recentRetry.at(-1), {
    lane: "A_TO_B",
    generation: 299,
    clearId: "pending-cycle-299",
  }, "a recent unacknowledged clear remains eligible for a real later worklet ACK");
});

test("audible-start lag is a scoped acknowledgement metric", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizePlayoutLag({
    scope: "server_to_audible_ack",
    side: "B",
    sequence: 4,
    audibleStartLagMs: 82.5,
    turnId: "turn-4",
    segmentId: "target:segment-4",
    revision: 2,
    sourceSide: "A",
    targetSide: "B",
  }), {
    scope: "server_to_audible_ack",
    side: "B",
    sequence: 4,
    audibleStartLagMs: 82.5,
    turnId: "turn-4",
    segmentId: "target:segment-4",
    revision: 2,
    sourceSide: "A",
    targetSide: "B",
  });
  assert.throws(() => contract.normalizePlayoutLag({
    scope: "server_to_audible_ack",
    side: "B",
    sequence: 4,
    audibleStartLagMs: -1,
  }), /non-negative/u);
  assert.throws(() => contract.normalizePlayoutLag({
    scope: "server_to_audible_ack",
    side: "B",
    sequence: 4,
    audibleStartLagMs: 82.5,
    turnId: "turn-4",
  }), /identity must include/u);
});

test("terminology gates retain provenance without plaintext targets or evidence references", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizeTerminologyGate({
    status: "bypassed",
    turnId: "turn-1",
    segmentId: "segment-1",
    revision: 1,
    final: true,
    glossaryHash: "a".repeat(64),
    entryIds: ["main-spindle"],
    termId: "main-spindle",
    confidence: 0.42,
    code: "TRANSCRIPTION_LOW_CONFIDENCE",
    message: "Speech transcription confidence was below the configured threshold.",
    sourceSide: "A",
    targetSide: "B",
  }), {
    status: "bypassed",
    glossaryHash: "a".repeat(64),
    entryIds: ["main-spindle"],
    termId: "main-spindle",
    confidence: 0.42,
    code: "TRANSCRIPTION_LOW_CONFIDENCE",
    message: "Speech transcription confidence was below the configured threshold.",
    sourceSide: "A",
    targetSide: "B",
  });
  assert.throws(() => contract.normalizeTerminologyGate({
    status: "bound",
    glossaryHash: "a".repeat(64),
    entryIds: [],
    evidenceRef: "opaque-but-internal",
  }), /safe terminology fields/u);
  assert.throws(() => contract.normalizeTerminologyGate({
    status: "authorized",
    glossaryHash: "a".repeat(64),
    entryIds: ["main-spindle"],
    text: "Plaintext target must remain canonical-target-only.",
  }), /safe terminology fields/u);
  assert.throws(() => contract.normalizeTerminologyGate({
    status: "bypassed",
    glossaryHash: "a".repeat(64),
    entryIds: ["main-spindle"],
    guaranteedTargetExact: ["Plaintext target must remain canonical-target-only."],
  }), /safe terminology fields/u);
});

test("recorder preflight stays distinct from arm state and excludes session identifiers", async () => {
  const contract = await loadContract();
  const ready = contract.normalizeRecorderPreflight({
    status: "ready",
    checkedAtMonoMs: 123,
    requiredFreeBytes: "67108864",
    availableFreeBytes: "134217728",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    manifestSha256: "a".repeat(64),
    encryptedSpoolSha256: "b".repeat(64),
    sealedRecordCount: 1,
    sealSha256: "c".repeat(64),
  });
  assert.equal(ready.status, "ready");
  assert.equal("failureCode" in ready, false);
  assert.throws(() => contract.normalizeRecorderPreflight({
    status: "ready",
    checkedAtMonoMs: 123,
    requiredFreeBytes: "67108864",
    availableFreeBytes: "134217728",
    tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"],
    manifestSha256: "a".repeat(64),
    encryptedSpoolSha256: "b".repeat(64),
    sealedRecordCount: 1,
    sealSha256: "c".repeat(64),
    sessionId: "must-not-reach-console",
  }), /only safe preflight fields/u);
});

test("barge lifecycle retains clear correlation without accepting evidence references", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizeBargeLifecycle({
    stage: "playout_clear_acknowledged",
    bargeId: "barge-0001",
    clearId: "clear-0001",
    sourceSide: "A",
    destinationSide: "B",
  }), {
    stage: "playout_clear_acknowledged",
    bargeId: "barge-0001",
    clearId: "clear-0001",
    sourceSide: "A",
    destinationSide: "B",
  });
  assert.deepEqual(contract.normalizeBargeLifecycle({
    stage: "speech_onset",
    bargeId: "barge-0002",
    clearId: "clear-0002",
    sourceSide: "B",
    destinationSide: "B",
  }), {
    stage: "speech_onset",
    bargeId: "barge-0002",
    clearId: "clear-0002",
    sourceSide: "B",
    destinationSide: "B",
  });
  assert.throws(() => contract.normalizeBargeLifecycle({
    stage: "playout_clear_acknowledged",
    bargeId: "barge-0001",
    clearId: "clear-0001",
    sourceSide: "A",
    destinationSide: "B",
    evidenceRef: "must-not-reach-browser",
  }), /immutable causal fields/u);
  assert.throws(() => contract.normalizeBargeLifecycle({
    stage: "made_up",
    bargeId: "barge-0001",
    clearId: "clear-0001",
    sourceSide: "A",
    destinationSide: "B",
  }), /stage/u);
});

test("queue samples retain scope and reject impossible browser backlog claims", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizeQueueSample({
    scope: "browser_playout",
    side: "B",
    depthFrames: 2,
    capacityFrames: 8,
    oldestQueuedAgeMs: 40,
    bufferedAudioMs: 80,
    sourceSide: "A",
    targetSide: "B",
  }), {
    scope: "browser_playout",
    side: "B",
    depthFrames: 2,
    capacityFrames: 8,
    oldestQueuedAgeMs: 40,
    bufferedAudioMs: 80,
    sourceSide: "A",
    targetSide: "B",
  });
  assert.throws(() => contract.normalizeQueueSample({
    scope: "browser_playout",
    side: "B",
    depthFrames: 9,
    capacityFrames: 8,
    bufferedAudioMs: 80,
  }), /cannot exceed capacity/u);
  assert.throws(() => contract.normalizeQueueSample({
    scope: "browser_playout",
    side: "B",
    depthFrames: 2,
    capacityFrames: 8,
  }), /bufferedAudioMs/u);
});

test("provider readiness does not overclaim a remote connection", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizeProviderReadiness({
    readiness: "local_route_validated",
    remoteConnection: "deferred_until_first_turn",
  }), {
    readiness: "local_route_validated",
    remoteConnection: "deferred_until_first_turn",
  });
  assert.deepEqual(contract.normalizeProviderReadiness({
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  }), {
    readiness: "remote_task_ready",
    remoteConnection: "connected",
  });
  assert.throws(() => contract.normalizeProviderReadiness({
    readiness: "local_route_validated",
    remoteConnection: "connected",
  }), /deferred/u);
});

test("participant readiness distinguishes browser capture from a headphone self-attestation", async () => {
  const contract = await loadContract();
  assert.deepEqual(contract.normalizeParticipantReadiness({
    side: "A",
    microphone: "browser_capture_active",
    headphones: "self_attested",
    source: "participant_browser_self_report",
  }), {
    side: "A",
    microphone: "browser_capture_active",
    headphones: "self_attested",
    source: "participant_browser_self_report",
  });
  assert.deepEqual(contract.normalizeParticipantReadiness({
    side: "B",
    microphone: "not_applicable",
    headphones: "not_applicable",
    source: "fake_telephony_fixture",
  }), {
    side: "B",
    microphone: "not_applicable",
    headphones: "not_applicable",
    source: "fake_telephony_fixture",
  });
  assert.throws(() => contract.normalizeParticipantReadiness({
    side: "A",
    microphone: "browser_capture_active",
    headphones: "not_attested",
    source: "participant_browser_self_report",
  }), /self-attested headphones/u);
  assert.throws(() => contract.normalizeParticipantReadiness({
    side: "B",
    microphone: "stopped",
    headphones: "self_attested",
    source: "participant_browser_self_report",
  }), /clear headphone attestation/u);
});

async function loadContract(): Promise<BrowserContract> {
  const url = pathToFileURL(
    resolve(process.cwd(), "web", "public", "browser-contract.js"),
  );
  url.searchParams.set("test", randomUUID());
  return await import(url.href) as BrowserContract;
}

test("operator evidence identity exposes only pinned immutable hashes", async () => {
  const contract = await loadContract();
  const identity = contract.normalizeEvidenceIdentity({
    deploymentBuildSha256: "a".repeat(64),
    processingProfile: {
      id: "manufacturing-poc",
      version: "2026-08-09",
      sha256: "b".repeat(64),
    },
    processingManifestSha256: "c".repeat(64),
    servicesSha256: "d".repeat(64),
  });

  assert.deepEqual(identity, {
    deploymentBuildSha256: "a".repeat(64),
    processingProfile: {
      id: "manufacturing-poc",
      version: "2026-08-09",
      sha256: "b".repeat(64),
    },
    processingManifestSha256: "c".repeat(64),
    servicesSha256: "d".repeat(64),
  });
  assert.throws(() => contract.normalizeEvidenceIdentity({
    ...identity,
    processingManifestSha256: "not-a-sha256",
  }), /SHA-256/u);
  assert.throws(() => contract.normalizeEvidenceIdentity({
    ...identity,
    processingProfile: { ...identity.processingProfile, manifest: { services: [] } },
  }), /only immutable identity fields/u);
});

test("endpoint presentation supports browser links without exposing access in the query", async () => {
  const contract = await loadContract();
  const presentation = contract.endpointGrantPresentation({
    kind: "browser_link",
    side: "A",
    url: "/?role=participant#access=secret",
    qrDataUrl: "data:image/png;base64,abc",
  }, "https://relay.example.test/operator");

  assert.deepEqual(presentation, {
    kind: "browser_link",
    side: "A",
    href: "https://relay.example.test/?role=participant#access=secret",
    copyValue: "https://relay.example.test/?role=participant#access=secret",
    qrDataUrl: "data:image/png;base64,abc",
  });
});

test("endpoint presentation renders telephony test addresses without requiring a URL or QR", async () => {
  const contract = await loadContract();
  const presentation = contract.endpointGrantPresentation({
    kind: "telephony_test",
    side: "B",
    address: "fake-telephony://session-1/B",
  }, "https://relay.example.test/");

  assert.deepEqual(presentation, {
    kind: "telephony_test",
    side: "B",
    address: "fake-telephony://session-1/B",
    copyValue: "fake-telephony://session-1/B",
  });
  assert.equal("href" in presentation, false);
  assert.equal("qrDataUrl" in presentation, false);
});

test("glossary upload keeps binary XLSX bytes intact as base64", async () => {
  const contract = await loadContract();
  const bytes = Uint8Array.from([0, 1, 2, 127, 128, 254, 255]);
  const upload = contract.glossaryUploadContents(
    "Factory Terms.XLSX",
    bytes.buffer,
  );

  assert.deepEqual(upload, {
    fileName: "Factory Terms.XLSX",
    contentsBase64: Buffer.from(bytes).toString("base64"),
  });
  assert.throws(
    () => contract.glossaryUploadContents("terms.txt", bytes.buffer),
    /CSV or XLSX/u,
  );
});

test("segment revisions replace text and final segments are terminal", async () => {
  const contract = await loadContract();
  const segments = new Map();

  const first = contract.applySegmentRevision(segments, {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 0,
    text: "I need a main",
    final: false,
  });
  assert.equal(first.applied, true);

  const replacement = contract.applySegmentRevision(segments, {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 1,
    text: "I need a main spindle",
    final: false,
  });
  assert.equal(replacement.applied, true);
  assert.deepEqual(segments.get(replacement.key), {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 1,
    text: "I need a main spindle",
    final: false,
  });

  const cleared = contract.applySegmentRevision(segments, {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 2,
    text: "",
    final: false,
  });
  assert.equal(cleared.applied, true);
  assert.equal(segments.get(cleared.key)?.text, "");

  const final = contract.applySegmentRevision(segments, {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 3,
    text: "I need a main spindle.",
    final: true,
  });
  assert.equal(final.applied, true);
  const afterFinal = contract.applySegmentRevision(segments, {
    generation: 4,
    turnId: "turn-17",
    segmentId: "source-17",
    revision: 4,
    text: "This late revision must not replace the final segment.",
    final: false,
  });
  assert.equal(afterFinal.applied, false);
  assert.equal(segments.get(final.key)?.text, "I need a main spindle.");
});

test("same-generation turns with matching segment IDs render independently", async () => {
  const contract = await loadContract();
  const segments = new Map();

  const firstTurn = contract.applySegmentRevision(segments, {
    generation: 6,
    turnId: "turn-1",
    segmentId: "segment-0",
    revision: 0,
    text: "First turn",
    final: false,
  });
  const secondTurn = contract.applySegmentRevision(segments, {
    generation: 6,
    turnId: "turn-2",
    segmentId: "segment-0",
    revision: 0,
    text: "Second turn",
    final: false,
  });

  assert.equal(firstTurn.applied, true);
  assert.equal(secondTurn.applied, true);
  assert.notEqual(firstTurn.key, secondTurn.key);
  assert.equal(segments.size, 2);
  assert.equal(segments.get(firstTurn.key)?.text, "First turn");
  assert.equal(segments.get(secondTurn.key)?.text, "Second turn");

  const clearFirstTurn = contract.applySegmentRevision(segments, {
    generation: 6,
    turnId: "turn-1",
    segmentId: "segment-0",
    revision: 1,
    text: "",
    final: false,
  });
  assert.equal(clearFirstTurn.applied, true);
  assert.equal(segments.get(firstTurn.key)?.text, "");
  assert.equal(segments.get(secondTurn.key)?.text, "Second turn");
});

test("active room transitions resume an already active VAD exactly once", async () => {
  const contract = await loadContract();

  assert.equal(
    contract.shouldSendSpeechStartForActiveTransition("ready", "active", true),
    true,
  );
  assert.equal(
    contract.shouldSendSpeechStartForActiveTransition("paused", "active", true),
    true,
  );
  assert.equal(
    contract.shouldSendSpeechStartForActiveTransition("active", "active", true),
    false,
  );
  assert.equal(
    contract.shouldSendSpeechStartForActiveTransition("running", "started", true),
    false,
  );
  assert.equal(
    contract.shouldSendSpeechStartForActiveTransition("ready", "active", false),
    false,
  );
});

test("translation capabilities retain every mode while requiring a selectable default", async () => {
  const contract = await loadContract();
  const capabilities = contract.normalizeTranslationCapabilities({
    provider: "openai_controlled",
    modes: [
      {
        mode: "fast",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
      {
        mode: "balanced",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
      {
        mode: "accurate",
        behavior: { version: 1 },
        state: "experimental",
        deterministicGlossary: false,
        reason: "Parity validation is pending.",
      },
    ],
    defaultMode: "balanced",
  });

  assert.equal(capabilities.modes[0]?.behavior.version, 1);
  assert.equal(capabilities.modes[2]?.state, "experimental");
  assert.equal(capabilities.modes[2]?.reason, "Parity validation is pending.");
  assert.throws(() => contract.normalizeTranslationCapabilities({
    provider: "openai_controlled",
    modes: [
      {
        mode: "fast",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
      {
        mode: "balanced",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
    ],
    defaultMode: "balanced",
  }), /fast, balanced, and accurate/u);
  assert.throws(() => contract.normalizeTranslationCapabilities({
    provider: "openai_controlled",
    modes: [
      {
        mode: "fast",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
      {
        mode: "balanced",
        behavior: { version: 1 },
        state: "locally_controlled",
        deterministicGlossary: false,
      },
      {
        mode: "accurate",
        behavior: { version: 1 },
        state: "experimental",
        deterministicGlossary: false,
        reason: "Parity validation is pending.",
      },
    ],
    defaultMode: "accurate",
  }), /selectable default mode/u);
});

test("capabilities require an exact data-admission decision", async () => {
  const contract = await loadContract();
  assert.equal(contract.normalizeDataAdmission("approved_poc_content"), "approved_poc_content");
  assert.equal(contract.normalizeDataAdmission("synthetic_only"), "synthetic_only");
  assert.throws(() => contract.normalizeDataAdmission("synthetic_only "), /data admission/iu);
  assert.throws(() => contract.normalizeDataAdmission("approved"), /data admission/iu);
  assert.throws(() => contract.normalizeDataAdmission(undefined), /data admission/iu);
});

test("participant processing disclosure requires an explicit notice, cloud services, and terminal withdrawal", async () => {
  const contract = await loadContract();
  const disclosure = contract.normalizeProcessingDisclosure({
    noticeVersion: "manufacturing-notice-v1",
    recording: true,
    processing: true,
    withdrawalTerminatesSession: true,
    provider: "openai_controlled",
    services: [
      {
        id: "openai-transcription",
        provider: "openai",
        role: "transcription",
        category: "managed_transcription",
        dataCategories: [
          "canonical_audio",
          "source_language",
          "source_terms",
          "aliases",
        ],
      },
      {
        id: "openai-text-translation",
        provider: "openai",
        role: "text_translation",
        category: "managed_text_translation",
        dataCategories: [
          "source_transcript",
          "source_language",
          "target_language",
          "opaque_placeholders",
        ],
      },
    ],
  });
  assert.deepEqual(disclosure, {
    noticeVersion: "manufacturing-notice-v1",
    recording: true,
    processing: true,
    withdrawalTerminatesSession: true,
    provider: "openai_controlled",
    services: [
      {
        id: "openai-transcription",
        provider: "openai",
        role: "transcription",
        category: "managed_transcription",
        dataCategories: [
          "canonical_audio",
          "source_language",
          "source_terms",
          "aliases",
        ],
      },
      {
        id: "openai-text-translation",
        provider: "openai",
        role: "text_translation",
        category: "managed_text_translation",
        dataCategories: [
          "source_transcript",
          "source_language",
          "target_language",
          "opaque_placeholders",
        ],
      },
    ],
  });
  assert.throws(() => contract.normalizeProcessingDisclosure({
    ...disclosure,
    recording: false,
  }), /recording/i);
  assert.throws(() => contract.normalizeProcessingDisclosure({
    ...disclosure,
    services: [],
  }), /service/i);
  assert.throws(() => contract.normalizeProcessingDisclosure({
    ...disclosure,
    services: [{
      ...disclosure.services[0],
      dataCategories: ["canonical_audio", "canonical_audio"],
    }],
  }), /unique/i);
  assert.throws(() => contract.normalizeProcessingDisclosure({
    ...disclosure,
    services: [{
      ...disclosure.services[0],
      dataCategories: ["secret_provider_trace"],
    }],
  }), /data category/i);
});

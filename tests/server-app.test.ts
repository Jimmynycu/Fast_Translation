import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";
import { createAudioFrame } from "../src/core/audio.js";
import type { GlossarySpec } from "../src/core/glossary.js";
import type {
  EventCursor,
  GuardedDuplexRelay,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  Side,
} from "../src/core/types.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import {
  createServerApp,
  mapSessionEvent,
  type BrowserMediaGateway,
  type ConfiguredTranslation,
  type GlossaryImportResult,
  type GlossaryRegistry,
} from "../src/server/app.js";
import {
  createServerAccessControl,
  type ServerAccessControl,
} from "../src/server/access.js";
import type { ImportGlossaryRequest } from "../src/server/protocol.js";

const glossary: GlossarySpec = {
  id: "factory",
  version: "factory-v1",
  sourceLanguage: "en-US",
  targetLanguage: "zh-TW",
  entries: [
    { id: "term-1", source: "spindle", aliases: ["main spindle"], targetExact: "main shaft" },
  ],
};

const OPERATOR_TOKEN = "operator-test-token-0123456789abcdef";
const OPERATOR_HEADERS = { authorization: "Bearer " + OPERATOR_TOKEN } as const;
const PARTICIPANT_SIGNING_KEY = Buffer.alloc(32, 19);

const translation: ConfiguredTranslation = {
  providerId: "openai_controlled",
  supportedModes: [
    {
      mode: "fast",
      behaviorVersion: 1,
      deterministicGlossary: false,
      degradation: "Provider-local revision behavior is not yet parity-verified.",
    },
    {
      mode: "balanced",
      behaviorVersion: 1,
      deterministicGlossary: false,
    },
    {
      mode: "accurate",
      behaviorVersion: 1,
      deterministicGlossary: true,
    },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
  defaultMode: "balanced",
};

function testAccess(): ServerAccessControl {
  return createServerAccessControl({
    operatorToken: OPERATOR_TOKEN,
    participantSigningKey: PARTICIPANT_SIGNING_KEY,
  });
}


function snapshot(sessionId: string, spec: SessionSpec): SessionSnapshot {
  return {
    sessionId,
    status: "waiting",
    spec,
    participants: {
      A: {
        kind: "browser_link",
        side: "A",
        url: `http://relay.test/?role=participant&sessionId=${sessionId}&side=A`,
        qrDataUrl: "data:image/png;base64,QQ==",
      },
      B: {
        kind: "browser_link",
        side: "B",
        url: `http://relay.test/?role=participant&sessionId=${sessionId}&side=B`,
        qrDataUrl: "data:image/png;base64,Qg==",
      },
    },
    generations: { A_TO_B: 0, B_TO_A: 0 },
    behavior: resolveTranslationBehavior(spec.mode),
    ...(spec.glossary === undefined
      ? {}
      : { glossary: { id: spec.glossary.id, version: spec.glossary.version, hash: "hash-v1" } }),
    eventCursor: 1,
    openedAtMs: 100,
  };
}


class FakeRelay implements GuardedDuplexRelay {
  readonly opened: SessionSpec[] = [];
  readonly commanded: Array<{ sessionId: string; command: RelayCommand }> = [];
  eventsForSession: readonly SessionEvent[] = [];
  snapshotStatus: SessionSnapshot["status"] = "waiting";

  async open(spec: SessionSpec): Promise<SessionSnapshot> {
    this.opened.push(spec);
    return snapshot("session-1", spec);
  }

  snapshot(sessionId: string): SessionSnapshot {
    const latest = this.opened.at(-1);
    if (latest === undefined) throw new Error("Unknown fake session");
    return { ...snapshot(sessionId, latest), status: this.snapshotStatus };
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    this.commanded.push({ sessionId, command });
  }

  events(_sessionId: string, after: EventCursor = 0): AsyncIterable<SessionEvent> {
    const events = this.eventsForSession.filter((event) => event.cursor > after);
    return (async function* (): AsyncIterable<SessionEvent> {
      yield* events;
    })();
  }
}

interface TrackingEventStream {
  returned: boolean;
  resolve?: (result: IteratorResult<SessionEvent>) => void;
}

class TrackingRelay extends FakeRelay {
  readonly streams: TrackingEventStream[] = [];

  override events(
    _sessionId: string,
    _after: EventCursor = 0,
    _signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const stream: TrackingEventStream = { returned: false };
    this.streams.push(stream);
    const iterator: AsyncIterator<SessionEvent> = {
      next: () => new Promise<IteratorResult<SessionEvent>>((resolve) => {
        stream.resolve = resolve;
      }),
      return: async () => {
        stream.returned = true;
        stream.resolve?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }
}

async function openFakeSession(relay: FakeRelay): Promise<void> {

  await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "openai_controlled",
    mode: "balanced",
  });
}

class FakeGlossaryRegistry implements GlossaryRegistry {
  readonly imports: ImportGlossaryRequest[] = [];

  async importFile(request: ImportGlossaryRequest): Promise<GlossaryImportResult> {
    this.imports.push(request);
    return { version: glossary.version, hash: "hash-v1", spec: glossary };
  }

  async get(version: string): Promise<GlossarySpec | undefined> {
    return version === glossary.version ? glossary : undefined;
  }
}

class FakeBrowserMedia implements BrowserMediaGateway {
  readonly attached: Array<{ sessionId: string; side: Side; socket: unknown }> = [];
  readonly detached: Array<{ sessionId: string; side: Side; socket: unknown }> = [];
  attachError: Error | undefined;

  attach(sessionId: string, side: Side, socket: unknown): void {
    if (this.attachError !== undefined) throw this.attachError;
    this.attached.push({ sessionId, side, socket });
  }

  detach(sessionId: string, side: Side, socket: unknown): void {
    this.detached.push({ sessionId, side, socket });
  }
}

async function fixture(
  evidenceHealth: "healthy" | "degraded" = "healthy",
): Promise<Readonly<{
  app: Awaited<ReturnType<typeof createServerApp>>;
  relay: FakeRelay;
  glossaries: FakeGlossaryRegistry;
  media: FakeBrowserMedia;
  access: ServerAccessControl;
}>> {
  const relay = new FakeRelay();
  const glossaries = new FakeGlossaryRegistry();
  const media = new FakeBrowserMedia();
  const access = testAccess();
  const app = await createServerApp({
    relay,
    glossaries,
    browserMedia: media,
    access,
    translation,
    evidenceHealth: () => evidenceHealth,
  });
  await app.ready();
  return { app, relay, glossaries, media, access };
}
async function openAndCollect(
  app: Awaited<ReturnType<typeof createServerApp>>,
  path: string,
  count: number,
) {
  let resolveMessages!: (messages: readonly string[]) => void;
  let rejectMessages!: (error: unknown) => void;
  const messages = new Promise<readonly string[]>((resolve, reject) => {
    resolveMessages = resolve;
    rejectMessages = reject;
  });
  const received: string[] = [];
  const socket = await app.injectWS(path, {}, {
    onInit(created) {
      created.on("message", (data) => {
        received.push(data.toString());
        if (received.length === count) resolveMessages(received);
      });
      created.on("error", rejectMessages);
    },
  });
  return { socket, messages: await messages };
}

async function websocketCloseCode(
  app: Awaited<ReturnType<typeof createServerApp>>,
  path: string,
): Promise<number> {
  let resolveClose!: (code: number) => void;
  const closed = new Promise<number>((resolve) => {
    resolveClose = resolve;
  });
  await app.injectWS(path, {}, {
    onInit(socket) {
      socket.once("close", (code) => resolveClose(code));
    },
  });
  return closed;
}


describe("server application", () => {
  it("requires the operator bearer before protected HTTP work", async () => {
    const { app, relay, glossaries } = await fixture();
    try {
      const responses = await Promise.all([
        app.inject({ method: "GET", url: "/api/capabilities" }),
        app.inject({ method: "GET", url: "/api/sessions/session-1" }),
        app.inject({ method: "POST", url: "/api/glossaries", payload: {} }),
        app.inject({ method: "POST", url: "/api/sessions", payload: {} }),
        app.inject({
          method: "POST",
          url: "/api/sessions/session-1/commands",
          payload: {},
        }),
      ]);
      for (const response of responses) {
        assert.equal(response.statusCode, 401);
        assert.equal(response.json().error.code, "unauthorized");
        assert.equal(response.headers["www-authenticate"], "Bearer");
      }

      const invalid = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: { authorization: "Bearer invalid" },
      });
      assert.equal(invalid.statusCode, 401);
      assert.equal(relay.opened.length, 0);
      assert.equal(relay.commanded.length, 0);
      assert.equal(glossaries.imports.length, 0);
    } finally {
      await app.close();
    }
  });

  it("imports glossary files and returns a version reference", async () => {
    const { app, glossaries } = await fixture();
    try {
      const csv = "id,source,target_exact\n1,spindle,main shaft";
      const response = await app.inject({
        method: "POST",
        url: "/api/glossaries",
        headers: OPERATOR_HEADERS,
        payload: {
          name: "Factory terms",
          fileName: "factory-terms.csv",
          contentsBase64: Buffer.from(csv).toString("base64"),
          sourceLanguage: "en-US",
          targetLanguage: "zh-TW",
          approvedBy: "Glossary owner",
        },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        glossaryVersion: "factory-v1",
        hash: "hash-v1",
        id: "factory",
      });
      assert.equal(glossaries.imports[0]?.name, "Factory terms");
      assert.equal(glossaries.imports[0]?.fileName, "factory-terms.csv");
      assert.equal(glossaries.imports[0]?.contentsBase64, Buffer.from(csv).toString("base64"));
    } finally {
      await app.close();
    }
  });

  it("requires consent, pins the glossary, and returns browser grants", async () => {
    const { app, relay } = await fixture();
    try {
      const refused = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          recordingConsent: false,
        },
      });
      assert.equal(refused.statusCode, 400);

      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "factory-v1",
          recordingConsent: true,
        },
      });
      assert.equal(response.statusCode, 201);
      assert.deepEqual(response.json(), {
        provider: "openai_controlled",
        translationMode: "accurate",
        behaviorVersion: 1,
        deterministicGlossary: true,
        degradation: { state: "full" },
        sessionId: "session-1",
        state: "waiting",
        endpointGrants: [
          {
            kind: "browser_link",
            side: "A",
            url: "http://relay.test/?role=participant&sessionId=session-1&side=A",
            qrDataUrl: "data:image/png;base64,QQ==",
          },
          {
            kind: "browser_link",
            side: "B",
            url: "http://relay.test/?role=participant&sessionId=session-1&side=B",
            qrDataUrl: "data:image/png;base64,Qg==",
          },
        ],
        glossaryHash: "hash-v1",
        evidenceHealth: "healthy",
      });
      assert.equal(relay.opened[0]?.glossary, glossary);
      assert.equal(relay.opened[0]?.sideA.language, "en-US");
      assert.equal(relay.opened[0]?.sideB.language, "zh-TW");
      assert.equal(relay.opened[0]?.provider, "openai_controlled");
      assert.equal(relay.opened[0]?.mode, "accurate");
      const recovered = await app.inject({
        method: "GET",
        url: "/api/sessions/session-1",
        headers: OPERATOR_HEADERS,
      });
      assert.equal(recovered.statusCode, 200);
      assert.deepEqual(recovered.json(), response.json());
    } finally {
      await app.close();
    }
  });

  it("rejects a pinned glossary when the selected mode cannot guarantee it", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "balanced",
          glossaryVersion: "factory-v1",
          recordingConsent: true,
        },
      });
      assert.equal(response.statusCode, 422);
      assert.equal(response.json().error.code, "glossary_unsupported");
      assert.deepEqual(response.json().error.supportedModes, ["accurate"]);
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });

  it("rejects an unknown glossary without opening a relay session", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          glossaryVersion: "missing",
          recordingConsent: true,
        },
      });
      assert.equal(response.statusCode, 404);
      assert.equal(response.json().error.code, "glossary_not_found");
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });


  it("maps HTTP command kinds to relay command types", async () => {
    const { app, relay } = await fixture();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/sessions/session-1/commands",
        payload: { kind: "pause", commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7" },
        headers: OPERATOR_HEADERS,
      });
      assert.equal(response.statusCode, 202);
      assert.deepEqual(relay.commanded, [{
        sessionId: "session-1",
        command: { type: "pause", commandId: "e9a9ccfc-c6cb-4a67-9d8b-2c716c805be7" },
      }]);
    } finally {
      await app.close();
    }
  });

  it("publishes health and stable capabilities", async () => {
    const { app } = await fixture();
    try {
      const home = await app.inject({ method: "GET", url: "/" });
      assert.equal(home.statusCode, 200);
      assert.match(home.body, /Live translation room/);
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), { status: "ok", evidenceHealth: "healthy" });
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().translation, {
        provider: "openai_controlled",
        supportedModes: [
          {
            mode: "fast",
            behavior: { version: 1 },
            deterministicGlossary: false,
            degradation: {
              state: "degraded",
              reason: "Provider-local revision behavior is not yet parity-verified.",
            },
          },
          {
            mode: "balanced",
            behavior: { version: 1 },
            deterministicGlossary: false,
            degradation: { state: "full" },
          },
          {
            mode: "accurate",
            behavior: { version: 1 },
            deterministicGlossary: true,
            degradation: { state: "full" },
          },
        ],
        defaultMode: "balanced",
      });
      assert.deepEqual(capabilities.json().glossaryImportFormats, ["csv", "xlsx"]);
      assert.deepEqual(capabilities.json().audio, {
        encoding: "pcm_s16le",
        sampleRateHz: 24000,
        channels: 1,
        frameDurationMs: 20,
      });
    } finally {
      await app.close();
    }
  });

  it("exposes fake telephony capability without a browser media route", async () => {
    const app = await createServerApp({
      relay: new FakeRelay(),
      glossaries: new FakeGlossaryRegistry(),
      mediaProfile: "fake_telephony",
      access: testAccess(),
      translation,
    });
    await app.ready();
    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().mediaProfiles, ["fake_telephony"]);
      assert.equal(
        app.hasRoute({
          method: "GET",
          url: "/ws/media/:sessionId/:side",
        }),
        false,
      );
    } finally {
      await app.close();
    }

    await assert.rejects(
      createServerApp({
        relay: new FakeRelay(),
        glossaries: new FakeGlossaryRegistry(),
        mediaProfile: "fake_telephony",
        browserMedia: new FakeBrowserMedia(),
        access: testAccess(),
        translation,
      }),
      /must not expose the browser media gateway/u,
    );
  });

  it("reports degraded status when evidence recording is degraded", async () => {
    const { app } = await fixture("degraded");
    try {
      const health = await app.inject({ method: "GET", url: "/api/health" });
      assert.deepEqual(health.json(), {
        status: "degraded",
        evidenceHealth: "degraded",
      });
    } finally {
      await app.close();
    }
  });

  it("advertises and accepts only configured translation modes", async () => {
    const relay = new FakeRelay();
    const glossaries = new FakeGlossaryRegistry();
    const media = new FakeBrowserMedia();
    const onlyBalanced: ConfiguredTranslation = {
      ...translation,
      supportedModes: [translation.supportedModes[1]!],
      defaultMode: "balanced",
    };
    const app = await createServerApp({
      relay,
      glossaries,
      browserMedia: media,
      access: testAccess(),
      translation: onlyBalanced,
    });
    await app.ready();
    try {
      const capabilities = await app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: OPERATOR_HEADERS,
      });
      assert.deepEqual(capabilities.json().translation, {
        provider: "openai_controlled",
        supportedModes: [{
          mode: "balanced",
          behavior: { version: 1 },
          deterministicGlossary: false,
          degradation: { state: "full" },
        }],
        defaultMode: "balanced",
      });

      const rejected = await app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: OPERATOR_HEADERS,
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationMode: "accurate",
          recordingConsent: true,
        },
      });
      assert.equal(rejected.statusCode, 422);
      assert.equal(rejected.json().error.code, "translation_mode_unsupported");
      assert.deepEqual(rejected.json().error.supportedModes, ["balanced"]);
      assert.equal(relay.opened.length, 0);
    } finally {
      await app.close();
    }
  });

  it("maps core transcripts and glossary alerts to browser events", () => {
    const source = mapSessionEvent({
      cursor: 3,
      sessionId: "session-1",
      timestampMonoMs: 120,
      lane: "A_TO_B",
      generation: 2,
      type: "source_transcript",
      turnId: "turn-a-2",
      segmentId: "source-a-2",
      revision: 3,
      text: "spindle",
      final: true,
    });
    assert.deepEqual(source, {
      cursor: 3,
      sessionId: "session-1",
      timestampMonoMs: 120,
      lane: "A_TO_B",
      generation: 2,
      type: "source_segment",
      data: {
        text: "spindle",
        turnId: "turn-a-2",
        segmentId: "source-a-2",
        revision: 3,
        final: true,
        sourceSide: "A",
        targetSide: "B",
      },
    });

    const alert = mapSessionEvent({
      cursor: 4,
      sessionId: "session-1",
      timestampMonoMs: 121,
      lane: "A_TO_B",
      generation: 2,
      type: "alert",
      alert: {
        type: "glossary_control_bypassed",
        code: "placeholder_missing",
        message: "missing protected term",
        glossaryId: "factory",
        glossaryVersion: "factory-v1",
        glossaryHash: "hash-v1",
        expectedPlaceholders: ["G1"],
        observedPlaceholders: [],
      },
    });
    assert.equal(alert.type, "terminology_alert");
    assert.equal(alert.data.message, "missing protected term");

    const lowConfidence = mapSessionEvent({
      cursor: 5,
      sessionId: "session-1",
      timestampMonoMs: 122,
      lane: "A_TO_B",
      generation: 2,
      type: "alert",
      alert: {
        code: "TRANSCRIPTION_LOW_CONFIDENCE",
        message: "review transcript",
        retryable: false,
      },
    });
    assert.equal(lowConfidence.type, "terminology_alert");
  });

  it("scopes participant event streams to their lane and side", async () => {
    const { app, relay, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 101,
        lane: null,
        generation: null,
        type: "session_state",
        previousStatus: "waiting",
        status: "ready",
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 102,
        lane: null,
        generation: null,
        type: "participant_state",
        side: "A",
        connected: true,
      },
      {
        cursor: 3,
        sessionId: "session-1",
        timestampMonoMs: 103,
        lane: null,
        generation: null,
        type: "participant_state",
        side: "B",
        connected: true,
      },
      {
        cursor: 4,
        sessionId: "session-1",
        timestampMonoMs: 104,
        lane: "A_TO_B",
        generation: 1,
        type: "source_transcript",
        turnId: "turn-a",
        segmentId: "source-a",
        revision: 0,
        text: "from A",
        final: true,
      },
      {
        cursor: 5,
        sessionId: "session-1",
        timestampMonoMs: 105,
        lane: "B_TO_A",
        generation: 1,
        type: "source_transcript",
        turnId: "turn-b",
        segmentId: "source-b",
        revision: 0,
        text: "from B",
        final: true,
      },
      {
        cursor: 6,
        sessionId: "session-1",
        timestampMonoMs: 106,
        lane: "A_TO_B",
        generation: 1,
        type: "target_transcript",
        turnId: "turn-a",
        segmentId: "target-a",
        revision: 0,
        text: "to B",
        final: true,
      },
      {
        cursor: 7,
        sessionId: "session-1",
        timestampMonoMs: 107,
        lane: "B_TO_A",
        generation: 1,
        type: "target_transcript",
        turnId: "turn-b",
        segmentId: "target-b",
        revision: 0,
        text: "to A",
        final: true,
      },
      {
        cursor: 8,
        sessionId: "session-1",
        timestampMonoMs: 108,
        lane: "A_TO_B",
        generation: 1,
        type: "generation_cut",
        previousGeneration: 0,
        reason: "barge_in",
      },
      {
        cursor: 9,
        sessionId: "session-1",
        timestampMonoMs: 109,
        lane: "B_TO_A",
        generation: 1,
        type: "generation_cut",
        previousGeneration: 0,
        reason: "barge_in",
      },
      {
        cursor: 10,
        sessionId: "session-1",
        timestampMonoMs: 110,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_bound",
        glossaryHash: "hash-a",
        entryIds: ["a"],
      },
      {
        cursor: 11,
        sessionId: "session-1",
        timestampMonoMs: 111,
        lane: "B_TO_A",
        generation: 1,
        type: "glossary_bound",
        glossaryHash: "hash-b",
        entryIds: ["b"],
      },
      {
        cursor: 12,
        sessionId: "session-1",
        timestampMonoMs: 112,
        lane: "A_TO_B",
        generation: 1,
        type: "glossary_authorized",
        glossaryHash: "hash-a",
        text: "to B",
        guaranteedTargetExact: ["to B"],
      },
      {
        cursor: 13,
        sessionId: "session-1",
        timestampMonoMs: 113,
        lane: "B_TO_A",
        generation: 1,
        type: "glossary_authorized",
        glossaryHash: "hash-b",
        text: "to A",
        guaranteedTargetExact: ["to A"],
      },
      {
        cursor: 14,
        sessionId: "session-1",
        timestampMonoMs: 114,
        lane: "A_TO_B",
        generation: 1,
        type: "alert",
        alert: { code: "lane-a", message: "lane A", retryable: false },
      },
      {
        cursor: 15,
        sessionId: "session-1",
        timestampMonoMs: 115,
        lane: "B_TO_A",
        generation: 1,
        type: "alert",
        alert: { code: "lane-b", message: "lane B", retryable: false },
      },
      {
        cursor: 16,
        sessionId: "session-1",
        timestampMonoMs: 116,
        lane: null,
        generation: null,
        type: "alert",
        alert: { code: "operator-only", message: "operator", retryable: true },
      },
      {
        cursor: 17,
        sessionId: "session-1",
        timestampMonoMs: 117,
        lane: "A_TO_B",
        generation: 1,
        type: "audio_playout",
        turnId: "turn-a",
        segmentId: "target-a",
        playoutSequence: 0,
        frame: createAudioFrame({
          sessionId: "session-1",
          lane: "A_TO_B",
          generation: 1,
          sequence: 0,
          capturedAtMs: 117,
          pcm16le: new Uint8Array(960),
        }),
        latencyMs: 42,
      },
    ];
    try {
      const tokenA = access.issueParticipantAccess("session-1", "A");
      const tokenB = access.issueParticipantAccess("session-1", "B");
      const a = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(tokenA),
        8,
      );
      const b = await openAndCollect(
        app,
        "/ws/events/session-1?access=" + encodeURIComponent(tokenB),
        8,
      );
      const cursors = (messages: readonly string[]) =>
        messages.map((message) => (JSON.parse(message) as { cursor: number }).cursor);
      assert.deepEqual(cursors(a.messages), [1, 2, 4, 7, 9, 10, 13, 15]);
      assert.deepEqual(cursors(b.messages), [1, 3, 5, 6, 8, 11, 12, 14]);
      for (const message of [...a.messages, ...b.messages]) {
        assert.notEqual((JSON.parse(message) as { type: string }).type, "latency");
      }
      a.socket.terminate();
      b.socket.terminate();
    } finally {
      await app.close();
    }
  });

  it("streams mapped events and delegates exact-side media sockets", async () => {
    const { app, relay, media, access } = await fixture();
    await openFakeSession(relay);
    relay.eventsForSession = [{
      cursor: 1,
      sessionId: "session-1",
      timestampMonoMs: 110,
      lane: null,
      generation: null,
      type: "participant_state",
      side: "A",
      connected: true,
    }];
    try {
      const eventPath = "/ws/events/session-1?access=" + encodeURIComponent(OPERATOR_TOKEN);
      const { socket: eventSocket, messages } = await openAndCollect(app, eventPath, 1);
      assert.deepEqual(JSON.parse(messages[0] ?? ""), {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 110,
        type: "participant_joined",
        data: { side: "A" },
      });
      if (eventSocket.readyState !== eventSocket.CLOSED) {
        const eventClosed = once(eventSocket, "close");
        eventSocket.terminate();
        await eventClosed;
      }

      const participantAccess = access.issueParticipantAccess("session-1", "A");
      const mediaSocket = await app.injectWS(
        "/ws/media/session-1/A?access=" + encodeURIComponent(participantAccess),
      );
      assert.equal(media.attached[0]?.sessionId, "session-1");
      assert.equal(media.attached[0]?.side, "A");
      const closed = once(mediaSocket, "close");
      mediaSocket.terminate();
      await closed;
      assert.equal(media.detached.length, 1);
    } finally {
      await app.close();
    }
  });

  it("emits inactive recording state without a synthetic active state on closed replay", async () => {
    const { app, relay, access } = await fixture();
    const spec: SessionSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "openai_controlled",
      mode: "balanced",
    };
    relay.eventsForSession = [
      {
        cursor: 1,
        sessionId: "session-1",
        timestampMonoMs: 100,
        lane: null,
        generation: null,
        type: "session_opened",
        snapshot: snapshot("session-1", spec),
      },
      {
        cursor: 2,
        sessionId: "session-1",
        timestampMonoMs: 120,
        lane: null,
        generation: null,
        type: "session_closed",
        reason: "operator_end",
      },
    ];
    try {
      const participantAccess = access.issueParticipantAccess("session-1", "A");
      const path = "/ws/events/session-1?after=1&access=" +
        encodeURIComponent(participantAccess);
      const { messages } = await openAndCollect(app, path, 2);
      const parsed = messages.map((message) => JSON.parse(message));
      assert.equal(parsed[0]?.type, "session_state");
      assert.equal(parsed[0]?.data.status, "closed");
      assert.deepEqual(parsed[1], {
        sessionId: "session-1",
        timestampMonoMs: 120,
        type: "recording_state",
        data: { active: false, recording: false },
      });
      assert.equal(parsed.some((event) => event.type === "recording_state" && event.data.active), false);
    } finally {
      await app.close();
    }
  });

  it("cancels event iterators on participant close and reconnect", async () => {
    const relay = new TrackingRelay();
    const glossaries = new FakeGlossaryRegistry();
    const media = new FakeBrowserMedia();
    const access = testAccess();
    const app = await createServerApp({ relay, glossaries, mediaProfile: "browser_pair", browserMedia: media, access, translation });
    await app.ready();
    await openFakeSession(relay);
    try {
      const path = "/ws/events/session-1?access=" +
        encodeURIComponent(access.issueParticipantAccess("session-1", "A"));
      const first = await app.injectWS(path);
      const firstClosed = once(first, "close");
      first.terminate();
      await firstClosed;
      assert.equal(relay.streams.length, 1);
      assert.equal(relay.streams[0]?.returned, true);

      const second = await app.injectWS(path);
      const secondClosed = once(second, "close");
      second.terminate();
      await secondClosed;
      assert.equal(relay.streams.length, 2);
      assert.equal(relay.streams.every((stream) => stream.returned), true);
    } finally {
      await app.close();
    }
  });

  it("closes missing or incorrectly scoped WebSocket access with policy violation", async () => {
    const { app, media, access } = await fixture();
    try {
      assert.equal(await websocketCloseCode(app, "/ws/events/session-1"), 1008);
      const otherSessionAccess = access.issueParticipantAccess("session-2", "A");
      const wrongSessionPath = "/ws/events/session-1?access=" +
        encodeURIComponent(otherSessionAccess);
      assert.equal(await websocketCloseCode(app, wrongSessionPath), 1008);
      const operatorMediaPath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(OPERATOR_TOKEN);
      assert.equal(await websocketCloseCode(app, operatorMediaPath), 1008);
      const sideBAccess = access.issueParticipantAccess("session-1", "B");
      const wrongSidePath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(sideBAccess);
      assert.equal(await websocketCloseCode(app, wrongSidePath), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });

  it("rejects old participant grants for unknown and terminal relay sessions", async () => {
    const { app, relay, media, access } = await fixture();
    try {
      const unknownAccess = access.issueParticipantAccess("evicted-session", "A");
      const unknownPath = "/ws/media/evicted-session/A?access=" +
        encodeURIComponent(unknownAccess);
      assert.equal(await websocketCloseCode(app, unknownPath), 1008);
      await openFakeSession(relay);
      relay.snapshotStatus = "closed";
      const closedAccess = access.issueParticipantAccess("session-1", "A");
      const closedPath = "/ws/media/session-1/A?access=" +
        encodeURIComponent(closedAccess);
      assert.equal(await websocketCloseCode(app, closedPath), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });

  it("closes a rejected participant attachment with a policy violation", async () => {
    const { app, relay, media, access } = await fixture();
    await openFakeSession(relay);
    media.attachError = new Error("side already attached");
    try {
      const participantAccess = access.issueParticipantAccess("session-1", "A");
      const path = "/ws/media/session-1/A?access=" +
        encodeURIComponent(participantAccess);
      assert.equal(await websocketCloseCode(app, path), 1008);
      assert.equal(media.attached.length, 0);
    } finally {
      await app.close();
    }
  });
});

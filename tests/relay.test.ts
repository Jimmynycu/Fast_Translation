import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAudioFrame } from "../src/core/audio.js";
import { AsyncQueue } from "../src/core/async-queue.js";
import { ModularGuardedDuplexRelay, RelaySessionError } from "../src/core/relay.js";
import type {
  AudioFrame,
  EvidencePort,
  EvidenceRecord,
  GenerationRef,
  GlossarySpec,
  LaneContext,
  MediaClearRequest,
  MediaIngressEvent,
  MediaIngressRequest,
  MediaPlaybackRequest,
  MediaPort,
  SessionEvent,
  Side,
  TranslationEvent,
  TranslationCapabilities,
  TranslationPort,
  TranslationRequest,
} from "../src/core/types.js";

const TEST_CAPABILITIES: TranslationCapabilities = {
  providerId: "palabra",
  supportedModes: [
    { mode: "fast", behaviorVersion: 1, deterministicGlossary: false },
    { mode: "balanced", behaviorVersion: 1, deterministicGlossary: false },
    { mode: "accurate", behaviorVersion: 1, deterministicGlossary: true },
  ],
  supportsProvisionalRevisions: true,
  supportsFinality: true,
  supportsCancellation: true,
  supportsDeterministicGlossary: true,
};

class FakeEvidence implements EvidencePort {
  readonly records: EvidenceRecord[] = [];
  readonly closed: string[] = [];

  constructor(readonly failClose = false) {}

  record(record: EvidenceRecord): boolean {
    this.records.push(structuredClone(record));
    return true;
  }

  async close(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
    if (this.failClose) throw new Error("evidence close failed");
  }
}

class FakeMedia implements MediaPort {
  readonly played: Record<Side, AudioFrame[]> = { A: [], B: [] };
  readonly clears: MediaClearRequest[] = [];
  readonly closedSessions: string[] = [];
  readonly #queues = new Map<string, AsyncQueue<MediaIngressEvent>>();

  push(event: MediaIngressEvent): void {
    assert.equal(this.#queue(event.sessionId).offer(event), true);
  }

  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent> {
    const queue = this.#queue(request.sessionId);
    request.signal.addEventListener("abort", () => queue.close(), { once: true });
    return queue;
  }

  async play(request: MediaPlaybackRequest): Promise<void> {
    for await (const frame of request.frames) {
      if (request.signal.aborted) return;
      this.played[request.side].push(frame);
      request.onPlayoutStarted(frame, performance.now());
    }
  }

  async clear(request: MediaClearRequest): Promise<void> {
    this.clears.push(request);
  }

  closeSession(sessionId: string): void {
    this.closedSessions.push(sessionId);
    this.#queues.get(sessionId)?.close();
  }

  #queue(sessionId: string): AsyncQueue<MediaIngressEvent> {
    const existing = this.#queues.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new AsyncQueue<MediaIngressEvent>(100);
    this.#queues.set(sessionId, created);
    return created;
  }
}

class StalledMedia extends FakeMedia {
  override async play(request: MediaPlaybackRequest): Promise<void> {
    await new Promise<void>((resolve) => {
      request.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class FakeTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  readonly captured: AudioFrame[] = [];
  readonly prepared: LaneContext[] = [];
  readonly closedSessions: string[] = [];
  readonly cancelled: GenerationRef[] = [];
  readonly #waitForRelease: boolean;
  #released = false;
  readonly #releaseWaiters: Array<() => void> = [];

  constructor(waitForRelease = false) {
    this.#waitForRelease = waitForRelease;
  }

  release(): void {
    this.#released = true;
    for (const resolve of this.#releaseWaiters.splice(0)) resolve();
  }

  async prepare(context: LaneContext): Promise<void> {
    this.prepared.push(context);
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      this.captured.push(frame);
      if (this.#waitForRelease && !this.#released) {
        await new Promise<void>((resolve) => this.#releaseWaiters.push(resolve));
      }
      yield {
        kind: "source_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "source-0",
        revision: 1,
        finality: "provisional",
        emittedAtMs: performance.now(),
        text: "source",
      };
      yield {
        kind: "target_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "target-0",
        revision: 1,
        finality: "provisional",
        emittedAtMs: performance.now(),
        text: "target",
      };
      yield {
        kind: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "audio-0",
        revision: 1,
        finality: "provisional",
        emittedAtMs: performance.now(),
        playoutSequence: frame.sequence,
        frame: createAudioFrame({
          ...frame,
          generation: request.context.generation,
        }),
      };
    }
  }

  async cancel(generation: GenerationRef): Promise<void> {
    this.cancelled.push(generation);
  }
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
  }


}

class CapabilityTranslation extends FakeTranslation {
  override readonly capabilities: TranslationCapabilities;

  constructor(capabilities: TranslationCapabilities) {
    super();
    this.capabilities = capabilities;
  }
}

class BatchTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  readonly completedBatches: AudioFrame[][] = [];
  readonly prepared: LaneContext[] = [];
  readonly closedSessions: string[] = [];
  readonly contexts: LaneContext[] = [];

  async prepare(context: LaneContext): Promise<void> {
    this.prepared.push(context);
  }

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    this.contexts.push(request.context);
    const batch: AudioFrame[] = [];
    for await (const frame of request.frames) batch.push(frame);
    this.completedBatches.push(batch);
    const last = batch.at(-1);
    if (last !== undefined && !request.signal.aborted) {
      yield { kind: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, turnId: request.context.turnId, segmentId: "term-0", revision: 1, finality: "final", emittedAtMs: performance.now(), status: "bound", glossaryHash: "test-hash", entryIds: ["term-1"], text: "bound", guaranteedTargetExact: [] };
      yield { kind: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, turnId: request.context.turnId, segmentId: "term-1", revision: 1, finality: "final", emittedAtMs: performance.now(), status: "authorized", glossaryHash: "test-hash", entryIds: ["term-1"], text: "target exact", guaranteedTargetExact: ["target exact"] };
      yield {
        kind: "target_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "target-0",
        revision: 1,
        finality: "final",
        emittedAtMs: performance.now(),
        text: "translated batch",
      };
      yield {
        kind: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "audio-0",
        revision: 1,
        finality: "final",
        emittedAtMs: performance.now(),
        playoutSequence: last.sequence,
        frame: createAudioFrame({ ...last, generation: request.context.generation }),
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
  }

}

class RevisionTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;

  async prepare(_context: LaneContext): Promise<void> {}

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const frame of request.frames) {
      const base = {
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        emittedAtMs: performance.now(),
      } as const;
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 0, finality: "provisional", text: "hel" };
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 1, finality: "final", text: "hello" };
      yield { ...base, kind: "source_transcript", segmentId: "source-1", revision: 2, finality: "final", text: "must be ignored" };
      for (const playoutSequence of [1, 1, 0, 2]) {
        yield {
          ...base,
          kind: "audio",
          segmentId: "audio-1",
          revision: playoutSequence,
          finality: "provisional",
          playoutSequence,
          frame: createAudioFrame({ ...frame, generation: request.context.generation }),
        };
      }
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class SegmentReuseTranslation implements TranslationPort {
  readonly capabilities = TEST_CAPABILITIES;
  #turn = 0;

  async prepare(_context: LaneContext): Promise<void> {}

  async *translate(request: TranslationRequest): AsyncIterable<TranslationEvent> {
    for await (const _frame of request.frames) {
      this.#turn += 1;
      yield {
        kind: "source_transcript",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        turnId: request.context.turnId,
        segmentId: "adapter-reused-segment",
        revision: 0,
        finality: "final",
        emittedAtMs: performance.now(),
        text: "turn " + this.#turn,
      };
      return;
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(_sessionId: string): Promise<void> {}
}

class PrepareFailureTranslation extends FakeTranslation {
  override async prepare(context: LaneContext): Promise<void> {
    if (context.lane === "B_TO_A") throw new Error("prepare failed");
    await super.prepare(context);
  }
}


async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function makeRelay(media: FakeMedia, translation: TranslationPort, evidence: FakeEvidence) {
  return new ModularGuardedDuplexRelay({
    media,
    translation,
    evidence,
    createSessionId: () => "session-1",
    endpointGrant: (sessionId, side) => ({
      kind: "browser_link",
      side,
      url: `https://demo.test/participant?session=${sessionId}&side=${side}`,
      qrDataUrl: "data:image/png;base64,AA==",
    }),
  });
}

async function readySession(
  relay: ModularGuardedDuplexRelay,
  media: FakeMedia,
  mode: "fast" | "accurate" = "fast",
  glossary?: GlossarySpec,
  maxQueueFrames: number | null = 10,
): Promise<{ events: SessionEvent[]; collector: Promise<void> }> {
  const snapshot = await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    provider: "palabra",
    mode,
    ...(glossary === undefined ? {} : { glossary }),
    ...(maxQueueFrames === null ? {} : { maxQueueFrames }),
  });
  const events: SessionEvent[] = [];
  const collector = (async () => {
    for await (const event of relay.events(snapshot.sessionId)) events.push(event);
  })();
  media.push({
    type: "participant_state",
    sessionId: snapshot.sessionId,
    side: "A",
    timestampMonoMs: performance.now(),
    connected: true,
  });
  media.push({
    type: "participant_state",
    sessionId: snapshot.sessionId,
    side: "B",
    timestampMonoMs: performance.now(),
    connected: true,
  });
  await waitUntil(
    () => events.some((event) => event.type === "session_state" && event.status === "ready"),
    "session did not become ready",
  );
  return { events, collector };
}

function audioEvent(side: Side, sequence: number): Extract<MediaIngressEvent, { type: "audio" }> {
  const lane = side === "A" ? "A_TO_B" : "B_TO_A";
  return {
    type: "audio",
    sessionId: "session-1",
    side,
    timestampMonoMs: performance.now(),
    frame: createAudioFrame({
      sessionId: "session-1",
      lane,
      generation: 0,
      sequence,
      capturedAtMs: performance.now(),
      pcm16le: new Uint8Array(960),
    }),
  };
}

describe("ModularGuardedDuplexRelay", () => {
  it("rejects provider, mode, and glossary capability mismatches before opening a session", async () => {
    const media = new FakeMedia();
    const baseSpec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "palabra",
      mode: "fast",
    } as const;
    const mismatchRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      providerId: "openai_native",
    }), new FakeEvidence());
    await assert.rejects(mismatchRelay.open(baseSpec), /provider does not match/u);

    const unsupportedRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      supportedModes: [{ mode: "accurate", behaviorVersion: 1, deterministicGlossary: true }],
    }), new FakeEvidence());
    await assert.rejects(unsupportedRelay.open(baseSpec), /mode is not supported/u);

    const palabraAccurateRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      supportedModes: [{ mode: "accurate", behaviorVersion: 1, deterministicGlossary: false }],
      supportsDeterministicGlossary: false,
    }), new FakeEvidence());
    const accurateSnapshot = await palabraAccurateRelay.open({ ...baseSpec, mode: "accurate" });
    await palabraAccurateRelay.command(accurateSnapshot.sessionId, {
      type: "end",
      commandId: "end-palabra-accurate",
    });

    const glossaryRelay = makeRelay(media, new CapabilityTranslation({
      ...TEST_CAPABILITIES,
      supportedModes: [{ mode: "accurate", behaviorVersion: 1, deterministicGlossary: false }],
      supportsDeterministicGlossary: false,
    }), new FakeEvidence());
    await assert.rejects(glossaryRelay.open({
      ...baseSpec,
      mode: "accurate",
      glossary: {
        id: "terms",
        version: "v1",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        entries: [{ id: "part", source: "part", aliases: [], targetExact: "component" }],
      },
    }), /does not support deterministic glossary/u);
  });

  it("prepares both lanes before activation and closes the provider on end", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-prepare" });
    await waitUntil(() => events.some((event) => event.type === "session_state" && event.status === "active"), "active event was not observed");
    assert.deepEqual(translation.prepared.map((context) => context.lane).sort(), ["A_TO_B", "B_TO_A"]);
    const activeIndex = events.findIndex((event) => event.type === "session_state" && event.status === "active");
    const readyIndex = events.findIndex((event) => event.type === "session_state" && event.status === "ready");
    assert.ok(activeIndex > readyIndex);
    await relay.command("session-1", { type: "end", commandId: "end-prepare" });
    await collector;
    assert.ok(translation.closedSessions.includes("session-1"));
  });

  it("leaves a ready session when lane preparation fails and cleans the provider", async () => {
    const media = new FakeMedia();
    const translation = new PrepareFailureTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await assert.rejects(
      relay.command("session-1", { type: "start", commandId: "start-prepare-failure" }),
      /prepare failed/u,
    );
    assert.equal(relay.snapshot("session-1").status, "ready");
    assert.ok(translation.closedSessions.includes("session-1"));
    await relay.command("session-1", { type: "end", commandId: "end-prepare-failure" });
    await collector;
  });

  it("runs the idempotent operator lifecycle and records state", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "start", commandId: "start-1" });
    await relay.command("session-1", { type: "start", commandId: "start-1" });
    await waitUntil(
      () => events.some((event) => event.type === "session_state" && event.status === "active"),
      "active state was not observed",
    );
    assert.equal(
      events.filter((event) => event.type === "session_state" && event.status === "active").length,
      1,
    );

    await relay.command("session-1", { type: "pause", commandId: "pause-1" });
    await waitUntil(() => media.clears.length === 2, "pause did not clear both playout lanes");
    await relay.command("session-1", { type: "resume", commandId: "resume-1" });
    await relay.command("session-1", { type: "end", commandId: "end-1" });
    await collector;

    assert.equal(events.at(-1)?.type, "session_closed");
    assert.deepEqual(evidence.closed, ["session-1"]);
    assert.equal(
      evidence.records.some(
        (record) =>
          record.type === "session_event" &&
          record.event.type === "session_state" &&
          record.event.status === "closed",
      ),
      true,
    );
  });

  it("retries rejected command IDs and rejects conflicting reuse", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const snapshot = await relay.open({
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "palabra",
      mode: "fast",
    });
    const events: SessionEvent[] = [];
    const collector = (async () => {
      for await (const event of relay.events(snapshot.sessionId)) events.push(event);
    })();

    const start = { type: "start", commandId: "retryable-id" } as const;
    await assert.rejects(
      relay.command(snapshot.sessionId, start),
      (error: unknown) =>
        error instanceof RelaySessionError && error.code === "invalid_command",
    );

    for (const side of ["A", "B"] as const) {
      media.push({
        type: "participant_state",
        sessionId: snapshot.sessionId,
        side,
        timestampMonoMs: performance.now(),
        connected: true,
      });
    }
    await waitUntil(
      () => events.some((event) =>
        event.type === "session_state" && event.status === "ready"
      ),
      "session did not become ready after rejected start",
    );

    await relay.command(snapshot.sessionId, start);
    await assert.rejects(
      relay.command(snapshot.sessionId, {
        type: "pause",
        commandId: start.commandId,
      }),
      (error: unknown) =>
        error instanceof RelaySessionError &&
        error.code === "invalid_command" &&
        /different command/u.test(error.message),
    );

    await relay.command(snapshot.sessionId, {
      type: "end",
      commandId: "end-retry-test",
    });
    await collector;
    assert.equal(
      events.filter((event) =>
        event.type === "session_state" && event.status === "active"
      ).length,
      1,
    );
  });

  it("closes event streams even when evidence finalization fails", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence(true);
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);

    await relay.command("session-1", { type: "start", commandId: "start-close-failure" });
    await relay.command("session-1", { type: "end", commandId: "end-close-failure" });
    await collector;

    assert.deepEqual(evidence.closed, ["session-1"]);
    assert.deepEqual(media.closedSessions, ["session-1"]);
    assert.ok(events.some((event) => event.type === "session_closed"));
    assert.ok(events.some((event) =>
      event.type === "alert" &&
      "code" in event.alert &&
      event.alert.code === "evidence_finalize_failed"
    ));
  });

  it("routes each lane independently and captures four-track evidence", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-2" });

    const speechStartedAtMs = performance.now() - 100;
    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: speechStartedAtMs,
    });
    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 1, "A-to-B audio was not played");
    assert.equal(media.played.B[0]?.lane, "A_TO_B");
    const firstAudio = events.find(
      (event) => event.type === "audio_playout" && event.lane === "A_TO_B",
    );
    assert.equal(firstAudio?.type, "audio_playout");
    if (firstAudio?.type === "audio_playout") assert.ok(firstAudio.latencyMs >= 90);
    assert.equal(
      evidence.records.some((record) => record.type === "audio" && record.track === "source_a"),
      true,
    );
    assert.equal(
      evidence.records.some((record) => record.type === "audio" && record.track === "playout_to_b"),
      true,
    );

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(() => media.clears.some((clear) => clear.lane === "A_TO_B"), "barge-in did not clear");
    assert.equal(translation.cancelled.some((cancelled) => cancelled.lane === "A_TO_B"), true);

    media.push(audioEvent("A", 2));
    await waitUntil(() => media.played.B.length === 2, "post-cut audio was not played");
    assert.equal(media.played.B[1]?.generation, 1);

    await relay.command("session-1", { type: "end", commandId: "end-2" });
    await collector;
  });

  it("commits a controlled utterance at the VAD speech boundary", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media, "accurate");
    await relay.command("session-1", { type: "start", commandId: "start-batch" });

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    media.push(audioEvent("A", 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(media.played.B.length, 0);

    media.push({
      type: "speech_ended",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(() => media.played.B.length === 1, "controlled utterance was not committed");
    assert.equal(translation.completedBatches[0]?.length, 1);
    assert.ok(events.some((event) => event.type === "glossary_bound"));
    assert.ok(events.some((event) => event.type === "glossary_authorized"));

    await relay.command("session-1", { type: "end", commandId: "end-batch" });
    await collector;
  });

  it("uses the accurate behavior buffer budget when no queue limit is explicitly configured", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media, "accurate", undefined, null);
    await relay.command("session-1", { type: "start", commandId: "start-accurate-buffer" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    for (let sequence = 1; sequence <= 26; sequence += 1) media.push(audioEvent("A", sequence));
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    await waitUntil(() => translation.completedBatches.length === 1, "accurate utterance was not committed");
    assert.equal(translation.completedBatches[0]?.length, 26);

    await relay.command("session-1", { type: "end", commandId: "end-accurate-buffer" });
    await collector;
  });

  it("pins the approved glossary pair in both translation directions", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const glossary: GlossarySpec = {
      id: "manufacturing",
      version: "v1",
      sourceLanguage: "en-US",
      targetLanguage: "zh-TW",
      entries: [{
        id: "spindle",
        source: "spindle",
        aliases: ["main spindle"],
        targetExact: "main shaft",
      }],
    };
    const { collector } = await readySession(
      relay,
      media,
      "accurate",
      glossary,
    );
    await relay.command("session-1", { type: "start", commandId: "start-directions" });

    const speak = async (side: Side, sequence: number, expectedBatches: number) => {
      media.push({
        type: "speech_started",
        sessionId: "session-1",
        side,
        timestampMonoMs: performance.now(),
      });
      media.push(audioEvent(side, sequence));
      media.push({
        type: "speech_ended",
        sessionId: "session-1",
        side,
        timestampMonoMs: performance.now(),
      });
      await waitUntil(
        () => translation.completedBatches.length === expectedBatches,
        "directional utterance was not completed",
      );
    };

    await speak("A", 1, 1);
    await speak("B", 1, 2);
    assert.equal(translation.contexts[0]?.glossary?.sourceLanguage, "en-US");
    assert.equal(translation.contexts[0]?.glossary?.targetLanguage, "zh-TW");
    assert.equal(translation.contexts[1]?.glossary?.sourceLanguage, "zh-TW");
    assert.equal(translation.contexts[1]?.glossary?.targetLanguage, "en-US");
    assert.equal(translation.contexts[1]?.glossary?.entries[0]?.source, "main shaft");
    assert.equal(translation.contexts[1]?.glossary?.entries[0]?.targetExact, "spindle");

    await relay.command("session-1", { type: "end", commandId: "end-directions" });
    await collector;
  });

  it("uses the local generation fence as authority over late provider audio", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation(true);
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-3" });

    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "A",
      timestampMonoMs: performance.now(),
    });
    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "translator did not receive the old frame");
    media.push({
      type: "speech_started",
      sessionId: "session-1",
      side: "B",
      timestampMonoMs: performance.now(),
    });
    await waitUntil(
      () => media.clears.some((clear) => clear.lane === "A_TO_B"),
      "generation was not cut",
    );
    translation.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(media.played.B.length, 0);

    media.push(audioEvent("A", 2));
    await waitUntil(() => media.played.B.length === 1, "new generation did not resume");
    assert.equal(media.played.B[0]?.generation, 1);

    await relay.command("session-1", { type: "end", commandId: "end-3" });
    await collector;
  });

  it("starts a fresh same-generation turn after speech end while the prior adapter is still draining", async () => {
    const media = new FakeMedia();
    const translation = new FakeTranslation(true);
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-back-to-back" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(() => translation.captured.length === 1, "first utterance did not reach the adapter");
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 2));
    await waitUntil(() => translation.captured.length === 2, "second utterance was lost behind the closed input");
    translation.release();
    await waitUntil(() => media.played.B.length === 1, "second utterance did not produce playout");
    assert.equal(media.played.B[0]?.sequence, 2);

    await relay.command("session-1", { type: "end", commandId: "end-back-to-back" });
    await collector;
  });

  it("keeps reused adapter segment IDs independent across same-generation turns", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new SegmentReuseTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-segment-reuse" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(
      () => events.some((event) => event.type === "source_transcript" && event.text === "turn 1"),
      "first reused segment was not emitted",
    );
    media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 2));
    await waitUntil(
      () => events.some((event) => event.type === "source_transcript" && event.text === "turn 2"),
      "second reused segment was suppressed by the first turn finality",
    );
    const source = events.filter(
      (event): event is SessionEvent & { type: "source_transcript"; text: string; turnId: string } =>
        event.type === "source_transcript",
    );
    assert.deepEqual(source.map((event) => event.text), ["turn 1", "turn 2"]);
    assert.notEqual(source[0]?.turnId, source[1]?.turnId);

    await relay.command("session-1", { type: "end", commandId: "end-segment-reuse" });
    await collector;
  });

  it("replaces transcript segments, makes final revisions terminal, and drops stale audio sequences", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new RevisionTranslation(), new FakeEvidence());
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-revisions" });
    media.push(audioEvent("A", 1));

    await waitUntil(() => media.played.B.length === 2, "ordered audio was not played");
    const source = events.filter(
      (event): event is SessionEvent & { type: "source_transcript"; text: string; revision: number } =>
        event.type === "source_transcript",
    );
    assert.deepEqual(source.map((event) => event.text), ["hel", "hello"]);
    assert.deepEqual(source.map((event) => event.revision), [0, 1]);
    assert.deepEqual(media.played.B.map((frame) => frame.sequence), [1, 2]);

    await relay.command("session-1", { type: "end", commandId: "end-revisions" });
    await collector;
  });

  it("barge-in clears only the interrupted destination while both lanes remain capturable", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-barge-lanes" });

    media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
    media.push(audioEvent("A", 1));
    await waitUntil(() => media.played.B.length === 1, "A-to-B audio was not played");
    const beforeBargeIn = media.clears.length;

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(() => media.clears.length === beforeBargeIn + 1, "barge-in clear was not issued");
    assert.equal(media.clears.at(-1)?.lane, "A_TO_B");
    assert.equal(media.clears.at(-1)?.side, "B");

    media.push(audioEvent("A", 2));
    media.push(audioEvent("B", 1));
    await waitUntil(
      () => evidence.records.some((record) => record.type === "audio" && record.track === "source_b"),
      "B ingress was not captured after barge-in",
    );
    assert.equal(evidence.records.some((record) => record.type === "audio" && record.track === "source_a"), true);

    await relay.command("session-1", { type: "end", commandId: "end-barge-lanes" });
    await collector;
  });

  it("resets only the disconnected side's source evidence cursor on reconnect", async () => {
    const media = new FakeMedia();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, new FakeTranslation(), evidence);
    const { events, collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-reconnect-evidence" });

    media.push(audioEvent("A", 0));
    media.push(audioEvent("B", 0));
    await waitUntil(
      () => evidence.records.filter(
        (record) => record.type === "audio" && (record.track === "source_a" || record.track === "source_b"),
      ).length === 2,
      "initial source evidence was not captured",
    );

    media.push({ type: "participant_state", sessionId: "session-1", side: "A", timestampMonoMs: performance.now(), connected: false });
    media.push({ type: "participant_state", sessionId: "session-1", side: "A", timestampMonoMs: performance.now(), connected: true });
    media.push(audioEvent("A", 0));
    await waitUntil(
      () => evidence.records.filter((record) => record.type === "audio" && record.track === "source_a").length === 2,
      "reconnected source frame was not captured as evidence",
    );
    assert.equal(
      events.some(
        (event) => event.type === "alert" &&
          event.lane === "A_TO_B" &&
          event.alert.code === "invalid_source_sequence",
      ),
      false,
    );

    media.push(audioEvent("B", 0));
    await waitUntil(
      () => events.some(
        (event) => event.type === "alert" &&
          event.lane === "B_TO_A" &&
          event.alert.code === "invalid_source_sequence",
      ),
      "other participant source evidence cursor was reset",
    );
    assert.equal(
      evidence.records.filter((record) => record.type === "audio" && record.track === "source_b").length,
      1,
    );

    await relay.command("session-1", { type: "end", commandId: "end-reconnect-evidence" });
    await collector;
  });

  it("bounds and purges playout metadata when playback stalls, cuts, or disconnects", async () => {
    const media = new StalledMedia();
    const translation = new FakeTranslation();
    const relay = makeRelay(media, translation, new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-stalled-playout" });

    for (let sequence = 1; sequence <= 100; sequence += 1) {
      media.push(audioEvent("A", sequence));
      await waitUntil(() => translation.captured.length >= sequence, "stalled playout did not receive source frames");
    }
    assert.ok(relay.playoutMetadataCount("session-1", "A_TO_B") <= 10);

    media.push({ type: "speech_started", sessionId: "session-1", side: "B", timestampMonoMs: performance.now() });
    await waitUntil(() => media.clears.some((clear) => clear.lane === "A_TO_B"), "cut did not clear stalled destination");
    assert.equal(relay.playoutMetadataCount("session-1", "A_TO_B"), 0);

    for (let sequence = 101; sequence <= 200; sequence += 1) {
      media.push(audioEvent("A", sequence));
      await waitUntil(() => translation.captured.length >= sequence, "post-cut frames were not translated");
    }
    assert.ok(relay.playoutMetadataCount("session-1", "A_TO_B") <= 10);
    media.push({ type: "participant_state", sessionId: "session-1", side: "B", timestampMonoMs: performance.now(), connected: false });
    await waitUntil(() => relay.playoutMetadataCount("session-1", "A_TO_B") === 0, "disconnect did not purge destination metadata");

    await relay.command("session-1", { type: "end", commandId: "end-stalled-playout" });
    await collector;
  });

  it("releases settled lane tasks instead of retaining one promise per completed turn", async () => {
    const media = new FakeMedia();
    const relay = makeRelay(media, new FakeTranslation(), new FakeEvidence());
    const { collector } = await readySession(relay, media);
    await relay.command("session-1", { type: "start", commandId: "start-task-retention" });

    for (let sequence = 1; sequence <= 25; sequence += 1) {
      media.push({ type: "speech_started", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
      media.push(audioEvent("A", sequence));
      media.push({ type: "speech_ended", sessionId: "session-1", side: "A", timestampMonoMs: performance.now() });
      await waitUntil(
        () => relay.backgroundTaskCount("session-1") === 3,
        "completed turn task was retained in the relay background set",
      );
    }

    await relay.command("session-1", { type: "end", commandId: "end-task-retention" });
    await collector;
    assert.equal(relay.backgroundTaskCount("session-1"), 0);
  });

  it("bounds retained closed sessions while keeping the newest event history", async () => {
    const media = new FakeMedia();
    const sessionIds = ["closed-1", "closed-2"];
    const relay = new ModularGuardedDuplexRelay({
      media,
      translation: new FakeTranslation(),
      evidence: new FakeEvidence(),
      closedSessionHistoryLimit: 1,
      createSessionId: () => sessionIds.shift() ?? "unexpected-session",
      endpointGrant: (sessionId, side) => ({
        kind: "browser_link",
        side,
        url: "https://demo.test/" + sessionId + "/" + side,
        qrDataUrl: "data:image/png;base64,AA==",
      }),
    });
    const spec = {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: "palabra",
      mode: "fast",
    } as const;

    const first = await relay.open(spec);
    await relay.command(first.sessionId, { type: "end", commandId: "end-first" });
    const second = await relay.open(spec);
    await relay.command(second.sessionId, { type: "end", commandId: "end-second" });

    assert.throws(
      () => relay.events(first.sessionId),
      (error: unknown) =>
        error instanceof RelaySessionError && error.code === "invalid_session",
    );
    assert.doesNotThrow(() => relay.events(second.sessionId));
  });
});

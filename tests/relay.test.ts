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
  TranslationPort,
  TranslationRequest,
} from "../src/core/types.js";

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

class FakeTranslation implements TranslationPort {
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
        type: "source_transcript_delta",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: performance.now(),
        delta: "source",
      };
      yield {
        type: "target_transcript_delta",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: performance.now(),
        delta: "target",
      };
      yield {
        type: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: performance.now(),
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

class BatchTranslation implements TranslationPort {
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
      yield { type: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, emittedAtMs: performance.now(), status: "bound", glossaryHash: "test-hash", entryIds: ["term-1"], text: "bound", guaranteedTargetExact: [] };
      yield { type: "terminology", sessionId: request.context.sessionId, lane: request.context.lane, generation: request.context.generation, emittedAtMs: performance.now(), status: "authorized", glossaryHash: "test-hash", entryIds: ["term-1"], text: "target exact", guaranteedTargetExact: ["target exact"] };
      yield {
        type: "target_transcript_delta",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: performance.now(),
        delta: "translated batch",
      };
      yield {
        type: "audio",
        sessionId: request.context.sessionId,
        lane: request.context.lane,
        generation: request.context.generation,
        emittedAtMs: performance.now(),
        frame: createAudioFrame({ ...last, generation: request.context.generation }),
      };
    }
  }

  async cancel(_generation: GenerationRef): Promise<void> {}
  async closeSession(sessionId: string): Promise<void> {
    this.closedSessions.push(sessionId);
  }

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
  profile: "deterministic_test" | "glossary_controlled" = "deterministic_test",
  glossary?: GlossarySpec,
): Promise<{ events: SessionEvent[]; collector: Promise<void> }> {
  const snapshot = await relay.open({
    sideA: { language: "en-US" },
    sideB: { language: "zh-TW" },
    profile,
    ...(glossary === undefined ? {} : { glossary }),
    maxQueueFrames: 10,
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
      profile: "deterministic_test",
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
    assert.equal(media.played.B[1]?.generation, 2);

    await relay.command("session-1", { type: "end", commandId: "end-2" });
    await collector;
  });

  it("commits a controlled utterance at the VAD speech boundary", async () => {
    const media = new FakeMedia();
    const translation = new BatchTranslation();
    const evidence = new FakeEvidence();
    const relay = makeRelay(media, translation, evidence);
    const { events, collector } = await readySession(relay, media, "glossary_controlled");
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
      "glossary_controlled",
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
    assert.equal(media.played.B[0]?.generation, 2);

    await relay.command("session-1", { type: "end", commandId: "end-3" });
    await collector;
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
      profile: "deterministic_test",
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

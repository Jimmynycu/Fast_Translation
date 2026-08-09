import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { chromium } from "playwright-core";
import { createKeylessBrowserAcceptanceApplication } from "./support/acceptance.js";

const RUN_BROWSER_E2E = process.env.RUN_BROWSER_E2E === "1";

function chromeExecutable(): string {
  return process.env.CHROME_PATH ??
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a browser test port");
  }
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error === undefined ? resolveClose() : reject(error));
  });
  return address.port;
}

function wavFile(durationSeconds = 8): Uint8Array {
  const sampleRate = 24_000;
  const samples = sampleRate * durationSeconds;
  const dataBytes = samples * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples; index += 1) {
    const cycleSeconds = (index / sampleRate) % 2;
    const active = cycleSeconds >= 0.4 && cycleSeconds < 1.4;
    const value = active
      ? Math.round(Math.sin(2 * Math.PI * 440 * index / sampleRate) * 12_000)
      : 0;
    output.writeInt16LE(value, 44 + index * 2);
  }
  return output;
}

async function waitForRoomState(
  page: import("playwright-core").Page,
  expected: string,
): Promise<void> {
  await page.locator("#room-state").filter({ hasText: new RegExp(expected, "iu") })
    .waitFor({ state: "visible", timeout: 15_000 });
}

async function assertExactSha256(
  page: import("playwright-core").Page,
  selector: string,
): Promise<void> {
  const value = (await page.locator(selector).textContent())?.trim() ?? "";
  assert.match(value, /^[a-f0-9]{64}$/u, selector + " must show the exact immutable SHA-256");
}

const MEDIA_CLEAR_BROWSER_HARNESS = `
(() => {
  const NativeWebSocket = window.WebSocket;
  const mediaSockets = [];
  const socketIndexes = new WeakMap();
  const harness = {
    deliveries: [],
    clearAcks: [],
    playoutFrames: [],
    playoutFrameCount: 0,
    lifecycleEvents: [],
    mediaSockets,
    suppressAutomaticSpeechControls: false,
    sendControl(socket, type) {
      NativeWebSocket.prototype.send.call(socket, JSON.stringify({ type }));
    },
    sendAudioFrame(socket) {
      NativeWebSocket.prototype.send.call(socket, new Uint8Array(960).buffer);
    },
  };
  class ObservedWebSocket extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      if (String(args[0] ?? "").includes("/ws/media/")) {
        socketIndexes.set(this, mediaSockets.length);
        mediaSockets.push(this);
      }
    }
    addEventListener(type, listener, options) {
      if (type !== "message") return super.addEventListener(type, listener, options);
      const socket = this;
      return super.addEventListener(type, function(event) {
        const socketIndex = socketIndexes.get(socket);
        if (socketIndex === undefined && typeof event.data === "string") {
          try {
            const eventEnvelope = JSON.parse(event.data);
            if (
              eventEnvelope.type === "barge_lifecycle" ||
              eventEnvelope.type === "generation_cut"
            ) {
              const data = eventEnvelope.data ?? {};
              harness.lifecycleEvents.push({
                type: eventEnvelope.type,
                stage: data.stage,
                clearId: data.clearId,
                bargeId: data.bargeId,
                sourceSide: data.sourceSide,
                destinationSide: data.destinationSide,
              });
            }
          } catch {
            // Non-JSON event traffic is outside this public test observation.
          }
        }
        if (socketIndex !== undefined && typeof event.data === "string") {
          try {
            const control = JSON.parse(event.data);
            if (control.type === "clear") {
              const delivery = {
                lane: control.lane,
                generation: control.generation,
                clearId: control.clearId,
                socketIndex,
              };
              harness.deliveries.push(delivery);
            }
          } catch {
            // Non-control browser-media frames keep their normal application path.
          }
        }
        if (
          socketIndex !== undefined &&
          event.data instanceof ArrayBuffer &&
          event.data.byteLength >= 8
        ) {
          const view = new DataView(event.data);
          harness.playoutFrames.push({
            ordinal: ++harness.playoutFrameCount,
            generation: view.getUint32(0, true),
            sequence: view.getUint32(4, true),
            socketIndex,
          });
          if (harness.playoutFrames.length > 96) harness.playoutFrames.shift();
        }
        return listener.call(this, event);
      }, options);
    }
    send(data) {
      const socketIndex = socketIndexes.get(this);
      if (socketIndex !== undefined && typeof data === "string") {
        try {
          const control = JSON.parse(data);
          if (control.type === "clear_applied") {
            harness.clearAcks.push({
              lane: control.lane,
              generation: control.generation,
              clearId: control.clearId,
              socketIndex,
            });
          }
          if (
            harness.suppressAutomaticSpeechControls &&
            (control.type === "speech_start" || control.type === "speech_end")
          ) return;
        } catch {
          // Malformed controls continue to the application transport unchanged.
        }
      }
      return super.send(data);
    }
  }
  window.WebSocket = ObservedWebSocket;
  Object.defineProperty(window, "__evidenceClearHarness", {
    configurable: false,
    value: harness,
  });
})();
`;

async function installMediaClearHarness(page: import("playwright-core").Page): Promise<void> {
  await page.addInitScript({ content: MEDIA_CLEAR_BROWSER_HARNESS });
}

interface MediaClearHarnessState {
  readonly deliveries: readonly Readonly<{
    lane: "A_TO_B" | "B_TO_A";
    generation: number;
    clearId: string;
    socketIndex: number;
  }>[];
  readonly clearAcks: readonly Readonly<{
    lane: "A_TO_B" | "B_TO_A";
    generation: number;
    clearId: string;
    socketIndex: number;
  }>[];
  readonly playoutFrames: readonly Readonly<{
    ordinal: number;
    generation: number;
    sequence: number;
    socketIndex: number;
  }>[];
  readonly playoutFrameCount: number;
  readonly lifecycleEvents: readonly Readonly<{
    type: string;
    stage?: string;
    clearId?: string;
    bargeId?: string;
    sourceSide?: string;
    destinationSide?: string;
  }>[];
  readonly socketCount: number;
}

async function mediaClearHarnessState(
  page: import("playwright-core").Page,
): Promise<MediaClearHarnessState> {
  const raw = await page.evaluate(`JSON.stringify({
    deliveries: window.__evidenceClearHarness.deliveries,
    clearAcks: window.__evidenceClearHarness.clearAcks,
    playoutFrames: window.__evidenceClearHarness.playoutFrames,
    playoutFrameCount: window.__evidenceClearHarness.playoutFrameCount,
    lifecycleEvents: window.__evidenceClearHarness.lifecycleEvents,
    socketCount: window.__evidenceClearHarness.mediaSockets.length,
  })`);
  return JSON.parse(String(raw)) as MediaClearHarnessState;
}

async function closeLatestMediaSocket(page: import("playwright-core").Page): Promise<void> {
  await page.evaluate(`(() => {
    const sockets = window.__evidenceClearHarness.mediaSockets;
    const socket = sockets.at(-1);
    if (!socket || socket.readyState !== window.WebSocket.OPEN) {
      throw new Error("No open browser media socket to close");
    }
    socket.close(4001, "reconnect clear regression");
  })()`);
}

async function setAutomaticSpeechControlsSuppressed(
  page: import("playwright-core").Page,
  suppressed: boolean,
): Promise<void> {
  await page.evaluate(
    "window.__evidenceClearHarness.suppressAutomaticSpeechControls = " + String(suppressed) + ";",
  );
}

async function sendMediaControl(
  page: import("playwright-core").Page,
  type: "speech_start" | "speech_end",
): Promise<void> {
  await page.evaluate(`(() => {
    const harness = window.__evidenceClearHarness;
    const socket = harness.mediaSockets.at(-1);
    if (!socket || socket.readyState !== window.WebSocket.OPEN) {
      throw new Error("Participant does not have an open browser media socket");
    }
    harness.sendControl(socket, ${JSON.stringify(type)});
  })()`);
}

async function sendMediaFrames(
  page: import("playwright-core").Page,
  count: number,
): Promise<void> {
  await page.evaluate(`(() => {
    const harness = window.__evidenceClearHarness;
    const socket = harness.mediaSockets.at(-1);
    if (!socket || socket.readyState !== window.WebSocket.OPEN) {
      throw new Error("Participant does not have an open browser media socket");
    }
    for (let frame = 0; frame < ${String(count)}; frame += 1) harness.sendAudioFrame(socket);
  })()`);
}

describe("real browser Harness", () => {
  it("collects each participant consent before duplex audio, arms the recorder, and terminates both phones on withdrawal", {
    skip: !RUN_BROWSER_E2E,
    timeout: 120_000,
  }, async () => {
    const workDirectory = resolve(process.cwd(), "work", "tmp", "browser-e2e");
    await mkdir(workDirectory, { recursive: true });
    const microphonePath = resolve(workDirectory, "fake-microphone.wav");
    await writeFile(microphonePath, wavFile());

    const port = await reservePort();
    const origin = "http://127.0.0.1:" + port;
    const fixture = await createKeylessBrowserAcceptanceApplication(origin, "fast");
    await fixture.app.listen({ host: "127.0.0.1", port });
    const operatorUrl = new URL("/", origin);
    operatorUrl.hash = new URLSearchParams({ access: fixture.operatorToken }).toString();

    let browser: import("playwright-core").Browser | undefined;
    try {
      browser = await chromium.launch({
        executablePath: chromeExecutable(),
        headless: true,
        args: [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          "--use-file-for-fake-audio-capture=" + microphonePath,
          "--autoplay-policy=no-user-gesture-required",
        ],
      });

      const context = await browser.newContext();
      await context.grantPermissions(["microphone"], { origin });
      const operator = await context.newPage();
      await installMediaClearHarness(operator);
      await operator.goto(operatorUrl.toString());
      await operator.locator("#translation-mode").selectOption("fast");
      assert.equal(await operator.locator("#translation-mode").inputValue(), "fast");
      assert.notEqual((await operator.locator("#translation-provider").textContent())?.trim(), "");
      await operator.locator("#create-session").click();
      await operator.locator("#operator-dashboard").waitFor({ state: "visible" });

      await operator.locator("#evidence-console").waitFor({ state: "visible" });
      await assertExactSha256(operator, "#evidence-build-sha256");
      await assertExactSha256(operator, "#evidence-profile-sha256");
      await assertExactSha256(operator, "#evidence-manifest-sha256");
      await assertExactSha256(operator, "#evidence-services-sha256");
      assert.match(
        (await operator.locator("#evidence-profile-reference").textContent())?.trim() ?? "",
        /test-only-verified-human-session@2026-08-09-test-only/u,
      );
      await operator.locator(".evidence-unobservable")
        .filter({ hasText: "Provider-internal queue: unobservable by this client." })
        .waitFor({ state: "visible" });

      const joinLinks = await operator.locator(".join-link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? "")
      );
      assert.equal(joinLinks.length, 2);

      const participants = await Promise.all(joinLinks.map(async (url) => {
        const page = await context.newPage();
        await installMediaClearHarness(page);
        await page.goto(url);
        await page.locator("#participant-notice-version")
          .filter({ hasText: "synthetic-poc-v1" })
          .waitFor({ state: "visible", timeout: 15_000 });
        await page.locator("#participant-processing-services")
          .filter({ hasText: /Configured cloud processing: openai transcription; openai text translation; openai tts\./iu })
          .waitFor({ state: "visible", timeout: 15_000 });
        await page.locator("#participant-processing-services")
          .filter({ hasText: /Data categories by service: .*canonical audio.*source language/iu })
          .waitFor({ state: "visible", timeout: 15_000 });
        await page.locator("#participant-withdrawal-status")
          .filter({ hasText: /Withdrawal ends the session immediately/iu })
          .waitFor({ state: "visible", timeout: 15_000 });
        await page.locator("#recording-processing-consent").check();
        await page.locator("#headphones-confirmed").check();
        await page.locator("#start-microphone").click();
        await page.locator("#call-live").waitFor({ state: "visible", timeout: 15_000 });
        assert.equal(await page.locator("#evidence-console").isVisible(), false);
        assert.equal(
          (await page.locator("#evidence-build-sha256").textContent())?.trim(),
          "Waiting for operator identity",
          "participant page must not receive operator evidence identity",
        );
        assert.match(
          (await page.locator("#evidence-queue-feed").textContent())?.trim() ?? "",
          /^No scoped queue samples yet\.$/u,
          "participant page must not receive operator queue telemetry",
        );
        assert.equal(
          (await page.locator("#evidence-finalization-status").textContent())?.trim(),
          "Not finalized",
          "participant page must not receive operator finalization state",
        );
        return page;
      }));

      await operator.locator("#participant-count").filter({ hasText: "2 / 2 joined" })
        .waitFor({ timeout: 15_000 });
      await operator.locator("#participant-consent-status").filter({ hasText: "2 / 2 consented" })
        .waitFor({ timeout: 15_000 });
      await operator.locator("#evidence-capture-a")
        .filter({ hasText: "Browser microphone capture active" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-capture-b")
        .filter({ hasText: "Browser microphone capture active" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-headphones-a")
        .filter({ hasText: "self-attested (not device-verified)" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-headphones-b")
        .filter({ hasText: "self-attested (not device-verified)" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#arm-recorder:not([disabled])").waitFor({ timeout: 15_000 });
      await operator.locator("#arm-recorder").click();
      await operator.locator("#recording-label").filter({ hasText: "Recorder armed" })
        .waitFor({ timeout: 15_000 });
      await operator.locator("#evidence-recorder-arm").filter({ hasText: "Armed" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-recorder-preflight")
        .filter({ hasText: "Preflight passed (not armed)" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await waitForRoomState(operator, "ready");
      assert.equal(await operator.locator("#start-session").isDisabled(), false);
      await operator.locator("#start-session").click();
      await waitForRoomState(operator, "active");
      await operator.locator("#evidence-provider-a-to-b")
        .filter({ hasText: "Fixture-local preparation" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-provider-b-to-a")
        .filter({ hasText: "Fixture-local preparation" })
        .waitFor({ state: "visible", timeout: 15_000 });

      await operator.locator("#transcript-a .transcript-line")
        .first().waitFor({ timeout: 20_000 });
      await operator.locator("#transcript-b .transcript-line")
        .first().waitFor({ timeout: 20_000 });
      await operator.locator("#latency-value").filter({ hasNotText: "--" })
        .waitFor({ timeout: 20_000 });
      await operator.locator("#evidence-queue-feed")
        .filter({ hasText: /Browser Playout/u })
        .waitFor({ state: "visible", timeout: 20_000 });
      await operator.locator("#evidence-audible-lag")
        .filter({ hasText: /audible-start acknowledgement/u })
        .waitFor({ state: "visible", timeout: 20_000 });

      await operator.locator("#evidence-audible-lag")
        .filter({ hasText: "Phone B" })
        .waitFor({ state: "visible", timeout: 20_000 });
      const participantBIndex = joinLinks.findIndex((url) =>
        new URL(url, origin).searchParams.get("side") === "B"
      );
      const participantAIndex = joinLinks.findIndex((url) =>
        new URL(url, origin).searchParams.get("side") === "A"
      );
      const participantB = participants[participantBIndex];
      const participantA = participants[participantAIndex];
      assert.ok(participantB, "the browser journey must include participant B");
      assert.ok(participantA, "the browser journey must include participant A");
      await participantB.locator("#playback-label")
        .filter({ hasText: /Playing AI voice/iu })
        .waitFor({ state: "visible", timeout: 15_000 });

      // A destination-side disconnect creates an ordinary cut after its old socket is gone.
      // It must replay to the replacement socket, but it must not be reported as a speech barge.
      await Promise.all([
        setAutomaticSpeechControlsSuppressed(participantA, true),
        setAutomaticSpeechControlsSuppressed(participantB, true),
      ]);
      await Promise.all([
        sendMediaControl(participantA, "speech_end"),
        sendMediaControl(participantB, "speech_end"),
      ]);
      await participantB.waitForTimeout(150);
      const beforeReconnect = await mediaClearHarnessState(participantB);
      await closeLatestMediaSocket(participantB);
      await participantB.locator("#participant-connection")
        .filter({ hasText: /Live - reconnected/iu })
        .waitFor({ state: "visible", timeout: 15_000 });
      try {
        await participantB.waitForFunction(
          `(() => {
            const harness = window.__evidenceClearHarness;
            return harness.deliveries.some((delivery) =>
              delivery.socketIndex >= ${String(beforeReconnect.socketCount)} &&
              harness.clearAcks.some((ack) =>
                ack.lane === delivery.lane &&
                ack.generation === delivery.generation &&
                ack.clearId === delivery.clearId &&
                ack.socketIndex === delivery.socketIndex
              )
            );
          })()`,
          undefined,
          { timeout: 15_000 },
        );
      } catch (error) {
        const state = await mediaClearHarnessState(participantB);
        const bargeFeed = (await operator.locator("#evidence-barge-feed").textContent())?.trim();
        const pipelineFeed = (await operator.locator("#pipeline-feed").textContent())?.trim();
        const connection = (await participantB.locator("#participant-connection").textContent())?.trim();
        throw new Error(
          "The replacement browser socket did not apply and forward its replayed clear; " +
          JSON.stringify({ state, bargeFeed, pipelineFeed, connection, cause: String(error) }),
        );
      }
      const afterReconnect = await mediaClearHarnessState(participantB);
      assert.equal(afterReconnect.socketCount > beforeReconnect.socketCount, true);
      const reconnectClear = afterReconnect.deliveries.find((delivery) =>
        delivery.socketIndex >= beforeReconnect.socketCount &&
        afterReconnect.clearAcks.some((ack) =>
          ack.lane === delivery.lane &&
          ack.generation === delivery.generation &&
          ack.clearId === delivery.clearId &&
          ack.socketIndex === delivery.socketIndex
        )
      );
      assert.ok(reconnectClear, "the replacement socket must receive and ACK an exact outstanding clear");
      assert.equal(
        afterReconnect.clearAcks.filter((ack) =>
          ack.lane === reconnectClear.lane &&
          ack.generation === reconnectClear.generation &&
          ack.clearId === reconnectClear.clearId &&
          ack.socketIndex === reconnectClear.socketIndex
        ).length,
        1,
        "the replacement browser socket must forward one fresh worklet ACK for its exact replay",
      );
      await participantB.waitForTimeout(300);
      assert.equal(
        ((await operator.locator("#evidence-barge-feed").textContent()) ?? "").includes(reconnectClear.clearId),
        false,
        "an ordinary disconnect/reconnect clear must not be mislabeled as a speech-barge lifecycle",
      );

      // The reconnect cleared B's accepted readiness, so Relay returns to ready only after the
      // browser reconnects and self-reports capture/headphones readiness again.
      await waitForRoomState(operator, "ready");
      await operator.locator("#start-session:not([disabled])").waitFor({ timeout: 15_000 });
      await operator.locator("#start-session").click();
      await waitForRoomState(operator, "active");

      // A fresh, explicit B speech onset during actual A-to-B playout is a different contract:
      // it must produce one correlated lifecycle through clear ACK and resumed valid output.
      await Promise.all([
        sendMediaControl(participantA, "speech_end"),
        sendMediaControl(participantB, "speech_end"),
      ]);
      await participantB.waitForTimeout(100);
      const beforeFreshPlayout = await mediaClearHarnessState(participantB);
      await sendMediaControl(participantA, "speech_start");
      await sendMediaFrames(participantA, 24);
      try {
        await participantB.waitForFunction(
          `(() => window.__evidenceClearHarness.playoutFrames.some((frame) =>
            frame.ordinal > ${String(beforeFreshPlayout.playoutFrameCount)} &&
            frame.socketIndex === ${String(afterReconnect.socketCount - 1)}
          ))()`,
          undefined,
          { timeout: 15_000 },
        );
      } catch (error) {
        const state = await mediaClearHarnessState(participantB);
        const playback = (await participantB.locator("#playback-label").textContent())?.trim();
        throw new Error(
          "Fresh A source audio did not reach B after the reconnect/start gate; " +
          JSON.stringify({ state, playback, cause: String(error) }),
        );
      }
      const beforeBarge = await mediaClearHarnessState(participantB);
      await sendMediaControl(participantB, "speech_start");
      try {
        await participantB.waitForFunction(
          `(() => {
            const harness = window.__evidenceClearHarness;
            return harness.deliveries.slice(${String(beforeBarge.deliveries.length)}).some((delivery) =>
              delivery.lane === "A_TO_B" &&
              harness.clearAcks.some((ack) =>
                ack.lane === delivery.lane &&
                ack.generation === delivery.generation &&
                ack.clearId === delivery.clearId &&
                ack.socketIndex === delivery.socketIndex
              )
            );
          })()`,
          undefined,
          { timeout: 15_000 },
        );
      } catch (error) {
        const state = await mediaClearHarnessState(participantB);
        const bargeFeed = (await operator.locator("#evidence-barge-feed").textContent())?.trim();
        throw new Error(
          "The explicit B speech onset did not receive and ACK the A-to-B barge clear; " +
          JSON.stringify({ state, bargeFeed, cause: String(error) }),
        );
      }
      const afterBarge = await mediaClearHarnessState(participantB);
      const bargeClear = afterBarge.deliveries.slice(beforeBarge.deliveries.length).find((delivery) =>
        delivery.lane === "A_TO_B" &&
        afterBarge.clearAcks.some((ack) =>
          ack.lane === delivery.lane &&
          ack.generation === delivery.generation &&
          ack.clearId === delivery.clearId &&
          ack.socketIndex === delivery.socketIndex
        )
      );
      assert.ok(bargeClear, "the real B speech onset must produce a correlated A-to-B clear");
      const bargeChain = operator.locator("#evidence-barge-feed .event-item")
        .filter({ hasText: "Barge causal chain" })
        .filter({ hasText: bargeClear.clearId });
      try {
        await bargeChain.filter({ hasText: "Playout Clear Acknowledged" })
          .waitFor({ state: "visible", timeout: 15_000 });
      } catch (error) {
        const state = await mediaClearHarnessState(participantB);
        const operatorLifecycle = await mediaClearHarnessState(operator);
        const bargeFeed = (await operator.locator("#evidence-barge-feed").textContent())?.trim();
        const pipelineFeed = (await operator.locator("#pipeline-feed").textContent())?.trim();
        throw new Error(
          "The apparent A-to-B clear did not become the expected speech-barge lifecycle; " +
          JSON.stringify({ bargeClear, state, operatorLifecycle, bargeFeed, pipelineFeed, cause: String(error) }),
        );
      }
      await sendMediaControl(participantB, "speech_end");
      await sendMediaFrames(participantA, 8);
      await bargeChain.filter({ hasText: "Valid Output Resumed" })
        .waitFor({ state: "visible", timeout: 15_000 });
      await operator.locator("#evidence-barge-feed .event-item")
        .filter({ hasText: "Generation cut" })
        .filter({ hasText: bargeClear.clearId })
        .waitFor({ state: "visible", timeout: 15_000 });
      const bargeText = (await bargeChain.textContent()) ?? "";
      assert.match(bargeText, /Speech Onset/u);
      assert.match(bargeText, /Provider Cancel Requested/u);
      assert.match(bargeText, /Playout Clear Requested/u);
      assert.match(bargeText, /Playout Clear Acknowledged/u);
      assert.match(bargeText, /Provider Cancel (Settled|Failed)/u);
      assert.match(bargeText, /Valid Output Resumed/u);
      const clearAcknowledgedAt = bargeText.indexOf("Playout Clear Acknowledged");
      const cancelOutcomeAt = Math.max(
        bargeText.indexOf("Provider Cancel Settled"),
        bargeText.indexOf("Provider Cancel Failed"),
      );
      const resumedAt = bargeText.indexOf("Valid Output Resumed");
      assert.ok(clearAcknowledgedAt >= 0 && clearAcknowledgedAt < resumedAt);
      assert.ok(cancelOutcomeAt >= 0 && cancelOutcomeAt < resumedAt);

      const transcriptA = await operator.locator("#transcript-a").textContent();
      const transcriptB = await operator.locator("#transcript-b").textContent();
      assert.match(transcriptA ?? "", /A_TO_B/u);
      assert.match(transcriptB ?? "", /B_TO_A/u);

      await operator.locator("#pause-session").click();
      await waitForRoomState(operator, "paused");
      await operator.locator("#pause-session").click();
      await waitForRoomState(operator, "active");

      const withdrawingParticipant = participants[0];
      const otherParticipant = participants[1];
      assert.ok(withdrawingParticipant);
      assert.ok(otherParticipant);
      await withdrawingParticipant.locator("#withdraw-recording-processing-consent:not([disabled])")
        .waitFor({ timeout: 15_000 });
      await withdrawingParticipant.locator("#withdraw-recording-processing-consent").click();
      await withdrawingParticipant.locator("#participant-withdrawal-status")
        .filter({ hasText: /consent was withdrawn\. This session has ended\./iu })
        .waitFor({ state: "visible", timeout: 15_000 });
      await withdrawingParticipant.locator("#call-live").waitFor({ state: "hidden", timeout: 15_000 });
      await waitForRoomState(operator, "closed");
      await operator.locator("#evidence-finalization-status")
        .filter({ hasText: "Sealed — review ready" })
        .waitFor({ state: "visible", timeout: 15_000 });
      const finalizationRecord = (await operator.locator("#evidence-finalization-record").textContent())?.trim() ?? "";
      assert.match(finalizationRecord, /Manifest [a-f0-9]{64}/u);
      assert.match(finalizationRecord, /Encrypted ledger [a-f0-9]{64}/u);
      assert.match(finalizationRecord, /Final chain [a-f0-9]{64}/u);
      await otherParticipant.locator("#call-live").waitFor({ state: "hidden", timeout: 15_000 });
      await otherParticipant.locator("#participant-connection")
        .filter({ hasText: /Session closed/iu })
        .waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        (await otherParticipant.locator("#evidence-finalization-status").textContent())?.trim(),
        "Not finalized",
        "participants must not receive an operator finalization projection after session closure",
      );
    } finally {
      await browser?.close();
      await fixture.app.close();
    }
  });

  it("hydrates a bounded finalization failure for operators only and blocks any review verdict", {
    skip: !RUN_BROWSER_E2E,
    timeout: 45_000,
  }, async () => {
    const port = await reservePort();
    const origin = "http://127.0.0.1:" + port;
    const fixture = await createKeylessBrowserAcceptanceApplication(origin, "fast");
    await fixture.app.listen({ host: "127.0.0.1", port });
    const operatorUrl = new URL("/", origin);
    operatorUrl.hash = new URLSearchParams({ access: fixture.operatorToken }).toString();

    let browser: import("playwright-core").Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath: chromeExecutable(), headless: true });
      const context = await browser.newContext();
      const operator = await context.newPage();
      await operator.goto(operatorUrl.toString());
      await operator.locator("#translation-mode").selectOption("fast");
      await operator.locator("#create-session").click();
      await operator.locator("#operator-dashboard").waitFor({ state: "visible", timeout: 15_000 });
      const sessionId = (await operator.locator("#session-id").textContent())?.trim();
      assert.ok(sessionId, "the operator must receive a session ID before finalization");
      await operator.locator("#end-session").click();
      await waitForRoomState(operator, "closed");
      await operator.locator("#evidence-finalization-status")
        .filter({ hasText: "Finalization failed — verdict blocked" })
        .waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        (await operator.locator("#evidence-finalization-detail").textContent())?.trim(),
        "Failure code: integrity_verification_failed · Recovery: rebuild_from_spool",
      );
      const failureProjection = [
        (await operator.locator("#evidence-finalization-record").textContent())?.trim(),
        (await operator.locator("#evidence-finalization-tracks").textContent())?.trim(),
      ].join(" ");
      assert.match(failureProjection, /No sealed review verdict is available/u);
      assert.match(failureProjection, /No sealed track digests after finalization failure/u);
      assert.doesNotMatch(
        failureProjection,
        /sessionId|processingManifest|evidenceRef|token|path|[a-f0-9]{64}/iu,
        "the operator failure projection must not disclose raw evidence internals",
      );

      const recoveryUrl = new URL("/", origin);
      recoveryUrl.searchParams.set("sessionId", sessionId);
      recoveryUrl.hash = new URLSearchParams({ access: fixture.operatorToken }).toString();
      const recovered = await context.newPage();
      await recovered.goto(recoveryUrl.toString());
      await recovered.locator("#operator-dashboard").waitFor({ state: "visible", timeout: 15_000 });
      await recovered.locator("#evidence-finalization-status")
        .filter({ hasText: "Finalization failed — verdict blocked" })
        .waitFor({ state: "visible", timeout: 15_000 });
      assert.equal(
        (await recovered.locator("#evidence-finalization-detail").textContent())?.trim(),
        "Failure code: integrity_verification_failed · Recovery: rebuild_from_spool",
        "operator reconnect hydration must retain the bounded, verdict-blocking failure state",
      );
    } finally {
      await browser?.close();
      await fixture.app.close();
    }
  });
});

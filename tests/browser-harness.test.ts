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

describe("real browser Harness", () => {
  it("runs two fake microphones through both AudioWorklets and both keyless duplex lanes", {
    skip: !RUN_BROWSER_E2E,
    timeout: 60_000,
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
      await operator.goto(operatorUrl.toString());
      await operator.locator("#translation-mode").selectOption("fast");
      assert.equal(await operator.locator("#translation-mode").inputValue(), "fast");
      assert.notEqual((await operator.locator("#translation-provider").textContent())?.trim(), "");
      await operator.locator("#recording-consent").check();
      await operator.locator("#create-session").click();
      await operator.locator("#operator-dashboard").waitFor({ state: "visible" });

      const joinLinks = await operator.locator(".join-link").evaluateAll((links) =>
        links.map((link) => link.getAttribute("href") ?? "")
      );
      assert.equal(joinLinks.length, 2);

      const participants = await Promise.all(joinLinks.map(async (url) => {
        const page = await context.newPage();
        await page.goto(url);
        await page.locator("#headphones-confirmed").check();
        await page.locator("#start-microphone").click();
        await page.locator("#call-live").waitFor({ state: "visible", timeout: 15_000 });
        return page;
      }));

      await operator.locator("#participant-count").filter({ hasText: "2 / 2 joined" })
        .waitFor({ timeout: 15_000 });
      await waitForRoomState(operator, "ready");
      await operator.locator("#start-session").click();
      await waitForRoomState(operator, "active");

      await operator.locator("#transcript-a .transcript-line")
        .first().waitFor({ timeout: 20_000 });
      await operator.locator("#transcript-b .transcript-line")
        .first().waitFor({ timeout: 20_000 });
      await operator.locator("#latency-value").filter({ hasNotText: "--" })
        .waitFor({ timeout: 20_000 });

      const transcriptA = await operator.locator("#transcript-a").textContent();
      const transcriptB = await operator.locator("#transcript-b").textContent();
      assert.match(transcriptA ?? "", /A_TO_B/u);
      assert.match(transcriptB ?? "", /B_TO_A/u);

      await operator.locator("#pause-session").click();
      await waitForRoomState(operator, "paused");
      await operator.locator("#pause-session").click();
      await waitForRoomState(operator, "active");

      for (const participant of participants) {
        await participant.locator("#stop-microphone").click();
      }
    } finally {
      await browser?.close();
      await fixture.app.close();
    }
  });
});

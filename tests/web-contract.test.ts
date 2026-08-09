import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

interface BrowserContract {
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
    supportedModes: readonly Readonly<{
      mode: string;
      behavior: Readonly<{ version: number }>;
      deterministicGlossary: boolean;
      degradation: Readonly<{
        state: "full" | "degraded";
        reason?: string;
      }>;
    }>[];
    defaultMode: string;
  }>;
}

async function loadContract(): Promise<BrowserContract> {
  const url = pathToFileURL(
    resolve(process.cwd(), "web", "public", "browser-contract.js"),
  );
  url.searchParams.set("test", randomUUID());
  return await import(url.href) as BrowserContract;
}

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

test("translation capabilities accept numeric behavior versions", async () => {
  const contract = await loadContract();
  const capabilities = contract.normalizeTranslationCapabilities({
    provider: "openai_controlled",
    supportedModes: [
      {
        mode: "fast",
        behavior: { version: 1 },
        deterministicGlossary: false,
        degradation: { state: "degraded", reason: "Revision parity is pending." },
      },
      {
        mode: "balanced",
        behavior: { version: 1 },
        deterministicGlossary: false,
        degradation: { state: "full" },
      },
    ],
    defaultMode: "balanced",
  });

  assert.equal(capabilities.supportedModes[0]?.behavior.version, 1);
  assert.equal(capabilities.supportedModes[0]?.degradation.state, "degraded");
  assert.throws(() => contract.normalizeTranslationCapabilities({
    provider: "openai_controlled",
    supportedModes: [{
      mode: "balanced",
      behavior: { version: "1" },
      deterministicGlossary: false,
      degradation: { state: "full" },
    }],
    defaultMode: "balanced",
  }), /positive integer version/u);
});

test("browser UI wires resilient media and binary glossary contracts", async () => {
  const [application, html] = await Promise.all([
    readFile(resolve(process.cwd(), "web", "app.js"), "utf8"),
    readFile(resolve(process.cwd(), "web", "index.html"), "utf8"),
  ]);

  assert.match(application, /new MediaSocketSupervisor\(/u);
  assert.match(application, /connectedSocket\.send\(JSON\.stringify\(\{ type: "speech_start" \}\)\)/u);
  assert.match(application, /navigator\.wakeLock\.request\("screen"\)/u);
  assert.match(
    application,
    /glossaryUploadContents\(file\.name, await file\.arrayBuffer\(\)\)/u,
  );
  assert.match(application, /endpointGrantPresentation\(grant, window\.location\.href\)/u);
  assert.match(application, /applySegmentRevision\(/u);
  assert.match(application, /typeof data\.turnId !== "string"/u);
  assert.match(application, /line\.dataset\.turnId = update\.turnId/u);
  assert.match(application, /shouldSendSpeechStartForActiveTransition\(/u);
  assert.match(application, /translationMode/u);
  assert.match(application, /typeof data\.text !== "string"/u);
  assert.doesNotMatch(application, /translationProfile/u);
  assert.match(html, /accept="\.csv,\.xlsx,/u);
  assert.match(html, />CSV\/XLSX</u);
  assert.match(html, /id="translation-mode"/u);
  assert.doesNotMatch(html, /translation-profile/u);
});

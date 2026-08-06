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
  assert.match(
    application,
    /\["glossary_controlled", "local_eval"\]\.includes\(translationProfileId\)/u,
  );
  assert.match(application, /endpointGrantPresentation\(grant, window\.location\.href\)/u);
  assert.match(html, /accept="\.csv,\.xlsx,/u);
  assert.match(html, />CSV\/XLSX</u);
});

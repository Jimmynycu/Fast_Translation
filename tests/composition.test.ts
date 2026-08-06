import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import ExcelJS from "exceljs";
import {
  EncryptedFileEvidenceStore,
  readEncryptedEvidence,
} from "../src/adapters/evidence/encrypted-file.js";
import { FileGlossaryRepository } from "../src/adapters/glossary/file-repository.js";
import { composeApplication, FileGlossaryRegistry } from "../src/composition.js";
import { loadConfig } from "../src/config.js";
import type { EvidenceRecord } from "../src/core/types.js";

function temporaryDirectory(name: string): string {
  return resolve(
    process.cwd(),
    "work",
    "tmp",
    "composition-tests",
    name + "-" + randomUUID(),
  );
}

describe("production composition", () => {
  it("runs without an OpenAI key and exposes deterministic plus local_eval profiles", async () => {
    const glossaryDirectory = temporaryDirectory("no-key");
    const config = loadConfig({
      PUBLIC_BASE_URL: "https://relay.example.test",
      TRANSLATION_PROFILE: "deterministic_test",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();
    const operatorUrl = new URL(composition.operatorUrl);
    assert.equal(operatorUrl.origin, "https://relay.example.test");
    assert.equal(operatorUrl.search, "");
    assert.equal(new URLSearchParams(operatorUrl.hash.slice(1)).get("access"), config.operatorToken);


    try {
      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: { authorization: "Bearer " + config.operatorToken },
      });
      assert.equal(capabilities.statusCode, 200);
      assert.deepEqual(capabilities.json().translationProfiles, [
        "deterministic_test",
        "local_eval",
      ]);
      assert.equal(
        capabilities.json().defaultTranslationProfile,
        "deterministic_test",
      );

      const unavailable = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationProfileId: "glossary_controlled",
          recordingConsent: true,
        },
      });
      assert.equal(unavailable.statusCode, 409);
      assert.equal(
        unavailable.json().error.code,
        "translation_profile_unavailable",
      );

      const created = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationProfileId: "deterministic_test",
          recordingConsent: true,
        },
      });
      assert.equal(created.statusCode, 201);
      const body = created.json();
      assert.equal(body.endpointGrants.length, 2);
      const participantAccess: string[] = [];
      for (const [index, grant] of body.endpointGrants.entries()) {
        const url = new URL(grant.url);
        assert.equal(url.origin, "https://relay.example.test");
        assert.equal(url.pathname, "/");
        assert.equal(url.searchParams.get("access"), null);
        const access = new URLSearchParams(url.hash.slice(1)).get("access");
        assert.match(access ?? "", /^p1\.[A-Za-z0-9_-]{43}$/u);
        participantAccess.push(access ?? "");
        assert.equal(url.searchParams.get("role"), "participant");
        assert.equal(url.searchParams.get("sessionId"), body.sessionId);
        assert.equal(url.searchParams.get("side"), index === 0 ? "A" : "B");
        assert.match(grant.qrDataUrl, /^data:image\/png;base64,/u);
        const participantPage = await composition.app.inject({
          method: "GET",
          url: url.pathname + url.search,
        });
        assert.equal(participantPage.statusCode, 200);
      }
      assert.notEqual(participantAccess[0], participantAccess[1]);

      const ended = await composition.app.inject({
        method: "POST",
        url: "/api/sessions/" + body.sessionId + "/commands",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: {
          kind: "end",
          commandId: randomUUID(),
        },
      });
      assert.equal(ended.statusCode, 202);
    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });

  it("composes fake telephony without a carrier or provider key", async () => {
    const glossaryDirectory = temporaryDirectory("fake-telephony");
    const config = loadConfig({
      PUBLIC_BASE_URL: "http://localhost:4207",
      MEDIA_PROFILE: "fake_telephony",
      TRANSLATION_PROFILE: "deterministic_test",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();

    try {
      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: { authorization: "Bearer " + config.operatorToken },
      });
      assert.deepEqual(capabilities.json().mediaProfiles, ["fake_telephony"]);
      assert.equal(
        composition.app.hasRoute({
          method: "GET",
          url: "/ws/media/:sessionId/:side",
        }),
        false,
      );

      const created = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationProfileId: "deterministic_test",
          recordingConsent: true,
        },
      });
      assert.equal(created.statusCode, 201);
      assert.deepEqual(
        created.json().endpointGrants.map(
          (grant: { kind: string; side: string; address: string }) => grant,
        ),
        [
          {
            kind: "telephony_test",
            side: "A",
            address: "fake-telephony://" + created.json().sessionId + "/A",
          },
          {
            kind: "telephony_test",
            side: "B",
            address: "fake-telephony://" + created.json().sessionId + "/B",
          },
        ],
      );
      const driver = composition.telephonyTestDriver;
      assert.ok(driver);
      const sessionId = created.json().sessionId as string;
      driver.connect(sessionId, "A");
      driver.connect(sessionId, "B");

      let ready = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await composition.app.inject({
          method: "GET",
          url: "/api/sessions/" + sessionId,
          headers: { authorization: "Bearer " + config.operatorToken },
        });
        if (current.json().state === "ready") {
          ready = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(ready, true);

      const started = await composition.app.inject({
        method: "POST",
        url: "/api/sessions/" + sessionId + "/commands",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: { kind: "start", commandId: randomUUID() },
      });
      assert.equal(started.statusCode, 202);

      driver.speechStarted(sessionId, "A");
      driver.ingestMulaw(sessionId, "A", 0, new Uint8Array(160).fill(0xff));
      driver.speechEnded(sessionId, "A");

      let routedAudio = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        routedAudio = driver.outbound(sessionId, "B")
          .some((event) => event.type === "audio");
        if (routedAudio) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(routedAudio, true);

      const ended = await composition.app.inject({
        method: "POST",
        url: "/api/sessions/" + sessionId + "/commands",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: { kind: "end", commandId: randomUUID() },
      });
      assert.equal(ended.statusCode, 202);

    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });

  it("constructs both OpenAI profiles when a key is present", async () => {
    const glossaryDirectory = temporaryDirectory("with-key");
    const config = loadConfig({
      OPENAI_API_KEY: "test-key",
      TRANSLATION_PROFILE: "glossary_controlled",
      EVIDENCE_PROFILE: "in_memory",
      GLOSSARY_DIRECTORY: glossaryDirectory,
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();

    try {
      const capabilities = await composition.app.inject({
        method: "GET",
        url: "/api/capabilities",
        headers: { authorization: "Bearer " + config.operatorToken },
      });
      assert.deepEqual(capabilities.json().translationProfiles, [
        "deterministic_test",
        "glossary_controlled",
        "local_eval",
        "native_live_baseline",
      ]);
      assert.equal(
        capabilities.json().defaultTranslationProfile,
        "glossary_controlled",
      );
    } finally {
      await composition.app.close();
      await rm(glossaryDirectory, { recursive: true, force: true });
    }
  });

  it("ends active sessions and flushes encrypted evidence when the app closes", async () => {
    const directory = temporaryDirectory("shutdown");
    const evidenceDirectory = resolve(directory, "evidence");
    const key = Buffer.alloc(32, 9);
    const config = loadConfig({
      TRANSLATION_PROFILE: "deterministic_test",
      EVIDENCE_PROFILE: "encrypted_local",
      EVIDENCE_KEY_BASE64: key.toString("base64"),
      EVIDENCE_DIRECTORY: evidenceDirectory,
      GLOSSARY_DIRECTORY: resolve(directory, "glossaries"),
      LOG_LEVEL: "silent",
    });
    const composition = await composeApplication(config);
    await composition.app.ready();
    let closed = false;

    try {
      const created = await composition.app.inject({
        method: "POST",
        url: "/api/sessions",
        headers: { authorization: "Bearer " + config.operatorToken },
        payload: {
          languages: { A: "en-US", B: "zh-TW" },
          translationProfileId: "deterministic_test",
          recordingConsent: true,
        },
      });
      assert.equal(created.statusCode, 201);
      const sessionId = created.json().sessionId as string;

      await composition.app.close();
      closed = true;
      const evidencePath = new EncryptedFileEvidenceStore<EvidenceRecord>({
        directory: evidenceDirectory,
        key,
      }).filePath(sessionId);
      const records = await readEncryptedEvidence<EvidenceRecord>(
        evidencePath,
        key,
      );
      assert.ok(records.some((record) =>
        record.type === "session_event" &&
        record.event.type === "session_closed" &&
        record.event.reason === "server_shutdown"
      ));
    } finally {
      if (!closed) await composition.app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("persists immutable CSV and XLSX glossary versions with language and approval metadata", async () => {
    const directory = temporaryDirectory("glossary");
    const repository = new FileGlossaryRepository({ directory });
    const approvedAt = new Date("2026-08-06T12:00:00.000Z");
    const registry = new FileGlossaryRegistry(repository, () => approvedAt);

    try {
      const imported = await registry.importFile({
        name: "Factory Terms",
        fileName: "factory-terms.csv",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        approvedBy: "Customer Glossary Owner",
        contentsBase64: Buffer.from([
          "id,source,aliases,target_exact",
          "term-1,spindle,main spindle|spindle head,main shaft",
        ].join("\n")).toString("base64"),
      });

      assert.match(imported.version, /^factory-terms-[a-f0-9]{12}\.[a-f0-9]{64}$/u);
      assert.equal(imported.spec.version, imported.version);
      assert.equal(imported.spec.sourceLanguage, "en-US");
      assert.equal(imported.spec.targetLanguage, "zh-TW");
      assert.equal(imported.spec.entries[0]?.targetExact, "main shaft");

      const persisted = await repository.pin(imported.spec.id, imported.version);
      assert.equal(persisted.approval.approvedBy, "Customer Glossary Owner");
      assert.equal(persisted.approval.approvedAt, approvedAt.toISOString());

      const reapproved = await registry.importFile({
        name: "Factory Terms",
        fileName: "factory-terms.csv",
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        approvedBy: "Second Glossary Owner",
        contentsBase64: Buffer.from([
          "id,source,aliases,target_exact",
          "term-1,spindle,main spindle|spindle head,main shaft",
        ].join("\n")).toString("base64"),
      });
      assert.notEqual(reapproved.version, imported.version);
      assert.deepEqual(reapproved.spec.entries, imported.spec.entries);
      const persistedReapproval = await repository.pin(
        reapproved.spec.id,
        reapproved.version,
      );
      assert.equal(persistedReapproval.approval.approvedBy, "Second Glossary Owner");
      assert.equal((await repository.pin(imported.spec.id, imported.version)).approval.approvedBy, "Customer Glossary Owner");

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Terms");
      sheet.addRow(["id", "source", "aliases", "target_exact"]);
      sheet.addRow(["term-xlsx", "pick-and-place", "pick and place", "取放機"]);
      const xlsxContents = new Uint8Array(await workbook.xlsx.writeBuffer());
      const xlsxImported = await registry.importFile({
        name: "Factory XLSX Terms",
        fileName: "factory-terms.xlsx",
        contentsBase64: Buffer.from(xlsxContents).toString("base64"),
        sourceLanguage: "en-US",
        targetLanguage: "zh-TW",
        approvedBy: "Customer Glossary Owner",
      });
      assert.equal(xlsxImported.spec.entries[0]?.targetExact, "取放機");
      const xlsxPersisted = await repository.pin(
        xlsxImported.spec.id,
        xlsxImported.version,
      );
      assert.equal(xlsxPersisted.sourceFileName, "factory-terms.xlsx");

      const restartedRegistry = new FileGlossaryRegistry(
        new FileGlossaryRepository({ directory }),
      );
      const reloaded = await restartedRegistry.get(imported.version);
      assert.equal(reloaded?.id, imported.spec.id);
      assert.equal(reloaded?.version, imported.spec.version);
      assert.equal(reloaded?.sourceLanguage, imported.spec.sourceLanguage);
      assert.equal(reloaded?.targetLanguage, imported.spec.targetLanguage);
      assert.deepEqual(reloaded?.entries, imported.spec.entries);
      assert.equal(await restartedRegistry.get("malformed"), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

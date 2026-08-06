import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import ExcelJS from "exceljs";
import {
  FileGlossaryRepository,
  GlossaryVersionConflictError,
} from "../src/adapters/glossary/file-repository.js";

const approval = {
  approvedBy: "Customer Glossary Owner",
  approvedAt: "2026-08-05T12:00:00.000Z",
} as const;

async function makeRepository(name: string): Promise<FileGlossaryRepository> {
  const directory = join(process.cwd(), "work", "tmp", "glossary-tests", name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return new FileGlossaryRepository({
    directory,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });
}

test("imports approved CSV and pins an immutable compiled version", async () => {
  const repository = await makeRepository("csv");
  const request = {
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Abel Ng,Abel|A. Ng,\u827e\u8c9d\u723e\u00b7\u5433",
      "term-2,ZX-900,ZX900|Z X 900,ZX-900",
    ].join("\n")),
  } as const;
  const imported = await repository.import(request);
  const pinned = await repository.pin(request.id, request.version);

  assert.equal(pinned.hash, imported.hash);
  assert.equal(pinned.compiled.entries.length, 2);
  assert.equal(pinned.compiled.bind("Ask Abel about ZX900.").bindings.length, 2);
  assert.match(await readFile(imported.storagePath, "utf8"), /approvedBy/u);

  const same = await repository.import({
    ...request,
    approval: {
      approvedBy: "Another Approver",
      approvedAt: "2026-08-06T00:00:00.000Z",
    },
  });
  assert.equal(same.approval.approvedBy, approval.approvedBy);

  await assert.rejects(
    repository.import({
      ...request,
      contents: new TextEncoder().encode(
        "id,source,aliases,target_exact\nterm-1,Abel Ng,,wrong",
      ),
    }),
    GlossaryVersionConflictError,
  );
});

test("imports canonical columns from the first XLSX worksheet", async () => {
  const repository = await makeRepository("xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Manufacturing Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  sheet.addRow(["term-1", "pick-and-place", "pick and place|PnP", "\u53d6\u653e\u6a5f"]);
  const contents = await workbook.xlsx.writeBuffer();

  await repository.import({
    id: "smt",
    version: "v3",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.xlsx",
    contents: new Uint8Array(contents),
  });
  const pinned = await repository.pin("smt", "v3");
  assert.deepEqual(pinned.compiled.entries[0]?.aliases, ["pick and place", "PnP"]);
});


test("rejects duplicate normalized CSV headers before values can be overwritten", async () => {
  const repository = await makeRepository("csv-duplicate-headers");
  await assert.rejects(
    repository.import({
      id: "duplicate-csv",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target exact,target-exact",
        "term-1,Spindle,,主軸,錯誤值",
      ].join("\n")),
    }),
    /duplicate normalized column target_exact/u,
  );
  assert.equal(await repository.has("duplicate-csv", "v1"), false);
});

test("rejects duplicate normalized XLSX headers before values can be overwritten", async () => {
  const repository = await makeRepository("xlsx-duplicate-headers");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Manufacturing Terms");
  sheet.addRow(["id", "source", "aliases", "target exact", "target-exact"]);
  sheet.addRow(["term-1", "Spindle", "", "主軸", "錯誤值"]);

  await assert.rejects(
    repository.import({
      id: "duplicate-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /duplicate normalized column target_exact/u,
  );
  assert.equal(await repository.has("duplicate-xlsx", "v1"), false);
});

test("rejects a glossary whose automatic reverse direction is ambiguous", async () => {
  const repository = await makeRepository("reverse-conflict");
  await assert.rejects(
    repository.import({
      id: "ambiguous-reverse",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        "term-1,Spindle,,approved-main-shaft",
        "term-2,Main shaft,,approved-main-shaft",
      ].join("\n")),
    }),
    /conflicts between/u,
  );
  assert.equal(await repository.has("ambiguous-reverse", "v1"), false);
});



test("requires explicit customer approval metadata", async () => {
  const repository = await makeRepository("approval");
  await assert.rejects(repository.import({
    id: "terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval: { approvedBy: " ", approvedAt: "not-a-date" },
    fileName: "terms.csv",
    contents: new TextEncoder().encode(
      "id,source,aliases,target_exact\nterm-1,Spindle,,\u4e3b\u8ef8",
    ),
  }), /approvedBy/u);
});

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

/** A central-directory-only ZIP is sufficient to prove guards run before ExcelJS inflates it. */
function syntheticXlsxArchive(options: Readonly<{
  entryCount?: number;
  compressedBytes?: number;
  uncompressedBytes?: number;
}> = {}): Uint8Array {
  const entryCount = options.entryCount ?? 1;
  const compressedBytes = options.compressedBytes ?? 1;
  const uncompressedBytes = options.uncompressedBytes ?? 1;
  const fileName = Buffer.from("xl/worksheets/sheet1.xml", "utf8");
  const centralHeaderBytes = 46 + fileName.byteLength;
  const archive = Buffer.alloc(centralHeaderBytes + 22);

  archive.writeUInt32LE(0x02014b50, 0); // central-directory file header
  archive.writeUInt16LE(20, 4);
  archive.writeUInt16LE(20, 6);
  archive.writeUInt16LE(0, 8);
  archive.writeUInt16LE(8, 10);
  archive.writeUInt32LE(0, 12);
  archive.writeUInt32LE(compressedBytes, 20);
  archive.writeUInt32LE(uncompressedBytes, 24);
  archive.writeUInt16LE(fileName.byteLength, 28);
  archive.writeUInt16LE(0, 30);
  archive.writeUInt16LE(0, 32);
  archive.writeUInt16LE(0, 34);
  archive.writeUInt16LE(0, 36);
  archive.writeUInt32LE(0, 38);
  archive.writeUInt32LE(0, 42);
  fileName.copy(archive, 46);

  const endOffset = centralHeaderBytes;
  archive.writeUInt32LE(0x06054b50, endOffset); // end of central directory
  archive.writeUInt16LE(0, endOffset + 4);
  archive.writeUInt16LE(0, endOffset + 6);
  archive.writeUInt16LE(entryCount, endOffset + 8);
  archive.writeUInt16LE(entryCount, endOffset + 10);
  archive.writeUInt32LE(centralHeaderBytes, endOffset + 12);
  archive.writeUInt32LE(0, endOffset + 16);
  archive.writeUInt16LE(0, endOffset + 20);
  return new Uint8Array(archive);
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

test("rejects a high-expansion XLSX central directory before ExcelJS can inflate it", async () => {
  const repository = await makeRepository("xlsx-zip-bomb");
  await assert.rejects(
    repository.import({
      id: "zip-bomb",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      // The archive stays tiny while declaring 1 GiB of inflated data.
      contents: syntheticXlsxArchive({ uncompressedBytes: 1024 * 1024 * 1024 }),
    }),
    /compression ratio exceeds/u,
  );
  assert.equal(await repository.has("zip-bomb", "v1"), false);
});

test("rejects an XLSX central directory with too many entries before parsing it", async () => {
  const repository = await makeRepository("xlsx-entry-count");
  await assert.rejects(
    repository.import({
      id: "too-many-zip-entries",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: syntheticXlsxArchive({ entryCount: 1_025 }),
    }),
    /entry count exceeds/u,
  );
  assert.equal(await repository.has("too-many-zip-entries", "v1"), false);
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

test("rejects duplicate source or alias ownership from a CSV before pinning", async () => {
  const repository = await makeRepository("ambiguous-alias");
  await assert.rejects(
    repository.import({
      id: "ambiguous-alias",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.csv",
      contents: new TextEncoder().encode([
        "id,source,aliases,target_exact",
        "term-1,Spindle, spindle | main spindle,主軸",
      ].join("\n")),
    }),
    /ambiguous normalized term/u,
  );
  assert.equal(await repository.has("ambiguous-alias", "v1"), false);
});

test("rejects an ambiguous XLSX source/alias overlap before pinning", async () => {
  const repository = await makeRepository("ambiguous-xlsx");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Terms");
  sheet.addRow(["id", "source", "aliases", "target_exact"]);
  sheet.addRow(["term-1", "Torque controller", "", "扭力控制器"]);
  sheet.addRow(["term-2", "Controller", " torque controller ", "控制器"]);
  await assert.rejects(
    repository.import({
      id: "ambiguous-xlsx",
      version: "v1",
      sourceLanguage: "en",
      targetLanguage: "zh-TW",
      approval,
      fileName: "terms.xlsx",
      contents: new Uint8Array(await workbook.xlsx.writeBuffer()),
    }),
    /conflicts between/u,
  );
  assert.equal(await repository.has("ambiguous-xlsx", "v1"), false);
});

test("pin rejects storage that claims a different immutable identity", async () => {
  const repository = await makeRepository("tampered-identity");
  const imported = await repository.import({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  });
  const persisted = JSON.parse(await readFile(imported.storagePath, "utf8")) as Record<string, unknown>;
  persisted.id = "other-glossary";
  persisted.version = "v9";
  await writeFile(imported.storagePath, JSON.stringify(persisted), "utf8");
  await assert.rejects(
    repository.pin("factory-terms", "v1"),
    /storage identity/u,
  );
});

test("pin revalidates reverse-direction ambiguity before accepting stored content", async () => {
  const repository = await makeRepository("tampered-reverse-ambiguity");
  const imported = await repository.import({
    id: "factory-terms",
    version: "v1",
    sourceLanguage: "en",
    targetLanguage: "zh-TW",
    approval,
    fileName: "terms.csv",
    contents: new TextEncoder().encode([
      "id,source,aliases,target_exact",
      "term-1,Spindle,,主軸",
    ].join("\n")),
  });
  const persisted = JSON.parse(await readFile(imported.storagePath, "utf8")) as Record<string, unknown>;
  persisted.entries = [
    { id: "term-1", source: "Spindle", aliases: [], targetExact: "approved-shaft" },
    { id: "term-2", source: "Main shaft", aliases: [], targetExact: "approved-shaft" },
  ];
  await writeFile(imported.storagePath, JSON.stringify(persisted), "utf8");
  await assert.rejects(
    repository.pin("factory-terms", "v1"),
    /conflicts between/u,
  );
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

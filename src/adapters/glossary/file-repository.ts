import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { parse } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { z } from "zod";
import {
  compileGlossary,
  reverseGlossarySpec,
  type CompiledGlossary,
  type GlossaryEntrySpec,
  type GlossarySpec,
} from "../../core/glossary.js";

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const REQUIRED_COLUMNS = ["id", "source", "aliases", "target_exact"] as const;

const persistedSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  version: z.string(),
  sourceLanguage: z.string(),
  targetLanguage: z.string(),
  entries: z.array(z.object({
    id: z.string(),
    source: z.string(),
    aliases: z.array(z.string()),
    targetExact: z.string(),
  })),
  approval: z.object({
    approvedBy: z.string(),
    approvedAt: z.string(),
  }),
  importedAt: z.string(),
  sourceFileName: z.string(),
  hash: z.string(),
});

interface PersistedGlossaryVersion {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly entries: readonly GlossaryEntrySpec[];
  readonly approval: GlossaryApproval;
  readonly importedAt: string;
  readonly sourceFileName: string;
  readonly hash: string;
}

export interface GlossaryApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export interface GlossaryImportRequest {
  readonly id: string;
  readonly version: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly approval: GlossaryApproval;
  readonly fileName: string;
  readonly contents: Uint8Array;
}

export interface ImportedGlossaryVersion {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
  readonly entryCount: number;
  readonly approval: GlossaryApproval;
  readonly importedAt: string;
  readonly sourceFileName: string;
  readonly storagePath: string;
}

export interface PinnedGlossaryVersion extends ImportedGlossaryVersion {
  readonly compiled: CompiledGlossary;
}

export interface FileGlossaryRepositoryOptions {
  readonly directory: string;
  readonly now?: () => Date;
}

export class GlossaryVersionConflictError extends Error {
  constructor(id: string, version: string) {
    super("glossary " + id + "@" + version + " already exists with different content");
    this.name = "GlossaryVersionConflictError";
  }
}

export class GlossaryVersionNotFoundError extends Error {
  constructor(id: string, version: string) {
    super("glossary " + id + "@" + version + " does not exist");
    this.name = "GlossaryVersionNotFoundError";
  }
}

export class GlossaryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlossaryIntegrityError";
  }
}

export class FileGlossaryRepository {
  readonly #directory: string;
  readonly #now: () => Date;

  constructor(options: FileGlossaryRepositoryOptions) {
    if (options.directory.trim().length === 0) {
      throw new TypeError("glossary repository directory must not be empty");
    }
    this.#directory = resolve(options.directory);
    this.#now = options.now ?? (() => new Date());
  }

  async import(request: GlossaryImportRequest): Promise<ImportedGlossaryVersion> {
    validateApproval(request.approval);
    if (request.contents.byteLength === 0) {
      throw new TypeError("glossary import file must not be empty");
    }
    if (request.contents.byteLength > MAX_IMPORT_BYTES) {
      throw new TypeError("glossary import exceeds " + MAX_IMPORT_BYTES + " bytes");
    }

    const entries = await parseEntries(request.fileName, request.contents);
    if (entries.length === 0) {
      throw new TypeError("glossary import must contain at least one entry");
    }
    if (entries.length > MAX_ENTRIES) {
      throw new TypeError("glossary import exceeds " + MAX_ENTRIES + " entries");
    }

    const spec: GlossarySpec = {
      id: request.id,
      version: request.version,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      entries,
    };
    const compiled = compileGlossary(spec);
    compileGlossary(reverseGlossarySpec(spec));
    const storagePath = this.#storagePath(compiled.id, compiled.version);
    const importedAt = this.#now().toISOString();
    const persisted: PersistedGlossaryVersion = {
      schemaVersion: 1,
      id: compiled.id,
      version: compiled.version,
      sourceLanguage: compiled.sourceLanguage,
      targetLanguage: compiled.targetLanguage,
      entries: compiled.entries,
      approval: Object.freeze({
        approvedBy: request.approval.approvedBy.trim(),
        approvedAt: new Date(request.approval.approvedAt).toISOString(),
      }),
      importedAt,
      sourceFileName: request.fileName,
      hash: compiled.hash,
    };

    await mkdir(join(this.#directory, encodedSegment(compiled.id)), {
      recursive: true,
    });
    try {
      await writeFile(storagePath, JSON.stringify(persisted) + "\n", {
        encoding: "utf8",
        flag: "wx",
      });
      return importedRecord(persisted, storagePath);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await this.#read(compiled.id, compiled.version);
      if (existing.hash !== compiled.hash) {
        throw new GlossaryVersionConflictError(compiled.id, compiled.version);
      }
      return importedRecord(existing, storagePath);
    }
  }

  async pin(id: string, version: string): Promise<PinnedGlossaryVersion> {
    const persisted = await this.#read(id, version);
    const compiled = compileGlossary({
      id: persisted.id,
      version: persisted.version,
      sourceLanguage: persisted.sourceLanguage,
      targetLanguage: persisted.targetLanguage,
      entries: persisted.entries,
    });
    if (compiled.hash !== persisted.hash) {
      throw new GlossaryIntegrityError(
        "glossary " + persisted.id + "@" + persisted.version +
          " failed its content hash",
      );
    }
    return Object.freeze({
      ...importedRecord(persisted, this.#storagePath(id, version)),
      compiled,
    });
  }

  async has(id: string, version: string): Promise<boolean> {
    try {
      await access(this.#storagePath(id, version), constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  async #read(id: string, version: string): Promise<PersistedGlossaryVersion> {
    let serialized: string;
    try {
      serialized = await readFile(this.#storagePath(id, version), "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new GlossaryVersionNotFoundError(id, version);
      }
      throw error;
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(serialized);
    } catch {
      throw new GlossaryIntegrityError(
        "glossary " + id + "@" + version + " is not valid JSON",
      );
    }
    const result = persistedSchema.safeParse(candidate);
    if (!result.success) {
      throw new GlossaryIntegrityError(
        "glossary " + id + "@" + version + " has an invalid storage schema",
      );
    }
    return Object.freeze({
      ...result.data,
      entries: Object.freeze(result.data.entries.map((entry) =>
        Object.freeze({
          ...entry,
          aliases: Object.freeze([...entry.aliases]),
        })
      )),
      approval: Object.freeze({ ...result.data.approval }),
    });
  }

  #storagePath(id: string, version: string): string {
    const path = resolve(
      this.#directory,
      encodedSegment(id),
      encodedSegment(version) + ".json",
    );
    if (path !== this.#directory && !path.startsWith(this.#directory + sep)) {
      throw new TypeError("glossary path escaped its repository");
    }
    return path;
  }
}

function validateApproval(approval: GlossaryApproval): void {
  if (approval.approvedBy.trim().length === 0) {
    throw new TypeError("approval.approvedBy must not be empty");
  }
  if (!Number.isFinite(Date.parse(approval.approvedAt))) {
    throw new TypeError("approval.approvedAt must be an ISO date");
  }
}

async function parseEntries(
  fileName: string,
  contents: Uint8Array,
): Promise<GlossaryEntrySpec[]> {
  const extension = extname(fileName).toLocaleLowerCase("en-US");
  if (extension === ".csv") {
    const records: unknown = parse(new TextDecoder().decode(contents), {
      bom: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });
    if (!Array.isArray(records)) {
      throw new TypeError("CSV glossary did not produce records");
    }
    return records.map((record, index) => entryFromUnknown(record, index + 2));
  }
  if (extension === ".xlsx") return parseXlsx(contents);
  throw new TypeError("glossary import must be a .csv or .xlsx file");
}

async function parseXlsx(contents: Uint8Array): Promise<GlossaryEntrySpec[]> {
  const workbook = new ExcelJS.Workbook();
  const loadBuffer = Buffer.from(contents) as unknown as Parameters<
    typeof workbook.xlsx.load
  >[0];
  await workbook.xlsx.load(loadBuffer);
  const worksheet = workbook.worksheets[0];
  if (worksheet === undefined) {
    throw new TypeError("XLSX glossary must contain a worksheet");
  }

  const headers: string[] = [];
  const records: Record<string, string>[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      values[columnNumber - 1] = cell.text.trim();
    });
    if (rowNumber === 1) {
      for (const value of values) headers.push(normalizeHeader(value));
      validateHeaders(headers);
      return;
    }
    if (values.every((value) => (value ?? "").length === 0)) return;
    const record: Record<string, string> = {};
    for (const [index, header] of headers.entries()) {
      record[header] = values[index] ?? "";
    }
    records.push(record);
  });
  return records.map((record, index) => entryFromRecord(record, index + 2));
}

function entryFromUnknown(candidate: unknown, row: number): GlossaryEntrySpec {
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("glossary row " + row + " must be an object");
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string") {
      throw new TypeError("glossary row " + row + " column " + key + " must be text");
    }
    record[normalizeHeader(key)] = value;
  }
  validateHeaders(Object.keys(record));
  return entryFromRecord(record, row);
}

function entryFromRecord(record: Record<string, string>, row: number): GlossaryEntrySpec {
  const id = record.id;
  const source = record.source;
  const targetExact = record.target_exact;
  if (id === undefined || source === undefined || targetExact === undefined) {
    throw new TypeError("glossary row " + row + " is missing a required column");
  }
  return {
    id,
    source,
    aliases: parseAliases(record.aliases ?? "", row),
    targetExact,
  };
}

function parseAliases(value: string, row: number): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new TypeError("glossary row " + row + " aliases must be valid JSON");
    }
    if (!Array.isArray(parsed) || parsed.some((alias) => typeof alias !== "string")) {
      throw new TypeError("glossary row " + row + " aliases JSON must be a string array");
    }
    return parsed;
  }
  return trimmed.split(/[|;\n]/u).map((alias) => alias.trim()).filter(Boolean);
}

function validateHeaders(headers: readonly string[]): void {
  const available = new Set(headers.map(normalizeHeader));
  for (const column of REQUIRED_COLUMNS) {
    if (!available.has(column)) {
      throw new TypeError("glossary import is missing required column " + column);
    }
  }
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[\s-]+/gu, "_");
}

function encodedSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function importedRecord(
  persisted: PersistedGlossaryVersion,
  storagePath: string,
): ImportedGlossaryVersion {
  return Object.freeze({
    id: persisted.id,
    version: persisted.version,
    hash: persisted.hash,
    entryCount: persisted.entries.length,
    approval: Object.freeze({ ...persisted.approval }),
    importedAt: persisted.importedAt,
    sourceFileName: persisted.sourceFileName,
    storagePath,
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error &&
    (error as NodeJS.ErrnoException).code === code;
}

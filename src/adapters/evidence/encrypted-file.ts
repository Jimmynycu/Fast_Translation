import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 1;

export type SessionEvidence = Readonly<{ sessionId: string }> & object;

interface WriterState {
  pending: number;
  closed: boolean;
  failure?: Error;
  tail: Promise<void>;
}

interface EncryptedLine {
  readonly v: 1;
  readonly alg: "A256GCM";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function validateKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new RangeError("Evidence encryption key must be exactly 32 bytes");
  return Buffer.from(key);
}

function serializeEvidence(record: object): Buffer {
  return Buffer.from(
    JSON.stringify(record, (_key, value: unknown) =>
      value instanceof Uint8Array
        ? { $type: "Uint8Array", base64: Buffer.from(value).toString("base64") }
        : value,
    ),
    "utf8",
  );
}

function deserializeEvidence<T>(plaintext: Buffer): T {
  return JSON.parse(plaintext.toString("utf8"), (_key, value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "$type" in value &&
      "base64" in value &&
      value.$type === "Uint8Array" &&
      typeof value.base64 === "string"
    ) {
      return Uint8Array.from(Buffer.from(value.base64, "base64"));
    }
    return value;
  }) as T;
}

function encryptLine(key: Buffer, record: object): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(serializeEvidence(record)), cipher.final()]);
  const line: EncryptedLine = {
    v: FORMAT_VERSION,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(line) + "\n";
}

function decryptLine<T>(key: Buffer, line: string): T {
  const parsed = JSON.parse(line) as Partial<EncryptedLine>;
  if (
    parsed.v !== FORMAT_VERSION ||
    parsed.alg !== "A256GCM" ||
    typeof parsed.iv !== "string" ||
    typeof parsed.tag !== "string" ||
    typeof parsed.ciphertext !== "string"
  ) {
    throw new Error("Unsupported or corrupt evidence record");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final(),
  ]);
  return deserializeEvidence<T>(plaintext);
}

export class EncryptedFileEvidenceStore<T extends SessionEvidence> {
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #maxPendingRecords: number;
  readonly #states = new Map<string, WriterState>();

  constructor(options: {
    directory: string;
    key: Uint8Array;
    maxPendingRecords?: number;
  }) {
    if (options.directory.trim().length === 0) throw new RangeError("Evidence directory is required");
    const maxPendingRecords = options.maxPendingRecords ?? 1_000;
    if (!Number.isSafeInteger(maxPendingRecords) || maxPendingRecords < 1) {
      throw new RangeError("maxPendingRecords must be a positive safe integer");
    }
    this.#directory = options.directory;
    this.#key = validateKey(options.key);
    this.#maxPendingRecords = maxPendingRecords;
  }

  filePath(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return join(this.#directory, `${digest}.evidence.jsonl.enc`);
  }

  record(record: T): boolean {
    if (record.sessionId.trim().length === 0) return false;
    const state = this.#state(record.sessionId);
    if (state.closed || state.failure !== undefined || state.pending >= this.#maxPendingRecords) {
      return false;
    }

    state.pending += 1;
    const encrypted = encryptLine(this.#key, record);
    state.tail = state.tail
      .then(async () => {
        await mkdir(this.#directory, { recursive: true });
        await appendFile(this.filePath(record.sessionId), encrypted, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error: unknown) => {
        state.failure = error instanceof Error ? error : new Error("Evidence write failed");
      })
      .finally(() => {
        state.pending -= 1;
      });
    return true;
  }

  async close(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return;
    state.closed = true;
    await state.tail;
    if (state.failure !== undefined) throw state.failure;
  }

  #state(sessionId: string): WriterState {
    const existing = this.#states.get(sessionId);
    if (existing !== undefined) return existing;
    const created: WriterState = {
      pending: 0,
      closed: false,
      tail: Promise.resolve(),
    };
    this.#states.set(sessionId, created);
    return created;
  }
}

export async function readEncryptedEvidence<T extends SessionEvidence>(
  path: string,
  key: Uint8Array,
): Promise<readonly T[]> {
  const validatedKey = validateKey(key);
  const text = await readFile(path, "utf8");
  return Object.freeze(
    text
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => Object.freeze(decryptLine<T>(validatedKey, line))),
  );
}

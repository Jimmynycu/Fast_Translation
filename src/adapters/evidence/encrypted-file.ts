import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

const ALGORITHM = "aes-256-gcm";
const FORMAT_VERSION = 2;
const INITIAL_CHAIN_SHA256 = "0".repeat(64);

export type SessionEvidence = Readonly<{ sessionId: string }> & object;

export interface EvidenceSeal {
  readonly schemaVersion: 2;
  readonly recordCount: number;
  readonly finalChainSha256: string;
  readonly sealSha256: string;
}

export interface VerifiedEncryptedEvidence<T extends SessionEvidence> {
  readonly records: readonly T[];
  readonly seal: EvidenceSeal;
}

interface WriterState {
  pending: number;
  closed: boolean;
  sealQueued: boolean;
  recordCount: number;
  chainSha256: string;
  failure?: Error;
  tail: Promise<void>;
}

interface EncryptedLine {
  readonly v: 2;
  readonly alg: "A256GCM";
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

interface EvidenceRecordEnvelope<T extends SessionEvidence> {
  readonly schemaVersion: 2;
  readonly kind: "record";
  readonly index: number;
  readonly previousChainSha256: string;
  readonly recordSha256: string;
  readonly chainSha256: string;
  readonly record: T;
}

interface EvidenceSealEnvelope {
  readonly schemaVersion: 2;
  readonly kind: "seal";
  readonly seal: EvidenceSeal;
}

type EvidenceEnvelope<T extends SessionEvidence> =
  | EvidenceRecordEnvelope<T>
  | EvidenceSealEnvelope;

function validateKey(key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new RangeError("Evidence encryption key must be exactly 32 bytes");
  return Buffer.from(key);
}

function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Object.freeze({
      $type: "Uint8Array",
      base64: Buffer.from(value).toString("base64"),
    });
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function serializeEvidence(record: object): Buffer {
  return Buffer.from(canonicalJson(record), "utf8");
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

function encryptLine(key: Buffer, envelope: EvidenceEnvelope<SessionEvidence>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(serializeEvidence(envelope)),
    cipher.final(),
  ]);
  const line: EncryptedLine = {
    v: FORMAT_VERSION,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(line) + "\n";
}

function decryptLine(key: Buffer, line: string): EvidenceEnvelope<SessionEvidence> {
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
  return deserializeEvidence<EvidenceEnvelope<SessionEvidence>>(plaintext);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function createRecordEnvelope<T extends SessionEvidence>(
  record: T,
  index: number,
  previousChainSha256: string,
): EvidenceRecordEnvelope<T> {
  const recordSha256 = sha256(record);
  const chainSha256 = sha256({
    schemaVersion: FORMAT_VERSION,
    index,
    previousChainSha256,
    recordSha256,
  });
  return Object.freeze({
    schemaVersion: FORMAT_VERSION,
    kind: "record",
    index,
    previousChainSha256,
    recordSha256,
    chainSha256,
    record,
  });
}

function createSeal(recordCount: number, finalChainSha256: string): EvidenceSeal {
  const body = {
    schemaVersion: FORMAT_VERSION,
    recordCount,
    finalChainSha256,
  } as const;
  return Object.freeze({
    ...body,
    sealSha256: sha256(body),
  });
}

function evidenceError(message: string): Error {
  return new Error("Evidence seal validation failed: " + message);
}

function validateEnvelopeShape(
  envelope: unknown,
): asserts envelope is EvidenceEnvelope<SessionEvidence> {
  if (envelope === null || typeof envelope !== "object") {
    throw evidenceError("record envelope is not an object");
  }
  const candidate = envelope as Record<string, unknown>;
  if (candidate.schemaVersion !== FORMAT_VERSION) {
    throw evidenceError("unsupported envelope version");
  }
  if (candidate.kind === "record") {
    if (
      !Number.isSafeInteger(candidate.index) ||
      (candidate.index as number) < 0 ||
      !isSha256(candidate.previousChainSha256) ||
      !isSha256(candidate.recordSha256) ||
      !isSha256(candidate.chainSha256) ||
      candidate.record === null ||
      typeof candidate.record !== "object"
    ) {
      throw evidenceError("record envelope has invalid fields");
    }
    return;
  }
  if (candidate.kind === "seal") {
    const seal = candidate.seal;
    if (seal === null || typeof seal !== "object") {
      throw evidenceError("seal envelope has no seal");
    }
    const sealCandidate = seal as Record<string, unknown>;
    if (
      sealCandidate.schemaVersion !== FORMAT_VERSION ||
      !Number.isSafeInteger(sealCandidate.recordCount) ||
      (sealCandidate.recordCount as number) < 0 ||
      !isSha256(sealCandidate.finalChainSha256) ||
      !isSha256(sealCandidate.sealSha256)
    ) {
      throw evidenceError("seal envelope has invalid fields");
    }
    return;
  }
  throw evidenceError("unknown envelope kind");
}

function verifyEnvelopes<T extends SessionEvidence>(
  envelopes: readonly EvidenceEnvelope<SessionEvidence>[],
): VerifiedEncryptedEvidence<T> {
  if (envelopes.length === 0) throw evidenceError("file is empty");

  const records: T[] = [];
  let chainSha256 = INITIAL_CHAIN_SHA256;
  let seal: EvidenceSeal | undefined;
  for (const [lineIndex, envelope] of envelopes.entries()) {
    validateEnvelopeShape(envelope);
    if (envelope.kind === "seal") {
      if (seal !== undefined || lineIndex !== envelopes.length - 1) {
        throw evidenceError("seal must occur exactly once at the end of the file");
      }
      seal = Object.freeze({ ...envelope.seal });
      continue;
    }
    if (seal !== undefined) throw evidenceError("record occurs after the seal");
    if (envelope.index !== records.length) {
      throw evidenceError("record index is not contiguous");
    }
    if (envelope.previousChainSha256 !== chainSha256) {
      throw evidenceError("record chain predecessor does not match");
    }
    const record = structuredClone(envelope.record) as T;
    const recordSha256 = sha256(record);
    if (recordSha256 !== envelope.recordSha256) {
      throw evidenceError("record digest does not match");
    }
    const expectedChainSha256 = sha256({
      schemaVersion: FORMAT_VERSION,
      index: envelope.index,
      previousChainSha256: envelope.previousChainSha256,
      recordSha256,
    });
    if (expectedChainSha256 !== envelope.chainSha256) {
      throw evidenceError("record chain digest does not match");
    }
    chainSha256 = expectedChainSha256;
    records.push(record);
  }

  if (seal === undefined) throw evidenceError("missing final seal");
  const expectedSeal = createSeal(records.length, chainSha256);
  if (
    seal.recordCount !== expectedSeal.recordCount ||
    seal.finalChainSha256 !== expectedSeal.finalChainSha256 ||
    seal.sealSha256 !== expectedSeal.sealSha256
  ) {
    throw evidenceError("final seal does not match the record chain");
  }
  return Object.freeze({
    records: Object.freeze(records.map((record) => Object.freeze(structuredClone(record)))),
    seal: expectedSeal,
  });
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

    const immutableRecord = structuredClone(record) as T;
    const envelope = createRecordEnvelope(
      immutableRecord,
      state.recordCount,
      state.chainSha256,
    );
    state.recordCount += 1;
    state.chainSha256 = envelope.chainSha256;
    this.#enqueue(state, record.sessionId, envelope, true);
    return true;
  }

  async close(sessionId: string): Promise<void> {
    const state = this.#states.get(sessionId);
    if (state === undefined) return;
    state.closed = true;
    if (!state.sealQueued) {
      state.sealQueued = true;
      this.#enqueue(state, sessionId, Object.freeze({
        schemaVersion: FORMAT_VERSION,
        kind: "seal",
        seal: createSeal(state.recordCount, state.chainSha256),
      }), false);
    }
    await state.tail;
    if (state.failure !== undefined) throw state.failure;
  }

  #enqueue(
    state: WriterState,
    sessionId: string,
    envelope: EvidenceEnvelope<SessionEvidence>,
    countsTowardsCapacity: boolean,
  ): void {
    if (countsTowardsCapacity) state.pending += 1;
    const encrypted = encryptLine(this.#key, envelope);
    state.tail = state.tail
      .then(async () => {
        if (state.failure !== undefined) throw state.failure;
        await mkdir(this.#directory, { recursive: true });
        await appendFile(this.filePath(sessionId), encrypted, { encoding: "utf8", mode: 0o600 });
      })
      .catch((error: unknown) => {
        state.failure = error instanceof Error ? error : new Error("Evidence write failed");
      })
      .finally(() => {
        if (countsTowardsCapacity) state.pending -= 1;
      });
  }

  #state(sessionId: string): WriterState {
    const existing = this.#states.get(sessionId);
    if (existing !== undefined) return existing;
    const created: WriterState = {
      pending: 0,
      closed: false,
      sealQueued: false,
      recordCount: 0,
      chainSha256: INITIAL_CHAIN_SHA256,
      tail: Promise.resolve(),
    };
    this.#states.set(sessionId, created);
    return created;
  }
}

export async function readVerifiedEncryptedEvidence<T extends SessionEvidence>(
  path: string,
  key: Uint8Array,
): Promise<VerifiedEncryptedEvidence<T>> {
  const validatedKey = validateKey(key);
  const text = await readFile(path, "utf8");
  const envelopes = text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => decryptLine(validatedKey, line));
  return verifyEnvelopes<T>(envelopes);
}

export async function readEncryptedEvidence<T extends SessionEvidence>(
  path: string,
  key: Uint8Array,
): Promise<readonly T[]> {
  return (await readVerifiedEncryptedEvidence<T>(path, key)).records;
}

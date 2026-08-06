import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EncryptedFileEvidenceStore,
  readEncryptedEvidence,
} from "../src/adapters/evidence/encrypted-file.js";
import { InMemoryEvidenceStore } from "../src/adapters/evidence/in-memory.js";

interface TestRecord {
  readonly sessionId: string;
  readonly type: "transcript" | "audio";
  readonly secret?: string;
  readonly pcm16le?: Uint8Array;
}

const taskTemp = join(process.cwd(), "work", "tmp", "evidence-tests");

async function isolatedDirectory(name: string): Promise<string> {
  const directory = join(taskTemp, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  return directory;
}

describe("encrypted evidence store", () => {
  it("never writes transcript or PCM evidence in plaintext", async () => {
    const directory = await isolatedDirectory("encrypted");
    const key = Buffer.alloc(32, 9);
    const store = new EncryptedFileEvidenceStore<TestRecord>({ directory, key });

    assert.equal(store.record({ sessionId: "session-one", type: "transcript", secret: "Abbe error" }), true);
    assert.equal(
      store.record({ sessionId: "session-one", type: "audio", pcm16le: Uint8Array.from([1, 2, 3, 4]) }),
      true,
    );
    await store.close("session-one");

    const path = store.filePath("session-one");
    const raw = await readFile(path, "utf8");
    assert.doesNotMatch(raw, /Abbe error/);
    const decrypted = await readEncryptedEvidence<TestRecord>(path, key);
    assert.equal(decrypted[0]?.secret, "Abbe error");
    assert.deepEqual(decrypted[1]?.pcm16le, Uint8Array.from([1, 2, 3, 4]));
  });

  it("authenticates every record and rejects the wrong key", async () => {
    const directory = await isolatedDirectory("wrong-key");
    const store = new EncryptedFileEvidenceStore<TestRecord>({
      directory,
      key: Buffer.alloc(32, 1),
    });
    store.record({ sessionId: "session-two", type: "transcript", secret: "private" });
    await store.close("session-two");
    await assert.rejects(
      readEncryptedEvidence<TestRecord>(store.filePath("session-two"), Buffer.alloc(32, 2)),
    );
  });

  it("fails open at its bounded non-blocking queue instead of stalling media", async () => {
    const directory = await isolatedDirectory("bounded");
    const store = new EncryptedFileEvidenceStore<TestRecord>({
      directory,
      key: Buffer.alloc(32, 3),
      maxPendingRecords: 1,
    });
    assert.equal(store.record({ sessionId: "session-three", type: "transcript", secret: "first" }), true);
    assert.equal(store.record({ sessionId: "session-three", type: "transcript", secret: "overflow" }), false);
    await store.close("session-three");
  });
});

describe("in-memory evidence store", () => {
  it("clones records and rejects writes after close", async () => {
    const store = new InMemoryEvidenceStore<TestRecord>();
    const pcm = Uint8Array.from([7, 8]);
    assert.equal(store.record({ sessionId: "test", type: "audio", pcm16le: pcm }), true);
    pcm[0] = 99;
    assert.deepEqual(store.records("test")[0]?.pcm16le, Uint8Array.from([7, 8]));
    await store.close("test");
    assert.equal(store.record({ sessionId: "test", type: "transcript" }), false);
  });
});

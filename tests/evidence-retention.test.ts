import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { CANONICAL_AUDIO, createAudioFrame } from "../src/core/audio.js";
import {
  canonicalJsonSha256,
  type SessionProcessingManifest,
  validateSessionProcessingManifest,
} from "../src/core/processing-profile.js";
import {
  exportManagedFinalizedEvidence,
  type ManagedEvidenceExportPort,
} from "../src/adapters/evidence/export.js";
import {
  computeEvidenceTrackDigests,
  SessionArtifactStore,
  type ManagedEvidenceExportLease,
  type ManagedEvidenceExportLeaseCompletion,
  type ManagedEvidenceExportLeaseRequest,
  type ManagedEvidenceExportLeaseResult,
} from "../src/adapters/evidence/session-artifact-store.js";
import { EvidenceReview } from "../src/adapters/evidence/review.js";
import { resolveTranslationBehavior } from "../src/core/translation-behavior.js";
import type { EvidenceRecord, SessionSnapshot } from "../src/core/types.js";

const taskTemp = join(process.cwd(), "work", "tmp", "evidence-retention-tests");
const execFile = promisify(execFileCallback);
const TEST_EVIDENCE_REVIEW_GRANT = Object.freeze({
  dataOwnerId: "retention-owner-1",
  bilingualReviewerId: "bilingual-reviewer-1",
});
const TEST_RETENTION_OWNER_AUTHORITY = Object.freeze({
  kind: "retention_owner" as const,
  actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
});

interface SyncableFileHandle {
  sync(): Promise<void>;
  stat(): Promise<Readonly<{ isDirectory(): boolean }>>;
}

const WINDOWS_ACL_DENYLIST_VERIFICATION_SCRIPT = [
  "& {",
  "param([string] $encodedPath)",
  '$ErrorActionPreference = "Stop"',
  '$base64 = $encodedPath.Replace("-", "+").Replace("_", "/")',
  'switch ($base64.Length % 4) { 2 { $base64 += "==" } 3 { $base64 += "=" } 1 { throw "Invalid encoded path" } }',
  '$path = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($base64))',
  '$acl = Get-Acl -LiteralPath $path',
  'if (-not $acl.AreAccessRulesProtected) { throw "Windows root DACL inherits permissions" }',
  '$rules = @($acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))',
  'foreach ($sid in @("S-1-1-0", "S-1-5-32-545")) {',
  '  if (@($rules | Where-Object { $_.IdentityReference.Value -eq $sid }).Count -ne 0) {',
  '    throw "Windows root still grants a public principal"',
  '  }',
  '}',
  "}",
].join("\n");

async function isolatedRoot(name: string): Promise<string> {
  const root = join(taskTemp, name);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

function encodePowerShellPath(path: string): string {
  return Buffer.from(path, "utf16le").toString("base64url");
}

async function makeWindowsDirectoryPermissive(directory: string): Promise<void> {
  await execFile("icacls.exe", [directory, "/grant", "*S-1-1-0:(OI)(CI)F"], {
    windowsHide: true,
  });
}

async function makeWindowsFilePermissive(path: string): Promise<void> {
  await execFile("icacls.exe", [path, "/grant", "*S-1-1-0:F"], { windowsHide: true });
}

async function assertWindowsDirectoryRejectsPublicPrincipals(directory: string): Promise<void> {
  await execFile("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_ACL_DENYLIST_VERIFICATION_SCRIPT,
    encodePowerShellPath(directory),
  ], { windowsHide: true });
}

async function withInjectedDirectorySyncFailure<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    if ((await this.stat()).isDirectory()) {
      const failure = Object.assign(new Error("injected directory sync failure"), { code: "EPERM" });
      throw failure;
    }
    return originalSync.call(this);
  };
  try {
    return await operation();
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
}

async function withInjectedNthRegularFileSyncFailure<T>(
  directory: string,
  failureOrdinal: number,
  operation: () => Promise<T>,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  let remaining = failureOrdinal;
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    if (!(await this.stat()).isDirectory()) {
      remaining -= 1;
      if (remaining === 0) {
        const failure = Object.assign(new Error("injected regular file sync failure"), { code: "EIO" });
        throw failure;
      }
    }
    return originalSync.call(this);
  };
  try {
    return await operation();
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
}

/**
 * Pause one regular-file fsync while a caller flips an abort fence. This keeps
 * the cancellation regression deterministic without depending on scheduler
 * timing or the number of records in the fixture ledger.
 */
async function withInjectedDelayedNthRegularFileSync<T>(
  directory: string,
  syncOrdinal: number,
  operation: () => Promise<T>,
  onEntered: (release: () => void) => Promise<void> | void,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  let remaining = syncOrdinal;
  let entered = false;
  let released = false;
  let resolveEntered!: () => void;
  let resolveRelease!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { resolveEntered = resolve; });
  const releasePromise = new Promise<void>((resolve) => { resolveRelease = resolve; });
  const release = (): void => {
    if (released) return;
    released = true;
    resolveRelease();
  };
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    if (!(await this.stat()).isDirectory()) {
      remaining -= 1;
      if (remaining === 0) {
        entered = true;
        resolveEntered();
        await releasePromise;
      }
    }
    return originalSync.call(this);
  };
  const completion = operation();
  try {
    const outcome = await Promise.race([
      enteredPromise.then(() => true),
      completion.then(() => false, () => false),
    ]);
    if (outcome && entered) await onEntered(release);
    return await completion;
  } finally {
    release();
    await completion.catch(() => undefined);
    prototype.sync = originalSync;
    await probe.close();
  }
}

/**
 * Hold every regular-file fsync until the caller releases the gate. The
 * regular sync itself is intentionally skipped after release: these tests
 * exercise admission/drain behavior, not platform durability latency.
 */
async function withBlockedRegularFileSync<T>(
  directory: string,
  operation: (
    waitForEntered: (count: number) => Promise<void>,
    release: () => void,
  ) => Promise<T>,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  let entered = 0;
  let released = false;
  const waiters = new Map<number, Array<() => void>>();
  let resolveRelease!: () => void;
  const releasePromise = new Promise<void>((resolve) => { resolveRelease = resolve; });
  const waitForEntered = (count: number): Promise<void> => {
    if (entered >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const pending = waiters.get(count) ?? [];
      pending.push(resolve);
      waiters.set(count, pending);
    });
  };
  const release = (): void => {
    if (released) return;
    released = true;
    resolveRelease();
  };
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    if (!(await this.stat()).isDirectory()) {
      entered += 1;
      for (const [count, pending] of waiters) {
        if (entered < count) continue;
        waiters.delete(count);
        for (const resolve of pending) resolve();
      }
      await releasePromise;
      return;
    }
    // Directory fsyncs are suppressed as well so draining hundreds of
    // independent lifecycle markers remains bounded on Windows CI.
    void originalSync;
    return;
  };
  try {
    return await operation(waitForEntered, release);
  } finally {
    release();
    prototype.sync = originalSync;
    await probe.close();
  }
}

/**
 * Capacity regressions append hundreds of tiny authenticated entries. Keep the
 * test focused on lifecycle behavior instead of making every synthetic append
 * pay the platform's durable-fsync latency.
 */
async function withSuppressedFileSync<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const probe = await open(directory, process.platform === "win32" ? "r+" : "r");
  const prototype = Object.getPrototypeOf(probe) as {
    sync(this: SyncableFileHandle): Promise<void>;
  };
  const originalSync = prototype.sync;
  prototype.sync = async function(this: SyncableFileHandle): Promise<void> {
    void this;
  };
  try {
    return await operation();
  } finally {
    prototype.sync = originalSync;
    await probe.close();
  }
}

function unleasedStoreFor(
  root: string,
  now: () => number = () => 1_000,
  onWindowsSecurityRootAclOperation?: () => void,
): SessionArtifactStore {
  return new SessionArtifactStore({
    archiveDirectory: join(root, "archive"),
    keyDirectory: join(root, "keys"),
    exportDirectory: join(root, "exports"),
    receiptDirectory: join(root, "receipts"),
    securityBoundaryDirectory: root,
    strictAncestors: false,
    rootKey: Buffer.alloc(32, 7),
    dataOwnerId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
    minimumFreeBytes: 1,
    now,
    ...(onWindowsSecurityRootAclOperation === undefined
      ? {}
      : { onWindowsSecurityRootAclOperation }),
  });
}

function storeFor(
  root: string,
  now: () => number = () => 1_000,
  onWindowsSecurityRootAclOperation?: () => void,
): SessionArtifactStore {
  return unleasedStoreFor(root, now, onWindowsSecurityRootAclOperation);
}

async function withServerLease<T>(
  store: SessionArtifactStore,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = await store.acquireEvidenceRootLease("server");
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

function testProcessingManifest(): SessionProcessingManifest {
  const reference = {
    id: "poc-contract",
    revision: "2026-08",
    sha256: "1".repeat(64),
    approvedBy: "compliance@example.test",
    approvedAtUtc: "2026-08-09T00:00:00.000Z",
  };
  const unverified = {
    status: "unverified" as const,
    reason: "POC vendor assurance is pending",
    acceptanceImpact: "NOT_RUN" as const,
  };
  const services = [{
    id: "openai-realtime",
    role: "speech_to_speech" as const,
    provider: "openai" as const,
    category: "managed_realtime_speech_translation" as const,
    dataCategories: ["canonical_audio", "target_language"] as const,
    endpoint: { origin: "https://api.openai.example", pathTemplate: "/v1/realtime" },
    model: { kind: "named" as const, value: "gpt-realtime" },
    voice: { kind: "named" as const, value: "alloy" },
    region: unverified,
    trainingUse: unverified,
    serviceRetention: unverified,
    dpa: unverified,
  }];
  const body = {
    schemaVersion: 1 as const,
    profile: { id: "manufacturing-poc", version: "2026-08-09", sha256: "2".repeat(64) },
    operationScope: "poc" as const,
    acceptanceImpact: "NOT_RUN" as const,
    selectedTranslation: {
      provider: "openai_native" as const,
      mode: "fast" as const,
      behaviorVersion: 1 as const,
      servicesSha256: canonicalJsonSha256(services),
    },
    services,
    consentPolicyRef: {
      ...reference,
      noticeVersion: "manufacturing-notice-v1",
      recordingRequired: true as const,
      processingRequired: true as const,
      withdrawalTerminatesSession: true as const,
    },
    glossaryEgress: {
      harnessPinnedGlossary: "disallowed" as const,
      stages: [] as const,
      providerAccountGlossary: unverified,
    },
    fallback: { kind: "none" as const, approval: reference },
    evidence: {
      storage: "local_encrypted_file" as const,
      encryption: "aes_256_gcm" as const,
      tracks: ["source_a", "source_b", "playout_to_a", "playout_to_b"] as const,
      providerEvents: "final_only" as const,
      provisionalEvents: "live_only" as const,
      browserEvidenceRefs: "redacted" as const,
      plaintextExport: "explicit_owner_acknowledgement" as const,
      minimumFreeBytes: "1",
    },
    retentionPolicy: {
      policyRef: reference,
      mode: "scheduled_delete" as const,
      defaultDays: 14 as const,
      maximumDays: 30 as const,
      verificationMaximumHours: 24 as const,
    },
  };
  return { ...body, manifestSha256: canonicalJsonSha256(body) } satisfies SessionProcessingManifest;
}

function testSessionOpenedRecord(
  sessionId: string,
  processingManifest = testProcessingManifest(),
): EvidenceRecord {
  const snapshot = {
    sessionId,
    status: "waiting",
    spec: {
      sideA: { language: "en-US" },
      sideB: { language: "zh-TW" },
      provider: processingManifest.selectedTranslation.provider,
      mode: processingManifest.selectedTranslation.mode,
      processingManifest,
      evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
    },
    participants: {
      A: { kind: "browser_link", side: "A", url: "https://example.test/a", qrDataUrl: "data:,a" },
      B: { kind: "browser_link", side: "B", url: "https://example.test/b", qrDataUrl: "data:,b" },
    },
    participantConsent: {
      A: { consented: false, recording: false, processing: false },
      B: { consented: false, recording: false, processing: false },
    },
    recorderArmState: "awaiting_consents",
    recordingArmed: false,
    participantReadiness: { A: undefined, B: undefined },
    providerReadiness: { A_TO_B: undefined, B_TO_A: undefined },
    generations: { A_TO_B: 0, B_TO_A: 0 },
    behavior: resolveTranslationBehavior(processingManifest.selectedTranslation.mode),
    eventCursor: 1,
    openedAtMs: 0,
  } satisfies SessionSnapshot;
  return {
    type: "session_event",
    sessionId,
    event: {
      type: "session_opened",
      cursor: 1,
      sessionId,
      timestampMonoMs: 1,
      lane: null,
      generation: null,
      snapshot,
    },
  } as EvidenceRecord;
}

async function writeValidManagedExportWorkspace(
  lease: ManagedEvidenceExportLease,
): Promise<Readonly<Pick<ManagedEvidenceExportLeaseCompletion<unknown>, "manifestFileSha256" | "completedAtMs">>> {
  let completion: ManagedEvidenceExportLeaseCompletion<unknown> | undefined;
  const artifacts: ManagedEvidenceExportPort = {
    async withManagedExportLease<T>(
      _request: ManagedEvidenceExportLeaseRequest,
      transaction: (
        activeLease: ManagedEvidenceExportLease,
      ) => Promise<ManagedEvidenceExportLeaseCompletion<T>>,
    ): Promise<ManagedEvidenceExportLeaseResult<T>> {
      const current = await transaction(lease);
      completion = current as ManagedEvidenceExportLeaseCompletion<unknown>;
      return {
        status: "completed",
        exportId: lease.exportId,
        manifestFileSha256: current.manifestFileSha256,
        completedAtMs: current.completedAtMs,
        value: current.value,
      };
    },
  };
  const result = await exportManagedFinalizedEvidence({
    artifacts,
    lookup: { archiveId: lease.artifact.archiveId },
    commandId: "retention-test-workspace-" + lease.exportId,
    authority: TEST_RETENTION_OWNER_AUTHORITY,
    requestedAtMs: lease.nowMs(),
  });
  if (result.status !== "completed" || completion === undefined) {
    throw new Error("Expected the production exporter to complete the test workspace");
  }
  return {
    manifestFileSha256: completion.manifestFileSha256,
    completedAtMs: completion.completedAtMs,
  };
}

async function sealedStoreForRetention(
  root: string,
  now: () => number,
  onWindowsSecurityRootAclOperation?: () => void,
): Promise<Readonly<{ store: SessionArtifactStore; sessionId: string }>> {
  const store = storeFor(root, now, onWindowsSecurityRootAclOperation);
  const sessionId = "retention-sealed-session";
  const processingManifest = testProcessingManifest();
  validateSessionProcessingManifest(processingManifest);
  const persist = async (value: EvidenceRecord): Promise<void> => {
    await store.persist(value);
  };
  await withServerLease(store, async () => {
  await persist(testSessionOpenedRecord(sessionId, processingManifest));
  await store.flush(sessionId);

  const preflight = await store.preflightRecorder({
    sessionId,
    processingManifestSha256: processingManifest.manifestSha256,
    checkedAtMonoMs: 2,
  });
  assert.equal(preflight.status, "ready", JSON.stringify(preflight));
  if (preflight.status !== "ready") throw new Error("Expected recorder preflight to succeed");
  await persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 2, preflight });
  for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
    await persist({
      type: "session_event",
      sessionId,
      event: {
        type: "participant_consent",
        cursor,
        sessionId,
        timestampMonoMs: cursor,
        lane: null,
        generation: null,
        side,
        consentId: "consent-" + side,
        consentPolicyRef: processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
        acceptedAtMonoMs: cursor,
      },
    } as unknown as EvidenceRecord);
  }
  await persist({
    type: "audio",
    sessionId,
    track: "source_a",
    timelineAtMonoMs: 10,
    frame: createAudioFrame({
      sessionId,
      lane: "A_TO_B",
      generation: 0,
      sequence: 0,
      capturedAtMs: 10,
      pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(7),
    }),
  });
  await store.flush(sessionId);
  const finalization = await store.finalize({
    sessionId,
    processingManifestSha256: processingManifest.manifestSha256,
    finalizedAtMonoMs: 20,
    reason: "operator_end",
    lastPersistedEventCursor: 3,
  });
  assert.equal(finalization.status, "sealed");
  });
  return Object.freeze({ store, sessionId });
}

async function failedFinalizationStoreForRetention(
  root: string,
  now: () => number,
): Promise<Readonly<{ store: SessionArtifactStore; sessionId: string }>> {
  const store = storeFor(root, now);
  const sessionId = "retention-failed-session";
  const processingManifest = testProcessingManifest();
  const persist = async (value: EvidenceRecord): Promise<void> => {
    await store.persist(value);
  };
  await withServerLease(store, async () => {
  await persist(testSessionOpenedRecord(sessionId, processingManifest));
  await store.flush(sessionId);
  const preflight = await store.preflightRecorder({
    sessionId,
    processingManifestSha256: processingManifest.manifestSha256,
    checkedAtMonoMs: 2,
  });
  assert.equal(preflight.status, "ready", JSON.stringify(preflight));
  if (preflight.status !== "ready") throw new Error("Expected recorder preflight to succeed");
  await persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 2, preflight });
  for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
    await persist({
      type: "session_event",
      sessionId,
      event: {
        type: "participant_consent",
        cursor,
        sessionId,
        timestampMonoMs: cursor,
        lane: null,
        generation: null,
        side,
        consentId: "consent-" + side,
        consentPolicyRef: processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
        acceptedAtMonoMs: cursor,
      },
    } as unknown as EvidenceRecord);
  }
  await persist({
    type: "audio",
    sessionId,
    track: "source_a",
    timelineAtMonoMs: 10,
    frame: createAudioFrame({
      sessionId,
      lane: "A_TO_B",
      generation: 0,
      sequence: 0,
      capturedAtMs: 10,
      pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(7),
    }),
  });
  await store.flush(sessionId);
  const finalization = await store.finalize({
    sessionId,
    processingManifestSha256: processingManifest.manifestSha256,
    finalizedAtMonoMs: 20,
    reason: "operator_end",
    lastPersistedEventCursor: 99,
  });
  assert.equal(finalization.status, "FINALIZATION_FAILED");
  });
  return Object.freeze({ store, sessionId });
}

async function activeOrphanForRetention(
  root: string,
  now: () => number,
  sessionId: string,
): Promise<Readonly<{
  store: SessionArtifactStore;
  sessionId: string;
  processingManifest: SessionProcessingManifest;
}>> {
  const writer = storeFor(root, now);
  const processingManifest = testProcessingManifest();
  await withServerLease(writer, async () => {
  await writer.persist({
    type: "session_event",
    sessionId,
    event: {
      type: "session_opened",
      cursor: 1,
      sessionId,
      timestampMonoMs: 1,
      lane: null,
      generation: null,
      snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
    },
  } as unknown as EvidenceRecord);
  await writer.flush(sessionId);
  });
  return Object.freeze({ store: writer, sessionId, processingManifest });
}

async function preparedStreamingFinalizationStore(
  root: string,
  now: () => number,
  audioRecordCount: number,
): Promise<Readonly<{
  readonly store: SessionArtifactStore;
  readonly sessionId: string;
  readonly processingManifest: SessionProcessingManifest;
  readonly recordCount: number;
}>> {
  const store = storeFor(root, now);
  const sessionId = "streaming-finalization-session";
  const processingManifest = testProcessingManifest();
  await withServerLease(store, async () => {
    await store.persist(testSessionOpenedRecord(sessionId, processingManifest));
    const preflight = await store.preflightRecorder({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected streaming fixture preflight");
    await store.persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 2, preflight });
    for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
      await store.persist({
        type: "session_event",
        sessionId,
        event: {
          type: "participant_consent",
          cursor,
          sessionId,
          timestampMonoMs: cursor,
          lane: null,
          generation: null,
          side,
          consentId: "streaming-consent-" + side,
          consentPolicyRef: processingManifest.consentPolicyRef,
          recording: true,
          processing: true,
          acceptedAtMonoMs: cursor,
        },
      } as unknown as EvidenceRecord);
    }
    for (let index = 0; index < audioRecordCount; index += 1) {
      const timelineAtMonoMs = 20 + index * CANONICAL_AUDIO.frameDurationMs;
      await store.persist({
        type: "audio",
        sessionId,
        track: "source_a",
        timelineAtMonoMs,
        frame: createAudioFrame({
          sessionId,
          lane: "A_TO_B",
          generation: 0,
          sequence: index,
          capturedAtMs: timelineAtMonoMs,
          pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(index % 256),
        }),
      });
    }
    await store.flush(sessionId);
  });
  return Object.freeze({
    store,
    sessionId,
    processingManifest,
    recordCount: 4 + audioRecordCount,
  });
}

describe("session artifact store", () => {
  it("rejects archive, key, export, and receipt roots that overlap", async () => {
    const root = await isolatedRoot("overlapping-roots");
    const archiveDirectory = join(root, "archive");

    assert.throws(
      () => new SessionArtifactStore({
        archiveDirectory,
        keyDirectory: join(archiveDirectory, "keys"),
        exportDirectory: join(root, "exports"),
        receiptDirectory: join(root, "receipts"),
        rootKey: Buffer.alloc(32, 7),
      }),
      /distinct, non-nested security roots/u,
    );
  });

  it("hardens pre-existing POSIX evidence roots to owner-only access", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("root-permissions");
    const archiveDirectory = join(root, "archive");
    await mkdir(archiveDirectory, { recursive: true, mode: 0o755 });
    await chmod(archiveDirectory, 0o755);

    const store = storeFor(root);
    await withServerLease(store, async () => {
      assert.equal((await store.recover()).status, "completed");
    });
    const rootInfo = await lstat(archiveDirectory);
    assert.equal(rootInfo.mode & 0o077, 0);
    if (typeof process.getuid === "function") {
      assert.equal(rootInfo.uid, process.getuid());
    }
  });

  it("hardens every evidence root against Everyone and Users on Windows", {
    skip: process.platform !== "win32",
  }, async () => {
    const root = await isolatedRoot("windows-root-acl");
    const staleExportDirectory = join(root, "archive", "stale-export");
    const staleExportFile = join(staleExportDirectory, "manifest.json");
    await mkdir(staleExportDirectory, { recursive: true });
    await writeFile(staleExportFile, "{}\n");
    await makeWindowsDirectoryPermissive(root);
    await makeWindowsDirectoryPermissive(staleExportDirectory);
    await makeWindowsFilePermissive(staleExportFile);
    const store = storeFor(root);
    const lease = await store.acquireEvidenceRootLease("server");
    try {
      for (const directory of ["archive", "keys", "exports", "receipts"]) {
        await assertWindowsDirectoryRejectsPublicPrincipals(join(root, directory));
      }
      await assertWindowsDirectoryRejectsPublicPrincipals(staleExportDirectory);
      await assertWindowsDirectoryRejectsPublicPrincipals(staleExportFile);
    } finally {
      await lease.release();
    }
  });

  it("does not re-run Windows root ACL tooling for repeated content-free audit appends", {
    skip: process.platform !== "win32",
  }, async () => {
    const root = await isolatedRoot("windows-audit-acl-hot-path");
    let aclOperations = 0;
    const { store, sessionId } = await sealedStoreForRetention(
      root,
      () => 1_705_000_000_000,
      () => { aclOperations += 1; },
    );
    const responseSha256 = createHash("sha256").update("windows-audit-hot-path").digest("hex");

    await withServerLease(store, async () => {
      const admittedOperations = aclOperations;
      for (let index = 0; index < 8; index += 1) {
        assert.equal((await store.withVerifiedSealedReviewLease({
          kind: "retention_summary",
          sessionId,
          actor: {
            role: "retention_owner",
            actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
          },
        }, async () => ({ value: index, responseSha256 }))).status, "completed");
      }
      assert.equal(aclOperations, admittedOperations);
    });
  });

  it("rejects a configured security root with an intermediate symbolic-link ancestor", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("root-intermediate-symlink");
    const physicalParent = join(root, "physical-parent");
    const linkedParent = join(root, "linked-parent");
    await mkdir(physicalParent, { recursive: true });
    await symlink(physicalParent, linkedParent, "dir");
    const store = new SessionArtifactStore({
      archiveDirectory: join(linkedParent, "archive"),
      keyDirectory: join(root, "keys"),
      exportDirectory: join(root, "exports"),
      receiptDirectory: join(root, "receipts"),
      rootKey: Buffer.alloc(32, 7),
      minimumFreeBytes: 1,
    });
    await assert.rejects(
      store.acquireEvidenceRootLease("server"),
      /symbolic-link or non-directory ancestor/u,
    );
  });

  it("rejects a configured security root below a writable non-sticky POSIX ancestor", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("root-writable-non-sticky-ancestor");
    const unsafeParent = join(root, "unsafe-parent");
    await mkdir(unsafeParent, { recursive: true, mode: 0o777 });
    await chmod(unsafeParent, 0o777);
    const store = new SessionArtifactStore({
      archiveDirectory: join(unsafeParent, "archive"),
      keyDirectory: join(root, "keys"),
      exportDirectory: join(root, "exports"),
      receiptDirectory: join(root, "receipts"),
      rootKey: Buffer.alloc(32, 7),
      minimumFreeBytes: 1,
    });

    await assert.rejects(
      store.acquireEvidenceRootLease("server"),
      /writable non-sticky ancestor/u,
    );
  });

  it("rechecks configured root ancestors after validation on POSIX", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("root-ancestor-recheck");
    const safeParent = join(root, "safe-parent");
    await mkdir(safeParent, { recursive: true, mode: 0o700 });
    await chmod(safeParent, 0o700);
    const store = new SessionArtifactStore({
      archiveDirectory: join(safeParent, "archive"),
      keyDirectory: join(root, "keys"),
      exportDirectory: join(root, "exports"),
      receiptDirectory: join(root, "receipts"),
      rootKey: Buffer.alloc(32, 7),
      minimumFreeBytes: 1,
    });
    const lease = await store.acquireEvidenceRootLease("server");
    try {
      assert.equal((await store.recover()).status, "completed");
    } finally {
      await lease.release();
    }

    await chmod(safeParent, 0o777);
    await assert.rejects(
      store.acquireEvidenceRootLease("server"),
      /writable non-sticky ancestor/u,
    );
  });

  it("fails closed on an unsigned root marker without reclaiming it", async () => {
    const root = await isolatedRoot("unsigned-root-lock-fail-closed");
    const keyDirectory = join(root, "keys");
    await mkdir(keyDirectory, { recursive: true });
    const markerPath = join(keyDirectory, "evidence-root.lifecycle.lock");
    const markerContents = JSON.stringify({
      schemaVersion: 3,
      kind: "evidence_root_process_lease",
      role: "server",
      host: hostname(),
      processId: process.pid,
      processStartIdentity: "crashed-process-instance",
      lockId: "a".repeat(64),
    }) + "\n";
    await writeFile(markerPath, markerContents);

    await assert.rejects(
      storeFor(root).acquireEvidenceRootLease("server"),
      /Evidence root is leased by another process/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), markerContents);
  });

  it("does not mutate any configured root when a live foreign root lease rejects admission", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("foreign-root-lease-does-not-mutate-roots");
    const roots = ["archive", "keys", "exports", "receipts"] as const;
    for (const name of roots) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true, mode: 0o755 });
      await chmod(directory, 0o755);
    }
    const sentinelPath = join(root, "archive", "must-not-be-touched.txt");
    await writeFile(sentinelPath, "root-admission-sentinel\n", { mode: 0o644 });
    await writeFile(join(root, "keys", "evidence-root.lifecycle.lock"), JSON.stringify({
      schemaVersion: 3,
      kind: "evidence_root_process_lease",
      role: "server",
      host: "another-live-host.example.test",
      processId: 42,
      processStartIdentity: "foreign-live-process",
      lockId: "f".repeat(64),
    }) + "\n", { mode: 0o600 });

    await assert.rejects(
      storeFor(root).acquireEvidenceRootLease("offline_admin"),
      /Evidence root is leased by another process/u,
    );

    for (const name of roots) {
      const info = await lstat(join(root, name));
      assert.equal(info.mode & 0o777, 0o755, name + " root mode changed on rejected admission");
    }
    assert.equal(await readFile(sentinelPath, "utf8"), "root-admission-sentinel\n");
  });

  it("fails closed on a malformed root marker without reclaiming it", async () => {
    const root = await isolatedRoot("malformed-root-lock-fail-closed");
    await mkdir(join(root, "keys"), { recursive: true });
    const markerPath = join(root, "keys", "evidence-root.lifecycle.lock");
    const markerContents = "{torn-marker";
    await writeFile(markerPath, markerContents);
    const store = storeFor(root);
    await assert.rejects(
      store.acquireEvidenceRootLease("offline_admin"),
      /Evidence root is leased by another process/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), markerContents);
  });

  it("rejects an oversized root marker before parsing and leaves it in place", async () => {
    const root = await isolatedRoot("oversized-root-lock-fail-closed");
    const keyDirectory = join(root, "keys");
    await mkdir(keyDirectory, { recursive: true });
    const markerPath = join(keyDirectory, "evidence-root.lifecycle.lock");
    const markerContents = Buffer.alloc(16 * 1024 + 1, 0x7f);
    await writeFile(markerPath, markerContents);

    await assert.rejects(
      storeFor(root).acquireEvidenceRootLease("server"),
      /Lifecycle lock marker exceeds its maximum size/u,
    );
    const persisted = await readFile(markerPath);
    assert.equal(persisted.byteLength, markerContents.byteLength);
    assert.deepEqual(persisted, markerContents);
  });

  it("reclaims a signed dead root marker from an exited child process", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("signed-dead-root-lock-reclaim");
    const markerPath = join(root, "keys", "evidence-root.lifecycle.lock");
    const storeModule = pathToFileURL(join(
      process.cwd(),
      "dist-test",
      "src",
      "adapters",
      "evidence",
      "session-artifact-store.js",
    )).href;
    const childScript = `
      import { SessionArtifactStore } from ${JSON.stringify(storeModule)};
      const root = ${JSON.stringify(root)};
      const store = new SessionArtifactStore({
        archiveDirectory: root + "/archive",
        keyDirectory: root + "/keys",
        exportDirectory: root + "/exports",
        receiptDirectory: root + "/receipts",
        rootKey: Buffer.alloc(32, 7),
        minimumFreeBytes: 1,
      });
      await store.acquireEvidenceRootLease("server");
    `;
    await execFile(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      windowsHide: true,
    });

    const successor = storeFor(root);
    const lease = await successor.acquireEvidenceRootLease("offline_admin");
    assert.equal(lease.role, "offline_admin");
    await lease.release();
    await assert.rejects(readFile(markerPath), /ENOENT/u);
  });

  it("removes an uncommitted root marker after directory fsync failure so retry succeeds", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await isolatedRoot("root-lock-directory-fsync-failure");
    const markerPath = join(root, "keys", "evidence-root.lifecycle.lock");
    const store = storeFor(root);

    await assert.rejects(
      withInjectedDirectorySyncFailure(root, () => store.acquireEvidenceRootLease("server")),
      /injected directory sync failure/u,
    );
    await assert.rejects(readFile(markerPath), /ENOENT/u);

    const successor = storeFor(root);
    const lease = await successor.acquireEvidenceRootLease("offline_admin");
    await lease.release();
  });

  it("requires each Store instance to own a root lease before filesystem operations", async () => {
    const root = await isolatedRoot("persist-respects-root-lease");
    const owner = unleasedStoreFor(root);
    const blocked = unleasedStoreFor(root);
    const processingManifest = testProcessingManifest();
    const ownerRecordBody = {
      type: "session_event" as const,
      sessionId: "root-lease-owner-session",
      event: {
        type: "session_opened" as const,
        cursor: 1,
        sessionId: "root-lease-owner-session",
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
      },
    };
    const ownerRecord = ownerRecordBody as unknown as EvidenceRecord;
    await assert.rejects(
      owner.persist(ownerRecord),
      /This evidence store must own an evidence root lease before filesystem operations/u,
    );
    const secondUnleasedSessionId = "root-lease-second-unleased-session";
    await assert.rejects(
      blocked.persist({
        ...ownerRecordBody,
        sessionId: secondUnleasedSessionId,
        event: { ...ownerRecordBody.event, sessionId: secondUnleasedSessionId },
      } as unknown as EvidenceRecord),
      /This evidence store must own an evidence root lease before filesystem operations/u,
    );

    const lease = await owner.acquireEvidenceRootLease("server");
    try {
      await owner.persist(ownerRecord);
      await assert.rejects(blocked.persist({
        type: "session_event",
        sessionId: "root-lease-blocked-session",
        event: {
          type: "session_opened",
          cursor: 1,
          sessionId: "root-lease-blocked-session",
          timestampMonoMs: 1,
          lane: null,
          generation: null,
          snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
        },
      } as unknown as EvidenceRecord), /This evidence store must own an evidence root lease before filesystem operations/u);
    } finally {
      await lease.release();
    }
    await assert.rejects(
      owner.flush("root-lease-owner-session"),
      /This evidence store must own an evidence root lease before filesystem operations/u,
    );
  });

  it("requires the owning root lease for every public filesystem operation", async () => {
    const root = await isolatedRoot("all-public-operations-require-root-lease");
    const store = unleasedStoreFor(root);
    const sessionId = "all-public-operations-session";
    const missingLease = /This evidence store must own an evidence root lease before filesystem operations/u;
    const assertMissingLease = async (operation: () => Promise<unknown>): Promise<void> => {
      await assert.rejects(operation(), missingLease);
    };

    await assertMissingLease(() => store.persist(testSessionOpenedRecord(sessionId)));
    await assertMissingLease(() => store.flush(sessionId));
    await assertMissingLease(() => store.artifact({ sessionId }));
    await assertMissingLease(() => store.preflightRecorder({
      sessionId,
      processingManifestSha256: "a".repeat(64),
      checkedAtMonoMs: 1,
    }));
    await assertMissingLease(() => store.finalize({
      sessionId,
      processingManifestSha256: "a".repeat(64),
      finalizedAtMonoMs: 2,
      reason: "operator_end",
      lastPersistedEventCursor: 0,
    }));
    await assertMissingLease(() => store.withVerifiedSealedReviewLease({
      kind: "retention_summary",
      sessionId,
      actor: {
        role: "retention_owner",
        actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
      },
    }, async () => ({
      value: null,
      responseSha256: "a".repeat(64),
    })));
    await assertMissingLease(() => store.getRetention(sessionId));
    await assertMissingLease(() => store.extendRetention({
      sessionId,
      commandId: "extend-without-lease",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "test",
      requestedAtMs: 1,
      requestedDeadlineAtMs: 2,
    }));
    await assertMissingLease(() => store.deleteEvidence({
      sessionId,
      commandId: "delete-without-lease",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "test",
      requestedAtMs: 1,
    }));
    await assertMissingLease(() => store.recover());
    await assertMissingLease(() => store.sweepExpired());
    await assertMissingLease(() => store.withManagedExportLease({
      lookup: { sessionId },
      commandId: "export-without-lease",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      requestedAtMs: 1,
    }, async () => ({
      value: null,
      manifestFileSha256: "a".repeat(64),
      completedAtMs: 1,
    })));
  });

  it("accepts a reused glossary/reference DAG but rejects a cycle before sidecar creation", async () => {
    const sharedGlossary = Object.freeze({
      id: "shared-glossary",
      version: "2026-08-10",
      hash: "c".repeat(64),
      entries: Object.freeze([]),
    });
    const dagRoot = await isolatedRoot("ingest-shared-glossary-dag");
    const dagStore = storeFor(dagRoot);
    const dagSessionId = "ingest-shared-glossary-dag-session";
    const processingManifest = testProcessingManifest();
    const dagRecord = {
      type: "session_event",
      sessionId: dagSessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId: dagSessionId,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: {
          sessionId: dagSessionId,
          spec: {
            processingManifest,
            evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
            glossary: sharedGlossary,
          },
          glossary: sharedGlossary,
        },
      },
    } as unknown as EvidenceRecord;

    await withServerLease(dagStore, async () => {
      await dagStore.persist(dagRecord);
      await dagStore.flush(dagSessionId);
      assert.equal((await dagStore.artifact({ sessionId: dagSessionId }))?.status, "active");
    });

    const cyclicRoot = await isolatedRoot("ingest-cyclic-record-rejected");
    const cyclicStore = storeFor(cyclicRoot);
    const cyclicSessionId = "ingest-cyclic-record-session";
    const cyclicEvent: Record<string, unknown> = {
      type: "session_opened",
      cursor: 1,
      sessionId: cyclicSessionId,
      timestampMonoMs: 1,
      lane: null,
      generation: null,
      snapshot: {
        sessionId: cyclicSessionId,
        spec: {
          processingManifest,
          evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT,
          glossary: sharedGlossary,
        },
        glossary: sharedGlossary,
      },
    };
    const cyclicRecord: Record<string, unknown> = {
      type: "session_event",
      sessionId: cyclicSessionId,
      event: cyclicEvent,
    };
    cyclicEvent.cycle = cyclicRecord;

    await withServerLease(cyclicStore, async () => {
      await assert.rejects(
        cyclicStore.persist(cyclicRecord as unknown as EvidenceRecord),
        /Evidence record contains a cycle/u,
      );
      const keyNames = await readdir(join(cyclicRoot, "keys"));
      assert.deepEqual(keyNames.filter((name) => name.endsWith(".key.json")), []);
    });
  });

  it("keeps the root marker until an entered managed export operation completes", async () => {
    const root = await isolatedRoot("root-lease-release-interleaving");
    const nowMs = 1_790_000_000_000;
    const now = (): number => nowMs;
    const { sessionId } = await sealedStoreForRetention(root, now);
    const owner = unleasedStoreFor(root, now);
    const lease = await owner.acquireEvidenceRootLease("server");
    const entered = Promise.withResolvers<void>();
    const continueOperation = Promise.withResolvers<void>();
    const operation = owner.withManagedExportLease({
      lookup: { sessionId },
      commandId: "root-lease-release-interleaving-export",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      requestedAtMs: nowMs,
    }, async () => {
      entered.resolve();
      await continueOperation.promise;
      throw new Error("root lease interleaving operation complete");
    });
    await entered.promise;

    let releaseCompleted = false;
    const releasing = lease.release().then(() => {
      releaseCompleted = true;
    });
    await Promise.resolve();
    assert.equal(releaseCompleted, false);
    await assert.rejects(
      unleasedStoreFor(root, now).acquireEvidenceRootLease("offline_admin"),
      /Evidence root is leased by another process/u,
    );

    continueOperation.resolve();
    await assert.rejects(operation, /root lease interleaving operation complete/u);
    await releasing;

    const successor = unleasedStoreFor(root, now);
    const successorLease = await successor.acquireEvidenceRootLease("offline_admin");
    await successorLease.release();
  });

  it("retries a transient root-marker release failure without abandoning ownership", async () => {
    const root = await isolatedRoot("root-lease-release-retry");
    const store = unleasedStoreFor(root);
    const lease = await store.acquireEvidenceRootLease("server");
    const markerPath = join(root, "keys", "evidence-root.lifecycle.lock");
    const markerContents = await readFile(markerPath, "utf8");
    let markerIsDirectory = false;
    try {
      await rm(markerPath);
      await mkdir(markerPath);
      markerIsDirectory = true;
      await assert.rejects(lease.release(), /Lifecycle lock marker is not a regular file/u);

      await rm(markerPath, { recursive: true, force: true });
      markerIsDirectory = false;
      await writeFile(markerPath, markerContents, { mode: 0o600 });
      await lease.release();

      const successor = unleasedStoreFor(root);
      const successorLease = await successor.acquireEvidenceRootLease("offline_admin");
      await successorLease.release();
    } finally {
      if (markerIsDirectory) {
        await rm(markerPath, { recursive: true, force: true });
        await writeFile(markerPath, markerContents, { mode: 0o600 });
      }
      await lease.release().catch(() => undefined);
    }
  });

  it("evicts active state on root release so a cross-store quarantine is visible after reacquire", async () => {
    const root = await isolatedRoot("root-lease-release-evicts-active-state");
    const nowMs = 1_790_500_000_000;
    const now = (): number => nowMs;
    const createStore = (): SessionArtifactStore => new SessionArtifactStore({
      archiveDirectory: join(root, "archive"),
      keyDirectory: join(root, "keys"),
      exportDirectory: join(root, "exports"),
      receiptDirectory: join(root, "receipts"),
      securityBoundaryDirectory: root,
      strictAncestors: false,
      rootKey: Buffer.alloc(32, 7),
      dataOwnerId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
      minimumFreeBytes: 1,
      now,
    });
    const writer = createStore();
    const sessionId = "root-release-cross-store-quarantine";
    const processingManifest = testProcessingManifest();

    await withServerLease(writer, async () => {
      await writer.persist({
        type: "session_event",
        sessionId,
        event: {
          type: "session_opened",
          cursor: 1,
          sessionId,
          timestampMonoMs: 1,
          lane: null,
          generation: null,
          snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
        },
      } as unknown as EvidenceRecord);
      await writer.flush(sessionId);
    });

    const quarantining = createStore();
    await withServerLease(quarantining, async () => {
      assert.equal((await quarantining.recover()).status, "completed");
      assert.equal((await quarantining.artifact({ sessionId }))?.status, "FINALIZATION_FAILED");
    });

    await withServerLease(writer, async () => {
      assert.deepEqual(await writer.getRetention(sessionId), {
        status: "FINALIZATION_FAILED",
        retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
        extensionUsed: false,
      });
    });
  });

  it("fails closed on an unsigned artifact marker before a lifecycle operation", async () => {
    const root = await isolatedRoot("unsigned-artifact-lock-fail-closed");
    const sessionId = "stale-artifact-lock-session";
    const first = storeFor(root);
    const descriptor = await withServerLease(first, async () => {
      await first.persist(testSessionOpenedRecord(sessionId));
      return first.artifact({ sessionId });
    });
    assert.ok(descriptor);
    const markerPath = join(root, "keys", descriptor.archiveId + ".lifecycle.lock");
    const markerContents = JSON.stringify({
      schemaVersion: 3,
      kind: "session_artifact_lifecycle_lock",
      archiveId: descriptor.archiveId,
      host: hostname(),
      processId: process.pid,
      processStartIdentity: "crashed-process-instance",
      lockId: "b".repeat(64),
    }) + "\n";
    await writeFile(markerPath, markerContents);

    const restarted = storeFor(root);
    await withServerLease(restarted, async () => {
      await assert.rejects(
        restarted.artifact({ sessionId }),
        /Artifact lifecycle is locked by another process/u,
      );
    });
    assert.equal(await readFile(markerPath, "utf8"), markerContents);
  });

  it("rejects an oversized artifact marker before mutation and leaves it in place", async () => {
    const root = await isolatedRoot("oversized-artifact-lock-fail-closed");
    const now = (): number => 1_793_875_000_000;
    const sessionId = "oversized-artifact-lock-session";
    const { store: writer } = await activeOrphanForRetention(root, now, sessionId);
    const descriptor = await withServerLease(writer, () => writer.artifact({ sessionId }));
    assert.ok(descriptor);
    const markerPath = join(root, "keys", descriptor.archiveId + ".lifecycle.lock");
    const markerContents = Buffer.alloc(16 * 1024 + 1, 0x7f);
    await writeFile(markerPath, markerContents);

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
      await assert.rejects(
        restarted.artifact({ sessionId }),
        /Lifecycle lock marker exceeds its maximum size/u,
      );
    });
    const persisted = await readFile(markerPath);
    assert.equal(persisted.byteLength, markerContents.byteLength);
    assert.deepEqual(persisted, markerContents);
  });

  it("rejects an oversized key sidecar before JSON parsing", async () => {
    const root = await isolatedRoot("oversized-key-sidecar-rejected");
    const now = (): number => 1_794_000_000_000;
    const { store: writer, sessionId } = await activeOrphanForRetention(
      root,
      now,
      "oversized-key-sidecar-session",
    );
    const descriptor = await withServerLease(writer, () => writer.artifact({ sessionId }));
    assert.ok(descriptor);
    const sidecarPath = join(root, "keys", descriptor.archiveId + ".key.json");
    const sidecarContents = "x".repeat(1 * 1024 * 1024 + 1);
    await writeFile(sidecarPath, sidecarContents);

    const verifier = storeFor(root, now);
    await withServerLease(verifier, async () => {
      await assert.rejects(
        verifier.artifact({ sessionId }),
        /Session key sidecar exceeds its maximum size/u,
      );
    });
    assert.equal((await readFile(sidecarPath, "utf8")).length, sidecarContents.length);
  });

  it("rejects an oversized deletion receipt before JSON parsing", async () => {
    const root = await isolatedRoot("oversized-deletion-receipt-rejected");
    const now = (): number => 1_794_125_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const descriptor = await withServerLease(store, async () => {
      const descriptor = await store.artifact({ sessionId });
      assert.ok(descriptor);
      const deletion = await store.deleteEvidence({
        sessionId,
        commandId: "oversized-receipt-fixture-delete",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "create receipt fixture",
        requestedAtMs: now(),
      });
      assert.equal(deletion.status, "completed");
      return descriptor;
    });
    const receiptPath = join(root, "receipts", descriptor.archiveId + ".delete.json");
    const receiptContents = "x".repeat(64 * 1024 + 1);
    await writeFile(receiptPath, receiptContents);

    const verifier = storeFor(root, now);
    await withServerLease(verifier, async () => {
      await assert.rejects(
        verifier.getRetention(sessionId),
        /Deletion receipt exceeds its maximum size/u,
      );
    });
    assert.equal((await readFile(receiptPath, "utf8")).length, receiptContents.length);
  });

  it("uses the fixed public four-track digest vector", () => {
    const records = [{
      type: "audio",
      sessionId: "fixed",
      track: "source_a",
      timelineAtMonoMs: 0,
      frame: { pcm16le: Uint8Array.from([1, 2]) },
    }] as unknown as readonly EvidenceRecord[];

    assert.deepEqual(computeEvidenceTrackDigests(records), {
      source_a: {
        recordCount: 1,
        sha256: "a9cb79e0dc50d935a79333ebf36cda7e9754f112833c35e26a82a9f1d1ac1c91",
      },
      source_b: {
        recordCount: 0,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
      playout_to_a: {
        recordCount: 0,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
      playout_to_b: {
        recordCount: 0,
        sha256: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    });
  });

  it("never deletes an active artifact through the owner early-delete seam", async () => {
    const store = storeFor(await isolatedRoot("active-delete-rejected"));
    const sessionId = "active-session";
    await withServerLease(store, async () => {
    await store.persist(testSessionOpenedRecord(sessionId));
    await store.flush(sessionId);

    assert.deepEqual(await store.deleteEvidence({
      sessionId,
      commandId: "owner-delete-active",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "operator request",
      requestedAtMs: 1_000,
    }), { status: "rejected" });
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "active",
      extensionUsed: false,
    });
    assert.equal((await store.artifact({ sessionId }))?.status, "active");
    });
  });

  it("rejects every affected persist when durable initialization cannot commit", async () => {
    const root = await isolatedRoot("persist-durable-failure");
    const store = storeFor(root);
    const lease = await store.acquireEvidenceRootLease("server");
    try {
      // The root was valid when the lease was acquired. Replacing it before
      // the queued initialization forces its first durable path to fail.
      await rm(join(root, "archive"), { recursive: true, force: true });
      await writeFile(join(root, "archive"), "not-a-directory");
      const first = store.persist(testSessionOpenedRecord("persist-failure-session"));
      const second = store.persist(testSessionOpenedRecord("persist-failure-session"));

      await assert.rejects(first, /EEXIST|Artifact security root/u);
      await assert.rejects(second, /EEXIST|Artifact security root/u);
    } finally {
      await lease.release();
    }
  });

  it("rejects persistence when the evidence directory sync fails", async () => {
    const root = await isolatedRoot("directory-sync-failure");
    const store = storeFor(root);
    const lease = await store.acquireEvidenceRootLease("server");
    try {
      await withInjectedDirectorySyncFailure(root, async () => {
        await assert.rejects(
          store.persist(testSessionOpenedRecord("directory-sync-failure-session")),
          /injected directory sync failure/u,
        );
      });
    } finally {
      await lease.release();
    }
  });

  it("allows an owner to safely erase a failed finalization without pretending it sealed", async () => {
    const root = await isolatedRoot("failed-finalization-delete");
    const now = (): number => 1_755_000_000_000;
    const { store, sessionId } = await failedFinalizationStoreForRetention(root, now);
    await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);
    assert.equal(descriptor.status, "FINALIZATION_FAILED");

    const deletion = await store.deleteEvidence({
      sessionId,
      commandId: "delete-failed-finalization",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "discard failed finalization",
      requestedAtMs: now(),
    });
    assert.equal(deletion.status, "completed");
    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.finalizationStatus, "FINALIZATION_FAILED");
    assert.equal(typeof receipt.finalizationFailureCode, "string");
    assert.equal("finalSealSha256" in receipt, false);
    assert.equal("finalizationManifestSha256" in receipt, false);
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("sweeps a failed finalization at its retention deadline with deletion audit metadata", async () => {
    const root = await isolatedRoot("failed-finalization-retention-sweep");
    let nowMs = 1_794_500_000_000;
    const { store, sessionId } = await failedFinalizationStoreForRetention(root, () => nowMs);
    await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);
    const beforeExpiry = await store.getRetention(sessionId);
    assert.deepEqual(beforeExpiry, {
      status: "FINALIZATION_FAILED",
      retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
      extensionUsed: false,
    });

    nowMs += 14 * 24 * 60 * 60 * 1_000;
    assert.deepEqual(await store.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 1,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.finalizationStatus, "FINALIZATION_FAILED");
    assert.equal(typeof receipt.finalizationFailureCode, "string");
    assert.equal(typeof receipt.processingManifestSha256, "string");
    assert.equal(typeof receipt.retentionDeadlineAtMs, "number");
    });
  });

  it("keeps a retention-governed deletion audit when a post-preflight ledger becomes corrupt", async () => {
    const root = await isolatedRoot("post-preflight-corrupt-finalization");
    const nowMs = 1_794_750_000_000;
    const now = (): number => nowMs;
    const store = storeFor(root, now);
    const sessionId = "corrupt-after-preflight-session";
    const processingManifest = testProcessingManifest();
    const descriptor = await withServerLease(store, async () => {
    await store.persist({
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
      },
    } as unknown as EvidenceRecord);
    const preflight = await store.preflightRecorder({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected recorder preflight");
    await store.persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 2, preflight });
    for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
      await store.persist({
        type: "session_event",
        sessionId,
        event: {
          type: "participant_consent",
          cursor,
          sessionId,
          timestampMonoMs: cursor,
          lane: null,
          generation: null,
          side,
          consentId: "corrupt-consent-" + side,
          consentPolicyRef: processingManifest.consentPolicyRef,
          recording: true,
          processing: true,
          acceptedAtMonoMs: cursor,
        },
      } as unknown as EvidenceRecord);
    }
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);
    await writeFile(join(root, "archive", descriptor.archiveId + ".spool.enc"), "{not-json}\n");

    const failure = await store.finalize({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      finalizedAtMonoMs: 20,
      reason: "corrupt ledger finalization",
      lastPersistedEventCursor: 3,
    });
    assert.equal(failure.status, "FINALIZATION_FAILED");
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "FINALIZATION_FAILED",
      retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
      extensionUsed: false,
    });
    return descriptor;
    });

    const recoveredStore = storeFor(root, now);
    await withServerLease(recoveredStore, async () => {
    const corruptRecovery = await recoveredStore.recover();
    assert.equal(corruptRecovery.status, "completed");
    assert.equal(corruptRecovery.finalizationFailures, 0);
    assert.equal((await recoveredStore.deleteEvidence({
      sessionId,
      commandId: "delete-corrupt-post-preflight",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "remove corrupt terminal ledger",
      requestedAtMs: nowMs,
    })).status, "completed");
    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.finalizationStatus, "FINALIZATION_FAILED");
    assert.equal(typeof receipt.processingManifestSha256, "string");
    });
  });

  it("retries a durable pending deletion in-process and keeps sweep health degraded until cleanup completes", async () => {
    const root = await isolatedRoot("pending-deletion-in-process-retry");
    const nowMs = 1_795_000_000_000;
    const now = (): number => nowMs;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const deletionRequest = {
      sessionId,
      commandId: "retry-pending-owner-delete",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "transient managed archive cleanup failure",
      requestedAtMs: now(),
    };
    await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);

    // Establish a fresh successful sweep first. A later pending receipt must
    // override this timestamp-based health signal until it is truly cleaned up.
    assert.equal((await store.sweepExpired()).health, "healthy");

    // A directory where only a registered atomic temporary file may exist is
    // an intentionally transient, safe removal failure. It is ignored while
    // the pending receipt is created, then blocks only the final cleanup step.
    const blockedTemporary = join(
      root,
      "archive",
      descriptor.archiveId + ".evidence.jsonl.enc." + "a".repeat(24) + ".tmp",
    );
    await mkdir(blockedTemporary);
    await assert.rejects(store.deleteEvidence(deletionRequest), /temporary is not a regular file/u);

    // The pending receipt binds the semantic request before the audit append
    // and cleanup. Reusing its command ID with a changed reason must remain a
    // conflict both before and after restart, never a fresh deletion.
    assert.deepEqual(await store.deleteEvidence({
      ...deletionRequest,
      reason: "changed deletion reason",
    }), { status: "conflict" });

    assert.deepEqual(await store.getRetention(sessionId), {
      status: "deletion_pending",
      retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
      extensionUsed: false,
    });
    assert.deepEqual(await store.extendRetention({
      sessionId,
      commandId: "extend-pending-delete",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "must not revive a deletion",
      requestedAtMs: now(),
      requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
    }), { status: "not_found" });
    assert.equal(store.getRetentionSweepHealth().health, "degraded");

    await rm(blockedTemporary, { recursive: true, force: true });
    assert.deepEqual(await store.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 0,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });

    });

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
      assert.deepEqual(await restarted.deleteEvidence({
        ...deletionRequest,
        reason: "changed deletion reason after restart",
      }), { status: "conflict" });
    });
  });

  it("retains a content-free extension audit in the deletion receipt and recovers it", async () => {
    const root = await isolatedRoot("extension-delete-recovery");
    let nowMs = 1_760_000_000_000;
    const now = (): number => nowMs;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const dayMs = 24 * 60 * 60 * 1_000;
    const originalDeadlineAtMs = nowMs + 14 * dayMs;
    const deletion = await withServerLease(store, async () => {
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "sealed",
      retentionDeadlineAtMs: originalDeadlineAtMs,
      extensionUsed: false,
    });

    assert.deepEqual(await store.extendRetention({
      sessionId,
      commandId: "extension-too-long",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "customer needs extra review time",
      requestedAtMs: nowMs + 1,
      requestedDeadlineAtMs: nowMs + 31 * dayMs,
    }), { status: "rejected" });

    const extendedDeadlineAtMs = nowMs + 20 * dayMs;
    assert.deepEqual(await store.extendRetention({
      sessionId,
      commandId: "extension-approved",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "customer needs extra review time",
      requestedAtMs: nowMs + 2,
      requestedDeadlineAtMs: extendedDeadlineAtMs,
    }), {
      status: "extended",
      retentionDeadlineAtMs: extendedDeadlineAtMs,
      extensionUsed: true,
    });
    assert.deepEqual(await store.extendRetention({
      sessionId,
      commandId: "extension-second-attempt",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "another request",
      requestedAtMs: nowMs + 3,
      requestedDeadlineAtMs: nowMs + 21 * dayMs,
    }), { status: "rejected" });

    const sealedDescriptor = await store.artifact({ sessionId });
    assert.ok(sealedDescriptor);
    const deletion = await store.deleteEvidence({
      sessionId,
      commandId: "owner-delete-after-extension",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "customer requested deletion",
      requestedAtMs: nowMs + 4,
    });
    assert.equal(deletion.status, "completed");
    if (deletion.status !== "completed") throw new Error("Expected deletion receipt");

    const receiptText = await readFile(
      join(root, "receipts", sealedDescriptor.archiveId + ".delete.json"),
      "utf8",
    );
    assert.equal(receiptText.includes(sessionId), false);
    assert.equal(receiptText.includes(TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId), false);
    assert.equal(receiptText.includes("customer requested deletion"), false);
    const receipt = JSON.parse(receiptText) as Record<string, unknown>;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.disposition, "early");
    assert.equal(receipt.extensionUsed, true);
    assert.equal(receipt.completedWithinVerificationMaximumHours, true);
    assert.equal(typeof receipt.extensionApproval, "object");
    assert.equal(typeof receipt.finalizationManifestSha256, "string");
    assert.equal(typeof receipt.encryptedLedgerSha256, "string");
    return deletion;
    });

    const recoveredStore = storeFor(root, now);
    await withServerLease(recoveredStore, async () => {
    assert.equal((await recoveredStore.recover()).status, "completed");
    assert.deepEqual(await recoveredStore.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    assert.deepEqual(await recoveredStore.deleteEvidence({
      sessionId,
      commandId: "owner-delete-after-extension",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "customer requested deletion",
      requestedAtMs: nowMs + 5,
    }), deletion);
    });
  });

  it("sweeps an expired sealed artifact on its scheduled retention deadline", async () => {
    const root = await isolatedRoot("scheduled-sweep");
    let nowMs = 1_770_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    await withServerLease(store, async () => {
    const sealedDescriptor = await store.artifact({ sessionId });
    assert.ok(sealedDescriptor);

    nowMs += 14 * 24 * 60 * 60 * 1_000;
    assert.deepEqual(await store.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 1,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await store.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    assert.equal(await store.artifact({ sessionId }), undefined);

    const receipt = JSON.parse(await readFile(
      join(root, "receipts", sealedDescriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.disposition, "scheduled");
    assert.equal(receipt.completedWithinVerificationMaximumHours, true);
    });
  });

  it("tombstones a completed deletion across recovery and rejects every new lifecycle write", async () => {
    const root = await isolatedRoot("deleted-session-tombstone");
    const now = (): number => 1_780_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const descriptor = await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);
    assert.equal((await store.deleteEvidence({
      sessionId,
      commandId: "delete-terminal-session",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "terminal deletion",
      requestedAtMs: now(),
    })).status, "completed");
    return descriptor;
    });

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    const manifest = testProcessingManifest();
    await assert.rejects(
      restarted.persist(testSessionOpenedRecord(sessionId)),
      /Deleted session evidence cannot be persisted/u,
    );
    assert.equal((await restarted.preflightRecorder({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      checkedAtMonoMs: 1,
    })).status, "failed");
    assert.equal((await restarted.finalize({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      finalizedAtMonoMs: 2,
      reason: "late retry",
      lastPersistedEventCursor: 0,
    })).status, "FINALIZATION_FAILED");
    assert.equal(await restarted.artifact({ sessionId }), undefined);
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    await assert.rejects(
      readFile(join(root, "keys", descriptor.archiveId + ".key.json"), "utf8"),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(join(root, "archive", descriptor.archiveId + ".spool.enc"), "utf8"),
      /ENOENT/u,
    );
    await assert.rejects(
      readFile(join(root, "archive", descriptor.archiveId + ".evidence.jsonl.enc"), "utf8"),
      /ENOENT/u,
    );
    });
  });

  it("quarantines a retained active sidecar under its required root lease and admits an audited failed-finalization terminal", async () => {
    const activeRoot = await isolatedRoot("recovery-active-degraded");
    const activeStore = storeFor(activeRoot);
    const activeSessionId = "orphaned-active-session";
    await withServerLease(activeStore, async () => {
    await activeStore.persist(testSessionOpenedRecord(activeSessionId));
    await activeStore.flush(activeSessionId);
    });

    const activeRecoveryStore = storeFor(activeRoot);
    const activeRecovery = await withServerLease(activeRecoveryStore, () => activeRecoveryStore.recover());
    assert.equal(activeRecovery.status, "completed");
    assert.equal(activeRecovery.orphanedActiveArtifacts, 0);
    assert.equal(activeRecovery.finalizationFailures, 0);

    const failedRoot = await isolatedRoot("recovery-failed-finalization-degraded");
    await failedFinalizationStoreForRetention(failedRoot, () => 1_791_000_000_000);
    const failedRecoveryStore = storeFor(failedRoot, () => 1_791_000_000_000);
    const failedRecovery = await withServerLease(failedRecoveryStore, () => failedRecoveryStore.recover());
    assert.equal(failedRecovery.status, "completed");
    assert.equal(failedRecovery.finalizationFailures, 0);
  });

  it("removes a base probe residue while recovering an active sidecar", async () => {
    const root = await isolatedRoot("recovery-removes-base-probe-residue");
    const now = (): number => 1_791_250_000_000;
    const sessionId = "recovery-base-probe-residue-session";
    const { store: writer } = await activeOrphanForRetention(root, now, sessionId);
    const descriptor = await withServerLease(writer, () => writer.artifact({ sessionId }));
    assert.ok(descriptor);
    const probePath = join(root, "archive", descriptor.archiveId + ".probe.enc");
    await writeFile(probePath, "crash-probe-residue\n");

    const recovered = storeFor(root, now);
    await withServerLease(recovered, async () => {
      assert.equal((await recovered.recover()).status, "completed");
    });
    await assert.rejects(readFile(probePath), /ENOENT/u);
  });

  it("removes a base probe residue during owner deletion cleanup", async () => {
    const root = await isolatedRoot("deletion-removes-base-probe-residue");
    const now = (): number => 1_791_375_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const probePath = join(root, "archive", descriptor.archiveId + ".probe.enc");
    await writeFile(probePath, "late-probe-residue\n");

    await withServerLease(store, async () => {
      const deletion = await store.deleteEvidence({
        sessionId,
        commandId: "delete-base-probe-residue",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "remove probe residue",
        requestedAtMs: now(),
      });
      assert.equal(deletion.status, "completed");
    });
    await assert.rejects(readFile(probePath), /ENOENT/u);
  });

  it("quarantines a crash-orphaned active ledger under an exclusive root lease for audited deletion", async () => {
    const root = await isolatedRoot("recovery-orphan-remediation");
    const nowMs = 1_791_500_000_000;
    const now = (): number => nowMs;
    const sessionId = "orphan-remediation-session";
    const processingManifest = testProcessingManifest();
    const writer = storeFor(root, now);
    await withServerLease(writer, async () => {
    await writer.persist({
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
      },
    } as unknown as EvidenceRecord);
    await writer.flush(sessionId);
    });

    const recovered = storeFor(root, now);
    const rootLease = await recovered.acquireEvidenceRootLease("server");
    try {
      const recovery = await recovered.recover();
      assert.equal(recovery.status, "completed");
      assert.equal(recovery.orphanedActiveArtifacts, 0);
      assert.deepEqual(await recovered.getRetention(sessionId), {
        status: "FINALIZATION_FAILED",
        retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
        extensionUsed: false,
      });
      const descriptor = await recovered.artifact({ sessionId });
      assert.ok(descriptor);
      assert.equal(descriptor.status, "FINALIZATION_FAILED");
      const deletion = await recovered.deleteEvidence({
        sessionId,
        commandId: "delete-remediated-orphan",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "remove crash-orphaned recording",
        requestedAtMs: nowMs,
      });
      assert.equal(deletion.status, "completed");
      assert.deepEqual(await recovered.sweepExpired(), {
        status: "completed",
        expiredArtifactsDeleted: 0,
        health: "healthy",
        lastSuccessfulSweepAtMs: nowMs,
      });
      const receipt = JSON.parse(await readFile(
        join(root, "receipts", descriptor.archiveId + ".delete.json"),
        "utf8",
      )) as Record<string, unknown>;
      assert.equal(receipt.finalizationStatus, "FINALIZATION_FAILED");
      assert.equal(typeof receipt.processingManifestSha256, "string");
    } finally {
      await rootLease.release();
    }
  });

  it("admits an audited orphan quarantine after a second restart so its owner can delete it", async () => {
    const root = await isolatedRoot("recovery-orphan-second-restart-owner-delete");
    const nowMs = 1_791_750_000_000;
    const now = (): number => nowMs;
    const { sessionId } = await activeOrphanForRetention(root, now, "orphan-second-restart-session");

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
    } finally {
      await rootLease.release();
    }

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    const secondRecovery = await restarted.recover();
    assert.equal(secondRecovery.status, "completed");
    assert.equal(secondRecovery.finalizationFailures, 0);
    assert.equal(secondRecovery.orphanedActiveArtifacts, 0);
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "FINALIZATION_FAILED",
      retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
      extensionUsed: false,
    });
    assert.equal((await restarted.deleteEvidence({
      sessionId,
      commandId: "delete-second-restart-orphan",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "remove audited orphan quarantine",
      requestedAtMs: nowMs,
    })).status, "completed");
    });
  });

  it("sweeps an audited orphan quarantine at its retention deadline after a second restart", async () => {
    const root = await isolatedRoot("recovery-orphan-second-restart-expiry");
    let nowMs = 1_792_000_000_000;
    const now = (): number => nowMs;
    const { sessionId } = await activeOrphanForRetention(root, now, "orphan-second-restart-expiry");

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
    } finally {
      await rootLease.release();
    }

    nowMs += 14 * 24 * 60 * 60 * 1_000;
    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.deepEqual(await restarted.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 1,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("quarantines a sidecar-only crash into an immediately governed terminal that survives restart", async () => {
    const root = await isolatedRoot("recovery-sidecar-only-orphan");
    const nowMs = 1_792_250_000_000;
    const now = (): number => nowMs;
    const sessionId = "sidecar-only-orphan-session";
    const writer = storeFor(root, now);
    await withServerLease(writer, async () => {
    const preflight = await writer.preflightRecorder({
      sessionId,
      processingManifestSha256: "a".repeat(64),
      checkedAtMonoMs: 1,
    });
    assert.equal(preflight.status, "failed");
    });

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
      assert.deepEqual(await quarantiningStore.getRetention(sessionId), {
        status: "FINALIZATION_FAILED",
        retentionDeadlineAtMs: nowMs,
        extensionUsed: false,
      });
    } finally {
      await rootLease.release();
    }

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.deepEqual(await restarted.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 1,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("allows owner deletion of a sidecar-only orphan after its fresh recovery", async () => {
    const root = await isolatedRoot("recovery-sidecar-only-owner-delete");
    const nowMs = 1_792_375_000_000;
    const now = (): number => nowMs;
    const sessionId = "sidecar-only-owner-delete-session";
    const writer = storeFor(root, now);
    await withServerLease(writer, async () => {
    assert.equal((await writer.preflightRecorder({
      sessionId,
      processingManifestSha256: "b".repeat(64),
      checkedAtMonoMs: 1,
    })).status, "failed");
    });

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
    } finally {
      await rootLease.release();
    }

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.deepEqual(await restarted.deleteEvidence({
      sessionId,
      commandId: "delete-sidecar-only-orphan-wrong-owner",
      authority: { kind: "retention_owner", actorId: "wrong-sidecar-orphan-owner" },
      reason: "must not delete another owner's sidecar-only orphan",
      requestedAtMs: nowMs,
    }), { status: "not_found" });
    assert.equal((await restarted.deleteEvidence({
      sessionId,
      commandId: "delete-sidecar-only-orphan",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "remove sidecar-only crash orphan",
      requestedAtMs: nowMs,
    })).status, "completed");
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("derives an expiry policy from authenticated sidecar metadata when an orphan spool is corrupt", async () => {
    const root = await isolatedRoot("recovery-corrupt-orphan-sidecar-policy");
    let nowMs = 1_792_500_000_000;
    const now = (): number => nowMs;
    const { store: writer, sessionId, processingManifest } = await activeOrphanForRetention(
      root,
      now,
      "corrupt-orphan-sidecar-policy-session",
    );
    await withServerLease(writer, async () => {
    const preflight = await writer.preflightRecorder({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected recorder preflight");
    await writer.persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 2, preflight });
    await writer.flush(sessionId);
    const descriptor = await writer.artifact({ sessionId });
    assert.ok(descriptor);
    await writeFile(descriptor.archivePath, "{torn-spool}\n");
    });

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
      assert.deepEqual(await quarantiningStore.getRetention(sessionId), {
        status: "FINALIZATION_FAILED",
        retentionDeadlineAtMs: nowMs + 14 * 24 * 60 * 60 * 1_000,
        extensionUsed: false,
      });
    } finally {
      await rootLease.release();
    }

    nowMs += 14 * 24 * 60 * 60 * 1_000;
    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.deepEqual(await restarted.sweepExpired(), {
      status: "completed",
      expiredArtifactsDeleted: 1,
      health: "healthy",
      lastSuccessfulSweepAtMs: nowMs,
    });
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("allows owner deletion of a corrupt orphan spool after fresh recovery", async () => {
    const root = await isolatedRoot("recovery-corrupt-orphan-owner-delete");
    const nowMs = 1_792_625_000_000;
    const now = (): number => nowMs;
    const { store: writer, sessionId } = await activeOrphanForRetention(
      root,
      now,
      "corrupt-orphan-owner-delete-session",
    );
    const descriptor = await withServerLease(writer, () => writer.artifact({ sessionId }));
    assert.ok(descriptor);
    await writeFile(descriptor.archivePath, "{torn-spool}\n");

    const quarantiningStore = storeFor(root, now);
    const rootLease = await quarantiningStore.acquireEvidenceRootLease("server");
    try {
      assert.equal((await quarantiningStore.recover()).status, "completed");
    } finally {
      await rootLease.release();
    }

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.equal((await restarted.deleteEvidence({
      sessionId,
      commandId: "delete-corrupt-orphan",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "remove corrupt crash orphan",
      requestedAtMs: nowMs,
    })).status, "completed");
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("refuses plaintext export at the deadline before the hourly sweep", async () => {
    const root = await isolatedRoot("expired-export-before-sweep");
    let nowMs = 1_792_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    nowMs += 14 * 24 * 60 * 60 * 1_000;
    let callbackRan = false;

    const result = await withServerLease(store, () => store.withManagedExportLease({
      lookup: { sessionId },
      commandId: "expired-export-command",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      requestedAtMs: nowMs,
    }, async () => {
      callbackRan = true;
      return {
        value: { shouldNotRun: true },
        manifestFileSha256: "0".repeat(64),
        completedAtMs: nowMs,
      };
    }));

    assert.deepEqual(result, { status: "expired" });
    assert.equal(callbackRan, false);
  });

  it("streams a sealed export lease only after complete verification and supports replay without a records array", async () => {
    const root = await isolatedRoot("managed-export-streaming-lease");
    const nowMs = 1_792_500_000_000;
    const now = (): number => nowMs;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const result = await withServerLease(store, () => store.withManagedExportLease({
      lookup: { sessionId },
      commandId: "streaming-export-command",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      requestedAtMs: nowMs,
      }, async (lease) => {
        assert.equal("records" in lease.artifact, false);
        assert.deepEqual(lease.artifact.audioTimeline, {
        originTimelineAtMonoMs: 10,
        durationSampleFrames: CANONICAL_AUDIO.samplesPerFrame,
      });
      const firstReplay: EvidenceRecord[] = [];
      for await (const record of lease.records()) firstReplay.push(record);
      const secondReplay: EvidenceRecord[] = [];
      for await (const record of lease.records()) secondReplay.push(record);
      assert.equal(firstReplay.length, lease.artifact.finalization.recordCount);
        assert.deepEqual(
          firstReplay.map((record) => record.type),
          secondReplay.map((record) => record.type),
        );
        return {
          value: { replayedRecordCount: firstReplay.length },
          ...await writeValidManagedExportWorkspace(lease),
        };
      }));
    assert.equal(result.status, "completed");
    if (result.status === "completed") {
      assert.deepEqual(result.value, { replayedRecordCount: 5 });
    }
  });

  it("authenticates complete content-free deletion receipts and erases derived atomic temporaries", async () => {
    const root = await isolatedRoot("receipt-integrity-and-temporaries");
    const now = (): number => 1_793_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const descriptor = await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);
    const deletion = await store.deleteEvidence({
      sessionId,
      commandId: "delete-for-receipt-integrity",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "delete test fixture",
      requestedAtMs: now(),
    });
    assert.equal(deletion.status, "completed");
    return descriptor;
    });

    const temporaryPaths = [
      join(root, "keys", descriptor.archiveId + ".key.json." + "a".repeat(24) + ".tmp"),
      join(root, "archive", descriptor.archiveId + ".spool.enc." + "b".repeat(24) + ".tmp"),
      join(root, "archive", descriptor.archiveId + ".evidence.jsonl.enc." + "c".repeat(24) + ".tmp"),
      join(root, "receipts", descriptor.archiveId + ".delete.json." + "d".repeat(24) + ".tmp"),
    ];
    await Promise.all(temporaryPaths.map((path) => writeFile(path, "would-be-encrypted-material")));
    const recovered = storeFor(root, now);
    await withServerLease(recovered, async () => {
    assert.equal((await recovered.recover()).status, "completed");
    for (const temporaryPath of temporaryPaths) {
      await assert.rejects(readFile(temporaryPath), /ENOENT/u);
    }
    });

    const receiptPath = join(root, "receipts", descriptor.archiveId + ".delete.json");
    const tampered = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    // This remains structurally valid, so only the whole-receipt HMAC can
    // detect the content-free governance tamper.
    tampered.managedExportRegistered = !Boolean(tampered.managedExportRegistered);
    await writeFile(receiptPath, JSON.stringify(tampered) + "\n");
    const verifier = storeFor(root, now);
    await withServerLease(verifier, async () => {
    await assert.rejects(
      verifier.getRetention(sessionId),
      /Deletion receipt integrity is invalid/u,
    );
    });
  });

  it("removes managed root and artifact lock temporaries during recovery", async () => {
    const root = await isolatedRoot("recovery-lock-marker-temporaries");
    const now = (): number => 1_793_062_500_000;
    const sessionId = "recovery-lock-marker-temporaries-session";
    const { store: writer } = await activeOrphanForRetention(root, now, sessionId);
    const descriptor = await withServerLease(writer, () => writer.artifact({ sessionId }));
    assert.ok(descriptor);
    const temporaryPaths = [
      join(root, "keys", "evidence-root.lifecycle.lock." + "a".repeat(24) + ".tmp"),
      join(root, "keys", descriptor.archiveId + ".lifecycle.lock." + "b".repeat(24) + ".tmp"),
    ];
    await Promise.all(temporaryPaths.map((path) => writeFile(path, "crash lock marker temporary")));

    const recovered = storeFor(root, now);
    await withServerLease(recovered, async () => {
      assert.equal((await recovered.recover()).status, "completed");
    });
    for (const temporaryPath of temporaryPaths) {
      await assert.rejects(readFile(temporaryPath), /ENOENT/u);
    }
  });

  it("clamps a rollback completion clock so the completed deletion tombstone remains recoverable", async () => {
    const root = await isolatedRoot("deletion-clock-rollback");
    const normalNowMs = 1_793_125_000_000;
    let phase: "setup" | "deleting" | "after" = "setup";
    let deletionClockReads = 0;
    const now = (): number => {
      if (phase !== "deleting") return normalNowMs;
      deletionClockReads += 1;
      return deletionClockReads === 1 ? normalNowMs : normalNowMs - 1_000;
    };
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const request = {
      sessionId,
      commandId: "delete-with-rollback-clock",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "clock rollback retention test",
      requestedAtMs: normalNowMs,
    };
    const deletion = await withServerLease(store, async () => {
    const descriptor = await store.artifact({ sessionId });
    assert.ok(descriptor);

    phase = "deleting";
    const deletion = await store.deleteEvidence(request);
    assert.equal(deletion.status, "completed");
    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.startedAtMs, normalNowMs);
    assert.equal(receipt.deletedAtMs, normalNowMs);
    return deletion;
    });

    phase = "after";
    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.equal((await restarted.recover()).status, "completed");
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    assert.deepEqual(await restarted.deleteEvidence(request), deletion);
    });
  });

  it("rejects noncanonical AES-GCM Base64 before attempting ledger decryption", async () => {
    const root = await isolatedRoot("noncanonical-aead-fields");
    const now = (): number => 1_793_250_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const path = join(root, "archive", descriptor.archiveId + ".evidence.jsonl.enc");
    const lines = (await readFile(path, "utf8")).split("\n");
    const second = JSON.parse(lines[1]!) as Record<string, unknown>;
    second.iv = "AQ=";
    lines[1] = JSON.stringify(second);
    await writeFile(path, lines.join("\n"));

    const verifier = storeFor(root, now);
    await withServerLease(verifier, async () => {
    let callbackInvoked = false;
    assert.deepEqual(await verifier.withVerifiedSealedReviewLease({
      kind: "metadata_page",
      sessionId,
      actor: {
        role: "retention_owner",
        actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
      },
      pageSize: 1,
    }, async () => {
      callbackInvoked = true;
      return { value: null, responseSha256: "a".repeat(64) };
    }), { status: "integrity_failed" });
    assert.equal(callbackInvoked, false);
    });
  });

  it("requires an exact 12-byte AES-GCM IV and 16-byte authentication tag", async () => {
    const now = (): number => 1_793_260_000_000;
    for (const candidate of [
      {
        label: "iv",
        field: "iv" as const,
        value: Buffer.alloc(11, 1).toString("base64"),
      },
      {
        label: "tag",
        field: "tag" as const,
        value: Buffer.alloc(15, 2).toString("base64"),
      },
    ]) {
      const root = await isolatedRoot("short-aead-" + candidate.label);
      const { store, sessionId } = await sealedStoreForRetention(root, now);
      const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
      assert.ok(descriptor);
      const path = join(root, "archive", descriptor.archiveId + ".evidence.jsonl.enc");
      const lines = (await readFile(path, "utf8")).split("\n");
      const second = JSON.parse(lines[1]!) as Record<string, unknown>;
      second[candidate.field] = candidate.value;
      lines[1] = JSON.stringify(second);
      await writeFile(path, lines.join("\n"));

      const verifier = storeFor(root, now);
      await withServerLease(verifier, async () => {
      let callbackInvoked = false;
      assert.deepEqual(await verifier.withVerifiedSealedReviewLease({
        kind: "metadata_page",
        sessionId,
        actor: {
          role: "retention_owner",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
        pageSize: 1,
      }, async () => {
        callbackInvoked = true;
        return { value: null, responseSha256: "a".repeat(64) };
      }), { status: "integrity_failed" });
      assert.equal(callbackInvoked, false);
      });
    }
  });

  it("continues an active ledger after restart before preflight without reusing its record index or chain", async () => {
    const root = await isolatedRoot("restart-active-ledger-persist");
    const now = (): number => 1_793_500_000_000;
    const sessionId = "restart-active-ledger-session";
    const processingManifest = testProcessingManifest();
    const firstStore = storeFor(root, now);
    await withServerLease(firstStore, async () => {
    await firstStore.persist({
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: { spec: { processingManifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
      },
    } as unknown as EvidenceRecord);
    });

    // No flush or preflight occurs before the process boundary. The next
    // persisted record must initialize from the encrypted ledger first.
    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    await restarted.persist({
      type: "session_event",
      sessionId,
      event: {
        type: "participant_joined",
        cursor: 2,
        sessionId,
        timestampMonoMs: 2,
        lane: null,
        generation: null,
        side: "A",
      },
    } as unknown as EvidenceRecord);
    const preflight = await restarted.preflightRecorder({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      checkedAtMonoMs: 3,
    });
    assert.equal(preflight.status, "ready", JSON.stringify(preflight));
    if (preflight.status !== "ready") throw new Error("Expected recorder preflight to succeed");
    await restarted.persist({ type: "recorder_preflight", sessionId, timestampMonoMs: 3, preflight });
    for (const [side, cursor] of [["A", 3], ["B", 4]] as const) {
      await restarted.persist({
        type: "session_event",
        sessionId,
        event: {
          type: "participant_consent",
          cursor,
          sessionId,
          timestampMonoMs: cursor,
          lane: null,
          generation: null,
          side,
          consentId: "restart-consent-" + side,
          consentPolicyRef: processingManifest.consentPolicyRef,
          recording: true,
          processing: true,
          acceptedAtMonoMs: cursor,
        },
      } as unknown as EvidenceRecord);
    }
    await restarted.persist({
      type: "audio",
      sessionId,
      track: "source_a",
      timelineAtMonoMs: 5,
      frame: createAudioFrame({
        sessionId,
        lane: "A_TO_B",
        generation: 0,
        sequence: 0,
        capturedAtMs: 5,
        pcm16le: new Uint8Array(CANONICAL_AUDIO.bytesPerFrame).fill(11),
      }),
    });

    const finalization = await restarted.finalize({
      sessionId,
      processingManifestSha256: processingManifest.manifestSha256,
      finalizedAtMonoMs: 6,
      reason: "restart_ledger_verification",
      lastPersistedEventCursor: 4,
    });
    assert.equal(finalization.status, "sealed", JSON.stringify(finalization));
    const verifiedRecords: EvidenceRecord[] = [];
    const reviewResult = await restarted.withVerifiedSealedReviewLease({
      kind: "metadata_page",
      sessionId,
      actor: {
        role: "retention_owner",
        actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
      },
      pageSize: 64,
    }, async (lease) => {
      for await (const record of lease.records()) verifiedRecords.push(record);
      return {
        value: null,
        responseSha256: createHash("sha256").update("restart-cursor-review").digest("hex"),
      };
    });
    assert.equal(reviewResult.status, "completed");
    assert.deepEqual(
      verifiedRecords
        .filter((record) => record.type === "session_event")
        .map((record) => (record as { readonly event: { readonly cursor: number } }).event.cursor),
      [1, 2, 3, 4],
    );
    });
  });

  it("reopens acknowledged evidence durably and serializes finalization before delete and sweep", async () => {
    const root = await isolatedRoot("durable-record-finalize-delete");
    const now = (): number => 1_794_000_000_000;
    const sessionId = "durable-finalize-session";
    const manifest = testProcessingManifest();
    const initial = storeFor(root, now);
    await withServerLease(initial, async () => {
    await initial.persist({
      type: "session_event",
      sessionId,
      event: {
        type: "session_opened",
        cursor: 1,
        sessionId,
        timestampMonoMs: 1,
        lane: null,
        generation: null,
        snapshot: { spec: { processingManifest: manifest, evidenceReviewGrant: TEST_EVIDENCE_REVIEW_GRANT } },
      },
    } as unknown as EvidenceRecord);
    });
    // `persist` itself is the public durable acknowledgement: a fresh Store
    // must reopen the record before any later recorder operation proceeds.

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    const preflight = await restarted.preflightRecorder({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      checkedAtMonoMs: 2,
    });
    assert.equal(preflight.status, "ready");
    if (preflight.status !== "ready") throw new Error("Expected durable preflight");
    await restarted.persist({
      type: "recorder_preflight",
      sessionId,
      timestampMonoMs: 2,
      preflight,
    });
    for (const [side, cursor] of [["A", 2], ["B", 3]] as const) {
      await restarted.persist({
        type: "session_event",
        sessionId,
        event: {
          type: "participant_consent",
          cursor,
          sessionId,
          timestampMonoMs: cursor,
          lane: null,
          generation: null,
          side,
          consentId: "durable-consent-" + side,
          consentPolicyRef: manifest.consentPolicyRef,
          recording: true,
          processing: true,
          acceptedAtMonoMs: cursor,
        },
      } as unknown as EvidenceRecord);
    }
    await restarted.flush(sessionId);

    // Both commands are intentionally started without awaiting the first.
    // The deletion can complete only after finalization releases the single
    // per-artifact lifecycle lock.
    const finalizationPromise = restarted.finalize({
      sessionId,
      processingManifestSha256: manifest.manifestSha256,
      finalizedAtMonoMs: 20,
      reason: "operator_end",
      lastPersistedEventCursor: 3,
    });
    const deletionPromise = restarted.deleteEvidence({
      sessionId,
      commandId: "delete-after-serialized-finalization",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "delete after finalization",
      requestedAtMs: now(),
    });
    assert.equal((await finalizationPromise).status, "sealed");
    assert.equal((await deletionPromise).status, "completed");
    assert.equal((await restarted.sweepExpired()).status, "completed");
    assert.deepEqual(await restarted.getRetention(sessionId), {
      status: "deleted",
      extensionUsed: false,
    });
    });
  });

  it("uses the store clock, not caller time, to reject an expired extension request", async () => {
    const root = await isolatedRoot("extension-authoritative-clock");
    let nowMs = 1_790_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    nowMs += 14 * 24 * 60 * 60 * 1_000;

    await withServerLease(store, async () => {
    assert.deepEqual(await store.extendRetention({
      sessionId,
      commandId: "late-extension",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "stale client clock",
      requestedAtMs: 1_790_000_000_001,
      requestedDeadlineAtMs: nowMs + 2 * 24 * 60 * 60 * 1_000,
    }), { status: "rejected" });
    });
  });

  it("replays a successful extension command after more than 32 later command IDs and restart", async () => {
    const root = await isolatedRoot("retention-command-history");
    const nowMs = 1_795_500_000_000;
    const now = (): number => nowMs;
    const { store, sessionId } = await sealedStoreForRetention(root, now);
    const extension = {
      sessionId,
      commandId: "extension-command-that-must-remain-replayable",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "retain for investigation",
      requestedAtMs: nowMs,
      requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
    };
    const expected = {
      status: "extended" as const,
      retentionDeadlineAtMs: extension.requestedDeadlineAtMs,
      extensionUsed: true,
    };
    await withServerLease(store, async () => {
    assert.deepEqual(await store.extendRetention(extension), expected);
    for (let index = 0; index < 33; index += 1) {
      assert.deepEqual(await store.extendRetention({
        ...extension,
        commandId: "later-rejected-extension-" + index,
        reason: "later request " + index,
      }), { status: "rejected" });
    }
    });

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
    assert.deepEqual(await restarted.extendRetention(extension), expected);
    });
  });

  it("replays a sealed assigned review only after its content-free audit is durable", async () => {
    const root = await isolatedRoot("review-sealed-assignment-and-audit");
    const nowMs = 1_800_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const review = new EvidenceReview({ artifacts: store, cursorKey: Buffer.alloc(32, 11) });

    await withServerLease(store, async () => {
      const result = await review.review({
        kind: "metadata_page",
        sessionId,
        actor: { role: "retention_owner", actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
        pageSize: 10,
      });
      assert.equal(result.status, "completed");
      if (result.status !== "completed") throw new Error("Expected a completed sealed evidence review");
      assert.match(result.auditId, /^[a-f0-9]{64}$/u);
      assert.equal(result.summary.retentionDeadlineAtMs, nowMs + 14 * 24 * 60 * 60 * 1_000);

      const descriptor = await store.artifact({ sessionId });
      assert.ok(descriptor);
      const journal = await readFile(
        join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc"),
        "utf8",
      );
      assert.ok(journal.length > 0);
      assert.equal(journal.includes(sessionId), false);
      assert.equal(journal.includes(TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId), false);
      assert.equal(journal.includes(TEST_EVIDENCE_REVIEW_GRANT.bilingualReviewerId), false);
      assert.equal(JSON.stringify(result).includes("evidenceReviewGrant"), false);
    });
  });

  it("admits only the assigned reviewer before expiry and expires the review lease before disclosure", async () => {
    const root = await isolatedRoot("review-grant-denial-and-expiry");
    let nowMs = 1_810_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const review = new EvidenceReview({ artifacts: store, cursorKey: Buffer.alloc(32, 12) });

    await withServerLease(store, async () => {
      const assigned = await review.review({
        kind: "retention_summary",
        sessionId,
        actor: {
          role: "evidence_reviewer",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.bilingualReviewerId,
        },
      });
      assert.equal(assigned.status, "completed");
      if (assigned.status !== "completed") throw new Error("Expected the assigned reviewer to be admitted");
      assert.deepEqual(Object.keys(assigned).sort(), ["auditId", "kind", "status", "summary"]);
      assert.match(assigned.auditId, /^[a-f0-9]{64}$/u);
      assert.equal(assigned.kind, "retention_summary");
      assert.equal(JSON.stringify(assigned).includes("evidenceReviewGrant"), false);
      assert.equal(JSON.stringify(assigned).includes(TEST_EVIDENCE_REVIEW_GRANT.bilingualReviewerId), false);

      const owner = await review.review({
        kind: "retention_summary",
        sessionId,
        actor: {
          role: "retention_owner",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
      });
      assert.equal(owner.status, "completed");
      if (owner.status !== "completed") throw new Error("Expected the assigned owner to be admitted");
      assert.match(owner.auditId, /^[a-f0-9]{64}$/u);

      assert.deepEqual(await review.review({
        kind: "retention_summary",
        sessionId,
        actor: { role: "retention_owner", actorId: "wrong-retention-owner" },
      }), { status: "grant_denied" });

      assert.deepEqual(await review.review({
        kind: "metadata_page",
        sessionId,
        actor: { role: "evidence_reviewer", actorId: "wrong-bilingual-reviewer" },
        pageSize: 1,
      }), { status: "grant_denied" });

      nowMs += 14 * 24 * 60 * 60 * 1_000;
      assert.deepEqual(await review.review({
        kind: "metadata_page",
        sessionId,
        actor: { role: "evidence_reviewer", actorId: TEST_EVIDENCE_REVIEW_GRANT.bilingualReviewerId },
        pageSize: 1,
      }), { status: "expired" });
    });
  });

  it("rejects retention mutations from a swapped review authority", async () => {
    const root = await isolatedRoot("retention-authority-swap-gate");
    const nowMs = 1_812_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const swappedAuthority = Object.freeze({
      kind: "retention_owner" as const,
      actorId: TEST_EVIDENCE_REVIEW_GRANT.bilingualReviewerId,
    });

    await withServerLease(store, async () => {
      assert.deepEqual(await store.extendRetention({
        sessionId,
        commandId: "swapped-authority-extension",
        authority: swappedAuthority,
        reason: "swapped authority must be denied",
        requestedAtMs: nowMs,
        requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
      }), { status: "not_found" });
      assert.deepEqual(await store.deleteEvidence({
        sessionId,
        commandId: "swapped-authority-delete",
        authority: swappedAuthority,
        reason: "swapped authority must be denied",
        requestedAtMs: nowMs,
      }), { status: "not_found" });

      let callbackInvoked = false;
      assert.deepEqual(await store.withManagedExportLease({
        lookup: { sessionId },
        commandId: "swapped-authority-export",
        authority: swappedAuthority,
        requestedAtMs: nowMs,
      }, async () => {
        callbackInvoked = true;
        return {
          value: null,
          manifestFileSha256: "a".repeat(64),
          completedAtMs: nowMs,
        };
      }), { status: "not_found" });
      assert.equal(callbackInvoked, false);
    });
  });

  it("keeps review callbacks closed across unsealed, integrity-failed, and deleted lifecycle gates", async () => {
    const nowMs = 1_815_000_000_000;
    const unsealedRoot = await isolatedRoot("review-gate-unsealed");
    const unsealed = await activeOrphanForRetention(
      unsealedRoot,
      () => nowMs,
      "review-gate-unsealed-session",
    );

    const tamperedRoot = await isolatedRoot("review-gate-integrity-failed");
    const tampered = await sealedStoreForRetention(tamperedRoot, () => nowMs);
    const tamperedDescriptor = await withServerLease(
      tampered.store,
      () => tampered.store.artifact({ sessionId: tampered.sessionId }),
    );
    assert.ok(tamperedDescriptor);
    const encryptedLedger = await readFile(tamperedDescriptor.archivePath, "utf8");
    const encryptedLines = encryptedLedger.split(/\r?\n/u);
    const secondEncryptedLine = encryptedLines[1];
    assert.ok(secondEncryptedLine !== undefined && secondEncryptedLine.length > 0);
    encryptedLines[1] =
      (secondEncryptedLine[0] === "{" ? "[" : "{") + secondEncryptedLine.slice(1);
    await writeFile(
      tamperedDescriptor.archivePath,
      encryptedLines.join("\n"),
      "utf8",
    );

    const deletedRoot = await isolatedRoot("review-gate-deleted");
    const deleted = await sealedStoreForRetention(deletedRoot, () => nowMs);
    await withServerLease(deleted.store, async () => {
      assert.equal((await deleted.store.deleteEvidence({
        sessionId: deleted.sessionId,
        commandId: "review-gate-completed-deletion",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "review gate tombstone",
        requestedAtMs: nowMs,
      })).status, "completed");
    });

    const gates = [
      { name: "unsealed", fixture: unsealed, expectedStatus: "not_sealed" as const },
      { name: "tampered", fixture: tampered, expectedStatus: "integrity_failed" as const },
      { name: "deleted", fixture: deleted, expectedStatus: "not_found" as const },
    ] as const;
    const responseSha256 = createHash("sha256").update("review-gate-response").digest("hex");
    for (const gate of gates) {
      let callbackInvoked = false;
      await withServerLease(gate.fixture.store, async () => {
        assert.deepEqual(await gate.fixture.store.withVerifiedSealedReviewLease({
          kind: "retention_summary",
          sessionId: gate.fixture.sessionId,
          actor: {
            role: "retention_owner",
            actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
          },
        }, async () => {
          callbackInvoked = true;
          return { value: "must-not-disclose", responseSha256 };
        }), { status: gate.expectedStatus }, gate.name);
      });
      assert.equal(callbackInvoked, false, gate.name);
    }
  });

  it("serializes deletion behind a review lease and never returns its callback value", async () => {
    const root = await isolatedRoot("review-delete-lifecycle-serialization");
    const nowMs = 1_820_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const entered = Promise.withResolvers<void>();
    const continueReview = Promise.withResolvers<void>();
    const responseSha256 = createHash("sha256").update("review-response").digest("hex");

    await withServerLease(store, async () => {
      const review = store.withVerifiedSealedReviewLease({
        kind: "metadata_page",
        sessionId,
        actor: { role: "retention_owner", actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
        pageSize: 1,
      }, async () => {
        entered.resolve();
        await continueReview.promise;
        return { value: "must-not-escape-review-port", responseSha256 };
      });
      await entered.promise;

      let deletionSettled = false;
      const deletion = store.deleteEvidence({
        sessionId,
        commandId: "delete-serialized-behind-review",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "audit-plaintext-delete-sentinel",
        requestedAtMs: nowMs,
      }).then((result) => {
        deletionSettled = true;
        return result;
      });
      await Promise.resolve();
      assert.equal(deletionSettled, false);

      continueReview.resolve();
      const reviewResult = await review;
      assert.equal(reviewResult.status, "completed");
      assert.equal(JSON.stringify(reviewResult).includes("must-not-escape-review-port"), false);
      assert.equal((await deletion).status, "completed");
    });

    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.auditIntegrity, "valid");
    assert.equal(typeof receipt.auditCount, "number");
    assert.match(String(receipt.auditHeadSha256), /^[a-f0-9]{64}$/u);
    assert.ok(await readFile(join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc"), "utf8"));
  });

  it("fails closed when a cached audit journal is mutated live before a second disclosure", async () => {
    const root = await isolatedRoot("review-audit-live-history-tamper");
    const nowMs = 1_825_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const request = {
      kind: "retention_summary" as const,
      sessionId,
      actor: { role: "retention_owner" as const, actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
    };
    const responseSha256 = createHash("sha256").update("live-audit-history").digest("hex");
    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");

    await withServerLease(store, async () => {
      assert.equal((await store.withVerifiedSealedReviewLease(request, async () => ({
        value: "first",
        responseSha256,
      }))).status, "completed");
      const journal = await readFile(journalPath, "utf8");
      const tampered = journal.length === 0
        ? journal
        : (journal[0] === "{" ? "[" : "{") + journal.slice(1);
      await writeFile(journalPath, tampered);

      let callbackInvoked = false;
      assert.deepEqual(await store.withVerifiedSealedReviewLease(request, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256 };
      }), { status: "audit_failed" });
      assert.equal(callbackInvoked, false);
    });
  });

  it("fails closed when both detached audit journal and head disappear after a successful review", async () => {
    const root = await isolatedRoot("review-audit-journal-and-head-reset");
    const nowMs = 1_825_500_000_000;
    await mkdir(join(root, "archive"), { recursive: true });
    const { store, sessionId } = await withSuppressedFileSync(
      join(root, "archive"),
      () => sealedStoreForRetention(root, () => nowMs),
    );
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const request = {
      kind: "retention_summary" as const,
      sessionId,
      actor: { role: "retention_owner" as const, actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
    };
    const responseSha256 = createHash("sha256").update("audit-reset-response").digest("hex");
    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");
    const headPath = join(root, "receipts", descriptor.archiveId + ".audit.head.enc");

    await withServerLease(store, async () => {
      const firstReview = await store.withVerifiedSealedReviewLease(request, async () => ({
        value: "first-review",
        responseSha256,
      }));
      assert.equal(firstReview.status, "completed");
      if (firstReview.status === "completed") assert.equal(firstReview.responseSha256, responseSha256);

      await rm(journalPath, { force: true });
      await rm(headPath, { force: true });

      let callbackInvoked = false;
      assert.deepEqual(await store.withVerifiedSealedReviewLease(request, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256 };
      }), { status: "audit_failed" });
      assert.equal(callbackInvoked, false);

      assert.deepEqual(await store.extendRetention({
        sessionId,
        commandId: "audit-reset-extension",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "audit reset must fail closed",
        requestedAtMs: nowMs,
        requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
      }), { status: "rejected" });

      callbackInvoked = false;
      assert.deepEqual(await store.withManagedExportLease({
        lookup: { sessionId },
        commandId: "audit-reset-export",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        requestedAtMs: nowMs,
      }, async () => {
        callbackInvoked = true;
        return {
          value: null,
          manifestFileSha256: "a".repeat(64),
          completedAtMs: nowMs,
        };
      }), { status: "audit_failed" });
      assert.equal(callbackInvoked, false);
    });
  });

  it("bounds same-artifact lifecycle admission without blocking root-lease release", async () => {
    const root = await isolatedRoot("artifact-lifecycle-admission-cap");
    const nowMs = 1_825_750_000_000;
    await mkdir(join(root, "archive"), { recursive: true });
    const { store, sessionId } = await withSuppressedFileSync(
      join(root, "archive"),
      () => sealedStoreForRetention(root, () => nowMs),
    );

    await withSuppressedFileSync(join(root, "archive"), async () => {
      await withServerLease(store, async () => {
        const entered = Promise.withResolvers<void>();
        const continueHolder = Promise.withResolvers<void>();
        const responseSha256 = createHash("sha256").update("admission-holder").digest("hex");
        const holder = store.withVerifiedSealedReviewLease({
          kind: "retention_summary",
          sessionId,
          actor: { role: "retention_owner", actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
        }, async () => {
          entered.resolve();
          await continueHolder.promise;
          return { value: "holder", responseSha256 };
        });
        await entered.promise;

        // The active holder consumes one of the 64 admissions. Fill the
        // remaining slots with retention reads, then make the 65th operation
        // an export so queue overflow is deterministic and callback-free.
        const queuedRetention = Array.from({ length: 62 }, (_, index) =>
          store.getRetention(sessionId).then((value) => ({ kind: "retention" as const, value, index })));
        let queuedReviewCallbackInvoked = false;
        const queuedReview = store.withVerifiedSealedReviewLease({
          kind: "retention_summary",
          sessionId,
          actor: { role: "retention_owner", actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
        }, async () => {
          queuedReviewCallbackInvoked = true;
          return { value: "queued-review", responseSha256 };
        });
        let overflowExportCallbackInvoked = false;
        const overflowExport = store.withManagedExportLease({
          lookup: { sessionId },
          commandId: "admission-cap-overflow-export",
          authority: TEST_RETENTION_OWNER_AUTHORITY,
          requestedAtMs: nowMs,
        }, async () => {
          overflowExportCallbackInvoked = true;
          throw new Error("overflow export callback must not run");
        });

        // Overflow is rejected before waiting on the held lifecycle lock.
        const overflowResult = await overflowExport;
        assert.equal(overflowResult.status, "audit_failed");
        assert.equal(overflowExportCallbackInvoked, false);

        continueHolder.resolve();
        const [holderResult, reviewResult] = await Promise.all([holder, queuedReview]);
        assert.equal(holderResult.status, "completed");
        assert.equal(reviewResult.status, "completed");
        assert.equal(queuedReviewCallbackInvoked, true);
        const retentionResults = await Promise.all(queuedRetention);
        assert.equal(retentionResults.length, 62);
        assert.ok(retentionResults.every(({ value }) => value?.status === "sealed"));
      });
    });
  });

  it("bounds process-wide lifecycle admission across unique artifacts", async () => {
    const root = await isolatedRoot("global-artifact-lifecycle-admission-cap");
    const nowMs = 1_825_800_000_000;
    const store = storeFor(root, () => nowMs);

    await withServerLease(store, async () => {
      await withBlockedRegularFileSync(join(root, "archive"), async (waitForEntered, release) => {
        const held = Array.from({ length: 256 }, (_, index) => store.extendRetention({
          sessionId: "global-admission-unknown-session-" + index,
          commandId: "global-admission-command-" + index,
          authority: TEST_RETENTION_OWNER_AUTHORITY,
          reason: "global admission cap",
          requestedAtMs: nowMs,
          requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
        }));
        await waitForEntered(256);

        // The 257th unique artifact is rejected at admission before it can
        // create a lifecycle lock marker or inflate root active operations.
        assert.deepEqual(await store.extendRetention({
          sessionId: "global-admission-overflow-session",
          commandId: "global-admission-overflow-command",
          authority: TEST_RETENTION_OWNER_AUTHORITY,
          reason: "global admission overflow",
          requestedAtMs: nowMs,
          requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
        }), { status: "conflict" });

        release();
        const results = await Promise.all(held);
        assert.equal(results.length, 256);
        assert.ok(results.every((result) => result.status === "not_found"));
      });
    });
  });

  it("rejects an oversized audit journal line before a review callback can disclose", async () => {
    const root = await isolatedRoot("review-audit-oversized-line");
    const nowMs = 1_826_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const request = {
      kind: "retention_summary" as const,
      sessionId,
      actor: { role: "retention_owner" as const, actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
    };
    const responseSha256 = createHash("sha256").update("oversized-audit-line").digest("hex");
    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");

    await withServerLease(store, async () => {
      assert.equal((await store.withVerifiedSealedReviewLease(request, async () => ({
        value: "first",
        responseSha256,
      }))).status, "completed");
      await writeFile(journalPath, "x".repeat(64 * 1024 + 1) + "\n", "utf8");

      let callbackInvoked = false;
      assert.deepEqual(await store.withVerifiedSealedReviewLease(request, async () => {
        callbackInvoked = true;
        return { value: "must-not-disclose", responseSha256 };
      }), { status: "audit_failed" });
      assert.equal(callbackInvoked, false);
    });
  });

  it("bounds the detached audit journal, reserves owner capacity, and preserves its valid head through deletion", async () => {
    const root = await isolatedRoot("review-audit-capacity-and-deletion");
    const nowMs = 1_827_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const reviewRequest = {
      kind: "retention_summary" as const,
      sessionId,
      actor: { role: "retention_owner" as const, actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
    };
    const responseSha256 = createHash("sha256").update("bounded-review-response").digest("hex");

    // Owner lifecycle entries may consume the reserved tail. At 1,000 entries,
    // review admission fails before any archive replay or callback.
    await withSuppressedFileSync(root, () => withServerLease(store, async () => {
      for (let index = 0; index < 1_024; index += 1) {
        const extension = await store.extendRetention({
          sessionId,
          commandId: "audit-capacity-extension-" + index,
          authority: TEST_RETENTION_OWNER_AUTHORITY,
          reason: "audit capacity owner action " + index,
          requestedAtMs: nowMs,
          requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
        });
        assert.equal(extension.status, index === 0 ? "extended" : "rejected");
        if (index === 999) {
          let deniedCallbackInvoked = false;
          assert.deepEqual(await store.withVerifiedSealedReviewLease({
            ...reviewRequest,
            actor: { role: "retention_owner", actorId: "wrong-capacity-review-owner" },
          }, async () => {
            deniedCallbackInvoked = true;
            return { value: "must-not-disclose", responseSha256 };
          }), { status: "audit_failed" });
          assert.equal(deniedCallbackInvoked, false);

          let callbackInvoked = false;
          assert.deepEqual(await store.withVerifiedSealedReviewLease(
            reviewRequest,
            async () => {
              callbackInvoked = true;
              return { value: "must-not-disclose", responseSha256 };
            },
          ), { status: "audit_failed" });
          assert.equal(callbackInvoked, false);
        }
      }

      let callbackInvoked = false;
      assert.deepEqual(await store.withVerifiedSealedReviewLease(
        reviewRequest,
        async () => {
          callbackInvoked = true;
          return { value: "must-not-disclose", responseSha256 };
        },
      ), { status: "audit_failed" });
      assert.equal(callbackInvoked, false);

      let exportCallbackInvoked = false;
      assert.deepEqual(await store.withManagedExportLease({
        lookup: { sessionId },
        commandId: "audit-capacity-export",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        requestedAtMs: nowMs,
      }, async () => {
        exportCallbackInvoked = true;
        throw new Error("audit capacity must fail before creating plaintext");
      }), { status: "audit_failed" });
      assert.equal(exportCallbackInvoked, false);
      await assert.rejects(lstat(join(root, "exports", descriptor.archiveId)), { code: "ENOENT" });

      const deletion = await store.deleteEvidence({
        sessionId,
        commandId: "audit-capacity-deletion",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "delete at bounded audit capacity",
        requestedAtMs: nowMs,
      });
      assert.equal(deletion.status, "completed");
      assert.deepEqual(await store.getRetention(sessionId), {
        status: "deleted",
        extensionUsed: false,
      });
    }));

    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.auditIntegrity, "valid");
    assert.equal(receipt.auditCount, 1_024);
    assert.match(String(receipt.auditHeadSha256), /^[a-f0-9]{64}$/u);

    // A restart must reject an over-cap journal before trying to decrypt or
    // replay its extra line; the authenticated deletion receipt remains the
    // durable tombstone and still reports the bounded valid head.
    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");
    const journal = await readFile(journalPath, "utf8");
    const lastLine = journal.trimEnd().split(/\r?\n/u).at(-1);
    assert.ok(lastLine);
    await writeFile(journalPath, journal + lastLine + "\n", "utf8");
    const restarted = storeFor(root, () => nowMs);
    await withServerLease(restarted, async () => {
      const recovered = await restarted.recover();
      assert.equal(recovered.status, "degraded");
      assert.ok(recovered.finalizationFailures >= 1);
      assert.deepEqual(await restarted.getRetention(sessionId), {
        status: "deleted",
        extensionUsed: false,
      });
      assert.deepEqual(await restarted.withVerifiedSealedReviewLease(
        reviewRequest,
        async () => {
          throw new Error("deleted evidence must not invoke review callback");
        },
      ), { status: "not_found" });
    });
  });

  it("audits successful owner export, retention extension, and deletion into the surviving receipt chain", async () => {
    const root = await isolatedRoot("owner-management-audit-chain");
    const nowMs = 1_828_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const exportCommand = "owner-export-audit-command";
    const extensionCommand = "owner-extension-audit-command";
    const deletionCommand = "owner-deletion-audit-command";
    const exportSentinel = "owner-export-plaintext-sentinel";
    const extensionSentinel = "owner-extension-plaintext-sentinel";
    const deletionSentinel = "owner-deletion-plaintext-sentinel";

    await withServerLease(store, async () => {
      const exported = await store.withManagedExportLease({
        lookup: { sessionId },
        commandId: exportCommand,
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        requestedAtMs: nowMs,
      }, async (lease) => {
        return {
          value: { export: "complete" },
          ...await writeValidManagedExportWorkspace(lease),
        };
      });
      assert.equal(exported.status, "completed");

      assert.deepEqual(await store.extendRetention({
        sessionId,
        commandId: extensionCommand,
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: extensionSentinel,
        requestedAtMs: nowMs,
        requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
      }), {
        status: "extended",
        retentionDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
        extensionUsed: true,
      });

      assert.equal((await store.deleteEvidence({
        sessionId,
        commandId: deletionCommand,
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: deletionSentinel,
        requestedAtMs: nowMs,
      })).status, "completed");
    });

    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.auditIntegrity, "valid");
    assert.ok(Number(receipt.auditCount) >= 4);
    assert.match(String(receipt.auditHeadSha256), /^[a-f0-9]{64}$/u);
    const journal = await readFile(join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc"), "utf8");
    assert.equal(journal.includes(exportSentinel), false);
    assert.equal(journal.includes(extensionSentinel), false);
    assert.equal(journal.includes(deletionSentinel), false);
  });

  it("recovers one durable audit tail after a head failure, then fails closed on tamper while deletion remains governed", async () => {
    const root = await isolatedRoot("review-audit-restart-tamper-and-deletion");
    const nowMs = 1_830_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const request = {
      kind: "metadata_page" as const,
      sessionId,
      actor: { role: "retention_owner" as const, actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId },
      pageSize: 1,
    };
    const responseSha256 = createHash("sha256").update("orphaned-audit-response").digest("hex");

    await withServerLease(store, async () => {
      const result = await withInjectedNthRegularFileSyncFailure(
        join(root, "receipts"),
        2,
        () => store.withVerifiedSealedReviewLease(request, async () => ({
          value: "unreleased-review-value",
          responseSha256,
        })),
      );
      assert.deepEqual(result, { status: "audit_failed" });
    });

    const restarted = storeFor(root, () => nowMs);
    await withServerLease(restarted, async () => {
      assert.equal((await restarted.recover()).status, "completed");
      const review = new EvidenceReview({ artifacts: restarted, cursorKey: Buffer.alloc(32, 13) });
      assert.equal((await review.review(request)).status, "completed");
    });

    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");
    await writeFile(journalPath, "{tampered-audit-journal}\n");
    await withServerLease(restarted, async () => {
      const review = new EvidenceReview({ artifacts: restarted, cursorKey: Buffer.alloc(32, 13) });
      assert.deepEqual(await review.review(request), { status: "audit_failed" });
      assert.deepEqual(await restarted.extendRetention({
        sessionId,
        commandId: "tampered-audit-extension",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "audit-plaintext-extension-sentinel",
        requestedAtMs: nowMs,
        requestedDeadlineAtMs: nowMs + 21 * 24 * 60 * 60 * 1_000,
      }), { status: "rejected" });
      assert.deepEqual(await restarted.withManagedExportLease({
        lookup: { sessionId },
        commandId: "tampered-audit-export",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        requestedAtMs: nowMs,
      }, async () => {
        throw new Error("tampered audit must fail before export callback");
      }), { status: "audit_failed" });
      assert.equal((await restarted.deleteEvidence({
        sessionId,
        commandId: "tampered-audit-delete",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        reason: "audit-plaintext-delete-sentinel",
        requestedAtMs: nowMs,
      })).status, "completed");
    });

    const receipt = JSON.parse(await readFile(
      join(root, "receipts", descriptor.archiveId + ".delete.json"),
      "utf8",
    )) as Record<string, unknown>;
    assert.equal(receipt.auditIntegrity, "invalid");
    assert.equal(receipt.auditCount, 0);
    assert.equal(receipt.auditHeadSha256, "0".repeat(64));
    const journal = await readFile(journalPath, "utf8");
    assert.equal(journal.includes("audit-plaintext-delete-sentinel"), false);
  });

  it("finalizes and recovers a many-record ledger through streaming verification and replay", async () => {
    const root = await isolatedRoot("streaming-many-record-finalize-recover");
    const nowMs = 1_840_000_000_000;
    const fixture = await preparedStreamingFinalizationStore(root, () => nowMs, 128);

    const finalization = await withServerLease(fixture.store, () => fixture.store.finalize({
      sessionId: fixture.sessionId,
      processingManifestSha256: fixture.processingManifest.manifestSha256,
      finalizedAtMonoMs: 100,
      reason: "streaming_many_record_finalization",
      lastPersistedEventCursor: 3,
    }));
    assert.equal(finalization.status, "sealed");
    if (finalization.status !== "sealed") throw new Error("Expected a sealed streaming fixture");
    assert.equal(finalization.recordCount, fixture.recordCount);

    const restarted = storeFor(root, () => nowMs);
    let replayed = 0;
    await withServerLease(restarted, async () => {
      assert.equal((await restarted.recover()).status, "completed");
      const exported = await restarted.withManagedExportLease({
        lookup: { sessionId: fixture.sessionId },
        commandId: "streaming-many-record-export",
        authority: TEST_RETENTION_OWNER_AUTHORITY,
        requestedAtMs: nowMs,
      }, async (lease) => {
        assert.equal("records" in lease.artifact, false);
        for await (const _record of lease.records()) replayed += 1;
        return {
          value: { replayed },
          ...await writeValidManagedExportWorkspace(lease),
        };
      });
      assert.equal(exported.status, "completed");
    });
    assert.equal(replayed, fixture.recordCount);
    assert.equal(
      (await readdir(join(root, "archive"))).some((name) => name.endsWith(".tmp")),
      false,
    );
  });

  it("fences pre- and in-flight finalization cancellation and never seals after restart", async () => {
    const nowMs = 1_840_500_000_000;
    const preRoot = await isolatedRoot("finalization-abort-before-terminal-commit");
    await mkdir(join(preRoot, "archive"), { recursive: true });
    const preFixture = await withSuppressedFileSync(
      join(preRoot, "archive"),
      () => preparedStreamingFinalizationStore(preRoot, () => nowMs, 0),
    );
    const preAbort = new AbortController();
    preAbort.abort();

    const preResult = await withServerLease(preFixture.store, () => preFixture.store.finalize({
      sessionId: preFixture.sessionId,
      processingManifestSha256: preFixture.processingManifest.manifestSha256,
      finalizedAtMonoMs: 100,
      reason: "abort_before_terminal_commit",
      lastPersistedEventCursor: 3,
      abortSignal: preAbort.signal,
    }));
    assert.equal(preResult.status, "FINALIZATION_FAILED");

    const preRestart = storeFor(preRoot, () => nowMs);
    await withServerLease(preRestart, async () => {
      const recovery = await preRestart.recover();
      assert.notEqual(recovery.sealedArtifacts, 1);
      const descriptor = await preRestart.artifact({ sessionId: preFixture.sessionId });
      assert.equal(descriptor?.status, "FINALIZATION_FAILED");
    });

    const duringRoot = await isolatedRoot("finalization-abort-during-terminal-commit");
    await mkdir(join(duringRoot, "archive"), { recursive: true });
    const duringFixture = await withSuppressedFileSync(
      join(duringRoot, "archive"),
      () => preparedStreamingFinalizationStore(duringRoot, () => nowMs, 0),
    );
    const duringAbort = new AbortController();
    const duringResult = await withServerLease(duringFixture.store, () =>
      withInjectedDelayedNthRegularFileSync(
        join(duringRoot, "archive"),
        1,
        () => duringFixture.store.finalize({
          sessionId: duringFixture.sessionId,
          processingManifestSha256: duringFixture.processingManifest.manifestSha256,
          finalizedAtMonoMs: 100,
          reason: "abort_during_terminal_commit",
          lastPersistedEventCursor: 3,
          abortSignal: duringAbort.signal,
        }),
        (release) => {
          duringAbort.abort();
          release();
        },
      ),
    );
    assert.equal(duringResult.status, "FINALIZATION_FAILED");

    const duringRestart = storeFor(duringRoot, () => nowMs);
    await withServerLease(duringRestart, async () => {
      const recovery = await duringRestart.recover();
      assert.notEqual(recovery.sealedArtifacts, 1);
      const descriptor = await duringRestart.artifact({ sessionId: duringFixture.sessionId });
      assert.equal(descriptor?.status, "FINALIZATION_FAILED");
    });
  });

  it("keeps a root lease busy until an aborted finalization tail settles", async () => {
    const root = await isolatedRoot("finalization-abort-tail-drain");
    const nowMs = 1_840_750_000_000;
    await mkdir(join(root, "archive"), { recursive: true });
    const fixture = await withSuppressedFileSync(
      join(root, "archive"),
      () => preparedStreamingFinalizationStore(root, () => nowMs, 0),
    );
    const lease = await fixture.store.acquireEvidenceRootLease("server");
    const tailGate = Promise.withResolvers<void>();
    const persistEntered = Promise.withResolvers<void>();
    const pendingPersist = withInjectedDelayedNthRegularFileSync(
      join(root, "archive"),
      1,
      () => fixture.store.persist({
        type: "session_event",
        sessionId: fixture.sessionId,
        event: {
          type: "participant_state",
          cursor: 4,
          sessionId: fixture.sessionId,
          timestampMonoMs: 4,
          lane: null,
          generation: null,
          side: "A",
          connected: true,
        },
      } as unknown as EvidenceRecord),
      async (release) => {
        persistEntered.resolve();
        await tailGate.promise;
        release();
      },
    );
    await persistEntered.promise;

    const abort = new AbortController();
    const finalizationPromise = fixture.store.finalize({
      sessionId: fixture.sessionId,
      processingManifestSha256: fixture.processingManifest.manifestSha256,
      finalizedAtMonoMs: 100,
      reason: "abort_with_pending_tail",
      lastPersistedEventCursor: 3,
      abortSignal: abort.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    abort.abort();
    const finalization = await finalizationPromise;
    assert.equal(finalization.status, "FINALIZATION_FAILED");

    await assert.rejects(lease.release(), /busy with an unfinished operation/u);
    assert.ok(await lstat(join(root, "keys", "evidence-root.lifecycle.lock")));
    const competingStore = storeFor(root, () => nowMs);
    await assert.rejects(
      competingStore.acquireEvidenceRootLease("server"),
      /Evidence root is leased by another process/u,
    );

    tailGate.resolve();
    await assert.rejects(pendingPersist, /cancelled|unavailable|failed/u);
    await lease.release();

    const recoveredLease = await competingStore.acquireEvidenceRootLease("server");
    try {
      const recovery = await competingStore.recover();
      assert.equal(recovery.sealedArtifacts, 0);
      const descriptor = await competingStore.artifact({ sessionId: fixture.sessionId });
      assert.equal(descriptor?.status, "FINALIZATION_FAILED");
    } finally {
      await recoveredLease.release();
    }
  });

  it("repairs a partial terminal by atomically rewriting only verified record envelopes", async () => {
    const root = await isolatedRoot("streaming-partial-terminal-rebuild");
    const nowMs = 1_841_000_000_000;
    const fixture = await preparedStreamingFinalizationStore(root, () => nowMs, 8);

    const finalization = await withServerLease(fixture.store, () =>
      withInjectedNthRegularFileSyncFailure(join(root, "archive"), 3, () => fixture.store.finalize({
        sessionId: fixture.sessionId,
        processingManifestSha256: fixture.processingManifest.manifestSha256,
        finalizedAtMonoMs: 100,
        reason: "repair_partial_terminal",
        lastPersistedEventCursor: 3,
      })),
    );
    assert.equal(finalization.status, "sealed");
    if (finalization.status !== "sealed") throw new Error("Expected rebuilt finalization to seal");
    assert.equal(finalization.recordCount, fixture.recordCount);
    const archiveNames = await readdir(join(root, "archive"));
    assert.equal(archiveNames.some((name) => name.endsWith(".tmp")), false);
    assert.equal(archiveNames.some((name) => name.endsWith(".spool.enc")), false);
    assert.equal(archiveNames.some((name) => name.endsWith(".evidence.jsonl.enc")), true);
  });

  it("fails closed before parsing an oversized encrypted ledger line and leaves no rewrite temporary", async () => {
    const root = await isolatedRoot("streaming-oversized-logical-line");
    const nowMs = 1_842_000_000_000;
    const { store, sessionId } = await sealedStoreForRetention(root, () => nowMs);
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const lines = (await readFile(descriptor.archivePath, "utf8")).split("\n");
    lines[1] = "x".repeat(2 * 1024 * 1024 + 1);
    await writeFile(descriptor.archivePath, lines.join("\n"), "utf8");

    const verifier = storeFor(root, () => nowMs);
    await withServerLease(verifier, async () => {
      let callbackInvoked = false;
      assert.deepEqual(await verifier.withVerifiedSealedReviewLease({
        kind: "metadata_page",
        sessionId,
        actor: {
          role: "retention_owner",
          actorId: TEST_EVIDENCE_REVIEW_GRANT.dataOwnerId,
        },
        pageSize: 1,
      }, async () => {
        callbackInvoked = true;
        return { value: null, responseSha256: "a".repeat(64) };
      }), { status: "integrity_failed" });
      assert.equal(callbackInvoked, false);
    });
    assert.equal(
      (await readdir(join(root, "archive"))).some((name) => name.endsWith(".tmp")),
      false,
    );
  });

  it("reconciles a durable extension audit before an in-process sweep and replays it once after restart", async () => {
    const root = await isolatedRoot("pending-extension-sweep-reconcile");
    const initialNowMs = 1_843_000_000_000;
    let nowMs = initialNowMs;
    const now = (): number => nowMs;
    const { store, sessionId } = await withSuppressedFileSync(
      root,
      () => sealedStoreForRetention(root, now),
    );
    const descriptor = await withServerLease(store, () => store.artifact({ sessionId }));
    assert.ok(descriptor);
    const dayMs = 24 * 60 * 60 * 1_000;
    const extension = {
      sessionId,
      commandId: "pending-extension-sweep-command",
      authority: TEST_RETENTION_OWNER_AUTHORITY,
      reason: "retain for delayed sweep reconciliation",
      requestedAtMs: initialNowMs,
      requestedDeadlineAtMs: initialNowMs + 21 * dayMs,
    };
    const expected = {
      status: "extended" as const,
      retentionDeadlineAtMs: extension.requestedDeadlineAtMs,
      extensionUsed: true,
    };

    // The sixth regular-file sync is the final sidecar commit (after the
    // lifecycle lock marker, pending sidecar, audit journal, audit head, and
    // audit-initialized sidecar).
    // Fail only that final commit: the completion audit is durable while the
    // signed metadata remains a pending extension intent.
    await withServerLease(store, async () => {
      assert.deepEqual(await withInjectedNthRegularFileSyncFailure(
        join(root, "receipts"),
        6,
        () => store.extendRetention(extension),
      ), { status: "rejected" });
    });

    // Cross the original fourteen-day deadline. The same live Store must
    // recover the durable completion audit before sweeping, so it cannot
    // delete against the stale pre-extension deadline.
    nowMs = initialNowMs + 14 * dayMs + 1;
    await withServerLease(store, async () => {
      const sweep = await store.sweepExpired();
      assert.equal(sweep.status, "completed");
      assert.equal(sweep.expiredArtifactsDeleted, 0);
      assert.deepEqual(await store.getRetention(sessionId), {
        status: "sealed",
        retentionDeadlineAtMs: extension.requestedDeadlineAtMs,
        extensionUsed: true,
      });
      assert.ok(await store.artifact({ sessionId }));
    });

    const journalPath = join(root, "receipts", descriptor.archiveId + ".audit.jsonl.enc");
    const journalEntryCount = async (): Promise<number> =>
      (await readFile(journalPath, "utf8")).trim().split(/\r?\n/u).filter(Boolean).length;
    const beforeRetry = await journalEntryCount();

    const restarted = storeFor(root, now);
    await withServerLease(restarted, async () => {
      assert.equal((await restarted.recover()).status, "completed");
      assert.deepEqual(await restarted.extendRetention(extension), expected);
      assert.equal(await journalEntryCount(), beforeRetry, "exact replay must not append another audit");
      assert.deepEqual(await restarted.extendRetention({
        ...extension,
        reason: "changed payload must conflict",
      }), { status: "conflict" });
    });
    assert.equal(await journalEntryCount(), beforeRetry + 1, "changed authenticated attempt must be audited");
  });
});

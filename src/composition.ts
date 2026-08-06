import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import { EncryptedFileEvidenceStore } from "./adapters/evidence/encrypted-file.js";
import { InMemoryEvidenceStore } from "./adapters/evidence/in-memory.js";
import {
  FileGlossaryRepository,
  GlossaryVersionNotFoundError,
} from "./adapters/glossary/file-repository.js";
import {
  NativeRealtimeTranslateAdapter,
  OpenAILiveTranscribeAdapter,
  OpenAITextTranslator,
  OpenAITtsAdapter,
} from "./adapters/openai/index.js";
import { PalabraTranslationAdapter } from "./adapters/palabra/index.js";
import { DeterministicTranslationAdapter } from "./adapters/translation/deterministic.js";
import { ControlledTranslationAdapter } from "./adapters/translation/glossary-controlled.js";
import { createLocalEvalTranslationAdapter } from "./adapters/translation/local-eval.js";
import { TranslationProfileRouter } from "./adapters/translation/profile-router.js";
import type { AppConfig } from "./config.js";
import type { CompiledGlossary, GlossarySpec } from "./core/glossary.js";
import { ModularGuardedDuplexRelay } from "./core/relay.js";
import type {
  EventCursor,
  EvidencePort,
  EvidenceRecord,
  GuardedDuplexRelay,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  TranslationPort,
  TranslationProfile,
} from "./core/types.js";
import {
  createMediaRuntime,
  type TelephonyTestDriver,
} from "./media-runtime.js";
import {
  createServerApp,
  type EvidenceHealth,
  type GlossaryImportResult,
  type GlossaryRegistry,
} from "./server/app.js";
import { createServerAccessControl, withAccessFragment } from "./server/access.js";
import {
  decodeGlossaryContents,
  type ImportGlossaryRequest,
} from "./server/protocol.js";

export interface ApplicationComposition {
  readonly app: Awaited<ReturnType<typeof createServerApp>>;
  readonly translationProfiles: readonly TranslationProfile[];
  readonly operatorUrl: string;
  readonly telephonyTestDriver?: TelephonyTestDriver;
}

class HealthTrackedEvidence implements EvidencePort {
  readonly #delegate: EvidencePort;
  #health: EvidenceHealth = "healthy";

  constructor(delegate: EvidencePort) {
    this.#delegate = delegate;
  }

  health = (): EvidenceHealth => this.#health;

  record(record: EvidenceRecord): boolean {
    const accepted = this.#delegate.record(record);
    if (!accepted) this.#health = "degraded";
    return accepted;
  }

  async close(sessionId: string): Promise<void> {
    try {
      await this.#delegate.close(sessionId);
    } catch (error: unknown) {
      this.#health = "degraded";
      throw error;
    }
  }
}

class ManagedRelay implements GuardedDuplexRelay {
  readonly #delegate: GuardedDuplexRelay;
  readonly #active = new Set<string>();
  readonly #ending = new Map<string, Promise<void>>();

  constructor(delegate: GuardedDuplexRelay) {
    this.#delegate = delegate;
  }

  async open(spec: SessionSpec): Promise<SessionSnapshot> {
    const snapshot = await this.#delegate.open(spec);
    this.#active.add(snapshot.sessionId);
    return snapshot;
  }

  snapshot(sessionId: string): SessionSnapshot {
    return this.#delegate.snapshot(sessionId);
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    if (command.type !== "end") {
      await this.#delegate.command(sessionId, command);
      return;
    }
    const existing = this.#ending.get(sessionId);
    if (existing !== undefined) {
      await existing;
      return;
    }
    const ending = this.#delegate.command(sessionId, command).finally(() => {
      this.#active.delete(sessionId);
      this.#ending.delete(sessionId);
    });
    this.#ending.set(sessionId, ending);
    await ending;
  }

  events(sessionId: string, after?: EventCursor): AsyncIterable<SessionEvent> {
    return this.#delegate.events(sessionId, after);
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#active].map(async (sessionId) => {
        await this.command(sessionId, {
          type: "end",
          commandId: randomUUID(),
          reason: "server_shutdown",
        });
      }),
    );
  }
}

export class FileGlossaryRegistry implements GlossaryRegistry {
  readonly #repository: FileGlossaryRepository;
  readonly #now: () => Date;

  constructor(repository: FileGlossaryRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async importFile(request: ImportGlossaryRequest): Promise<GlossaryImportResult> {
    const id = glossaryId(request.name);
    const contents = decodeGlossaryContents(request.contentsBase64);
    const version = glossaryVersion(id, request, contents);
    await this.#repository.import({
      id,
      version,
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      approval: {
        approvedBy: request.approvedBy,
        approvedAt: this.#now().toISOString(),
      },
      fileName: request.fileName,
      contents,
    });
    const pinned = await this.#repository.pin(id, version);
    return Object.freeze({
      version,
      hash: pinned.hash,
      spec: glossarySpec(pinned.compiled),
    });
  }

  async get(version: string): Promise<import("./core/glossary.js").GlossarySpec | undefined> {
    const id = glossaryIdFromVersion(version);
    if (id === undefined) return undefined;
    try {
      return glossarySpec((await this.#repository.pin(id, version)).compiled);
    } catch (error) {
      if (error instanceof GlossaryVersionNotFoundError) return undefined;
      throw error;
    }
  }
}

function glossarySpec(compiled: CompiledGlossary): GlossarySpec {
  return Object.freeze({
    id: compiled.id,
    version: compiled.version,
    sourceLanguage: compiled.sourceLanguage,
    targetLanguage: compiled.targetLanguage,
    entries: Object.freeze(compiled.entries.map((entry) => Object.freeze({
      id: entry.id,
      source: entry.source,
      aliases: Object.freeze([...entry.aliases]),
      targetExact: entry.targetExact,
    }))),
  });
}

function glossaryId(name: string): string {
  const normalized = name.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  const stem = normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/gu, "");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return (stem.length === 0 ? "glossary" : stem) + "-" + digest.slice(0, 12);
}

function glossaryVersion(
  id: string,
  request: ImportGlossaryRequest,
  contents: Uint8Array,
): string {
  const digest = createHash("sha256")
    .update(request.sourceLanguage.normalize("NFKC").trim(), "utf8")
    .update("\0", "utf8")
    .update(request.targetLanguage.normalize("NFKC").trim(), "utf8")
    .update("\0", "utf8")
    .update(request.approvedBy.normalize("NFKC").trim(), "utf8")
    .update("\0", "utf8")
    .update(request.fileName.normalize("NFKC").trim(), "utf8")
    .update("\0", "utf8")
    .update(contents)
    .digest("hex");
  return id + "." + digest;
}

function glossaryIdFromVersion(version: string): string | undefined {
  const separator = version.lastIndexOf(".");
  if (separator < 1 || separator === version.length - 1) return undefined;
  return version.slice(0, separator);
}

function translationRouter(config: AppConfig): TranslationProfileRouter {
  const profiles = new Map<TranslationProfile, TranslationPort>([
    ["deterministic_test", new DeterministicTranslationAdapter()],
    ["local_eval", createLocalEvalTranslationAdapter({
      transcriptByLane: {
        A_TO_B: config.localEvalTranscriptAToB,
        B_TO_A: config.localEvalTranscriptBToA,
      },
      confidence: config.localEvalConfidence,
      translationMode: config.localEvalTranslationMode,
    })],
  ]);

  if (config.openaiApiKey !== undefined) {
    profiles.set(
      "native_live_baseline",
      new NativeRealtimeTranslateAdapter({
        apiKey: config.openaiApiKey,
        model: config.openaiRealtimeModel,
      }),
    );
    profiles.set(
      "glossary_controlled",
      new ControlledTranslationAdapter({
        transcriber: new OpenAILiveTranscribeAdapter({
          apiKey: config.openaiApiKey,
          model: config.openaiTranscribeModel,
          prompt: "Manufacturing support call. Preserve product names, model numbers, " +
            "part numbers, acronyms, and technical terms exactly.",
        }),
        translator: new OpenAITextTranslator({
          apiKey: config.openaiApiKey,
          model: config.openaiTextModel,
        }),
        tts: new OpenAITtsAdapter({
          apiKey: config.openaiApiKey,
          model: config.openaiTtsModel,
          voice: config.openaiTtsVoice,
        }),
      }),
    );
  }
  if (config.palabraApiKey !== undefined) {
    profiles.set(
      "palabra_live",
      new PalabraTranslationAdapter({
        apiKey: config.palabraApiKey,
        inputChunkMs: config.palabraInputChunkMs,
      }),
    );
  }

  const router = new TranslationProfileRouter(profiles);
  if (!router.has(config.translationProfile)) {
    throw new TypeError(
      "Configured translation profile " + config.translationProfile + " is unavailable",
    );
  }
  return router;
}

function evidencePort(config: AppConfig): HealthTrackedEvidence {
  if (config.evidenceProfile === "in_memory") {
    return new HealthTrackedEvidence(
      new InMemoryEvidenceStore<EvidenceRecord>(),
    );
  }
  if (config.evidenceKey === undefined) {
    throw new TypeError("Encrypted evidence requires a 32-byte evidence key");
  }
  return new HealthTrackedEvidence(
    new EncryptedFileEvidenceStore<EvidenceRecord>({
      directory: config.evidenceDirectory,
      key: config.evidenceKey,
    }),
  );
}

async function httpsOptions(config: AppConfig): Promise<HttpsServerOptions | undefined> {
  if (config.tlsCertPath === undefined && config.tlsKeyPath === undefined) {
    return undefined;
  }
  if (config.tlsCertPath === undefined || config.tlsKeyPath === undefined) {
    throw new TypeError("TLS certificate and key must be configured together");
  }
  const [cert, key] = await Promise.all([
    readFile(config.tlsCertPath),
    readFile(config.tlsKeyPath),
  ]);
  return { cert, key };
}

export async function composeApplication(config: AppConfig): Promise<ApplicationComposition> {
  const access = createServerAccessControl({
    operatorToken: config.operatorToken,
  });
  const media = createMediaRuntime({
    profile: config.mediaProfile,
    publicBaseUrl: config.publicBaseUrl,
    access,
  });
  const translation = translationRouter(config);
  const evidence = evidencePort(config);
  const glossaries = new FileGlossaryRegistry(
    new FileGlossaryRepository({ directory: config.glossaryDirectory }),
  );
  const relay = new ManagedRelay(new ModularGuardedDuplexRelay({
    media: media.port,
    translation,
    evidence,
    endpointGrant: media.endpointGrant,
  }));
  const translationProfiles = translation.available();
  const https = await httpsOptions(config);
  const app = await createServerApp({
    relay,
    glossaries,
    mediaProfile: media.profile,
    ...(media.browserGateway === undefined
      ? {}
      : { browserMedia: media.browserGateway }),
    logger: {
      level: config.logLevel,
      redact: {
        paths: ["req.url", "req.headers.authorization"],
        censor: "[REDACTED]",
      },
    },
    access,
    translationProfiles,
    defaultTranslationProfile: config.translationProfile,
    evidenceHealth: evidence.health,
    ...(https === undefined ? {} : { https }),
  });
  app.addHook("onClose", async () => relay.close());
  const operatorUrl = withAccessFragment(
    config.publicBaseUrl,
    config.operatorToken,
  ).toString();

  return Object.freeze({
    app,
    translationProfiles,
    operatorUrl,
    ...(media.telephonyTestDriver === undefined
      ? {}
      : { telephonyTestDriver: media.telephonyTestDriver }),
  });
}

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
  createOpenAITranslationAdapter,
  OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES,
  OPENAI_NATIVE_TRANSLATION_CAPABILITIES,
} from "./adapters/openai/index.js";
import {
  PALABRA_TRANSLATION_CAPABILITIES,
  PalabraTranslationAdapter,
} from "./adapters/palabra/index.js";
import type { AppConfig } from "./config.js";
import type { CompiledGlossary, GlossarySpec } from "./core/glossary.js";
import { ModularGuardedDuplexRelay } from "./core/relay.js";
import { resolveTranslationBehavior } from "./core/translation-behavior.js";
import type {
  EventCursor,
  EvidencePort,
  EvidenceRecord,
  GuardedDuplexRelay,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  TranslationCapabilities,
  TranslationModeCapability,
  TranslationPort,
} from "./core/types.js";
import {
  createMediaRuntime,
  type TelephonyTestDriver,
} from "./media-runtime.js";
import {
  createServerApp,
  type ConfiguredTranslation,
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
  readonly translation: ConfiguredTranslation;
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

export class ManagedRelay implements GuardedDuplexRelay {
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

  events(
    sessionId: string,
    after?: EventCursor,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    return this.#delegate.events(sessionId, after, signal);
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

interface TranslationRuntime {
  readonly port: TranslationPort;
  readonly configuration: ConfiguredTranslation;
}

function requireServerKey(
  value: string | undefined,
  name: "OPENAI_API_KEY" | "PALABRA_API_KEY",
  provider: AppConfig["translationProvider"],
): string {
  if (value === undefined || value.trim() === "") {
    throw new TypeError(
      name + " is required for TRANSLATION_PROVIDER=" + provider,
    );
  }
  return value;
}

function staticCapabilities(
  provider: AppConfig["translationProvider"],
): TranslationCapabilities {
  switch (provider) {
    case "palabra":
      return PALABRA_TRANSLATION_CAPABILITIES;
    case "openai_native":
      return OPENAI_NATIVE_TRANSLATION_CAPABILITIES;
    case "openai_controlled":
      return OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES;
  }
}

function assertModeCapability(
  capabilities: TranslationCapabilities,
  capability: TranslationModeCapability,
): void {
  const behavior = resolveTranslationBehavior(capability.mode);
  if (capability.behaviorVersion !== behavior.version) {
    throw new TypeError(
      capabilities.providerId + " " + capability.mode +
        " is incompatible with translation behavior version " + behavior.version,
    );
  }
  if (
    behavior.requirements.revisions &&
    !capabilities.supportsProvisionalRevisions
  ) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy provisional revisions for " + capability.mode,
    );
  }
  if (behavior.requirements.cancellation && !capabilities.supportsCancellation) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy interruption cancellation for " + capability.mode,
    );
  }
  if (
    capability.deterministicGlossary &&
    !capabilities.supportsDeterministicGlossary
  ) {
    throw new TypeError(
      capabilities.providerId + " advertises deterministic glossary support inconsistently",
    );
  }
  if (
    behavior.transcriptPolicy === "final_only" &&
    !capabilities.supportsFinality
  ) {
    throw new TypeError(
      capabilities.providerId + " cannot satisfy final transcript policy for " + capability.mode,
    );
  }
}

function validateTranslationConfiguration(
  config: AppConfig,
  capabilities: TranslationCapabilities,
): void {
  if (capabilities.providerId !== config.translationProvider) {
    throw new TypeError(
      "Configured provider " + config.translationProvider +
        " does not match " + capabilities.providerId + " capabilities",
    );
  }
  for (const capability of capabilities.supportedModes) {
    assertModeCapability(capabilities, capability);
  }
  const defaultCapability = capabilities.supportedModes.find(
    (capability) => capability.mode === config.translationMode,
  );
  if (defaultCapability === undefined) {
    throw new TypeError(
      "TRANSLATION_PROVIDER=" + config.translationProvider +
        " does not support TRANSLATION_MODE=" + config.translationMode,
    );
  }
  if (config.translationBehavior.mode !== config.translationMode) {
    throw new TypeError("Configured translation behavior does not match TRANSLATION_MODE");
  }
  if (defaultCapability.behaviorVersion !== config.translationBehavior.version) {
    throw new TypeError(
      "Configured translation behavior version " +
        config.translationBehavior.version + " is unsupported",
    );
  }
}

function translationRuntime(config: AppConfig): TranslationRuntime {
  const capabilities = staticCapabilities(config.translationProvider);
  validateTranslationConfiguration(config, capabilities);

  let port: TranslationPort;
  switch (config.translationProvider) {
    case "palabra":
      port = new PalabraTranslationAdapter({
        apiKey: requireServerKey(
          config.palabraApiKey,
          "PALABRA_API_KEY",
          config.translationProvider,
        ),
        inputChunkMs: config.palabraInputChunkMs,
      });
      break;
    case "openai_native":
      port = createOpenAITranslationAdapter({
        provider: "openai_native",
        apiKey: requireServerKey(
          config.openaiApiKey,
          "OPENAI_API_KEY",
          config.translationProvider,
        ),
        native: {
          model: config.openaiRealtimeModel,
        },
      });
      break;
    case "openai_controlled":
      port = createOpenAITranslationAdapter({
        provider: "openai_controlled",
        apiKey: requireServerKey(
          config.openaiApiKey,
          "OPENAI_API_KEY",
          config.translationProvider,
        ),
        controlled: {
          transcribeModel: config.openaiTranscribeModel,
          textModel: config.openaiTextModel,
          ttsModel: config.openaiTtsModel,
          ttsVoice: config.openaiTtsVoice,
        },
      });
      break;
  }

  if (port.capabilities.providerId !== capabilities.providerId) {
    throw new TypeError(
      "Configured " + config.translationProvider + " adapter returned mismatched capabilities",
    );
  }
  return Object.freeze({
    port,
    configuration: Object.freeze({
      ...capabilities,
      defaultMode: config.translationMode,
    }),
  });
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
  const translation = translationRuntime(config);
  const evidence = evidencePort(config);
  const glossaries = new FileGlossaryRegistry(
    new FileGlossaryRepository({ directory: config.glossaryDirectory }),
  );
  const relay = new ManagedRelay(new ModularGuardedDuplexRelay({
    media: media.port,
    translation: translation.port,
    evidence,
    endpointGrant: media.endpointGrant,
  }));
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
    translation: translation.configuration,
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
    translation: translation.configuration,
    operatorUrl,
    ...(media.telephonyTestDriver === undefined
      ? {}
      : { telephonyTestDriver: media.telephonyTestDriver }),
  });
}

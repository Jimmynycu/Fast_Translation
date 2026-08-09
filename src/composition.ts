import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerOptions as HttpsServerOptions } from "node:https";
import {
  SessionArtifactStore,
  type SessionArtifactManagementPort,
} from "./adapters/evidence/session-artifact-store.js";
import { EvidenceReview } from "./adapters/evidence/review.js";
import { loadApprovedSessionProcessingProfile } from "./adapters/config/processing-profile.js";
import {
  FileGlossaryRepository,
  GlossaryVersionDeletedError,
  GlossaryVersionNotFoundError,
  type GlossaryRootLease,
} from "./adapters/glossary/file-repository.js";
import {
  assertTranslationBehaviorCapability,
  validateTranslationCapabilities,
} from "./core/translation-capabilities.js";
import {
  createOpenAITranslationAdapter,
  OpenAILiveTranscribeAdapter,
  OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES,
  OPENAI_NATIVE_TRANSLATION_CAPABILITIES,
  OpenAITextTranslator,
  OpenAITtsAdapter,
} from "./adapters/openai/index.js";
import {
  PALABRA_TRANSLATION_CAPABILITIES,
  PalabraTranslationAdapter,
} from "./adapters/palabra/index.js";
import type { AppConfig } from "./config.js";
import type { CompiledGlossary, GlossarySpec } from "./core/glossary.js";
import {
  canonicalJsonSha256,
  type ApprovedSessionProcessingProfile,
  type ProcessingService,
} from "./core/processing-profile.js";
import { ModularGuardedDuplexRelay, RelaySessionError } from "./core/relay.js";
import { resolveTranslationBehavior } from "./core/translation-behavior.js";
import type {
  EvidenceFinalization,
  EvidenceFinalizeRequest,
  EventCursor,
  EvidencePort,
  EvidenceRecord,
  GuardedDuplexRelay,
  RecorderPreflightRequest,
  RecorderPreflightResult,
  RelayCommand,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  TranslationCapabilities,
  TranslationProviderId,
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
  type GlossaryDeletionResult,
  type GlossaryImportResult,
  type GlossaryLease,
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

/** Hard upper bound for concurrently managed service sessions. */
export const MAX_ACTIVE_SESSIONS = 64;

class HealthTrackedEvidence implements EvidencePort {
  readonly #delegate: SessionArtifactManagementPort;
  #health: EvidenceHealth = "healthy";

  constructor(delegate: SessionArtifactManagementPort) {
    this.#delegate = delegate;
  }

  health = (): EvidenceHealth =>
    this.#health === "degraded" || this.#delegate.getRetentionSweepHealth().health === "degraded"
      ? "degraded"
      : "healthy";

  async preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult> {
    try {
      const result = await this.#delegate.preflightRecorder(request);
      if (result.status === "failed") this.#health = "degraded";
      return result;
    } catch (error: unknown) {
      this.#health = "degraded";
      throw error;
    }
  }

  async persist(record: EvidenceRecord): Promise<void> {
    try {
      await this.#delegate.persist(record);
    } catch (error: unknown) {
      this.#health = "degraded";
      throw error;
    }
  }

  async flush(sessionId: string): Promise<void> {
    try {
      await this.#delegate.flush(sessionId);
    } catch (error: unknown) {
      this.#health = "degraded";
      throw error;
    }
  }

  async finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization> {
    try {
      const result = await this.#delegate.finalize(request);
      if (result.status === "FINALIZATION_FAILED") this.#health = "degraded";
      return result;
    } catch (error: unknown) {
      this.#health = "degraded";
      throw error;
    }
  }
}

export class ManagedRelay implements GuardedDuplexRelay {
  readonly #delegate: GuardedDuplexRelay;
  readonly #active = new Set<string>();
  readonly #opening = new Map<symbol, Promise<void>>();
  readonly #ending = new Map<string, Promise<void>>();
  readonly #terminalWatchers = new Map<string, AbortController>();
  #closeAll: Promise<void> | undefined;

  constructor(delegate: GuardedDuplexRelay) {
    this.#delegate = delegate;
  }

  async open(spec: SessionSpec): Promise<SessionSnapshot> {
    const closing = this.#closeAll;
    if (closing !== undefined) await closing;
    if (this.#active.size + this.#opening.size >= MAX_ACTIVE_SESSIONS) {
      throw new RelaySessionError(
        "invalid_command",
        `Managed relay active session limit (${MAX_ACTIVE_SESSIONS}) reached`,
      );
    }
    const reservation = Symbol("managed relay session");
    let resolveOpening!: () => void;
    const opening = new Promise<void>((resolve) => {
      resolveOpening = resolve;
    });
    this.#opening.set(reservation, opening);
    try {
      const snapshot = await this.#delegate.open(spec);
      if (snapshot.status === "closed") return snapshot;
      this.#active.add(snapshot.sessionId);
      this.#watchTerminalState(snapshot);
      return snapshot;
    } finally {
      this.#opening.delete(reservation);
      resolveOpening();
    }
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
    const ending = this.#delegate.command(sessionId, command)
      .then(
        () => this.#releaseSession(sessionId),
        (error: unknown) => { throw error; },
      )
      .finally(() => {
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
    const existing = this.#closeAll;
    if (existing !== undefined) {
      await existing;
      return;
    }
    const closing = this.#closeSessions();
    this.#closeAll = closing;
    try {
      await closing;
    } finally {
      if (this.#closeAll === closing) this.#closeAll = undefined;
    }
  }

  async #closeSessions(): Promise<void> {
    const openingCompletions = [...this.#opening.values()];
    await Promise.allSettled(openingCompletions);
    const endingSessionIds = new Set(this.#ending.keys());
    const settled = await Promise.allSettled(
      [
        ...this.#ending.values(),
        ...[...this.#active]
          .filter((sessionId) => !endingSessionIds.has(sessionId))
          .map((sessionId) => this.command(sessionId, {
            type: "end",
            commandId: randomUUID(),
            reason: "server_shutdown",
          })),
      ],
    );
    const failures = settled
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to close one or more managed relay sessions");
    }
  }

  #watchTerminalState(snapshot: SessionSnapshot): void {
    const existing = this.#terminalWatchers.get(snapshot.sessionId);
    existing?.abort();
    const watcher = new AbortController();
    this.#terminalWatchers.set(snapshot.sessionId, watcher);
    void this.#observeTerminalState(snapshot.sessionId, snapshot.eventCursor, watcher);
  }

  async #observeTerminalState(
    sessionId: string,
    after: EventCursor,
    watcher: AbortController,
  ): Promise<void> {
    try {
      for await (const event of this.#delegate.events(sessionId, after, watcher.signal)) {
        if (!isTerminalSessionEvent(event)) continue;
        this.#releaseSession(sessionId, watcher);
        return;
      }
      this.#releaseClosedSession(sessionId, watcher);
    } catch {
      this.#releaseClosedSession(sessionId, watcher);
    } finally {
      if (this.#terminalWatchers.get(sessionId) === watcher) {
        this.#terminalWatchers.delete(sessionId);
      }
    }
  }

  #releaseClosedSession(sessionId: string, watcher: AbortController): void {
    if (watcher.signal.aborted || this.#terminalWatchers.get(sessionId) !== watcher) return;
    try {
      if (this.#delegate.snapshot(sessionId).status === "closed") {
        this.#releaseSession(sessionId, watcher);
      }
    } catch {
      // The terminal observer only removes sessions whose public state is closed.
    }
  }

  #releaseSession(sessionId: string, watcher?: AbortController): void {
    if (watcher !== undefined && this.#terminalWatchers.get(sessionId) !== watcher) return;
    this.#active.delete(sessionId);
    const currentWatcher = this.#terminalWatchers.get(sessionId);
    if (currentWatcher === undefined) return;
    this.#terminalWatchers.delete(sessionId);
    currentWatcher.abort();
  }
}

function isTerminalSessionEvent(event: SessionEvent): boolean {
  return event.type === "session_closed" ||
    (event.type === "session_state" && event.status === "closed");
}

export class FileGlossaryRegistry implements GlossaryRegistry {
  readonly #repository: FileGlossaryRepository;
  readonly #now: () => Date;

  constructor(repository: FileGlossaryRepository, now: () => Date = () => new Date()) {
    this.#repository = repository;
    this.#now = now;
  }

  async acquireRootLease(): Promise<GlossaryRootLease> {
    return this.#repository.acquireRootLease();
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
    const lease = await this.#repository.acquire(id, version);
    try {
      return Object.freeze({
        version,
        hash: lease.glossary.hash,
        spec: glossarySpec(lease.glossary.compiled),
      });
    } finally {
      await lease.release();
    }
  }

  async acquire(version: string): Promise<GlossaryLease | undefined> {
    const id = glossaryIdFromVersion(version);
    if (id === undefined) return undefined;
    try {
      const lease = await this.#repository.acquire(id, version);
      return Object.freeze({
        spec: glossarySpec(lease.glossary.compiled),
        release: lease.release,
      });
    } catch (error) {
      if (
        error instanceof GlossaryVersionNotFoundError ||
        error instanceof GlossaryVersionDeletedError
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async deleteVersion(request: Readonly<{
    readonly version: string;
    readonly commandId: string;
    readonly ownerId: string;
    readonly reason: string;
    readonly requestedAtMs: number;
  }>): Promise<GlossaryDeletionResult> {
    const id = glossaryIdFromVersion(request.version);
    if (id === undefined) return Object.freeze({ status: "not_found" as const });
    return this.#repository.delete({ ...request, id });
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
  provider: TranslationProviderId,
): string {
  if (value === undefined || value.trim() === "") {
    throw new TypeError(
      name + " is required for the processing profile provider " + provider,
    );
  }
  return value;
}

function staticCapabilities(
  provider: TranslationProviderId,
): TranslationCapabilities {
  switch (provider) {
    case "palabra":
      return PALABRA_TRANSLATION_CAPABILITIES;
    case "openai_native":
      return OPENAI_NATIVE_TRANSLATION_CAPABILITIES;
    case "openai_controlled":
      return OPENAI_CONTROLLED_TRANSLATION_CAPABILITIES;
    default:
      throw new TypeError("Unsupported processing profile provider");
  }
}

type ServiceTransport = "https" | "wss";

interface ServiceExpectation {
  readonly role: ProcessingService["role"];
  readonly provider: ProcessingService["provider"];
  readonly category: ProcessingService["category"];
  readonly model: ProcessingService["model"]["kind"];
  readonly voice: ProcessingService["voice"]["kind"];
}

function profileService(
  profile: ApprovedSessionProcessingProfile,
  expected: ServiceExpectation,
): ProcessingService {
  const service = profile.services.find((candidate) => candidate.role === expected.role);
  if (service === undefined) {
    throw new TypeError("Processing profile is missing the " + expected.role + " service");
  }
  if (
    service.provider !== expected.provider ||
    service.category !== expected.category ||
    service.model.kind !== expected.model ||
    service.voice.kind !== expected.voice
  ) {
    throw new TypeError(
      "Processing profile service " + service.id + " does not match the " +
        profile.translation.provider + " runtime route",
    );
  }
  const endpoint = new URL(service.endpoint.pathTemplate, service.endpoint.origin);
  if (endpoint.protocol !== "https:") {
    throw new TypeError(
      "Processing profile service " + service.id + " must use an HTTPS origin",
    );
  }
  return service;
}

function serviceEndpoint(service: ProcessingService, transport: ServiceTransport): string {
  return resolveApprovedServiceEndpoint(service, transport);
}

const PALABRA_HASH_PLACEHOLDER = "{hash}";
const PALABRA_ROUTE_HASH_SENTINEL = "palabra-route-hash-placeholder";

function canonicalPalabraRoutePath(service: ProcessingService): string {
  if (service.role !== "speech_to_speech") {
    throw new TypeError("Palabra socket route only supports the speech_to_speech service");
  }
  const template = service.endpoint.pathTemplate;
  if (template.split(PALABRA_HASH_PLACEHOLDER).length !== 2) {
    throw new TypeError("Palabra socket route must contain exactly one literal {hash} placeholder");
  }
  const routePath = template.replace(PALABRA_HASH_PLACEHOLDER, PALABRA_ROUTE_HASH_SENTINEL);
  if (routePath.split("/").filter((segment) => segment === PALABRA_ROUTE_HASH_SENTINEL).length !== 1) {
    throw new TypeError("Palabra socket route must use a {hash} path segment");
  }
  return routePath;
}

export function resolveApprovedServiceEndpoint(
  service: ProcessingService,
  transport: ServiceTransport,
): string {
  const template = service.endpoint.pathTemplate;
  const routePath = service.provider === "palabra"
    ? canonicalPalabraRoutePath(service)
    : template;
  const origin = new URL(service.endpoint.origin);
  if (
    origin.protocol !== "https:" ||
    origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
  ) {
    throw new TypeError(
      "Processing profile service " + service.id + " route must use an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  const route = new URL(routePath, origin);
  if (
    route.origin !== origin.origin ||
    route.username || route.password || route.search || route.hash ||
    route.pathname !== routePath
  ) {
    throw new TypeError(
      "Processing profile service " + service.id + " route must remain on its declared origin as a canonical path",
    );
  }
  const expectedOrigin = new URL(origin.toString());
  expectedOrigin.protocol = transport + ":";
  route.protocol = transport + ":";
  if (
    route.protocol !== transport + ":" ||
    route.origin !== expectedOrigin.origin ||
    route.username || route.password || route.search || route.hash
  ) {
    throw new TypeError(
      "Processing profile service " + service.id + " route did not preserve its declared origin during transport conversion",
    );
  }
  return route.origin + template;
}

export function resolvePalabraWebSocketEndpoint(service: ProcessingService): string {
  if (service.provider !== "palabra" || service.role !== "speech_to_speech") {
    throw new TypeError("Only the Palabra speech-to-speech service has a Palabra socket route");
  }
  return resolveApprovedServiceEndpoint(service, "wss");
}

function namedModel(service: ProcessingService): string {
  if (service.model.kind !== "named") {
    throw new TypeError("Processing profile service " + service.id + " must name its model");
  }
  if (service.model.value.trim().length === 0) {
    throw new TypeError("Processing profile service " + service.id + " model must not be empty");
  }
  return service.model.value;
}

function namedVoice(service: ProcessingService): string {
  if (service.voice.kind !== "named") {
    throw new TypeError("Processing profile service " + service.id + " must name its voice");
  }
  if (service.voice.value.trim().length === 0) {
    throw new TypeError("Processing profile service " + service.id + " voice must not be empty");
  }
  return service.voice.value;
}

function assertProfileEvidenceControls(profile: ApprovedSessionProcessingProfile): void {
  const evidence = profile.evidence;
  if (
    evidence.storage !== "local_encrypted_file" ||
    evidence.encryption !== "aes_256_gcm" ||
    evidence.providerEvents !== "final_only" ||
    evidence.provisionalEvents !== "live_only" ||
    evidence.browserEvidenceRefs !== "redacted" ||
    evidence.plaintextExport !== "explicit_owner_acknowledgement"
  ) {
    throw new TypeError("Processing profile evidence controls do not match the local artifact runtime");
  }
}

function assertGlossaryEgressRoute(profile: ApprovedSessionProcessingProfile): void {
  const expectedStages = profile.translation.provider === "openai_controlled"
    ? [
      { role: "transcription", fields: ["source_terms", "aliases"] },
      { role: "text_translation", fields: ["opaque_placeholders"] },
      { role: "tts", fields: ["authorized_target_text"] },
    ]
    : [];
  const expectedHarnessPolicy = profile.translation.provider === "openai_controlled"
    ? "local_pinned"
    : "disallowed";
  if (
    profile.glossaryEgress.harnessPinnedGlossary !== expectedHarnessPolicy ||
    canonicalJsonSha256(profile.glossaryEgress.stages) !== canonicalJsonSha256(expectedStages)
  ) {
    throw new TypeError(
      "Processing profile glossary egress does not match the " +
        profile.translation.provider + " runtime route",
    );
  }
}

function configurationFromProfile(
  profile: ApprovedSessionProcessingProfile,
  capabilities: TranslationCapabilities,
): ConfiguredTranslation {
  const expected = staticCapabilities(profile.translation.provider);
  validateTranslationCapabilities(expected);
  validateTranslationCapabilities(capabilities);
  if (
    capabilities.providerId !== profile.translation.provider ||
    canonicalJsonSha256(capabilities) !== canonicalJsonSha256(expected)
  ) {
    throw new TypeError("Runtime translation capabilities do not match the approved processing profile route");
  }

  const allowedModes = new Set(profile.translation.allowedModes);
  for (const mode of allowedModes) {
    if (mode !== "fast" && mode !== "balanced" && mode !== "accurate") {
      throw new TypeError("Processing profile declares an unsupported translation mode");
    }
  }
  const constrained = Object.freeze({
    ...capabilities,
    modes: Object.freeze(capabilities.modes.map((capability) => {
      if (allowedModes.has(capability.mode)) return capability;
      return Object.freeze({
        ...capability,
        state: "unsupported" as const,
        reason: "This mode is not approved by processing profile " + profile.id + "@" + profile.version,
      });
    })),
  });
  validateTranslationCapabilities(constrained);
  for (const mode of profile.translation.allowedModes) {
    const behavior = resolveTranslationBehavior(mode);
    if (behavior.version !== profile.translation.behaviorVersion) {
      throw new TypeError("Processing profile behavior version does not match " + mode);
    }
    assertTranslationBehaviorCapability(constrained, behavior, { glossaryRequested: false });
  }

  return Object.freeze({
    ...constrained,
    defaultMode: profile.translation.defaultMode,
  });
}

function translationRuntime(
  config: AppConfig,
  profile: ApprovedSessionProcessingProfile,
): TranslationRuntime {
  assertProfileEvidenceControls(profile);
  assertGlossaryEgressRoute(profile);
  let port: TranslationPort;

  switch (profile.translation.provider) {
    case "palabra": {
      const service = profileService(profile, {
        role: "speech_to_speech",
        provider: "palabra",
        category: "managed_realtime_speech_translation",
        model: "vendor_managed",
        voice: "provider_managed",
      });
      const endpoint = resolvePalabraWebSocketEndpoint(service);
      const apiKey = requireServerKey(config.palabraApiKey, "PALABRA_API_KEY", profile.translation.provider);
      port = new PalabraTranslationAdapter({
        apiKey,
        endpoint,
      });
      break;
    }
    case "openai_native": {
      const service = profileService(profile, {
        role: "speech_to_speech",
        provider: "openai",
        category: "managed_realtime_speech_translation",
        model: "named",
        voice: "provider_managed",
      });
      const endpoint = serviceEndpoint(service, "wss");
      const model = namedModel(service);
      if (
        endpoint !== "wss://api.openai.com/v1/realtime/translations" ||
        model !== "gpt-realtime-translate"
      ) {
        throw new TypeError(
          "Processing profile service " + service.id + " does not match the openai_native runtime route",
        );
      }
      const apiKey = requireServerKey(config.openaiApiKey, "OPENAI_API_KEY", profile.translation.provider);
      port = createOpenAITranslationAdapter({
        provider: "openai_native",
        apiKey,
        native: { endpoint, model },
      });
      break;
    }
    case "openai_controlled": {
      const transcribe = profileService(profile, {
        role: "transcription",
        provider: "openai",
        category: "managed_transcription",
        model: "named",
        voice: "not_applicable",
      });
      const text = profileService(profile, {
        role: "text_translation",
        provider: "openai",
        category: "managed_text_translation",
        model: "named",
        voice: "not_applicable",
      });
      const tts = profileService(profile, {
        role: "tts",
        provider: "openai",
        category: "managed_tts",
        model: "named",
        voice: "named",
      });
      const transcribeEndpoint = serviceEndpoint(transcribe, "wss");
      const textEndpoint = serviceEndpoint(text, "https");
      const ttsEndpoint = serviceEndpoint(tts, "https");
      const transcribeModel = namedModel(transcribe);
      const textModel = namedModel(text);
      const ttsModel = namedModel(tts);
      const ttsVoice = namedVoice(tts);
      const apiKey = requireServerKey(
        config.openaiApiKey,
        "OPENAI_API_KEY",
        profile.translation.provider,
      );
      port = createOpenAITranslationAdapter({
        provider: "openai_controlled",
        apiKey,
        controlled: {
          fallback: profile.fallback,
          transcriber: new OpenAILiveTranscribeAdapter({
            apiKey,
            endpoint: transcribeEndpoint,
            model: transcribeModel,
          }),
          translator: new OpenAITextTranslator({
            apiKey,
            endpoint: textEndpoint,
            model: textModel,
          }),
          tts: new OpenAITtsAdapter({
            apiKey,
            endpoint: ttsEndpoint,
            model: ttsModel,
            voice: ttsVoice,
          }),
        },
      });
      break;
    }
  }

  return Object.freeze({
    port,
    configuration: configurationFromProfile(profile, port.capabilities),
  });
}

function minimumFreeBytes(profile: ApprovedSessionProcessingProfile): number {
  const value = BigInt(profile.evidence.minimumFreeBytes);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Processing profile evidence.minimumFreeBytes exceeds the supported safe integer range");
  }
  return Number(value);
}

function evidenceArtifacts(
  config: AppConfig,
  profile: ApprovedSessionProcessingProfile,
): SessionArtifactStore {
  assertProfileEvidenceControls(profile);
  return new SessionArtifactStore({
    archiveDirectory: config.evidence.archiveDirectory,
    keyDirectory: config.evidence.keyDirectory,
    exportDirectory: config.evidence.exportDirectory,
    receiptDirectory: config.evidence.receiptDirectory,
    securityBoundaryDirectory: config.securityDataDirectory,
    strictAncestors: config.strictSecurityAncestors,
    rootKey: config.evidence.rootKey,
    dataOwnerId: config.retentionOwner.id,
    minimumFreeBytes: minimumFreeBytes(profile),
  });
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
  const processingProfile = await loadApprovedSessionProcessingProfile(config.processingProfile);
  const access = createServerAccessControl({
    operatorToken: config.operatorToken,
    retentionOwner: config.retentionOwner,
    evidenceReviewer: config.evidenceReviewer,
  });
  const media = createMediaRuntime({
    profile: config.mediaProfile,
    publicBaseUrl: config.publicBaseUrl,
    access,
  });
  const translation = translationRuntime(config, processingProfile);
  const artifacts = evidenceArtifacts(config, processingProfile);
  const evidenceReview = new EvidenceReview({
    artifacts,
    cursorKey: config.evidence.rootKey,
  });
  const evidence = new HealthTrackedEvidence(artifacts);
  const glossaries = new FileGlossaryRegistry(
    new FileGlossaryRepository({
      directory: config.glossaryDirectory,
      securityBoundaryDirectory: config.securityDataDirectory,
      strictAncestors: config.strictSecurityAncestors,
      rootKey: config.evidence.rootKey,
    }),
  );
  const relay = new ManagedRelay(new ModularGuardedDuplexRelay({
    media: media.port,
    translation: translation.port,
    evidence,
    processingProfile,
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
    processingProfile,
    deploymentBuildSha256: config.deploymentBuildSha256,
    artifacts,
    evidenceReview,
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

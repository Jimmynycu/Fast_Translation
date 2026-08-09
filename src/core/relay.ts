import { randomUUID } from "node:crypto";
import { CANONICAL_AUDIO, destinationForLane, laneFromSource, sourceForLane } from "./audio.js";
import { AsyncQueue } from "./async-queue.js";
import {
  validateEvidenceFinalization,
  validateRecorderPreflightResult,
} from "./evidence-lifecycle.js";
import { GenerationFence } from "./generation-fence.js";
import { compileGlossaryPair, type CompiledGlossary } from "./glossary.js";
import {
  assertParticipantConsentForManifest,
  canonicalJsonSha256,
  validateSessionSpecAgainstProcessingProfile,
} from "./processing-profile.js";
import type { ApprovedSessionProcessingProfile } from "./processing-profile.js";
import { assertTranslationBehaviorCapability } from "./translation-capabilities.js";
import { resolveTranslationBehavior } from "./translation-behavior.js";
import { EVIDENCE_AUDIO_TRACKS } from "./types.js";
import type {
  EvidenceAudioTrack,
  BargeLifecycleStage,
  EvidenceFinalization,
  EvidenceReviewGrant,
  EvidencePort,
  EvidenceRecord,
  EventCursor,
  GuardedDuplexRelay,
  Lane,
  LaneContext,
  MediaIngressEvent,
  MediaPort,
  ParticipantConsentState,
  ParticipantReadiness,
  ParticipantEndpointGrant,
  RelayCommand,
  RecorderArmState,
  RecorderPreflightResult,
  SessionEvent,
  SessionSnapshot,
  SessionSpec,
  SessionStatus,
  Side,
  TranslationEvent,
  TranslationRejectionReason,
  TranslationPort,
  TranslationBehavior,
  TranslationPreparation,
} from "./types.js";

export class RelaySessionError extends Error {
  readonly code:
    | "invalid_command"
    | "invalid_session"
    | "invalid_spec"
    | "session_exists";

  constructor(code: RelaySessionError["code"], message: string) {
    super(message);
    this.name = "RelaySessionError";
    this.code = code;
  }
}

export type EndpointGrantFactory = (
  sessionId: string,
  side: Side,
) => Promise<ParticipantEndpointGrant> | ParticipantEndpointGrant;

export interface GuardedDuplexRelayOptions {
  readonly media: MediaPort;
  readonly translation: TranslationPort;
  readonly evidence: EvidencePort;
  readonly processingProfile: ApprovedSessionProcessingProfile;
  readonly endpointGrant: EndpointGrantFactory;
  readonly createSessionId?: () => string;
  readonly now?: () => number;
  /** Maximum time allowed for one ordinary evidence persist/flush operation. */
  readonly evidenceOperationTimeoutMs?: number;
  /** Maximum time allowed for media/translation closeSession cleanup. */
  readonly adapterCloseTimeoutMs?: number;
  /** Maximum time allowed for the evidence store's terminal finalize call. */
  readonly finalizationTimeoutMs?: number;
  readonly eventHistoryLimit?: number;
  readonly closedSessionHistoryLimit?: number;
}

interface LaneRun {
  readonly generation: number;
  readonly turnId: string;
  readonly input: AsyncQueue<import("./audio.js").AudioFrame>;
  readonly controller: AbortController;
  readonly task: Promise<void>;
}

interface TranscriptAccumulator {
  generation: number;
  segments: Map<string, SegmentRevision>;
}

interface SegmentRevision {
  readonly kind: "source_transcript" | "target_transcript";
  revision: number;
  text: string;
  final: boolean;
}

interface SpeechOnset {
  readonly generation: number;
  readonly startedAtMs: number;
}

interface PlayoutEvidenceCursor {
  readonly generation: number;
  readonly sequence: number;
  readonly timelineAtMonoMs: number;
}

interface PlayoutMetadata {
  readonly turnId: string;
  readonly targetSegmentId: string;
  readonly audioSegmentId: string;
  readonly revision: number;
  readonly playoutSequence: number;
  readonly evidenceRef: string;
  readonly queuedAtMonoMs: number;
}

interface QueueSampleState {
  readonly generation: number;
  readonly depthFrames: number;
  readonly capacityFrames: number;
  readonly oldestQueuedAgeMs: number | undefined;
  readonly bufferedAudioMs: number | undefined;
  readonly emittedAtMonoMs: number;
}

interface PendingPlayoutClear {
  readonly lane: Lane;
  readonly generation: number;
  readonly side: Side;
  readonly clearId: string;
  readonly bargeId: string | undefined;
  readonly sourceSide: Side | undefined;
}

interface PendingBargeResumption {
  readonly bargeId: string;
  readonly clearId: string;
  readonly sourceSide: Side;
  readonly destinationSide: Side;
  readonly generation: number;
}

interface BargeCut {
  readonly bargeId: string;
  readonly sourceSide: Side;
}

const QUEUE_SAMPLE_MIN_INTERVAL_MS = 100;
const MAX_PENDING_QUEUE_TELEMETRY_EVIDENCE = 1;
const MAX_QUEUE_TELEMETRY_STATES = 256;
// Keep separate admission classes: normal ancillary work, control transitions,
// the terminal withdrawal receipt, terminal closing/cut transitions, and the
// authoritative failure alert. Terminal controls must retain their slots even
// when ordinary priority work has filled its smaller budget.
const MAX_PENDING_EVIDENCE_OPERATIONS = 70;
const MAX_NORMAL_EVIDENCE_OPERATIONS = 63;
const MAX_PRIORITY_EVIDENCE_OPERATIONS = 65;
const MAX_WITHDRAWAL_EVIDENCE_OPERATIONS = 66;
const MAX_TERMINAL_EVIDENCE_OPERATIONS = 69;
// Reserve one of the small in-flight command budget for a terminal consent withdrawal.
const MAX_INCOMPLETE_COMMANDS = 16;
const MAX_SETTLED_COMMANDS = 256;
const MAX_PENDING_PLAYOUT_CLEARS = 128;
const MAX_PENDING_PLAYOUT_EVIDENCE_PER_GENERATION = 32;
const ADAPTER_CLEANUP_GRACE_MS = 250;
const DEFAULT_ADAPTER_CLOSE_TIMEOUT_MS = 5_000;
const MIN_ADAPTER_CLOSE_TIMEOUT_MS = ADAPTER_CLEANUP_GRACE_MS;
const MAX_ADAPTER_CLOSE_TIMEOUT_MS = 120_000;
const DEFAULT_EVIDENCE_OPERATION_TIMEOUT_MS = 15_000;
const MIN_EVIDENCE_OPERATION_TIMEOUT_MS = 100;
const MAX_EVIDENCE_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 30_000;
const MIN_FINALIZATION_TIMEOUT_MS = 100;
const MAX_FINALIZATION_TIMEOUT_MS = 120_000;
const MAX_SESSION_OPENED_TERM_IDS = 4_096;

interface AlertMetadata {
  readonly termId?: string;
  readonly confidence?: number;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isLane(value: unknown): value is Lane {
  return value === "A_TO_B" || value === "B_TO_A";
}

function isSide(value: unknown): value is Side {
  return value === "A" || value === "B";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (candidate: unknown): unknown => {
    if (candidate !== null && typeof candidate === "object" && !Object.isFrozen(candidate)) {
      for (const child of Object.values(candidate as Record<string, unknown>)) freeze(child);
      Object.freeze(candidate);
    }
    return candidate;
  };
  return freeze(cloned) as T;
}

/**
 * Resolve a promise with a bounded timeout while releasing the timer as soon
 * as the operation settles. Rejections are intentionally propagated to the
 * caller; callers that historically map failures to a value do so before
 * entering this helper.
 */
function settleWithin<T>(task: Promise<T>, timeoutMs: number, timeoutValue: T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timer = undefined;
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, timeoutMs);
    const clearTimer = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    void task.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimer();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        reject(error);
      },
    );
  });
}

function normalizeTranslationPreparation(value: unknown): TranslationPreparation {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid translation preparation: expected a readiness result");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    candidate.readiness === "local_route_validated" &&
    candidate.remoteConnection === "deferred_until_first_turn"
  ) {
    return Object.freeze({
      readiness: "local_route_validated" as const,
      remoteConnection: "deferred_until_first_turn" as const,
    });
  }
  if (
    candidate.readiness === "remote_task_ready" &&
    candidate.remoteConnection === "connected"
  ) {
    return Object.freeze({
      readiness: "remote_task_ready" as const,
      remoteConnection: "connected" as const,
    });
  }
  if (
    candidate.readiness === "fixture_local" &&
    candidate.remoteConnection === "not_applicable"
  ) {
    return Object.freeze({
      readiness: "fixture_local" as const,
      remoteConnection: "not_applicable" as const,
    });
  }
  throw new Error("Invalid translation preparation: unsupported readiness discriminants");
}

interface CommandExecution {
  readonly fingerprint: string;
  readonly completion: Promise<void>;
  settled: boolean;
}

interface WithdrawalReservation {
  readonly side: Side;
  readonly consentId: string;
  readonly withdrawalId: string;
  readonly event: Promise<SessionEvent | undefined>;
  readonly ending: Promise<void>;
}

interface SessionRuntime {
  readonly sessionId: string;
  readonly spec: SessionSpec;
  readonly behavior: TranslationBehavior;
  readonly compiledGlossary?: CompiledGlossary;
  readonly compiledGlossaries?: Readonly<Record<Lane, CompiledGlossary>>;
  readonly participants: Readonly<{ A: ParticipantEndpointGrant; B: ParticipantEndpointGrant }>;
  readonly connected: Record<Side, boolean>;
  readonly lastParticipantStateAtMonoMs: Record<Side, number | undefined>;
  readonly readinessConnectionStartedAtMonoMs: Record<Side, number | undefined>;
  readonly participantReadiness: Record<Side, ParticipantReadiness | undefined>;
  readonly providerReadiness: Record<Lane, TranslationPreparation | undefined>;
  readonly consent: Record<Side, ParticipantConsentState>;
  recorderArmState: RecorderArmState;
  readonly speaking: Record<Side, boolean>;
  readonly fences: Record<Lane, GenerationFence>;
  readonly laneRuns: Record<Lane, LaneRun | undefined>;
  readonly playout: Record<Side, AsyncQueue<import("./audio.js").AudioFrame>>;
  readonly playoutEvidenceCursors: Record<Side, PlayoutEvidenceCursor | undefined>;
  playoutEvidenceTails: Record<Side, Map<string, Promise<void>>>;
  readonly playoutEvidencePending: Map<string, number>;
  readonly playoutEvidenceBackpressureAlerts: Set<string>;
  readonly sourceEvidenceCursors: Record<Side, PlayoutEvidenceCursor | undefined>;
  readonly subscribers: Set<AsyncQueue<SessionEvent>>;
  readonly events: SessionEvent[];
  readonly commands: Map<string, CommandExecution>;
  incompleteCommandCount: number;
  commandOperationTail: Promise<void>;
  readonly ingressController: AbortController;
  readonly playoutController: AbortController;
  readonly backgroundTasks: Set<Promise<void>>;
  readonly adapterTasks: Set<Promise<void>>;
  readonly firstAudio: Set<string>;
  readonly speechOnsets: Record<Lane, SpeechOnset | undefined>;
  readonly transcripts: Record<Lane, TranscriptAccumulator>;
  readonly pendingFrames: Record<Lane, import("./audio.js").AudioFrame[]>;
  readonly playoutSequences: Record<Lane, { generation: number; sequence: number } | undefined>;
  readonly playoutMetadata: Map<string, PlayoutMetadata>;
  readonly playoutMetadataOrder: Record<Lane, string[]>;
  readonly playedSegments: Set<string>;
  readonly queueTelemetry: Map<string, QueueSampleState>;
  pendingQueueTelemetryEvidence: number;
  readonly pendingPlayoutClears: Map<string, PendingPlayoutClear>;
  readonly pendingPlayoutClearOrder: string[];
  readonly pendingBargeResumptions: Record<Lane, PendingBargeResumption | undefined>;
  status: SessionStatus;
  cursor: EventCursor;
  openedAtMs: number;
  closedAtMs: number | undefined;
  recorderPreflight: RecorderPreflightResult | undefined;
  evidenceFinalization: EvidenceFinalization | undefined;
  endTask: Promise<void> | undefined;
  withdrawalReservation: WithdrawalReservation | undefined;
  providerPreparationTask: Promise<void> | undefined;
  lastPersistedEventCursor: EventCursor;
  evidenceFailureStarted: boolean;
  pendingEvidenceOperations: number;
  evidenceOperationTail: Promise<void>;
  evidenceRecordTail: Promise<void>;
  controlStatus: SessionStatus | undefined;
  ingressStopped: boolean;
}

function normalizedEvidenceReviewIdentity(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new RelaySessionError("invalid_spec", `${field} must be a string`);
  }
  const normalized = value.normalize("NFC").trim();
  if (normalized.length === 0 || normalized.length > 128) {
    throw new RelaySessionError(
      "invalid_spec",
      `${field} must contain 1-128 non-whitespace characters after normalization`,
    );
  }
  return normalized;
}

function freezeEvidenceReviewGrant(value: unknown): EvidenceReviewGrant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RelaySessionError("invalid_spec", "evidenceReviewGrant is required");
  }
  const candidate = value as Readonly<{
    readonly dataOwnerId?: unknown;
    readonly bilingualReviewerId?: unknown;
  }>;
  const dataOwnerId = normalizedEvidenceReviewIdentity(candidate.dataOwnerId, "dataOwnerId");
  const bilingualReviewerId = normalizedEvidenceReviewIdentity(
    candidate.bilingualReviewerId,
    "bilingualReviewerId",
  );
  if (dataOwnerId === bilingualReviewerId) {
    throw new RelaySessionError(
      "invalid_spec",
      "dataOwnerId and bilingualReviewerId must be distinct after normalization",
    );
  }
  return Object.freeze({ dataOwnerId, bilingualReviewerId });
}

function freezeSessionSpec(spec: SessionSpec): SessionSpec {
  if (spec.sideA.language.trim().length === 0 || spec.sideB.language.trim().length === 0) {
    throw new RelaySessionError("invalid_spec", "Both participant languages are required");
  }
  if (
    spec.maxQueueFrames !== undefined &&
    (!Number.isSafeInteger(spec.maxQueueFrames) || spec.maxQueueFrames < 1)
  ) {
    throw new RelaySessionError("invalid_spec", "maxQueueFrames must be a positive safe integer");
  }

  const glossary =
    spec.glossary === undefined
      ? undefined
      : Object.freeze({
          ...spec.glossary,
          entries: Object.freeze(
            spec.glossary.entries.map((entry) =>
              Object.freeze({ ...entry, aliases: Object.freeze([...entry.aliases]) }),
            ),
          ),
        });
  const evidenceReviewGrant = freezeEvidenceReviewGrant(spec.evidenceReviewGrant);

  return Object.freeze({
    sideA: Object.freeze({ ...spec.sideA, language: spec.sideA.language.trim() }),
    sideB: Object.freeze({ ...spec.sideB, language: spec.sideB.language.trim() }),
    provider: spec.provider,
    mode: spec.mode,
    processingManifest: spec.processingManifest,
    evidenceReviewGrant,
    ...(glossary === undefined ? {} : { glossary }),
    ...(spec.maxQueueFrames === undefined ? {} : { maxQueueFrames: spec.maxQueueFrames }),
  });
}

function queueCapacity(spec: SessionSpec, behavior: TranslationBehavior): number {
  return spec.maxQueueFrames ?? Math.ceil(behavior.maxBufferedAudioMs / CANONICAL_AUDIO.frameDurationMs);
}

function laneLanguages(spec: SessionSpec, lane: Lane): Readonly<{
  sourceLanguage: string;
  targetLanguage: string;
}> {
  return lane === "A_TO_B"
    ? { sourceLanguage: spec.sideA.language, targetLanguage: spec.sideB.language }
    : { sourceLanguage: spec.sideB.language, targetLanguage: spec.sideA.language };
}

interface SessionGlossaries {
  readonly primary: CompiledGlossary;
  readonly byLane: Readonly<Record<Lane, CompiledGlossary>>;
}

function normalizedLanguage(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function compileSessionGlossaries(spec: SessionSpec): SessionGlossaries | undefined {
  if (spec.glossary === undefined) return undefined;

  let primary: CompiledGlossary;
  let reverse: CompiledGlossary;
  try {
    const pair = compileGlossaryPair(spec.glossary);
    primary = pair.forward;
    reverse = pair.reverse;
  } catch (error: unknown) {
    throw new RelaySessionError(
      "invalid_spec",
      "Glossary compilation failed: " +
        (error instanceof Error ? error.message : "unknown glossary error"),
    );
  }

  const aToB = laneLanguages(spec, "A_TO_B");
  const primaryIsAToB =
    normalizedLanguage(primary.sourceLanguage) === normalizedLanguage(aToB.sourceLanguage) &&
    normalizedLanguage(primary.targetLanguage) === normalizedLanguage(aToB.targetLanguage);
  const primaryIsBToA =
    normalizedLanguage(primary.sourceLanguage) === normalizedLanguage(aToB.targetLanguage) &&
    normalizedLanguage(primary.targetLanguage) === normalizedLanguage(aToB.sourceLanguage);
  if (!primaryIsAToB && !primaryIsBToA) {
    throw new RelaySessionError(
      "invalid_spec",
      "Glossary languages must match the configured participant language pair",
    );
  }

  return Object.freeze({
    primary,
    byLane: Object.freeze(primaryIsAToB
      ? { A_TO_B: primary, B_TO_A: reverse }
      : { A_TO_B: reverse, B_TO_A: primary }),
  });
}

function sourceTrack(side: Side): EvidenceAudioTrack {
  return side === "A" ? "source_a" : "source_b";
}

function playoutTrack(side: Side): EvidenceAudioTrack {
  return side === "A" ? "playout_to_a" : "playout_to_b";
}

function oppositeInboundLane(side: Side): Lane {
  return side === "A" ? "B_TO_A" : "A_TO_B";
}

export class ModularGuardedDuplexRelay implements GuardedDuplexRelay {
  readonly #media: MediaPort;
  readonly #translation: TranslationPort;
  readonly #evidence: EvidencePort;
  readonly #processingProfile: ApprovedSessionProcessingProfile;
  readonly #endpointGrant: EndpointGrantFactory;
  readonly #createSessionId: () => string;
  readonly #now: () => number;
  readonly #adapterCloseTimeoutMs: number;
  readonly #evidenceOperationTimeoutMs: number;
  readonly #finalizationTimeoutMs: number;
  readonly #eventHistoryLimit: number;
  readonly #closedSessionHistoryLimit: number;
  readonly #closedSessionIds: string[] = [];
  readonly #sessions = new Map<string, SessionRuntime>();

  constructor(options: GuardedDuplexRelayOptions) {
    this.#media = options.media;
    this.#translation = options.translation;
    this.#evidence = options.evidence;
    this.#processingProfile = options.processingProfile;
    this.#endpointGrant = options.endpointGrant;
    this.#createSessionId = options.createSessionId ?? randomUUID;
    this.#now = options.now ?? (() => performance.now());
    this.#adapterCloseTimeoutMs = options.adapterCloseTimeoutMs ?? DEFAULT_ADAPTER_CLOSE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#adapterCloseTimeoutMs) ||
      this.#adapterCloseTimeoutMs < MIN_ADAPTER_CLOSE_TIMEOUT_MS ||
      this.#adapterCloseTimeoutMs > MAX_ADAPTER_CLOSE_TIMEOUT_MS
    ) {
      throw new RangeError(
        `adapterCloseTimeoutMs must be a safe integer between ${MIN_ADAPTER_CLOSE_TIMEOUT_MS} and ${MAX_ADAPTER_CLOSE_TIMEOUT_MS}`,
      );
    }
    this.#evidenceOperationTimeoutMs = options.evidenceOperationTimeoutMs ?? DEFAULT_EVIDENCE_OPERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#evidenceOperationTimeoutMs) ||
      this.#evidenceOperationTimeoutMs < MIN_EVIDENCE_OPERATION_TIMEOUT_MS ||
      this.#evidenceOperationTimeoutMs > MAX_EVIDENCE_OPERATION_TIMEOUT_MS
    ) {
      throw new RangeError(
        `evidenceOperationTimeoutMs must be a safe integer between ${MIN_EVIDENCE_OPERATION_TIMEOUT_MS} and ${MAX_EVIDENCE_OPERATION_TIMEOUT_MS}`,
      );
    }
    this.#finalizationTimeoutMs = options.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#finalizationTimeoutMs) ||
      this.#finalizationTimeoutMs < MIN_FINALIZATION_TIMEOUT_MS ||
      this.#finalizationTimeoutMs > MAX_FINALIZATION_TIMEOUT_MS
    ) {
      throw new RangeError(
        `finalizationTimeoutMs must be a safe integer between ${MIN_FINALIZATION_TIMEOUT_MS} and ${MAX_FINALIZATION_TIMEOUT_MS}`,
      );
    }
    this.#eventHistoryLimit = options.eventHistoryLimit ?? 10_000;
    if (!Number.isSafeInteger(this.#eventHistoryLimit) || this.#eventHistoryLimit < 100) {
      throw new RangeError("eventHistoryLimit must be a safe integer of at least 100");
    }
    this.#closedSessionHistoryLimit = options.closedSessionHistoryLimit ?? 20;
    if (!Number.isSafeInteger(this.#closedSessionHistoryLimit) || this.#closedSessionHistoryLimit < 1) {
      throw new RangeError("closedSessionHistoryLimit must be a positive safe integer");
    }
  }

  async open(specInput: SessionSpec): Promise<SessionSnapshot> {
    let spec: SessionSpec;
    try {
      const processingManifest = validateSessionSpecAgainstProcessingProfile(
        specInput,
        this.#processingProfile,
      );
      spec = freezeSessionSpec({ ...specInput, processingManifest });
    } catch (error: unknown) {
      if (error instanceof RelaySessionError) throw error;
      throw new RelaySessionError(
        "invalid_spec",
        error instanceof Error ? error.message : "Invalid session processing manifest",
      );
    }
    const behavior = resolveTranslationBehavior(spec.mode);
    const inputCapacity = queueCapacity(spec, behavior);
    this.#validateTranslationSpec(spec, behavior);
    const sessionId = this.#createSessionId();
    if (this.#sessions.has(sessionId)) {
      throw new RelaySessionError("session_exists", `Session ${sessionId} already exists`);
    }

    const sessionGlossaries = compileSessionGlossaries(spec);
    const [participantA, participantB] = await Promise.all([
      this.#endpointGrant(sessionId, "A"),
      this.#endpointGrant(sessionId, "B"),
    ]);
    if (participantA.side !== "A" || participantB.side !== "B") {
      throw new RelaySessionError("invalid_spec", "Endpoint grants were returned for the wrong side");
    }

    const openedAtMs = this.#now();
    const runtime: SessionRuntime = {
      sessionId,
      spec,
      behavior,
      ...(sessionGlossaries === undefined
        ? {}
        : {
            compiledGlossary: sessionGlossaries.primary,
            compiledGlossaries: sessionGlossaries.byLane,
          }),
      participants: Object.freeze({ A: Object.freeze(participantA), B: Object.freeze(participantB) }),
      connected: { A: false, B: false },
      lastParticipantStateAtMonoMs: { A: undefined, B: undefined },
      readinessConnectionStartedAtMonoMs: { A: undefined, B: undefined },
      participantReadiness: { A: undefined, B: undefined },
      providerReadiness: { A_TO_B: undefined, B_TO_A: undefined },
      consent: {
        A: Object.freeze({ consented: false, recording: false, processing: false }),
        B: Object.freeze({ consented: false, recording: false, processing: false }),
      },
      recorderArmState: "awaiting_consents",
      speaking: { A: false, B: false },
      fences: { A_TO_B: new GenerationFence(), B_TO_A: new GenerationFence() },
      laneRuns: { A_TO_B: undefined, B_TO_A: undefined },
      playout: {
        A: new AsyncQueue(inputCapacity),
        B: new AsyncQueue(inputCapacity),
      },
      playoutEvidenceCursors: { A: undefined, B: undefined },
      playoutEvidenceTails: { A: new Map(), B: new Map() },
      playoutEvidencePending: new Map(),
      playoutEvidenceBackpressureAlerts: new Set(),
      sourceEvidenceCursors: { A: undefined, B: undefined },
      subscribers: new Set(),
      events: [],
      commands: new Map(),
      incompleteCommandCount: 0,
      commandOperationTail: Promise.resolve(),
      ingressController: new AbortController(),
      playoutController: new AbortController(),
      backgroundTasks: new Set(),
      adapterTasks: new Set(),
      firstAudio: new Set(),
      speechOnsets: { A_TO_B: undefined, B_TO_A: undefined },
      transcripts: {
        A_TO_B: { generation: 0, segments: new Map() },
        B_TO_A: { generation: 0, segments: new Map() },
      },
      pendingFrames: { A_TO_B: [], B_TO_A: [] },
      playoutSequences: { A_TO_B: undefined, B_TO_A: undefined },
      playoutMetadata: new Map(),
      playoutMetadataOrder: { A_TO_B: [], B_TO_A: [] },
      playedSegments: new Set(),
      queueTelemetry: new Map(),
      pendingQueueTelemetryEvidence: 0,
      pendingPlayoutClears: new Map(),
      pendingPlayoutClearOrder: [],
      pendingBargeResumptions: { A_TO_B: undefined, B_TO_A: undefined },
      status: "waiting",
      cursor: 0,
      openedAtMs,
      closedAtMs: undefined,
      recorderPreflight: undefined,
      evidenceFinalization: undefined,
      endTask: undefined,
      withdrawalReservation: undefined,
      providerPreparationTask: undefined,
      lastPersistedEventCursor: 0,
      evidenceFailureStarted: false,
      pendingEvidenceOperations: 0,
      evidenceOperationTail: Promise.resolve(),
      evidenceRecordTail: Promise.resolve(),
      controlStatus: undefined,
      ingressStopped: false,
    };
    this.#sessions.set(sessionId, runtime);

    const snapshot = this.#snapshot(runtime);
    const openedEvent = await this.#emit(
      runtime,
      { type: "session_opened", snapshot },
      null,
      null,
      true,
      undefined,
      false,
      false,
      this.#sessionOpenedEvidenceProjection(runtime, snapshot),
    );
    if (openedEvent === undefined || runtime.evidenceFailureStarted) {
      throw new Error("Evidence rejected session opened event");
    }
    if (runtime.status === "closing" || runtime.status === "closed") {
      return this.#snapshot(runtime);
    }
    this.#trackBackground(runtime, this.#runIngress(runtime));
    this.#trackBackground(runtime, this.#runPlayout(runtime, "A"));
    this.#trackBackground(runtime, this.#runPlayout(runtime, "B"));
    return this.#snapshot(runtime);
  }

  #validateTranslationSpec(spec: SessionSpec, behavior: TranslationBehavior): void {
    const capabilities = this.#translation.capabilities;
    if (capabilities.providerId !== spec.provider) {
      throw new RelaySessionError("invalid_spec", "The selected provider does not match the translation port");
    }
    try {
      assertTranslationBehaviorCapability(capabilities, behavior, {
        glossaryRequested: spec.glossary !== undefined,
      });
    } catch (error: unknown) {
      throw new RelaySessionError(
        "invalid_spec",
        error instanceof Error
          ? error.message
          : "The translation port does not satisfy the selected mode requirements",
      );
    }
  }

  #sessionOpenedEvidenceProjection(
    runtime: SessionRuntime,
    snapshot: SessionSnapshot,
  ): Readonly<Record<string, unknown>> {
    const glossary = runtime.compiledGlossary === undefined
      ? undefined
      : Object.freeze({
          version: runtime.compiledGlossary.version,
          hash: runtime.compiledGlossary.hash,
          termIds: Object.freeze([
            ...new Set(runtime.compiledGlossary.entries.map((entry) => entry.id)),
          ].slice(0, MAX_SESSION_OPENED_TERM_IDS)),
        });
    return Object.freeze({
      type: "session_opened",
      snapshot: Object.freeze({
        sessionId: snapshot.sessionId,
        status: snapshot.status,
        spec: Object.freeze({
          sideA: Object.freeze({ language: snapshot.spec.sideA.language }),
          sideB: Object.freeze({ language: snapshot.spec.sideB.language }),
          provider: snapshot.spec.provider,
          mode: snapshot.spec.mode,
          processingManifest: snapshot.spec.processingManifest,
          evidenceReviewGrant: snapshot.spec.evidenceReviewGrant,
          ...(snapshot.spec.maxQueueFrames === undefined
            ? {}
            : { maxQueueFrames: snapshot.spec.maxQueueFrames }),
          ...(glossary === undefined ? {} : { glossary }),
        }),
        ...(glossary === undefined ? {} : { glossary }),
      }),
    });
  }

  snapshot(sessionId: string): SessionSnapshot {
    return this.#snapshot(this.#requireSession(sessionId));
  }

  #trackBackground(runtime: SessionRuntime, task: Promise<void>): void {
    runtime.backgroundTasks.add(task);
    void task.then(
      () => runtime.backgroundTasks.delete(task),
      () => runtime.backgroundTasks.delete(task),
    );
  }

  #trackAdapterTask(runtime: SessionRuntime, task: Promise<void>): void {
    runtime.adapterTasks.add(task);
    void task.then(
      () => runtime.adapterTasks.delete(task),
      () => runtime.adapterTasks.delete(task),
    );
  }

  async command(sessionId: string, command: RelayCommand): Promise<void> {
    const runtime = this.#requireSession(sessionId);
    if (command.commandId.trim().length === 0) {
      throw new RelaySessionError("invalid_command", "commandId is required");
    }
    const fingerprint = this.#commandFingerprint(command);
    const existing = runtime.commands.get(command.commandId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new RelaySessionError(
          "invalid_command",
          "commandId cannot be reused for a different command",
        );
      }
      await existing.completion;
      return;
    }

    const priorityWithdrawal = command.type === "participant_consent_withdrawal";
    const priorityEnd = command.type === "end";
    const priorityTerminal = priorityWithdrawal || priorityEnd;
    if (priorityWithdrawal) {
      const replay = this.#withdrawalReplay(runtime, command);
      if (replay !== undefined) {
        const completion = this.#completeWithdrawalReservation(replay);
        const execution: CommandExecution = { fingerprint, completion, settled: false };
        runtime.commands.set(command.commandId, execution);
        void completion.then(
          () => {
            execution.settled = true;
            this.#evictSettledCommands(runtime);
          },
          () => {
            execution.settled = true;
            this.#evictSettledCommands(runtime);
          },
        );
        try {
          await completion;
        } catch (error: unknown) {
          if (runtime.commands.get(command.commandId)?.completion === completion) {
            runtime.commands.delete(command.commandId);
          }
          throw error;
        }
        return;
      }
    }
    const admissionLimit = priorityTerminal
      ? MAX_INCOMPLETE_COMMANDS
      : MAX_INCOMPLETE_COMMANDS - 1;
    if (runtime.incompleteCommandCount >= admissionLimit) {
      throw new RelaySessionError("invalid_command", "Session command queue is busy");
    }
    const priorCommandTail = runtime.commandOperationTail;
    const completion = priorityWithdrawal
      ? this.#completeWithdrawalReservation(this.#reserveWithdrawal(runtime, command))
      : priorityEnd
        ? this.#end(runtime, command.commandId, command.reason ?? "operator_end")
        : priorCommandTail.then(() => this.#applyCommand(runtime, command));
    runtime.incompleteCommandCount += 1;
    const execution: CommandExecution = { fingerprint, completion, settled: false };
    void completion.then(
      () => {
        runtime.incompleteCommandCount -= 1;
        execution.settled = true;
        this.#evictSettledCommands(runtime);
      },
      () => {
        runtime.incompleteCommandCount -= 1;
        execution.settled = true;
        this.#evictSettledCommands(runtime);
      },
    );
    runtime.commandOperationTail = priorityTerminal
      ? Promise.all([
          priorCommandTail.then(() => undefined, () => undefined),
          completion.then(() => undefined, () => undefined),
        ]).then(() => undefined)
      : completion.then(
          () => undefined,
          () => undefined,
        );
    runtime.commands.set(command.commandId, execution);
    try {
      await completion;
    } catch (error: unknown) {
      if (runtime.commands.get(command.commandId)?.completion === completion) {
        runtime.commands.delete(command.commandId);
      }
      throw error;
    }
  }

  #commandFingerprint(command: RelayCommand): string {
    switch (command.type) {
      case "end":
        return command.type + "\u0000" + (command.reason ?? "");
      case "participant_consent":
        return [
          command.type,
          command.side,
          command.consentId,
          canonicalJsonSha256(command.consentPolicyRef),
          command.recording,
          command.processing,
        ].join("\u0000");
      case "participant_consent_withdrawal":
        return [
          command.type,
          command.side,
          command.consentId,
          command.withdrawalId,
        ].join("\u0000");
      default:
        return command.type;
    }
  }

  #withdrawalReplay(
    runtime: SessionRuntime,
    command: Extract<RelayCommand, { type: "participant_consent_withdrawal" }>,
  ): WithdrawalReservation | undefined {
    const reservation = runtime.withdrawalReservation;
    if (reservation === undefined || command.side !== "A" && command.side !== "B") return undefined;
    if (
      reservation.side !== command.side ||
      reservation.consentId !== command.consentId ||
      reservation.withdrawalId !== command.withdrawalId
    ) return undefined;
    const consent = runtime.consent[command.side];
    if (
      consent.consentId === command.consentId &&
      consent.withdrawalId === command.withdrawalId
    ) {
      return reservation;
    }
    return undefined;
  }

  #evictSettledCommands(runtime: SessionRuntime): void {
    if (runtime.commands.size <= MAX_SETTLED_COMMANDS) return;
    for (const [commandId, execution] of runtime.commands) {
      if (!execution.settled) continue;
      runtime.commands.delete(commandId);
      if (runtime.commands.size <= MAX_SETTLED_COMMANDS) return;
    }
  }

  async #applyCommand(runtime: SessionRuntime, command: RelayCommand): Promise<void> {
    if (runtime.endTask !== undefined && command.type !== "end") {
      throw this.#invalidState(runtime, `run ${command.type} on`);
    }
    switch (command.type) {
      case "start":
        if (runtime.status !== "ready" || !this.#hasReadyPrerequisites(runtime)) {
          throw this.#invalidState(runtime, "start");
        }
        await this.#setStatus(runtime, "active", command.commandId);
        return;
      case "pause":
        if (runtime.status !== "active") {
          throw this.#invalidState(runtime, "pause");
        }
        const pausedEvent = this.#beginControlStatus(runtime, "paused", command.commandId);
        this.#cutLane(runtime, "A_TO_B", "pause");
        this.#cutLane(runtime, "B_TO_A", "pause");
        if ((await pausedEvent) === undefined && !runtime.evidenceFailureStarted) {
          throw new Error("Evidence rejected session state event");
        }
        return;
      case "resume":
        if (runtime.status !== "paused" || !this.#hasReadyPrerequisites(runtime)) {
          throw this.#invalidState(runtime, "resume");
        }
        const resumedEvent = this.#beginControlStatus(runtime, "active", command.commandId);
        if ((await resumedEvent) === undefined && !runtime.evidenceFailureStarted) {
          throw new Error("Evidence rejected session state event");
        }
        return;
      case "end":
        await this.#end(runtime, command.commandId, command.reason ?? "operator_end");
        return;
      case "participant_consent":
        if (runtime.status !== "waiting" && runtime.status !== "ready") {
          throw this.#invalidState(runtime, "record participant consent for");
        }
        if (command.side !== "A" && command.side !== "B") {
          throw new RelaySessionError("invalid_command", "Participant consent side must be A or B");
        }
        if (command.consentId.trim().length === 0) {
          throw new RelaySessionError("invalid_command", "Participant consentId is required");
        }
        if (command.recording !== true || command.processing !== true) {
          throw new RelaySessionError(
            "invalid_command",
            "Participant consent must accept recording and processing",
          );
        }
        try {
          assertParticipantConsentForManifest(command, runtime.spec.processingManifest);
        } catch (error: unknown) {
          throw new RelaySessionError(
            "invalid_command",
            error instanceof Error ? error.message : "Participant consent policy is invalid",
          );
        }
        const priorConsent = runtime.consent[command.side];
        if (priorConsent.consented) {
          if (priorConsent.consentId === command.consentId) return;
          throw new RelaySessionError(
            "invalid_command",
            `Participant ${command.side} consent is immutable`,
          );
        }
        const acceptedAtMonoMs = this.#now();
        const acceptedConsent = Object.freeze({
          consented: true,
          consentId: command.consentId,
          consentPolicyRef: command.consentPolicyRef,
          recording: command.recording,
          processing: command.processing,
        });
        const consentEvent = await this.#emit(runtime, {
          type: "participant_consent",
          side: command.side,
          consentId: command.consentId,
          consentPolicyRef: command.consentPolicyRef,
          recording: command.recording,
          processing: command.processing,
          acceptedAtMonoMs,
        }, null, null, true, () => {
          runtime.consent[command.side] = acceptedConsent;
        });
        if (consentEvent === undefined || runtime.evidenceFailureStarted) {
          throw new Error("Evidence rejected participant consent event");
        }
        if (this.#hasAllConsents(runtime)) await this.#setRecorderArmState(runtime, "unarmed");
        await this.#updateReadiness(runtime);
        return;
      case "participant_consent_withdrawal": {
        await this.#completeWithdrawalReservation(this.#reserveWithdrawal(runtime, command));
        return;
      }
      case "arm_recorder":
        if (
          runtime.status !== "waiting" ||
          runtime.recorderArmState !== "unarmed" ||
          !this.#hasAllConsents(runtime) ||
          !runtime.connected.A ||
          !runtime.connected.B
        ) {
          throw this.#invalidState(runtime, "arm the recorder for");
        }
        await this.#setRecorderArmState(runtime, "arming");
        try {
          const preflightRequest = Object.freeze({
            sessionId: runtime.sessionId,
            processingManifestSha256: runtime.spec.processingManifest.manifestSha256,
            checkedAtMonoMs: this.#now(),
          });
          let preflight: RecorderPreflightResult;
          try {
            const preflightResult = await this.#valueBounded(
              this.#evidence.preflightRecorder(preflightRequest),
              this.#evidenceOperationTimeoutMs,
            );
            if (!preflightResult.ok || preflightResult.value === undefined) {
              throw new Error("Recorder preflight timed out");
            }
            preflight = preflightResult.value;
            validateRecorderPreflightResult(preflight);
            if (
              preflight.sessionId !== runtime.sessionId ||
              preflight.processingManifestSha256 !== runtime.spec.processingManifest.manifestSha256
            ) {
              throw new Error("Recorder preflight does not match the active processing manifest");
            }
          } catch {
            this.#failEvidence(runtime);
            throw new Error("Recorder preflight failed");
          }
          const publishedPreflight = cloneAndFreeze(preflight);
          try {
            await this.#persistEvidence(runtime, {
              type: "recorder_preflight",
              sessionId: runtime.sessionId,
              timestampMonoMs: this.#now(),
              preflight: publishedPreflight,
            });
          } catch {
            throw new Error("Evidence rejected recorder preflight record");
          }
          const preflightEvent = await this.#emit(
            runtime,
            { type: "recorder_preflight", preflight: publishedPreflight },
            null,
            null,
            true,
            () => {
              runtime.recorderPreflight = publishedPreflight;
            },
          );
          if (preflightEvent === undefined || runtime.evidenceFailureStarted) {
            throw new Error("Evidence rejected recorder preflight event");
          }
          if (preflight.status !== "ready") {
            this.#failEvidence(runtime);
            throw new Error("Recorder preflight failed");
          }
          const armedAtMonoMs = this.#now();
          for (const track of EVIDENCE_AUDIO_TRACKS) {
            try {
              await this.#persistEvidence(runtime, {
                type: "recorder_track_armed",
                sessionId: runtime.sessionId,
                track,
                armedAtMonoMs,
                consentPolicyRef: runtime.spec.processingManifest.consentPolicyRef,
              });
            } catch {
              throw new Error("Evidence rejected recorder arm records");
            }
          }
          try {
            const flushResult = await this.#valueBounded(
              this.#evidence.flush(runtime.sessionId),
              this.#evidenceOperationTimeoutMs,
            );
            if (!flushResult.ok) throw new Error("Recorder flush timed out");
          } catch {
            this.#failEvidence(runtime);
            throw new Error("recorder flush failed");
          }
          if (
            runtime.status !== "waiting" ||
            !this.#isRecorderArming(runtime) ||
            !this.#hasAllConsents(runtime) ||
            !runtime.connected.A ||
            !runtime.connected.B
          ) {
            throw this.#invalidState(runtime, "complete recorder arming for");
          }
          await this.#setRecorderArmState(runtime, "armed");
          await this.#updateReadiness(runtime);
        } catch (error: unknown) {
          if (
            runtime.status === "waiting" &&
            this.#isRecorderArming(runtime) &&
            !runtime.evidenceFailureStarted
          ) {
            await this.#setRecorderArmState(runtime, "failed");
          }
          throw error;
        }
        return;
    }
  }

  #reserveWithdrawal(
    runtime: SessionRuntime,
    command: Extract<RelayCommand, { type: "participant_consent_withdrawal" }>,
  ): WithdrawalReservation | undefined {
    if (command.side !== "A" && command.side !== "B") {
      throw new RelaySessionError("invalid_command", "Participant withdrawal side must be A or B");
    }
    if (command.consentId.trim().length === 0) {
      throw new RelaySessionError("invalid_command", "Participant withdrawal consentId is required");
    }
    if (command.withdrawalId.trim().length === 0) {
      throw new RelaySessionError("invalid_command", "Participant withdrawalId is required");
    }
    if (!Number.isFinite(command.withdrawnAtMonoMs) || command.withdrawnAtMonoMs < 0) {
      throw new RelaySessionError("invalid_command", "Participant withdrawnAtMonoMs must be non-negative");
    }
    const activeReservation = runtime.withdrawalReservation;
    if (activeReservation !== undefined) {
      if (this.#withdrawalReplay(runtime, command) !== undefined) return activeReservation;
      throw new RelaySessionError(
        "invalid_command",
        "A participant consent withdrawal is already in progress",
      );
    }
    const priorConsent = runtime.consent[command.side];
    if (priorConsent.consentId !== command.consentId) {
      throw new RelaySessionError("invalid_command", `Participant ${command.side} consentId does not match`);
    }
    if (priorConsent.withdrawalId !== undefined) {
      if (priorConsent.withdrawalId === command.withdrawalId) return runtime.withdrawalReservation;
      throw new RelaySessionError(
        "invalid_command",
        `Participant ${command.side} withdrawal is immutable`,
      );
    }
    if (!priorConsent.consented) {
      throw new RelaySessionError("invalid_command", `Participant ${command.side} has not consented`);
    }
    if (priorConsent.consentPolicyRef === undefined) {
      throw new RelaySessionError("invalid_command", `Participant ${command.side} consent policy is missing`);
    }
    if (runtime.status === "closing" || runtime.status === "closed") {
      throw this.#invalidState(runtime, "withdraw participant consent for");
    }

    runtime.consent[command.side] = Object.freeze({
      consented: false,
      consentId: priorConsent.consentId,
      consentPolicyRef: priorConsent.consentPolicyRef,
      recording: false,
      processing: false,
      withdrawalId: command.withdrawalId,
      withdrawnAtMonoMs: command.withdrawnAtMonoMs,
    });
    runtime.speaking.A = false;
    runtime.speaking.B = false;
    const event = this.#emit(runtime, {
      type: "participant_consent_withdrawal",
      side: command.side,
      consentId: command.consentId,
      withdrawalId: command.withdrawalId,
      withdrawnAtMonoMs: command.withdrawnAtMonoMs,
      terminal: true,
    }, null, null, true, undefined, false, true, undefined, true);
    const ending = this.#end(runtime, command.commandId, "participant_consent_withdrawal");
    void ending.catch(() => {});
    const reservation = Object.freeze({
      side: command.side,
      consentId: command.consentId,
      withdrawalId: command.withdrawalId,
      event,
      ending,
    });
    runtime.withdrawalReservation = reservation;
    return reservation;
  }

  async #completeWithdrawalReservation(reservation: WithdrawalReservation | undefined): Promise<void> {
    if (reservation === undefined) return;
    const event = await reservation.event;
    if (event === undefined) {
      throw new Error("Evidence rejected participant consent withdrawal event");
    }
    await reservation.ending;
  }

  events(
    sessionId: string,
    after: EventCursor = 0,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const runtime = this.#requireSession(sessionId);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new RelaySessionError("invalid_command", "Event cursor must be a non-negative safe integer");
    }
    return this.#eventStream(runtime, after, signal);
  }

  async *#eventStream(
    runtime: SessionRuntime,
    after: number,
    signal?: AbortSignal,
  ): AsyncIterable<SessionEvent> {
    const queue = new AsyncQueue<SessionEvent>(this.#eventHistoryLimit);
    const onAbort = (): void => {
      queue.close();
    };
    if (signal?.aborted) return;
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for (const event of runtime.events) {
        if (signal?.aborted) return;
        if (event.cursor > after && !queue.offer(event)) break;
      }
      if (runtime.status !== "closed" && !signal?.aborted) runtime.subscribers.add(queue);
      else queue.close();

      for await (const event of queue) {
        if (signal?.aborted) return;
        yield event;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      runtime.subscribers.delete(queue);
      queue.close();
    }
  }

  async #runIngress(runtime: SessionRuntime): Promise<void> {
    try {
      for await (const event of this.#media.frames({
        sessionId: runtime.sessionId,
        signal: runtime.ingressController.signal,
      })) {
        await this.#handleIngress(runtime, event);
      }
    } catch {
      if (!runtime.ingressController.signal.aborted) {
        this.#emitAlert(runtime, null, null, "media_ingress_failed", "Media ingress adapter failed", true);
      }
    }
  }

  async #handleIngress(runtime: SessionRuntime, event: MediaIngressEvent): Promise<void> {
    if (
      (runtime.ingressStopped && event.type !== "participant_state" && event.type !== "participant_readiness") ||
      runtime.status === "closing" ||
      runtime.status === "closed"
    ) return;
    if ("side" in event && !isSide((event as { readonly side?: unknown }).side)) {
      this.#emitAlert(runtime, null, null, "invalid_media_side", "Rejected media with an invalid participant side", false);
      return;
    }
    if (event.sessionId !== runtime.sessionId) {
      this.#emitAlert(runtime, null, null, "wrong_session_media", "Rejected media for another session", false);
      return;
    }
    if (
      (event.type === "participant_state" || event.type === "participant_readiness") &&
      (!isSide(event.side) || !runtime.consent[event.side].consented)
    ) return;
    if (
      event.type !== "participant_state" &&
      event.type !== "participant_readiness" &&
      !this.#hasAllConsents(runtime)
    ) return;

    switch (event.type) {
      case "participant_readiness":
        await this.#acceptParticipantReadiness(runtime, event);
        return;
      case "queue_sample":
        this.#acceptBrowserQueueSample(runtime, event);
        return;
      case "playout_cleared":
        this.#acceptPlayoutClearAcknowledgement(runtime, event);
        return;
      case "alert":
        this.#emitAlert(
          runtime,
          null,
          null,
          event.code,
          event.message,
          event.retryable,
        );
        return;
      case "participant_state": {
        if (!isNonNegativeFinite(event.timestampMonoMs)) {
          this.#emitAlert(
            runtime,
            null,
            null,
            "invalid_participant_state",
            "Rejected a participant state with an invalid monotonic timestamp",
            false,
          );
          return;
        }
        const previousStateAtMonoMs = runtime.lastParticipantStateAtMonoMs[event.side];
        if (
          previousStateAtMonoMs !== undefined &&
          event.timestampMonoMs < previousStateAtMonoMs
        ) {
          this.#emitAlert(
            runtime,
            null,
            null,
            "invalid_participant_state",
            "Rejected an out-of-order participant state",
            false,
          );
          return;
        }
        const wasActive = runtime.status === "active";
        const wasInteractive = wasActive || runtime.status === "paused";
        const wasConnected = runtime.connected[event.side];
        const stateChanged = wasConnected !== event.connected;
        const stateEventTask = this.#emit(runtime, {
          type: "participant_state",
          side: event.side,
          connected: event.connected,
        }, null, null, true, () => {
          runtime.lastParticipantStateAtMonoMs[event.side] = event.timestampMonoMs;
          if (!stateChanged) return;
          runtime.connected[event.side] = event.connected;
          runtime.readinessConnectionStartedAtMonoMs[event.side] = event.connected
            ? event.timestampMonoMs
            : undefined;
          runtime.participantReadiness[event.side] = undefined;
          if (!event.connected) {
            runtime.sourceEvidenceCursors[event.side] = undefined;
            this.#discardUtterance(runtime, event.side);
            this.#purgePlayoutMetadata(runtime, oppositeInboundLane(event.side));
          }
        });
        const stateResult = await this.#valueBounded(stateEventTask, this.#evidenceOperationTimeoutMs);
        if (!stateResult.ok) {
          this.#failEvidence(runtime);
          return;
        }
        const stateEvent = stateResult.value;
        if (stateEvent === undefined || runtime.evidenceFailureStarted) return;
        if (!event.connected && stateChanged && wasInteractive) {
          await this.#setStatus(runtime, "waiting");
          runtime.speaking.A = false;
          runtime.speaking.B = false;
          if (wasActive) {
            this.#cutLane(runtime, "A_TO_B", "operator");
            this.#cutLane(runtime, "B_TO_A", "operator");
          }
        }
        await this.#updateReadiness(runtime);
        if (!event.connected && stateChanged && wasInteractive) {
          this.#emitAlert(
            runtime,
            null,
            null,
            "participant_disconnected",
            `Participant ${event.side} disconnected`,
            true,
          );
        }
        return;
      }
      case "speech_started":
        if (runtime.status === "active" && !runtime.speaking[event.side]) {
          runtime.speaking[event.side] = true;
          const ownLane = laneFromSource(event.side);
          const generation = runtime.fences[ownLane].generation;
          runtime.firstAudio.delete(`${ownLane}:${generation}`);
          runtime.speechOnsets[ownLane] = Object.freeze({
            generation,
            startedAtMs: event.timestampMonoMs,
          });
          this.#cutLane(runtime, oppositeInboundLane(event.side), "barge_in", {
            bargeId: randomUUID(),
            sourceSide: event.side,
          });
        }
        return;
      case "speech_ended":
        this.#finishUtterance(runtime, event.side);
        return;
      case "audio":
        if (runtime.status !== "active") return;
        if (runtime.behavior.inputCommit === "speech_end" && !runtime.speaking[event.side]) {
          return;
        }
        if (event.frame.lane !== laneFromSource(event.side)) {
          this.#emitAlert(runtime, event.frame.lane, event.frame.generation, "wrong_lane_media", "Rejected audio routed to the wrong lane", false);
          return;
        }
        await this.#acceptAudio(runtime, event);
        return;
    }
  }

  #finishUtterance(runtime: SessionRuntime, side: Side): void {
    runtime.speaking[side] = false;
    const lane = laneFromSource(side);
    if (runtime.behavior.inputCommit === "speech_end") {
      const frames = runtime.pendingFrames[lane];
      if (frames.length > 0) {
        for (const frame of frames) this.#offerFrame(runtime, lane, frame);
      }
      runtime.pendingFrames[lane] = [];
    }
    const run = runtime.laneRuns[lane];
    if (run !== undefined && !run.input.closed) {
      run.input.close();
    }
  }

  #discardUtterance(runtime: SessionRuntime, side: Side): void {
    runtime.speaking[side] = false;
    const lane = laneFromSource(side);
    runtime.pendingFrames[lane] = [];
    const run = runtime.laneRuns[lane];
    if (run !== undefined) {
      run.input.close();
      run.controller.abort();
    }
  }

  async #acceptParticipantReadiness(
    runtime: SessionRuntime,
    event: Extract<MediaIngressEvent, { type: "participant_readiness" }>,
  ): Promise<void> {
    const connectionStartedAtMonoMs = isSide(event.side)
      ? runtime.readinessConnectionStartedAtMonoMs[event.side]
      : undefined;
    if (
      !isSide(event.side) ||
      !runtime.connected[event.side] ||
      connectionStartedAtMonoMs === undefined ||
      !isNonNegativeFinite(event.timestampMonoMs) ||
      event.timestampMonoMs < connectionStartedAtMonoMs ||
      (event.microphone !== "browser_capture_active" &&
        event.microphone !== "stopped" &&
        event.microphone !== "not_applicable") ||
      (event.headphones !== "self_attested" &&
        event.headphones !== "not_attested" &&
        event.headphones !== "not_applicable") ||
      (event.source !== "participant_browser_self_report" &&
        event.source !== "fake_telephony_fixture") ||
      (event.source === "participant_browser_self_report" &&
        (event.microphone === "not_applicable" || event.headphones === "not_applicable")) ||
      (event.source === "fake_telephony_fixture" &&
        (event.microphone !== "not_applicable" || event.headphones !== "not_applicable"))
    ) {
      this.#emitAlert(runtime, null, null, "invalid_participant_readiness", "Rejected an invalid participant readiness report", false);
      return;
    }
    const readiness = Object.freeze({
      microphone: event.microphone,
      headphones: event.headphones,
      source: event.source,
    });
    const accepted = await this.#emit(
      runtime,
      { type: "participant_readiness", side: event.side, ...readiness },
      null,
      null,
      true,
      () => {
        runtime.participantReadiness[event.side] = readiness;
      },
    );
    if (accepted === undefined || runtime.evidenceFailureStarted) return;
    await this.#updateReadiness(runtime);
  }

  #acceptBrowserQueueSample(
    runtime: SessionRuntime,
    event: Extract<MediaIngressEvent, { type: "queue_sample" }>,
  ): void {
    const valid =
      event.scope === "browser_playout" &&
      isSide(event.side) &&
      isLane(event.lane) &&
      isNonNegativeSafeInteger(event.generation) &&
      isNonNegativeSafeInteger(event.depthFrames) &&
      isNonNegativeSafeInteger(event.capacityFrames) &&
      event.capacityFrames > 0 &&
      event.depthFrames <= event.capacityFrames &&
      isNonNegativeFinite(event.bufferedAudioMs) &&
      (event.oldestQueuedAgeMs === undefined || isNonNegativeFinite(event.oldestQueuedAgeMs)) &&
      isNonNegativeFinite(event.timestampMonoMs) &&
      event.side === destinationForLane(event.lane) &&
      runtime.fences[event.lane].accepts(event.generation) &&
      (runtime.status === "active" || runtime.status === "paused");
    if (!valid) {
      this.#emitAlert(runtime, null, null, "invalid_queue_sample", "Rejected an invalid browser playout queue sample", false);
      return;
    }
    this.#emitQueueSample(runtime, {
      scope: "browser_playout",
      lane: event.lane,
      generation: event.generation,
      side: event.side,
      depthFrames: event.depthFrames,
      capacityFrames: event.capacityFrames,
      bufferedAudioMs: event.bufferedAudioMs,
      ...(event.oldestQueuedAgeMs === undefined ? {} : { oldestQueuedAgeMs: event.oldestQueuedAgeMs }),
    });
  }

  #acceptPlayoutClearAcknowledgement(
    runtime: SessionRuntime,
    event: Extract<MediaIngressEvent, { type: "playout_cleared" }>,
  ): void {
    const pending = isOpaqueId(event.clearId) ? runtime.pendingPlayoutClears.get(event.clearId) : undefined;
    const valid =
      pending !== undefined &&
      isSide(event.side) &&
      isLane(event.lane) &&
      isNonNegativeSafeInteger(event.generation) &&
      isNonNegativeFinite(event.timestampMonoMs) &&
      event.side === destinationForLane(event.lane) &&
      pending.lane === event.lane &&
      pending.generation === event.generation &&
      pending.side === event.side &&
      runtime.fences[event.lane].accepts(event.generation);
    if (!valid || pending === undefined) {
      if (
        pending !== undefined &&
        runtime.fences[pending.lane].generation !== pending.generation
      ) {
        runtime.pendingPlayoutClears.delete(pending.clearId);
        const staleOrderIndex = runtime.pendingPlayoutClearOrder.indexOf(pending.clearId);
        if (staleOrderIndex >= 0) runtime.pendingPlayoutClearOrder.splice(staleOrderIndex, 1);
      }
      this.#emitAlert(runtime, null, null, "invalid_playout_clear_ack", "Rejected a stale, foreign, or duplicate playout clear acknowledgement", false);
      return;
    }
    runtime.pendingPlayoutClears.delete(event.clearId);
    const orderIndex = runtime.pendingPlayoutClearOrder.indexOf(event.clearId);
    if (orderIndex >= 0) runtime.pendingPlayoutClearOrder.splice(orderIndex, 1);
    if (pending.bargeId !== undefined && pending.sourceSide !== undefined) {
      this.#emitBargeLifecycle(
        runtime,
        pending.lane,
        pending.generation,
        "playout_clear_acknowledged",
        pending.bargeId,
        pending.clearId,
        pending.sourceSide,
        pending.side,
      );
    }
  }

  async #updateReadiness(runtime: SessionRuntime): Promise<void> {
    if (runtime.status !== "waiting" && runtime.status !== "ready") return;
    if (!this.#hasNonProviderReadyPrerequisites(runtime)) {
      if (runtime.status === "ready") await this.#setStatus(runtime, "waiting");
      return;
    }
    if (!this.#hasProviderReadiness(runtime)) {
      this.#beginProviderPreparation(runtime);
      return;
    }
    if (runtime.status === "waiting") {
      await this.#setStatus(runtime, "ready");
    }
  }

  #hasAllConsents(runtime: SessionRuntime): boolean {
    return runtime.consent.A.consented && runtime.consent.B.consented;
  }

  #isRecorderArming(runtime: SessionRuntime): boolean {
    return runtime.recorderArmState === "arming";
  }

  #hasReadyPrerequisites(runtime: SessionRuntime): boolean {
    return this.#hasNonProviderReadyPrerequisites(runtime) &&
      this.#hasProviderReadiness(runtime);
  }

  #hasNonProviderReadyPrerequisites(runtime: SessionRuntime): boolean {
    return this.#hasAllConsents(runtime) &&
      runtime.connected.A &&
      runtime.connected.B &&
      this.#hasAcceptedParticipantReadiness(runtime, "A") &&
      this.#hasAcceptedParticipantReadiness(runtime, "B") &&
      runtime.recorderArmState === "armed";
  }

  #hasAcceptedParticipantReadiness(runtime: SessionRuntime, side: Side): boolean {
    const readiness = runtime.participantReadiness[side];
    if (readiness === undefined) return false;
    return (
      readiness.source === "participant_browser_self_report" &&
      readiness.microphone === "browser_capture_active" &&
      readiness.headphones === "self_attested"
    ) || (
      readiness.source === "fake_telephony_fixture" &&
      readiness.microphone === "not_applicable" &&
      readiness.headphones === "not_applicable"
    );
  }

  #hasProviderReadiness(runtime: SessionRuntime): boolean {
    return runtime.providerReadiness.A_TO_B !== undefined &&
      runtime.providerReadiness.B_TO_A !== undefined;
  }

  #isTerminating(runtime: SessionRuntime): boolean {
    return runtime.status === "closing" || runtime.status === "closed";
  }

  #beginProviderPreparation(runtime: SessionRuntime): void {
    if (
      runtime.providerPreparationTask !== undefined ||
      !this.#hasNonProviderReadyPrerequisites(runtime) ||
      this.#hasProviderReadiness(runtime)
    ) {
      return;
    }
    const task = this.#prepareProviders(runtime).finally(() => {
      if (runtime.providerPreparationTask === task) {
        runtime.providerPreparationTask = undefined;
      }
    });
    runtime.providerPreparationTask = task;
    this.#trackBackground(runtime, task);
  }

  async #prepareProviders(runtime: SessionRuntime): Promise<void> {
    try {
      const preparations = await Promise.all(
        (["A_TO_B", "B_TO_A"] as const).map(async (lane) => {
          const preparation = normalizeTranslationPreparation(
            await this.#translation.prepare(this.#laneContext(runtime, lane)),
          );
          return [lane, preparation] as const;
        }),
      );
      if (this.#isTerminating(runtime)) return;
      for (const [lane, preparation] of preparations) {
        const emitted = await this.#emit(
          runtime,
          { type: "provider_readiness", readiness: preparation },
          lane,
          runtime.fences[lane].generation,
          true,
          () => {
            runtime.providerReadiness[lane] = preparation;
          },
        );
        if (emitted === undefined || this.#isTerminating(runtime)) return;
      }
      await this.#updateReadiness(runtime);
    } catch {
      if (this.#isTerminating(runtime)) return;
      const emitted = await this.#emit(runtime, {
          type: "alert",
          alert: Object.freeze({
            code: "translation_prepare_failed",
            message: "Translation provider preparation failed",
            retryable: false,
          }),
      });
      if (emitted === undefined || runtime.evidenceFailureStarted) return;
      void this.#end(runtime, "translation_prepare_failed", "translation_prepare_failed").catch(() => {});
    }
  }

  async #setRecorderArmState(runtime: SessionRuntime, state: RecorderArmState): Promise<void> {
    if (runtime.recorderArmState === state) return;
    const previousState = runtime.recorderArmState;
    const event = await this.#emit(runtime, {
      type: "recorder_state",
      previousState,
      state,
      armedTracks: Object.freeze(state === "armed" ? [...EVIDENCE_AUDIO_TRACKS] : []),
    }, null, null, true, () => {
      runtime.recorderArmState = state;
    });
    if (event === undefined || runtime.evidenceFailureStarted) {
      throw new Error("Evidence rejected recorder state event");
    }
  }

  async #sourceEvidenceTimeline(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
  ): Promise<number | undefined> {
    const previous = runtime.sourceEvidenceCursors[side];
    if (previous !== undefined &&
        previous.generation === frame.generation &&
        frame.sequence <= previous.sequence) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_source_sequence",
        "Rejected source evidence with a non-increasing frame sequence",
        false,
      );
      return undefined;
    }
    const sequenceDistance = previous?.generation === frame.generation
      ? frame.sequence - previous.sequence
      : 0;
    const timelineAtMonoMs = sequenceDistance === 0
      ? frame.capturedAtMs
      : Math.max(
          frame.capturedAtMs,
          previous!.timelineAtMonoMs +
            sequenceDistance * CANONICAL_AUDIO.frameDurationMs,
        );
    if (sequenceDistance > 1 && previous !== undefined) {
      const emitted = await this.#emit(
        runtime,
        {
          type: "sequence_gap",
          stream: "source",
          expectedSequence: previous.sequence + 1,
          actualSequence: frame.sequence,
          missingCount: sequenceDistance - 1,
          timelineAtMonoMs,
        },
        frame.lane,
        frame.generation,
      );
      if (emitted === undefined || runtime.evidenceFailureStarted) return undefined;
    }
    runtime.sourceEvidenceCursors[side] = Object.freeze({
      generation: frame.generation,
      sequence: frame.sequence,
      timelineAtMonoMs,
    });
    return timelineAtMonoMs;
  }
  async #acceptAudio(
    runtime: SessionRuntime,
    event: Extract<MediaIngressEvent, { type: "audio" }>,
  ): Promise<void> {
    const lane = laneFromSource(event.side);
    const generation = runtime.fences[lane].generation;
    const frame = Object.freeze({
      ...event.frame,
      sessionId: runtime.sessionId,
      lane,
      generation,
    });
    const onset = runtime.speechOnsets[lane];
    if (onset === undefined || onset.generation !== generation) {
      runtime.speechOnsets[lane] = Object.freeze({
        generation,
        startedAtMs: frame.capturedAtMs,
      });
    }
    const timelineResult = await this.#valueBounded(
      this.#sourceEvidenceTimeline(runtime, event.side, frame),
      this.#evidenceOperationTimeoutMs,
    );
    if (!timelineResult.ok) {
      this.#failEvidence(runtime);
      return;
    }
    const timelineAtMonoMs = timelineResult.value;
    if (timelineAtMonoMs === undefined) return;
    try {
      const persistTask = this.#persistEvidence(runtime, {
        type: "audio",
        sessionId: runtime.sessionId,
        track: sourceTrack(event.side),
        timelineAtMonoMs,
        frame,
      });
      const persisted = await this.#awaitBounded(persistTask, this.#evidenceOperationTimeoutMs);
      if (!persisted) {
        this.#failEvidence(runtime);
        return;
      }
    } catch {
      return;
    }

    if (
      runtime.status !== "active" ||
      !runtime.fences[lane].accepts(frame.generation)
    ) return;

    if (runtime.behavior.inputCommit === "speech_end") {
      const pending = runtime.pendingFrames[lane];
      pending.push(frame);
      const maxFrames = queueCapacity(runtime.spec, runtime.behavior);
      if (pending.length > maxFrames) {
        pending.shift();
        this.#emitAlert(runtime, lane, generation, "source_queue_trimmed", "Dropped the oldest queued source frame to preserve the latency budget", true);
      }
      return;
    }
    this.#offerFrame(runtime, lane, frame);
  }

  #offerFrame(
    runtime: SessionRuntime,
    lane: Lane,
    frame: import("./audio.js").AudioFrame,
  ): void {
    if (
      frame.sessionId !== runtime.sessionId ||
      frame.lane !== lane ||
      !runtime.fences[lane].accepts(frame.generation)
    ) return;
    let run = this.#ensureLaneRun(runtime, lane);
    let result = run.input.offerLatest(frame);
    if (result === "closed") {
      run = this.#ensureLaneRun(runtime, lane);
      result = run.input.offerLatest(frame);
    }
    if (result === "closed") {
      this.#emitAlert(
        runtime,
        lane,
        frame.generation,
        "source_input_closed",
        "Rejected source frame because its translation input closed before it could be queued",
        true,
      );
      return;
    }
    this.#sampleRelayQueue(runtime, "relay_input", lane, frame.generation, sourceForLane(lane), run.input);
    if (result === "dropped_oldest") {
      this.#emitAlert(
        runtime,
        lane,
        frame.generation,
        "source_queue_trimmed",
        "Dropped the oldest queued source frame to preserve the latency budget",
        true,
      );
    }
  }

  #laneContext(
    runtime: SessionRuntime,
    lane: Lane,
    generation = runtime.fences[lane].generation,
  ): LaneContext {
    const languages = laneLanguages(runtime.spec, lane);
    const glossary = runtime.compiledGlossaries?.[lane];
    return Object.freeze({
      sessionId: runtime.sessionId,
      lane,
      generation,
      turnId: randomUUID(),
      sourceLanguage: languages.sourceLanguage,
      targetLanguage: languages.targetLanguage,
      behavior: runtime.behavior,
      ...(glossary === undefined ? {} : { glossary }),
    });
  }

  #ensureLaneRun(runtime: SessionRuntime, lane: Lane): LaneRun {
    const existing = runtime.laneRuns[lane];
    const generation = runtime.fences[lane].generation;
    if (existing !== undefined && existing.generation === generation && !existing.input.closed) {
      return existing;
    }

    const input = new AsyncQueue<import("./audio.js").AudioFrame>(
      queueCapacity(runtime.spec, runtime.behavior),
    );
    const controller = new AbortController();
    const context = this.#laneContext(runtime, lane, generation);

    let laneRun!: LaneRun;
    const task = this.#consumeTranslation(runtime, input, context, controller.signal).finally(() => {
      if (runtime.laneRuns[lane] === laneRun) runtime.laneRuns[lane] = undefined;
    });
    laneRun = { generation, turnId: context.turnId, input, controller, task };
    runtime.laneRuns[lane] = laneRun;
    this.#trackBackground(runtime, task);
    return laneRun;
  }

  async #consumeTranslation(
    runtime: SessionRuntime,
    input: AsyncQueue<import("./audio.js").AudioFrame>,
    context: LaneContext,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const frames = this.#observedRelayInput(runtime, context, input);
      for await (const event of this.#translation.translate({ frames, context, signal })) {
        this.#handleTranslation(runtime, event);
      }
    } catch {
      if (!signal.aborted) {
        this.#cutLane(runtime, context.lane, "operator");
        this.#emitAlert(runtime, context.lane, context.generation, "translation_failed", "Translation stream failed", true);
      }
    }
  }

  async *#observedRelayInput(
    runtime: SessionRuntime,
    context: LaneContext,
    input: AsyncQueue<import("./audio.js").AudioFrame>,
  ): AsyncIterable<import("./audio.js").AudioFrame> {
    for await (const frame of input) {
      this.#sampleRelayQueue(
        runtime,
        "relay_input",
        context.lane,
        context.generation,
        sourceForLane(context.lane),
        input,
      );
      yield frame;
    }
  }

  #sampleRelayQueue(
    runtime: SessionRuntime,
    scope: "relay_input" | "relay_playout",
    lane: Lane,
    generation: number,
    side: Side,
    queue: AsyncQueue<import("./audio.js").AudioFrame>,
  ): void {
    this.#emitQueueSample(runtime, {
      scope,
      lane,
      generation,
      side,
      depthFrames: queue.size,
      capacityFrames: queue.capacity,
      bufferedAudioMs: queue.size * CANONICAL_AUDIO.frameDurationMs,
    });
  }

  #emitQueueSample(
    runtime: SessionRuntime,
    sample: Readonly<{
      scope: "relay_input" | "relay_playout" | "browser_playout";
      lane: Lane;
      generation: number;
      side: Side;
      depthFrames: number;
      capacityFrames: number;
      bufferedAudioMs?: number;
      oldestQueuedAgeMs?: number;
    }>,
  ): void {
    const key = [sample.scope, sample.lane, sample.generation, sample.side].join(":");
    for (const existingKey of runtime.queueTelemetry.keys()) {
      const [existingScope, existingLane, _existingGeneration, existingSide] = existingKey.split(":");
      if (
        existingScope === sample.scope &&
        existingLane === sample.lane &&
        existingSide === sample.side &&
        existingKey !== key
      ) {
        runtime.queueTelemetry.delete(existingKey);
      }
    }
    const now = this.#now();
    const previous = runtime.queueTelemetry.get(key);
    const changed =
      previous === undefined ||
      previous.depthFrames !== sample.depthFrames ||
      previous.capacityFrames !== sample.capacityFrames ||
      previous.bufferedAudioMs !== sample.bufferedAudioMs ||
      previous.oldestQueuedAgeMs !== sample.oldestQueuedAgeMs;
    if (
      !changed ||
      (previous !== undefined && now - previous.emittedAtMonoMs < QUEUE_SAMPLE_MIN_INTERVAL_MS) ||
      runtime.evidenceFailureStarted ||
      runtime.pendingQueueTelemetryEvidence >= MAX_PENDING_QUEUE_TELEMETRY_EVIDENCE
    ) {
      return;
    }
    runtime.queueTelemetry.set(key, Object.freeze({
      generation: sample.generation,
      depthFrames: sample.depthFrames,
      capacityFrames: sample.capacityFrames,
      bufferedAudioMs: sample.bufferedAudioMs,
      oldestQueuedAgeMs: sample.oldestQueuedAgeMs,
      emittedAtMonoMs: now,
    }));
    while (runtime.queueTelemetry.size > MAX_QUEUE_TELEMETRY_STATES) {
      const oldest = runtime.queueTelemetry.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      runtime.queueTelemetry.delete(oldest);
    }
    runtime.pendingQueueTelemetryEvidence += 1;
    const emitted = this.#emit(runtime, {
      type: "queue_sample",
      scope: sample.scope,
      side: sample.side,
      depthFrames: sample.depthFrames,
      capacityFrames: sample.capacityFrames,
      ...(sample.oldestQueuedAgeMs === undefined ? {} : { oldestQueuedAgeMs: sample.oldestQueuedAgeMs }),
      ...(sample.bufferedAudioMs === undefined ? {} : { bufferedAudioMs: sample.bufferedAudioMs }),
    }, sample.lane, sample.generation);
    const releaseTelemetrySlot = (): void => {
      runtime.pendingQueueTelemetryEvidence -= 1;
    };
    void emitted.then(releaseTelemetrySlot, releaseTelemetrySlot);
  }

  #resetTranscripts(
    runtime: SessionRuntime,
    lane: Lane,
    generation: number,
  ): TranscriptAccumulator {
    const accumulator = runtime.transcripts[lane];
    accumulator.generation = generation;
    accumulator.segments.clear();
    return accumulator;
  }

  #acceptTranscriptRevision(
    runtime: SessionRuntime,
    event: Extract<TranslationEvent, { kind: "source_transcript" | "target_transcript" }>,
  ): TranslationRejectionReason | undefined {
    const existing = runtime.transcripts[event.lane];
    const accumulator = existing.generation === event.generation
      ? existing
      : this.#resetTranscripts(runtime, event.lane, event.generation);
    const key = event.turnId + ":" + event.segmentId;
    const prior = accumulator.segments.get(key);
    if (prior?.final) return "terminal_revision";
    if (prior !== undefined && event.revision <= prior.revision) return "stale_revision";
    accumulator.segments.set(key, {
      kind: event.kind,
      revision: event.revision,
      text: event.text,
      final: event.finality === "final",
    });
    return undefined;
  }

  #hasValidTerminologyProvenance(
    runtime: SessionRuntime,
    event: Extract<TranslationEvent, { kind: "terminology" }>,
  ): boolean {
    const glossary = runtime.compiledGlossaries?.[event.lane];
    if (glossary === undefined || event.glossaryHash !== glossary.hash) return false;
    const entryIds = new Set(glossary.entries.map((entry) => entry.id));
    return event.entryIds.length > 0 && event.entryIds.every((entryId) => entryIds.has(entryId));
  }

  #authorizedGlossaryTermId(
    runtime: SessionRuntime,
    lane: Lane,
    value: unknown,
  ): string | undefined {
    if (!isOpaqueId(value)) return undefined;
    const glossary = runtime.compiledGlossaries?.[lane];
    return glossary?.entries.some((entry) => entry.id === value) ? value : undefined;
  }

  #audioTargetRejection(
    runtime: SessionRuntime,
    event: Extract<TranslationEvent, { kind: "audio" }>,
  ): TranslationRejectionReason | undefined {
    if (!isOpaqueId((event as unknown as { readonly targetSegmentId?: unknown }).targetSegmentId)) {
      return "unknown_identity";
    }
    const accumulator = runtime.transcripts[event.lane];
    if (accumulator.generation !== event.generation) return "unknown_identity";
    const target = accumulator.segments.get(event.turnId + ":" + event.targetSegmentId);
    if (target === undefined || target.kind !== "target_transcript") return "unknown_identity";
    if (target.revision !== event.revision) return target.final ? "terminal_revision" : "stale_revision";
    return undefined;
  }

  #handleTranslation(runtime: SessionRuntime, event: TranslationEvent): void {
    if (!isLane((event as unknown as { readonly lane?: unknown }).lane)) {
      this.#emitAlert(
        runtime,
        null,
        null,
        "invalid_translation_lane",
        "Rejected a translation event with an invalid lane",
        false,
      );
      return;
    }
    if (event.kind === "diagnostic") {
      this.#recordTranslationRejection(runtime, event, event.reason);
      return;
    }
    const rejection = this.#translationRejectionReason(runtime, event);
    if (rejection !== undefined) {
      this.#recordTranslationRejection(runtime, event, rejection);
      return;
    }

    switch (event.kind) {
      case "source_transcript":
      case "target_transcript": {
        if (runtime.behavior.transcriptPolicy === "final_only" && event.finality !== "final") {
          return;
        }
        const revisionRejection = this.#acceptTranscriptRevision(runtime, event);
        if (revisionRejection !== undefined) {
          this.#recordTranslationRejection(runtime, event, revisionRejection);
          return;
        }
        this.#emit(
          runtime,
          {
            type: event.kind,
            turnId: event.turnId,
            segmentId: event.segmentId,
            revision: event.revision,
            text: event.text,
            final: event.finality === "final",
            evidenceRef: event.evidenceRef,
          },
          event.lane,
          event.generation,
          event.finality === "final",
        );
        return;
      }
      case "terminology":
        {
          if (!this.#hasValidTerminologyProvenance(runtime, event)) {
            this.#recordTranslationRejection(runtime, event, "unknown_identity");
            return;
          }
          const provenance = {
            turnId: event.turnId,
            segmentId: event.segmentId,
            revision: event.revision,
            final: event.finality === "final",
            glossaryHash: event.glossaryHash,
            entryIds: Object.freeze([...event.entryIds]),
            evidenceRef: event.evidenceRef,
          };
        if (event.status === "bound") {
          this.#emit(runtime, {
            type: "glossary_bound",
            ...provenance,
          }, event.lane, event.generation, provenance.final);
        } else if (event.status === "authorized") {
          this.#emit(runtime, {
            type: "glossary_authorized",
            ...provenance,
          }, event.lane, event.generation, provenance.final);
        } else {
          this.#emit(runtime, {
            type: "glossary_bypassed",
            ...provenance,
          }, event.lane, event.generation, provenance.final);
        }
        return;
        }
      case "error":
        // Unknown/ambiguous terminology is an observable fail-open warning:
        // keep the unbound translation stream alive while surfacing the alert.
        // Other non-retryable provider errors still cut the lane before any
        // subsequent output can cross the relay generation fence.
        if (
          !event.error.retryable &&
          event.error.code !== "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM"
        ) {
          this.#cutLane(runtime, event.lane, "operator");
        }
        const termId = this.#authorizedGlossaryTermId(runtime, event.lane, event.error.termId);
        const alertMetadata: AlertMetadata = termId === undefined
          ? (isUnitInterval(event.error.confidence) ? { confidence: event.error.confidence } : {})
          : (isUnitInterval(event.error.confidence)
            ? { termId, confidence: event.error.confidence }
            : { termId });
        this.#emitAlert(
          runtime,
          event.lane,
          event.generation,
          event.error.code,
          "Translation provider reported an error",
          event.error.retryable,
          event.evidenceRef,
          alertMetadata,
        );
        return;
      case "completed":
        return;
      case "audio": {
        const targetRejection = this.#audioTargetRejection(runtime, event);
        if (targetRejection !== undefined) {
          this.#recordTranslationRejection(runtime, event, targetRejection);
          return;
        }
        const previous = runtime.playoutSequences[event.lane];
        if (previous?.generation === event.generation && event.playoutSequence <= previous.sequence) {
          this.#recordTranslationRejection(runtime, event, "stale_playout_sequence");
          return;
        }
        runtime.playoutSequences[event.lane] = {
          generation: event.generation,
          sequence: event.playoutSequence,
        };
        const side = destinationForLane(event.lane);
        const frame = Object.freeze({
          ...event.frame,
          sessionId: runtime.sessionId,
          lane: event.lane,
          generation: event.generation,
          sequence: event.playoutSequence,
        });
    this.#storePlayoutMetadata(runtime, event.lane, event.generation, {
          turnId: event.turnId,
          targetSegmentId: event.targetSegmentId,
          audioSegmentId: event.segmentId,
          revision: event.revision,
          playoutSequence: event.playoutSequence,
          evidenceRef: event.evidenceRef,
          queuedAtMonoMs: this.#now(),
        });
        const playoutOffer = runtime.playout[side].offerLatest(frame);
        this.#sampleRelayQueue(runtime, "relay_playout", event.lane, event.generation, side, runtime.playout[side]);
        if (playoutOffer === "dropped_oldest") {
          this.#emitAlert(
            runtime,
            event.lane,
            event.generation,
            "playout_queue_trimmed",
            "Dropped the oldest queued playout frame to preserve the latency budget",
            true,
          );
        }
        return;
      }
    }
  }

  #translationRejectionReason(
    runtime: SessionRuntime,
    event: Exclude<TranslationEvent, { kind: "diagnostic" }>,
  ): TranslationRejectionReason | undefined {
    if (runtime.status !== "active") return "inactive_session";
    if (event.sessionId !== runtime.sessionId) return "wrong_session";
    if (!runtime.fences[event.lane].accepts(event.generation)) return "stale_generation";
    const run = runtime.laneRuns[event.lane];
    if (run === undefined) return "lane_run_tombstone";
    if (run.generation !== event.generation) return "lane_run_generation_mismatch";
    if (run.turnId !== event.turnId) return "lane_run_turn_mismatch";
    return undefined;
  }

  #recordTranslationRejection(
    runtime: SessionRuntime,
    event: TranslationEvent,
    reason: TranslationRejectionReason,
  ): void {
    void this.#persistEvidence(runtime, {
      type: "translation_rejected",
      sessionId: runtime.sessionId,
      timestampMonoMs: this.#now(),
      reason,
      identity: Object.freeze({
        sessionId: event.sessionId,
        lane: event.lane,
        generation: event.generation,
        turnId: event.turnId,
        segmentId: event.segmentId,
        revision: event.revision,
        finality: event.finality,
        kind: event.kind,
        evidenceRef: event.evidenceRef,
        emittedAtMs: event.emittedAtMs,
      }),
    }).catch(() => {});
  }

  #storePlayoutMetadata(
    runtime: SessionRuntime,
    lane: Lane,
    generation: number,
    metadata: PlayoutMetadata,
  ): void {
    const key = lane + ":" + generation + ":" + metadata.playoutSequence;
    runtime.playoutMetadata.set(key, metadata);
    const order = runtime.playoutMetadataOrder[lane];
    order.push(key);
    const capacity = queueCapacity(runtime.spec, runtime.behavior);
    if (order.length <= capacity) return;
    const trimmed = order.shift();
    if (trimmed !== undefined) runtime.playoutMetadata.delete(trimmed);
    this.#emitAlert(
      runtime,
      lane,
      generation,
      "playout_metadata_trimmed",
      "Trimmed stale playout metadata to preserve the relay memory budget",
      true,
    );
  }

  #purgePlayoutMetadata(
    runtime: SessionRuntime,
    lane: Lane,
    generation?: number,
  ): void {
    const prefix = generation === undefined ? lane + ":" : lane + ":" + generation + ":";
    const order = runtime.playoutMetadataOrder[lane];
    runtime.playoutMetadataOrder[lane] = order.filter((key) => {
      if (!key.startsWith(prefix)) return true;
      runtime.playoutMetadata.delete(key);
      return false;
    });
  }

  async #runPlayout(runtime: SessionRuntime, side: Side): Promise<void> {
    try {
      await this.#media.play({
        sessionId: runtime.sessionId,
        side,
        frames: this.#currentPlayout(runtime, side),
        signal: runtime.playoutController.signal,
        onPlayoutStarted: (frame, startedAtMonoMs) => {
          if (
            runtime.status !== "active" ||
            frame.sessionId !== runtime.sessionId ||
            !isLane(frame.lane) ||
            destinationForLane(frame.lane) !== side ||
            !runtime.fences[frame.lane].accepts(frame.generation)
          ) return;
          const tailKey = frame.lane + ":" + frame.generation;
          const pendingKey = side + ":" + tailKey;
          const pending = runtime.playoutEvidencePending.get(pendingKey) ?? 0;
          if (pending >= MAX_PENDING_PLAYOUT_EVIDENCE_PER_GENERATION) {
            if (!runtime.playoutEvidenceBackpressureAlerts.has(pendingKey)) {
              runtime.playoutEvidenceBackpressureAlerts.add(pendingKey);
              this.#emitAlert(
                runtime,
                frame.lane,
                frame.generation,
                "playout_evidence_backpressure",
                "Dropped audible acknowledgement evidence after reaching the bounded pending limit",
                true,
              );
            }
            return;
          }
          runtime.playoutEvidencePending.set(pendingKey, pending + 1);
          const tails = runtime.playoutEvidenceTails[side];
          const previous = tails.get(tailKey) ?? Promise.resolve();
          const task = previous.then(
            () => this.#acceptPlayout(runtime, side, frame, startedAtMonoMs),
            () => this.#acceptPlayout(runtime, side, frame, startedAtMonoMs),
          );
          const settled = task.then(
            () => undefined,
            () => undefined,
          );
          tails.set(tailKey, settled);
          void settled.then(() => {
            if (tails.get(tailKey) === settled) tails.delete(tailKey);
            const current = runtime.playoutEvidencePending.get(pendingKey) ?? 1;
            if (current <= 1) runtime.playoutEvidencePending.delete(pendingKey);
            else runtime.playoutEvidencePending.set(pendingKey, current - 1);
          });
          this.#trackBackground(runtime, settled);
        },
      });
    } catch {
      if (!runtime.playoutController.signal.aborted) {
        this.#emitAlert(runtime, null, null, "media_playout_failed", "Media playout adapter failed", true);
      }
    }
  }

  async #playoutEvidenceTimeline(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
    startedAtMonoMs: number,
  ): Promise<number | undefined> {
    if (!Number.isFinite(startedAtMonoMs) || startedAtMonoMs < 0) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_playout_timeline",
        "Rejected playout evidence with an invalid audible start timestamp",
        false,
      );
      return undefined;
    }
    const previous = runtime.playoutEvidenceCursors[side];
    if (previous !== undefined && previous.generation === frame.generation && frame.sequence <= previous.sequence) {
      this.#emitAlert(
        runtime,
        frame.lane,
        frame.generation,
        "invalid_playout_sequence",
        "Rejected playout evidence with a non-increasing frame sequence",
        false,
      );
      return undefined;
    }
    const sequenceDistance = previous?.generation === frame.generation
      ? frame.sequence - previous.sequence
      : 0;
    const timelineAtMonoMs = sequenceDistance === 0
      ? startedAtMonoMs
      : Math.max(startedAtMonoMs, previous!.timelineAtMonoMs + sequenceDistance * CANONICAL_AUDIO.frameDurationMs);
    if (sequenceDistance > 1 && previous !== undefined) {
      const emitted = await this.#emit(
        runtime,
        {
          type: "sequence_gap",
          stream: "playout",
          expectedSequence: previous.sequence + 1,
          actualSequence: frame.sequence,
          missingCount: sequenceDistance - 1,
          timelineAtMonoMs,
        },
        frame.lane,
        frame.generation,
      );
      if (emitted === undefined || runtime.evidenceFailureStarted) return undefined;
    }
    runtime.playoutEvidenceCursors[side] = Object.freeze({
      generation: frame.generation,
      sequence: frame.sequence,
      timelineAtMonoMs,
    });
    return timelineAtMonoMs;
  }
  async #acceptPlayout(
    runtime: SessionRuntime,
    side: Side,
    frame: import("./audio.js").AudioFrame,
    startedAtMonoMs: number,
  ): Promise<void> {
    if (
      runtime.status !== "active" ||
      frame.sessionId !== runtime.sessionId ||
      destinationForLane(frame.lane) !== side ||
      !runtime.fences[frame.lane].accepts(frame.generation)
    ) {
      return;
    }
    const metadataKey = frame.lane + ":" + frame.generation + ":" + frame.sequence;
    const metadata = runtime.playoutMetadata.get(metadataKey);
    if (metadata === undefined) return;
    runtime.playoutMetadata.delete(metadataKey);
    const order = runtime.playoutMetadataOrder[frame.lane];
    const orderIndex = order.indexOf(metadataKey);
    if (orderIndex >= 0) order.splice(orderIndex, 1);
    const timelineAtMonoMs = await this.#playoutEvidenceTimeline(runtime, side, frame, startedAtMonoMs);
    if (timelineAtMonoMs === undefined) return;

    try {
      await this.#persistEvidence(runtime, {
        type: "audio",
        sessionId: runtime.sessionId,
        track: playoutTrack(side),
        timelineAtMonoMs,
        frame,
      });
    } catch {
      return;
    }
    if (
      runtime.status !== "active" ||
      !runtime.fences[frame.lane].accepts(frame.generation)
    ) {
      return;
    }
    const playedKey = [
      frame.lane,
      frame.generation,
      metadata.turnId,
      metadata.targetSegmentId,
      metadata.revision,
    ].join(":");
    if (!runtime.playedSegments.has(playedKey)) {
      runtime.playedSegments.add(playedKey);
      const played = await this.#emit(
        runtime,
        {
          type: "playout_lag",
          turnId: metadata.turnId,
          segmentId: metadata.targetSegmentId,
          revision: metadata.revision,
          scope: "server_to_audible_ack",
          side,
          sequence: frame.sequence,
          audibleStartLagMs: Math.max(0, startedAtMonoMs - metadata.queuedAtMonoMs),
        },
        frame.lane,
        frame.generation,
      );
      if (played === undefined) runtime.playedSegments.delete(playedKey);
    }
    if (
      runtime.status !== "active" ||
      !runtime.fences[frame.lane].accepts(frame.generation)
    ) {
      return;
    }
    const firstAudioKey = frame.lane + ":" + frame.generation;
    if (!runtime.firstAudio.has(firstAudioKey)) {
      runtime.firstAudio.add(firstAudioKey);
      const onset = runtime.speechOnsets[frame.lane];
      const latencyMs = onset?.generation === frame.generation
        ? Math.max(0, startedAtMonoMs - onset.startedAtMs)
        : 0;
      this.#emit(
        runtime,
        {
          type: "audio_playout",
          frame,
          latencyMs,
          turnId: metadata.turnId,
          segmentId: metadata.targetSegmentId,
          playoutSequence: metadata.playoutSequence,
          evidenceRef: metadata.evidenceRef,
        },
        frame.lane,
        frame.generation,
      );
    }
    const resumption = runtime.pendingBargeResumptions[frame.lane];
    if (resumption?.generation === frame.generation) {
      runtime.pendingBargeResumptions[frame.lane] = undefined;
      this.#emitBargeLifecycle(
        runtime,
        frame.lane,
        frame.generation,
        "valid_output_resumed",
        resumption.bargeId,
        resumption.clearId,
        resumption.sourceSide,
        resumption.destinationSide,
      );
    }
  }

  async *#currentPlayout(
    runtime: SessionRuntime,
    side: Side,
  ): AsyncIterable<import("./audio.js").AudioFrame> {
    const lane = oppositeInboundLane(side);
    for await (const frame of runtime.playout[side]) {
      this.#sampleRelayQueue(runtime, "relay_playout", lane, frame.generation, side, runtime.playout[side]);
      if (runtime.fences[lane].accepts(frame.generation)) yield frame;
    }
  }

  #cutLane(
    runtime: SessionRuntime,
    lane: Lane,
    reason: "barge_in" | "pause" | "end" | "operator",
    barge?: BargeCut,
  ): void {
    const fence = runtime.fences[lane];
    const previousGeneration = fence.generation;
    const nextGeneration = previousGeneration + 1;
    const side = destinationForLane(lane);
    const clearId = randomUUID();
    for (const key of runtime.firstAudio) {
      if (key.startsWith(lane + ":")) runtime.firstAudio.delete(key);
    }
    for (const key of runtime.playedSegments) {
      if (key.startsWith(lane + ":")) runtime.playedSegments.delete(key);
    }
    for (const side of ["A", "B"] as const) {
      const prefix = side + ":" + lane + ":";
      for (const key of runtime.playoutEvidenceBackpressureAlerts) {
        if (key.startsWith(prefix)) runtime.playoutEvidenceBackpressureAlerts.delete(key);
      }
    }
    this.#discardPendingPlayoutClearsForLane(runtime, lane);
    runtime.pendingBargeResumptions[lane] = undefined;
    if (barge !== undefined) {
      this.#emitBargeLifecycle(
        runtime,
        lane,
        nextGeneration,
        "speech_onset",
        barge.bargeId,
        clearId,
        barge.sourceSide,
        side,
      );
    }
    fence.cut(nextGeneration);
    this.#resetTranscripts(runtime, lane, nextGeneration);
    this.#purgePlayoutMetadata(runtime, lane);
    runtime.pendingFrames[lane] = [];
    runtime.playoutSequences[lane] = undefined;
    runtime.speechOnsets[lane] = undefined;

    const run = runtime.laneRuns[lane];
    if (run !== undefined) {
      run.input.close();
      run.controller.abort();
    }

    this.#emit(
      runtime,
      {
        type: "generation_cut",
        previousGeneration,
        reason,
        clearId,
        ...(barge === undefined ? {} : { bargeId: barge.bargeId }),
      },
      lane,
      nextGeneration,
      true,
      undefined,
      false,
      true,
    );
    const pendingClear = Object.freeze({
      lane,
      generation: nextGeneration,
      side,
      clearId,
      bargeId: barge?.bargeId,
      sourceSide: barge?.sourceSide,
    });
    this.#registerPendingPlayoutClear(runtime, pendingClear);
    if (barge !== undefined) {
      runtime.pendingBargeResumptions[lane] = Object.freeze({
        bargeId: barge.bargeId,
        clearId,
        sourceSide: barge.sourceSide,
        destinationSide: side,
        generation: nextGeneration,
      });
      this.#emitBargeLifecycle(
        runtime,
        lane,
        nextGeneration,
        "playout_clear_requested",
        barge.bargeId,
        clearId,
        barge.sourceSide,
        side,
      );
    }
    const clearTask = Promise.resolve().then(() => this.#media.clear({
      sessionId: runtime.sessionId,
      lane,
      generation: nextGeneration,
      side,
      clearId,
    }));
    this.#trackAdapterTask(runtime, clearTask);
    void clearTask.then(
      () => {},
      () => {
        const pending = runtime.pendingPlayoutClears.get(clearId);
        if (pending === undefined) return;
        if (runtime.status === "closed" || runtime.status === "closing") return;
        runtime.pendingPlayoutClears.delete(clearId);
        const orderIndex = runtime.pendingPlayoutClearOrder.indexOf(clearId);
        if (orderIndex >= 0) runtime.pendingPlayoutClearOrder.splice(orderIndex, 1);
        runtime.pendingBargeResumptions[pending.lane] = undefined;
        if (pending.bargeId === undefined || pending.sourceSide === undefined) return;
        const failureStage = this.#emitBargeLifecycle(
          runtime,
          pending.lane,
          pending.generation,
          "playout_clear_failed",
          pending.bargeId,
          pending.clearId,
          pending.sourceSide,
          pending.side,
          "Playout clear failed",
          true,
        );
        void failureStage.then(
          () => this.#failEvidence(runtime),
          () => this.#failEvidence(runtime),
        );
      },
    );
    if (barge !== undefined) {
      this.#emitBargeLifecycle(
        runtime,
        lane,
        nextGeneration,
        "provider_cancel_requested",
        barge.bargeId,
        clearId,
        barge.sourceSide,
        side,
      );
    }
    const cancelTask = Promise.resolve().then(() => this.#translation.cancel({
      sessionId: runtime.sessionId,
      lane,
      generation: previousGeneration,
    }));
    this.#trackAdapterTask(runtime, cancelTask);
    void cancelTask.then(
      () => {
        if (barge === undefined || runtime.status === "closed" || runtime.status === "closing") return;
        this.#emitBargeLifecycle(
          runtime,
          lane,
          nextGeneration,
          "provider_cancel_settled",
          barge.bargeId,
          clearId,
          barge.sourceSide,
          side,
        );
      },
      () => {
        if (barge === undefined || runtime.status === "closed" || runtime.status === "closing") return;
        this.#emitBargeLifecycle(
          runtime,
          lane,
          nextGeneration,
          "provider_cancel_failed",
          barge.bargeId,
          clearId,
          barge.sourceSide,
          side,
          "Translation cancellation failed",
        );
      },
    );
  }

  #registerPendingPlayoutClear(runtime: SessionRuntime, pending: PendingPlayoutClear): void {
    runtime.pendingPlayoutClears.set(pending.clearId, pending);
    runtime.pendingPlayoutClearOrder.push(pending.clearId);
    while (runtime.pendingPlayoutClearOrder.length > MAX_PENDING_PLAYOUT_CLEARS) {
      const expired = runtime.pendingPlayoutClearOrder.shift();
      if (expired === undefined) break;
      runtime.pendingPlayoutClears.delete(expired);
      this.#emitAlert(
        runtime,
        null,
        null,
        "playout_clear_tracking_trimmed",
        "Dropped an unacknowledged playout clear correlation to preserve the relay memory budget",
        true,
      );
    }
  }

  #discardPendingPlayoutClearsForLane(runtime: SessionRuntime, lane: Lane): void {
    for (const [clearId, pending] of runtime.pendingPlayoutClears) {
      if (pending.lane !== lane) continue;
      runtime.pendingPlayoutClears.delete(clearId);
    }
    runtime.pendingPlayoutClearOrder.splice(
      0,
      runtime.pendingPlayoutClearOrder.length,
      ...runtime.pendingPlayoutClearOrder.filter((clearId) =>
        runtime.pendingPlayoutClears.has(clearId),
      ),
    );
  }

  #emitBargeLifecycle(
    runtime: SessionRuntime,
    lane: Lane,
    generation: number,
    stage: BargeLifecycleStage,
    bargeId: string,
    clearId: string,
    sourceSide: Side,
    destinationSide: Side,
    message?: string,
    priority = false,
  ): Promise<SessionEvent | undefined> {
    if (runtime.status === "closed") return Promise.resolve(undefined);
    return this.#emit(
      runtime,
      {
        type: "barge_lifecycle",
        stage,
        bargeId,
        clearId,
        sourceSide,
        destinationSide,
        ...(message === undefined ? {} : { message }),
      },
      lane,
      generation,
      true,
      undefined,
      false,
      priority,
    );
  }

  #end(runtime: SessionRuntime, commandId: string, reason: string): Promise<void> {
    if (runtime.endTask !== undefined) return runtime.endTask;

    let resolveTask!: () => void;
    let rejectTask!: (error: unknown) => void;
    const endTask = new Promise<void>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    runtime.endTask = endTask;
    void this.#finishEnd(runtime, commandId, reason).then(resolveTask, rejectTask);
    return endTask;
  }

  async #finishEnd(runtime: SessionRuntime, commandId: string, reason: string): Promise<void> {
    if (runtime.status === "closed") return;
    const closingEvent = runtime.status === "closing"
      ? Promise.resolve(undefined)
      : this.#beginControlStatus(runtime, "closing", commandId);
    this.#cutLane(runtime, "A_TO_B", "end");
    this.#cutLane(runtime, "B_TO_A", "end");
    runtime.ingressController.abort();
    for (const lane of ["A_TO_B", "B_TO_A"] as const) {
      runtime.laneRuns[lane]?.input.close();
      runtime.laneRuns[lane]?.controller.abort();
    }
    runtime.playout.A.close();
    runtime.playout.B.close();
    runtime.playoutController.abort();

    // Signal both adapters before waiting on any in-flight operation. An
    // evidence write may be stalled indefinitely; privacy cleanup must not
    // leave participant transports open behind that tail.
    let mediaCleanupSettled = false;
    let translationCleanupSettled = false;
    const mediaCleanupTask = Promise.resolve()
      .then(() => this.#media.closeSession(runtime.sessionId))
      .finally(() => {
        mediaCleanupSettled = true;
      });
    const translationCleanupTask = Promise.resolve()
      .then(() => this.#translation.closeSession(runtime.sessionId))
      .finally(() => {
        translationCleanupSettled = true;
      });
    const cleanupTask = Promise.allSettled([mediaCleanupTask, translationCleanupTask]);
    this.#trackAdapterTask(runtime, cleanupTask.then(() => undefined));
    const cleanupResults = await settleWithin(
      cleanupTask,
      this.#adapterCloseTimeoutMs,
      undefined,
    );
    if (cleanupResults === undefined) {
      if (!mediaCleanupSettled) {
        this.#emitAlert(
          runtime,
          null,
          null,
          "media_cleanup_timeout",
          "Media cleanup timed out",
          true,
        );
      }
      if (!translationCleanupSettled) {
        this.#emitAlert(
          runtime,
          null,
          null,
          "translation_cleanup_timeout",
          "Translation cleanup timed out",
          true,
        );
      }
    }
    const mediaCleanup = cleanupResults?.[0];
    const translationCleanup = cleanupResults?.[1];
    if (mediaCleanup?.status === "rejected") {
      this.#emitAlert(
        runtime,
        null,
        null,
        "media_cleanup_failed",
        "Media cleanup failed",
        true,
      );
    }
    if (translationCleanup?.status === "rejected") {
      this.#emitAlert(
        runtime,
        null,
        null,
        "translation_cleanup_failed",
        "Translation cleanup failed",
        true,
      );
    }
    await this.#drainAdapterTasks(runtime);
    const closingDrained = await this.#awaitBounded(closingEvent, this.#evidenceOperationTimeoutMs);
    if (!closingDrained) this.#failEvidence(runtime);
    // Let subscribers observe the durably published closing projection before
    // the terminal closed projection is appended.
    await Promise.resolve();
    const backgroundDrained = await this.#drainBackgroundTasks(runtime);
    if (!backgroundDrained) this.#failEvidence(runtime);
    runtime.closedAtMs = this.#now();
    await this.#setStatus(runtime, "closed", commandId, true);
    const evidenceDrained = await this.#drainEvidenceOperations(runtime);
    if (!evidenceDrained) this.#failEvidence(runtime);
    const finalizationController = new AbortController();
    const finalizeRequest = Object.freeze({
      sessionId: runtime.sessionId,
      processingManifestSha256: runtime.spec.processingManifest.manifestSha256,
      finalizedAtMonoMs: this.#now(),
      reason,
      lastPersistedEventCursor: runtime.lastPersistedEventCursor,
      abortSignal: finalizationController.signal,
    });
    let finalization: EvidenceFinalization;
    try {
      const finalizeTask = this.#evidence.finalize(finalizeRequest);
      const result = await this.#valueBounded(finalizeTask, this.#finalizationTimeoutMs);
      if (!result.ok) {
        finalizationController.abort("finalization_timeout");
        throw new Error("Evidence finalization did not settle");
      }
      const candidate = result.value;
      if (candidate === undefined) throw new Error("Evidence finalization did not settle");
      if (runtime.evidenceFailureStarted && candidate.status === "sealed") {
        finalization = Object.freeze({
          status: "FINALIZATION_FAILED" as const,
          sessionId: runtime.sessionId,
          processingManifestSha256: runtime.spec.processingManifest.manifestSha256,
          failureCode: "integrity_verification_failed" as const,
          recovery: "quarantine_delete_rerun" as const,
        });
      } else {
        validateEvidenceFinalization(candidate, {
          sessionId: runtime.sessionId,
          processingManifestSha256: runtime.spec.processingManifest.manifestSha256,
          retentionPolicy: runtime.spec.processingManifest.retentionPolicy,
        });
        finalization = candidate;
      }
    } catch {
      finalization = Object.freeze({
        status: "FINALIZATION_FAILED" as const,
        sessionId: runtime.sessionId,
        processingManifestSha256: runtime.spec.processingManifest.manifestSha256,
        failureCode: "seal_write_failed" as const,
        recovery: "quarantine_delete_rerun" as const,
      });
    }
    runtime.evidenceFinalization = finalization;
    if (runtime.evidenceFailureStarted) {
      // The control tail may itself be the stalled operation. Do not wait on
      // it or claim that this terminal notification was durable; publish the
      // explicit failed finalization to in-memory subscribers and close them.
      this.#publishWithoutEvidence(runtime, { type: "session_closed", reason, finalization });
    } else {
      await this.#emit(
        runtime,
        { type: "session_closed", reason, finalization },
        null,
        null,
        false,
        undefined,
        false,
        true,
      );
    }
    for (const subscriber of runtime.subscribers) {
      subscriber.close();
    }
    runtime.subscribers.clear();
    this.#retainClosedSession(runtime);
  }

  #retainClosedSession(runtime: SessionRuntime): void {
    if (this.#closedSessionIds.includes(runtime.sessionId)) {
      return;
    }
    this.#closedSessionIds.push(runtime.sessionId);
    while (this.#closedSessionIds.length > this.#closedSessionHistoryLimit) {
      const expiredSessionId = this.#closedSessionIds.shift();
      if (expiredSessionId === undefined) break;
      const expiredRuntime = this.#sessions.get(expiredSessionId);
      if (
        expiredRuntime?.status === "closed" &&
        expiredRuntime.subscribers.size === 0
      ) {
        this.#sessions.delete(expiredSessionId);
      }
    }
  }

  async #setStatus(
    runtime: SessionRuntime,
    status: SessionStatus,
    commandId?: string,
    priority = false,
  ): Promise<void> {
    if (runtime.status === status) return;
    const previousStatus = runtime.status;
    if (runtime.evidenceFailureStarted) {
      if (status === "closing" || status === "closed") {
        runtime.status = status;
        runtime.controlStatus = undefined;
        runtime.ingressStopped = true;
        return;
      }
      throw new Error("Evidence rejected session state event");
    }
    const event = await this.#emit(runtime, {
      type: "session_state",
      previousStatus,
      status,
      ...(commandId === undefined ? {} : { commandId }),
    }, null, null, true, () => {
      if (
        runtime.evidenceFailureStarted ||
        runtime.status !== previousStatus ||
        runtime.controlStatus !== undefined
      ) return;
      runtime.status = status;
      runtime.controlStatus = undefined;
      if (status === "active" || status === "waiting" || status === "ready") {
        runtime.ingressStopped = false;
      } else {
        runtime.ingressStopped = true;
      }
    }, false, priority);
    if (event === undefined || runtime.evidenceFailureStarted) {
      if (status === "closing" || status === "closed") {
        runtime.status = status;
        runtime.controlStatus = undefined;
        runtime.ingressStopped = true;
        return;
      }
      throw new Error("Evidence rejected session state event");
    }
  }

  #beginControlStatus(
    runtime: SessionRuntime,
    status: SessionStatus,
    commandId?: string,
  ): Promise<SessionEvent | undefined> {
    if (runtime.status === status) return Promise.resolve(undefined);
    if (runtime.evidenceFailureStarted && (status === "closing" || status === "closed")) {
      runtime.status = status;
      runtime.controlStatus = undefined;
      runtime.ingressStopped = true;
      return Promise.resolve(undefined);
    }
    const previousStatus = runtime.status;
    // Reserve the control transition synchronously so ingress and generation
    // work stop immediately, while the public snapshot remains at the last
    // durably persisted status until the priority event commits.
    runtime.controlStatus = status;
    runtime.ingressStopped = true;
    const task = this.#emit(
      runtime,
      {
        type: "session_state",
        previousStatus,
        status,
        ...(commandId === undefined ? {} : { commandId }),
      },
      null,
      null,
      true,
      () => {
        if (
          runtime.evidenceFailureStarted ||
          runtime.controlStatus !== status ||
          runtime.status !== previousStatus
        ) return;
        runtime.status = status;
        runtime.controlStatus = undefined;
        runtime.ingressStopped = !(status === "active" || status === "waiting" || status === "ready");
      },
      false,
      true,
    );
    const boundedTask = this.#valueBounded(task, this.#evidenceOperationTimeoutMs).then((result) => {
      if (!result.ok) {
        this.#failEvidence(runtime);
        return undefined;
      }
      return result.value;
    });
    void boundedTask.then((event) => {
      if (event === undefined && runtime.controlStatus === status) {
        runtime.controlStatus = undefined;
      }
    });
    return boundedTask;
  }

  #emitAlert(
    runtime: SessionRuntime,
    lane: Lane | null,
    generation: number | null,
    code: string,
    message: string,
    retryable: boolean,
    evidenceRef?: string,
    metadata: AlertMetadata = {},
  ): void {
    this.#emit(
      runtime,
      {
        type: "alert",
        alert: Object.freeze({
          code,
          message,
          retryable,
          ...(metadata.termId === undefined ? {} : { termId: metadata.termId }),
          ...(isUnitInterval(metadata.confidence) ? { confidence: metadata.confidence } : {}),
        }),
        ...(evidenceRef === undefined ? {} : { evidenceRef }),
      },
      lane,
      generation,
    );
  }

  #emit(
    runtime: SessionRuntime,
    payload: Readonly<Record<string, unknown> & { type: SessionEvent["type"] }>,
    lane: Lane | null = null,
    generation: number | null = null,
    persist = true,
    afterPersistBeforePublish?: () => void,
    emergency = false,
    priority = false,
    evidencePayload?: Readonly<Record<string, unknown>>,
    withdrawal = false,
  ): Promise<SessionEvent | undefined> {
    const terminal =
      (payload.type === "session_state" &&
        (payload.status === "closing" || payload.status === "closed")) ||
      (payload.type === "generation_cut" && payload.reason === "end");
    const task = this.#enqueueEvidenceOperation(runtime, async () => {
      if (persist && runtime.evidenceFailureStarted) return undefined;
      const event = Object.freeze({
        ...payload,
        cursor: runtime.cursor + 1,
        sessionId: runtime.sessionId,
        timestampMonoMs: this.#now(),
        lane,
        generation,
      }) as unknown as SessionEvent;
      if (persist) {
        try {
          await this.#evidence.persist({
            type: "session_event",
            sessionId: runtime.sessionId,
            event: (evidencePayload === undefined
              ? event
              : Object.freeze({
                  ...evidencePayload,
                  cursor: event.cursor,
                  sessionId: event.sessionId,
                  timestampMonoMs: event.timestampMonoMs,
                  lane: event.lane,
                  generation: event.generation,
                })) as SessionEvent,
          });
        } catch {
          this.#failEvidence(runtime);
          return undefined;
        }
        if (runtime.evidenceFailureStarted) return undefined;
        runtime.lastPersistedEventCursor = event.cursor;
      }
      afterPersistBeforePublish?.();
      runtime.cursor = event.cursor;
      runtime.events.push(event);
      if (runtime.events.length > this.#eventHistoryLimit) runtime.events.shift();
      for (const subscriber of runtime.subscribers) subscriber.offer(event);
      return event;
    }, emergency, priority, withdrawal, false, terminal);
    if (task === undefined) return Promise.resolve(undefined);
    return this.#valueBounded(task, this.#evidenceOperationTimeoutMs).then((result) => {
      if (!result.ok) {
        this.#failEvidence(runtime);
        return undefined;
      }
      return result.value;
    });
  }

  #publishWithoutEvidence(
    runtime: SessionRuntime,
    payload: Readonly<Record<string, unknown> & { type: SessionEvent["type"] }>,
    lane: Lane | null = null,
    generation: number | null = null,
  ): SessionEvent {
    const event = Object.freeze({
      ...payload,
      cursor: runtime.cursor + 1,
      sessionId: runtime.sessionId,
      timestampMonoMs: this.#now(),
      lane,
      generation,
    }) as unknown as SessionEvent;
    runtime.cursor = event.cursor;
    runtime.events.push(event);
    if (runtime.events.length > this.#eventHistoryLimit) runtime.events.shift();
    for (const subscriber of runtime.subscribers) subscriber.offer(event);
    return event;
  }

  #enqueueEvidenceOperation<T>(
    runtime: SessionRuntime,
    operation: () => Promise<T>,
    emergency = false,
    priority = false,
    withdrawal = false,
    record = false,
    terminal = false,
  ): Promise<T> | undefined {
    const admissionLimit = emergency
      ? MAX_PENDING_EVIDENCE_OPERATIONS
      : terminal
        ? MAX_TERMINAL_EVIDENCE_OPERATIONS
      : withdrawal
        ? MAX_WITHDRAWAL_EVIDENCE_OPERATIONS
        : priority
          ? MAX_PRIORITY_EVIDENCE_OPERATIONS
          : MAX_NORMAL_EVIDENCE_OPERATIONS;
    if (runtime.pendingEvidenceOperations >= admissionLimit) {
      if (!emergency) this.#failEvidence(runtime);
      return undefined;
    }
    runtime.pendingEvidenceOperations += 1;
    // Session events share one cursor-ordered append tail. Raw evidence
    // records have no event cursor and may continue independently so a held
    // audio write cannot prevent a priority control transition from becoming
    // durable or fencing the session.
    const priorTail = record ? runtime.evidenceRecordTail : runtime.evidenceOperationTail;
    const task = priorTail.then(operation);
    const settled = task.then(
      (result) => {
        runtime.pendingEvidenceOperations -= 1;
        return result;
      },
      (error: unknown) => {
        runtime.pendingEvidenceOperations -= 1;
        throw error;
      },
    );
    const nextTail = settled.then(
      () => undefined,
      () => undefined,
    );
    if (record) runtime.evidenceRecordTail = nextTail;
    else runtime.evidenceOperationTail = nextTail;
    return settled;
  }

  async #drainEvidenceOperations(runtime: SessionRuntime): Promise<boolean> {
    let observedNormal: Promise<void>;
    let observedRecords: Promise<void>;
    do {
      observedNormal = runtime.evidenceOperationTail;
      observedRecords = runtime.evidenceRecordTail;
      const settled = Promise.all([observedNormal, observedRecords]).then(() => undefined);
      const completed = await settleWithin(
        settled.then(() => true),
        this.#evidenceOperationTimeoutMs,
        false,
      );
      if (!completed) return false;
    } while (
      observedNormal !== runtime.evidenceOperationTail ||
      observedRecords !== runtime.evidenceRecordTail
    );
    return true;
  }

  async #drainAdapterTasks(runtime: SessionRuntime): Promise<void> {
    if (runtime.adapterTasks.size === 0) return;
    const settled = Promise.allSettled([...runtime.adapterTasks]).then(() => undefined);
    await settleWithin(settled, ADAPTER_CLEANUP_GRACE_MS, undefined);
  }

  async #drainBackgroundTasks(runtime: SessionRuntime): Promise<boolean> {
    if (runtime.backgroundTasks.size === 0) return true;
    const settled = Promise.allSettled([...runtime.backgroundTasks]).then(() => undefined);
    return this.#awaitBounded(settled, this.#evidenceOperationTimeoutMs);
  }

  async #awaitBounded(
    task: Promise<unknown>,
    timeoutMs = ADAPTER_CLEANUP_GRACE_MS,
  ): Promise<boolean> {
    return settleWithin(task.then(() => true, () => true), timeoutMs, false);
  }

  async #valueBounded<T>(
    task: Promise<T>,
    timeoutMs = ADAPTER_CLEANUP_GRACE_MS,
  ): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
    return settleWithin(
      task.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
      timeoutMs,
      { ok: false as const },
    );
  }

  async #persistEvidence(runtime: SessionRuntime, record: EvidenceRecord): Promise<void> {
    if (runtime.evidenceFailureStarted) {
      throw new Error("Evidence persistence has already failed");
    }
    try {
      const task = this.#enqueueEvidenceOperation(runtime, async () => {
        if (runtime.evidenceFailureStarted) {
          throw new Error("Evidence persistence has already failed");
        }
        await this.#evidence.persist(record);
      }, false, false, false, true);
      if (task === undefined) throw new Error("Evidence operation capacity exceeded");
      const persisted = await this.#valueBounded(task, this.#evidenceOperationTimeoutMs);
      if (!persisted.ok) throw new Error("Evidence persistence timed out");
    } catch {
      this.#failEvidence(runtime);
      throw new Error("Evidence persistence failed");
    }
  }

  #failEvidence(runtime: SessionRuntime): void {
    if (runtime.evidenceFailureStarted) return;
    runtime.evidenceFailureStarted = true;
    // Evidence is already unavailable (and may be stalled behind an
    // unfinished operation), so the authoritative failure alert must not
    // queue on the failed evidence tail. Publish the non-durable alert
    // synchronously before starting terminal cleanup.
    this.#publishWithoutEvidence(runtime, {
      type: "alert",
      alert: Object.freeze({
        code: "evidence_store_failed",
        message: "Authoritative evidence storage failed; ending session",
        retryable: false,
      }),
    });
    void this.#end(runtime, "evidence_store_failure", "evidence_store_failed").catch(() => {});
  }

  #snapshot(runtime: SessionRuntime): SessionSnapshot {
    return Object.freeze({
      sessionId: runtime.sessionId,
      status: runtime.status,
      spec: runtime.spec,
      behavior: runtime.behavior,
      participants: runtime.participants,
      participantConsent: Object.freeze({
        A: Object.freeze({ ...runtime.consent.A }),
        B: Object.freeze({ ...runtime.consent.B }),
      }),
      recorderArmState: runtime.recorderArmState,
      recordingArmed: runtime.recorderArmState === "armed",
      ...(runtime.recorderPreflight === undefined
        ? {}
        : {
            recorderPreflight: Object.isFrozen(runtime.recorderPreflight)
              ? runtime.recorderPreflight
              : cloneAndFreeze(runtime.recorderPreflight),
          }),
      participantReadiness: Object.freeze({
        A: runtime.participantReadiness.A,
        B: runtime.participantReadiness.B,
      }),
      providerReadiness: Object.freeze({
        A_TO_B: runtime.providerReadiness.A_TO_B,
        B_TO_A: runtime.providerReadiness.B_TO_A,
      }),
      ...(runtime.evidenceFinalization === undefined
        ? {}
        : {
            evidenceFinalization: Object.isFrozen(runtime.evidenceFinalization)
              ? runtime.evidenceFinalization
              : cloneAndFreeze(runtime.evidenceFinalization),
          }),
      generations: Object.freeze({
        A_TO_B: runtime.fences.A_TO_B.generation,
        B_TO_A: runtime.fences.B_TO_A.generation,
      }),
      ...(runtime.compiledGlossary === undefined
        ? {}
        : {
            glossary: Object.freeze({
              id: runtime.compiledGlossary.id,
              version: runtime.compiledGlossary.version,
              hash: runtime.compiledGlossary.hash,
            }),
          }),
      eventCursor: runtime.cursor,
      openedAtMs: runtime.openedAtMs,
      ...(runtime.closedAtMs === undefined ? {} : { closedAtMs: runtime.closedAtMs }),
    });
  }

  #requireSession(sessionId: string): SessionRuntime {
    const runtime = this.#sessions.get(sessionId);
    if (runtime === undefined) {
      throw new RelaySessionError("invalid_session", `Unknown session ${sessionId}`);
    }
    return runtime;
  }

  #invalidState(runtime: SessionRuntime, command: string): RelaySessionError {
    return new RelaySessionError(
      "invalid_command",
      `Cannot ${command} a session in ${runtime.status} state`,
    );
  }

}

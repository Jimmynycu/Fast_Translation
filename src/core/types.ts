import type { AudioFrame } from "./audio.js";
import type { CompiledGlossary, GlossaryAlert, GlossarySpec } from "./glossary.js";
import type {
  TranslationBehavior,
  TranslationMode,
  TranslationProviderId,
} from "./translation-behavior.js";
import type {
  ConsentPolicyReference,
  SessionProcessingManifest,
} from "./processing-profile.js";
import type {
  EvidenceFinalization,
  EvidenceFinalizeRequest,
  RecorderPreflightRequest,
  RecorderPreflightResult,
} from "./evidence-lifecycle.js";

export type {
  TranslationBehavior,
  TranslationMode,
  TranslationProviderId,
} from "./translation-behavior.js";

export const SIDES = ["A", "B"] as const;
export type Side = (typeof SIDES)[number];
export const LANES = ["A_TO_B", "B_TO_A"] as const;
export type Lane = (typeof LANES)[number];

export const MEDIA_PROFILES = ["browser_pair", "fake_telephony"] as const;
export type MediaProfile = (typeof MEDIA_PROFILES)[number];

export interface ParticipantSpec {
  readonly language: string;
  readonly displayName?: string;
}

/**
 * Immutable identities authorized to review one session's finalized evidence.
 * This is durable evidence metadata, never a public-session projection.
 */
export interface EvidenceReviewGrant {
  readonly dataOwnerId: string;
  readonly bilingualReviewerId: string;
}

export interface SessionSpec {
  readonly sideA: ParticipantSpec;
  readonly sideB: ParticipantSpec;
  readonly provider: TranslationProviderId;
  readonly mode: TranslationMode;
  readonly processingManifest: SessionProcessingManifest;
  readonly evidenceReviewGrant: EvidenceReviewGrant;
  readonly glossary?: GlossarySpec;
  readonly maxQueueFrames?: number;
}

export type SessionStatus = "waiting" | "ready" | "active" | "paused" | "closing" | "closed";
export type RecorderArmState =
  | "awaiting_consents"
  | "unarmed"
  | "arming"
  | "armed"
  | "failed";

export interface BrowserParticipantEndpointGrant {
  readonly kind: "browser_link";
  readonly side: Side;
  readonly url: string;
  readonly qrDataUrl: string;
}

export interface TelephonyTestParticipantEndpointGrant {
  readonly kind: "telephony_test";
  readonly side: Side;
  readonly address: string;
}

export type ParticipantEndpointGrant =
  | BrowserParticipantEndpointGrant
  | TelephonyTestParticipantEndpointGrant;

export interface GlossaryReference {
  readonly id: string;
  readonly version: string;
  readonly hash: string;
}

export interface ParticipantConsentState {
  readonly consented: boolean;
  readonly consentId?: string;
  readonly consentPolicyRef?: ConsentPolicyReference;
  readonly recording: boolean;
  readonly processing: boolean;
  readonly withdrawalId?: string;
  readonly withdrawnAtMonoMs?: number;
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly spec: SessionSpec;
  readonly participants: Readonly<{
    readonly A: ParticipantEndpointGrant;
    readonly B: ParticipantEndpointGrant;
  }>;
  readonly participantConsent: Readonly<Record<Side, ParticipantConsentState>>;
  readonly recorderArmState: RecorderArmState;
  readonly recordingArmed: boolean;
  readonly recorderPreflight?: RecorderPreflightResult;
  readonly participantReadiness: Readonly<Record<Side, ParticipantReadiness | undefined>>;
  readonly providerReadiness: Readonly<Record<Lane, TranslationPreparation | undefined>>;
  readonly evidenceFinalization?: EvidenceFinalization;
  readonly generations: Readonly<Record<Lane, number>>;
  readonly behavior: TranslationBehavior;
  readonly glossary?: GlossaryReference;
  readonly eventCursor: EventCursor;
  readonly openedAtMs: number;
  readonly closedAtMs?: number;
}

interface CommandBase { readonly commandId: string; }
export interface StartSessionCommand extends CommandBase { readonly type: "start"; }
export interface PauseSessionCommand extends CommandBase { readonly type: "pause"; }
export interface ResumeSessionCommand extends CommandBase { readonly type: "resume"; }
export interface EndSessionCommand extends CommandBase {
  readonly type: "end";
  readonly reason?: string;
}
export interface ParticipantConsentCommand extends CommandBase {
  readonly type: "participant_consent";
  readonly side: Side;
  readonly consentId: string;
  readonly consentPolicyRef: ConsentPolicyReference;
  readonly recording: true;
  readonly processing: true;
}
export interface ParticipantConsentWithdrawalCommand extends CommandBase {
  readonly type: "participant_consent_withdrawal";
  readonly side: Side;
  readonly consentId: string;
  readonly withdrawalId: string;
  readonly withdrawnAtMonoMs: number;
}
export interface ArmRecorderCommand extends CommandBase {
  readonly type: "arm_recorder";
}
export type RelayCommand =
  | StartSessionCommand
  | PauseSessionCommand
  | ResumeSessionCommand
  | EndSessionCommand
  | ParticipantConsentCommand
  | ParticipantConsentWithdrawalCommand
  | ArmRecorderCommand;

export type EventCursor = number;
interface SessionEventBase {
  readonly cursor: EventCursor;
  readonly sessionId: string;
  readonly timestampMonoMs: number;
  readonly lane: Lane | null;
  readonly generation: number | null;
}

export interface SessionOpenedEvent extends SessionEventBase {
  readonly type: "session_opened";
  readonly snapshot: SessionSnapshot;
}
export interface SessionStateEvent extends SessionEventBase {
  readonly type: "session_state";
  readonly previousStatus: SessionStatus;
  readonly status: SessionStatus;
  readonly commandId?: string;
}
export interface ParticipantStateEvent extends SessionEventBase {
  readonly type: "participant_state";
  readonly side: Side;
  readonly connected: boolean;
}
export interface ParticipantConsentEvent extends SessionEventBase {
  readonly type: "participant_consent";
  readonly side: Side;
  readonly consentId: string;
  readonly consentPolicyRef: ConsentPolicyReference;
  readonly recording: true;
  readonly processing: true;
  readonly acceptedAtMonoMs: number;
}
export interface ParticipantConsentWithdrawalEvent extends SessionEventBase {
  readonly type: "participant_consent_withdrawal";
  readonly side: Side;
  readonly consentId: string;
  readonly withdrawalId: string;
  readonly withdrawnAtMonoMs: number;
  readonly terminal: true;
}
export interface RecorderStateEvent extends SessionEventBase {
  readonly type: "recorder_state";
  readonly previousState: RecorderArmState;
  readonly state: RecorderArmState;
  readonly armedTracks: readonly EvidenceAudioTrack[];
}
export interface RecorderPreflightEvent extends SessionEventBase {
  readonly type: "recorder_preflight";
  readonly preflight: RecorderPreflightResult;
}
export interface ParticipantReadinessEvent extends SessionEventBase, ParticipantReadiness {
  readonly type: "participant_readiness";
  readonly side: Side;
}
export interface ProviderReadinessEvent extends SessionEventBase {
  readonly type: "provider_readiness";
  readonly readiness: TranslationPreparation;
}
interface ProviderDerivedSessionEventBase extends SessionEventBase {
  readonly evidenceRef?: string;
}
export interface TranscriptEvent extends ProviderDerivedSessionEventBase {
  readonly type: "source_transcript" | "target_transcript";
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly text: string;
  readonly final: boolean;
}
export interface AudioPlayoutEvent extends ProviderDerivedSessionEventBase {
  readonly type: "audio_playout";
  readonly turnId: string;
  readonly segmentId: string;
  readonly playoutSequence: number;
  readonly frame: AudioFrame;
  readonly latencyMs: number;
}
export interface GenerationCutEvent extends SessionEventBase {
  readonly type: "generation_cut";
  readonly previousGeneration: number;
  readonly reason: "barge_in" | "pause" | "end" | "operator";
  readonly clearId: string;
  readonly bargeId?: string;
}
export interface SequenceGapEvent extends SessionEventBase {
  readonly type: "sequence_gap";
  readonly stream: "source" | "playout";
  readonly expectedSequence: number;
  readonly actualSequence: number;
  readonly missingCount: number;
  readonly timelineAtMonoMs: number;
}
export interface GlossaryBoundEvent extends ProviderDerivedSessionEventBase {
  readonly type: "glossary_bound";
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly final: boolean;
  readonly glossaryHash: string;
  readonly entryIds: readonly string[];
}
/**
 * Durable terminology decisions carry only glossary provenance. Canonical
 * target text is recorded separately as target transcript/audio evidence.
 */
export interface GlossaryAuthorizedEvent extends ProviderDerivedSessionEventBase {
  readonly type: "glossary_authorized";
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly final: boolean;
  readonly glossaryHash: string;
  readonly entryIds: readonly string[];
}
export interface GlossaryBypassedEvent extends ProviderDerivedSessionEventBase {
  readonly type: "glossary_bypassed";
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly final: boolean;
  readonly glossaryHash: string;
  readonly entryIds: readonly string[];
}
export type QueueTelemetryScope = "relay_input" | "relay_playout" | "browser_playout";
export interface QueueSampleEvent extends SessionEventBase {
  readonly type: "queue_sample";
  readonly scope: QueueTelemetryScope;
  readonly side: Side | null;
  readonly depthFrames: number;
  readonly capacityFrames: number;
  readonly oldestQueuedAgeMs?: number;
  readonly bufferedAudioMs?: number;
}
export interface PlayoutLagEvent extends SessionEventBase {
  readonly type: "playout_lag";
  /** Provider segment identity associated with the first durable audible ACK. */
  readonly turnId?: string;
  readonly segmentId?: string;
  readonly revision?: number;
  readonly scope: "server_to_audible_ack";
  readonly side: Side;
  readonly sequence: number;
  readonly audibleStartLagMs: number;
}
export type BargeLifecycleStage =
  | "speech_onset"
  | "provider_cancel_requested"
  | "provider_cancel_settled"
  | "provider_cancel_failed"
  | "playout_clear_requested"
  | "playout_clear_acknowledged"
  | "playout_clear_failed"
  | "valid_output_resumed";
export interface BargeLifecycleEvent extends SessionEventBase {
  readonly type: "barge_lifecycle";
  readonly stage: BargeLifecycleStage;
  readonly bargeId: string;
  readonly clearId: string;
  readonly sourceSide: Side;
  readonly destinationSide: Side;
  readonly message?: string;
}
export interface RelayAlertEvent extends ProviderDerivedSessionEventBase {
  readonly type: "alert";
  readonly alert: GlossaryAlert | RelayAlert;
}
export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "session_closed";
  readonly reason: string;
  readonly finalization: EvidenceFinalization;
}
export interface RelayAlert {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  /** Present only when the alert is attributable to one glossary entry. */
  readonly termId?: string;
  /** A finite transcription confidence from 0 through 1, when available. */
  readonly confidence?: number;
}
export type SessionEvent =
  | SessionOpenedEvent
  | SessionStateEvent
  | ParticipantStateEvent
  | ParticipantConsentEvent
  | ParticipantConsentWithdrawalEvent
  | RecorderStateEvent
  | RecorderPreflightEvent
  | ParticipantReadinessEvent
  | ProviderReadinessEvent
  | TranscriptEvent
  | AudioPlayoutEvent
  | GenerationCutEvent
  | SequenceGapEvent
  | GlossaryBoundEvent
  | GlossaryAuthorizedEvent
  | GlossaryBypassedEvent
  | QueueSampleEvent
  | PlayoutLagEvent
  | BargeLifecycleEvent
  | RelayAlertEvent
  | SessionClosedEvent;

export interface GuardedDuplexRelay {
  open(spec: SessionSpec): Promise<SessionSnapshot>;
  snapshot(sessionId: string): SessionSnapshot;
  command(sessionId: string, command: RelayCommand): Promise<void>;
  events(sessionId: string, after?: EventCursor, signal?: AbortSignal): AsyncIterable<SessionEvent>;
}

export interface GenerationRef {
  readonly sessionId: string;
  readonly lane: Lane;
  readonly generation: number;
}
export interface LaneContext extends GenerationRef {
  readonly turnId: string;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly behavior: TranslationBehavior;
  readonly glossary?: CompiledGlossary;
}
export interface TranslationRequest {
  readonly frames: AsyncIterable<AudioFrame>;
  readonly context: LaneContext;
  readonly signal: AbortSignal;
}
interface TranslationEventBase extends GenerationRef {
  readonly turnId: string;
  readonly segmentId: string;
  /** A higher revision fully replaces the prior event for this segment. */
  readonly revision: number;
  readonly finality: "provisional" | "final";
  readonly evidenceRef: string;
  readonly emittedAtMs: number;
}
export interface TranslationAudioEvent extends TranslationEventBase {
  readonly kind: "audio";
  /** Target transcript segment that owns this audible audio frame. */
  readonly targetSegmentId: string;
  readonly frame: AudioFrame;
  readonly playoutSequence: number;
}
export interface TranslationTranscriptEvent extends TranslationEventBase {
  readonly kind: "source_transcript" | "target_transcript";
  readonly text: string;
}
export interface TranslationTerminologyEvent extends TranslationEventBase {
  readonly kind: "terminology";
  readonly status: "bound" | "authorized" | "bypassed";
  readonly glossaryHash: string;
  readonly entryIds: readonly string[];
  readonly text: string;
  readonly guaranteedTargetExact: readonly string[];
}
export interface TranslationCompletedEvent extends TranslationEventBase { readonly kind: "completed"; }
export interface TranslationErrorEvent extends TranslationEventBase {
  readonly kind: "error";
  readonly error: Readonly<{
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    /** Present only when the alert is attributable to one glossary entry. */
    readonly termId?: string;
    /** A finite transcription confidence from 0 through 1, when available. */
    readonly confidence?: number;
  }>;
}
export type TranslationRejectionReason =
  | "adapter_tombstone"
  | "unknown_identity"
  | "inactive_session"
  | "wrong_session"
  | "stale_generation"
  | "lane_run_tombstone"
  | "lane_run_generation_mismatch"
  | "lane_run_turn_mismatch"
  | "terminal_revision"
  | "stale_revision"
  | "stale_playout_sequence";
export interface TranslationDiagnosticEvent extends TranslationEventBase {
  readonly kind: "diagnostic";
  readonly reason: TranslationRejectionReason;
}
export type TranslationEvent =
  | TranslationAudioEvent
  | TranslationTranscriptEvent
  | TranslationTerminologyEvent
  | TranslationCompletedEvent
  | TranslationErrorEvent
  | TranslationDiagnosticEvent;

export type TranslationModeState =
  | "native"
  | "locally_controlled"
  | "experimental"
  | "unsupported";

export interface TranslationModeCapability {
  readonly mode: TranslationMode;
  readonly behaviorVersion: TranslationBehavior["version"];
  readonly state: TranslationModeState;
  readonly deterministicGlossary: boolean;
  readonly reason?: string;
}

export interface TranslationCapabilities {
  readonly providerId: TranslationProviderId;
  readonly modes: readonly TranslationModeCapability[];
  readonly supportsProvisionalRevisions: boolean;
  readonly supportsFinality: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsDeterministicGlossary: boolean;
}

export type TranslationPreparation =
  | Readonly<{
      readonly readiness: "local_route_validated";
      readonly remoteConnection: "deferred_until_first_turn";
    }>
  | Readonly<{
      readonly readiness: "remote_task_ready";
      readonly remoteConnection: "connected";
    }>
  | Readonly<{
      readonly readiness: "fixture_local";
      readonly remoteConnection: "not_applicable";
    }>;

/**
 * The operational fallback decision projected from the immutable, approved
 * session processing manifest. Its approval record remains with that manifest;
 * translation ports need only the executable kind.
 */
export type TranslationFallbackPolicy =
  Readonly<Pick<SessionProcessingManifest["fallback"], "kind">>;

export interface TranslationPort {
  readonly capabilities: TranslationCapabilities;
  prepare(context: LaneContext): Promise<TranslationPreparation>;
  translate(request: TranslationRequest): AsyncIterable<TranslationEvent>;
  cancel(generation: GenerationRef): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

interface MediaIngressEventBase {
  readonly sessionId: string;
  readonly side: Side;
  readonly timestampMonoMs: number;
}
export interface ParticipantReadiness {
  readonly microphone: "browser_capture_active" | "stopped" | "not_applicable";
  readonly headphones: "self_attested" | "not_attested" | "not_applicable";
  readonly source: "participant_browser_self_report" | "fake_telephony_fixture";
}
export interface MediaAudioEvent extends MediaIngressEventBase {
  readonly type: "audio";
  readonly frame: AudioFrame;
}
export interface MediaSpeechStartedEvent extends MediaIngressEventBase { readonly type: "speech_started"; }
export interface MediaSpeechEndedEvent extends MediaIngressEventBase { readonly type: "speech_ended"; }
export interface MediaParticipantStateEvent extends MediaIngressEventBase {
  readonly type: "participant_state";
  readonly connected: boolean;
}
export interface MediaParticipantReadinessEvent extends MediaIngressEventBase, ParticipantReadiness {
  readonly type: "participant_readiness";
}
export interface MediaPlayoutClearedEvent extends MediaIngressEventBase {
  readonly type: "playout_cleared";
  readonly lane: Lane;
  readonly generation: number;
  readonly clearId: string;
}
export interface MediaQueueSampleEvent extends MediaIngressEventBase {
  readonly type: "queue_sample";
  readonly scope: "browser_playout";
  readonly lane: Lane;
  readonly generation: number;
  readonly depthFrames: number;
  readonly capacityFrames: number;
  readonly bufferedAudioMs: number;
  readonly oldestQueuedAgeMs?: number;
}
export interface MediaAlertEvent extends MediaIngressEventBase {
  readonly type: "alert";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
export type MediaIngressEvent =
  | MediaAudioEvent
  | MediaSpeechStartedEvent
  | MediaSpeechEndedEvent
  | MediaParticipantStateEvent
  | MediaParticipantReadinessEvent
  | MediaPlayoutClearedEvent
  | MediaQueueSampleEvent
  | MediaAlertEvent;
export interface MediaIngressRequest {
  readonly sessionId: string;
  readonly signal: AbortSignal;
}
export interface MediaPlaybackRequest {
  readonly sessionId: string;
  readonly side: Side;
  readonly frames: AsyncIterable<AudioFrame>;
  readonly signal: AbortSignal;
  readonly onPlayoutStarted: (
    frame: AudioFrame,
    startedAtMonoMs: number,
  ) => void;
}
export interface MediaClearRequest extends GenerationRef {
  readonly side: Side;
  readonly clearId: string;
}
export interface MediaPort {
  frames(request: MediaIngressRequest): AsyncIterable<MediaIngressEvent>;
  play(request: MediaPlaybackRequest): Promise<void>;
  clear(request: MediaClearRequest): Promise<void>;
  closeSession(sessionId: string): Promise<void> | void;
}

export const EVIDENCE_AUDIO_TRACKS = [
  "source_a",
  "source_b",
  "playout_to_a",
  "playout_to_b",
] as const;
export type EvidenceAudioTrack = (typeof EVIDENCE_AUDIO_TRACKS)[number];
export interface EvidenceSessionEventRecord {
  readonly type: "session_event";
  readonly sessionId: string;
  readonly event: SessionEvent;
}
export interface EvidenceAudioRecord {
  readonly type: "audio";
  readonly sessionId: string;
  readonly track: EvidenceAudioTrack;
  readonly timelineAtMonoMs: number;
  readonly frame: AudioFrame;
}
export interface EvidenceRecorderTrackArmedRecord {
  readonly type: "recorder_track_armed";
  readonly sessionId: string;
  readonly track: EvidenceAudioTrack;
  readonly armedAtMonoMs: number;
  readonly consentPolicyRef: ConsentPolicyReference;
}
export interface EvidenceRecorderPreflightRecord {
  readonly type: "recorder_preflight";
  readonly sessionId: string;
  readonly timestampMonoMs: number;
  readonly preflight: RecorderPreflightResult;
}
export interface TranslationRejectedEvidenceIdentity {
  readonly sessionId: string;
  readonly lane: Lane;
  readonly generation: number;
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly finality: "provisional" | "final";
  readonly kind: TranslationEvent["kind"];
  readonly evidenceRef: string;
  readonly emittedAtMs: number;
}
export interface EvidenceTranslationRejectedRecord {
  readonly type: "translation_rejected";
  readonly sessionId: string;
  readonly timestampMonoMs: number;
  readonly reason: TranslationRejectionReason;
  readonly identity: TranslationRejectedEvidenceIdentity;
}
export type EvidenceRecord =
  | EvidenceSessionEventRecord
  | EvidenceAudioRecord
  | EvidenceRecorderPreflightRecord
  | EvidenceRecorderTrackArmedRecord
  | EvidenceTranslationRejectedRecord;
export interface EvidencePort {
  preflightRecorder(request: RecorderPreflightRequest): Promise<RecorderPreflightResult>;
  /** Resolves only after the authoritative record is durably committed. */
  persist(record: EvidenceRecord): Promise<void>;
  flush(sessionId: string): Promise<void>;
  finalize(request: EvidenceFinalizeRequest): Promise<EvidenceFinalization>;
}

export type { AudioFrame } from "./audio.js";
export type {
  ApprovedSessionProcessingProfile,
  ConsentPolicyReference,
  SessionProcessingManifest,
  SessionProcessingProfileReference,
} from "./processing-profile.js";
export type {
  EvidenceFinalization,
  EvidenceFinalizationExpectation,
  EvidenceFinalizeRequest,
  RecorderPreflightRequest,
  RecorderPreflightResult,
} from "./evidence-lifecycle.js";
export type {
  BoundGlossaryText,
  CompiledGlossary,
  GlossaryAlert,
  GlossaryAuthorizationResult,
  GlossaryEntry,
  GlossaryEntrySpec,
  GlossarySpec,
} from "./glossary.js";

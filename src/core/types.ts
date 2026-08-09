import type { AudioFrame } from "./audio.js";
import type { CompiledGlossary, GlossaryAlert, GlossarySpec } from "./glossary.js";
import type {
  TranslationBehavior,
  TranslationMode,
  TranslationProviderId,
} from "./translation-behavior.js";

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

export interface SessionSpec {
  readonly sideA: ParticipantSpec;
  readonly sideB: ParticipantSpec;
  readonly provider: TranslationProviderId;
  readonly mode: TranslationMode;
  readonly glossary?: GlossarySpec;
  readonly maxQueueFrames?: number;
}

export type SessionStatus = "waiting" | "ready" | "active" | "paused" | "closing" | "closed";

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

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly status: SessionStatus;
  readonly spec: SessionSpec;
  readonly participants: Readonly<{
    readonly A: ParticipantEndpointGrant;
    readonly B: ParticipantEndpointGrant;
  }>;
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
export type RelayCommand =
  | StartSessionCommand
  | PauseSessionCommand
  | ResumeSessionCommand
  | EndSessionCommand;

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
export interface TranscriptEvent extends SessionEventBase {
  readonly type: "source_transcript" | "target_transcript";
  readonly turnId: string;
  readonly segmentId: string;
  readonly revision: number;
  readonly text: string;
  readonly final: boolean;
}
export interface AudioPlayoutEvent extends SessionEventBase {
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
}
export interface GlossaryBoundEvent extends SessionEventBase {
  readonly type: "glossary_bound";
  readonly glossaryHash: string;
  readonly entryIds: readonly string[];
}
export interface GlossaryAuthorizedEvent extends SessionEventBase {
  readonly type: "glossary_authorized";
  readonly glossaryHash: string;
  readonly text: string;
  readonly guaranteedTargetExact: readonly string[];
}
export interface RelayAlertEvent extends SessionEventBase {
  readonly type: "alert";
  readonly alert: GlossaryAlert | RelayAlert;
}
export interface SessionClosedEvent extends SessionEventBase {
  readonly type: "session_closed";
  readonly reason: string;
}
export interface RelayAlert {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
export type SessionEvent =
  | SessionOpenedEvent
  | SessionStateEvent
  | ParticipantStateEvent
  | TranscriptEvent
  | AudioPlayoutEvent
  | GenerationCutEvent
  | GlossaryBoundEvent
  | GlossaryAuthorizedEvent
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
  readonly evidenceRef?: string;
  readonly emittedAtMs: number;
}
export interface TranslationAudioEvent extends TranslationEventBase {
  readonly kind: "audio";
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
  }>;
}
export type TranslationEvent =
  | TranslationAudioEvent
  | TranslationTranscriptEvent
  | TranslationTerminologyEvent
  | TranslationCompletedEvent
  | TranslationErrorEvent;

export interface TranslationModeCapability {
  readonly mode: TranslationMode;
  readonly behaviorVersion: TranslationBehavior["version"];
  readonly deterministicGlossary: boolean;
  readonly degradation?: string;
}

export interface TranslationCapabilities {
  readonly providerId: TranslationProviderId;
  readonly supportedModes: readonly TranslationModeCapability[];
  readonly supportsProvisionalRevisions: boolean;
  readonly supportsFinality: boolean;
  readonly supportsCancellation: boolean;
  readonly supportsDeterministicGlossary: boolean;
}

export interface TranslationPort {
  readonly capabilities: TranslationCapabilities;
  prepare(context: LaneContext): Promise<void>;
  translate(request: TranslationRequest): AsyncIterable<TranslationEvent>;
  cancel(generation: GenerationRef): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}

interface MediaIngressEventBase {
  readonly sessionId: string;
  readonly side: Side;
  readonly timestampMonoMs: number;
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
export interface MediaClearRequest extends GenerationRef { readonly side: Side; }
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
export type EvidenceRecord = EvidenceSessionEventRecord | EvidenceAudioRecord;
export interface EvidencePort {
  record(record: EvidenceRecord): boolean;
  close(sessionId: string): Promise<void>;
}

export type { AudioFrame } from "./audio.js";
export type {
  BoundGlossaryText,
  CompiledGlossary,
  GlossaryAlert,
  GlossaryAuthorizationResult,
  GlossaryEntry,
  GlossaryEntrySpec,
  GlossarySpec,
} from "./glossary.js";

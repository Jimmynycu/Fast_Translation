import type { ServerOptions as HttpsServerOptions } from "node:https";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import { z, ZodError } from "zod";
import type {
  EvidenceRootProcessLease,
  RetentionExtensionResult,
  RetentionSweepHealth,
  SessionArtifactManagementPort,
} from "../adapters/evidence/session-artifact-store.js";
import { exportManagedFinalizedEvidence } from "../adapters/evidence/export.js";
import type {
  EvidenceReview,
  EvidenceReviewActor,
  EvidenceReviewMetadataRecord,
  EvidenceReviewResult,
} from "../adapters/evidence/review.js";
import { CANONICAL_AUDIO, destinationForLane, sourceForLane } from "../core/audio.js";
import { compileGlossary, type GlossarySpec } from "../core/glossary.js";
import {
  createSessionProcessingManifest,
  validateApprovedSessionProcessingProfile,
  validateSessionSpecAgainstProcessingProfile,
  type ApprovedSessionProcessingProfile,
} from "../core/processing-profile.js";
import { RelaySessionError } from "../core/relay.js";
import {
  isSelectableTranslationMode,
  modeCapability,
  validateTranslationCapabilities,
} from "../core/translation-capabilities.js";
import {
  type GuardedDuplexRelay,
  type EvidenceFinalization,
  type Lane,
  type MediaProfile,
  type ParticipantConsentState,
  type ParticipantEndpointGrant,
  type ParticipantReadiness,
  type RecorderPreflightResult,
  type RelayCommand,
  type SessionEvent,
  type SessionSnapshot,
  type Side,
  type TranslationCapabilities,
  type TranslationMode,
  type TranslationModeCapability,
  type TranslationPreparation,
  type TranslationProviderId,
} from "../core/types.js";
import type { EventAccessScope, ServerAccessControl } from "./access.js";
import {
  createSessionRequestSchema,
  importGlossaryRequestSchema,
  participantRecordingProcessingConsentRequestSchema,
  participantRecordingProcessingWithdrawalRequestSchema,
  sessionCommandSchema,
  sideSchema,
  type ImportGlossaryRequest,
} from "./protocol.js";
import {
  earlyEvidenceDeletionRequestSchema,
  evidenceReviewAudioWindowRequestSchema,
  evidenceReviewMetadataRequestSchema,
  managedPlaintextExportRequestSchema,
  retentionExtensionRequestSchema,
} from "./retention-protocol.js";

export interface GlossaryImportResult {
  readonly version: string;
  readonly hash: string;
  readonly spec: GlossarySpec;
}

export interface GlossaryLease {
  readonly spec: GlossarySpec;
  release(): Promise<void>;
}

export interface GlossaryRootLease {
  release(): Promise<void>;
}

export interface GlossaryDeletionCommand {
  readonly version: string;
  readonly commandId: string;
  readonly ownerId: string;
  readonly reason: string;
  readonly requestedAtMs: number;
}

export type GlossaryDeletionResult =
  | Readonly<{
      readonly status: "completed";
      readonly deletionReceiptId: string;
      readonly requestedAtMs: number;
      readonly deletedAtMs: number;
    }>
  | Readonly<{ readonly status: "active" | "not_found" | "conflict" }>;

export interface GlossaryRegistry {
  acquireRootLease(): Promise<GlossaryRootLease>;
  importFile(request: ImportGlossaryRequest): Promise<GlossaryImportResult>;
  acquire(version: string): Promise<GlossaryLease | undefined>;
  deleteVersion(command: GlossaryDeletionCommand): Promise<GlossaryDeletionResult>;
}

export type BrowserMediaSocketListener = (...args: readonly unknown[]) => void;

export interface BrowserMediaSocket {
  readonly readyState?: number;
  on(event: string, listener: BrowserMediaSocketListener): unknown;
  off?(event: string, listener: BrowserMediaSocketListener): unknown;
  send(data: string | Uint8Array): void;
}

export interface EventSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount?: number;
  once(event: string, listener: BrowserMediaSocketListener): unknown;
  off?(event: string, listener: BrowserMediaSocketListener): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface BrowserMediaGateway {
  attach(sessionId: string, side: Side, socket: BrowserMediaSocket): void;
  detach(sessionId: string, side: Side, socket: BrowserMediaSocket): void;
}

export type EvidenceHealth = "healthy" | "degraded";

export interface ConfiguredTranslation extends TranslationCapabilities {
  readonly defaultMode: TranslationMode;
}

export interface EvidenceIdentity {
  readonly deploymentBuildSha256: string;
  readonly processingProfile: Readonly<{
    readonly id: string;
    readonly version: string;
    readonly sha256: string;
  }>;
  readonly processingManifestSha256: string;
  readonly servicesSha256: string;
}

/**
 * Governance-only artifact boundary consumed by the HTTP server. Evidence
 * ingest and finalization stay behind the relay/store composition boundary.
 */
export type ServerArtifactGovernancePort = Pick<
  SessionArtifactManagementPort,
  | "recover"
  | "sweepExpired"
  | "getRetentionSweepHealth"
  | "extendRetention"
  | "deleteEvidence"
  | "acquireEvidenceRootLease"
  | "withManagedExportLease"
>;

export interface ServerAppOptions {
  readonly relay: GuardedDuplexRelay;
  readonly glossaries: GlossaryRegistry;
  readonly mediaProfile?: MediaProfile;
  readonly browserMedia?: BrowserMediaGateway;
  readonly access: ServerAccessControl;
  readonly webRoot?: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly https?: HttpsServerOptions;
  readonly translation: ConfiguredTranslation;
  readonly processingProfile: ApprovedSessionProcessingProfile;
  readonly deploymentBuildSha256: string;
  readonly artifacts: ServerArtifactGovernancePort;
  /** Sole HTTP-facing boundary for sealed and durably audited evidence review. */
  readonly evidenceReview: Pick<EvidenceReview, "review">;
  readonly evidenceHealth?: () => EvidenceHealth;
}

export interface UiEventEnvelope {
  readonly cursor?: number;
  readonly sessionId: string;
  readonly timestampMonoMs: number;
  readonly lane?: Lane;
  readonly generation?: number;
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
}

const MAX_HTTP_BODY_BYTES = 32 * 1024 * 1024;
const MAX_SMALL_HTTP_BODY_BYTES = 64 * 1024;
const MAX_GLOSSARY_HTTP_BODY_BYTES = 8 * 1024 * 1024;
const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1_000;
/**
 * Per-client unflushed event data limit. This matches the browser-media send
 * budget so a slow event client cannot retain an unbounded server-side queue.
 */
export const MAX_EVENT_SOCKET_BUFFERED_BYTES = 24 * 1024;
/** Maximum inbound WebSocket message; leaves room for media controls and 960-byte audio frames. */
export const MAX_WEBSOCKET_PAYLOAD_BYTES = 4 * 1024;
/** Maximum number of authenticated event streams that one session may serve. */
export const MAX_EVENT_SUBSCRIPTIONS_PER_SESSION = 4;
/** Maximum number of authenticated event streams that one app instance may serve. */
export const MAX_EVENT_SUBSCRIPTIONS_GLOBAL = 32;
const EVENT_SOCKET_POLICY_CLOSE_CODE = 1008;
const EVENT_SOCKET_BACKPRESSURE_REASON = "Event stream backpressure";
const EVENT_SOCKET_CAPACITY_CLOSE_CODE = 1013;
const EVENT_SOCKET_CAPACITY_CLOSE_REASON = "Event stream capacity exceeded";
const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_ALERT_CODES = new Set([
  "aborted",
  "configuration_error",
  "connection_failed",
  "evidence_store_failed",
  "glossary_mismatch",
  "invalid_input",
  "invalid_participant_state",
  "invalid_participant_readiness",
  "invalid_playout_clear_ack",
  "invalid_playout_sequence",
  "invalid_playout_timeline",
  "invalid_queue_sample",
  "invalid_response",
  "invalid_source_sequence",
  "media_cleanup_failed",
  "media_ingress_failed",
  "media_playout_failed",
  "participant_disconnected",
  "placeholder_duplicate",
  "placeholder_missing",
  "placeholder_reordered",
  "placeholder_unknown",
  "playout_clear_failed",
  "playout_clear_tracking_trimmed",
  "playout_metadata_trimmed",
  "playout_queue_trimmed",
  "provider_cancel_failed",
  "provider_error",
  "request_failed",
  "source_queue_overflow",
  "source_input_closed",
  "source_queue_trimmed",
  "target_exact_missing",
  "timeout",
  "GLOSSARY_BYPASSED_TRANSLATION_FALLBACK",
  "GLOSSARY_DIRECTION_MISMATCH",
  "GLOSSARY_GLOSSARY_MISMATCH",
  "GLOSSARY_PLACEHOLDER_DUPLICATE",
  "GLOSSARY_PLACEHOLDER_MISSING",
  "GLOSSARY_PLACEHOLDER_REORDERED",
  "GLOSSARY_PLACEHOLDER_UNKNOWN",
  "GLOSSARY_TARGET_EXACT_MISSING",
  "GLOSSARY_UNKNOWN_OR_AMBIGUOUS_TERM",
  "TEXT_TRANSLATION_FALLBACK",
  "TRANSCRIPTION_FAILED",
  "TRANSCRIPTION_LOW_CONFIDENCE",
  "TTS_FAILED",
  "PALABRA_ABORTED",
  "PALABRA_CONFIGURATION",
  "PALABRA_CONNECTION",
  "PALABRA_CONNECT_TIMEOUT",
  "PALABRA_GLOSSARY_UNSUPPORTED",
  "PALABRA_INPUT",
  "PALABRA_INPUT_FORMAT",
  "PALABRA_INVALID_AUDIO",
  "PALABRA_INVALID_PAYLOAD",
  "PALABRA_LOCAL_AUDIO_QUEUE_TRIMMED",
  "PALABRA_PREPARE",
  "PALABRA_READINESS_TIMEOUT",
  "PALABRA_TURN_TIMEOUT",
  "translation_cleanup_failed",
  "translation_failed",
  "translation_prepare_failed",
  "wrong_lane_media",
  "wrong_session_media",
]);

class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type CompletedEvidenceReview = Extract<
  EvidenceReviewResult,
  Readonly<{ readonly status: "completed" }>
>;

type CompletedMetadataEvidenceReview = Extract<
  CompletedEvidenceReview,
  Readonly<{ readonly kind: "metadata_page" }>
>;

type CompletedAudioEvidenceReview = Extract<
  CompletedEvidenceReview,
  Readonly<{ readonly kind: "audio_window" }>
>;

type CompletedRetentionEvidenceReview = Extract<
  CompletedEvidenceReview,
  Readonly<{ readonly kind: "retention_summary" }>
>;

async function noStoreEvidenceResponse(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.header("cache-control", "no-store");
}

function requireOperator(
  access: ServerAccessControl,
  authorization: string | undefined,
): void {
  if (!access.acceptsOperatorAuthorization(authorization)) {
    throw new ApiError(
      401,
      "unauthorized",
      "A valid operator bearer token is required",
    );
  }
}

function requireEvidenceManagementAccess(
  access: ServerAccessControl,
  authorization: string | undefined,
) {
  const scope = access.resolveEvidenceManagementAuthorization(authorization);
  if (scope === undefined) {
    throw new ApiError(
      401,
      "unauthorized",
      "A valid evidence management bearer token is required",
    );
  }
  return scope;
}

function requireEvidenceReviewActor(
  access: ServerAccessControl,
  authorization: string | undefined,
): EvidenceReviewActor {
  const scope = requireEvidenceManagementAccess(access, authorization);
  return Object.freeze({ role: scope.kind, actorId: scope.actorId });
}

function requireRetentionOwner(
  access: ServerAccessControl,
  authorization: string | undefined,
): string {
  const scope = requireEvidenceManagementAccess(access, authorization);
  if (scope.kind !== "retention_owner") {
    throw new ApiError(
      401,
      "unauthorized",
      "A valid retention owner bearer token is required",
    );
  }
  return scope.actorId;
}

function retentionTimestamp(epochMs: number): string {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new Error("Artifact retention timestamp is invalid");
  }
  return new Date(epochMs).toISOString();
}

function extendedRetentionPayload(result: RetentionExtensionResult) {
  if (
    result.status !== "extended" ||
    result.retentionDeadlineAtMs === undefined ||
    result.extensionUsed !== true
  ) {
    throw new Error("Artifact retention extension result is invalid");
  }
  return {
    status: result.status,
    retentionDeadlineAt: retentionTimestamp(result.retentionDeadlineAtMs),
    extensionUsed: true,
  };
}

function completedEvidenceReview(result: EvidenceReviewResult): CompletedEvidenceReview {
  if (result.status === "completed") return result;
  switch (result.status) {
    case "not_found":
    case "grant_denied":
      throw new ApiError(404, "evidence_not_found", "Evidence was not found");
    case "not_sealed":
      throw new ApiError(409, "evidence_not_sealed", "Evidence is not sealed");
    case "expired":
      throw new ApiError(410, "evidence_expired", "Evidence retention has expired");
    case "integrity_failed":
    case "audit_failed":
      throw new ApiError(
        503,
        "evidence_review_unavailable",
        "Evidence review is temporarily unavailable",
      );
  }
}

function safeReviewMetadataRecord(
  record: EvidenceReviewMetadataRecord,
): Readonly<Record<string, unknown>> {
  switch (record.kind) {
    case "transcript":
      return Object.freeze({
        kind: record.kind,
        direction: record.direction,
        turnId: record.turnId,
        segmentId: record.segmentId,
        revision: record.revision,
        text: record.text,
      });
    case "glossary_provenance":
      return Object.freeze({
        kind: record.kind,
        action: record.action,
        turnId: record.turnId,
        segmentId: record.segmentId,
        revision: record.revision,
        glossaryHash: record.glossaryHash,
        entryIds: Object.freeze([...record.entryIds]),
      });
    case "alert":
      return Object.freeze({ kind: record.kind, code: record.code });
  }
}

function safeMetadataReviewPayload(result: CompletedMetadataEvidenceReview) {
  return Object.freeze({
    status: "completed" as const,
    summary: Object.freeze({
      finalizationSha256: result.summary.finalizationSha256,
      durationMs: result.summary.durationMs,
      recordCount: result.summary.recordCount,
      retentionDeadlineAt: retentionTimestamp(result.summary.retentionDeadlineAtMs),
    }),
    records: Object.freeze(result.records.map(safeReviewMetadataRecord)),
    ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }),
  });
}

function sealedRetentionReviewPayload(result: CompletedRetentionEvidenceReview) {
  return Object.freeze({
    status: "sealed" as const,
    retentionDeadlineAt: retentionTimestamp(result.summary.retentionDeadlineAtMs),
  });
}

function expectMetadataReview(
  result: CompletedEvidenceReview,
): CompletedMetadataEvidenceReview {
  if (result.kind === "metadata_page") return result;
  throw new Error("Evidence review returned the wrong response type");
}

function expectAudioReview(
  result: CompletedEvidenceReview,
): CompletedAudioEvidenceReview {
  if (result.kind === "audio_window") return result;
  throw new Error("Evidence review returned the wrong response type");
}

function expectRetentionReview(
  result: CompletedEvidenceReview,
): CompletedRetentionEvidenceReview {
  if (result.kind === "retention_summary") return result;
  throw new Error("Evidence review returned the wrong response type");
}

function requireExactParticipant(
  access: ServerAccessControl,
  authorization: string | undefined,
  sessionId: string,
  side: Side,
): void {
  if (!access.acceptsParticipantAuthorization(authorization, sessionId, side)) {
    throw new ApiError(
      401,
      "unauthorized",
      "A valid participant bearer token for this side is required",
    );
  }
}

function queryAccess(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function parseEvidenceReviewBody<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    return parse(schema, value);
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new ApiError(400, "invalid_request", "Evidence review request is invalid");
    }
    throw error;
  }
}

function eventBase(event: SessionEvent): Omit<UiEventEnvelope, "type" | "data"> {
  return {
    cursor: event.cursor,
    sessionId: event.sessionId,
    timestampMonoMs: event.timestampMonoMs,
    ...(event.lane === null ? {} : { lane: event.lane }),
    ...(event.generation === null ? {} : { generation: event.generation }),
  };
}

function laneSides(event: SessionEvent): Readonly<{
  sourceSide?: Side;
  targetSide?: Side;
}> {
  if (event.lane === null) return {};
  return {
    sourceSide: sourceForLane(event.lane),
    targetSide: destinationForLane(event.lane),
  };
}

function isParticipantEventVisible(event: SessionEvent, side: Side): boolean {
  switch (event.type) {
    case "session_opened":
    case "session_state":
    case "session_closed":
      return true;
    case "participant_state":
    case "participant_consent":
    case "participant_consent_withdrawal":
      return event.side === side;
    case "recorder_state":
      return true;
    case "recorder_preflight":
    case "participant_readiness":
    case "provider_readiness":
    case "queue_sample":
    case "playout_lag":
    case "barge_lifecycle":
    case "sequence_gap":
      return false;
    case "source_transcript":
    case "glossary_bound":
      return event.lane !== null && sourceForLane(event.lane) === side;
    case "target_transcript":
    case "generation_cut":
    case "glossary_authorized":
    case "glossary_bypassed":
      return event.lane !== null && destinationForLane(event.lane) === side;
    case "alert":
      return event.lane !== null && destinationForLane(event.lane) === side;
    case "audio_playout":
      return false;
  }
  throw new Error("Unsupported session event");
}

function isTerminologyAlert(event: Extract<SessionEvent, { type: "alert" }>): boolean {
  if ("type" in event.alert && event.alert.type === "glossary_control_bypassed") {
    return true;
  }
  const code = event.alert.code.toLocaleUpperCase("en-US");
  return code.startsWith("GLOSSARY_") || code === "TRANSCRIPTION_LOW_CONFIDENCE";
}

function isGlossaryControlBypassed(
  event: Extract<SessionEvent, { type: "alert" }>,
): boolean {
  return "type" in event.alert && event.alert.type === "glossary_control_bypassed";
}

function safeAlertCode(code: string): string {
  return SAFE_ALERT_CODES.has(code) ? code : "unclassified_relay_alert";
}

function safeAlert(
  event: Extract<SessionEvent, { type: "alert" }>,
): Readonly<Record<string, unknown>> {
  const alert = event.alert;
  if ("type" in alert && alert.type === "glossary_control_bypassed") {
    return Object.freeze({
      code: safeAlertCode(alert.code),
      message: "Terminology control was bypassed.",
      ...(alert.termId === undefined ? {} : { termId: alert.termId }),
      glossaryId: alert.glossaryId,
      glossaryVersion: alert.glossaryVersion,
      glossaryHash: alert.glossaryHash,
      expectedPlaceholders: alert.expectedPlaceholders,
      observedPlaceholders: alert.observedPlaceholders,
    });
  }
  return Object.freeze({
    code: safeAlertCode(alert.code),
    message: "An operational relay error occurred.",
    retryable: "retryable" in alert ? alert.retryable : false,
    ...(alert.termId === undefined ? {} : { termId: alert.termId }),
    ...("confidence" in alert && alert.confidence !== undefined
      ? { confidence: alert.confidence }
      : {}),
  });
}

function safeRecorderPreflight(
  preflight: RecorderPreflightResult,
): Readonly<Record<string, unknown>> {
  if (preflight.status === "failed") {
    return Object.freeze({
      status: preflight.status,
      checkedAtMonoMs: preflight.checkedAtMonoMs,
      failureCode: preflight.failureCode,
    });
  }
  return Object.freeze({
    status: preflight.status,
    checkedAtMonoMs: preflight.checkedAtMonoMs,
    requiredFreeBytes: preflight.requiredFreeBytes,
    availableFreeBytes: preflight.availableFreeBytes,
    tracks: preflight.tracks,
    manifestSha256: preflight.manifestSha256,
    encryptedSpoolSha256: preflight.encryptedSpoolSha256,
    sealedRecordCount: preflight.sealedRecordCount,
    sealSha256: preflight.sealSha256,
  });
}

export type EvidenceFinalizationSummary =
  | Readonly<{
      readonly status: "sealed";
      readonly manifestSha256: string;
      readonly encryptedLedgerSha256: string;
      readonly finalChainSha256: string;
      readonly retentionDeadlineAt: string;
      readonly tracks: Readonly<Record<
        "source_a" | "source_b" | "playout_to_a" | "playout_to_b",
        Readonly<{ readonly sha256: string; readonly frameCount: number; readonly byteCount: number }>
      >>;
    }>
  | Readonly<{
      readonly status: "FINALIZATION_FAILED";
      readonly failureCode: "seal_write_failed" | "integrity_verification_failed" | "manifest_write_failed";
      readonly recovery: "rebuild_from_spool" | "quarantine_delete_rerun";
    }>;

function safeEvidenceFinalization(
  finalization: EvidenceFinalization,
): EvidenceFinalizationSummary {
  if (finalization.status === "FINALIZATION_FAILED") {
    return Object.freeze({
      status: finalization.status,
      failureCode: finalization.failureCode,
      recovery: finalization.recovery,
    });
  }
  return Object.freeze({
    status: finalization.status,
    manifestSha256: finalization.manifestSha256,
    encryptedLedgerSha256: finalization.encryptedLedgerSha256,
    finalChainSha256: finalization.finalChainSha256,
    retentionDeadlineAt: finalization.retentionDeadlineAt,
    tracks: Object.freeze({
      source_a: Object.freeze({
        sha256: finalization.tracks.source_a.sha256,
        frameCount: finalization.tracks.source_a.frameCount,
        byteCount: finalization.tracks.source_a.byteCount,
      }),
      source_b: Object.freeze({
        sha256: finalization.tracks.source_b.sha256,
        frameCount: finalization.tracks.source_b.frameCount,
        byteCount: finalization.tracks.source_b.byteCount,
      }),
      playout_to_a: Object.freeze({
        sha256: finalization.tracks.playout_to_a.sha256,
        frameCount: finalization.tracks.playout_to_a.frameCount,
        byteCount: finalization.tracks.playout_to_a.byteCount,
      }),
      playout_to_b: Object.freeze({
        sha256: finalization.tracks.playout_to_b.sha256,
        frameCount: finalization.tracks.playout_to_b.frameCount,
        byteCount: finalization.tracks.playout_to_b.byteCount,
      }),
    }),
  });
}

function requiresSyntheticOnlyAdmission(profile: ApprovedSessionProcessingProfile): boolean {
  return profile.services.some((service) =>
    service.trainingUse.status === "unverified" || service.serviceRetention.status === "unverified"
  );
}

function safeParticipantReadiness(
  readiness: ParticipantReadiness,
): Readonly<ParticipantReadiness> {
  return Object.freeze({
    microphone: readiness.microphone,
    headphones: readiness.headphones,
    source: readiness.source,
  });
}

function safeParticipantConsent(
  consent: ParticipantConsentState,
): Readonly<Pick<ParticipantConsentState, "consented" | "recording" | "processing">> {
  return Object.freeze({
    consented: consent.consented,
    recording: consent.recording,
    processing: consent.processing,
  });
}

function safeEndpointGrant(grant: ParticipantEndpointGrant): Readonly<ParticipantEndpointGrant> {
  switch (grant.kind) {
    case "browser_link":
      return Object.freeze({
        kind: grant.kind,
        side: grant.side,
        url: grant.url,
        qrDataUrl: grant.qrDataUrl,
      });
    case "telephony_test":
      return Object.freeze({
        kind: grant.kind,
        side: grant.side,
        address: grant.address,
      });
    default:
      throw new TypeError("participant endpoint grant is invalid");
  }
}

function safeProviderReadiness(
  readiness: TranslationPreparation,
): Readonly<TranslationPreparation> {
  switch (readiness.readiness) {
    case "local_route_validated":
      return Object.freeze({
        readiness: "local_route_validated" as const,
        remoteConnection: "deferred_until_first_turn" as const,
      });
    case "remote_task_ready":
      return Object.freeze({
        readiness: "remote_task_ready" as const,
        remoteConnection: "connected" as const,
      });
    case "fixture_local":
      return Object.freeze({
        readiness: "fixture_local" as const,
        remoteConnection: "not_applicable" as const,
      });
  }
}

function snapshotOperationalReadiness(snapshot: SessionSnapshot): Readonly<{
  participantReadiness: Readonly<Partial<Record<Side, Readonly<ParticipantReadiness>>>>;
  providerReadiness: Readonly<Partial<Record<Lane, Readonly<TranslationPreparation>>>>;
}> {
  const participantReadiness: Partial<Record<Side, Readonly<ParticipantReadiness>>> = {};
  for (const side of ["A", "B"] as const) {
    const readiness = snapshot.participantReadiness[side];
    if (readiness !== undefined) participantReadiness[side] = safeParticipantReadiness(readiness);
  }
  const providerReadiness: Partial<Record<Lane, Readonly<TranslationPreparation>>> = {};
  for (const lane of ["A_TO_B", "B_TO_A"] as const) {
    const readiness = snapshot.providerReadiness[lane];
    if (readiness !== undefined) providerReadiness[lane] = safeProviderReadiness(readiness);
  }
  return Object.freeze({
    participantReadiness: Object.freeze(participantReadiness),
    providerReadiness: Object.freeze(providerReadiness),
  });
}

function mapSessionEvent(
  event: SessionEvent,
  processingProfile: ApprovedSessionProcessingProfile,
  deploymentBuildSha256: string,
  includeOperatorEvidence: boolean,
): UiEventEnvelope {
  const base = eventBase(event);
  const sides = laneSides(event);

  switch (event.type) {
    case "session_opened":
      return {
        ...base,
        type: "session_state",
        data: {
          state: event.snapshot.status,
          status: event.snapshot.status,
          processingDisclosure: publicProcessingDisclosure(event.snapshot, processingProfile),
          ...(includeOperatorEvidence
            ? {
                evidenceIdentity: evidenceIdentity(
                  event.snapshot,
                  processingProfile,
                  deploymentBuildSha256,
                ),
                ...(event.snapshot.recorderPreflight === undefined
                  ? {}
                  : { recorderPreflight: safeRecorderPreflight(event.snapshot.recorderPreflight) }),
                ...(event.snapshot.evidenceFinalization === undefined
                  ? {}
                  : { evidenceFinalization: safeEvidenceFinalization(event.snapshot.evidenceFinalization) }),
                ...snapshotOperationalReadiness(event.snapshot),
              }
            : {}),
        },
      };
    case "session_state":
      return {
        ...base,
        type: "session_state",
        data: {
          state: event.status,
          status: event.status,
          previousState: event.previousStatus,
          ...(event.commandId === undefined ? {} : { commandId: event.commandId }),
        },
      };
    case "participant_state":
      return {
        ...base,
        type: event.connected ? "participant_joined" : "participant_left",
        data: { side: event.side },
      };
    case "participant_consent":
      return {
        ...base,
        type: "participant_consent",
        data: {
          side: event.side,
          accepted: true,
          recording: event.recording,
          processing: event.processing,
          noticeVersion: event.consentPolicyRef.noticeVersion,
          acceptedAtMonoMs: event.acceptedAtMonoMs,
        },
      };
    case "participant_consent_withdrawal":
      return {
        ...base,
        type: "participant_consent_withdrawal",
        data: {
          side: event.side,
          withdrawalId: event.withdrawalId,
          withdrawnAtMonoMs: event.withdrawnAtMonoMs,
          terminal: event.terminal,
        },
      };
    case "recorder_state":
      return {
        ...base,
        type: "recorder_state",
        data: {
          previousState: event.previousState,
          state: event.state,
          recordingArmed: event.state === "armed",
          armedTracks: event.armedTracks,
        },
      };
    case "recorder_preflight":
      return {
        ...base,
        type: "recorder_preflight",
        data: safeRecorderPreflight(event.preflight),
      };
    case "participant_readiness":
      return {
        ...base,
        type: "participant_readiness",
        data: {
          side: event.side,
          ...safeParticipantReadiness(event),
        },
      };
    case "provider_readiness":
      return {
        ...base,
        type: "provider_readiness",
        data: safeProviderReadiness(event.readiness),
      };
    case "source_transcript":
      return {
        ...base,
        type: "source_segment",
        data: {
          text: event.text,
          turnId: event.turnId,
          segmentId: event.segmentId,
          revision: event.revision,
          final: event.final,
          ...sides,
        },
      };
    case "target_transcript":
      return {
        ...base,
        type: "target_segment",
        data: {
          text: event.text,
          turnId: event.turnId,
          segmentId: event.segmentId,
          revision: event.revision,
          final: event.final,
          ...sides,
        },
      };
    case "audio_playout": {
      const latencyMs = event.latencyMs;
      return {
        ...base,
        type: "latency",
        data: {
          firstAudioMs: latencyMs,
          latencyMs,
          turnId: event.turnId,
          segmentId: event.segmentId,
          sequence: event.playoutSequence,
          ...sides,
        },
      };
    }
    case "generation_cut":
      return {
        ...base,
        type: "generation_cut",
        data: {
          previousGeneration: event.previousGeneration,
          generation: event.generation,
          reason: event.reason,
          clearId: event.clearId,
          ...(includeOperatorEvidence && event.bargeId !== undefined
            ? { bargeId: event.bargeId }
            : {}),
          ...sides,
        },
      };
    case "sequence_gap":
      return {
        ...base,
        type: "sequence_gap",
        data: {
          stream: event.stream,
          expectedSequence: event.expectedSequence,
          actualSequence: event.actualSequence,
          missingCount: event.missingCount,
          timelineAtMonoMs: event.timelineAtMonoMs,
        },
      };
    case "glossary_bound":
      return {
        ...base,
        type: includeOperatorEvidence ? "terminology_gate" : "glossary_bound",
        data: {
          ...(includeOperatorEvidence ? { status: "bound" } : {}),
          turnId: event.turnId,
          segmentId: event.segmentId,
          revision: event.revision,
          final: event.final,
          glossaryHash: event.glossaryHash,
          entryIds: event.entryIds,
          ...sides,
        },
      };
    case "glossary_authorized":
      return {
        ...base,
        type: includeOperatorEvidence ? "terminology_gate" : "target_validated",
        data: {
          ...(includeOperatorEvidence ? { status: "authorized" } : {}),
          turnId: event.turnId,
          segmentId: event.segmentId,
          revision: event.revision,
          final: event.final,
          glossaryHash: event.glossaryHash,
          entryIds: event.entryIds,
          ...sides,
        },
      };
    case "glossary_bypassed":
      return {
        ...base,
        type: includeOperatorEvidence ? "terminology_gate" : "terminology_alert",
        data: {
          status: "bypassed",
          turnId: event.turnId,
          segmentId: event.segmentId,
          revision: event.revision,
          final: event.final,
          glossaryHash: event.glossaryHash,
          entryIds: event.entryIds,
          ...sides,
        },
      };
    case "queue_sample":
      return {
        ...base,
        type: "queue_sample",
        data: {
          scope: event.scope,
          side: event.side,
          depthFrames: event.depthFrames,
          capacityFrames: event.capacityFrames,
          ...(event.oldestQueuedAgeMs === undefined
            ? {}
            : { oldestQueuedAgeMs: event.oldestQueuedAgeMs }),
          ...(event.bufferedAudioMs === undefined
            ? {}
            : { bufferedAudioMs: event.bufferedAudioMs }),
          ...sides,
        },
      };
    case "playout_lag":
      return {
        ...base,
        type: "playout_lag",
        data: {
          scope: event.scope,
          side: event.side,
          sequence: event.sequence,
          audibleStartLagMs: event.audibleStartLagMs,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          ...(event.segmentId === undefined ? {} : { segmentId: event.segmentId }),
          ...(event.revision === undefined ? {} : { revision: event.revision }),
          ...sides,
        },
      };
    case "barge_lifecycle":
      return {
        ...base,
        type: "barge_lifecycle",
        data: {
          stage: event.stage,
          bargeId: event.bargeId,
          clearId: event.clearId,
          sourceSide: event.sourceSide,
          destinationSide: event.destinationSide,
        },
      };
    case "alert": {
      const alert = safeAlert(event);
      return {
        ...base,
        type: includeOperatorEvidence && isGlossaryControlBypassed(event)
          ? "terminology_gate"
          : isTerminologyAlert(event)
            ? "terminology_alert"
            : "error",
        data: {
          ...(includeOperatorEvidence && isGlossaryControlBypassed(event)
            ? { status: "bypassed" }
            : {}),
          ...alert,
          ...sides,
        },
      };
    }
    case "session_closed":
      return {
        ...base,
        type: "session_state",
        data: {
          state: "closed",
          status: "closed",
          reason: event.reason,
          ...(includeOperatorEvidence
            ? { evidenceFinalization: safeEvidenceFinalization(event.finalization) }
            : {}),
        },
      };
  }
  throw new Error("Unsupported session event");
}

function relayCommand(
  command: z.infer<typeof sessionCommandSchema>,
): RelayCommand {
  return {
    type: command.kind,
    commandId: command.commandId,
  };
}

function errorPayload(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Readonly<{ error: Readonly<Record<string, unknown>> }> {
  return { error: { code, message, ...details } };
}

function configureTranslation(value: ConfiguredTranslation): ConfiguredTranslation {
  if (
    value === undefined ||
    typeof value.providerId !== "string" ||
    !["palabra", "openai_native", "openai_controlled"].includes(value.providerId) ||
    !Array.isArray(value.modes)
  ) {
    throw new TypeError("translation must advertise a configured provider and mode capabilities");
  }
  validateTranslationCapabilities(value);
  const modes = new Set<TranslationMode>();
  for (const capability of value.modes) {
    if (
      !["fast", "balanced", "accurate"].includes(capability.mode) ||
      modes.has(capability.mode) ||
      !Number.isSafeInteger(capability.behaviorVersion) ||
      capability.behaviorVersion < 1 ||
      typeof capability.deterministicGlossary !== "boolean" ||
      !["native", "locally_controlled", "experimental", "unsupported"].includes(capability.state) ||
      (capability.reason !== undefined &&
        (typeof capability.reason !== "string" || capability.reason.trim().length === 0)) ||
      (!isSelectableTranslationMode(capability) && capability.reason === undefined)
    ) {
      throw new TypeError("translation must advertise unique valid mode capabilities");
    }
    modes.add(capability.mode);
  }
  const defaultMode = modeCapability(value, value.defaultMode);
  if (defaultMode === undefined || !isSelectableTranslationMode(defaultMode)) {
    throw new TypeError("translation defaultMode must be selectable");
  }
  if (
    typeof value.supportsProvisionalRevisions !== "boolean" ||
    typeof value.supportsFinality !== "boolean" ||
    typeof value.supportsCancellation !== "boolean" ||
    typeof value.supportsDeterministicGlossary !== "boolean"
  ) {
    throw new TypeError("translation capability flags must be explicit booleans");
  }
  return Object.freeze({
    ...value,
    modes: Object.freeze(value.modes.map((capability) => Object.freeze({
      ...capability,
      ...(capability.reason === undefined
        ? {}
        : { reason: capability.reason.trim() }),
    }))),
  });
}

function publicTranslationCapabilities(translation: ConfiguredTranslation): Readonly<{
  provider: TranslationProviderId;
  modes: readonly Readonly<{
    mode: TranslationMode;
    behavior: Readonly<{ version: number }>;
    state: TranslationModeCapability["state"];
    deterministicGlossary: boolean;
    reason?: string;
  }>[];
  defaultMode: TranslationMode;
}> {
  return Object.freeze({
    provider: translation.providerId,
    modes: Object.freeze(translation.modes.map((capability) => Object.freeze({
      mode: capability.mode,
      behavior: Object.freeze({ version: capability.behaviorVersion }),
      state: capability.state,
      deterministicGlossary: capability.deterministicGlossary,
      ...(capability.reason === undefined ? {} : { reason: capability.reason }),
    }))),
    defaultMode: translation.defaultMode,
  });
}

function pinnedSessionTranslation(
  snapshot: SessionSnapshot,
  translation: ConfiguredTranslation,
  requestedMode?: TranslationMode,
): Readonly<{
  provider: TranslationProviderId;
  translationMode: TranslationMode;
  behaviorVersion: number;
  translationState: TranslationModeCapability["state"];
  deterministicGlossary: boolean;
  reason?: string;
}> {
  const capability = modeCapability(translation, snapshot.spec.mode);
  if (
    snapshot.spec.provider !== translation.providerId ||
    capability === undefined ||
    (requestedMode !== undefined && snapshot.spec.mode !== requestedMode) ||
    snapshot.behavior.mode !== snapshot.spec.mode ||
    snapshot.behavior.version !== capability.behaviorVersion
  ) {
    throw new TypeError("relay snapshot does not match the configured translation behavior");
  }
  return Object.freeze({
    provider: snapshot.spec.provider,
    translationMode: snapshot.spec.mode,
    behaviorVersion: snapshot.behavior.version,
    translationState: capability.state,
    deterministicGlossary: capability.deterministicGlossary,
    ...(capability.reason === undefined ? {} : { reason: capability.reason }),
  });
}

function publicProcessingDisclosure(
  snapshot: SessionSnapshot,
  profile: ApprovedSessionProcessingProfile,
): Readonly<{
  noticeVersion: string;
  recording: true;
  processing: true;
  withdrawalTerminatesSession: true;
  provider: TranslationProviderId;
  services: readonly Readonly<{
    id: string;
    provider: "openai" | "palabra";
    role: string;
    category: string;
    dataCategories: readonly string[];
  }>[];
}> {
  validateSessionSpecAgainstProcessingProfile(snapshot.spec, profile);
  const policy = snapshot.spec.processingManifest.consentPolicyRef;
  return Object.freeze({
    noticeVersion: policy.noticeVersion,
    recording: policy.recordingRequired,
    processing: policy.processingRequired,
    withdrawalTerminatesSession: policy.withdrawalTerminatesSession,
    provider: snapshot.spec.processingManifest.selectedTranslation.provider,
    services: Object.freeze(snapshot.spec.processingManifest.services.map((service) => Object.freeze({
      id: service.id,
      provider: service.provider,
      role: service.role,
      category: service.category,
      dataCategories: Object.freeze([...service.dataCategories]),
    }))),
  });
}

function evidenceIdentity(
  snapshot: SessionSnapshot,
  profile: ApprovedSessionProcessingProfile,
  deploymentBuildSha256: string,
): EvidenceIdentity {
  validateSessionSpecAgainstProcessingProfile(snapshot.spec, profile);
  return Object.freeze({
    deploymentBuildSha256,
    processingProfile: Object.freeze({
      id: profile.id,
      version: profile.version,
      sha256: profile.sha256,
    }),
    processingManifestSha256: snapshot.spec.processingManifest.manifestSha256,
    servicesSha256: snapshot.spec.processingManifest.selectedTranslation.servicesSha256,
  });
}

function validateDeploymentBuildSha256(value: string): string {
  if (!SHA256_HEX.test(value)) {
    throw new TypeError("deploymentBuildSha256 must be lowercase SHA-256 hex");
  }
  return value;
}

function safeSocketError(
  socket: Readonly<{ send(data: string): void }>,
  code: string,
  message: string,
  sessionId = "",
): void {
  try {
    socket.send(JSON.stringify({
      cursor: 0,
      sessionId,
      timestampMonoMs: performance.now(),
      type: "error",
      data: { code, message },
    }));
  } catch {
    // A failed socket cannot receive a structured error.
  }
}

function safeEventStreamError(error: unknown): Readonly<{ code: string; message: string }> {
  if (error instanceof RelaySessionError) {
    const relayCode = String(error.code);
    if (relayCode === "event_cursor_gap") {
      return {
        code: "event_cursor_gap",
        message: "Event history is unavailable for the requested cursor; resync is required",
      };
    }
    if (relayCode === "event_stream_overflow") {
      return {
        code: "event_stream_overflow",
        message: "Event stream fell behind; resync is required",
      };
    }
    switch (error.code) {
      case "invalid_session":
        return { code: error.code, message: "The requested session was not found" };
      case "invalid_command":
        return { code: error.code, message: "The event stream request is invalid" };
      case "invalid_spec":
      case "session_exists":
        break;
    }
  }
  return { code: "event_stream_failed", message: "The event stream failed" };
}

function safeRelayErrorMessage(code: RelaySessionError["code"]): string {
  switch (code) {
    case "invalid_session":
      return "The requested session was not found";
    case "invalid_command":
      return "The session command could not be accepted";
    case "session_exists":
      return "The session already exists";
    case "invalid_spec":
      return "The session specification is invalid";
    case "event_cursor_gap":
      return "Event history is unavailable for the requested cursor; resync is required";
    case "event_stream_overflow":
      return "Event stream fell behind; resync is required";
  }
}

export interface EventSocketStreamOptions {
  readonly socket: EventSocket;
  /** Session identity used on structured stream errors before the first event. */
  readonly sessionId?: string;
  readonly events: AsyncIterable<SessionEvent> | (() => AsyncIterable<SessionEvent>);
  readonly eventAccess: EventAccessScope;
  readonly processingProfile: ApprovedSessionProcessingProfile;
  readonly deploymentBuildSha256: string;
  readonly onSessionClosed?: () => Promise<void>;
  readonly abort?: () => void;
  /** Releases the server-side capacity reservation exactly once. */
  readonly releaseSubscription?: () => void;
}

function closeEventSocket(socket: EventSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.terminate();
    } catch {
      // The caller still performs subscription cleanup after either close path fails.
    }
  }
}

/**
 * Sends only while the peer is open and within its unflushed-data budget.
 * A rejected send closes the peer rather than accumulating another queued event.
 */
export function sendBoundedEventSocketMessage(
  socket: EventSocket,
  serialize: () => string,
): boolean {
  const payload = serialize();
  if (
    socket.readyState !== socket.OPEN ||
    (socket.bufferedAmount ?? 0) + Buffer.byteLength(payload, "utf8") >
      MAX_EVENT_SOCKET_BUFFERED_BYTES
  ) {
    closeEventSocket(socket, EVENT_SOCKET_POLICY_CLOSE_CODE, EVENT_SOCKET_BACKPRESSURE_REASON);
    return false;
  }
  socket.send(payload);
  return true;
}

/**
 * Projects a relay event subscription onto one event WebSocket and releases it
 * as soon as the peer closes or exceeds its bounded send budget.
 */
export async function streamEventSocket(options: EventSocketStreamOptions): Promise<void> {
  const { socket } = options;
  let eventIterator: AsyncIterator<SessionEvent> | undefined;
  let socketClosed = false;
  let iteratorReturn: Promise<void> | undefined;
  let subscriptionReleased = false;
  const releaseSubscription = (): void => {
    if (subscriptionReleased) return;
    subscriptionReleased = true;
    try {
      options.releaseSubscription?.();
    } catch {
      // Capacity accounting must not interfere with socket cleanup.
    }
  };
  const returnIterator = (): Promise<void> => {
    if (eventIterator === undefined) return Promise.resolve();
    iteratorReturn ??= Promise.resolve()
      .then(() => eventIterator?.return?.())
      .then(() => undefined)
      .catch(() => undefined);
    return iteratorReturn;
  };
  const stopSubscription = (): void => {
    options.abort?.();
    void returnIterator();
  };
  const onSocketClose = (): void => {
    socketClosed = true;
    releaseSubscription();
    stopSubscription();
  };
  const onSocketError = (): void => {
    socketClosed = true;
    releaseSubscription();
    stopSubscription();
  };
  socket.once("close", onSocketClose);
  socket.once("error", onSocketError);

  try {
    const events = typeof options.events === "function" ? options.events() : options.events;
    eventIterator = events[Symbol.asyncIterator]();
    while (!socketClosed) {
      const next = await eventIterator.next();
      if (next.done || socketClosed) break;
      const event = next.value;
      if (event.type === "session_closed") await options.onSessionClosed?.();
      if (
        options.eventAccess.kind === "participant" &&
        !isParticipantEventVisible(event, options.eventAccess.side)
      ) {
        continue;
      }
      const sent = sendBoundedEventSocketMessage(
        socket,
        () => JSON.stringify(mapSessionEvent(
          event,
          options.processingProfile,
          options.deploymentBuildSha256,
          options.eventAccess.kind === "operator",
        )),
      );
      if (!sent) {
        socketClosed = true;
        stopSubscription();
        break;
      }
    }
    if (!socketClosed && socket.readyState === socket.OPEN) socket.terminate();
  } catch (error: unknown) {
    if (socketClosed) return;
    const eventStreamError = safeEventStreamError(error);
    safeSocketError(socket, eventStreamError.code, eventStreamError.message, options.sessionId);
    if (socket.readyState === socket.OPEN) closeEventSocket(socket, 1011, "Event stream failed");
  } finally {
    socketClosed = true;
    options.abort?.();
    await returnIterator();
    socket.off?.("close", onSocketClose);
    socket.off?.("error", onSocketError);
    releaseSubscription();
  }
}

export async function createServerApp(options: ServerAppOptions): Promise<FastifyInstance> {
  if (
    options.evidenceReview === undefined ||
    typeof options.evidenceReview.review !== "function"
  ) {
    throw new TypeError("evidenceReview must provide review");
  }
  const mediaProfile = options.mediaProfile ?? "browser_pair";
  if (mediaProfile === "browser_pair" && options.browserMedia === undefined) {
    throw new TypeError("browser_pair media requires a browser media gateway");
  }
  if (mediaProfile === "fake_telephony" && options.browserMedia !== undefined) {
    throw new TypeError(
      "fake_telephony media must not expose the browser media gateway",
    );
  }
  const fastifyOptions = {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.https === undefined ? {} : { https: options.https }),
  };
  const app = Fastify(fastifyOptions as FastifyServerOptions);
  const evidenceHealth = options.evidenceHealth ?? (() => "healthy");
  const translation = configureTranslation(options.translation);
  const processingProfile = options.processingProfile;
  const deploymentBuildSha256 = validateDeploymentBuildSha256(options.deploymentBuildSha256);
  validateApprovedSessionProcessingProfile(processingProfile);
  const dataAdmission = requiresSyntheticOnlyAdmission(processingProfile)
    ? "synthetic_only" as const
    : "approved_poc_content" as const;
  const glossaryLeases = new Map<string, GlossaryLease>();
  const unattachedGlossaryLeases = new Set<GlossaryLease>();
  const glossaryLeaseWatchers = new Map<string, AbortController>();
  let activeEventSubscriptions = 0;
  const activeEventSubscriptionsBySession = new Map<string, number>();
  const reserveEventSubscription = (sessionId: string): (() => void) | undefined => {
    const sessionCount = activeEventSubscriptionsBySession.get(sessionId) ?? 0;
    if (
      activeEventSubscriptions >= MAX_EVENT_SUBSCRIPTIONS_GLOBAL ||
      sessionCount >= MAX_EVENT_SUBSCRIPTIONS_PER_SESSION
    ) {
      return undefined;
    }
    activeEventSubscriptions += 1;
    activeEventSubscriptionsBySession.set(sessionId, sessionCount + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeEventSubscriptions -= 1;
      const currentSessionCount = activeEventSubscriptionsBySession.get(sessionId) ?? 0;
      if (currentSessionCount <= 1) {
        activeEventSubscriptionsBySession.delete(sessionId);
      } else {
        activeEventSubscriptionsBySession.set(sessionId, currentSessionCount - 1);
      }
    };
  };
  const releaseUnattachedGlossaryLease = async (lease: GlossaryLease): Promise<void> => {
    await lease.release();
    unattachedGlossaryLeases.delete(lease);
  };
  const releaseGlossaryLease = async (sessionId: string): Promise<void> => {
    const watcher = glossaryLeaseWatchers.get(sessionId);
    if (watcher !== undefined) {
      glossaryLeaseWatchers.delete(sessionId);
      watcher.abort();
    }
    const lease = glossaryLeases.get(sessionId);
    if (lease === undefined) return;
    await lease.release();
    if (glossaryLeases.get(sessionId) === lease) glossaryLeases.delete(sessionId);
  };
  const releaseAllGlossaryLeases = async (): Promise<void> => {
    let failure: unknown;
    for (const sessionId of [...glossaryLeases.keys()]) {
      try {
        await releaseGlossaryLease(sessionId);
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    for (const lease of [...unattachedGlossaryLeases]) {
      try {
        await releaseUnattachedGlossaryLease(lease);
      } catch (error: unknown) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
  const watchGlossaryLease = (sessionId: string): void => {
    const watcher = new AbortController();
    glossaryLeaseWatchers.set(sessionId, watcher);
    void (async () => {
      try {
        for await (const event of options.relay.events(sessionId, 0, watcher.signal)) {
          if (event.type !== "session_closed") continue;
          await releaseGlossaryLease(sessionId);
          return;
        }
      } catch {
        // A failed observer conservatively retains the lease until an explicit terminal path or shutdown.
      } finally {
        if (glossaryLeaseWatchers.get(sessionId) === watcher) {
          glossaryLeaseWatchers.delete(sessionId);
        }
      }
    })();
  };
  if (processingProfile.translation.provider !== translation.providerId) {
    throw new TypeError("processingProfile provider must match the configured translation provider");
  }
  for (const capability of translation.modes) {
    if (
      processingProfile.translation.allowedModes.includes(capability.mode) &&
      processingProfile.translation.behaviorVersion !== capability.behaviorVersion
    ) {
      throw new TypeError("processingProfile behavior version must match configured translation modes");
    }
  }
  let retentionSweepFailed = false;
  let retentionRecoveryDegraded = false;
  let retentionSweepInFlight: Promise<void> | undefined;
  const runRetentionSweep = (): Promise<void> => {
    if (retentionSweepInFlight !== undefined) return retentionSweepInFlight;
    const currentSweep = (async () => {
      if (retentionRecoveryDegraded) {
        retentionSweepFailed = true;
        return;
      }
      try {
        const result = await options.artifacts.sweepExpired();
        retentionSweepFailed = result.status !== "completed";
      } catch {
        retentionSweepFailed = true;
      }
    })();
    retentionSweepInFlight = currentSweep;
    void currentSweep.finally(() => {
      if (retentionSweepInFlight === currentSweep) {
        retentionSweepInFlight = undefined;
      }
    });
    return currentSweep;
  };
  const currentRetentionHealth = (): RetentionSweepHealth => {
    try {
      const health = options.artifacts.getRetentionSweepHealth();
      if (!retentionRecoveryDegraded && !retentionSweepFailed && health.health === "healthy") return health;
      return {
        health: "degraded",
        ...(health.lastSuccessfulSweepAtMs === undefined
          ? {}
          : { lastSuccessfulSweepAtMs: health.lastSuccessfulSweepAtMs }),
      };
    } catch {
      return { health: "degraded" };
    }
  };
  const requireHealthyRetention = (): void => {
    if (currentRetentionHealth().health === "degraded") {
      throw new ApiError(
        503,
        "retention_degraded",
        "Evidence retention is temporarily degraded",
      );
    }
  };

  const sessionPayload = (snapshot: SessionSnapshot, requestedMode?: TranslationMode) => ({
    ...pinnedSessionTranslation(snapshot, translation, requestedMode),
    sessionId: snapshot.sessionId,
    languages: Object.freeze({
      A: snapshot.spec.sideA.language,
      B: snapshot.spec.sideB.language,
    }),
    eventCursor: snapshot.eventCursor,
    state: snapshot.status,
    participantConsent: Object.freeze({
      A: safeParticipantConsent(snapshot.participantConsent.A),
      B: safeParticipantConsent(snapshot.participantConsent.B),
    }),
    recorderArmState: snapshot.recorderArmState,
    recordingArmed: snapshot.recordingArmed,
    processingDisclosure: publicProcessingDisclosure(snapshot, processingProfile),
    evidenceIdentity: evidenceIdentity(snapshot, processingProfile, deploymentBuildSha256),
    ...(snapshot.recorderPreflight === undefined
      ? {}
      : { recorderPreflight: safeRecorderPreflight(snapshot.recorderPreflight) }),
    ...(snapshot.evidenceFinalization === undefined
      ? {}
      : { evidenceFinalization: safeEvidenceFinalization(snapshot.evidenceFinalization) }),
    ...snapshotOperationalReadiness(snapshot),
    endpointGrants: Object.freeze([
      safeEndpointGrant(snapshot.participants.A),
      safeEndpointGrant(snapshot.participants.B),
    ]),
    ...(snapshot.glossary === undefined
      ? {}
      : {
          glossaryVersion: snapshot.glossary.version,
          glossaryHash: snapshot.glossary.hash,
        }),
    evidenceHealth: evidenceHealth(),
  });

  const requireOperatorOnRequest = async (request: FastifyRequest): Promise<void> => {
    requireOperator(options.access, request.headers.authorization);
  };
  const requireEvidenceReviewOnRequest = async (request: FastifyRequest): Promise<void> => {
    requireEvidenceReviewActor(options.access, request.headers.authorization);
  };
  const requireRetentionOwnerOnRequest = async (request: FastifyRequest): Promise<void> => {
    requireRetentionOwner(options.access, request.headers.authorization);
  };
  const requireParticipantOnRequest = async (
    request: FastifyRequest<{ Params: { sessionId: string; side: string } }>,
  ): Promise<void> => {
    const side = parse(sideSchema, request.params.side);
    requireExactParticipant(
      options.access,
      request.headers.authorization,
      request.params.sessionId,
      side,
    );
  };

  const glossaryRootLease = await options.glossaries.acquireRootLease();
  try {
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
      perMessageDeflate: false,
    },
  });
  await app.register(fastifyStatic, {
    root: resolve(options.webRoot ?? resolve(process.cwd(), "web")),
    index: "index.html",
    wildcard: true,
  });

  app.setErrorHandler((error, request, reply) => {
    const parserErrorCode = (error as { readonly code?: unknown }).code;
    if (parserErrorCode === "FST_ERR_CTP_INVALID_JSON_BODY") {
      void reply
        .code(400)
        .send(errorPayload("invalid_request", "Invalid request body"));
      return;
    }
    if (parserErrorCode === "FST_ERR_CTP_BODY_TOO_LARGE") {
      void reply
        .code(413)
        .send(errorPayload("payload_too_large", "Request payload is too large"));
      return;
    }
    if (error instanceof ApiError) {
      if (error.statusCode === 401) reply.header("www-authenticate", "Bearer");
      void reply.code(error.statusCode).send(errorPayload(error.code, error.message, error.details));
      return;
    }
    if (error instanceof ZodError) {
      void reply.code(400).send(errorPayload("invalid_request", error.issues[0]?.message ?? "Invalid request"));
      return;
    }
    if (error instanceof RelaySessionError) {
      const statusCode =
        error.code === "invalid_session"
          ? 404
          : error.code === "invalid_command"
            ? 409
            : 400;
      void reply.code(statusCode).send(errorPayload(error.code, safeRelayErrorMessage(error.code)));
      return;
    }
    request.log.error({ err: error }, "Unhandled server request error");
    void reply.code(500).send(errorPayload("internal_error", "The server could not complete the request"));
  });

  app.get("/api/health", async () => {
    const currentEvidenceHealth = evidenceHealth();
    const retention = currentRetentionHealth();
    return {
      status:
        currentEvidenceHealth === "degraded" || retention.health === "degraded"
          ? "degraded"
          : "ok",
      evidenceHealth: currentEvidenceHealth,
      retention: {
        health: retention.health,
        ...(retention.lastSuccessfulSweepAtMs === undefined
          ? {}
          : { lastSuccessfulSweepAt: retentionTimestamp(retention.lastSuccessfulSweepAtMs) }),
      },
    };
  });

  app.get("/api/capabilities", { onRequest: requireOperatorOnRequest }, async () => {
    return {
      mediaProfiles: [mediaProfile],
      dataAdmission,
      translation: publicTranslationCapabilities(translation),
      glossaryImportFormats: ["csv", "xlsx"],
      recording: true,
      audio: {
        encoding: "pcm_s16le",
        sampleRateHz: CANONICAL_AUDIO.sampleRateHz,
        channels: CANONICAL_AUDIO.channels,
        frameDurationMs: CANONICAL_AUDIO.frameDurationMs,
      },
    };
  });

  app.post(
    "/api/glossaries",
    { onRequest: requireOperatorOnRequest, bodyLimit: MAX_GLOSSARY_HTTP_BODY_BYTES },
    async (request, reply) => {
      const body = parse(importGlossaryRequestSchema, request.body);
      let imported: GlossaryImportResult;
      try {
        imported = await options.glossaries.importFile(body);
      } catch {
        throw new ApiError(
          422,
          "invalid_glossary",
          "The glossary could not be imported",
        );
      }
      return reply.code(201).send({
        glossaryVersion: imported.version,
        hash: imported.hash,
        id: imported.spec.id,
      });
    },
  );

  app.delete<{ Params: { version: string } }>(
    "/api/glossaries/:version",
    { onRequest: requireRetentionOwnerOnRequest, bodyLimit: MAX_SMALL_HTTP_BODY_BYTES },
    async (request, reply) => {
      const ownerId = requireRetentionOwner(options.access, request.headers.authorization);
      const body = parse(earlyEvidenceDeletionRequestSchema, request.body);
      const result = await options.glossaries.deleteVersion({
        version: request.params.version,
        commandId: body.commandId,
        ownerId,
        reason: body.reason,
        requestedAtMs: Date.now(),
      });
      switch (result.status) {
        case "completed":
          return reply.code(200).send({
            status: "completed",
            deletionReceiptId: result.deletionReceiptId,
            requestedAtMs: result.requestedAtMs,
            deletedAtMs: result.deletedAtMs,
          });
        case "active":
          throw new ApiError(409, "glossary_active", "The glossary version is active in a session");
        case "not_found":
          throw new ApiError(404, "glossary_not_found", "The glossary version was not found");
        case "conflict":
          throw new ApiError(409, "idempotency_conflict", "A different command already uses this commandId");
      }
    },
  );

  app.post(
    "/api/sessions",
    { onRequest: requireOperatorOnRequest, bodyLimit: MAX_SMALL_HTTP_BODY_BYTES },
    async (request, reply) => {
      if (dataAdmission === "synthetic_only") {
        throw new ApiError(
          422,
          "synthetic_only_profile",
          "The configured processing profile permits synthetic benchmark data only",
          { dataAdmission },
        );
      }
      requireHealthyRetention();
      const body = parse(createSessionRequestSchema, request.body);
      const selectedMode = modeCapability(translation, body.translationMode);
      const selectableModes = translation.modes
        .filter(isSelectableTranslationMode)
        .map((capability) => capability.mode);
      if (selectedMode === undefined || !isSelectableTranslationMode(selectedMode)) {
        throw new ApiError(
          422,
          "translation_mode_unavailable",
          `Translation mode ${body.translationMode} is not available from the configured provider`,
          {
            ...(selectedMode === undefined
              ? {}
              : {
                  state: selectedMode.state,
                  reason: selectedMode.reason,
                }),
            selectableModes,
          },
        );
      }
      if (
        body.glossaryVersion !== undefined &&
        !selectedMode.deterministicGlossary
      ) {
        throw new ApiError(
          422,
          "glossary_unsupported",
          "The selected translation mode cannot guarantee a pinned glossary",
          { selectableModes: translation.modes
            .filter((capability) => capability.deterministicGlossary)
            .filter(isSelectableTranslationMode)
            .map((capability) => capability.mode) },
        );
      }
    const glossaryLease =
      body.glossaryVersion === undefined
        ? undefined
        : await options.glossaries.acquire(body.glossaryVersion);
    if (body.glossaryVersion !== undefined && glossaryLease === undefined) {
      throw new ApiError(
        404,
        "glossary_not_found",
        "The requested glossary version was not found",
      );
    }
    if (glossaryLease !== undefined) unattachedGlossaryLeases.add(glossaryLease);
    const glossary = glossaryLease?.spec;
    let snapshot: SessionSnapshot;
    try {
      const processingManifest = createSessionProcessingManifest({
        profile: processingProfile,
        mode: selectedMode.mode,
        ...(glossary === undefined
          ? {}
          : {
              glossary: {
                id: glossary.id,
                version: glossary.version,
                hash: compileGlossary(glossary).hash,
              },
            }),
      });
      snapshot = await options.relay.open({
        sideA: { language: body.languages.A },
        sideB: { language: body.languages.B },
        provider: translation.providerId,
        mode: selectedMode.mode,
        processingManifest,
        evidenceReviewGrant: options.access.evidenceReviewGrant(),
        ...(glossary === undefined ? {} : { glossary }),
      });
    } catch (error: unknown) {
      if (glossaryLease !== undefined) {
        try {
          await releaseUnattachedGlossaryLease(glossaryLease);
        } catch {
          throw new ApiError(
            500,
            "session_open_cleanup_failed",
            "The session could not be opened; glossary cleanup will be retried during shutdown",
          );
        }
      }
      if (error instanceof RelaySessionError) throw error;
      throw new ApiError(500, "session_open_failed", "The session could not be opened");
    }
    let payload: ReturnType<typeof sessionPayload>;
    try {
      // Validate the relay's authoritative mode/spec before attaching a
      // glossary lease to a session that cannot be safely exposed.
      payload = sessionPayload(snapshot, body.translationMode);
    } catch (error: unknown) {
      // Relay admission succeeded, so terminate that session before returning
      // the redacted payload-validation failure. The command is intentionally
      // best effort: preserve the original safe error if cleanup itself fails.
      try {
        await options.relay.command(snapshot.sessionId, {
          type: "end",
          commandId: randomUUID(),
          reason: "session_payload_invalid",
        });
      } catch {
        // Preserve the original payload-validation error and its redaction.
      }
      if (glossaryLease !== undefined) {
        try {
          await releaseUnattachedGlossaryLease(glossaryLease);
        } catch {
          throw new ApiError(
            500,
            "session_open_cleanup_failed",
            "The session could not be opened; glossary cleanup will be retried during shutdown",
          );
        }
      }
      throw error;
    }
    if (glossaryLease !== undefined) {
      glossaryLeases.set(snapshot.sessionId, glossaryLease);
      unattachedGlossaryLeases.delete(glossaryLease);
      watchGlossaryLease(snapshot.sessionId);
    }
    return reply.code(201).send(payload);
  });

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence/review",
    {
      onRequest: [noStoreEvidenceResponse, requireEvidenceReviewOnRequest],
      bodyLimit: MAX_SMALL_HTTP_BODY_BYTES,
    },
    async (request) => {
      const actor = requireEvidenceReviewActor(options.access, request.headers.authorization);
      requireHealthyRetention();
      const body = parseEvidenceReviewBody(evidenceReviewMetadataRequestSchema, request.body);
      let completed: CompletedEvidenceReview;
      try {
        completed = completedEvidenceReview(await options.evidenceReview.review({
          kind: "metadata_page",
          sessionId: request.params.sessionId,
          actor,
          ...(body.cursor === undefined ? {} : { cursor: body.cursor }),
          ...(body.pageSize === undefined ? {} : { pageSize: body.pageSize }),
        }));
      } catch (error: unknown) {
        if (error instanceof RangeError) {
          throw new ApiError(400, "invalid_request", "Evidence review request is invalid");
        }
        throw error;
      }
      return safeMetadataReviewPayload(expectMetadataReview(completed));
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence/review/audio-window",
    {
      onRequest: [noStoreEvidenceResponse, requireEvidenceReviewOnRequest],
      bodyLimit: MAX_SMALL_HTTP_BODY_BYTES,
    },
    async (request, reply) => {
      const actor = requireEvidenceReviewActor(options.access, request.headers.authorization);
      requireHealthyRetention();
      const body = parseEvidenceReviewBody(evidenceReviewAudioWindowRequestSchema, request.body);
      let completed: CompletedEvidenceReview;
      try {
        completed = completedEvidenceReview(await options.evidenceReview.review({
          kind: "audio_window",
          sessionId: request.params.sessionId,
          actor,
          track: body.track,
          startOffsetMs: body.startOffsetMs,
          durationMs: body.durationMs,
        }));
      } catch (error: unknown) {
        if (error instanceof RangeError) {
          throw new ApiError(
            416,
            "audio_window_unavailable",
            "The requested audio window is unavailable",
          );
        }
        throw error;
      }
      const reviewed = expectAudioReview(completed);
      return reply
        .type("audio/wav")
        .header("X-Evidence-Audit-Id", reviewed.auditId)
        .send(Buffer.from(reviewed.wav));
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence/retention",
    { onRequest: [noStoreEvidenceResponse, requireEvidenceReviewOnRequest] },
    async (request) => {
      const actor = requireEvidenceReviewActor(options.access, request.headers.authorization);
      requireHealthyRetention();
      let completed: CompletedEvidenceReview;
      try {
        completed = completedEvidenceReview(await options.evidenceReview.review({
          kind: "retention_summary",
          sessionId: request.params.sessionId,
          actor,
        }));
      } catch (error: unknown) {
        if (error instanceof RangeError) {
          throw new ApiError(400, "invalid_request", "Evidence review request is invalid");
        }
        throw error;
      }
      return sealedRetentionReviewPayload(expectRetentionReview(completed));
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence/retention/extensions",
    {
      onRequest: [noStoreEvidenceResponse, requireRetentionOwnerOnRequest],
      bodyLimit: MAX_SMALL_HTTP_BODY_BYTES,
    },
    async (request) => {
      const ownerId = requireRetentionOwner(options.access, request.headers.authorization);
      requireHealthyRetention();
      const body = parse(retentionExtensionRequestSchema, request.body);
      const requestedDeadlineAtMs = Date.parse(body.requestedDeadline);
      if (!Number.isSafeInteger(requestedDeadlineAtMs) || requestedDeadlineAtMs < 0) {
        throw new ApiError(400, "invalid_request", "requestedDeadline must be a valid UTC timestamp");
      }
      const result = await options.artifacts.extendRetention({
        sessionId: request.params.sessionId,
        commandId: body.commandId,
        authority: { kind: "retention_owner" as const, actorId: ownerId },
        reason: body.reason,
        requestedAtMs: Date.now(),
        requestedDeadlineAtMs,
      });
      if (result.status === "extended") return extendedRetentionPayload(result);
      if (result.status === "conflict") {
        throw new ApiError(409, "idempotency_conflict", "A different command already uses this commandId");
      }
      if (result.status === "not_found") {
        throw new ApiError(404, "evidence_not_found", "Evidence was not found");
      }
      throw new ApiError(422, "retention_extension_rejected", "The retention extension was rejected");
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence",
    {
      onRequest: [noStoreEvidenceResponse, requireRetentionOwnerOnRequest],
      bodyLimit: MAX_SMALL_HTTP_BODY_BYTES,
    },
    async (request, reply) => {
      const ownerId = requireRetentionOwner(options.access, request.headers.authorization);
      const body = parse(earlyEvidenceDeletionRequestSchema, request.body);
      const result = await options.artifacts.deleteEvidence({
        sessionId: request.params.sessionId,
        commandId: body.commandId,
        authority: { kind: "retention_owner" as const, actorId: ownerId },
        reason: body.reason,
        requestedAtMs: Date.now(),
      });
      switch (result.status) {
        case "completed":
          return reply.code(200).send({
            status: "completed",
            deletionReceiptId: result.deletionReceiptId,
          });
        case "pending":
          return reply.code(202).send({ status: "pending" });
        case "conflict":
          throw new ApiError(409, "idempotency_conflict", "A different command already uses this commandId");
        case "not_found":
          throw new ApiError(404, "evidence_not_found", "Evidence was not found");
        case "rejected":
          throw new ApiError(
            409,
            "evidence_not_finalized",
            "Evidence must be finalized before it can be deleted",
          );
      }
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/evidence/exports",
    {
      onRequest: [noStoreEvidenceResponse, requireRetentionOwnerOnRequest],
      bodyLimit: MAX_SMALL_HTTP_BODY_BYTES,
    },
    async (request) => {
      const ownerId = requireRetentionOwner(options.access, request.headers.authorization);
      const body = parse(managedPlaintextExportRequestSchema, request.body);
      requireHealthyRetention();
      const requestedAtMs = Date.now();
      const result = await exportManagedFinalizedEvidence({
        artifacts: options.artifacts,
        lookup: { sessionId: request.params.sessionId },
        commandId: body.commandId,
        authority: { kind: "retention_owner" as const, actorId: ownerId },
        requestedAtMs,
      });
      switch (result.status) {
        case "audit_failed":
          throw new ApiError(503, "evidence_audit_failed", "Evidence audit verification failed");
        case "not_found":
          throw new ApiError(404, "evidence_not_found", "Evidence was not found");
        case "conflict":
          throw new ApiError(
            409,
            "idempotency_conflict",
            "A different command already uses this commandId",
          );
        case "expired":
          throw new ApiError(410, "evidence_expired", "Evidence retention has expired");
        case "completed":
          return {
            status: "completed" as const,
            exportId: result.exportId,
            manifestFileSha256: result.manifestFileSha256,
            processingManifestSha256: result.processingManifestSha256,
            finalizationManifestSha256: result.finalizationManifestSha256,
            retentionDeadlineAt: retentionTimestamp(result.retentionDeadlineAtMs),
            recordCount: result.recordCount,
            finalChainSha256: result.finalChainSha256,
            evidenceSealSha256: result.evidenceSealSha256,
            trackDigests: result.trackDigests,
          };
      }
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    { onRequest: requireOperatorOnRequest },
    async (request) => {
      requireOperator(options.access, request.headers.authorization);
      return sessionPayload(options.relay.snapshot(request.params.sessionId));
    },
  );

  app.post<{ Params: { sessionId: string; side: string } }>(
    "/api/sessions/:sessionId/participants/:side/recording-processing-consent",
    { onRequest: requireParticipantOnRequest, bodyLimit: MAX_SMALL_HTTP_BODY_BYTES },
    async (request, reply) => {
      const side = parse(sideSchema, request.params.side);
      requireExactParticipant(
        options.access,
        request.headers.authorization,
        request.params.sessionId,
        side,
      );
      const body = parse(participantRecordingProcessingConsentRequestSchema, request.body);
      const session = options.relay.snapshot(request.params.sessionId);
      await options.relay.command(request.params.sessionId, {
        type: "participant_consent",
        commandId: body.consentId,
        side,
        consentId: body.consentId,
        consentPolicyRef: session.spec.processingManifest.consentPolicyRef,
        recording: true,
        processing: true,
      });
      return reply.code(202).send({ accepted: true, consentId: body.consentId });
    },
  );

  app.post<{ Params: { sessionId: string; side: string } }>(
    "/api/sessions/:sessionId/participants/:side/recording-processing-withdrawal",
    { onRequest: requireParticipantOnRequest, bodyLimit: MAX_SMALL_HTTP_BODY_BYTES },
    async (request, reply) => {
      const side = parse(sideSchema, request.params.side);
      requireExactParticipant(
        options.access,
        request.headers.authorization,
        request.params.sessionId,
        side,
      );
      const body = parse(participantRecordingProcessingWithdrawalRequestSchema, request.body);
      const session = options.relay.snapshot(request.params.sessionId);
      const consent = session.participantConsent[side];
      const matchingWithdrawalRetry = consent.withdrawalId === body.withdrawalId;
      if (consent.consentId === undefined || (!consent.consented && !matchingWithdrawalRetry)) {
        throw new ApiError(
          409,
          "consent_not_active",
          "Recording and processing consent is not active for this participant",
        );
      }
      await options.relay.command(request.params.sessionId, {
        type: "participant_consent_withdrawal",
        commandId: body.withdrawalId,
        side,
        consentId: consent.consentId,
        withdrawalId: body.withdrawalId,
        withdrawnAtMonoMs: performance.now(),
      });
      await releaseGlossaryLease(request.params.sessionId);
      return reply.code(202).send({ accepted: true, withdrawalId: body.withdrawalId });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/commands",
    { onRequest: requireOperatorOnRequest, bodyLimit: MAX_SMALL_HTTP_BODY_BYTES },
    async (request, reply) => {
      requireOperator(options.access, request.headers.authorization);
      const command = parse(sessionCommandSchema, request.body);
      if (command.kind === "start") requireHealthyRetention();
      await options.relay.command(request.params.sessionId, relayCommand(command));
      if (command.kind === "end") await releaseGlossaryLease(request.params.sessionId);
      return reply.code(202).send({ accepted: true, commandId: command.commandId });
    },
  );

  app.get<{ Params: { sessionId: string }; Querystring: { after?: string; access?: unknown } }>(
    "/ws/events/:sessionId",
    { websocket: true },
    (socket, request) => {
      const browserSocket = socket as unknown as BrowserMediaSocket;
      const afterText = request.query.after;
      const after = afterText === undefined ? 0 : Number(afterText);
      const eventAccess = options.access.resolveEventAccess(
        queryAccess(request.query.access),
        request.params.sessionId,
      );
      if (eventAccess === undefined) {
        safeSocketError(browserSocket, "unauthorized", "A valid access token is required");
        socket.close(1008, "Unauthorized");
        return;
      }

      if (!Number.isSafeInteger(after) || after < 0) {
        safeSocketError(browserSocket, "invalid_cursor", "after must be a non-negative integer");
        socket.close(1008, "Invalid event cursor");
        return;
      }

      const releaseSubscription = reserveEventSubscription(request.params.sessionId);
      if (releaseSubscription === undefined) {
        socket.close(EVENT_SOCKET_CAPACITY_CLOSE_CODE, EVENT_SOCKET_CAPACITY_CLOSE_REASON);
        return;
      }
      const eventController = new AbortController();
      void streamEventSocket({
        socket: socket as unknown as EventSocket,
        sessionId: request.params.sessionId,
        events: () => options.relay.events(request.params.sessionId, after, eventController.signal),
        eventAccess,
        processingProfile,
        deploymentBuildSha256,
        onSessionClosed: () => releaseGlossaryLease(request.params.sessionId),
        abort: () => eventController.abort(),
        releaseSubscription,
      });
    },
  );

  if (options.browserMedia !== undefined) {
    const browserMedia = options.browserMedia;
    app.get<{ Params: { sessionId: string; side: string }; Querystring: { access?: unknown } }>(
      "/ws/media/:sessionId/:side",
      { websocket: true },
      (socket, request) => {
        const parsedSide = sideSchema.safeParse(request.params.side);
        if (!parsedSide.success) {
          socket.close(1008, "Side must be A or B");
          return;
        }
        const browserSocket = socket as unknown as BrowserMediaSocket;
        const side = parsedSide.data;
        if (!options.access.acceptsMediaAccess(
          queryAccess(request.query.access),
          request.params.sessionId,
          side,
        )) {
          safeSocketError(browserSocket, "unauthorized", "A valid participant access token is required");
          socket.close(1008, "Unauthorized");
          return;
        }
        try {
          const session = options.relay.snapshot(request.params.sessionId);
          if (session.status === "closing" || session.status === "closed") {
            throw new Error("Participant media cannot attach to a terminal session");
          }
          if (!session.participantConsent[side].consented) {
            throw new Error("Participant recording and processing consent is required before media can attach");
          }
          browserMedia.attach(request.params.sessionId, side, browserSocket);
        } catch (error: unknown) {
          safeSocketError(
            browserSocket,
            "media_attach_rejected",
            "Participant media attachment was rejected",
          );
          socket.close(1008, "Media attachment rejected");
          return;
        }
        socket.once("close", () => {
          browserMedia.detach(request.params.sessionId, side, browserSocket);
        });
      },
    );
  }

  const evidenceRootLease: EvidenceRootProcessLease = await options.artifacts
    .acquireEvidenceRootLease("server");
  let retentionSweepTimer: ReturnType<typeof setInterval> | undefined;
  try {
    let recovery;
    try {
      recovery = await options.artifacts.recover();
    } catch {
      throw new Error("Evidence artifact recovery failed");
    }
    const recoverableDegradedRecovery =
      recovery.finalizationFailures > 0 || recovery.orphanedActiveArtifacts > 0;
    if (recovery.status !== "completed" && !recoverableDegradedRecovery) {
      throw new Error("Evidence artifact recovery failed");
    }
    retentionRecoveryDegraded =
      recovery.status !== "completed" ||
      recovery.finalizationFailures !== 0 ||
      recovery.orphanedActiveArtifacts !== 0;
    await runRetentionSweep();
    retentionSweepTimer = setInterval(() => {
      void runRetentionSweep();
    }, RETENTION_SWEEP_INTERVAL_MS);
    retentionSweepTimer.unref();
    app.addHook("onClose", async () => {
      clearInterval(retentionSweepTimer);
      try {
        await retentionSweepInFlight;
      } finally {
        try {
          await releaseAllGlossaryLeases();
        } finally {
          try {
            await evidenceRootLease.release();
          } finally {
            await glossaryRootLease.release();
          }
        }
      }
    });
    await app.ready();
    return app;
  } catch (error: unknown) {
    if (retentionSweepTimer !== undefined) clearInterval(retentionSweepTimer);
    await evidenceRootLease.release();
    throw error;
  }
  } catch (error: unknown) {
    await glossaryRootLease.release();
    throw error;
  }
}

import type { ServerOptions as HttpsServerOptions } from "node:https";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { z, ZodError } from "zod";
import { CANONICAL_AUDIO, destinationForLane, sourceForLane } from "../core/audio.js";
import type { GlossarySpec } from "../core/glossary.js";
import { RelaySessionError } from "../core/relay.js";
import {
  type GuardedDuplexRelay,
  type Lane,
  type MediaProfile,
  type RelayCommand,
  type SessionEvent,
  type SessionSnapshot,
  type Side,
  type TranslationCapabilities,
  type TranslationMode,
  type TranslationModeCapability,
  type TranslationProviderId,
} from "../core/types.js";
import type { ServerAccessControl } from "./access.js";
import {
  createSessionRequestSchema,
  importGlossaryRequestSchema,
  sessionCommandSchema,
  sideSchema,
  type ImportGlossaryRequest,
} from "./protocol.js";

export interface GlossaryImportResult {
  readonly version: string;
  readonly hash: string;
  readonly spec: GlossarySpec;
}

export interface GlossaryRegistry {
  importFile(request: ImportGlossaryRequest): Promise<GlossaryImportResult>;
  get(version: string): Promise<GlossarySpec | undefined>;
}

export type BrowserMediaSocketListener = (...args: readonly unknown[]) => void;

export interface BrowserMediaSocket {
  readonly readyState?: number;
  on(event: string, listener: BrowserMediaSocketListener): unknown;
  off?(event: string, listener: BrowserMediaSocketListener): unknown;
  send(data: string | Uint8Array): void;
}

export interface BrowserMediaGateway {
  attach(sessionId: string, side: Side, socket: BrowserMediaSocket): void;
  detach(sessionId: string, side: Side, socket: BrowserMediaSocket): void;
}

export type EvidenceHealth = "healthy" | "degraded";

export interface ConfiguredTranslation extends TranslationCapabilities {
  readonly defaultMode: TranslationMode;
}

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

function queryAccess(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
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
      return event.side === side;
    case "source_transcript":
    case "glossary_bound":
      return event.lane !== null && sourceForLane(event.lane) === side;
    case "target_transcript":
    case "generation_cut":
    case "glossary_authorized":
      return event.lane !== null && destinationForLane(event.lane) === side;
    case "alert":
      return event.lane !== null && destinationForLane(event.lane) === side;
    case "audio_playout":
      return false;
  }
}

function isTerminologyAlert(event: Extract<SessionEvent, { type: "alert" }>): boolean {
  if ("type" in event.alert && event.alert.type === "glossary_control_bypassed") {
    return true;
  }
  const code = event.alert.code.toLocaleUpperCase("en-US");
  return code.startsWith("GLOSSARY_") || code === "TRANSCRIPTION_LOW_CONFIDENCE";
}

export function mapSessionEvent(event: SessionEvent): UiEventEnvelope {
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
          recording: true,
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
          ...sides,
        },
      };
    case "glossary_bound":
      return {
        ...base,
        type: "glossary_bound",
        data: {
          glossaryHash: event.glossaryHash,
          entryIds: event.entryIds,
          ...sides,
        },
      };
    case "glossary_authorized":
      return {
        ...base,
        type: "target_validated",
        data: {
          text: event.text,
          glossaryHash: event.glossaryHash,
          guaranteedTargetExact: event.guaranteedTargetExact,
          ...sides,
        },
      };
    case "alert":
      return {
        ...base,
        type: isTerminologyAlert(event) ? "terminology_alert" : "error",
        data: { ...event.alert, ...sides },
      };
    case "session_closed":
      return {
        ...base,
        type: "session_state",
        data: { state: "closed", status: "closed", reason: event.reason },
      };
  }
}

function mapRecordingStateEvent(
  event: SessionEvent,
): UiEventEnvelope | undefined {
  if (
    event.type !== "session_opened" && event.type !== "session_closed"
  ) return undefined;
  const active = event.type === "session_opened";
  return {
    sessionId: event.sessionId,
    timestampMonoMs: event.timestampMonoMs,
    ...(event.lane === null ? {} : { lane: event.lane }),
    ...(event.generation === null ? {} : { generation: event.generation }),
    type: "recording_state",
    data: { active, recording: active },
  };
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

function capabilityDegradation(capability: TranslationModeCapability): Readonly<{
  state: "full" | "degraded";
  reason?: string;
}> {
  return capability.degradation === undefined
    ? Object.freeze({ state: "full" as const })
    : Object.freeze({ state: "degraded" as const, reason: capability.degradation });
}

function modeCapability(
  translation: ConfiguredTranslation,
  mode: TranslationMode,
): TranslationModeCapability | undefined {
  return translation.supportedModes.find((candidate) => candidate.mode === mode);
}

function configureTranslation(value: ConfiguredTranslation): ConfiguredTranslation {
  if (
    value === undefined ||
    typeof value.providerId !== "string" ||
    !["palabra", "openai_native", "openai_controlled"].includes(value.providerId) ||
    !Array.isArray(value.supportedModes) ||
    value.supportedModes.length === 0
  ) {
    throw new TypeError("translation must advertise a configured provider and supported modes");
  }
  const modes = new Set<TranslationMode>();
  for (const capability of value.supportedModes) {
    if (
      !["fast", "balanced", "accurate"].includes(capability.mode) ||
      modes.has(capability.mode) ||
      !Number.isSafeInteger(capability.behaviorVersion) ||
      capability.behaviorVersion < 1 ||
      typeof capability.deterministicGlossary !== "boolean" ||
      (capability.degradation !== undefined &&
        (typeof capability.degradation !== "string" || capability.degradation.trim().length === 0))
    ) {
      throw new TypeError("translation must advertise unique valid mode capabilities");
    }
    modes.add(capability.mode);
  }
  if (!modes.has(value.defaultMode)) {
    throw new TypeError("translation defaultMode must be supported");
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
    supportedModes: Object.freeze(value.supportedModes.map((capability) => Object.freeze({
      ...capability,
      ...(capability.degradation === undefined
        ? {}
        : { degradation: capability.degradation.trim() }),
    }))),
  });
}

function publicTranslationCapabilities(translation: ConfiguredTranslation): Readonly<{
  provider: TranslationProviderId;
  supportedModes: readonly Readonly<{
    mode: TranslationMode;
    behavior: Readonly<{ version: number }>;
    deterministicGlossary: boolean;
    degradation: Readonly<{ state: "full" | "degraded"; reason?: string }>;
  }>[];
  defaultMode: TranslationMode;
}> {
  return Object.freeze({
    provider: translation.providerId,
    supportedModes: Object.freeze(translation.supportedModes.map((capability) => Object.freeze({
      mode: capability.mode,
      behavior: Object.freeze({ version: capability.behaviorVersion }),
      deterministicGlossary: capability.deterministicGlossary,
      degradation: capabilityDegradation(capability),
    }))),
    defaultMode: translation.defaultMode,
  });
}

function pinnedSessionTranslation(
  snapshot: SessionSnapshot,
  translation: ConfiguredTranslation,
): Readonly<{
  provider: TranslationProviderId;
  translationMode: TranslationMode;
  behaviorVersion: number;
  deterministicGlossary: boolean;
  degradation: Readonly<{ state: "full" | "degraded"; reason?: string }>;
}> {
  const capability = modeCapability(translation, snapshot.spec.mode);
  if (
    snapshot.spec.provider !== translation.providerId ||
    capability === undefined ||
    snapshot.behavior.version !== capability.behaviorVersion
  ) {
    throw new TypeError("relay snapshot does not match the configured translation behavior");
  }
  return Object.freeze({
    provider: snapshot.spec.provider,
    translationMode: snapshot.spec.mode,
    behaviorVersion: snapshot.behavior.version,
    deterministicGlossary: capability.deterministicGlossary,
    degradation: capabilityDegradation(capability),
  });
}

function safeSocketError(socket: BrowserMediaSocket, code: string, message: string): void {
  try {
    socket.send(JSON.stringify({
      cursor: 0,
      sessionId: "",
      timestampMonoMs: performance.now(),
      type: "error",
      data: { code, message },
    }));
  } catch {
    // A failed socket cannot receive a structured error.
  }
}

export async function createServerApp(options: ServerAppOptions): Promise<FastifyInstance> {
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
  const sessionPayload = (snapshot: SessionSnapshot) => ({
    ...pinnedSessionTranslation(snapshot, translation),
    sessionId: snapshot.sessionId,
    state: snapshot.status,
    endpointGrants: [snapshot.participants.A, snapshot.participants.B],
    ...(snapshot.glossary === undefined ? {} : { glossaryHash: snapshot.glossary.hash }),
    evidenceHealth: evidenceHealth(),
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: resolve(options.webRoot ?? resolve(process.cwd(), "web")),
    index: "index.html",
    wildcard: true,
  });

  app.setErrorHandler((error, request, reply) => {
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
      void reply.code(statusCode).send(errorPayload(error.code, error.message));
      return;
    }
    request.log.error({ err: error }, "Unhandled server request error");
    void reply.code(500).send(errorPayload("internal_error", "The server could not complete the request"));
  });

  app.get("/api/health", async () => {
    const currentEvidenceHealth = evidenceHealth();
    return {
      status: currentEvidenceHealth === "degraded" ? "degraded" : "ok",
      evidenceHealth: currentEvidenceHealth,
    };
  });

  app.get("/api/capabilities", async (request) => {
    requireOperator(options.access, request.headers.authorization);
    return {
      mediaProfiles: [mediaProfile],
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

  app.post("/api/glossaries", async (request, reply) => {
    requireOperator(options.access, request.headers.authorization);
    const body = parse(importGlossaryRequestSchema, request.body);
    let imported: GlossaryImportResult;
    try {
      imported = await options.glossaries.importFile(body);
    } catch (error: unknown) {
      throw new ApiError(
        422,
        "invalid_glossary",
        error instanceof Error ? error.message : "The glossary could not be imported",
      );
    }
    return reply.code(201).send({
      glossaryVersion: imported.version,
      hash: imported.hash,
      id: imported.spec.id,
    });
  });

  app.post("/api/sessions", async (request, reply) => {
    requireOperator(options.access, request.headers.authorization);
    const body = parse(createSessionRequestSchema, request.body);
    const selectedMode = modeCapability(translation, body.translationMode);
    if (selectedMode === undefined) {
      throw new ApiError(
        422,
        "translation_mode_unsupported",
        `Translation mode ${body.translationMode} is not available from the configured provider`,
        { supportedModes: translation.supportedModes.map((capability) => capability.mode) },
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
        { supportedModes: translation.supportedModes
          .filter((capability) => capability.deterministicGlossary)
          .map((capability) => capability.mode) },
      );
    }
    const glossary =
      body.glossaryVersion === undefined
        ? undefined
        : await options.glossaries.get(body.glossaryVersion);
    if (body.glossaryVersion !== undefined && glossary === undefined) {
      throw new ApiError(
        404,
        "glossary_not_found",
        `Unknown glossary version ${body.glossaryVersion}`,
      );
    }

    const snapshot = await options.relay.open({
      sideA: { language: body.languages.A },
      sideB: { language: body.languages.B },
      provider: translation.providerId,
      mode: selectedMode.mode,
      ...(glossary === undefined ? {} : { glossary }),
    });
    return reply.code(201).send(sessionPayload(snapshot));
  });

  app.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId",
    async (request) => {
      requireOperator(options.access, request.headers.authorization);
      return sessionPayload(options.relay.snapshot(request.params.sessionId));
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/commands",
    async (request, reply) => {
      requireOperator(options.access, request.headers.authorization);
      const command = parse(sessionCommandSchema, request.body);
      await options.relay.command(request.params.sessionId, relayCommand(command));
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

      const eventController = new AbortController();
      let eventIterator: AsyncIterator<SessionEvent> | undefined;
      let socketClosed = false;
      const onSocketClose = (): void => {
        socketClosed = true;
        eventController.abort();
        void Promise.resolve(eventIterator?.return?.()).catch(() => undefined);
      };
      socket.once("close", onSocketClose);

      void (async () => {
        try {
          eventIterator = options.relay
            .events(request.params.sessionId, after, eventController.signal)
            [Symbol.asyncIterator]();
          while (!socketClosed) {
            const next = await eventIterator.next();
            if (next.done || socketClosed) break;
            const event = next.value;
            if (
              eventAccess.kind === "participant" &&
              !isParticipantEventVisible(event, eventAccess.side)
            ) {
              continue;
            }
            if (socketClosed || socket.readyState !== socket.OPEN) break;
            socket.send(JSON.stringify(mapSessionEvent(event)));
            const recordingState = mapRecordingStateEvent(event);
            if (recordingState !== undefined) {
              socket.send(JSON.stringify(recordingState));
            }
          }
          if (!socketClosed && socket.readyState === socket.OPEN) socket.terminate();
        } catch (error: unknown) {
          if (socketClosed || eventController.signal.aborted) return;
          safeSocketError(
            browserSocket,
            error instanceof RelaySessionError ? error.code : "event_stream_failed",
            error instanceof Error ? error.message : "The event stream failed",
          );
          if (socket.readyState === socket.OPEN) socket.close(1011, "Event stream failed");
        } finally {
          socketClosed = true;
          eventController.abort();
          await Promise.resolve(eventIterator?.return?.()).catch(() => undefined);
          browserSocket.off?.("close", onSocketClose);
        }
      })();
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
          browserMedia.attach(request.params.sessionId, side, browserSocket);
        } catch (error: unknown) {
          safeSocketError(
            browserSocket,
            "media_attach_rejected",
            error instanceof Error ? error.message : "Participant media attachment was rejected",
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

  return app;
}

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
  TRANSLATION_PROFILES,
  type GuardedDuplexRelay,
  type Lane,
  type RelayCommand,
  type SessionEvent,
  type SessionSnapshot,
  type Side,
  type TranslationProfile,
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
  importCsv(request: ImportGlossaryRequest): Promise<GlossaryImportResult>;
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

export interface ServerAppOptions {
  readonly relay: GuardedDuplexRelay;
  readonly glossaries: GlossaryRegistry;
  readonly browserMedia: BrowserMediaGateway;
  readonly access: ServerAccessControl;
  readonly webRoot?: string;
  readonly logger?: FastifyServerOptions["logger"];
  readonly https?: HttpsServerOptions;
  readonly translationProfiles?: readonly TranslationProfile[];
  readonly defaultTranslationProfile?: TranslationProfile;
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
        type: event.final ? "source_stable" : "source_partial",
        data: { text: event.text, final: event.final, ...sides },
      };
    case "target_transcript":
      return {
        ...base,
        type: "target_committed",
        data: { text: event.text, final: event.final, ...sides },
      };
    case "audio_playout": {
      const latencyMs = event.latencyMs;
      return {
        ...base,
        type: "latency",
        data: {
          firstAudioMs: latencyMs,
          latencyMs,
          sequence: event.frame.sequence,
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

function errorPayload(code: string, message: string): Readonly<{
  error: Readonly<{ code: string; message: string }>;
}> {
  return { error: { code, message } };
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
  const fastifyOptions = {
    bodyLimit: MAX_HTTP_BODY_BYTES,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.https === undefined ? {} : { https: options.https }),
  };
  const app = Fastify(fastifyOptions as FastifyServerOptions);
  const evidenceHealth = options.evidenceHealth ?? (() => "healthy");
  const sessionPayload = (snapshot: SessionSnapshot) => ({
    sessionId: snapshot.sessionId,
    state: snapshot.status,
    endpointGrants: [snapshot.participants.A, snapshot.participants.B],
    ...(snapshot.glossary === undefined ? {} : { glossaryHash: snapshot.glossary.hash }),
    evidenceHealth: evidenceHealth(),
  });

  const translationProfiles = Object.freeze([
    ...(options.translationProfiles ?? TRANSLATION_PROFILES),
  ]);
  const defaultTranslationProfile =
    options.defaultTranslationProfile ?? translationProfiles[0];
  if (
    defaultTranslationProfile === undefined ||
    !translationProfiles.includes(defaultTranslationProfile)
  ) {
    throw new TypeError("defaultTranslationProfile must be available");
  }

  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: resolve(options.webRoot ?? resolve(process.cwd(), "web")),
    index: "index.html",
    wildcard: true,
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      if (error.statusCode === 401) reply.header("www-authenticate", "Bearer");
      void reply.code(error.statusCode).send(errorPayload(error.code, error.message));
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
      mediaProfiles: ["browser_pair"],
      translationProfiles,
      defaultTranslationProfile,
      glossaryImportFormats: ["csv"],
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
      imported = await options.glossaries.importCsv(body);
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
    if (!translationProfiles.includes(body.translationProfileId)) {
      throw new ApiError(
        409,
        "translation_profile_unavailable",
        `Translation profile ${body.translationProfileId} is not configured on this server`,
      );
    }
    if (
      body.glossaryVersion !== undefined &&
      body.translationProfileId !== "glossary_controlled"
    ) {
      throw new ApiError(
        422,
        "glossary_profile_mismatch",
        "A glossary version can only be used with the glossary_controlled profile",
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
      profile: body.translationProfileId,
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
      if (!options.access.acceptsEventAccess(
        queryAccess(request.query.access),
        request.params.sessionId,
      )) {
        safeSocketError(browserSocket, "unauthorized", "A valid access token is required");
        socket.close(1008, "Unauthorized");
        return;
      }

      if (!Number.isSafeInteger(after) || after < 0) {
        safeSocketError(browserSocket, "invalid_cursor", "after must be a non-negative integer");
        socket.close(1008, "Invalid event cursor");
        return;
      }

      void (async () => {
        try {
          for await (const event of options.relay.events(request.params.sessionId, after)) {
            if (socket.readyState !== socket.OPEN) break;
            socket.send(JSON.stringify(mapSessionEvent(event)));
            const recordingState = mapRecordingStateEvent(event);
            if (recordingState !== undefined) {
              socket.send(JSON.stringify(recordingState));
            }
          }
          if (socket.readyState === socket.OPEN) socket.terminate();
        } catch (error: unknown) {
          safeSocketError(
            browserSocket,
            error instanceof RelaySessionError ? error.code : "event_stream_failed",
            error instanceof Error ? error.message : "The event stream failed",
          );
          if (socket.readyState === socket.OPEN) socket.close(1011, "Event stream failed");
        }
      })();
    },
  );

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
        options.browserMedia.attach(request.params.sessionId, side, browserSocket);
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
        options.browserMedia.detach(request.params.sessionId, side, browserSocket);
      });
    },
  );

  return app;
}

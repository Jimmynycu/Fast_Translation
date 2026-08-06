import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Side } from "../core/types.js";

const PARTICIPANT_TOKEN_CONTEXT = "fast-translation/participant-access/v1";
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_PRESENTED_TOKEN_LENGTH = 512;

export type EventAccessScope =
  | Readonly<{ kind: "operator" }>
  | Readonly<{ kind: "participant"; side: Side }>;

export interface ServerAccessControl {
  acceptsOperatorAuthorization(authorization: string | undefined): boolean;
  issueParticipantAccess(sessionId: string, side: Side): string;
  resolveEventAccess(
    access: string | undefined,
    sessionId: string,
  ): EventAccessScope | undefined;
  acceptsEventAccess(access: string | undefined, sessionId: string): boolean;
  acceptsMediaAccess(
    access: string | undefined,
    sessionId: string,
    side: Side,
  ): boolean;
}

export interface ServerAccessControlOptions {
  readonly operatorToken: string;
  readonly participantSigningKey?: Uint8Array;
}

export function createServerAccessControl(
  options: ServerAccessControlOptions,
): ServerAccessControl {
  if (
    options.operatorToken.length < MINIMUM_SECRET_BYTES ||
    options.operatorToken.length > MAXIMUM_PRESENTED_TOKEN_LENGTH
  ) {
    throw new RangeError("operatorToken must contain between 32 and 512 characters");
  }
  const participantSigningKey = Buffer.from(
    options.participantSigningKey ?? randomBytes(MINIMUM_SECRET_BYTES),
  );
  if (participantSigningKey.byteLength < MINIMUM_SECRET_BYTES) {
    throw new RangeError("participantSigningKey must contain at least 32 bytes");
  }

  const participantToken = (sessionId: string, side: Side): string => {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    const signature = createHmac("sha256", participantSigningKey)
      .update(PARTICIPANT_TOKEN_CONTEXT, "utf8")
      .update("\0", "utf8")
      .update(sessionId, "utf8")
      .update("\0", "utf8")
      .update(side, "utf8")
      .digest("base64url");
    return "p1." + signature;
  };

  const acceptsOperatorToken = (presented: string | undefined): boolean =>
    secureTokenEquals(presented, options.operatorToken);

  const resolveEventAccess = (
    access: string | undefined,
    sessionId: string,
  ): EventAccessScope | undefined => {
    if (acceptsOperatorToken(access)) return { kind: "operator" };
    for (const side of ["A", "B"] as const) {
      if (secureTokenEquals(access, participantToken(sessionId, side))) {
        return { kind: "participant", side };
      }
    }
    return undefined;
  };

  return Object.freeze({
    acceptsOperatorAuthorization(authorization: string | undefined) {
      return acceptsOperatorToken(bearerToken(authorization));
    },
    issueParticipantAccess: participantToken,
    resolveEventAccess,
    acceptsEventAccess(access: string | undefined, sessionId: string) {
      return resolveEventAccess(access, sessionId) !== undefined;
    },
    acceptsMediaAccess(access: string | undefined, sessionId: string, side: Side) {
      return secureTokenEquals(access, participantToken(sessionId, side));
    },
  });
}

export function withAccessFragment(url: URL, access: string): URL {
  const result = new URL(url);
  result.hash = new URLSearchParams({ access }).toString();
  return result;
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 ? undefined : token;
}

function secureTokenEquals(
  presented: string | undefined,
  expected: string,
): boolean {
  if (
    presented === undefined ||
    presented.length === 0 ||
    presented.length > MAXIMUM_PRESENTED_TOKEN_LENGTH
  ) {
    return false;
  }
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { EvidenceReviewGrant, Side } from "../core/types.js";

const PARTICIPANT_TOKEN_CONTEXT = "fast-translation/participant-access/v1";
const MINIMUM_SECRET_BYTES = 32;
const MAXIMUM_PRESENTED_TOKEN_LENGTH = 512;

export type EventAccessScope =
  | Readonly<{ kind: "operator" }>
  | Readonly<{ kind: "participant"; side: Side }>;

export type EvidenceManagementAccessScope =
  | Readonly<{ kind: "retention_owner"; actorId: string }>
  | Readonly<{ kind: "evidence_reviewer"; actorId: string }>;

export interface EvidenceManagementCredential {
  readonly id: string;
  readonly token: string;
}

export interface ServerAccessControl {
  acceptsOperatorAuthorization(authorization: string | undefined): boolean;
  evidenceReviewGrant(): EvidenceReviewGrant;
  issueParticipantAccess(sessionId: string, side: Side): string;
  resolveEventAccess(
    access: string | undefined,
    sessionId: string,
  ): EventAccessScope | undefined;
  resolveEvidenceManagementAuthorization(
    authorization: string | undefined,
  ): EvidenceManagementAccessScope | undefined;
  acceptsEventAccess(access: string | undefined, sessionId: string): boolean;
  acceptsParticipantAuthorization(
    authorization: string | undefined,
    sessionId: string,
    side: Side,
  ): boolean;
  acceptsMediaAccess(
    access: string | undefined,
    sessionId: string,
    side: Side,
  ): boolean;
}

export interface ServerAccessControlOptions {
  readonly operatorToken: string;
  readonly retentionOwner: EvidenceManagementCredential;
  readonly evidenceReviewer: EvidenceManagementCredential;
  readonly participantSigningKey?: Uint8Array;
}

export function createServerAccessControl(
  options: ServerAccessControlOptions,
): ServerAccessControl {
  if (
    typeof options.operatorToken !== "string" ||
    options.operatorToken.length < MINIMUM_SECRET_BYTES ||
    options.operatorToken.length > MAXIMUM_PRESENTED_TOKEN_LENGTH ||
    /\s/u.test(options.operatorToken)
  ) {
    throw new RangeError("operatorToken must contain 32-512 non-whitespace characters");
  }
  const retentionOwner = validateEvidenceManagementCredential(
    options.retentionOwner,
    "retentionOwner",
  );
  const evidenceReviewer = validateEvidenceManagementCredential(
    options.evidenceReviewer,
    "evidenceReviewer",
  );
  if (
    options.operatorToken === retentionOwner.token ||
    options.operatorToken === evidenceReviewer.token ||
    retentionOwner.token === evidenceReviewer.token
  ) {
    throw new RangeError("operator, retention owner, and evidence reviewer tokens must be distinct");
  }
  if (retentionOwner.id === evidenceReviewer.id) {
    throw new RangeError("retention owner and evidence reviewer identities must be distinct");
  }
  const evidenceReviewGrant = Object.freeze({
    dataOwnerId: retentionOwner.id,
    bilingualReviewerId: evidenceReviewer.id,
  });
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

  const resolveEvidenceManagementAuthorization = (
    authorization: string | undefined,
  ): EvidenceManagementAccessScope | undefined => {
    const token = bearerToken(authorization);
    if (secureTokenEquals(token, retentionOwner.token)) {
      return Object.freeze({ kind: "retention_owner" as const, actorId: retentionOwner.id });
    }
    if (secureTokenEquals(token, evidenceReviewer.token)) {
      return Object.freeze({ kind: "evidence_reviewer" as const, actorId: evidenceReviewer.id });
    }
    return undefined;
  };

  return Object.freeze({
    acceptsOperatorAuthorization(authorization: string | undefined) {
      return acceptsOperatorToken(bearerToken(authorization));
    },
    evidenceReviewGrant() {
      return evidenceReviewGrant;
    },
    issueParticipantAccess: participantToken,
    resolveEventAccess,
    resolveEvidenceManagementAuthorization,
    acceptsEventAccess(access: string | undefined, sessionId: string) {
      return resolveEventAccess(access, sessionId) !== undefined;
    },
    acceptsParticipantAuthorization(
      authorization: string | undefined,
      sessionId: string,
      side: Side,
    ) {
      return secureTokenEquals(bearerToken(authorization), participantToken(sessionId, side));
    },
    acceptsMediaAccess(access: string | undefined, sessionId: string, side: Side) {
      return secureTokenEquals(access, participantToken(sessionId, side));
    },
  });
}

function validateEvidenceManagementCredential(
  credential: EvidenceManagementCredential | undefined,
  name: string,
): EvidenceManagementCredential {
  const id = typeof credential?.id === "string"
    ? credential.id.normalize("NFC").trim()
    : undefined;
  if (
    credential === undefined ||
    id === undefined ||
    id.length === 0 ||
    id.length > 128
  ) {
    throw new RangeError(`${name}.id must contain 1-128 characters after NFC normalization`);
  }
  if (
    typeof credential.token !== "string" ||
    credential.token.length < MINIMUM_SECRET_BYTES ||
    credential.token.length > MAXIMUM_PRESENTED_TOKEN_LENGTH ||
    /\s/u.test(credential.token)
  ) {
    throw new RangeError(`${name}.token must contain 32-512 non-whitespace characters`);
  }
  return Object.freeze({ id, token: credential.token });
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

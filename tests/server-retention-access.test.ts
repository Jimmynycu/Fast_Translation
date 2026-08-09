import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServerAccessControl } from "../src/server/access.js";

const OPERATOR_TOKEN = "operator-0123456789abcdef0123456789abcdef";
const OWNER_TOKEN = "retention-owner-0123456789abcdef012345";
const REVIEWER_TOKEN = "evidence-reviewer-0123456789abcdef01234";

describe("evidence management access", () => {
  it("resolves only configured owner and reviewer identities from their bearer tokens", () => {
    const access = createServerAccessControl({
      operatorToken: OPERATOR_TOKEN,
      retentionOwner: {
        id: "customer-retention-owner",
        token: OWNER_TOKEN,
      },
      evidenceReviewer: {
        id: "customer-evidence-reviewer",
        token: REVIEWER_TOKEN,
      },
      participantSigningKey: Buffer.alloc(32, 23),
    });

    assert.deepEqual(
      access.resolveEvidenceManagementAuthorization("Bearer " + OWNER_TOKEN),
      { kind: "retention_owner", actorId: "customer-retention-owner" },
    );
    assert.deepEqual(
      access.resolveEvidenceManagementAuthorization("Bearer " + REVIEWER_TOKEN),
      { kind: "evidence_reviewer", actorId: "customer-evidence-reviewer" },
    );
  });

  it("derives one immutable per-session review grant from configured management identities", () => {
    const access = createServerAccessControl({
      operatorToken: OPERATOR_TOKEN,
      retentionOwner: {
        id: "customer-retention-owner",
        token: OWNER_TOKEN,
      },
      evidenceReviewer: {
        id: "customer-evidence-reviewer",
        token: REVIEWER_TOKEN,
      },
      participantSigningKey: Buffer.alloc(32, 23),
    });

    const grant = access.evidenceReviewGrant();
    assert.deepEqual(grant, {
      dataOwnerId: "customer-retention-owner",
      bilingualReviewerId: "customer-evidence-reviewer",
    });
    assert.equal(Object.isFrozen(grant), true);
  });

  it("uses NFC-normalized configured identities consistently for grants and resolved actors", () => {
    const access = createServerAccessControl({
      operatorToken: OPERATOR_TOKEN,
      retentionOwner: {
        id: "cafe\u0301-data-owner",
        token: OWNER_TOKEN,
      },
      evidenceReviewer: {
        id: "re\u0301viewer",
        token: REVIEWER_TOKEN,
      },
      participantSigningKey: Buffer.alloc(32, 23),
    });

    assert.deepEqual(access.evidenceReviewGrant(), {
      dataOwnerId: "café-data-owner",
      bilingualReviewerId: "réviewer",
    });
    assert.deepEqual(
      access.resolveEvidenceManagementAuthorization("Bearer " + OWNER_TOKEN),
      { kind: "retention_owner", actorId: "café-data-owner" },
    );
    assert.deepEqual(
      access.resolveEvidenceManagementAuthorization("Bearer " + REVIEWER_TOKEN),
      { kind: "evidence_reviewer", actorId: "réviewer" },
    );
  });

  it("does not grant a management role to operator, participant, malformed, or foreign tokens", () => {
    const access = createServerAccessControl({
      operatorToken: OPERATOR_TOKEN,
      retentionOwner: {
        id: "customer-retention-owner",
        token: OWNER_TOKEN,
      },
      evidenceReviewer: {
        id: "customer-evidence-reviewer",
        token: REVIEWER_TOKEN,
      },
      participantSigningKey: Buffer.alloc(32, 23),
    });

    const participant = access.issueParticipantAccess("session-1", "A");
    for (const authorization of [
      "Bearer " + OPERATOR_TOKEN,
      "Bearer " + participant,
      "Bearer foreign-0123456789abcdef0123456789",
      OWNER_TOKEN,
      undefined,
    ]) {
      assert.equal(access.resolveEvidenceManagementAuthorization(authorization), undefined);
    }
  });

  it("refuses overlapping server-config management credentials", () => {
    assert.throws(
      () => createServerAccessControl({
        operatorToken: OPERATOR_TOKEN,
        retentionOwner: { id: "customer-retention-owner", token: OPERATOR_TOKEN },
        evidenceReviewer: { id: "customer-evidence-reviewer", token: REVIEWER_TOKEN },
      }),
      /must be distinct/i,
    );
    assert.throws(
      () => createServerAccessControl({
        operatorToken: OPERATOR_TOKEN,
        retentionOwner: { id: "same-configured-id", token: OWNER_TOKEN },
        evidenceReviewer: { id: "same-configured-id", token: REVIEWER_TOKEN },
      }),
      /identities must be distinct/i,
    );
    assert.throws(
      () => createServerAccessControl({
        operatorToken: OPERATOR_TOKEN,
        retentionOwner: { id: "cafe\u0301", token: OWNER_TOKEN },
        evidenceReviewer: { id: "café", token: REVIEWER_TOKEN },
      }),
      /identities must be distinct/i,
    );
  });
});

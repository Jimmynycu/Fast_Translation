import { Buffer } from "node:buffer";
import { z } from "zod";

const CANONICAL_LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/u;
const EVIDENCE_REVIEW_CURSOR_PREFIX = "evidence-review-v1";

function isCanonicalBase64UrlToken(value: string, expectedByteLength?: number): boolean {
  if (!BASE64URL_TOKEN.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength > 0 &&
    (expectedByteLength === undefined || decoded.byteLength === expectedByteLength) &&
    decoded.toString("base64url") === value;
}

function isEvidenceReviewCursor(value: string): boolean {
  if (value.length > 512) return false;
  const parts = value.split(".");
  return parts.length === 4 &&
    parts[0] === EVIDENCE_REVIEW_CURSOR_PREFIX &&
    isCanonicalBase64UrlToken(parts[1] ?? "", 12) &&
    isCanonicalBase64UrlToken(parts[2] ?? "") &&
    isCanonicalBase64UrlToken(parts[3] ?? "", 16);
}

const managementCommandSchema = z.object({
  commandId: z.string().regex(CANONICAL_LOWERCASE_UUID, {
    message: "commandId must be a canonical lowercase UUID v1-v8 with an RFC variant",
  }),
});

const reasonSchema = z.string().trim().min(1).max(500);

const utcDeadlineSchema = z.string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), {
    message: "requestedDeadline must be an ISO-8601 UTC timestamp",
  });

export const retentionExtensionRequestSchema = managementCommandSchema.extend({
  reason: reasonSchema,
  requestedDeadline: utcDeadlineSchema,
}).strict();

export const earlyEvidenceDeletionRequestSchema = managementCommandSchema.extend({
  reason: reasonSchema,
}).strict();

export const managedPlaintextExportRequestSchema = managementCommandSchema.extend({
  acknowledgePlaintextExport: z.literal(true),
}).strict();

export const evidenceReviewMetadataRequestSchema = z.object({
  cursor: z.string().refine(isEvidenceReviewCursor, {
    message: "cursor must be a canonical evidence-review cursor",
  }).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
}).strict();

export const evidenceReviewAudioWindowRequestSchema = z.object({
  track: z.enum(["source_a", "source_b", "playout_to_a", "playout_to_b"]),
  startOffsetMs: z.number().int().nonnegative().multipleOf(20),
  durationMs: z.number().int().min(20).max(30_000).multipleOf(20),
}).strict();

export type RetentionExtensionRequest = z.infer<typeof retentionExtensionRequestSchema>;
export type EarlyEvidenceDeletionRequest = z.infer<typeof earlyEvidenceDeletionRequestSchema>;
export type ManagedPlaintextExportRequest = z.infer<typeof managedPlaintextExportRequestSchema>;
export type EvidenceReviewMetadataRequest = z.infer<typeof evidenceReviewMetadataRequestSchema>;
export type EvidenceReviewAudioWindowRequest = z.infer<typeof evidenceReviewAudioWindowRequestSchema>;

import { createHash } from "node:crypto";
import type { TranslationEvent } from "../../core/types.js";

export type TranslationEvidenceRefSource = "controlled" | "deterministic" | "local_eval";
export type OpaqueEvidenceRefPart = string | number | boolean | null;

type WithoutEvidenceRef<Event> = Event extends unknown ? Omit<Event, "evidenceRef"> : never;

export type DraftTranslationEvent = WithoutEvidenceRef<TranslationEvent>;

/**
 * Produces a versioned, opaque reference from a namespace and canonical
 * identity parts. The serialized identity is hashed, never encoded directly.
 */
export function createOpaqueEvidenceRef(
  namespace: string,
  parts: readonly OpaqueEvidenceRefPart[],
): string {
  const canonicalIdentity = JSON.stringify([namespace, ...parts]);
  const digest = createHash("sha256").update(canonicalIdentity, "utf8").digest("hex");
  return namespace + ":v1:sha256:" + digest;
}

/**
 * Produces an opaque event reference from immutable translation-event identity
 * plus its position in one adapter emission stream. The ordinal makes repeated
 * provider errors distinguishable without leaking session or transcript data.
 */
export function attachTranslationEvidenceRef(
  source: TranslationEvidenceRefSource,
  ordinal: number,
  event: DraftTranslationEvent,
): TranslationEvent {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new RangeError("translation evidence ordinal must be a non-negative safe integer");
  }
  return {
    ...event,
    evidenceRef: createOpaqueEvidenceRef(source, [
      event.sessionId,
      event.lane,
      event.generation,
      event.turnId,
      event.segmentId,
      event.revision,
      event.finality,
      event.kind,
      ordinal,
    ]),
  } as TranslationEvent;
}

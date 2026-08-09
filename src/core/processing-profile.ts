import { createHash } from "node:crypto";
import { compileGlossary } from "./glossary.js";
import type { GlossaryReference, ParticipantConsentCommand, SessionSpec } from "./types.js";
import type { TranslationMode, TranslationProviderId } from "./translation-behavior.js";

export type Sha256 = string;

export interface ContractEvidenceReference {
  readonly id: string;
  readonly revision: string;
  readonly sha256: Sha256;
  readonly approvedBy: string;
  readonly approvedAtUtc: string;
}

export type ExternalAssurance<T> =
  | Readonly<{ readonly status: "verified"; readonly value: T; readonly evidenceRef: ContractEvidenceReference }>
  | Readonly<{ readonly status: "unverified"; readonly reason: string; readonly acceptanceImpact: "NOT_RUN" }>;

export type ProcessingServiceRole = "speech_to_speech" | "transcription" | "text_translation" | "tts";
export type ProcessingServiceCategory =
  | "managed_realtime_speech_translation"
  | "managed_transcription"
  | "managed_text_translation"
  | "managed_tts";
export type ProcessingServiceDataCategory =
  | "canonical_audio"
  | "source_language"
  | "target_language"
  | "source_transcript"
  | "source_terms"
  | "aliases"
  | "opaque_placeholders"
  | "authorized_target_text";

export interface ProcessingService {
  readonly id: string;
  readonly role: ProcessingServiceRole;
  readonly provider: "openai" | "palabra";
  readonly category: ProcessingServiceCategory;
  /**
   * Exact non-secret categories the route sends to this provider. The
   * approved profile and every session manifest pin this ordered projection.
   */
  readonly dataCategories: readonly ProcessingServiceDataCategory[];
  readonly endpoint: Readonly<{ readonly origin: string; readonly pathTemplate: string }>;
  readonly model:
    | Readonly<{ readonly kind: "named"; readonly value: string }>
    | Readonly<{ readonly kind: "vendor_managed"; readonly reason: string }>;
  readonly voice:
    | Readonly<{ readonly kind: "named"; readonly value: string }>
    | Readonly<{ readonly kind: "provider_managed"; readonly reason: string }>
    | Readonly<{ readonly kind: "not_applicable" }>;
  readonly region: ExternalAssurance<string>;
  readonly trainingUse: ExternalAssurance<"no_training">;
  readonly serviceRetention: ExternalAssurance<
    | Readonly<{ readonly kind: "zero_retention" }>
    | Readonly<{ readonly kind: "bounded"; readonly maximumDays: number }>
  >;
  readonly dpa: ExternalAssurance<ContractEvidenceReference>;
}

export interface ConsentPolicyReference extends ContractEvidenceReference {
  readonly noticeVersion: string;
  readonly recordingRequired: true;
  readonly processingRequired: true;
  readonly withdrawalTerminatesSession: true;
}

export interface SessionProcessingProfileReference {
  readonly id: string;
  readonly version: string;
  readonly sha256: Sha256;
}

export interface GlossaryEgressControl {
  readonly harnessPinnedGlossary: "disallowed" | "local_pinned";
  readonly stages: readonly Readonly<{
    readonly role: ProcessingServiceRole;
    readonly fields: readonly (
      | "source_terms"
      | "aliases"
      | "opaque_placeholders"
      | "authorized_target_text"
    )[];
  }>[];
  readonly providerAccountGlossary: ExternalAssurance<"disabled" | "snapshot_and_hash_at_session_boundary">;
}

export interface EvidenceControls {
  readonly storage: "local_encrypted_file";
  readonly encryption: "aes_256_gcm";
  readonly tracks: readonly ["source_a", "source_b", "playout_to_a", "playout_to_b"];
  readonly providerEvents: "final_only";
  readonly provisionalEvents: "live_only";
  readonly browserEvidenceRefs: "redacted";
  readonly plaintextExport: "explicit_owner_acknowledgement";
  readonly minimumFreeBytes: string;
}

export interface RetentionPolicy {
  readonly policyRef: ContractEvidenceReference;
  readonly mode: "scheduled_delete";
  readonly defaultDays: 14;
  readonly maximumDays: 30;
  readonly verificationMaximumHours: 24;
}

export interface ApprovedSessionProcessingProfile {
  readonly schemaVersion: 1;
  readonly kind: "approved_session_processing_profile";
  readonly id: string;
  readonly version: string;
  readonly sha256: Sha256;
  readonly operationScope: "poc" | "production";
  readonly translation: Readonly<{
    readonly provider: TranslationProviderId;
    readonly allowedModes: readonly TranslationMode[];
    readonly defaultMode: TranslationMode;
    readonly behaviorVersion: 1;
  }>;
  readonly services: readonly ProcessingService[];
  readonly glossaryEgress: GlossaryEgressControl;
  readonly fallback: Readonly<{
    readonly kind: "none" | "same_route_fail_open";
    readonly approval: ContractEvidenceReference;
  }>;
  readonly evidence: EvidenceControls;
  readonly retentionPolicy: RetentionPolicy;
  readonly consentPolicy: ConsentPolicyReference;
  readonly approval: Readonly<{
    readonly approvalId: string;
    readonly approvedBy: string;
    readonly approvedAtUtc: string;
  }>;
}

export interface SessionProcessingManifest {
  readonly schemaVersion: 1;
  readonly profile: SessionProcessingProfileReference;
  readonly operationScope: "poc" | "production";
  readonly acceptanceImpact: "PASS" | "NOT_RUN";
  readonly selectedTranslation: Readonly<{
    readonly provider: TranslationProviderId;
    readonly mode: TranslationMode;
    readonly behaviorVersion: 1;
    readonly servicesSha256: Sha256;
  }>;
  readonly services: readonly ProcessingService[];
  readonly consentPolicyRef: ConsentPolicyReference;
  readonly glossaryEgress: GlossaryEgressControl;
  readonly fallback: ApprovedSessionProcessingProfile["fallback"];
  readonly evidence: EvidenceControls;
  readonly retentionPolicy: RetentionPolicy;
  readonly glossary?: GlossaryReference;
  readonly manifestSha256: Sha256;
}

export interface ProcessingProfileValidation {
  readonly acceptanceImpact: "PASS" | "NOT_RUN";
  readonly unverifiedAssurances: readonly string[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
        .map((key) => [key, canonical(object[key])]),
    );
  }
  return value;
}

export function canonicalJsonSha256(value: unknown): Sha256 {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function assertNonempty(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} is required`);
}

function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${field} must be a lowercase SHA-256`);
}

function assertUtc(value: string, field: string): void {
  if (typeof value !== "string" || !value.endsWith("Z") || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be a canonical UTC timestamp`);
  }
}

function assertContractReference(reference: ContractEvidenceReference, field: string): void {
  assertNonempty(reference.id, `${field}.id`);
  assertNonempty(reference.revision, `${field}.revision`);
  assertSha256(reference.sha256, `${field}.sha256`);
  assertNonempty(reference.approvedBy, `${field}.approvedBy`);
  assertUtc(reference.approvedAtUtc, `${field}.approvedAtUtc`);
}

function profileBody(profile: ApprovedSessionProcessingProfile): Omit<ApprovedSessionProcessingProfile, "sha256"> {
  const { sha256: _sha256, ...body } = profile;
  return body;
}

function manifestBody(manifest: SessionProcessingManifest): Omit<SessionProcessingManifest, "manifestSha256"> {
  const { manifestSha256: _sha256, ...body } = manifest;
  return body;
}

function expectedRoles(provider: TranslationProviderId): readonly ProcessingServiceRole[] {
  return provider === "openai_controlled"
    ? ["transcription", "text_translation", "tts"]
    : ["speech_to_speech"];
}

const PROVIDERS = new Set<TranslationProviderId>(["palabra", "openai_native", "openai_controlled"]);
const MODES = new Set<TranslationMode>(["fast", "balanced", "accurate"]);
const DATA_CATEGORIES = new Set<ProcessingServiceDataCategory>([
  "canonical_audio",
  "source_language",
  "target_language",
  "source_transcript",
  "source_terms",
  "aliases",
  "opaque_placeholders",
  "authorized_target_text",
]);

type UnknownObject = Record<string, unknown>;

const PROFILE_KEYS = [
  "schemaVersion",
  "kind",
  "id",
  "version",
  "sha256",
  "operationScope",
  "translation",
  "services",
  "glossaryEgress",
  "fallback",
  "evidence",
  "retentionPolicy",
  "consentPolicy",
  "approval",
] as const;
const TRANSLATION_KEYS = ["provider", "allowedModes", "defaultMode", "behaviorVersion"] as const;
const SERVICE_KEYS = [
  "id",
  "role",
  "provider",
  "category",
  "dataCategories",
  "endpoint",
  "model",
  "voice",
  "region",
  "trainingUse",
  "serviceRetention",
  "dpa",
] as const;
const ENDPOINT_KEYS = ["origin", "pathTemplate"] as const;
const MODEL_KEYS = ["kind", "value", "reason"] as const;
const VOICE_KEYS = ["kind", "value", "reason"] as const;
const ASSURANCE_KEYS = ["status", "value", "evidenceRef", "reason", "acceptanceImpact"] as const;
const CONTRACT_REFERENCE_KEYS = ["id", "revision", "sha256", "approvedBy", "approvedAtUtc"] as const;
const SERVICE_RETENTION_VALUE_KEYS = ["kind", "maximumDays"] as const;
const GLOSSARY_EGRESS_KEYS = ["harnessPinnedGlossary", "stages", "providerAccountGlossary"] as const;
const GLOSSARY_STAGE_KEYS = ["role", "fields"] as const;
const FALLBACK_KEYS = ["kind", "approval"] as const;
const EVIDENCE_KEYS = [
  "storage",
  "encryption",
  "tracks",
  "providerEvents",
  "provisionalEvents",
  "browserEvidenceRefs",
  "plaintextExport",
  "minimumFreeBytes",
] as const;
const RETENTION_POLICY_KEYS = [
  "policyRef",
  "mode",
  "defaultDays",
  "maximumDays",
  "verificationMaximumHours",
] as const;
const CONSENT_POLICY_KEYS = [
  "id",
  "revision",
  "sha256",
  "approvedBy",
  "approvedAtUtc",
  "noticeVersion",
  "recordingRequired",
  "processingRequired",
  "withdrawalTerminatesSession",
] as const;
const APPROVAL_KEYS = ["approvalId", "approvedBy", "approvedAtUtc"] as const;
const GLOSSARY_REFERENCE_KEYS = ["id", "version", "hash"] as const;
const MANIFEST_KEYS = [
  "schemaVersion",
  "profile",
  "operationScope",
  "acceptanceImpact",
  "selectedTranslation",
  "services",
  "consentPolicyRef",
  "glossaryEgress",
  "fallback",
  "evidence",
  "retentionPolicy",
  "glossary",
  "manifestSha256",
] as const;
const MANIFEST_PROFILE_KEYS = ["id", "version", "sha256"] as const;
const SELECTED_TRANSLATION_KEYS = ["provider", "mode", "behaviorVersion", "servicesSha256"] as const;

function assertObject(value: unknown, field: string): asserts value is UnknownObject {
  const prototype = value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.getPrototypeOf(value)
    : undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError(`${field} must be an object`);
  }
}

function assertArray(value: unknown, field: string): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (
      typeof key !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(key) ||
      Number(key) >= value.length
    ) {
      throw new TypeError(`${field} contains unknown key: ${String(key)}`);
    }
  }
}

function assertExactKeys(value: UnknownObject, field: string, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      !Object.prototype.propertyIsEnumerable.call(value, key)
    ) {
      throw new TypeError(`${field} contains unknown key: ${String(key)}`);
    }
  }
}

function objectWithKeys(value: unknown, field: string, keys: readonly string[]): UnknownObject {
  assertObject(value, field);
  assertExactKeys(value, field, keys);
  return value;
}

function assertContractReferenceShape(value: unknown, field: string): void {
  objectWithKeys(value, field, CONTRACT_REFERENCE_KEYS);
}

function assertGlossaryReferenceShape(value: unknown, field: string): void {
  objectWithKeys(value, field, GLOSSARY_REFERENCE_KEYS);
}

function assertAssuranceShape(value: unknown, field: string, nestedValue: "none" | "retention" | "contract"): void {
  const assurance = objectWithKeys(value, field, ASSURANCE_KEYS);
  if (assurance.status === "verified") {
    assertExactKeys(assurance, field, ["status", "value", "evidenceRef"]);
    if (nestedValue === "retention") {
      const retention = objectWithKeys(assurance.value, `${field}.value`, SERVICE_RETENTION_VALUE_KEYS);
      if (retention.kind === "zero_retention") {
        assertExactKeys(retention, `${field}.value`, ["kind"]);
      } else if (retention.kind === "bounded") {
        assertExactKeys(retention, `${field}.value`, ["kind", "maximumDays"]);
      }
    } else if (nestedValue === "contract") {
      assertContractReferenceShape(assurance.value, `${field}.value`);
    }
    assertContractReferenceShape(assurance.evidenceRef, `${field}.evidenceRef`);
    return;
  }
  if (assurance.status === "unverified") {
    assertExactKeys(assurance, field, ["status", "reason", "acceptanceImpact"]);
    return;
  }
  // Keep the semantic validator's unsupported-discriminant error for unknown
  // statuses, while still rejecting arbitrary fields at this boundary.
  assertExactKeys(assurance, field, ASSURANCE_KEYS);
}

function assertModelShape(value: unknown, field: string): void {
  const model = objectWithKeys(value, field, MODEL_KEYS);
  if (model.kind === "named") assertExactKeys(model, field, ["kind", "value"]);
  else if (model.kind === "vendor_managed") assertExactKeys(model, field, ["kind", "reason"]);
}

function assertVoiceShape(value: unknown, field: string): void {
  const voice = objectWithKeys(value, field, VOICE_KEYS);
  if (voice.kind === "named") assertExactKeys(voice, field, ["kind", "value"]);
  else if (voice.kind === "provider_managed") assertExactKeys(voice, field, ["kind", "reason"]);
  else if (voice.kind === "not_applicable") assertExactKeys(voice, field, ["kind"]);
}

function assertServiceShape(value: unknown, index: number, collectionField = "profile.services"): void {
  const field = `${collectionField}[${index}]`;
  const service = objectWithKeys(value, field, SERVICE_KEYS);
  objectWithKeys(service.endpoint, `${field}.endpoint`, ENDPOINT_KEYS);
  // Let the service validator retain its established missing-field diagnostic;
  // present arrays still receive exact-key checks.
  if (service.dataCategories !== undefined) {
    assertArray(service.dataCategories, `${field}.dataCategories`);
  }
  assertModelShape(service.model, `${field}.model`);
  assertVoiceShape(service.voice, `${field}.voice`);
  assertAssuranceShape(service.region, `${field}.region`, "none");
  assertAssuranceShape(service.trainingUse, `${field}.trainingUse`, "none");
  assertAssuranceShape(service.serviceRetention, `${field}.serviceRetention`, "retention");
  assertAssuranceShape(service.dpa, `${field}.dpa`, "contract");
}

function assertGlossaryEgressShape(value: unknown, field: string): void {
  const glossaryEgress = objectWithKeys(value, field, GLOSSARY_EGRESS_KEYS);
  assertArray(glossaryEgress.stages, `${field}.stages`);
  glossaryEgress.stages.forEach((stage, index) => {
    const stageField = `${field}.stages[${index}]`;
    const stageObject = objectWithKeys(stage, stageField, GLOSSARY_STAGE_KEYS);
    assertArray(stageObject.fields, `${stageField}.fields`);
  });
  assertAssuranceShape(
    glossaryEgress.providerAccountGlossary,
    `${field}.providerAccountGlossary`,
    "none",
  );
}

function assertApprovedSessionProcessingProfileShape(value: unknown): asserts value is ApprovedSessionProcessingProfile {
  const profile = objectWithKeys(value, "profile", PROFILE_KEYS);
  const translation = objectWithKeys(profile.translation, "profile.translation", TRANSLATION_KEYS);
  assertArray(translation.allowedModes, "profile.translation.allowedModes");
  assertArray(profile.services, "profile.services");
  profile.services.forEach((service, index) => assertServiceShape(service, index));
  assertGlossaryEgressShape(profile.glossaryEgress, "profile.glossaryEgress");

  const fallback = objectWithKeys(profile.fallback, "profile.fallback", FALLBACK_KEYS);
  assertContractReferenceShape(fallback.approval, "profile.fallback.approval");

  objectWithKeys(profile.evidence, "profile.evidence", EVIDENCE_KEYS);

  const retentionPolicy = objectWithKeys(profile.retentionPolicy, "profile.retentionPolicy", RETENTION_POLICY_KEYS);
  assertContractReferenceShape(retentionPolicy.policyRef, "profile.retentionPolicy.policyRef");

  objectWithKeys(profile.consentPolicy, "profile.consentPolicy", CONSENT_POLICY_KEYS);

  objectWithKeys(profile.approval, "profile.approval", APPROVAL_KEYS);
}

function assertSessionProcessingManifestShape(value: unknown): asserts value is SessionProcessingManifest {
  const manifest = objectWithKeys(value, "processingManifest", MANIFEST_KEYS);
  objectWithKeys(manifest.profile, "processingManifest.profile", MANIFEST_PROFILE_KEYS);
  objectWithKeys(
    manifest.selectedTranslation,
    "processingManifest.selectedTranslation",
    SELECTED_TRANSLATION_KEYS,
  );
  assertArray(manifest.services, "processingManifest.services");
  manifest.services.forEach((service, index) => {
    assertServiceShape(service, index, "processingManifest.services");
  });
  objectWithKeys(manifest.consentPolicyRef, "processingManifest.consentPolicyRef", CONSENT_POLICY_KEYS);
  assertGlossaryEgressShape(manifest.glossaryEgress, "processingManifest.glossaryEgress");

  const fallback = objectWithKeys(manifest.fallback, "processingManifest.fallback", FALLBACK_KEYS);
  assertContractReferenceShape(fallback.approval, "processingManifest.fallback.approval");

  objectWithKeys(manifest.evidence, "processingManifest.evidence", EVIDENCE_KEYS);

  const retentionPolicy = objectWithKeys(
    manifest.retentionPolicy,
    "processingManifest.retentionPolicy",
    RETENTION_POLICY_KEYS,
  );
  assertContractReferenceShape(
    retentionPolicy.policyRef,
    "processingManifest.retentionPolicy.policyRef",
  );

  if (manifest.glossary !== undefined) {
    assertGlossaryReferenceShape(manifest.glossary, "processingManifest.glossary");
  }
}

function assertProvider(value: TranslationProviderId, field: string): void {
  if (!PROVIDERS.has(value)) throw new TypeError(`${field} is unsupported`);
}

function assertMode(value: TranslationMode, field: string): void {
  if (!MODES.has(value)) throw new TypeError(`${field} is unsupported`);
}

function assertAssurance<T>(
  assurance: ExternalAssurance<T>,
  field: string,
  validateValue: (value: T, field: string) => void,
): void {
  if (assurance.status === "unverified") {
    assertNonempty(assurance.reason, `${field}.reason`);
    if (assurance.acceptanceImpact !== "NOT_RUN") {
      throw new TypeError(`${field}.acceptanceImpact must be NOT_RUN`);
    }
    return;
  }
  if (assurance.status !== "verified") throw new TypeError(`${field}.status is unsupported`);
  validateValue(assurance.value, `${field}.value`);
  assertContractReference(assurance.evidenceRef, `${field}.evidenceRef`);
}

function expectedService(provider: TranslationProviderId, role: ProcessingServiceRole): Readonly<{
  provider: ProcessingService["provider"];
  category: ProcessingServiceCategory;
}> {
  if (role === "speech_to_speech") {
    return {
      provider: provider === "palabra" ? "palabra" : "openai",
      category: "managed_realtime_speech_translation",
    };
  }
  const category = role === "transcription"
    ? "managed_transcription"
    : role === "text_translation"
      ? "managed_text_translation"
      : "managed_tts";
  return { provider: "openai", category };
}

function expectedServiceDataCategories(
  provider: TranslationProviderId,
  role: ProcessingServiceRole,
): readonly ProcessingServiceDataCategory[] {
  if (role === "speech_to_speech") {
    if (provider === "palabra") {
      return ["canonical_audio", "source_language", "target_language"];
    }
    if (provider === "openai_native") {
      return ["canonical_audio", "target_language"];
    }
    throw new TypeError("Processing service role does not match the selected provider route");
  }
  if (provider !== "openai_controlled") {
    throw new TypeError("Processing service role does not match the selected provider route");
  }
  switch (role) {
    case "transcription":
      return ["canonical_audio", "source_language", "source_terms", "aliases"];
    case "text_translation":
      return ["source_transcript", "source_language", "target_language", "opaque_placeholders"];
    case "tts":
      return ["authorized_target_text"];
    default:
      throw new TypeError("Processing service role is unsupported");
  }
}

function validateServiceDataCategories(
  service: ProcessingService,
  provider: TranslationProviderId,
): void {
  if (!Array.isArray(service.dataCategories)) {
    throw new TypeError("Processing service dataCategories is required");
  }
  if (service.dataCategories.length === 0) {
    throw new TypeError("Processing service dataCategories must not be empty");
  }
  const categories = new Set<ProcessingServiceDataCategory>();
  for (const category of service.dataCategories) {
    if (!DATA_CATEGORIES.has(category)) {
      throw new TypeError("Processing service dataCategories contains an unsupported value");
    }
    if (categories.has(category)) {
      throw new TypeError("Processing service dataCategories must be unique");
    }
    categories.add(category);
  }
  if (
    canonicalJsonSha256(service.dataCategories) !==
      canonicalJsonSha256(expectedServiceDataCategories(provider, service.role))
  ) {
    throw new TypeError("Processing service dataCategories do not match the approved provider route");
  }
}

function validateService(service: ProcessingService, provider: TranslationProviderId): void {
  assertNonempty(service.id, "service.id");
  const expected = expectedService(provider, service.role);
  if (service.provider !== expected.provider || service.category !== expected.category) {
    throw new TypeError("Processing service does not match its approved provider route");
  }
  validateServiceDataCategories(service, provider);
  const endpoint = new URL(service.endpoint.origin);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/"
  ) {
    throw new TypeError("Service endpoint origin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  const pathTemplate = service.endpoint.pathTemplate;
  const hashMarker = "{hash}";
  const hashMarkerCount = pathTemplate.split(hashMarker).length - 1;
  const isPalabraSpeechService = service.provider === "palabra" && service.role === "speech_to_speech";
  const hasEncodedHashMarker = /%7bhash%7d/iu.test(pathTemplate);
  const hasExactlyOneWholeSegmentHash =
    hashMarkerCount === 1 &&
    !hasEncodedHashMarker &&
    /(?:^|\/)\{hash\}(?:\/|$)/u.test(pathTemplate);
  if (isPalabraSpeechService && !hasExactlyOneWholeSegmentHash) {
    throw new TypeError(
      "Palabra service endpoint pathTemplate must contain exactly one literal {hash} whole path segment",
    );
  }
  if (!isPalabraSpeechService && hashMarkerCount > 0) {
    throw new TypeError("Service endpoint pathTemplate has an unsupported placeholder");
  }
  const canonicalPathTemplate = hashMarkerCount === 1
    ? pathTemplate.replace(hashMarker, "fast-translation-hash")
    : pathTemplate;
  if (
    !canonicalPathTemplate.startsWith("/") ||
    canonicalPathTemplate.startsWith("//") ||
    canonicalPathTemplate.includes("\\") ||
    canonicalPathTemplate.includes("://") ||
    canonicalPathTemplate.includes("?") ||
    canonicalPathTemplate.includes("#") ||
    canonicalPathTemplate.includes("{") ||
    canonicalPathTemplate.includes("}") ||
    /%(?:2f|5c)/iu.test(canonicalPathTemplate)
  ) {
    throw new TypeError(
      "Service endpoint pathTemplate must be a canonical origin-relative path without network, scheme, query, fragment, or backslash overrides",
    );
  }
  const resolvedEndpoint = new URL(canonicalPathTemplate, endpoint);
  if (
    resolvedEndpoint.protocol !== "https:" ||
    resolvedEndpoint.origin !== endpoint.origin ||
    resolvedEndpoint.username ||
    resolvedEndpoint.password ||
    resolvedEndpoint.search ||
    resolvedEndpoint.hash ||
    resolvedEndpoint.pathname !== canonicalPathTemplate
  ) {
    throw new TypeError(
      "Service endpoint pathTemplate must canonically resolve under its declared HTTPS origin",
    );
  }
  if (service.model.kind === "named") assertNonempty(service.model.value, "service.model.value");
  else if (service.model.kind === "vendor_managed") assertNonempty(service.model.reason, "service.model.reason");
  else throw new TypeError("Service model kind is unsupported");
  if (service.voice.kind === "named") assertNonempty(service.voice.value, "service.voice.value");
  else if (service.voice.kind === "provider_managed") assertNonempty(service.voice.reason, "service.voice.reason");
  else if (service.voice.kind !== "not_applicable") throw new TypeError("Service voice kind is unsupported");
  assertAssurance(service.region, "service.region", (value, field) => assertNonempty(value, field));
  assertAssurance(service.trainingUse, "service.trainingUse", (value, field) => {
    if (value !== "no_training") throw new TypeError(`${field} must be no_training`);
  });
  assertAssurance(service.serviceRetention, "service.serviceRetention", (value, field) => {
    if (value.kind === "zero_retention") return;
    if (
      value.kind !== "bounded" ||
      !Number.isSafeInteger(value.maximumDays) ||
      value.maximumDays <= 0
    ) {
      throw new TypeError(`${field} is invalid`);
    }
  });
  assertAssurance(service.dpa, "service.dpa", (value, field) => assertContractReference(value, field));
}

function expectedGlossaryStages(provider: TranslationProviderId): GlossaryEgressControl["stages"] {
  return provider === "openai_controlled"
    ? [
        { role: "transcription", fields: ["source_terms", "aliases"] },
        { role: "text_translation", fields: ["opaque_placeholders"] },
        { role: "tts", fields: ["authorized_target_text"] },
      ]
    : [];
}

function validateGlossaryEgress(control: GlossaryEgressControl, provider: TranslationProviderId): void {
  const expectedPinned = provider === "openai_controlled" ? "local_pinned" : "disallowed";
  if (
    control.harnessPinnedGlossary !== expectedPinned ||
    canonicalJsonSha256(control.stages) !== canonicalJsonSha256(expectedGlossaryStages(provider))
  ) {
    throw new TypeError("Glossary egress controls do not match the selected provider route");
  }
  assertAssurance(control.providerAccountGlossary, "glossaryEgress.providerAccountGlossary", (value, field) => {
    if (value !== "disabled" && value !== "snapshot_and_hash_at_session_boundary") {
      throw new TypeError(`${field} is unsupported`);
    }
  });
}

function collectUnverified(profile: ApprovedSessionProcessingProfile): string[] {
  const paths: string[] = [];
  for (const service of profile.services) {
    const assurances: readonly [string, ExternalAssurance<unknown>][] = [
      ["region", service.region],
      ["trainingUse", service.trainingUse],
      ["serviceRetention", service.serviceRetention],
      ["dpa", service.dpa],
    ];
    for (const [name, assurance] of assurances) {
      if (assurance.status === "unverified") paths.push(`services.${service.id}.${name}`);
    }
  }
  if (profile.glossaryEgress.providerAccountGlossary.status === "unverified") {
    paths.push("glossaryEgress.providerAccountGlossary");
  }
  return paths;
}

export function validateApprovedSessionProcessingProfile(profile: unknown): ProcessingProfileValidation {
  assertApprovedSessionProcessingProfileShape(profile);
  if (profile.schemaVersion !== 1 || profile.kind !== "approved_session_processing_profile") {
    throw new TypeError("Unsupported processing profile schema");
  }
  assertNonempty(profile.id, "profile.id");
  assertNonempty(profile.version, "profile.version");
  if (profile.operationScope !== "poc" && profile.operationScope !== "production") {
    throw new TypeError("Processing profile operationScope is unsupported");
  }
  assertSha256(profile.sha256, "profile.sha256");
  if (canonicalJsonSha256(profileBody(profile)) !== profile.sha256) {
    throw new TypeError("Processing profile SHA-256 mismatch");
  }
  assertProvider(profile.translation.provider, "translation.provider");
  if (profile.translation.behaviorVersion !== 1) throw new TypeError("Unsupported behavior version");
  for (const mode of profile.translation.allowedModes) assertMode(mode, "translation.allowedModes");
  assertMode(profile.translation.defaultMode, "translation.defaultMode");
  const modes = new Set(profile.translation.allowedModes);
  if (modes.size !== profile.translation.allowedModes.length || !modes.has(profile.translation.defaultMode)) {
    throw new TypeError("Processing profile modes must be unique and include the default mode");
  }
  const roles = profile.services.map((service) => service.role).sort();
  const required = [...expectedRoles(profile.translation.provider)].sort();
  if (JSON.stringify(roles) !== JSON.stringify(required)) {
    throw new TypeError("Processing services do not match the selected provider route");
  }
  const ids = new Set<string>();
  for (const service of profile.services) {
    validateService(service, profile.translation.provider);
    if (ids.has(service.id)) throw new TypeError("Processing service IDs must be unique");
    ids.add(service.id);
  }
  validateGlossaryEgress(profile.glossaryEgress, profile.translation.provider);
  if (profile.fallback.kind !== "none" && profile.fallback.kind !== "same_route_fail_open") {
    throw new TypeError("Processing profile fallback kind is unsupported");
  }
  if (
    profile.evidence.storage !== "local_encrypted_file" ||
    profile.evidence.encryption !== "aes_256_gcm" ||
    profile.evidence.providerEvents !== "final_only" ||
    profile.evidence.provisionalEvents !== "live_only" ||
    profile.evidence.browserEvidenceRefs !== "redacted" ||
    profile.evidence.plaintextExport !== "explicit_owner_acknowledgement" ||
    JSON.stringify(profile.evidence.tracks) !== JSON.stringify([
      "source_a", "source_b", "playout_to_a", "playout_to_b",
    ]) ||
    !POSITIVE_DECIMAL_PATTERN.test(profile.evidence.minimumFreeBytes)
  ) {
    throw new TypeError("Processing profile evidence controls are invalid");
  }
  if (
    profile.retentionPolicy.defaultDays !== 14 ||
    profile.retentionPolicy.maximumDays !== 30 ||
    profile.retentionPolicy.verificationMaximumHours !== 24 ||
    profile.retentionPolicy.mode !== "scheduled_delete"
  ) {
    throw new TypeError("Processing profile retention policy must be 14-day default, 30-day maximum, verified within 24 hours");
  }
  assertContractReference(profile.retentionPolicy.policyRef, "retentionPolicy.policyRef");
  assertContractReference(profile.consentPolicy, "consentPolicy");
  assertNonempty(profile.consentPolicy.noticeVersion, "consentPolicy.noticeVersion");
  if (
    profile.consentPolicy.recordingRequired !== true ||
    profile.consentPolicy.processingRequired !== true ||
    profile.consentPolicy.withdrawalTerminatesSession !== true
  ) {
    throw new TypeError("Consent policy must require recording, processing, and terminal withdrawal");
  }
  assertContractReference(profile.fallback.approval, "fallback.approval");
  assertNonempty(profile.approval.approvalId, "approval.approvalId");
  assertNonempty(profile.approval.approvedBy, "approval.approvedBy");
  assertUtc(profile.approval.approvedAtUtc, "approval.approvedAtUtc");
  const unverifiedAssurances = collectUnverified(profile);
  if (profile.operationScope === "production" && unverifiedAssurances.length > 0) {
    throw new TypeError("Production processing profile has unverified external assurances");
  }
  return Object.freeze({
    acceptanceImpact: unverifiedAssurances.length === 0 ? "PASS" : "NOT_RUN",
    unverifiedAssurances: Object.freeze(unverifiedAssurances),
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createSessionProcessingManifest(input: {
  readonly profile: ApprovedSessionProcessingProfile;
  readonly mode: TranslationMode;
  readonly glossary?: GlossaryReference;
}): SessionProcessingManifest {
  const validation = validateApprovedSessionProcessingProfile(input.profile);
  if (input.glossary !== undefined) {
    assertGlossaryReferenceShape(input.glossary, "glossary");
  }
  if (!input.profile.translation.allowedModes.includes(input.mode)) {
    throw new TypeError("Selected mode is not approved by the processing profile");
  }
  const body = {
    schemaVersion: 1 as const,
    profile: {
      id: input.profile.id,
      version: input.profile.version,
      sha256: input.profile.sha256,
    },
    operationScope: input.profile.operationScope,
    acceptanceImpact: validation.acceptanceImpact,
    selectedTranslation: {
      provider: input.profile.translation.provider,
      mode: input.mode,
      behaviorVersion: input.profile.translation.behaviorVersion,
      servicesSha256: canonicalJsonSha256(input.profile.services),
    },
    services: input.profile.services,
    consentPolicyRef: input.profile.consentPolicy,
    glossaryEgress: input.profile.glossaryEgress,
    fallback: input.profile.fallback,
    evidence: input.profile.evidence,
    retentionPolicy: input.profile.retentionPolicy,
    ...(input.glossary === undefined ? {} : { glossary: input.glossary }),
  };
  const clonedBody = structuredClone(body);
  return deepFreeze({ ...clonedBody, manifestSha256: canonicalJsonSha256(clonedBody) });
}

export function validateSessionProcessingManifest(manifest: unknown): void {
  assertSessionProcessingManifestShape(manifest);
  if (manifest.schemaVersion !== 1) throw new TypeError("Unsupported processing manifest schema");
  assertNonempty(manifest.profile.id, "processingManifest.profile.id");
  assertNonempty(manifest.profile.version, "processingManifest.profile.version");
  assertSha256(manifest.profile.sha256, "processingManifest.profile.sha256");
  if (manifest.operationScope !== "poc" && manifest.operationScope !== "production") {
    throw new TypeError("Processing manifest operationScope is unsupported");
  }
  assertProvider(manifest.selectedTranslation.provider, "processingManifest.selectedTranslation.provider");
  assertMode(manifest.selectedTranslation.mode, "processingManifest.selectedTranslation.mode");
  if (manifest.selectedTranslation.behaviorVersion !== 1) {
    throw new TypeError("Unsupported processing manifest behavior version");
  }
  assertSha256(manifest.selectedTranslation.servicesSha256, "processingManifest.servicesSha256");
  assertSha256(manifest.manifestSha256, "processingManifest.manifestSha256");
  if (canonicalJsonSha256(manifestBody(manifest)) !== manifest.manifestSha256) {
    throw new TypeError("Processing manifest SHA-256 mismatch");
  }
  if (canonicalJsonSha256(manifest.services) !== manifest.selectedTranslation.servicesSha256) {
    throw new TypeError("Processing manifest service projection SHA-256 mismatch");
  }
  const roles = manifest.services.map((service) => service.role).sort();
  const required = [...expectedRoles(manifest.selectedTranslation.provider)].sort();
  if (JSON.stringify(roles) !== JSON.stringify(required)) {
    throw new TypeError("Processing manifest services do not match the selected provider route");
  }
  const ids = new Set<string>();
  for (const service of manifest.services) {
    validateService(service, manifest.selectedTranslation.provider);
    if (ids.has(service.id)) throw new TypeError("Processing manifest service IDs must be unique");
    ids.add(service.id);
  }
  validateGlossaryEgress(manifest.glossaryEgress, manifest.selectedTranslation.provider);
  if (manifest.fallback.kind !== "none" && manifest.fallback.kind !== "same_route_fail_open") {
    throw new TypeError("Processing manifest fallback kind is unsupported");
  }
  assertContractReference(manifest.fallback.approval, "processingManifest.fallback.approval");
  if (
    manifest.evidence.storage !== "local_encrypted_file" ||
    manifest.evidence.encryption !== "aes_256_gcm" ||
    manifest.evidence.providerEvents !== "final_only" ||
    manifest.evidence.provisionalEvents !== "live_only" ||
    manifest.evidence.browserEvidenceRefs !== "redacted" ||
    manifest.evidence.plaintextExport !== "explicit_owner_acknowledgement" ||
    JSON.stringify(manifest.evidence.tracks) !== JSON.stringify([
      "source_a", "source_b", "playout_to_a", "playout_to_b",
    ]) ||
    !POSITIVE_DECIMAL_PATTERN.test(manifest.evidence.minimumFreeBytes)
  ) {
    throw new TypeError("Processing manifest evidence controls are invalid");
  }
  if (
    manifest.retentionPolicy.defaultDays !== 14 ||
    manifest.retentionPolicy.maximumDays !== 30 ||
    manifest.retentionPolicy.verificationMaximumHours !== 24 ||
    manifest.retentionPolicy.mode !== "scheduled_delete"
  ) {
    throw new TypeError("Processing manifest retention policy is invalid");
  }
  assertContractReference(manifest.retentionPolicy.policyRef, "processingManifest.retentionPolicy.policyRef");
  assertContractReference(manifest.consentPolicyRef, "processingManifest.consentPolicyRef");
  assertNonempty(manifest.consentPolicyRef.noticeVersion, "processingManifest.consentPolicyRef.noticeVersion");
  if (
    manifest.consentPolicyRef.recordingRequired !== true ||
    manifest.consentPolicyRef.processingRequired !== true ||
    manifest.consentPolicyRef.withdrawalTerminatesSession !== true
  ) {
    throw new TypeError("Processing manifest consent policy is invalid");
  }
  if (manifest.glossary !== undefined) {
    assertNonempty(manifest.glossary.id, "processingManifest.glossary.id");
    assertNonempty(manifest.glossary.version, "processingManifest.glossary.version");
    assertSha256(manifest.glossary.hash, "processingManifest.glossary.hash");
  }
  const hasUnverified = manifest.services.some((service) =>
    [service.region, service.trainingUse, service.serviceRetention, service.dpa]
      .some((assurance) => assurance.status === "unverified")
  ) || manifest.glossaryEgress.providerAccountGlossary.status === "unverified";
  const expectedImpact = hasUnverified ? "NOT_RUN" : "PASS";
  if (manifest.acceptanceImpact !== expectedImpact) {
    throw new TypeError("Processing manifest acceptance impact is inconsistent with external assurances");
  }
  if (manifest.operationScope === "production" && hasUnverified) {
    throw new TypeError("Production processing manifest has unverified external assurances");
  }
}

export function validateSessionSpecProcessingManifest(spec: SessionSpec): void {
  if (spec.processingManifest === undefined) throw new TypeError("processingManifest is required");
  validateSessionProcessingManifest(spec.processingManifest);
  if (spec.provider !== spec.processingManifest.selectedTranslation.provider) {
    throw new TypeError("Provider does not match processing manifest");
  }
  if (spec.mode !== spec.processingManifest.selectedTranslation.mode) {
    throw new TypeError("Mode does not match processing manifest");
  }
  if ((spec.glossary === undefined) !== (spec.processingManifest.glossary === undefined)) {
    throw new TypeError("Glossary does not match processing manifest");
  }
  if (spec.glossary !== undefined && spec.processingManifest.glossary !== undefined) {
    const compiled = compileGlossary(spec.glossary);
    if (
      compiled.id !== spec.processingManifest.glossary.id ||
      compiled.version !== spec.processingManifest.glossary.version ||
      compiled.hash !== spec.processingManifest.glossary.hash
    ) {
      throw new TypeError("Glossary identity does not match processing manifest");
    }
  }
}

export function validateSessionSpecAgainstProcessingProfile(
  spec: SessionSpec,
  profile: ApprovedSessionProcessingProfile,
): SessionProcessingManifest {
  validateSessionSpecProcessingManifest(spec);
  validateApprovedSessionProcessingProfile(profile);
  if (
    spec.processingManifest.profile.id !== profile.id ||
    spec.processingManifest.profile.version !== profile.version ||
    spec.processingManifest.profile.sha256 !== profile.sha256
  ) {
    throw new TypeError("Session processing manifest does not match approved profile");
  }
  if (!profile.translation.allowedModes.includes(spec.mode)) {
    throw new TypeError("Session mode is not approved by processing profile");
  }
  const compiledGlossary = spec.glossary === undefined ? undefined : compileGlossary(spec.glossary);
  const expectedManifest = createSessionProcessingManifest({
    profile,
    mode: spec.mode,
    ...(compiledGlossary === undefined ? {} : {
      glossary: {
        id: compiledGlossary.id,
        version: compiledGlossary.version,
        hash: compiledGlossary.hash,
      },
    }),
  });
  if (expectedManifest.manifestSha256 !== spec.processingManifest.manifestSha256) {
    throw new TypeError("Session processing manifest immutable projection does not match approved profile");
  }
  return expectedManifest;
}

export function assertParticipantConsentForManifest(
  consent: ParticipantConsentCommand,
  manifest: SessionProcessingManifest,
): void {
  if (canonicalJsonSha256(consent.consentPolicyRef) !== canonicalJsonSha256(manifest.consentPolicyRef)) {
    throw new TypeError("Consent policy does not match processing manifest");
  }
}

import {
  canonicalJsonSha256,
  validateApprovedSessionProcessingProfile,
  type ApprovedSessionProcessingProfile,
  type ProcessingProfileValidation,
} from "../../core/processing-profile.js";
import { readProcessingProfileText } from "./processing-profile.js";

const RESULT_KIND = "approved_session_processing_profile_validation";

type ValidationFailureCode =
  | "invalid_arguments"
  | "input_read_failed"
  | "invalid_json"
  | "invalid_profile"
  | "embedded_hash_mismatch";

interface ValidationSuccess {
  readonly kind: typeof RESULT_KIND;
  readonly status: "valid";
  readonly canonicalBodySha256: string;
  readonly acceptanceImpact: ProcessingProfileValidation["acceptanceImpact"];
  readonly unverifiedAssurancePaths: readonly string[];
}

interface ValidationFailure {
  readonly kind: typeof RESULT_KIND;
  readonly status: "invalid";
  readonly code: ValidationFailureCode;
  readonly expectedCanonicalBodySha256?: string;
}

class ProcessingProfileValidationCliError extends Error {
  readonly code: ValidationFailureCode;
  readonly expectedCanonicalBodySha256: string | undefined;

  constructor(
    code: ValidationFailureCode,
    expectedCanonicalBodySha256?: string,
  ) {
    super(code);
    this.code = code;
    this.expectedCanonicalBodySha256 = expectedCanonicalBodySha256;
  }
}

function inputPath(arguments_: readonly string[]): string {
  const forwarded = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (forwarded.length !== 2 || forwarded[0] !== "--input") {
    throw new ProcessingProfileValidationCliError("invalid_arguments");
  }
  const input = forwarded[1]?.trim();
  if (input === undefined || input.length === 0) {
    throw new ProcessingProfileValidationCliError("invalid_arguments");
  }
  return input;
}

async function inputJson(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readProcessingProfileText(path);
  } catch {
    throw new ProcessingProfileValidationCliError("input_read_failed");
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new ProcessingProfileValidationCliError("invalid_json");
  }
}

function profileBody(parsed: unknown): Readonly<{
  readonly profile: ApprovedSessionProcessingProfile;
  readonly embeddedSha256: unknown;
  readonly canonicalBodySha256: string;
}> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProcessingProfileValidationCliError("invalid_profile");
  }
  const { sha256: embeddedSha256, ...body } = parsed as Record<string, unknown>;
  return Object.freeze({
    profile: parsed as ApprovedSessionProcessingProfile,
    embeddedSha256,
    canonicalBodySha256: canonicalJsonSha256(body),
  });
}

function result(
  validation: ProcessingProfileValidation,
  canonicalBodySha256: string,
): ValidationSuccess {
  return Object.freeze({
    kind: RESULT_KIND,
    status: "valid",
    canonicalBodySha256,
    acceptanceImpact: validation.acceptanceImpact,
    unverifiedAssurancePaths: Object.freeze([...validation.unverifiedAssurances]),
  });
}

/**
 * Validates one explicit, non-secret profile artifact. It deliberately has no
 * environment-variable input, deployment routing, or file mutation behavior.
 */
export async function runProcessingProfileValidationCli(
  arguments_: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const parsed = await inputJson(inputPath(arguments_));
  const body = profileBody(parsed);
  if (body.embeddedSha256 !== body.canonicalBodySha256) {
    throw new ProcessingProfileValidationCliError(
      "embedded_hash_mismatch",
      body.canonicalBodySha256,
    );
  }
  let validation: ProcessingProfileValidation;
  try {
    validation = validateApprovedSessionProcessingProfile(body.profile);
  } catch {
    throw new ProcessingProfileValidationCliError("invalid_profile");
  }
  process.stdout.write(JSON.stringify(result(validation, body.canonicalBodySha256)) + "\n");
}

export function processingProfileValidationFailure(error: unknown): ValidationFailure {
  if (error instanceof ProcessingProfileValidationCliError) {
    return Object.freeze({
      kind: RESULT_KIND,
      status: "invalid",
      code: error.code,
      ...(error.expectedCanonicalBodySha256 === undefined ? {} : {
        expectedCanonicalBodySha256: error.expectedCanonicalBodySha256,
      }),
    });
  }
  return Object.freeze({
    kind: RESULT_KIND,
    status: "invalid",
    code: "invalid_profile",
  });
}

if (import.meta.main) {
  await runProcessingProfileValidationCli().catch((error: unknown) => {
    process.stderr.write(JSON.stringify(processingProfileValidationFailure(error)) + "\n");
    process.exitCode = 1;
  });
}

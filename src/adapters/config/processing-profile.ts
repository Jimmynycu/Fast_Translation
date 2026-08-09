import { lstat, open } from "node:fs/promises";
import {
  validateApprovedSessionProcessingProfile,
  type ApprovedSessionProcessingProfile,
} from "../../core/processing-profile.js";

export interface ApprovedSessionProcessingProfileLoadRequest {
  readonly path: string;
  readonly expectedSha256: string;
}

export const MAX_PROCESSING_PROFILE_BYTES = 1 * 1024 * 1024;
const PROFILE_INPUT_READ_FAILED = "input_read_failed";
const PROFILE_INVALID_JSON = "invalid JSON";

/**
 * Read one deployment profile only after proving it is a bounded regular file.
 * The second stat check and bounded +1 read close growth/replacement races
 * without ever allocating based on attacker-controlled file size.
 */
export async function readProcessingProfileText(path: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathInfo = await lstat(path);
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
      throw new TypeError(PROFILE_INPUT_READ_FAILED);
    }
    handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 0) {
      throw new TypeError(PROFILE_INPUT_READ_FAILED);
    }
    if (info.size > MAX_PROCESSING_PROFILE_BYTES) {
      throw new TypeError(PROFILE_INPUT_READ_FAILED);
    }

    const bytes = Buffer.alloc(MAX_PROCESSING_PROFILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROCESSING_PROFILE_BYTES) {
      throw new TypeError(PROFILE_INPUT_READ_FAILED);
    }
    const currentPathInfo = await lstat(path);
    if (
      currentPathInfo.isSymbolicLink() ||
      !currentPathInfo.isFile() ||
      String(currentPathInfo.dev) !== String(info.dev) ||
      String(currentPathInfo.ino) !== String(info.ino)
    ) {
      throw new TypeError(PROFILE_INPUT_READ_FAILED);
    }
    return bytes.subarray(0, offset).toString("utf8");
  } catch (error: unknown) {
    if (error instanceof TypeError && error.message === PROFILE_INPUT_READ_FAILED) {
      throw error;
    }
    throw new TypeError(PROFILE_INPUT_READ_FAILED);
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

function assertCanonicalSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("expectedSha256 must be a lowercase 64-character SHA-256 hash");
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function parseProfile(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new TypeError(PROFILE_INVALID_JSON);
  }
}

/**
 * Loads the one deployment-authorized, non-secret processing route. The
 * profile's embedded SHA-256 is calculated over its canonical body, so
 * indentation and object-key order cannot silently change the approved route.
 */
export async function loadApprovedSessionProcessingProfile(
  request: ApprovedSessionProcessingProfileLoadRequest,
): Promise<ApprovedSessionProcessingProfile> {
  assertCanonicalSha256(request.expectedSha256);
  const parsed = parseProfile(await readProcessingProfileText(request.path));
  validateApprovedSessionProcessingProfile(parsed);
  const profile = parsed as ApprovedSessionProcessingProfile;
  if (profile.sha256 !== request.expectedSha256) {
    throw new TypeError("PROCESSING_PROFILE_SHA256 does not match canonical profile hash");
  }
  return deepFreeze(profile);
}

import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Resolve a path through the portion that exists on disk. This lets callers
 * validate a destination before creating its missing leaf directories while
 * still detecting a symlink or junction in an existing ancestor.
 */
async function resolveThroughExistingAncestor(path: string): Promise<string> {
  const missingSegments: string[] = [];
  let current = resolve(path);
  while (true) {
    try {
      await lstat(current);
      break;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) throw new Error("Unable to resolve path ancestor");
      missingSegments.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
  const physicalExisting = await realpath(current);
  return resolve(physicalExisting, ...missingSegments.reverse());
}

function isContained(path: string, root: string): boolean {
  const remainder = relative(root, path);
  return remainder === "" ||
    (!remainder.startsWith(".." + sep) && remainder !== ".." && !isAbsolute(remainder));
}

/**
 * Validates that a path is lexically and physically contained by a root. The
 * physical check rejects a symlink/junction that would escape the root,
 * including when the final path does not exist yet.
 */
export async function assertContainedPath(
  path: string,
  root: string,
  label: string,
): Promise<string> {
  const lexicalPath = resolve(path);
  const lexicalRoot = resolve(root);
  if (!isContained(lexicalPath, lexicalRoot)) {
    throw new TypeError(label + " must stay inside the active workspace");
  }

  const [physicalRoot, physicalPath] = await Promise.all([
    realpath(lexicalRoot),
    resolveThroughExistingAncestor(lexicalPath),
  ]);
  if (!isContained(physicalPath, physicalRoot)) {
    throw new TypeError(label + " must not traverse a symlink or junction outside the active workspace");
  }
  return lexicalPath;
}

/**
 * Validates a corpus fixture path against its manifest directory. The
 * manifest may live anywhere, but a WAV fixture may not escape that directory
 * through a symlink or junction.
 */
export async function assertManifestFixturePath(
  path: string,
  manifestDirectory: string,
  label: string,
): Promise<string> {
  const lexicalPath = resolve(path);
  const lexicalRoot = resolve(manifestDirectory);
  if (!isContained(lexicalPath, lexicalRoot)) {
    throw new TypeError(label + " must stay inside the manifest directory");
  }
  const [physicalRoot, physicalPath] = await Promise.all([
    realpath(lexicalRoot),
    resolveThroughExistingAncestor(lexicalPath),
  ]);
  if (!isContained(physicalPath, physicalRoot)) {
    throw new TypeError(label + " must not traverse a symlink or junction outside the manifest directory");
  }
  return lexicalPath;
}

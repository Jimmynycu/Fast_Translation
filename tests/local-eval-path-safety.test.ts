import assert from "node:assert/strict";
import { mkdir, rm, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { assertContainedPath } from "../src/local-eval/path-safety.js";

function temporaryDirectory(name: string): string {
  return resolve(process.cwd(), "work", "tmp", "local-eval-path-tests", name + "-" + randomUUID());
}

test("workspace output paths reject lexical escapes", async () => {
  const root = temporaryDirectory("root");
  await mkdir(root, { recursive: true });
  try {
    await assert.rejects(
      assertContainedPath(resolve(root, "..", "outside", "report.json"), root, "--output"),
      /must stay inside the active workspace/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace output paths reject symlink escapes", async (testContext) => {
  const root = temporaryDirectory("root");
  const outside = temporaryDirectory("outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  const link = resolve(root, "linked");
  try {
    try {
      await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error &&
        ((error as NodeJS.ErrnoException).code === "EPERM" ||
          (error as NodeJS.ErrnoException).code === "EACCES")) {
        testContext.skip("symlink creation is unavailable on this host");
        return;
      }
      throw error;
    }
    await assert.rejects(
      assertContainedPath(resolve(link, "report.json"), root, "--output"),
      /must not traverse a symlink or junction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

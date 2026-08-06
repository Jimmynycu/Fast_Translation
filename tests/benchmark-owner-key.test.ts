import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  generateOperatorTestOwnerKeyFiles,
  ownerKeyIdSha256,
} from "../src/benchmark/owner-key.js";

const taskTemp = join(process.cwd(), "work", "tmp", "benchmark-owner-key-tests");

describe("operator test owner key generation", () => {
  it("writes non-overwriting Ed25519 key files and explicit trust metadata", async () => {
    const outputDirectory = join(taskTemp, "generated");
    await rm(outputDirectory, { recursive: true, force: true });

    const generated = await generateOperatorTestOwnerKeyFiles(outputDirectory);
    const privatePem = await readFile(generated.privateKeyPath, "utf8");
    const publicPem = await readFile(generated.publicKeyPath, "utf8");
    const summary = JSON.parse(await readFile(generated.summaryPath, "utf8")) as typeof generated.summary;

    assert.equal(summary.kind, "operator_test_owner_key");
    assert.equal(summary.algorithm, "Ed25519");
    assert.equal(summary.trustAnchorSource, "operator_supplied_test_key");
    assert.equal(summary.customerOwnerAcceptanceVerdict, "NOT_RUN");
    assert.equal(summary.keyIdSha256, ownerKeyIdSha256(publicPem));
    assert.equal(createPrivateKey(privatePem).asymmetricKeyType, "ed25519");
    assert.equal(createPublicKey(publicPem).asymmetricKeyType, "ed25519");
    assert.equal(generated.summaryPath, join(outputDirectory, "owner-key-summary.json"));

    await assert.rejects(
      generateOperatorTestOwnerKeyFiles(outputDirectory),
      /refusing to overwrite existing owner key artifact/u,
    );
    await assert.rejects(
      generateOperatorTestOwnerKeyFiles(join(process.cwd(), "..", "owner-key-outside")),
      /inside the workspace/u,
    );
  });

  it("rejects symlinked owner-key output directories", async (testContext) => {
    const root = join(taskTemp, "symlink-root");
    const outside = process.platform === "win32"
      ? (process.env.SystemRoot ?? "C:\\Windows")
      : "/tmp";
    const linked = join(root, "linked");
    await mkdir(root, { recursive: true });
    try {
      try {
        await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
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
        generateOperatorTestOwnerKeyFiles(linked),
        /must not traverse a symlink or junction/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
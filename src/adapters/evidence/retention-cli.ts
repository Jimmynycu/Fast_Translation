import {
  createOfflineEvidenceStore,
  withOfflineEvidenceRootLease,
} from "./cli.js";

/**
 * Runs the same recovery and expiry sweep used during server startup. It is
 * deliberately suitable for an hourly OS scheduler while the server is down.
 */
export async function runEvidenceRetentionSweepCli(
  arguments_: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { store, parsed } = createOfflineEvidenceStore(arguments_, environment);
  if (parsed.flags.has("--acknowledge-plaintext-export")) {
    throw new Error("--acknowledge-plaintext-export is valid only for evidence export");
  }
  const { recovery, sweep } = await withOfflineEvidenceRootLease(store, async () => {
    const recovery = await store.recover();
    if (recovery.status !== "completed") {
      throw new Error("Evidence artifact recovery is degraded");
    }
    const sweep = await store.sweepExpired();
    if (sweep.status !== "completed" || sweep.health !== "healthy") {
      throw new Error("Evidence retention sweep is degraded");
    }
    return { recovery, sweep };
  });
  process.stdout.write(JSON.stringify({
    kind: "managed_evidence_retention_sweep",
    recovery: {
      status: recovery.status,
      recoveredDeletions: recovery.recoveredDeletions,
      sealedArtifacts: recovery.sealedArtifacts,
      finalizationFailures: recovery.finalizationFailures,
    },
    sweep: {
      status: sweep.status,
      expiredArtifactsDeleted: sweep.expiredArtifactsDeleted,
      health: sweep.health,
      lastSuccessfulSweepAtMs: sweep.lastSuccessfulSweepAtMs,
    },
  }, null, 2) + "\n");
}

if (import.meta.main) {
  await runEvidenceRetentionSweepCli().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "Evidence retention sweep failed") + "\n",
    );
    process.exitCode = 1;
  });
}

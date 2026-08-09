const { runEvidenceRetentionSweepCli } = await import(
  "../dist/src/adapters/evidence/retention-cli.js"
);

await runEvidenceRetentionSweepCli().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Evidence retention sweep failed") + "\n",
  );
  process.exitCode = 1;
});

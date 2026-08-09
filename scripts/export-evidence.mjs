const { runManagedEvidenceExportCli } = await import(
  "../dist/src/adapters/evidence/cli.js"
);

await runManagedEvidenceExportCli().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.message : "Evidence export failed") + "\n",
  );
  process.exitCode = 1;
});

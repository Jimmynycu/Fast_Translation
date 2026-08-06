import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const browserTemp = resolve(process.cwd(), "work", "tmp", "browser-e2e");
mkdirSync(browserTemp, { recursive: true });

const child = spawn(
  process.execPath,
  [
    "--test",
    "--test-isolation=none",
    "dist-test/tests/browser-harness.test.js",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      RUN_BROWSER_E2E: "1",
      TEMP: browserTemp,
      TMP: browserTemp,
      TMPDIR: browserTemp,
    },
  },
);

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal !== null) {
    console.error("Browser E2E terminated by signal " + signal);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

import { composeApplication, type ApplicationComposition } from "../composition.js";
import { loadConfig } from "../config.js";

export async function startServer(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<ApplicationComposition> {
  const config = loadConfig(environment, cwd);
  const composition = await composeApplication(config);
  try {
    const address = await composition.app.listen({
      host: config.host,
      port: config.port,
    });
    composition.app.log.info(
      {
        address,
        operatorUrl: composition.operatorUrl,
        publicBaseUrl: config.publicBaseUrl.toString(),
        translationProfiles: composition.translationProfiles,
      },
      "Fast Translation server listening",
    );
    return composition;
  } catch (error) {
    await composition.app.close();
    throw error;
  }
}

function installShutdownHandlers(composition: ApplicationComposition): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    composition.app.log.info({ signal }, "Shutting down Fast Translation server");
    void composition.app.close().catch((error: unknown) => {
      composition.app.log.error(
        { err: error },
        "Fast Translation server shutdown failed",
      );
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const composition = await startServer();
  installShutdownHandlers(composition);
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Fast Translation startup failed: " + message);
    process.exitCode = 1;
  });
}

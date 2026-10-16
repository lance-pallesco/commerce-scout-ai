import { loadEnvConfig } from "@next/env";

import { getServerConfig } from "@/lib/config/env";
import { runResearchWorkerLoop } from "@/lib/jobs/worker";

async function main() {
  loadEnvConfig(process.cwd());

  const abortController = new AbortController();
  process.once("SIGINT", () => abortController.abort());
  process.once("SIGTERM", () => abortController.abort());

  await runResearchWorkerLoop(getServerConfig(), { signal: abortController.signal });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Unknown worker failure.";
  console.error(`Research worker stopped: ${message}`);
  process.exitCode = 1;
});

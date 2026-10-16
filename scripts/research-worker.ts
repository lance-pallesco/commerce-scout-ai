import { loadEnvConfig } from "@next/env";

import { getServerConfig } from "@/lib/config/env";
import { runResearchWorkerLoop } from "@/lib/jobs/worker";

loadEnvConfig(process.cwd());

const abortController = new AbortController();
process.once("SIGINT", () => abortController.abort());
process.once("SIGTERM", () => abortController.abort());

await runResearchWorkerLoop(getServerConfig(), { signal: abortController.signal });

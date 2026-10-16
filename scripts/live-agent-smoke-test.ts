import { loadEnvConfig } from "@next/env";

import { createLiveSmokeConfig, createLiveSmokeRequest, LIVE_SMOKE_LIMITS } from "@/lib/agent/live-smoke";
import { assertLiveResearchAvailable, getServerConfig } from "@/lib/config/env";
import {
  createResearchJob,
  getJobEvents,
  getResearchJob,
  getResearchProducts,
  getResearchReport,
  listResearchJobs,
} from "@/lib/jobs/repository";
import { runResearchWorkerOnce } from "@/lib/jobs/worker";

async function main() {
  loadEnvConfig(process.cwd());

  const baseConfig = getServerConfig();
  if (baseConfig.researchMode !== "live") {
    console.error("Live smoke test not run: set RESEARCH_MODE=live in .env.local first.");
    process.exitCode = 2;
    return;
  }

  try {
    assertLiveResearchAvailable(baseConfig);
    const config = createLiveSmokeConfig(baseConfig);
    const activeJobs = await listResearchJobs(config);
    if (activeJobs.some((job) => job.status === "pending" || job.status === "running")) {
      throw new Error("Live smoke test refused: wait for existing pending or running jobs to finish.");
    }

    const job = await createResearchJob(createLiveSmokeRequest(), config);
    const workerResult = await runResearchWorkerOnce(config, "live-agent-smoke-test");
    if (workerResult.processedJobId !== job.id) {
      throw new Error("Live smoke test did not claim its own research job.");
    }

    const [completedJob, report, products, events] = await Promise.all([
      getResearchJob(config, job.id),
      getResearchReport(config, job.id),
      getResearchProducts(config, job.id),
      getJobEvents(config, job.id),
    ]);
    const reportMode = (report?.report as { mode?: unknown } | undefined)?.mode;
    const invokedCollectionTool = events.some(
      (event) =>
        event.type === "tool_completed" && event.detail?.startsWith("collect_products:"),
    );
    if (
      !completedJob ||
      !["completed", "partial"].includes(completedJob.status) ||
      reportMode !== "claude_agent" ||
      products.length === 0 ||
      !invokedCollectionTool
    ) {
      throw new Error("Live smoke test completed without a validated Claude MCP collection report.");
    }

    console.log("Live Claude smoke test succeeded.");
    console.log(`Job ID: ${job.id}`);
    console.log(`Status: ${completedJob.status}`);
    console.log(`Collected products: ${products.length}`);
    console.log(`Estimated API cost: $${completedJob.estimatedCostUsd.toFixed(4)}`);
    console.log(`Boundaries: <=${LIVE_SMOKE_LIMITS.maxTurns} turns, <=$${LIVE_SMOKE_LIMITS.maxBudgetUsd.toFixed(2)} budget, <=${LIVE_SMOKE_LIMITS.timeoutMs / 1_000}s timeout, ${LIVE_SMOKE_LIMITS.maxPages} browser page.`);
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Unknown smoke-test failure.";
    console.error(`Live smoke test did not succeed: ${message}`);
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ") : "Unknown smoke-test failure.";
  console.error(`Live smoke test did not succeed: ${message}`);
  process.exitCode = 1;
});

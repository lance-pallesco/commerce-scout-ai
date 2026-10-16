import { loadEnvConfig } from "@next/env";

import {
  createLiveSmokeConfig,
  createLiveSmokeRequest,
  inspectLiveSmokeRun,
  LIVE_SMOKE_LIMITS,
  type LiveSmokeInspection,
} from "@/lib/agent/live-smoke";
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

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function printInspection(inspection: LiveSmokeInspection): void {
  console.log("Live Claude smoke-test summary");
  console.log(`Job ID: ${inspection.jobId}`);
  console.log(`Runtime mode: ${inspection.runtimeMode}`);
  console.log(`SDK initialization: ${inspection.sdkInitialization}`);
  console.log(`Anthropic request: ${inspection.anthropicRequest}`);
  console.log(`MCP tools: ${inspection.mcpTools.length ? inspection.mcpTools.join("; ") : "none observed"}`);
  console.log(`Products collected: ${inspection.productsCollected}`);
  console.log(`Structured output: ${inspection.structuredOutput}`);
  console.log(`Persisted report: ${inspection.persistedReport}`);
  console.log(`Terminal agent status: ${inspection.terminalAgentStatus}`);
  console.log(`Execution duration: ${formatDuration(inspection.executionDurationMs)}`);
  console.log(`Estimated API cost: $${inspection.estimatedCostUsd.toFixed(4)}`);
  if (inspection.failureCategory) {
    console.log(`Failure category: ${inspection.failureCategory}`);
  }
  if (inspection.safeErrorMessage) {
    console.log(`Safe error: ${inspection.safeErrorMessage}`);
  }
}

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

    const [completedJob, report, products, events] = await Promise.all([
      getResearchJob(config, job.id),
      getResearchReport(config, job.id),
      getResearchProducts(config, job.id),
      getJobEvents(config, job.id),
    ]);
    if (!completedJob) {
      throw new Error("Live smoke test job could not be read after worker execution.");
    }
    const inspection = inspectLiveSmokeRun({
      job: completedJob,
      report,
      products,
      events,
    });
    printInspection(inspection);
    if (workerResult.processedJobId !== job.id) {
      throw new Error("Live smoke test did not claim its own research job.");
    }
    if (!inspection.passed) {
      throw new Error(
        `Live smoke verification failed: ${inspection.failureCategory ?? "unknown validation failure"}.`,
      );
    }

    console.log("Live Claude smoke test succeeded.");
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

import { randomUUID } from "node:crypto";

import type { ServerConfig } from "@/lib/config/env";
import { runResearchAgent, type AgentExecutionEvent } from "@/lib/agent/research-agent";
import { collectProducts } from "@/lib/research/collection-service";
import { evaluateProducts } from "@/lib/scoring/score-product";

import {
  appendJobEvent,
  claimNextResearchJob,
  finishResearchJob,
  isCancellationRequested,
  persistResearchBundle,
  recoverInterruptedResearchJobs,
  renewJobLease,
  sanitizeJobFailure,
  updateJobProgress,
} from "./repository";

export type WorkerRunResult = Readonly<{
  recoveredJobs: number;
  processedJobId?: string;
}>;

class ResearchPersistenceError extends Error {
  readonly estimatedCostUsd: number;

  constructor(estimatedCostUsd: number) {
    super("Research results could not be saved safely. No partial records were committed.");
    this.name = "ResearchPersistenceError";
    this.estimatedCostUsd = estimatedCostUsd;
  }
}

function eventDetail(event: AgentExecutionEvent): string | undefined {
  if ("toolName" in event) {
    return event.detail ? `${event.toolName}: ${event.detail}` : event.toolName;
  }
  if ("detail" in event) return event.detail;
  return undefined;
}

async function runFixtureResearch(
  config: ServerConfig,
  jobId: string,
  signal: AbortSignal,
) {
  const job = await updateJobProgress(config, jobId, {
    currentStage: "collecting",
    progressPercent: 15,
  });
  const sourceId = job.request.sourceIds[0];
  const collection = await collectProducts(
    {
      sourceId,
      niche: job.request.niche,
      limit: job.request.requestedProductCount,
      minimumPrice: job.request.minimumPrice,
      maximumPrice: job.request.maximumPrice,
      mode: job.request.mode,
      signal,
    },
    config,
  );
  await appendJobEvent(
    config,
    jobId,
    "fixture_collection_completed",
    `${collection.products.length} product candidates persisted from deterministic fixture data.`,
  );
  await updateJobProgress(config, jobId, { currentStage: "scoring", progressPercent: 65 });
  const evaluations = evaluateProducts(collection.products, job.request);
  try {
    await persistResearchBundle(config, jobId, collection.products, evaluations, {
      mode: "deterministic_fixture",
      limitations: [
        "This report uses synthetic local fixture data and does not demonstrate a live Claude or market-data run.",
        "Scores measure observed evidence completeness and price/niche fit only; they do not predict sales or profitability.",
      ],
    });
  } catch {
    throw new ResearchPersistenceError(0);
  }
  return {
    status: collection.products.length > 0 ? ("completed" as const) : ("partial" as const),
    estimatedCostUsd: 0,
  };
}

async function runClaudeResearch(
  config: ServerConfig,
  jobId: string,
  signal: AbortSignal,
) {
  const job = await updateJobProgress(config, jobId, {
    currentStage: "collecting",
    progressPercent: 15,
  });
  const agent = await runResearchAgent({
    request: job.request,
    config,
    signal,
    onEvent: async (event) => {
      await appendJobEvent(config, jobId, event.type, eventDetail(event));
      if (event.type === "agent_started") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 20 });
      }
      if (event.type === "tool_started" && event.toolName === "collect_products") {
        await updateJobProgress(config, jobId, { currentStage: "collecting", progressPercent: 40 });
      }
      if (event.type === "tool_completed" && event.toolName === "collect_products") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 60 });
      }
      if (event.type === "tool_completed" && event.toolName === "get_research_candidates") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 70 });
      }
    },
  });
  if (agent.status === "failed" || agent.status === "cancelled") {
    return agent;
  }

  await updateJobProgress(config, jobId, { currentStage: "scoring", progressPercent: 75 });
  const evaluations = evaluateProducts(agent.candidates, job.request, agent.report);
  try {
    await persistResearchBundle(config, jobId, agent.candidates, evaluations, {
      mode: "claude_agent",
      agentReport: agent.report,
      limitations: agent.report?.limitations ?? ["The agent did not return a report."],
    });
  } catch {
    throw new ResearchPersistenceError(agent.estimatedCostUsd);
  }
  return agent;
}

export async function runResearchWorkerOnce(
  config: ServerConfig,
  workerId = `worker-${randomUUID()}`,
): Promise<WorkerRunResult> {
  const recoveredJobs = await recoverInterruptedResearchJobs(config);
  const job = await claimNextResearchJob(config, workerId);
  if (!job) return { recoveredJobs };

  const abortController = new AbortController();
  const startedAt = Date.now();
  const monitor = setInterval(async () => {
    try {
      if (await isCancellationRequested(config, job.id)) abortController.abort();
      else await renewJobLease(config, job.id, workerId);
    } catch {
      abortController.abort();
    }
  }, 500);

  try {
    await appendJobEvent(config, job.id, "job_claimed", `Claimed by ${workerId}.`);
    const execution =
      job.request.mode === "fixtures"
        ? await runFixtureResearch(config, job.id, abortController.signal)
        : await runClaudeResearch(config, job.id, abortController.signal);
    const cancellationRequested = await isCancellationRequested(config, job.id);
    const status = cancellationRequested ? "cancelled" : execution.status;
    await updateJobProgress(config, job.id, { currentStage: "finalizing", progressPercent: 95 });
    await finishResearchJob(config, job.id, {
      status,
      estimatedCostUsd: execution.estimatedCostUsd,
      elapsedTimeMs: Date.now() - startedAt,
      errorCode: "errorCode" in execution ? execution.errorCode : undefined,
      sanitizedErrorMessage:
        "sanitizedErrorMessage" in execution ? execution.sanitizedErrorMessage : undefined,
    });
    await appendJobEvent(config, job.id, "job_finished", `Research finished with status ${status}.`);
  } catch (error) {
    const cancellationRequested = await isCancellationRequested(config, job.id);
    await finishResearchJob(config, job.id, {
      status: cancellationRequested ? "cancelled" : "failed",
      estimatedCostUsd:
        error instanceof ResearchPersistenceError ? error.estimatedCostUsd : undefined,
      elapsedTimeMs: Date.now() - startedAt,
      errorCode: cancellationRequested
        ? "JOB_CANCELLED"
        : error instanceof ResearchPersistenceError
          ? "RESEARCH_PERSISTENCE_FAILED"
          : "WORKER_EXECUTION_FAILED",
      sanitizedErrorMessage: cancellationRequested
        ? "Research execution was cancelled."
        : error instanceof ResearchPersistenceError
          ? error.message
          : sanitizeJobFailure(error),
    });
    await appendJobEvent(config, job.id, "job_failed", "Research worker stopped before completion.");
  } finally {
    clearInterval(monitor);
  }

  return { recoveredJobs, processedJobId: job.id };
}

export async function runResearchWorkerLoop(
  config: ServerConfig,
  options: { pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pollIntervalMs = Math.max(100, options.pollIntervalMs ?? 1_000);
  while (!options.signal?.aborted) {
    const result = await runResearchWorkerOnce(config);
    if (!result.processedJobId) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }
}

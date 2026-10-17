import { randomUUID } from "node:crypto";

import type { ServerConfig } from "@/lib/config/env";
import type { ResearchJobStatus } from "@/lib/jobs/contracts";
import {
  AgentResearchReportSchema,
  type AgentResearchReport,
} from "@/lib/agent/contracts";
import { runResearchAgent, type AgentExecutionEvent } from "@/lib/agent/research-agent";
import {
  verifyDiscoveredProductPages,
  type ProductPageVerificationResult,
} from "@/lib/research/browser-source";
import { collectProducts } from "@/lib/research/collection-service";
import type {
  ProductCandidate,
  ProductPageVerificationSummary,
} from "@/lib/research/contracts";
import { isSearchDiscoverySource } from "@/lib/research/source-registry";
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

type FinalJobStatus = Extract<ResearchJobStatus, "completed" | "partial" | "failed" | "cancelled">;

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

function verificationSummary(
  result: ProductPageVerificationResult,
): ProductPageVerificationSummary {
  return {
    queuedLeadCount: result.queuedLeadCount,
    attemptedLeadCount: result.attemptedLeadCount,
    verifiedCandidateCount: result.verifiedProducts.length,
    rejectedLeads: result.rejected.map(({ lead, code }) => ({
      name: lead.title,
      sourceUrl: lead.sourceUrl,
      reason: code,
    })),
  };
}

function verificationLimitation(summary: ProductPageVerificationSummary): string | null {
  if (summary.queuedLeadCount === 0) return null;
  if (summary.rejectedLeads.length === 0) {
    return `${summary.verifiedCandidateCount}/${summary.attemptedLeadCount} bounded product-page verification attempt${summary.attemptedLeadCount === 1 ? "" : "s"} produced verified candidates before ranking.`;
  }
  const reasonCounts = [...summary.rejectedLeads.reduce((counts, item) => {
    counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()]
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(", ");
  return `${summary.rejectedLeads.length} of ${summary.queuedLeadCount} dynamically discovered lead${summary.queuedLeadCount === 1 ? " was" : "s were"} not saved or ranked because bounded product-page verification did not pass (${reasonCounts}).`;
}

function postVerificationSummary(
  candidates: readonly ProductCandidate[],
  requestedProductCount: number,
  summary: ProductPageVerificationSummary,
  completion: AgentResearchReport["completion"],
): string {
  const target = `${candidates.length}/${requestedProductCount} requested candidate${requestedProductCount === 1 ? "" : "s"}`;
  const outcome = completion === "completed" ? "was fulfilled" : "was partially fulfilled";
  if (summary.queuedLeadCount === 0) {
    return `Research execution completed. The verified candidate target ${target} ${outcome}.`;
  }
  return `Post-run product-page verification completed: ${summary.verifiedCandidateCount}/${summary.queuedLeadCount} discovered lead${summary.queuedLeadCount === 1 ? "" : "s"} passed. The verified candidate target ${target} ${outcome}.`;
}

function isStalePreVerificationLimitation(value: string): boolean {
  return /(?:not yet (?:been )?verified|verification (?:has )?not (?:yet )?(?:been )?(?:done|available)|only search-result snippets|only snippets were observed|not independently check(?:ed)? prices|product pages were not independently verified)/i.test(value);
}

export function deriveVerifiedJobStatus(
  candidates: readonly ProductCandidate[],
  requestedProductCount: number,
): Extract<FinalJobStatus, "completed" | "partial"> {
  return candidates.length >= requestedProductCount ? "completed" : "partial";
}

export function reconcileVerifiedResearchReport(
  report: AgentResearchReport | undefined,
  candidates: readonly ProductCandidate[],
  summary: ProductPageVerificationSummary,
  completion: AgentResearchReport["completion"],
  requestedProductCount: number,
): AgentResearchReport | undefined {
  if (!report) return undefined;
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const limitation = verificationLimitation(summary);
  const targetLimitation = completion === "partial"
    ? `Only ${candidates.length}/${requestedProductCount} requested candidate${requestedProductCount === 1 ? "" : "s"} passed final evidence verification.`
    : null;
  return AgentResearchReportSchema.parse({
    ...report,
    completion,
    executiveSummary: postVerificationSummary(candidates, requestedProductCount, summary, completion),
    findings: report.findings.filter((finding) => candidateIds.has(finding.productId)),
    limitations: [...new Set([
      ...report.limitations.filter((item) => !isStalePreVerificationLimitation(item)),
      ...(limitation ? [limitation] : []),
      ...(targetLimitation ? [targetLimitation] : []),
    ])].slice(0, 15),
  });
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
      if (event.type === "tool_started" && event.toolName === "discover_products") {
        await updateJobProgress(config, jobId, { currentStage: "collecting", progressPercent: 35 });
      }
      if (event.type === "tool_completed" && event.toolName === "collect_products") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 60 });
      }
      if (event.type === "tool_completed" && event.toolName === "discover_products") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 55 });
      }
      if (event.type === "tool_completed" && event.toolName === "get_research_candidates") {
        await updateJobProgress(config, jobId, { currentStage: "analyzing", progressPercent: 70 });
      }
    },
  });
  if (agent.status === "failed" || agent.status === "cancelled") {
    return agent;
  }

  await appendJobEvent(
    config,
    jobId,
    "agent_cost_summary",
    `Claude Agent SDK model estimate ${agent.modelEstimatedCostUsd.toFixed(4)} USD + bounded Web Search estimate ${agent.webSearchEstimatedCostUsd.toFixed(4)} USD = ${agent.estimatedCostUsd.toFixed(4)} USD total.`,
  );

  const dynamicLeads = agent.discoveryLeads;
  const directlyVerifiedCandidates = agent.candidates.filter(
    (candidate) => !isSearchDiscoverySource(candidate.sourceId),
  );
  let verifiedDiscoveryCandidates: ProductCandidate[] = [];
  let verification: ProductPageVerificationSummary | undefined;
  if (dynamicLeads.length > 0) {
    await updateJobProgress(config, jobId, { currentStage: "verifying", progressPercent: 72 });
    await appendJobEvent(
      config,
      jobId,
      "product_page_verification_started",
      `${dynamicLeads.length} discovered product page${dynamicLeads.length === 1 ? "" : "s"} queued for bounded verification.`,
    );
    const pageVerification = await verifyDiscoveredProductPages({
      leads: dynamicLeads,
      niche: job.request.niche,
      minimumPrice: job.request.minimumPrice,
      maximumPrice: job.request.maximumPrice,
      currency: job.request.currency,
      headless: config.browserHeadless,
      timeoutMs: config.browserTimeoutMs,
      maxPages: Math.min(config.browserMaxPagesPerRun, dynamicLeads.length),
      signal,
    });
    verifiedDiscoveryCandidates = pageVerification.verifiedProducts;
    verification = verificationSummary(pageVerification);
    await appendJobEvent(
      config,
      jobId,
      "product_page_verification_completed",
      `${verification.verifiedCandidateCount}/${verification.queuedLeadCount} discovered lead${verification.queuedLeadCount === 1 ? "" : "s"} verified; ${verification.attemptedLeadCount} page checks attempted; ${verification.rejectedLeads.length} excluded from rankings.`,
    );
  }

  const candidates = [...directlyVerifiedCandidates, ...verifiedDiscoveryCandidates];
  // Claude's report is produced before restricted page verification. Final
  // fulfilment must therefore be derived from persisted, verified candidates
  // rather than the model's pre-verification completion label.
  const status = deriveVerifiedJobStatus(candidates, job.request.requestedProductCount);
  const report = reconcileVerifiedResearchReport(agent.report, candidates, verification ?? {
    queuedLeadCount: 0,
    attemptedLeadCount: 0,
    verifiedCandidateCount: 0,
    rejectedLeads: [],
  }, status, job.request.requestedProductCount);
  await updateJobProgress(config, jobId, { currentStage: "scoring", progressPercent: 75 });
  const evaluations = evaluateProducts(candidates, job.request, report);
  try {
    await persistResearchBundle(config, jobId, candidates, evaluations, {
      mode: "claude_agent",
      agentReport: report,
      limitations: report?.limitations ?? ["The agent did not return a report."],
      verification,
    });
  } catch {
    throw new ResearchPersistenceError(agent.estimatedCostUsd);
  }
  return { ...agent, candidates, report, status };
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
  let monitorBusy = false;
  let monitorFailed = false;
  const monitor = setInterval(async () => {
    if (monitorBusy) return;
    monitorBusy = true;
    try {
      if (await isCancellationRequested(config, job.id)) abortController.abort();
      else await renewJobLease(config, job.id, workerId);
    } catch {
      monitorFailed = true;
      abortController.abort();
    } finally {
      monitorBusy = false;
    }
  }, 500);

  try {
    await appendJobEvent(config, job.id, "job_claimed", `Claimed by ${workerId}.`);
    const execution =
      job.request.mode === "fixtures"
        ? await runFixtureResearch(config, job.id, abortController.signal)
        : await runClaudeResearch(config, job.id, abortController.signal);
    const cancellationRequested = await isCancellationRequested(config, job.id);
    const healthcheckFailed = monitorFailed && !cancellationRequested;
    if (healthcheckFailed) {
      await appendJobEvent(
        config,
        job.id,
        "worker_healthcheck_failed",
        "The worker health check stopped this run before completion.",
      );
    }
    const status: FinalJobStatus = healthcheckFailed
      ? "failed"
      : cancellationRequested
        ? "cancelled"
        : execution.status;
    await updateJobProgress(config, job.id, { currentStage: "finalizing", progressPercent: 95 });
    await finishResearchJob(config, job.id, {
      status,
      estimatedCostUsd: execution.estimatedCostUsd,
      elapsedTimeMs: Date.now() - startedAt,
      errorCode: healthcheckFailed
        ? "WORKER_HEALTHCHECK_FAILED"
        : "errorCode" in execution
          ? execution.errorCode
          : undefined,
      sanitizedErrorMessage: healthcheckFailed
        ? "The worker health check stopped this run before completion."
        : "sanitizedErrorMessage" in execution
          ? execution.sanitizedErrorMessage
          : undefined,
    });
    await appendJobEvent(config, job.id, "job_finished", `Research finished with status ${status}.`);
  } catch (error) {
    const cancellationRequested = await isCancellationRequested(config, job.id);
    const healthcheckFailed = monitorFailed && !cancellationRequested;
    if (healthcheckFailed) {
      await appendJobEvent(
        config,
        job.id,
        "worker_healthcheck_failed",
        "The worker health check stopped this run before completion.",
      );
    }
    await finishResearchJob(config, job.id, {
      status: cancellationRequested ? "cancelled" : "failed",
      estimatedCostUsd:
        error instanceof ResearchPersistenceError ? error.estimatedCostUsd : undefined,
      elapsedTimeMs: Date.now() - startedAt,
      errorCode: cancellationRequested
        ? "JOB_CANCELLED"
        : healthcheckFailed
          ? "WORKER_HEALTHCHECK_FAILED"
          : error instanceof ResearchPersistenceError
            ? "RESEARCH_PERSISTENCE_FAILED"
            : "WORKER_EXECUTION_FAILED",
      sanitizedErrorMessage: cancellationRequested
        ? "Research execution was cancelled."
        : healthcheckFailed
          ? "The worker health check stopped this run before completion."
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

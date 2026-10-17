import type { ServerConfig } from "@/lib/config/env";
import type { PersistedEvent, ResearchJob } from "@/lib/jobs/contracts";
import { ResearchRequestSchema, type ResearchRequest } from "@/lib/research/contracts";

import { RESEARCH_TOOL_NAMES } from "./research-tools";

export const LIVE_SMOKE_LIMITS = Object.freeze({
  maxTurns: 5,
  maxBudgetUsd: 0.1,
  timeoutMs: 90_000,
  maxPages: 1,
});

type SmokeReport = Readonly<{ report: unknown }> | null;

export type LiveSmokeInspection = Readonly<{
  passed: boolean;
  jobId: string;
  runtimeMode: ResearchJob["request"]["mode"];
  sdkInitialization: string;
  anthropicRequest: string;
  mcpTools: readonly string[];
  productsCollected: number;
  structuredOutput: string;
  persistedReport: string;
  terminalAgentStatus: string;
  executionDurationMs: number;
  estimatedCostUsd: number;
  failureCategory: string | null;
  safeErrorMessage: string | null;
}>;

function eventDetailForTool(event: PersistedEvent, toolName: string): string | null {
  const prefix = `${toolName}:`;
  if (!event.detail?.startsWith(prefix)) return null;
  return event.detail.slice(prefix.length).trim() || null;
}

function summarizeMcpTools(events: readonly PersistedEvent[]): string[] {
  return RESEARCH_TOOL_NAMES.flatMap((toolName) => {
    const toolEvents = events.filter(
      (event) =>
        (event.type === "tool_started" ||
          event.type === "tool_completed" ||
          event.type === "tool_failed") &&
        (event.detail === toolName || event.detail?.startsWith(`${toolName}:`)),
    );
    if (toolEvents.length === 0) return [];
    const latest = toolEvents.at(-1);
    if (!latest) return [];
    const detail = eventDetailForTool(latest, toolName);
    const status =
      latest.type === "tool_completed"
        ? "completed"
        : latest.type === "tool_failed"
          ? `failed${detail ? ` (${detail})` : ""}`
          : "started";
    return [`${toolName}: ${status}`];
  });
}

function reportMode(report: SmokeReport): unknown {
  if (!report || typeof report.report !== "object" || report.report === null) return undefined;
  return (report.report as { mode?: unknown }).mode;
}

export function inspectLiveSmokeRun(input: Readonly<{
  job: ResearchJob;
  report: SmokeReport;
  products: readonly unknown[];
  events: readonly PersistedEvent[];
}>): LiveSmokeInspection {
  const { job, report, products, events } = input;
  const initialized = events.find((event) => event.type === "agent_sdk_initialized");
  const apiResponse = events.find((event) => event.type === "agent_api_response_observed");
  const terminalResult = events.findLast((event) => event.type === "agent_terminal_result");
  const outputReceived = events.some(
    (event) => event.type === "agent_structured_output_received",
  );
  const outputValidated = events.some(
    (event) => event.type === "agent_structured_output_validated",
  );
  const agentFailure = events.findLast((event) => event.type === "agent_failed");
  const collectionSucceeded = events.some(
    (event) =>
      event.type === "tool_completed" &&
      (event.detail?.startsWith("collect_products:") ||
        event.detail?.startsWith("discover_products:")),
  );
  const persistedAgentReport = reportMode(report) === "claude_agent";
  const finished = job.status === "completed" || job.status === "partial";
  const failureCategory =
    job.errorCode ??
    (!collectionSucceeded
      ? "MCP_COLLECTION_NOT_COMPLETED"
      : !outputValidated
        ? "STRUCTURED_OUTPUT_NOT_VALIDATED"
        : !persistedAgentReport
          ? "CLAUDE_REPORT_NOT_PERSISTED"
          : !finished
            ? `JOB_${job.status.toUpperCase()}`
            : products.length === 0
              ? "NO_PRODUCTS_PERSISTED"
              : null);

  return {
    passed:
      finished &&
      collectionSucceeded &&
      outputValidated &&
      persistedAgentReport &&
      products.length > 0,
    jobId: job.id,
    runtimeMode: job.request.mode,
    sdkInitialization: initialized?.detail ?? "not observed",
    anthropicRequest: apiResponse?.detail
      ? apiResponse.detail
      : apiResponse
        ? "response observed"
      : terminalResult
        ? "terminal result observed"
        : "not observed",
    mcpTools: summarizeMcpTools(events),
    productsCollected: products.length,
    structuredOutput: outputValidated
      ? "validated"
      : outputReceived
        ? "received but custom validation failed"
        : "not observed",
    persistedReport: persistedAgentReport ? "persisted claude_agent report" : "not persisted",
    terminalAgentStatus: agentFailure?.detail ?? terminalResult?.detail ?? "not observed",
    executionDurationMs: job.elapsedTimeMs,
    estimatedCostUsd: job.estimatedCostUsd,
    failureCategory,
    safeErrorMessage: job.sanitizedErrorMessage,
  };
}

export function createLiveSmokeConfig(config: ServerConfig): ServerConfig {
  return Object.freeze({
    ...config,
    agentMaxTurns: Math.min(config.agentMaxTurns, LIVE_SMOKE_LIMITS.maxTurns),
    agentMaxBudgetUsd: Math.min(config.agentMaxBudgetUsd, LIVE_SMOKE_LIMITS.maxBudgetUsd),
    agentTimeoutMs: Math.min(config.agentTimeoutMs, LIVE_SMOKE_LIMITS.timeoutMs),
    browserMaxPagesPerRun: Math.min(config.browserMaxPagesPerRun, LIVE_SMOKE_LIMITS.maxPages),
  });
}

export function createLiveSmokeRequest(): ResearchRequest {
  return ResearchRequestSchema.parse({
    niche: "electronics",
    minimumPrice: 1,
    maximumPrice: 2_000,
    requestedProductCount: 2,
    sourceIds: ["webscraper-ecommerce-demo"],
    mode: "live",
    objective: "Produce a small evidence-grounded report from the approved demonstration catalog.",
  });
}

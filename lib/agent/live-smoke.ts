import type { ServerConfig } from "@/lib/config/env";
import type { PersistedEvent, ResearchJob } from "@/lib/jobs/contracts";
import { ResearchRequestSchema, type ResearchRequest } from "@/lib/research/contracts";

import { RESEARCH_TOOL_NAMES } from "./research-tools";

export const LIVE_SMOKE_LIMITS = Object.freeze({
  maxTurns: 5,
  maxBudgetUsd: 0.1,
  timeoutMs: 90_000,
  maxPages: 1,
  maxWebSearchUses: 1,
  maxWebSearchResults: 3,
});

type SmokeReport = Readonly<{ report: unknown }> | null;

export type LiveSmokeInspection = Readonly<{
  passed: boolean;
  jobId: string;
  runtimeMode: ResearchJob["request"]["mode"];
  sdkInitialization: string;
  providerRequest: string;
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
    const outcomes = toolEvents.filter(
      (event) => event.type === "tool_completed" || event.type === "tool_failed",
    );
    if (outcomes.length === 0) return [`${toolName}: started`];
    const statuses = outcomes.map((event) => {
      const detail = eventDetailForTool(event, toolName);
      return event.type === "tool_completed"
        ? "completed"
        : `failed${detail ? ` (${detail})` : ""}`;
    });
    return [`${toolName}: ${statuses.join(" → ")}`];
  });
}

function collectionFailure(events: readonly PersistedEvent[]): string | null {
  const relevantFailures = events.filter(
    (event) =>
      event.type === "tool_failed" &&
      (event.detail?.startsWith("collect_products:") ||
        event.detail?.startsWith("discover_products:")),
  );
  const firstWebSearchFailure = relevantFailures.find((event) =>
    event.detail?.startsWith("discover_products: WEB_SEARCH_"),
  );
  const detail = firstWebSearchFailure?.detail ?? relevantFailures[0]?.detail;
  if (!detail) return null;
  const match = /^(?:collect_products|discover_products):\s*([A-Z_]+)/.exec(detail);
  return match?.[1] ?? null;
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
  const rootCollectionFailure = collectionFailure(events);
  const failureCategory =
    job.errorCode ??
    (!collectionSucceeded
      ? rootCollectionFailure ?? "MCP_COLLECTION_NOT_COMPLETED"
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
    providerRequest: apiResponse?.detail
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
    safeErrorMessage: job.sanitizedErrorMessage ??
      (rootCollectionFailure === "WEB_SEARCH_NO_RESULTS"
        ? "No provider-observed product evidence matched the requested niche and price range."
        : null),
  };
}

export function createLiveSmokeConfig(config: ServerConfig): ServerConfig {
  return Object.freeze({
    ...config,
    agentMaxTurns: Math.min(config.agentMaxTurns, LIVE_SMOKE_LIMITS.maxTurns),
    agentMaxBudgetUsd: Math.min(config.agentMaxBudgetUsd, LIVE_SMOKE_LIMITS.maxBudgetUsd),
    agentTimeoutMs: Math.min(config.agentTimeoutMs, LIVE_SMOKE_LIMITS.timeoutMs),
    browserMaxPagesPerRun: Math.min(config.browserMaxPagesPerRun, LIVE_SMOKE_LIMITS.maxPages),
    webSearchMaxUses: Math.min(config.webSearchMaxUses, LIVE_SMOKE_LIMITS.maxWebSearchUses),
    webSearchMaxResults: Math.min(
      config.webSearchMaxResults,
      LIVE_SMOKE_LIMITS.maxWebSearchResults,
    ),
  });
}

export function createLiveSmokeRequest(
  options: Readonly<{ dynamicWebDiscovery?: boolean }> = {},
): ResearchRequest {
  if (options.dynamicWebDiscovery) {
    return ResearchRequestSchema.parse({
      niche: "desk organizer",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 1,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective:
        "Produce one evidence-grounded discovery lead using the bounded configured-provider Web Search tool.",
    });
  }

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

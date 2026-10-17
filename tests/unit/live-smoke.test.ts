import { describe, expect, it } from "vitest";

import {
  createLiveSmokeConfig,
  createLiveSmokeRequest,
  inspectLiveSmokeRun,
  LIVE_SMOKE_LIMITS,
} from "@/lib/agent/live-smoke";
import { getServerConfig } from "@/lib/config/env";
import type { PersistedEvent, ResearchJob } from "@/lib/jobs/contracts";

const liveJob: ResearchJob = {
  id: "00000000-0000-4000-8000-000000000001",
  request: createLiveSmokeRequest(),
  status: "completed",
  currentStage: "completed",
  progressPercent: 100,
  createdAt: "2026-10-16T00:00:00.000Z",
  startedAt: "2026-10-16T00:00:01.000Z",
  completedAt: "2026-10-16T00:00:03.000Z",
  cancellationRequestedAt: null,
  errorCode: null,
  sanitizedErrorMessage: null,
  agentModel: "sonnet",
  maximumTurns: 5,
  estimatedCostUsd: 0.025,
  elapsedTimeMs: 2_000,
  workerId: "live-agent-smoke-test",
  leaseExpiresAt: null,
};

function event(type: string, detail: string | null = null): PersistedEvent {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(type.length).padStart(2, "0")}`,
    jobId: liveJob.id,
    type,
    detail,
    createdAt: "2026-10-16T00:00:02.000Z",
  };
}

describe("live Claude smoke-test boundaries", () => {
  it("caps live configuration and targets only the approved browser source", () => {
    const bounded = createLiveSmokeConfig(
      getServerConfig({
        RESEARCH_MODE: "live",
        ANTHROPIC_API_KEY: "test-only-not-used",
        AGENT_MAX_TURNS: "12",
        AGENT_MAX_BUDGET_USD: "1",
        AGENT_TIMEOUT_MS: "120000",
        BROWSER_MAX_PAGES_PER_RUN: "10",
      }),
    );

    expect(bounded).toMatchObject({
      agentMaxTurns: LIVE_SMOKE_LIMITS.maxTurns,
      agentMaxBudgetUsd: LIVE_SMOKE_LIMITS.maxBudgetUsd,
      agentTimeoutMs: LIVE_SMOKE_LIMITS.timeoutMs,
      browserMaxPagesPerRun: LIVE_SMOKE_LIMITS.maxPages,
      webSearchMaxUses: LIVE_SMOKE_LIMITS.maxWebSearchUses,
      webSearchMaxResults: LIVE_SMOKE_LIMITS.maxWebSearchResults,
    });
    expect(createLiveSmokeRequest()).toMatchObject({
      mode: "live",
      niche: "electronics",
      sourceIds: ["webscraper-ecommerce-demo"],
      requestedProductCount: 2,
    });
  });

  it("reports a fully evidenced live MCP result without inspecting raw model output", () => {
    const inspection = inspectLiveSmokeRun({
      job: liveJob,
      report: { report: { mode: "claude_agent" } },
      products: [{ id: "product-1" }],
      events: [
        event("agent_sdk_initialized", "5/5 approved MCP tools registered"),
        event("agent_api_response_observed", "Anthropic response observed."),
        event("tool_started", "collect_products"),
        event("tool_completed", "collect_products: 2 products collected"),
        event("agent_terminal_result", "success; structured output received"),
        event("agent_structured_output_received"),
        event("agent_structured_output_validated"),
        event("agent_completed"),
      ],
    });

    expect(inspection).toMatchObject({
      passed: true,
      sdkInitialization: "5/5 approved MCP tools registered",
      providerRequest: "Anthropic response observed.",
      structuredOutput: "validated",
      persistedReport: "persisted claude_agent report",
      terminalAgentStatus: "success; structured output received",
      failureCategory: null,
    });
    expect(inspection.mcpTools).toContain("collect_products: completed");
  });

  it("identifies a browser collection failure and invalid model citations precisely", () => {
    const inspection = inspectLiveSmokeRun({
      job: {
        ...liveJob,
        status: "failed",
        errorCode: "AGENT_INVALID_OUTPUT",
        sanitizedErrorMessage: "The research agent cited a product that was not collected for this job.",
      },
      report: null,
      products: [],
      events: [
        event("agent_sdk_initialized", "5/5 approved MCP tools registered"),
        event("agent_api_response_observed", "Anthropic response observed."),
        event("tool_started", "collect_products"),
        event("tool_failed", "collect_products: BROWSER_LAUNCH_FAILED"),
        event("agent_terminal_result", "success; structured output received"),
        event("agent_structured_output_received"),
        event("agent_failed", "AGENT_INVALID_OUTPUT"),
      ],
    });

    expect(inspection).toMatchObject({
      passed: false,
      structuredOutput: "received but custom validation failed",
      terminalAgentStatus: "AGENT_INVALID_OUTPUT",
      failureCategory: "AGENT_INVALID_OUTPUT",
      safeErrorMessage: "The research agent cited a product that was not collected for this job.",
    });
    expect(inspection.mcpTools).toContain("collect_products: failed (BROWSER_LAUNCH_FAILED)");
  });

  it("preserves the sanitized Anthropic rejection diagnostic in the smoke summary", () => {
    const inspection = inspectLiveSmokeRun({
      job: {
        ...liveJob,
        status: "failed",
        errorCode: "AGENT_API_ERROR",
        sanitizedErrorMessage:
          "Anthropic rejected the outer Claude Agent SDK request; HTTP 400; SDK category unknown; request ID req_01Diagnostic. The SDK did not provide a safe provider error message.",
      },
      report: null,
      products: [],
      events: [
        event("agent_sdk_initialized", "6/6 approved MCP tools registered"),
        event(
          "agent_api_response_observed",
          "Anthropic API response rejected. SDK category unknown. Request ID req_01Diagnostic.",
        ),
        event(
          "agent_terminal_result",
          "success (error); terminal reason api_error; Anthropic HTTP 400; request ID req_01Diagnostic; provider message unavailable",
        ),
        event("agent_failed", "AGENT_API_ERROR"),
      ],
    });

    expect(inspection).toMatchObject({
      passed: false,
      providerRequest:
        "Anthropic API response rejected. SDK category unknown. Request ID req_01Diagnostic.",
      failureCategory: "AGENT_API_ERROR",
    });
  });

  it("creates a one-candidate dynamic discovery request for the explicit OpenRouter smoke test", () => {
    expect(createLiveSmokeRequest({ dynamicWebDiscovery: true })).toMatchObject({
      mode: "live",
      niche: "desk organizer",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 1,
      sourceIds: ["anthropic-web-discovery"],
    });
  });
});

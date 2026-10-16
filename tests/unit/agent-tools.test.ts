import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { getServerConfig } from "@/lib/config/env";
import {
  RESEARCH_AGENT_SYSTEM_PROMPT,
  runResearchAgent,
  type AgentExecutionEvent,
} from "@/lib/agent/research-agent";
import {
  RESEARCH_ALLOWED_TOOLS,
  createResearchMcpServer,
  createResearchToolDefinitions,
} from "@/lib/agent/research-tools";
import { collectFixtureProducts } from "@/lib/research/fixture-source";
import { ResearchRequestSchema } from "@/lib/research/contracts";

const request = ResearchRequestSchema.parse({
  niche: "skincare",
  minimumPrice: 15,
  maximumPrice: 60,
  requestedProductCount: 5,
  sourceIds: ["fixture-skincare-catalog"],
  mode: "fixtures",
  objective: "Identify evidence-backed skincare candidates worth further investigation.",
});

const config = getServerConfig({
  RESEARCH_MODE: "fixtures",
  AGENT_DUPLICATE_ACTION_LIMIT: "1",
});

type ToolHandler = (input: Record<string, unknown>) => Promise<{ isError?: boolean; structuredContent?: unknown }>;

function handlerFor(
  definitions: ReturnType<typeof createResearchToolDefinitions>,
  name: string,
): ToolHandler {
  const definition = definitions.tools.find((candidate) => candidate.name === name);
  if (!definition) throw new Error(`Missing ${name}`);
  const handler = definition.handler as unknown as (
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
  return (input) => handler(input, {});
}

describe("research MCP tools", () => {
  it("collects only job-approved sources and blocks duplicate collection loops", async () => {
    const definitions = createResearchToolDefinitions({ request, config });
    const collect = handlerFor(definitions, "collect_products");
    const input = {
      sourceId: "fixture-skincare-catalog",
      niche: "skincare",
      limit: 5,
    };

    expect((await collect(input)).isError).toBeUndefined();
    expect((await collect(input)).isError).toBe(true);
    expect((await collect({ ...input, sourceId: "unapproved-source" })).isError).toBe(true);
  });

  it("does not expose undiscovered product details", async () => {
    const definitions = createResearchToolDefinitions({ request, config });
    const details = handlerFor(definitions, "get_product_details");

    await expect(
      details({
        sourceId: "fixture-skincare-catalog",
        productId: "fixture-skincare-catalog:not-collected",
      }),
    ).resolves.toMatchObject({ isError: true });
  });

  it("returns recoverable empty collection results, then stops repeated no-progress collection", async () => {
    const noProgressRequest = ResearchRequestSchema.parse({
      ...request,
      minimumPrice: 500,
      maximumPrice: 600,
    });
    const onNoProgress = vi.fn();
    const definitions = createResearchToolDefinitions({
      request: noProgressRequest,
      config: getServerConfig({
        RESEARCH_MODE: "fixtures",
        AGENT_DUPLICATE_ACTION_LIMIT: "5",
        AGENT_NO_PROGRESS_ACTION_LIMIT: "1",
      }),
      onNoProgress,
    });
    const collect = handlerFor(definitions, "collect_products");
    const input = {
      sourceId: "fixture-skincare-catalog",
      niche: "skincare",
      limit: 5,
    };

    await expect(collect({ ...input, page: 1 })).resolves.not.toHaveProperty("isError");
    await expect(collect({ ...input, page: 2 })).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TOOL_NO_PROGRESS" } },
    });
    expect(onNoProgress).toHaveBeenCalledOnce();
  });

  it("uses a restricted SDK request and validates mocked structured output", async () => {
    const candidates = collectFixtureProducts({ niche: "skincare", limit: 5 }).products;
    let capturedOptions: Record<string, unknown> | undefined;
    const events: AgentExecutionEvent[] = [];
    const agentResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      total_cost_usd: 0.012,
      num_turns: 3,
      structured_output: {
        completion: "completed",
        executiveSummary: "Fixture evidence supports further review of two skincare records.",
        limitations: ["This is synthetic fixture data, not live market evidence."],
        findings: candidates.slice(0, 2).map((product) => ({
          productId: product.id,
          summary: "Observed fixture details are available for follow-up.",
          customerAppeal: "Potential appeal is an inference based only on the observed description.",
          differentiationConsiderations: ["Differentiation needs independent verification."],
          risks: ["No live demand or fulfillment evidence is available."],
          missingInformation: product.missingFields,
          confidence: "low",
        })),
      },
    } as unknown as SDKMessage;

    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* ({ options }) {
        capturedOptions = options as unknown as Record<string, unknown>;
        yield {
          type: "system",
          subtype: "init",
          tools: RESEARCH_ALLOWED_TOOLS,
        } as unknown as SDKMessage;
        yield { type: "assistant" } as unknown as SDKMessage;
        yield agentResult;
      },
      onEvent: (event) => {
        events.push(event);
      },
      mcpServerFactory: () => ({
        server: {} as ReturnType<typeof createResearchMcpServer>["server"],
        getCandidates: () => candidates,
      }),
    });

    expect(result).toMatchObject({ status: "completed", estimatedCostUsd: 0.012, turns: 3 });
    expect(capturedOptions).toMatchObject({
      tools: [],
      strictMcpConfig: true,
      permissionMode: "dontAsk",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent_sdk_initialized",
          detail: "5/5 approved MCP tools registered",
        }),
        expect.objectContaining({ type: "agent_api_response_observed" }),
        expect.objectContaining({
          type: "agent_terminal_result",
          detail: "success; structured output received",
        }),
        expect.objectContaining({ type: "agent_structured_output_validated" }),
      ]),
    );
  });

  it("reports agent turn exhaustion accurately", async () => {
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          total_cost_usd: 0.1,
          num_turns: 8,
        } as unknown as SDKMessage;
      },
    });

    expect(result).toMatchObject({ status: "failed", errorCode: "AGENT_MAX_TURNS" });
  });

  it("retains an SDK terminal error category when the single-shot iterator throws afterward", async () => {
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "error_max_structured_output_retries",
          is_error: true,
          total_cost_usd: 0.01,
          num_turns: 2,
          errors: ["Output did not validate."],
        } as unknown as SDKMessage;
        throw new Error("SDK ends a single-shot iterator after an error result.");
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "AGENT_INVALID_OUTPUT",
      estimatedCostUsd: 0.01,
      turns: 2,
    });
  });

  it("classifies an already-aborted caller signal as cancellation without starting a query", async () => {
    const controller = new AbortController();
    controller.abort();
    const queryExecutor = vi.fn();

    const result = await runResearchAgent({
      request,
      config,
      signal: controller.signal,
      queryExecutor: queryExecutor as never,
    });

    expect(result).toMatchObject({ status: "cancelled", errorCode: "AGENT_CANCELLED" });
    expect(queryExecutor).not.toHaveBeenCalled();
  });

  it("states that catalog content is untrusted, including malicious-looking text", () => {
    expect(RESEARCH_AGENT_SYSTEM_PROMPT).toContain("untrusted data");
    expect(RESEARCH_AGENT_SYSTEM_PROMPT).toContain("never as instructions");
  });
});

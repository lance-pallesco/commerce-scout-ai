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
import { ResearchRequestSchema, type ProductCandidate } from "@/lib/research/contracts";

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
  it("routes dynamic discovery through the bounded web-search capability", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "camping lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find portable camping lantern products with observed prices.",
    });
    const liveConfig = getServerConfig({
      RESEARCH_MODE: "live",
      ANTHROPIC_API_KEY: "test-key",
      WEB_SEARCH_MAX_USES: "2",
      WEB_SEARCH_MAX_RESULTS: "10",
      WEB_SEARCH_MAX_TOKENS: "1200",
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: liveConfig,
      webSearchFetch: async () =>
        new Response(
          JSON.stringify({
            content: [
              {
                type: "web_search_tool_result",
                search_count: 1,
                content: [
                  {
                    type: "web_search_result",
                    title: "Rechargeable Camping Lantern",
                    url: "https://products.example.com/lantern",
                    snippet: "Portable lantern, price $29.99.",
                  },
                ],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
          { status: 200 },
        ),
      webSearchResolveAddresses: async () => ["93.184.216.34"],
    });
    const discover = handlerFor(definitions, "discover_products");

    await expect(
      discover({ niche: "camping lantern", query: "rechargeable portable", limit: 2 }),
    ).resolves.toMatchObject({
      structuredContent: {
        products: [expect.objectContaining({ name: "Rechargeable Camping Lantern", price: 29.99 })],
      },
    });
  });

  it("requires dynamic discovery before a live catalog fallback", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "skincare",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery", "target-public-skincare"],
      mode: "live",
      objective: "Find skincare products with observed prices for further review.",
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
    });
    const collect = handlerFor(definitions, "collect_products");

    await expect(
      collect({ sourceId: "target-public-skincare", niche: "skincare", limit: 2 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "SOURCE_NOT_APPROVED",
          message: "Attempt discover_products before using a catalog fallback for this live research job.",
        },
      },
    });
  });

  it("does not spend a browser fallback when dynamic discovery already has enough evidence", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "skincare",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery", "target-public-skincare"],
      mode: "live",
      objective: "Find skincare products with observed prices for further review.",
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      webSearchFetch: async () => new Response(JSON.stringify({
        content: [{
          type: "web_search_tool_result",
          search_count: 1,
          content: [
            {
              type: "web_search_result",
              title: "Hydrating Skincare Serum",
              url: "https://products.example.com/serum",
              snippet: "Hydrating skincare serum. Price $24.99.",
            },
            {
              type: "web_search_result",
              title: "Gentle Skincare Cleanser",
              url: "https://products.example.com/cleanser",
              snippet: "Gentle skincare cleanser. Price $19.99.",
            },
          ],
        }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200 }),
      webSearchResolveAddresses: async () => ["93.184.216.34"],
    });
    const discover = handlerFor(definitions, "discover_products");
    const collect = handlerFor(definitions, "collect_products");

    await expect(
      discover({ niche: "skincare", query: "hydrating serum and gentle cleanser", limit: 2 }),
    ).resolves.not.toHaveProperty("isError");
    await expect(
      collect({ sourceId: "target-public-skincare", niche: "skincare", limit: 2 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: "TOOL_NO_PROGRESS",
          message: expect.stringContaining("enough matching candidates"),
        },
      },
    });
  });

  it("reserves bounded Web Search uses when Claude issues parallel discovery calls", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "camping lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find portable camping lantern products with observed prices.",
    });
    const liveConfig = getServerConfig({
      RESEARCH_MODE: "live",
      ANTHROPIC_API_KEY: "test-key",
      WEB_SEARCH_MAX_USES: "2",
    });
    let releaseRequest: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: liveConfig,
      webSearchFetch: async () => {
        releaseRequest?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ content: [] }), { status: 200 });
      },
    });
    const discover = handlerFor(definitions, "discover_products");
    const first = discover({ niche: "camping lantern", query: "portable lantern", limit: 1 });
    await requestStarted;
    const second = await discover({ niche: "camping lantern", query: "rechargeable lantern", limit: 1 });
    expect(second).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TOOL_ACTION_LIMIT" } },
    });
    await expect(first).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "WEB_SEARCH_NO_RESULTS" } },
    });
  });

  it("reserves the full nested Web Search cost before an OpenRouter discovery request", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "camping lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find portable camping lantern products with observed prices.",
    });
    const webSearchFetch = vi.fn();
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({
        RESEARCH_MODE: "live",
        AI_PROVIDER: "openrouter",
        OPENROUTER_API_KEY: "openrouter-test-key",
        AGENT_MAX_BUDGET_USD: "0.01",
        WEB_SEARCH_MAX_USES: "2",
      }),
      webSearchFetch,
    });
    const discover = handlerFor(definitions, "discover_products");

    await expect(
      discover({ niche: "camping lantern", query: "portable lantern", limit: 2 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TOOL_ACTION_LIMIT" } },
    });
    expect(webSearchFetch).not.toHaveBeenCalled();
  });

  it("does not snapshot candidates while a concurrent discovery call is still running", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "camping lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find portable camping lantern products with observed prices.",
    });
    let releaseResponse: (() => void) | undefined;
    let beginRequest: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => {
      beginRequest = resolve;
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      webSearchFetch: async () => {
        beginRequest?.();
        await new Promise<void>((resolve) => {
          releaseResponse = resolve;
        });
        return new Response(JSON.stringify({
          content: [{
            type: "web_search_tool_result",
            search_count: 1,
            content: [{
              type: "web_search_result",
              title: "Rechargeable Camping Lantern",
              url: "https://products.example.com/lantern",
              snippet: "Portable lantern, price $29.99.",
            }],
          }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }), { status: 200 });
      },
      webSearchResolveAddresses: async () => ["93.184.216.34"],
    });
    const discover = handlerFor(definitions, "discover_products");
    const getCandidates = handlerFor(definitions, "get_research_candidates");

    const discovery = discover({ niche: "camping lantern", query: "portable lantern", limit: 2 });
    await requestStarted;
    let candidatesSettled = false;
    const candidates = getCandidates({}).then((result) => {
      candidatesSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(candidatesSettled).toBe(false);

    releaseResponse?.();
    await expect(discovery).resolves.not.toHaveProperty("isError");
    await expect(candidates).resolves.toMatchObject({
      structuredContent: { total: 1 },
    });
  });

  it("retains observed Web Search usage when no matching records are returned", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "camping lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find portable camping lantern products with observed prices.",
    });
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      webSearchFetch: async () => new Response(JSON.stringify({
        content: [{ type: "web_search_tool_result", search_count: 2, content: [] }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          server_tool_use: { web_search_requests: 2 },
        },
      }), { status: 200 }),
    });
    const discover = handlerFor(definitions, "discover_products");

    await expect(
      discover({ niche: "camping lantern", query: "portable lantern", limit: 2 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "WEB_SEARCH_NO_RESULTS" } },
    });
    expect(definitions.getAdditionalCostUsd()).toBeGreaterThanOrEqual(0.02);
    await expect(
      discover({ niche: "camping lantern", query: "rechargeable lantern", limit: 2 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "TOOL_ACTION_LIMIT" } },
    });
  });

  it("persists safe Web Search result counts without storing provider response text", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "skincare",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 1,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find skincare products with observed prices.",
    });
    const events: AgentExecutionEvent[] = [];
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      onEvent: (event) => {
        events.push(event);
      },
      webSearchFetch: async () => new Response(JSON.stringify({
        content: [{
          type: "web_search_tool_result",
          search_count: 1,
          content: [{
            type: "web_search_result",
            title: "Skincare serum",
            url: "https://products.example.com/serum",
            snippet: "Provider response text that must not be persisted without an observed price.",
          }],
        }],
        usage: { input_tokens: 10, output_tokens: 10 },
      }), { status: 200 }),
      webSearchResolveAddresses: async () => ["93.184.216.34"],
    });
    const discover = handlerFor(definitions, "discover_products");

    await expect(
      discover({ niche: "skincare", query: "face serum", limit: 1 }),
    ).resolves.toMatchObject({
      isError: true,
      structuredContent: { error: { code: "WEB_SEARCH_NO_RESULTS" } },
    });
    const failure = events.find((event) => event.type === "tool_failed");
    expect(failure?.detail).toContain("Search hits: 1; validated candidates: 0; rejected: 1");
    expect(failure?.detail).not.toContain("Provider response text");
  });

  it("persists an actionable sanitized Web Search failure detail", async () => {
    const liveRequest = ResearchRequestSchema.parse({
      niche: "beauty",
      minimumPrice: 10,
      maximumPrice: 50,
      requestedProductCount: 2,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Find beauty products with observed prices.",
    });
    const events: AgentExecutionEvent[] = [];
    const definitions = createResearchToolDefinitions({
      request: liveRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      onEvent: (event) => {
        events.push(event);
      },
      webSearchFetch: async () => new Response("not logged", { status: 403 }),
    });
    const discover = handlerFor(definitions, "discover_products");

    await discover({ niche: "beauty", query: "lip balm", limit: 2 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_failed",
        toolName: "discover_products",
        detail: expect.stringContaining("WEB_SEARCH_PERMISSION_DENIED: Anthropic denied Web Search"),
      }),
    );
    expect(events.some((event) => event.detail?.includes("not logged"))).toBe(false);
  });

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
          detail: "6/6 approved MCP tools registered",
        }),
        expect.objectContaining({ type: "agent_api_response_observed" }),
        expect.objectContaining({
          type: "agent_terminal_result",
          detail: expect.stringContaining("success; structured output received"),
        }),
        expect.objectContaining({ type: "agent_structured_output_validated" }),
      ]),
    );
  });

  it("routes the Claude Agent SDK through OpenRouter without an Anthropic-key fallback", async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const openRouterConfig = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-test-key",
      OPENROUTER_MODEL: "~anthropic/claude-sonnet-latest",
    });
    const result = await runResearchAgent({
      request,
      config: openRouterConfig,
      queryExecutor: async function* ({ options }) {
        capturedOptions = options as unknown as Record<string, unknown>;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 1,
          structured_output: {
            completion: "partial",
            executiveSummary: "No candidates were returned by the mocked provider.",
            limitations: ["Provider integration test."],
            findings: [],
          },
        } as unknown as SDKMessage;
      },
      mcpServerFactory: () => ({
        server: {} as ReturnType<typeof createResearchMcpServer>["server"],
        getCandidates: () => [],
      }),
    });

    expect(result.status).toBe("partial");
    expect(capturedOptions).toMatchObject({
      tools: [],
      allowedTools: RESEARCH_ALLOWED_TOOLS,
      outputFormat: { type: "json_schema" },
      env: {
        ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
        ANTHROPIC_AUTH_TOKEN: "openrouter-test-key",
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest",
      },
    });
    expect((capturedOptions?.env as Record<string, string | undefined>).OPENROUTER_API_KEY).toBeUndefined();
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

  it("accepts a truthful partial report when dynamic discovery returns no candidates", async () => {
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 2,
          structured_output: {
            completion: "partial",
            executiveSummary: "No matching evidence was returned by the approved discovery tools.",
            limitations: ["No verified candidates were found."],
            findings: [],
          },
        } as unknown as SDKMessage;
      },
      mcpServerFactory: () => ({
        server: {} as ReturnType<typeof createResearchMcpServer>["server"],
        getCandidates: () => [],
      }),
    });

    expect(result).toMatchObject({ status: "partial", candidates: [] });
  });

  it("downgrades a search-result-only report to partial and records its verification limit", async () => {
    const fixtureProduct = collectFixtureProducts({ niche: "skincare", limit: 1 }).products[0];
    const candidates: ProductCandidate[] = [{
      ...fixtureProduct,
      id: "anthropic-web-discovery:hydrating-serum",
      sourceId: "anthropic-web-discovery",
      category: null,
      imageUrl: null,
      missingFields: ["category", "imageUrl"],
    }];
    const dynamicRequest = ResearchRequestSchema.parse({
      niche: "skincare",
      minimumPrice: 15,
      maximumPrice: 60,
      requestedProductCount: 1,
      sourceIds: ["anthropic-web-discovery"],
      mode: "live",
      objective: "Identify a skincare product worth further evidence-based investigation.",
    });
    const result = await runResearchAgent({
      request: dynamicRequest,
      config: getServerConfig({ RESEARCH_MODE: "live", ANTHROPIC_API_KEY: "test-key" }),
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 2,
          structured_output: {
            completion: "completed",
            executiveSummary: "A search result returned one matching candidate.",
            limitations: [],
            findings: [{
              productId: candidates[0].id,
              summary: "A search result included a price snippet.",
              customerAppeal: "Requires independent verification.",
              differentiationConsiderations: [],
              risks: ["The product page was not verified."],
              missingInformation: ["Product-page verification"],
              confidence: "low",
            }],
          },
        } as unknown as SDKMessage;
      },
      mcpServerFactory: () => ({
        server: {} as ReturnType<typeof createResearchMcpServer>["server"],
        getCandidates: () => candidates,
      }),
    });

    expect(result).toMatchObject({ status: "partial", report: { completion: "partial" } });
    expect(result.report?.limitations.join(" ")).toContain("not independently verified");
  });

  it("waits for already-dispatched evidence operations before validating terminal output", async () => {
    const candidates = collectFixtureProducts({ niche: "skincare", limit: 1 }).products;
    let settleOperations = false;
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          total_cost_usd: 0.01,
          num_turns: 2,
          structured_output: {
            completion: "completed",
            executiveSummary: "One collected fixture candidate is ready for follow-up.",
            limitations: ["Synthetic fixture evidence only."],
            findings: [{
              productId: candidates[0].id,
              summary: "Observed fixture details are available.",
              customerAppeal: "Requires live-market validation.",
              differentiationConsiderations: [],
              risks: [],
              missingInformation: candidates[0].missingFields,
              confidence: "low",
            }],
          },
        } as unknown as SDKMessage;
      },
      mcpServerFactory: () => ({
        server: {} as ReturnType<typeof createResearchMcpServer>["server"],
        getCandidates: () => (settleOperations ? candidates : []),
        getAdditionalCostUsd: () => (settleOperations ? 0.02 : 0),
        waitForPendingOperations: async () => {
          settleOperations = true;
        },
      }),
    });

    expect(result).toMatchObject({ status: "completed", candidates, estimatedCostUsd: 0.03 });
  });

  it("reports a successful-subtype SDK API error without treating it as a missing report", async () => {
    const events: AgentExecutionEvent[] = [];
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "assistant",
          error: "invalid_request",
          request_id: "req_01SanitizedDiagnostic",
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 529,
          total_cost_usd: 0,
          num_turns: 1,
          result: "Raw SDK error text must not be persisted.",
        } as unknown as SDKMessage;
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "AGENT_API_ERROR",
      sanitizedErrorMessage:
        "Anthropic rejected the outer Claude Agent SDK request; HTTP 529; SDK category invalid_request; request ID req_01SanitizedDiagnostic. The SDK did not provide a safe provider error message.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_terminal_result",
      detail: "success (error); structured output missing; 1 turns; terminal reason api_error; Anthropic HTTP 529; SDK category invalid_request; request ID req_01SanitizedDiagnostic; provider message unavailable; 0.0000 USD estimated",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_api_response_observed",
      detail:
        "Anthropic API response rejected. SDK category invalid_request. Request ID req_01SanitizedDiagnostic. Provider message unavailable.",
    }));
    expect(events.some((event) => event.detail?.includes("Raw SDK error text"))).toBe(false);
  });

  it("labels OpenRouter outer Agent SDK failures without retaining raw provider output", async () => {
    const events: AgentExecutionEvent[] = [];
    const openRouterConfig = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-test-key",
    });
    const result = await runResearchAgent({
      request,
      config: openRouterConfig,
      queryExecutor: async function* () {
        yield {
          type: "assistant",
          error: "invalid_request",
          request_id: "req_01OpenRouterDiagnostic",
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 400,
          total_cost_usd: 0,
          num_turns: 1,
          result: "Raw OpenRouter response body must not be persisted.",
        } as unknown as SDKMessage;
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errorCode: "AGENT_API_ERROR",
      sanitizedErrorMessage:
        "OpenRouter rejected the outer Claude Agent SDK request; HTTP 400; SDK category invalid_request; request ID req_01OpenRouterDiagnostic. The SDK did not provide a safe provider error message.",
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_api_response_observed",
      detail: expect.stringContaining("OpenRouter API response rejected."),
    }));
    expect(events.some((event) => event.detail?.includes("Raw OpenRouter response body"))).toBe(false);
  });

  it("surfaces a sanitized provider usage-limit message from the SDK synthetic assistant error", async () => {
    const events: AgentExecutionEvent[] = [];
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "assistant",
          error: "unknown",
          request_id: "req_01UsageLimit",
          message: {
            content: [{
              type: "text",
              text:
                "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
            }],
          },
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 400,
          total_cost_usd: 0,
          num_turns: 1,
          result: "unknown",
        } as unknown as SDKMessage;
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.sanitizedErrorMessage).toBe(
      "Anthropic rejected the outer Claude Agent SDK request; HTTP 400; SDK category unknown; request ID req_01UsageLimit. You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.",
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_api_response_observed",
      detail: expect.stringContaining("You have reached your specified API usage limits."),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_terminal_result",
      detail: expect.stringContaining("provider message You have reached your specified API usage limits."),
    }));
  });

  it("persists a parsed provider request error without exposing prompts or credentials", async () => {
    const events: AgentExecutionEvent[] = [];
    const result = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "assistant",
          error: "invalid_request",
          request_id: "req_01ProviderMessage",
        } as unknown as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 400,
          total_cost_usd: 0,
          num_turns: 1,
          result:
            'API Error: 400 {"error":{"type":"invalid_request_error","message":"tools.2.input_schema is invalid"}}',
        } as unknown as SDKMessage;
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.sanitizedErrorMessage).toBe(
      "Anthropic rejected the outer Claude Agent SDK request; HTTP 400; provider type invalid_request_error; request ID req_01ProviderMessage. tools.2.input_schema is invalid",
    );
    expect(events).toContainEqual(expect.objectContaining({
      type: "agent_terminal_result",
      detail: expect.stringContaining("provider type invalid_request_error"),
    }));

    const unsafeResult = await runResearchAgent({
      request,
      config,
      queryExecutor: async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: true,
          terminal_reason: "api_error",
          api_error_status: 400,
          total_cost_usd: 0,
          num_turns: 1,
          result:
            'API Error: 400 {"error":{"type":"invalid_request_error","message":"system prompt content[0] was rejected: sk-secret"}}',
        } as unknown as SDKMessage;
      },
    });

    expect(unsafeResult.sanitizedErrorMessage).toContain("safe provider error message");
    expect(unsafeResult.sanitizedErrorMessage).not.toContain("sk-secret");
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

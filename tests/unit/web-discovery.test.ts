import { describe, expect, it } from "vitest";

import { getServerConfig } from "@/lib/config/env";
import { discoverProductsWithWebSearch } from "@/lib/research/web-discovery";

const config = getServerConfig({
  RESEARCH_MODE: "live",
  ANTHROPIC_API_KEY: "test-key",
  AGENT_MODEL: "sonnet",
  WEB_SEARCH_MAX_USES: "2",
  WEB_SEARCH_MAX_RESULTS: "10",
  WEB_SEARCH_MAX_TOKENS: "1200",
});

const openRouterConfig = getServerConfig({
  RESEARCH_MODE: "live",
  AI_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "openrouter-test-key",
  OPENROUTER_MODEL: "~anthropic/claude-sonnet-latest",
  WEB_SEARCH_MAX_USES: "2",
  WEB_SEARCH_MAX_RESULTS: "10",
  WEB_SEARCH_MAX_TOKENS: "1200",
});

function response(
  content: unknown,
  usage: Readonly<{
    input_tokens: number;
    output_tokens: number;
    server_tool_use?: Readonly<{ web_search_requests: number }>;
  }> = { input_tokens: 100, output_tokens: 50 },
): Response {
  return new Response(JSON.stringify({ content, usage }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function openRouterCitationResponse(
  annotations: unknown,
  usage: Readonly<{
    input_tokens: number;
    output_tokens: number;
    server_tool_use: Readonly<{ web_search_requests: number }>;
  }> = {
    input_tokens: 100,
    output_tokens: 50,
    server_tool_use: { web_search_requests: 1 },
  },
): Response {
  return new Response(JSON.stringify({
    content: [{ type: "text", text: "Provider-generated answer with citations." }],
    annotations,
    usage,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Anthropic web discovery", () => {
  it("converts observable priced search results into niche-matched candidates", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await discoverProductsWithWebSearch({
      niche: "skincare",
      query: "gentle face serum",
      minimumPrice: 15,
      maximumPrice: 60,
      limit: 5,
      config,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response([
          {
            type: "web_search_tool_result",
            search_count: 1,
            content: [
              {
                type: "web_search_result",
                title: "Hydrating Skincare Face Serum",
                url: "https://products.example.com/serum",
                snippet: "A gentle daily serum. Price $24.99.",
              },
              {
                type: "web_search_result",
                title: "Gaming laptop",
                url: "https://products.example.com/laptop",
                snippet: "Price $899.",
              },
            ],
          },
        ]);
      },
      resolveAddresses: async () => ["93.184.216.34"],
    });

    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      sourceId: "anthropic-web-discovery",
      name: "Hydrating Skincare Face Serum",
      price: 24.99,
      category: null,
      sourceUrl: "https://products.example.com/serum",
    });
    expect(result.products[0].evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name", confidence: "medium" }),
        expect.objectContaining({ field: "price", confidence: "medium" }),
      ]),
    );
    expect(result.searchUses).toBe(1);
    expect(result.estimatedCostUsd).toBeGreaterThan(0.01);
    expect(requestBody).toMatchObject({
      tools: [{
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 2,
        allowed_callers: ["direct"],
      }],
    });
  });

  it("uses OpenRouter's bounded server Web Search without sending an Anthropic credential", async () => {
    let requestUrl = "";
    let requestHeaders: Headers | undefined;
    let requestBody: Record<string, unknown> | undefined;
    const result = await discoverProductsWithWebSearch({
      niche: "skincare",
      query: "gentle face serum",
      minimumPrice: 15,
      maximumPrice: 60,
      limit: 3,
      config: openRouterConfig,
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestHeaders = new Headers(init?.headers);
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return openRouterCitationResponse([
          {
            type: "url_citation",
            url_citation: {
              title: "Hydrating Skincare Face Serum",
              url: "https://products.example.com/serum",
              content: "A gentle daily serum with an observed price of $24.99.",
            },
          },
        ]);
      },
      resolveAddresses: async () => ["93.184.216.34"],
    });

    expect(result.products).toHaveLength(1);
    expect(requestUrl).toBe("https://openrouter.ai/api/v1/messages");
    expect(requestHeaders?.get("authorization")).toBe("Bearer openrouter-test-key");
    expect(requestHeaders?.get("x-api-key")).toBeNull();
    expect(requestHeaders?.get("anthropic-version")).toBeNull();
    expect(requestBody).toMatchObject({
      model: "~anthropic/claude-sonnet-latest",
      max_tool_calls: 2,
      tools: [{
        type: "openrouter:web_search",
        parameters: {
          engine: "exa",
          max_uses: 2,
          max_results: 9,
          max_total_results: 18,
          max_characters: 2_000,
        },
      }],
    });
    expect(result.estimatedCostUsd).toBe(0.007);
  });

  it("requests bounded headroom so an out-of-range first hit does not hide a valid candidate", async () => {
    const limitedOpenRouterConfig = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-test-key",
      OPENROUTER_MODEL: "~anthropic/claude-sonnet-latest",
      WEB_SEARCH_MAX_USES: "1",
      WEB_SEARCH_MAX_RESULTS: "3",
      WEB_SEARCH_MAX_TOKENS: "1200",
    });
    let requestBody: Record<string, unknown> | undefined;

    const result = await discoverProductsWithWebSearch({
      niche: "desk organizer",
      query: "desk organizer",
      minimumPrice: 15,
      maximumPrice: 60,
      // The smoke path needs one persisted candidate, but discovery should
      // receive the configured three-result ceiling before filtering.
      limit: 1,
      config: limitedOpenRouterConfig,
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return openRouterCitationResponse([
          {
            type: "url_citation",
            url_citation: {
              title: "Desk Organizer",
              url: "https://products.example.com/too-cheap-organizer",
              content: "Desk organizer with an observed price of $9.99.",
            },
          },
          {
            type: "url_citation",
            url_citation: {
              title: "Bamboo Desk Organizer",
              url: "https://products.example.com/bamboo-desk-organizer",
              content: "Bamboo desk organizer with an observed price of $29.99.",
            },
          },
        ]);
      },
      resolveAddresses: async () => ["93.184.216.34"],
    });

    expect(requestBody).toMatchObject({
      tools: [{
        parameters: {
          max_uses: 1,
          max_results: 3,
          max_total_results: 3,
        },
      }],
    });
    expect(result.products).toEqual([
      expect.objectContaining({
        name: "Bamboo Desk Organizer",
        price: 29.99,
      }),
    ]);
  });

  it("accepts OpenRouter citations returned through a Chat Completions compatibility envelope", async () => {
    const result = await discoverProductsWithWebSearch({
      niche: "skincare",
      query: "gentle face serum",
      minimumPrice: 15,
      maximumPrice: 60,
      limit: 3,
      config: openRouterConfig,
      fetchImpl: async () => new Response(JSON.stringify({
        content: [{ type: "text", text: "Do not use this generated answer as evidence." }],
        choices: [{
          message: {
            annotations: [{
              type: "url_citation",
              url_citation: {
                title: "Skincare Face Serum",
                url: "https://products.example.com/chat-envelope-serum",
                content: "Skincare serum, observed price $29.00.",
              },
            }],
          },
        }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          server_tool_use: { web_search_requests: 1 },
        },
      }), { status: 200 }),
      resolveAddresses: async () => ["93.184.216.34"],
    });

    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      name: "Skincare Face Serum",
      price: 29,
      sourceUrl: "https://products.example.com/chat-envelope-serum",
    });
  });

  it("classifies safe HTTP failures without retaining response bodies", async () => {
    await expect(
      discoverProductsWithWebSearch({
        niche: "beauty",
        query: "lip balm",
        minimumPrice: 5,
        maximumPrice: 40,
        limit: 2,
        config,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "secret response details" } }), {
            status: 403,
          }),
      }),
    ).rejects.toMatchObject({
      code: "WEB_SEARCH_PERMISSION_DENIED",
      message: expect.stringContaining("HTTP 403"),
      httpStatus: 403,
    });
  });

  it("reports an OpenRouter authentication failure without retaining its response body", async () => {
    await expect(
      discoverProductsWithWebSearch({
        niche: "beauty",
        query: "lip balm",
        minimumPrice: 5,
        maximumPrice: 40,
        limit: 2,
        config: openRouterConfig,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "credential must never be persisted" } }), {
            status: 401,
          }),
      }),
    ).rejects.toMatchObject({
      code: "WEB_SEARCH_AUTHENTICATION_FAILED",
      message: "OpenRouter rejected the Web Search credential (HTTP 401). Check OPENROUTER_API_KEY.",
      httpStatus: 401,
    });
  });

  it("surfaces Anthropic server-tool errors separately from an empty result set", async () => {
    await expect(
      discoverProductsWithWebSearch({
        niche: "beauty",
        query: "lip balm",
        minimumPrice: 5,
        maximumPrice: 40,
        limit: 2,
        config,
        fetchImpl: async () =>
          response([
            {
              type: "web_search_tool_result_error",
              error_code: "unavailable",
            },
          ]),
      }),
    ).rejects.toMatchObject({
      code: "WEB_SEARCH_TOOL_FAILED",
      message: expect.stringContaining("unavailable"),
    });
  });

  it("uses Anthropic's observed Web Search usage for bounded cost accounting", async () => {
    const result = await discoverProductsWithWebSearch({
      niche: "skincare",
      query: "face serum",
      minimumPrice: 15,
      maximumPrice: 60,
      limit: 1,
      config,
      fetchImpl: async () =>
        response(
          [{
            type: "web_search_tool_result",
            search_count: 1,
            content: [{
              type: "web_search_result",
              title: "Skincare Face Serum",
              url: "https://products.example.com/serum",
              snippet: "Price $24.",
            }],
          }],
          {
            input_tokens: 100,
            output_tokens: 50,
            server_tool_use: { web_search_requests: 2 },
          },
        ),
      resolveAddresses: async () => ["93.184.216.34"],
    });

    expect(result.searchUses).toBe(2);
    expect(result.estimatedCostUsd).toBeGreaterThanOrEqual(0.02);
  });

  it("reports rejected private and non-HTTPS result URLs without trusting fabricated evidence", async () => {
    await expect(discoverProductsWithWebSearch({
      niche: "camping lantern",
      query: "portable lantern",
      minimumPrice: 10,
      maximumPrice: 100,
      limit: 5,
      config,
      fetchImpl: async () =>
        response([
          {
            type: "web_search_tool_result",
            search_count: 1,
            content: [
              {
                type: "web_search_result",
                title: "Camping lantern",
                url: "http://127.0.0.1/private",
                snippet: "Price $30.",
              },
            ],
          },
        ]),
      resolveAddresses: async () => ["127.0.0.1"],
    })).rejects.toMatchObject({
      code: "WEB_SEARCH_NO_RESULTS",
      diagnostics: expect.objectContaining({ rejectedUrlCount: 1, validCandidateCount: 0 }),
    });
  });

  it("reports a niche mismatch instead of accepting a generic modifier as proof", async () => {
    await expect(discoverProductsWithWebSearch({
      niche: "wireless earbuds",
      query: "affordable wireless earbuds",
      minimumPrice: 10,
      maximumPrice: 100,
      limit: 5,
      config,
      fetchImpl: async () =>
        response([
          {
            type: "web_search_tool_result",
            search_count: 1,
            content: [
              {
                type: "web_search_result",
                title: "Wireless charger",
                url: "https://products.example.com/charger",
                snippet: "A compact charging pad. Price $29.",
              },
            ],
          },
        ]),
      resolveAddresses: async () => ["93.184.216.34"],
    })).rejects.toMatchObject({
      code: "WEB_SEARCH_NO_RESULTS",
      diagnostics: expect.objectContaining({ nicheMismatchCount: 1, validCandidateCount: 0 }),
    });
  });

  it("reports observable result counts and rejection reasons when citations lack a usable price", async () => {
    await expect(discoverProductsWithWebSearch({
      niche: "skincare",
      query: "gentle face serum",
      minimumPrice: 15,
      maximumPrice: 60,
      limit: 2,
      config: openRouterConfig,
      fetchImpl: async () => openRouterCitationResponse([
        {
          type: "url_citation",
          url_citation: {
            title: "Gentle Skincare Face Serum",
            url: "https://products.example.com/no-price-serum",
            content: "A gentle daily face serum with no price in this observed excerpt.",
          },
        },
      ]),
      resolveAddresses: async () => ["93.184.216.34"],
    })).rejects.toMatchObject({
      code: "WEB_SEARCH_NO_RESULTS",
      message: expect.stringContaining("Search hits: 1; validated candidates: 0; rejected: 1"),
      diagnostics: expect.objectContaining({ missingPriceCount: 1 }),
    });
  });

  it("fails closed when the search response has no usable results", async () => {
    await expect(
      discoverProductsWithWebSearch({
        niche: "home storage",
        query: "modular shelf",
        minimumPrice: 20,
        maximumPrice: 200,
        limit: 2,
        config,
        fetchImpl: async () => response([]),
      }),
    ).rejects.toMatchObject({ code: "WEB_SEARCH_NO_RESULTS" });
  });
});

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

function response(content: unknown, usage = { input_tokens: 100, output_tokens: 50 }): Response {
  return new Response(JSON.stringify({ content, usage }), {
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
      sourceUrl: "https://products.example.com/serum",
    });
    expect(result.searchUses).toBe(1);
    expect(result.estimatedCostUsd).toBeGreaterThan(0.01);
    expect(requestBody).toMatchObject({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    });
  });

  it("rejects private and non-HTTPS result URLs without trusting fabricated evidence", async () => {
    const result = await discoverProductsWithWebSearch({
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
    });

    expect(result.products).toEqual([]);
    expect(result.rejectedUrlCount).toBe(1);
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

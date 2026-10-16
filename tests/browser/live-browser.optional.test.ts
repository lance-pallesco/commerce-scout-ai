import { describe, expect, it } from "vitest";

import { getServerConfig } from "@/lib/config/env";
import { collectWebScraperCatalogProducts } from "@/lib/research/browser-source";
import { collectProducts } from "@/lib/research/collection-service";
import { getResearchSource } from "@/lib/research/source-registry";

const runLiveBrowserTest = process.env.RUN_LIVE_BROWSER_TESTS === "true";

describe.runIf(runLiveBrowserTest)("approved external browser source", () => {
  it("collects available product evidence without claiming a skincare category", async () => {
    const config = getServerConfig({ RESEARCH_MODE: "live" });
    const result = await collectWebScraperCatalogProducts({
      source: getResearchSource("webscraper-ecommerce-demo", "live"),
      limit: 2,
      headless: config.browserHeadless,
      timeoutMs: config.browserTimeoutMs,
      maxPages: config.browserMaxPagesPerRun,
    });

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((product) => product.category === "electronics")).toBe(true);
  });

  it("collects registered skincare evidence from the public Target catalog", async () => {
    const config = getServerConfig({ RESEARCH_MODE: "live" });
    const result = await collectProducts({
      sourceId: "target-public-skincare",
      niche: "skincare",
      limit: 2,
      minimumPrice: 0,
      maximumPrice: 100_000,
      mode: "live",
    }, config);

    expect(result.products.length).toBeGreaterThan(0);
    expect(result.products.every((product) => product.sourceId === "target-public-skincare")).toBe(true);
  });
});

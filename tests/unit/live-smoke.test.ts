import { describe, expect, it } from "vitest";

import {
  createLiveSmokeConfig,
  createLiveSmokeRequest,
  LIVE_SMOKE_LIMITS,
} from "@/lib/agent/live-smoke";
import { getServerConfig } from "@/lib/config/env";

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
    });
    expect(createLiveSmokeRequest()).toMatchObject({
      mode: "live",
      niche: "electronics",
      sourceIds: ["webscraper-ecommerce-demo"],
      requestedProductCount: 2,
    });
  });
});

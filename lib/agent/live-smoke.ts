import type { ServerConfig } from "@/lib/config/env";
import { ResearchRequestSchema, type ResearchRequest } from "@/lib/research/contracts";

export const LIVE_SMOKE_LIMITS = Object.freeze({
  maxTurns: 5,
  maxBudgetUsd: 0.1,
  timeoutMs: 90_000,
  maxPages: 1,
});

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

import { getServerConfig, type ServerConfig } from "@/lib/config/env";

import {
  CollectionResultSchema,
  type CollectionResult,
  type ResearchMode,
} from "./contracts";
import { collectWebScraperCatalogProducts } from "./browser-source";
import { collectFixtureProducts } from "./fixture-source";
import { filterProductsByNiche, filterProductsByPrice } from "./normalize";
import {
  assertSourceSupportsNiche,
  getResearchSource,
} from "./source-registry";

export type CollectProductsInput = Readonly<{
  sourceId: string;
  niche: string;
  searchQuery?: string;
  limit: number;
  minimumPrice: number;
  maximumPrice: number;
  mode: ResearchMode;
  signal?: AbortSignal;
}>;

export async function collectProducts(
  input: CollectProductsInput,
  config: ServerConfig = getServerConfig(),
): Promise<CollectionResult> {
  const startedAt = Date.now();
  const source = getResearchSource(input.sourceId, input.mode);
  assertSourceSupportsNiche(source, input.niche);
  const limit = Math.min(input.limit, 50);

  const collected =
    source.type === "fixture"
      ? collectFixtureProducts({ niche: input.niche, limit })
      : await collectWebScraperCatalogProducts({
          source,
          niche: input.niche,
          searchQuery: input.searchQuery,
          limit,
          headless: config.browserHeadless,
          timeoutMs: config.browserTimeoutMs,
          maxPages: config.browserMaxPagesPerRun,
          signal: input.signal,
        });
  const nicheMatchedProducts = filterProductsByNiche(collected.products, input.niche);
  const filteredProducts = filterProductsByPrice(
    nicheMatchedProducts,
    input.minimumPrice,
    input.maximumPrice,
  ).slice(0, limit);

  return CollectionResultSchema.parse({
    products: filteredProducts,
    metadata: {
      sourceId: source.id,
      sourceName: source.name,
      mode: input.mode,
      extractedCount: collected.extractedCount,
      returnedCount: filteredProducts.length,
      duplicateCount: collected.duplicateCount,
      filteredCount: Math.max(0, collected.products.length - filteredProducts.length),
      durationMs: Date.now() - startedAt,
      collectedAt: new Date().toISOString(),
      recoverableErrors: [],
    },
  });
}

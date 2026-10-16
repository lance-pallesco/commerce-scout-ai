import fixtureRecords from "@/fixtures/products.skincare.json";

import type { ProductCandidate } from "./contracts";
import {
  type RawProductRecord,
  deduplicateProducts,
  normalizeProduct,
} from "./normalize";

const FIXTURE_SOURCE_ID = "fixture-skincare-catalog";
const FIXTURE_FALLBACK_URL = "https://fixtures.commercescout.local/catalog/skincare";

export function collectFixtureProducts(options: {
  niche: string;
  limit: number;
}): {
  products: ProductCandidate[];
  extractedCount: number;
  duplicateCount: number;
} {
  const niche = options.niche.trim().toLowerCase();
  const normalized = (fixtureRecords as RawProductRecord[])
    .filter((record) => record.category?.toLowerCase() === niche)
    .map((record) =>
      normalizeProduct(record, FIXTURE_SOURCE_ID, FIXTURE_FALLBACK_URL),
    )
    .filter((record): record is ProductCandidate => record !== null);
  const deduplicated = deduplicateProducts(normalized);

  return {
    products: deduplicated.products.slice(0, options.limit),
    extractedCount: normalized.length,
    duplicateCount: deduplicated.duplicateCount,
  };
}

export function getFixtureProductDetails(productId: string): ProductCandidate | null {
  const record = (fixtureRecords as RawProductRecord[]).find(
    (candidate) => `${FIXTURE_SOURCE_ID}:${candidate.externalId}` === productId,
  );
  return record
    ? normalizeProduct(record, FIXTURE_SOURCE_ID, FIXTURE_FALLBACK_URL)
    : null;
}

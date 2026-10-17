import { describe, expect, it } from "vitest";

import { collectFixtureProducts } from "@/lib/research/fixture-source";
import {
  deduplicateProducts,
  filterProductsByNiche,
  filterProductsByPrice,
  normalizeProduct,
  parseObservedPrice,
} from "@/lib/research/normalize";

describe("product normalization", () => {
  it("parses supported observed-price formats", () => {
    expect(parseObservedPrice("$24.50")).toBe(24.5);
    expect(parseObservedPrice("USD 1,200.00")).toBe(1200);
    expect(parseObservedPrice("not disclosed")).toBeNull();
  });

  it("records unavailable fields instead of fabricating them", () => {
    const product = normalizeProduct(
      {
        name: "Incomplete product",
        sourceUrl: "https://fixtures.commercescout.local/products/incomplete",
      },
      "fixture-skincare-catalog",
      "https://fixtures.commercescout.local/catalog/skincare",
    );

    expect(product?.missingFields).toEqual(
      expect.arrayContaining(["price", "description", "category", "imageUrl"]),
    );
  });

  it("deduplicates fixture products and filters only observed prices", () => {
    const fixture = collectFixtureProducts({ niche: "skincare", limit: 10 });
    expect(fixture.duplicateCount).toBe(1);

    const filtered = filterProductsByPrice(fixture.products, 15, 30);
    expect(filtered.map((product) => product.name)).toEqual([
      "Niacinamide 10% Barrier Serum",
      "Gentle Oat Cream Cleanser",
    ]);
    expect(deduplicateProducts(filtered).duplicateCount).toBe(0);
  });

  it("rejects candidates whose observed text does not match the requested niche", () => {
    const products = collectFixtureProducts({ niche: "skincare", limit: 10 }).products;
    expect(filterProductsByNiche(products, "skincare serum").map((product) => product.name)).toEqual([
      "Niacinamide 10% Barrier Serum",
    ]);
    expect(filterProductsByNiche(products, "wireless earbuds")).toEqual([]);
  });
});

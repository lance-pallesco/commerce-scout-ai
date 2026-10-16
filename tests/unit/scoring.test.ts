import { describe, expect, it } from "vitest";

import { collectFixtureProducts } from "@/lib/research/fixture-source";
import { evaluateProducts, rankProductEvaluations, scoreProduct } from "@/lib/scoring/score-product";

const criteria = { niche: "skincare", minimumPrice: 15, maximumPrice: 60 };

describe("evidence-based scoring", () => {
  it("awards transparent points only for observed product fields", () => {
    const [product] = collectFixtureProducts({ niche: "skincare", limit: 5 }).products;
    const evaluation = scoreProduct(product, criteria);

    expect(evaluation.score).toEqual({
      priceFit: 25,
      evidenceQuality: 30,
      nicheRelevance: 20,
      informationCompleteness: 25,
      total: 100,
    });
  });

  it("reduces evidence score when source fields are missing", () => {
    const sparse = {
      ...collectFixtureProducts({ niche: "skincare", limit: 5 }).products[0],
      description: null,
      imageUrl: null,
      missingFields: ["description", "imageUrl"],
    };
    const evaluation = scoreProduct(sparse, criteria);

    expect(evaluation.score.evidenceQuality).toBeLessThan(30);
    expect(evaluation.evidenceQuality).toBe("medium");
    expect(evaluation.concerns.join(" ")).toContain("Missing source fields");
  });

  it("uses a stable product-id tiebreaker", () => {
    const first = {
      productId: "source:b",
      score: { priceFit: 20, evidenceQuality: 20, nicheRelevance: 20, informationCompleteness: 20, total: 80 },
      evidenceQuality: "high" as const,
      observedStrengths: [],
      concerns: [],
      missingInformation: [],
    };
    const second = { ...first, productId: "source:a" };

    expect(rankProductEvaluations([first, second]).map((item) => item.productId)).toEqual([
      "source:a",
      "source:b",
    ]);
  });

  it("does not award price or niche fit to an unrelated out-of-range product", () => {
    const product = {
      ...collectFixtureProducts({ niche: "skincare", limit: 5 }).products[0],
      name: "Gaming laptop",
      category: "electronics",
      price: 1_299,
    };
    const evaluation = scoreProduct(product, criteria);

    expect(evaluation.score.priceFit).toBe(0);
    expect(evaluation.score.nicheRelevance).toBe(0);
    expect(evaluation.score.total).toBeLessThan(75);
  });

  it("attaches model findings without allowing them to change the score", () => {
    const products = collectFixtureProducts({ niche: "skincare", limit: 5 }).products;
    const evaluations = evaluateProducts(products, criteria, {
      completion: "completed",
      executiveSummary: "Fixture run.",
      limitations: ["Synthetic data."],
      findings: [
        {
          productId: products[0].id,
          summary: "An unverified interpretation.",
          customerAppeal: "An inference, not a market result.",
          differentiationConsiderations: [],
          risks: [],
          missingInformation: [],
          confidence: "low",
        },
      ],
    });

    expect(evaluations.find((item) => item.productId === products[0].id)?.agentFinding).toBeDefined();
    expect(evaluations[0].score.total).toBe(100);
  });
});

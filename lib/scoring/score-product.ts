import { z } from "zod";

import type { AgentProductFinding, AgentResearchReport } from "@/lib/agent/contracts";
import type { ProductCandidate, ResearchRequest } from "@/lib/research/contracts";

export const ScoreBreakdownSchema = z.object({
  priceFit: z.number().int().min(0).max(25),
  evidenceQuality: z.number().int().min(0).max(30),
  nicheRelevance: z.number().int().min(0).max(20),
  informationCompleteness: z.number().int().min(0).max(25),
  total: z.number().int().min(0).max(100),
});

export const ProductEvaluationSchema = z.object({
  productId: z.string().min(1),
  score: ScoreBreakdownSchema,
  evidenceQuality: z.enum(["high", "medium", "low"]),
  observedStrengths: z.array(z.string().min(1)).max(10),
  concerns: z.array(z.string().min(1)).max(15),
  missingInformation: z.array(z.string().min(1)).max(20),
  agentFinding: z
    .object({
      summary: z.string(),
      customerAppeal: z.string(),
      differentiationConsiderations: z.array(z.string()),
      risks: z.array(z.string()),
      confidence: z.enum(["high", "medium", "low"]),
    })
    .optional(),
});

export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;
export type ProductEvaluation = z.infer<typeof ProductEvaluationSchema>;

function countAvailableEvidence(product: ProductCandidate): number {
  return [
    product.name,
    product.description,
    product.category,
    product.price,
    product.imageUrl,
  ].filter((value) => value !== null && value !== undefined && value !== "").length;
}

function buildAgentFinding(finding: AgentProductFinding | undefined) {
  if (!finding) return undefined;
  return {
    summary: finding.summary,
    customerAppeal: finding.customerAppeal,
    differentiationConsiderations: finding.differentiationConsiderations,
    risks: finding.risks,
    confidence: finding.confidence,
  };
}

export function scoreProduct(
  product: ProductCandidate,
  request: Pick<ResearchRequest, "niche" | "minimumPrice" | "maximumPrice">,
): Omit<ProductEvaluation, "agentFinding"> {
  const observedStrengths: string[] = [];
  const concerns: string[] = [];
  const priceFit =
    product.price !== null &&
    product.price >= request.minimumPrice &&
    product.price <= request.maximumPrice
      ? 25
      : 0;
  if (priceFit === 25) {
    observedStrengths.push("Observed price is within the selected research range.");
  } else {
    concerns.push("Observed price is unavailable or outside the selected range.");
  }

  const evidenceCount = countAvailableEvidence(product);
  const evidenceQuality = Math.round((evidenceCount / 5) * 30);
  if (evidenceCount >= 4) {
    observedStrengths.push("Most core catalog fields are available as source evidence.");
  } else {
    concerns.push("Core catalog evidence is incomplete.");
  }

  const nicheRelevance =
    product.category?.toLowerCase() === request.niche.toLowerCase()
      ? 20
      : product.category
        ? 8
        : 0;
  if (nicheRelevance === 20) {
    observedStrengths.push("The source categorizes this record in the selected niche.");
  } else if (nicheRelevance === 8) {
    concerns.push("The source category differs from the selected niche.");
  } else {
    concerns.push("The source does not provide a category for niche matching.");
  }

  const informationCompleteness = Math.round((evidenceCount / 5) * 25);
  if (product.missingFields.length > 0) {
    concerns.push(`Missing source fields: ${product.missingFields.join(", ")}.`);
  }
  const total = priceFit + evidenceQuality + nicheRelevance + informationCompleteness;
  const evidenceLevel =
    evidenceCount === 5 ? "high" : evidenceCount >= 3 ? "medium" : "low";

  return ProductEvaluationSchema.parse({
    productId: product.id,
    score: { priceFit, evidenceQuality, nicheRelevance, informationCompleteness, total },
    evidenceQuality: evidenceLevel,
    observedStrengths,
    concerns,
    missingInformation: product.missingFields,
  });
}

export function rankProductEvaluations(
  evaluations: readonly ProductEvaluation[],
): ProductEvaluation[] {
  return [...evaluations].sort(
    (left, right) =>
      right.score.total - left.score.total || left.productId.localeCompare(right.productId),
  );
}

export function evaluateProducts(
  products: readonly ProductCandidate[],
  request: Pick<ResearchRequest, "niche" | "minimumPrice" | "maximumPrice">,
  report?: AgentResearchReport,
): ProductEvaluation[] {
  const findingsByProductId = new Map(report?.findings.map((finding) => [finding.productId, finding]));
  const knownProductIds = new Set(products.map((product) => product.id));
  if (report?.findings.some((finding) => !knownProductIds.has(finding.productId))) {
    throw new Error("Agent findings must reference a collected product.");
  }

  return rankProductEvaluations(
    products.map((product) => {
      const deterministicEvaluation = scoreProduct(product, request);
      const agentFinding = buildAgentFinding(findingsByProductId.get(product.id));
      return ProductEvaluationSchema.parse({ ...deterministicEvaluation, agentFinding });
    }),
  );
}

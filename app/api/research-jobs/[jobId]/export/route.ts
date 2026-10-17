import { apiError, apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { getResearchJob, getResearchProducts } from "@/lib/jobs/repository";
import { isRankableProductCandidate } from "@/lib/research/contracts";

function csvCell(value: string | number | null): string {
  const content = value === null ? "" : String(value);
  return `"${content.replaceAll('"', '""')}"`;
}

export async function GET(
  _request: Request,
  context: RouteContext<"/api/research-jobs/[jobId]/export">,
) {
  try {
    const { jobId } = await context.params;
    const config = getServerConfig();
    const job = await getResearchJob(config, jobId);
    if (!job) return apiError("JOB_NOT_FOUND", "The requested research job was not found.", 404);
    const products = (await getResearchProducts(config, jobId)).filter(
      ({ product, evaluation }) =>
        isRankableProductCandidate(product) &&
        evaluation?.evidenceScope !== "search_discovery" &&
        evaluation?.evidenceScope !== "verification_required",
    );
    const header = ["rank", "name", "variant", "source", "source_url", "price", "list_price", "price_kind", "currency", "price_observation_method", "price_observed_at", "score", "evidence_quality", "evidence_scope", "missing_information"];
    const rows = products.map(({ product, evaluation }, index) =>
      [
        index + 1,
        product.name,
        product.variant,
        product.sourceId,
        product.sourceUrl,
        product.price,
        product.listPrice,
        product.priceKind,
        product.currency,
        product.priceObservation?.method ?? null,
        product.priceObservation?.observedAt ?? null,
        evaluation?.score.total ?? null,
        evaluation?.evidenceQuality ?? null,
        evaluation?.evidenceScope ?? product.evidenceStatus,
        (evaluation?.missingInformation ?? product.missingFields).join("; "),
      ]
        .map(csvCell)
        .join(","),
    );
    return new Response([header.join(","), ...rows].join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="commerce-scout-${jobId}.csv"`,
      },
    });
  } catch (error) {
    return apiException(error);
  }
}

import { apiError, apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { getResearchJob, getResearchProducts } from "@/lib/jobs/repository";

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
    const products = await getResearchProducts(config, jobId);
    const header = ["rank", "name", "source", "source_url", "price", "currency", "score", "evidence_quality", "missing_information"];
    const rows = products.map(({ product, evaluation }, index) =>
      [
        index + 1,
        product.name,
        product.sourceId,
        product.sourceUrl,
        product.price,
        product.currency,
        evaluation?.score.total ?? null,
        evaluation?.evidenceQuality ?? null,
        product.missingFields.join("; "),
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

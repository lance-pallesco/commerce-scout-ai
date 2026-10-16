import { NextResponse } from "next/server";

import { apiError, apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import {
  getResearchJob,
  getResearchProducts,
  getResearchReport,
} from "@/lib/jobs/repository";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/research-jobs/[jobId]/report">,
) {
  try {
    const { jobId } = await context.params;
    const config = getServerConfig();
    const job = await getResearchJob(config, jobId);
    if (!job) return apiError("JOB_NOT_FOUND", "The requested research job was not found.", 404);
    const report = await getResearchReport(config, jobId);
    if (!report) return apiError("REPORT_NOT_READY", "The research report is not ready.", 409);
    const products = await getResearchProducts(config, jobId);
    return NextResponse.json({ job, report, products });
  } catch (error) {
    return apiException(error);
  }
}

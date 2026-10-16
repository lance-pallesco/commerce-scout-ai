import { NextResponse } from "next/server";

import { apiError, apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { getResearchJob } from "@/lib/jobs/repository";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/research-jobs/[jobId]">,
) {
  try {
    const { jobId } = await context.params;
    const job = await getResearchJob(getServerConfig(), jobId);
    if (!job) return apiError("JOB_NOT_FOUND", "The requested research job was not found.", 404);
    return NextResponse.json({ job });
  } catch (error) {
    return apiException(error);
  }
}

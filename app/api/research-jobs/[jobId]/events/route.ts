import { NextResponse } from "next/server";

import { apiError, apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { getJobEvents, getResearchJob } from "@/lib/jobs/repository";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/research-jobs/[jobId]/events">,
) {
  try {
    const { jobId } = await context.params;
    const config = getServerConfig();
    if (!(await getResearchJob(config, jobId))) {
      return apiError("JOB_NOT_FOUND", "The requested research job was not found.", 404);
    }
    return NextResponse.json({ events: await getJobEvents(config, jobId) });
  } catch (error) {
    return apiException(error);
  }
}

import { NextResponse } from "next/server";

import { apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { requestResearchJobCancellation } from "@/lib/jobs/repository";

export async function POST(
  _request: Request,
  context: RouteContext<"/api/research-jobs/[jobId]/cancel">,
) {
  try {
    const { jobId } = await context.params;
    const job = await requestResearchJobCancellation(getServerConfig(), jobId);
    return NextResponse.json({ job });
  } catch (error) {
    return apiException(error);
  }
}

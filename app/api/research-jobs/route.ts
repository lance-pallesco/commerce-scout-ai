import { NextResponse } from "next/server";
import { z } from "zod";

import { apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { createResearchJob, listResearchJobs } from "@/lib/jobs/repository";
import { ResearchRequestSchema } from "@/lib/research/contracts";

const SubmissionSchema = z.object({
  niche: z.string().trim().min(2).max(80),
  minimumPrice: z.number().finite().nonnegative().max(100_000),
  maximumPrice: z.number().finite().positive().max(100_000),
  currency: z.enum(["USD"]).optional(),
  requestedProductCount: z.number().int().min(1).max(50),
  sourceIds: z.array(z.string().min(1).max(80)).min(1).max(4),
  objective: z.string().trim().min(10).max(1_000),
  mode: z.enum(["fixtures", "live"]).optional(),
});

export async function GET() {
  try {
    const config = getServerConfig();
    const jobs = await listResearchJobs(config);
    return NextResponse.json({ jobs });
  } catch (error) {
    return apiException(error);
  }
}

export async function POST(request: Request) {
  try {
    const config = getServerConfig();
    const submission = SubmissionSchema.parse(await request.json());
    const researchRequest = ResearchRequestSchema.parse({
      ...submission,
      mode: submission.mode ?? config.researchMode,
    });
    const job = await createResearchJob(researchRequest, config);
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return apiException(error);
  }
}

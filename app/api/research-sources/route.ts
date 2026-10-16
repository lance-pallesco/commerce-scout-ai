import { NextResponse } from "next/server";

import { apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import { listResearchSources } from "@/lib/research/source-registry";

export async function GET(request: Request) {
  try {
    const config = getServerConfig();
    const niche = new URL(request.url).searchParams.get("niche") ?? undefined;
    const sources = listResearchSources(niche).filter((source) =>
      source.supportedModes.includes(config.researchMode),
    );
    return NextResponse.json({
      mode: config.researchMode,
      liveAgentAvailable: config.researchMode === "fixtures" || Boolean(config.anthropicApiKey),
      sources,
    });
  } catch (error) {
    return apiException(error);
  }
}

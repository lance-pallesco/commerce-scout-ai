import { NextResponse } from "next/server";

import { apiException } from "@/lib/api/response";
import { getServerConfig } from "@/lib/config/env";
import {
  listCompatibleResearchSources,
  listResearchSources,
} from "@/lib/research/source-registry";

export async function GET(request: Request) {
  try {
    const config = getServerConfig();
    const niche = new URL(request.url).searchParams.get("niche") ?? undefined;
    const sources = listCompatibleResearchSources(niche ?? "", config.researchMode);
    const supportedNiches = [
      ...new Set(
        listResearchSources()
          .filter(
            (source) =>
              source.availability === "available" &&
              source.supportedModes.includes(config.researchMode),
          )
          .flatMap((source) => source.supportedCategories),
      ),
    ];
    const liveAgentAvailable =
      config.researchMode === "live" && Boolean(config.anthropicApiKey);
    return NextResponse.json({
      mode: config.researchMode,
      runtime: config.researchMode === "fixtures"
        ? "deterministic_fixture"
        : liveAgentAvailable
          ? "claude_agent"
          : "live_agent_blocked",
      liveAgentAvailable,
      sources,
      supportedNiches,
    });
  } catch (error) {
    return apiException(error);
  }
}

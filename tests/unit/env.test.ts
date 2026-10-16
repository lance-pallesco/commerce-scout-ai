import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  assertLiveResearchAvailable,
  getServerConfig,
} from "@/lib/config/env";

describe("server configuration", () => {
  it("parses bounded numeric settings into numbers", () => {
    const config = getServerConfig({
      RESEARCH_MODE: "fixtures",
      AGENT_MAX_TURNS: "6",
      BROWSER_HEADLESS: "false",
    });

    expect(config.agentMaxTurns).toBe(6);
    expect(config.browserHeadless).toBe(false);
    expect(config.agentTimeoutMs).toBe(120_000);
  });

  it("rejects out-of-range settings without exposing a secret", () => {
    expect(() =>
      getServerConfig({
        ANTHROPIC_API_KEY: "secret-value",
        AGENT_MAX_TURNS: "100",
      }),
    ).toThrow(ConfigurationError);
  });

  it("requires a key only for live research", () => {
    const config = getServerConfig({ RESEARCH_MODE: "live" });
    expect(() => assertLiveResearchAvailable(config)).toThrow(
      "ANTHROPIC_API_KEY is required",
    );
  });
});

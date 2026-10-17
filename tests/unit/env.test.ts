import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  assertLiveResearchAvailable,
  createAgentSdkEnvironment,
  getServerConfig,
  routedAgentModel,
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

  it("selects OpenRouter explicitly and requires its own server-only credential", () => {
    const config = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-test-key",
    });

    expect(config.aiProvider).toBe("openrouter");
    expect(config.openRouterApiKey).toBe("openrouter-test-key");
    expect(config.openRouterModel).toBe("~anthropic/claude-sonnet-latest");
    expect(routedAgentModel(config)).toBe("~anthropic/claude-sonnet-latest");
    expect(() => assertLiveResearchAvailable(config)).not.toThrow();

    const missingCredential = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      ANTHROPIC_API_KEY: "anthropic-key-must-not-fallback",
    });
    expect(() => assertLiveResearchAvailable(missingCredential)).toThrow(
      "OPENROUTER_API_KEY is required",
    );
  });

  it("routes only the selected provider into the Agent SDK child environment", () => {
    const openRouterConfig = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "openrouter-test-key",
    });
    const openRouterEnvironment = createAgentSdkEnvironment(openRouterConfig, {
      ANTHROPIC_API_KEY: "must-not-reach-openrouter",
      ANTHROPIC_AUTH_TOKEN: "inherited-token",
      ANTHROPIC_BASE_URL: "https://unexpected.example",
      OPENROUTER_API_KEY: "must-not-reach-sdk-child",
    });

    expect(openRouterEnvironment).toMatchObject({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "openrouter-test-key",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "~anthropic/claude-sonnet-latest",
    });
    expect(openRouterEnvironment.OPENROUTER_API_KEY).toBeUndefined();

    const anthropicConfig = getServerConfig({
      RESEARCH_MODE: "live",
      AI_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "anthropic-test-key",
    });
    const anthropicEnvironment = createAgentSdkEnvironment(anthropicConfig, {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "openrouter-token",
      OPENROUTER_API_KEY: "openrouter-key",
    });

    expect(anthropicEnvironment.ANTHROPIC_API_KEY).toBe("anthropic-test-key");
    expect(anthropicEnvironment.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(anthropicEnvironment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(anthropicEnvironment.OPENROUTER_API_KEY).toBeUndefined();
  });
});

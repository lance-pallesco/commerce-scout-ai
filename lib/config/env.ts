import { z } from "zod";

const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

const positiveInteger = (minimum: number, maximum: number, fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

const positiveNumber = (minimum: number, maximum: number, fallback: number) =>
  z.preprocess(
    blankToUndefined,
    z.coerce.number().min(minimum).max(maximum).default(fallback),
  );

const booleanSetting = (fallback: boolean) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") return value;
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
      return value;
    },
    z.boolean().default(fallback),
  );

export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";

const openRouterModel = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[~a-zA-Z0-9._:/\-[\]]+$/);

const ServerConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  AI_PROVIDER: z.preprocess(
    blankToUndefined,
    z.enum(["anthropic", "openrouter"]).default("anthropic"),
  ),
  OPENROUTER_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
  OPENROUTER_MODEL: z.preprocess(
    blankToUndefined,
    openRouterModel.default("~anthropic/claude-sonnet-latest"),
  ),
  RESEARCH_MODE: z.preprocess(
    blankToUndefined,
    z.enum(["fixtures", "live"]).default("fixtures"),
  ),
  AGENT_MODEL: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/).default("sonnet"),
  ),
  AGENT_MAX_TURNS: positiveInteger(1, 20, 8),
  AGENT_MAX_BUDGET_USD: positiveNumber(0.01, 25, 0.5),
  AGENT_TIMEOUT_MS: positiveInteger(1_000, 600_000, 120_000),
  AGENT_DUPLICATE_ACTION_LIMIT: positiveInteger(1, 5, 2),
  AGENT_NO_PROGRESS_ACTION_LIMIT: positiveInteger(1, 10, 3),
  WEB_SEARCH_MAX_USES: positiveInteger(1, 2, 2),
  WEB_SEARCH_MAX_RESULTS: positiveInteger(1, 20, 10),
  WEB_SEARCH_MAX_TOKENS: positiveInteger(256, 4_096, 1_200),
  WEB_SEARCH_TIMEOUT_MS: positiveInteger(1_000, 120_000, 30_000),
  MAX_CONCURRENT_RESEARCH_JOBS: positiveInteger(1, 4, 1),
  BROWSER_HEADLESS: booleanSetting(true),
  BROWSER_TIMEOUT_MS: positiveInteger(1_000, 120_000, 15_000),
  BROWSER_MAX_PAGES_PER_RUN: positiveInteger(1, 50, 10),
  DATABASE_URL: z.preprocess(
    blankToUndefined,
    z.string().startsWith("file:").default("file:./data/commerce-scout.db"),
  ),
  NEXT_PUBLIC_APP_NAME: z.preprocess(
    blankToUndefined,
    z.string().trim().min(1).max(80).default("CommerceScout AI"),
  ),
});

export type ResearchMode = z.infer<typeof ServerConfigSchema>["RESEARCH_MODE"];
export type AiProvider = z.infer<typeof ServerConfigSchema>["AI_PROVIDER"];
export type ServerConfig = Readonly<{
  anthropicApiKey?: string;
  aiProvider: AiProvider;
  openRouterApiKey?: string;
  openRouterModel: string;
  researchMode: ResearchMode;
  agentModel: string;
  agentMaxTurns: number;
  agentMaxBudgetUsd: number;
  agentTimeoutMs: number;
  agentDuplicateActionLimit: number;
  agentNoProgressActionLimit: number;
  webSearchMaxUses: number;
  webSearchMaxResults: number;
  webSearchMaxTokens: number;
  webSearchTimeoutMs: number;
  maxConcurrentResearchJobs: number;
  browserHeadless: boolean;
  browserTimeoutMs: number;
  browserMaxPagesPerRun: number;
  databaseUrl: string;
  appName: string;
}>;

export class ConfigurationError extends Error {
  readonly code = "INVALID_CONFIGURATION";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function hasLiveProviderCredential(config: ServerConfig): boolean {
  return config.aiProvider === "openrouter"
    ? Boolean(config.openRouterApiKey)
    : Boolean(config.anthropicApiKey);
}

export function routedAgentModel(config: ServerConfig): string {
  return config.aiProvider === "openrouter" ? config.openRouterModel : config.agentModel;
}

export function getServerConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ServerConfig {
  const parsed = ServerConfigSchema.safeParse(environment);

  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join("."))
      .filter(Boolean)
      .join(", ");
    throw new ConfigurationError(`Invalid environment configuration: ${fields}.`);
  }

  const config = parsed.data;
  return Object.freeze({
    anthropicApiKey: config.ANTHROPIC_API_KEY,
    aiProvider: config.AI_PROVIDER,
    openRouterApiKey: config.OPENROUTER_API_KEY,
    openRouterModel: config.OPENROUTER_MODEL,
    researchMode: config.RESEARCH_MODE,
    agentModel: config.AGENT_MODEL,
    agentMaxTurns: config.AGENT_MAX_TURNS,
    agentMaxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
    agentTimeoutMs: config.AGENT_TIMEOUT_MS,
    agentDuplicateActionLimit: config.AGENT_DUPLICATE_ACTION_LIMIT,
    agentNoProgressActionLimit: config.AGENT_NO_PROGRESS_ACTION_LIMIT,
    webSearchMaxUses: config.WEB_SEARCH_MAX_USES,
    webSearchMaxResults: config.WEB_SEARCH_MAX_RESULTS,
    webSearchMaxTokens: config.WEB_SEARCH_MAX_TOKENS,
    webSearchTimeoutMs: config.WEB_SEARCH_TIMEOUT_MS,
    maxConcurrentResearchJobs: config.MAX_CONCURRENT_RESEARCH_JOBS,
    browserHeadless: config.BROWSER_HEADLESS,
    browserTimeoutMs: config.BROWSER_TIMEOUT_MS,
    browserMaxPagesPerRun: config.BROWSER_MAX_PAGES_PER_RUN,
    databaseUrl: config.DATABASE_URL,
    appName: config.NEXT_PUBLIC_APP_NAME,
  });
}

export function assertLiveResearchAvailable(config: ServerConfig): void {
  if (config.researchMode !== "live") return;

  if (config.aiProvider === "openrouter") {
    if (!hasLiveProviderCredential(config)) {
      throw new ConfigurationError(
        "OPENROUTER_API_KEY is required when RESEARCH_MODE is live and AI_PROVIDER is openrouter.",
      );
    }
    return;
  }

  if (!hasLiveProviderCredential(config)) {
    throw new ConfigurationError(
      "ANTHROPIC_API_KEY is required when RESEARCH_MODE is live.",
    );
  }
}

const CLAUDE_MODEL_ENVIRONMENT_KEYS = [
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const;

/**
 * Creates the complete child-process environment for the Agent SDK runtime.
 * The explicit provider branch prevents an inherited credential or gateway URL
 * from silently changing billing providers.
 */
export function createAgentSdkEnvironment(
  config: ServerConfig,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...inheritedEnvironment };
  delete environment.OPENROUTER_API_KEY;

  if (config.aiProvider === "openrouter") {
    environment.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_BASE_URL;
    environment.ANTHROPIC_AUTH_TOKEN = config.openRouterApiKey;
    // Claude Code treats this as a direct-Anthropic credential. It must be
    // blank so a selected OpenRouter run cannot fall back to Anthropic billing.
    environment.ANTHROPIC_API_KEY = "";
    for (const key of CLAUDE_MODEL_ENVIRONMENT_KEYS) {
      environment[key] = config.openRouterModel;
    }
    return environment;
  }

  delete environment.ANTHROPIC_BASE_URL;
  delete environment.ANTHROPIC_AUTH_TOKEN;
  for (const key of CLAUDE_MODEL_ENVIRONMENT_KEYS) {
    delete environment[key];
  }
  environment.ANTHROPIC_API_KEY = config.anthropicApiKey;
  return environment;
}

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

const ServerConfigSchema = z.object({
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().min(1).optional()),
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
  AGENT_MAX_RETRIES: positiveInteger(0, 5, 2),
  AGENT_DUPLICATE_ACTION_LIMIT: positiveInteger(1, 5, 2),
  AGENT_NO_PROGRESS_ACTION_LIMIT: positiveInteger(1, 10, 3),
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
export type ServerConfig = Readonly<{
  anthropicApiKey?: string;
  researchMode: ResearchMode;
  agentModel: string;
  agentMaxTurns: number;
  agentMaxBudgetUsd: number;
  agentTimeoutMs: number;
  agentMaxRetries: number;
  agentDuplicateActionLimit: number;
  agentNoProgressActionLimit: number;
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
    researchMode: config.RESEARCH_MODE,
    agentModel: config.AGENT_MODEL,
    agentMaxTurns: config.AGENT_MAX_TURNS,
    agentMaxBudgetUsd: config.AGENT_MAX_BUDGET_USD,
    agentTimeoutMs: config.AGENT_TIMEOUT_MS,
    agentMaxRetries: config.AGENT_MAX_RETRIES,
    agentDuplicateActionLimit: config.AGENT_DUPLICATE_ACTION_LIMIT,
    agentNoProgressActionLimit: config.AGENT_NO_PROGRESS_ACTION_LIMIT,
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

  if (!config.anthropicApiKey) {
    throw new ConfigurationError(
      "ANTHROPIC_API_KEY is required when RESEARCH_MODE is live.",
    );
  }
}

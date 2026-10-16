import {
  SourceDescriptorSchema,
  type ResearchMode,
  type SourceDescriptor,
} from "./contracts";

const sources = [
  {
    id: "fixture-skincare-catalog",
    name: "CommerceScout synthetic skincare catalog",
    type: "fixture",
    supportedCategories: ["skincare", "beauty"],
    availability: "available",
    supportedModes: ["fixtures"],
    allowedCapabilities: ["list", "collect", "details"],
    allowedHosts: [],
    sourceNotice:
      "Synthetic local data for deterministic development. It contains no live demand, advertising, or sales claims.",
  },
  {
    id: "webscraper-ecommerce-demo",
    name: "Web Scraper e-commerce practice catalog",
    type: "browser",
    supportedCategories: ["electronics"],
    availability: "available",
    supportedModes: ["live"],
    allowedCapabilities: ["list", "collect", "details"],
    baseUrl: "https://webscraper.io/test-sites/e-commerce/allinone",
    allowedHosts: ["webscraper.io"],
    sourceNotice:
      "Public demonstration catalog. Its inventory is electronics and must not be represented as skincare evidence.",
  },
] as const;

export const researchSources: readonly SourceDescriptor[] = Object.freeze(
  sources.map((source) => SourceDescriptorSchema.parse(source)),
);

export class SourceRegistryError extends Error {
  readonly code:
    | "UNKNOWN_SOURCE"
    | "SOURCE_UNAVAILABLE"
    | "SOURCE_MODE_MISMATCH"
    | "SOURCE_NICHE_MISMATCH";

  constructor(
    code:
      | "UNKNOWN_SOURCE"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_MODE_MISMATCH"
      | "SOURCE_NICHE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SourceRegistryError";
    this.code = code;
  }
}

export function listResearchSources(category?: string): SourceDescriptor[] {
  const normalizedCategory = category?.trim().toLowerCase();
  return researchSources.filter(
    (source) =>
      !normalizedCategory ||
      source.supportedCategories.some(
        (supportedCategory) => supportedCategory === normalizedCategory,
      ),
  );
}

export function getResearchSource(
  sourceId: string,
  mode?: ResearchMode,
): SourceDescriptor {
  const source = researchSources.find((candidate) => candidate.id === sourceId);

  if (!source) {
    throw new SourceRegistryError("UNKNOWN_SOURCE", "The requested research source is not configured.");
  }

  if (source.availability !== "available") {
    throw new SourceRegistryError("SOURCE_UNAVAILABLE", "The requested research source is unavailable.");
  }

  if (mode && !source.supportedModes.includes(mode)) {
    throw new SourceRegistryError(
      "SOURCE_MODE_MISMATCH",
      "The requested research source is not available in this research mode.",
    );
  }

  return source;
}

export function assertSourceSupportsNiche(
  source: SourceDescriptor,
  niche: string,
): void {
  if (!source.supportedCategories.includes(niche.trim().toLowerCase())) {
    throw new SourceRegistryError(
      "SOURCE_NICHE_MISMATCH",
      "The requested source does not support the selected research niche.",
    );
  }
}

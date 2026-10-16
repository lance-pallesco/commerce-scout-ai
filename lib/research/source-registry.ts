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
    id: "anthropic-web-discovery",
    name: "Anthropic Web Search product discovery",
    type: "web-search",
    supportedCategories: ["general-products"],
    availability: "available",
    supportedModes: ["live"],
    allowedCapabilities: ["list", "collect", "details"],
    searchable: true,
    collectionStrategy: "anthropic-web-search",
    allowedHosts: [],
    sourceNotice:
      "Dynamic discovery uses Anthropic's bounded Web Search server tool. Search-result URLs are untrusted until validated and are retained only as observed provenance.",
  },
  {
    id: "webscraper-ecommerce-demo",
    name: "Web Scraper e-commerce practice catalog",
    type: "browser",
    supportedCategories: ["electronics"],
    nicheKeywords: ["electronics", "earbuds", "headphones", "phone", "laptop", "computer", "gadget"],
    canonicalCategory: "electronics",
    availability: "available",
    supportedModes: ["live"],
    allowedCapabilities: ["list", "collect", "details"],
    baseUrl: "https://webscraper.io/test-sites/e-commerce/allinone",
    allowedHosts: ["webscraper.io"],
    sourceNotice:
      "Public demonstration catalog. Its inventory is electronics and must not be represented as skincare evidence.",
  },
  {
    id: "target-public-skincare",
    name: "Target public product search",
    type: "browser",
    supportedCategories: ["skincare", "beauty"],
    nicheKeywords: ["skin", "skincare", "serum", "moisturizer", "cleanser", "sunscreen", "facial", "beauty", "makeup", "cosmetic", "cosmetics"],
    canonicalCategory: "skincare",
    availability: "available",
    supportedModes: ["live"],
    allowedCapabilities: ["list", "collect", "details"],
    searchable: true,
    collectionStrategy: "structured-search",
    baseUrl: "https://www.target.com/s?searchTerm=skincare",
    searchUrlTemplate: "https://www.target.com/s?searchTerm={query}",
    allowedHosts: ["www.target.com", "target.com"],
    sourceNotice:
      "Public Target search pages can discover multiple product categories and are used only for product name, price, and provenance evidence. Availability and pricing can change.",
  },
  {
    id: "ikea-public-search",
    name: "IKEA public home catalog",
    type: "browser",
    supportedCategories: ["home", "home-living", "storage", "furniture"],
    nicheKeywords: ["home", "living", "storage", "furniture", "decor", "kitchen", "office"],
    canonicalCategory: "home",
    availability: "available",
    supportedModes: ["live"],
    allowedCapabilities: ["list", "collect", "details"],
    searchable: true,
    collectionStrategy: "structured-search",
    baseUrl: "https://www.ikea.com/us/en/search/?q=storage",
    searchUrlTemplate: "https://www.ikea.com/us/en/search/?q={query}",
    allowedHosts: ["www.ikea.com", "ikea.com"],
    sourceNotice:
      "Public IKEA search pages can discover multiple home-related product categories and are used only for product name, price, and provenance evidence. Availability and pricing can change.",
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
    | "SOURCE_NICHE_MISMATCH"
    | "NO_COMPATIBLE_SOURCE"
    | "SOURCE_SELECTION_REQUIRED"
    | "SOURCE_SELECTION_INVALID";

  constructor(
    code:
      | "UNKNOWN_SOURCE"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_MODE_MISMATCH"
      | "SOURCE_NICHE_MISMATCH"
      | "NO_COMPATIBLE_SOURCE"
      | "SOURCE_SELECTION_REQUIRED"
      | "SOURCE_SELECTION_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SourceRegistryError";
    this.code = code;
  }
}

export function listResearchSources(category?: string): SourceDescriptor[] {
  const normalizedCategory = normalizeNiche(category);
  return researchSources.filter(
    (source) =>
      !normalizedCategory ||
      sourceSupportsNiche(source, normalizedCategory),
  );
}

function normalizeNiche(niche?: string): string {
  return niche?.trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

export function sourceSupportsNiche(source: SourceDescriptor, niche: string): boolean {
  if (source.searchable) return true;
  if (source.supportedCategories.includes(niche)) return true;
  const terms = niche.split(/[^a-z0-9]+/).filter(Boolean);
  return terms.some((term) => source.nicheKeywords.includes(term));
}

export function listCompatibleResearchSources(
  niche: string,
  mode: ResearchMode,
): SourceDescriptor[] {
  return listResearchSources(niche).filter(
    (source) =>
      source.availability === "available" && source.supportedModes.includes(mode),
  );
}

export function resolveResearchSourceIds(input: {
  niche: string;
  mode: ResearchMode;
  selection: "automatic" | "manual";
  sourceIds?: readonly string[];
}): string[] {
  const compatible = listCompatibleResearchSources(input.niche, input.mode);
  if (input.selection === "automatic") {
    if (compatible.length === 0) {
      throw new SourceRegistryError(
        "NO_COMPATIBLE_SOURCE",
        `No approved ${input.mode} research source supports the ${input.niche} niche.`,
      );
    }
    return compatible.map((source) => source.id);
  }

  if (!input.sourceIds || input.sourceIds.length !== 1) {
    throw new SourceRegistryError(
      "SOURCE_SELECTION_REQUIRED",
      "Choose one approved source for manual research selection.",
    );
  }

  const source = getResearchSource(input.sourceIds[0], input.mode);
  assertSourceSupportsNiche(source, input.niche);
  if (!compatible.some((candidate) => candidate.id === source.id)) {
    throw new SourceRegistryError(
      "SOURCE_SELECTION_INVALID",
      "The selected source is not compatible with this research niche and runtime mode.",
    );
  }
  return [source.id];
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
  if (!sourceSupportsNiche(source, normalizeNiche(niche))) {
    throw new SourceRegistryError(
      "SOURCE_NICHE_MISMATCH",
      "The requested source does not support the selected research niche.",
    );
  }
}

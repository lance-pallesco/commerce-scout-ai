import {
  ProductCandidateSchema,
  type EvidenceStatus,
  type ProductCandidate,
} from "./contracts";

export type RawProductRecord = Readonly<{
  externalId?: string | null;
  name?: string | null;
  description?: string | null;
  category?: string | null;
  price?: string | number | null;
  currency?: string | null;
  sourceUrl?: string | null;
  imageUrl?: string | null;
  collectedAt?: string;
  evidenceConfidence?: "high" | "medium" | "low";
  evidenceStatus?: EvidenceStatus;
}>;

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function toStableIdentifier(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 120);
}

export function parseObservedPrice(value: RawProductRecord["price"]): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }

  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/(?:USD|\$)?\s*(\d+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function optionalText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : null;
}

function validUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

export function normalizeProduct(
  raw: RawProductRecord,
  sourceId: string,
  fallbackSourceUrl: string,
): ProductCandidate | null {
  const name = optionalText(raw.name);
  const sourceUrl = validUrl(raw.sourceUrl) ?? validUrl(fallbackSourceUrl);
  if (!name || !sourceUrl) return null;

  const price = parseObservedPrice(raw.price);
  const description = optionalText(raw.description);
  const category = optionalText(raw.category)?.toLowerCase() ?? null;
  const imageUrl = validUrl(raw.imageUrl);
  const collectedAt = raw.collectedAt ?? new Date().toISOString();
  const evidenceConfidence = raw.evidenceConfidence ?? "high";
  const externalId =
    optionalText(raw.externalId) ?? toStableIdentifier(`${name}-${sourceUrl}`);
  const missingFields = [
    ...(price === null ? ["price"] : []),
    ...(description === null ? ["description"] : []),
    ...(category === null ? ["category"] : []),
    ...(imageUrl === null ? ["imageUrl"] : []),
  ];

  const product: ProductCandidate = {
    id: `${sourceId}:${externalId}`,
    sourceId,
    externalId,
    name,
    description,
    category,
    price,
    currency: price === null ? null : "USD",
    sourceUrl,
    imageUrl,
    evidence: [
      {
        field: "name",
        value: name,
        sourceUrl,
        observedAt: collectedAt,
        confidence: evidenceConfidence,
      },
      ...(price === null
        ? []
        : [
            {
              field: "price",
              value: `${price.toFixed(2)} USD`,
              sourceUrl,
              observedAt: collectedAt,
              confidence: evidenceConfidence,
            },
          ]),
      ...(description === null
        ? []
        : [
            {
              field: "description",
              value: description,
              sourceUrl,
              observedAt: collectedAt,
              confidence: "medium" as const,
            },
          ]),
    ],
    missingFields,
    evidenceStatus: raw.evidenceStatus ?? "source_verified",
    collectedAt,
  };

  return ProductCandidateSchema.parse(product);
}

export function deduplicateProducts(products: readonly ProductCandidate[]): {
  products: ProductCandidate[];
  duplicateCount: number;
} {
  const seen = new Set<string>();
  const unique: ProductCandidate[] = [];
  let duplicateCount = 0;

  for (const product of products) {
    const fingerprint = [
      product.sourceId,
      product.sourceUrl.toLowerCase(),
      toStableIdentifier(product.name),
      product.price ?? "unknown",
    ].join("|");

    if (seen.has(fingerprint)) {
      duplicateCount += 1;
      continue;
    }

    seen.add(fingerprint);
    unique.push(product);
  }

  return { products: unique, duplicateCount };
}

export function filterProductsByPrice(
  products: readonly ProductCandidate[],
  minimumPrice: number,
  maximumPrice: number,
): ProductCandidate[] {
  return products.filter(
    (product) =>
      product.price !== null &&
      product.price >= minimumPrice &&
      product.price <= maximumPrice,
  );
}

function nicheTerms(niche: string): string[] {
  return niche
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3);
}

export function productMatchesNiche(product: ProductCandidate, niche: string): boolean {
  const terms = nicheTerms(niche);
  if (terms.length === 0) return false;
  const searchableText = [product.name, product.description, product.category]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // A free-form discovery result has no category (and cannot satisfy an
  // unobserved request term). For every candidate, each meaningful requested
  // term must be present in observed name, description, or source category;
  // matching only a generic modifier such as "wireless" is not enough.
  return terms.every((term) => searchableText.includes(term));
}

export function filterProductsByNiche(
  products: readonly ProductCandidate[],
  niche: string,
): ProductCandidate[] {
  return products.filter((product) => productMatchesNiche(product, niche));
}

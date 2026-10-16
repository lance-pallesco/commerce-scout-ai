import { ProductCandidateSchema, type ProductCandidate } from "./contracts";

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
        confidence: "high",
      },
      ...(price === null
        ? []
        : [
            {
              field: "price",
              value: `${price.toFixed(2)} USD`,
              sourceUrl,
              observedAt: collectedAt,
              confidence: "high" as const,
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

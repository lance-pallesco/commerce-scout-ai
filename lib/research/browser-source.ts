import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import {
  type DiscoveryLead,
  ProductCandidateSchema,
  type ProductCandidate,
  type SourceDescriptor,
} from "./contracts";
import {
  type RawProductRecord,
  deduplicateProducts,
  normalizeProduct,
  productMatchesNiche,
} from "./normalize";
import {
  SourceAccessError,
  assertApprovedSourceUrl,
  assertObservedWebUrl,
  isAllowedBrowserRequest,
  type AddressResolver,
} from "./url-policy";

export class BrowserCollectionError extends Error {
  readonly code:
    | "BROWSER_LAUNCH_FAILED"
    | "BROWSER_TIMEOUT"
    | "SOURCE_EXTRACTION_FAILED"
    | "SOURCE_ACCESS_REJECTED"
    | "COLLECTION_CANCELLED";

  constructor(
    code:
      | "BROWSER_LAUNCH_FAILED"
      | "BROWSER_TIMEOUT"
      | "SOURCE_EXTRACTION_FAILED"
      | "SOURCE_ACCESS_REJECTED"
      | "COLLECTION_CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "BrowserCollectionError";
    this.code = code;
  }
}

type BrowserCollectionStage =
  | "source_validation"
  | "browser_launch"
  | "navigation"
  | "extraction";

export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

export type ProductPageVerificationCode =
  | "VERIFIED"
  | "PAGE_URL_REJECTED"
  | "PAGE_REDIRECT_REJECTED"
  | "PAGE_UNAVAILABLE"
  | "PAGE_NOT_PRODUCT_DETAIL"
  | "PAGE_IDENTITY_MISMATCH"
  | "PAGE_VARIANT_UNRESOLVED"
  | "PAGE_PRICE_NOT_OBSERVED"
  | "PAGE_PRICE_AMBIGUOUS"
  | "PAGE_CURRENCY_MISMATCH"
  | "PAGE_PRICE_OUT_OF_RANGE"
  | "PAGE_NICHE_MISMATCH"
  | "PAGE_TIMEOUT"
  | "PAGE_FETCH_FAILED"
  | "PAGE_VERIFICATION_LIMIT"
  | "PAGE_CANCELLED";

export type ProductPageVerification = Readonly<{
  lead: DiscoveryLead;
  verifiedProduct?: ProductCandidate;
  code: ProductPageVerificationCode;
}>;

export type ProductPageStructuredEvidence = Readonly<{
  source: "json_ld" | "meta" | "microdata";
  name?: string;
  sku?: string;
  variant?: string;
  price?: number;
  listPrice?: number;
  priceKind?: "current" | "sale" | "regular";
  currency?: string;
  availability?: string;
}>;

export type ProductPageStructure = Readonly<{
  products: ProductPageStructuredEvidence[];
  pageTypes: string[];
}>;

export type ProductPageVerificationEvidence = Readonly<{
  finalUrl: string;
  httpStatus: number | null;
  title: string;
  bodyText: string;
  structuredProducts?: readonly ProductPageStructuredEvidence[];
  pageTypes?: readonly string[];
  verifiedAt?: string;
}>;

export type ProductPageVerificationResult = Readonly<{
  queuedLeadCount: number;
  attemptedLeadCount: number;
  verifiedProducts: ProductCandidate[];
  rejected: ProductPageVerification[];
}>;

type PlaywrightBrowserType = Pick<typeof chromium, "launch">;

export function createDefaultBrowserLauncher(
  browserType: PlaywrightBrowserType = chromium,
): BrowserLauncher {
  return (options) => browserType.launch(options);
}

type BrowserCollectionOptions = Readonly<{
  source: SourceDescriptor;
  niche?: string;
  searchQuery?: string;
  limit: number;
  headless: boolean;
  timeoutMs: number;
  maxPages: number;
  signal?: AbortSignal;
  launchBrowser?: BrowserLauncher;
}>;

type DynamicPageVerificationOptions = Readonly<{
  leads: readonly DiscoveryLead[];
  niche: string;
  minimumPrice: number;
  maximumPrice: number;
  currency?: "USD";
  headless: boolean;
  timeoutMs: number;
  maxPages: number;
  signal?: AbortSignal;
  launchBrowser?: BrowserLauncher;
  resolveAddresses?: AddressResolver;
}>;

export function buildCollectionUrl(
  source: SourceDescriptor,
  niche?: string,
  searchQuery?: string,
): string | undefined {
  if (source.collectionStrategy === "structured-search" && source.searchUrlTemplate) {
    const query = searchQuery ?? niche ?? source.supportedCategories[0];
    return source.searchUrlTemplate.replace("{query}", encodeURIComponent(query));
  }
  return source.baseUrl;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BrowserCollectionError(
      "COLLECTION_CANCELLED",
      "Product collection was cancelled.",
    );
  }
}

function classifyBrowserError(
  error: unknown,
  stage: BrowserCollectionStage,
): BrowserCollectionError {
  if (error instanceof BrowserCollectionError) return error;
  if (error instanceof SourceAccessError) {
    return new BrowserCollectionError(
      "SOURCE_ACCESS_REJECTED",
      "The configured research source was blocked by the source access policy.",
    );
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return new BrowserCollectionError(
      "BROWSER_TIMEOUT",
      "The configured research source did not respond before the browser timeout.",
    );
  }
  if (stage === "browser_launch") {
    return new BrowserCollectionError(
      "BROWSER_LAUNCH_FAILED",
      "The local browser could not start for the approved research source.",
    );
  }
  if (stage === "navigation") {
    return new BrowserCollectionError(
      "SOURCE_EXTRACTION_FAILED",
      "The approved research source could not be opened in the restricted browser session.",
    );
  }
  return new BrowserCollectionError(
    "SOURCE_EXTRACTION_FAILED",
    "The configured catalog could not be collected safely.",
  );
}

const unavailablePagePattern = /\b(?:404|not[\s-]?found|page[\s-]?not[\s-]?found|no longer available|discontinued|out[\s-]?of[\s-]?stock|sold[\s-]?out)\b/i;
const nonIdentityTerms = new Set([
  "and",
  "for",
  "from",
  "product",
  "products",
  "with",
  "the",
  "this",
]);

function pageIdentityTerms(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !nonIdentityTerms.has(term)),
  )];
}

function textHasProductIdentity(lead: DiscoveryLead, value: string): boolean {
  const terms = pageIdentityTerms(lead.title);
  if (terms.length === 0) return false;
  const normalizedText = value.toLowerCase();
  const matchedTerms = terms.filter((term) => normalizedText.includes(term));
  return matchedTerms.length >= Math.min(2, terms.length);
}

function finitePrice(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return undefined;
  const price = Number(normalized);
  return Number.isFinite(price) && price >= 0 ? price : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function jsonLdNodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(jsonLdNodes);
  const record = recordValue(value);
  if (!record) return [];
  const graph = record["@graph"];
  return graph === undefined ? [record] : [record, ...jsonLdNodes(graph)];
}

function isProductType(value: unknown): boolean {
  return schemaTypes(value).includes("product");
}

function schemaTypes(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    const text = boundedText(item, 120)?.toLowerCase();
    if (!text) return [];
    return [text.slice(text.lastIndexOf("/") + 1).replace(/^schema:/, "")];
  });
}

function offerRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const record = recordValue(item);
      return record ? [record] : [];
    });
  }
  const record = recordValue(value);
  return record ? [record] : [];
}

function offerPriceDetails(offer: Record<string, unknown>): Readonly<{
  price?: number;
  listPrice?: number;
  priceKind?: "current" | "sale" | "regular";
}> {
  let price = finitePrice(offer.price);
  let listPrice: number | undefined;
  let salePrice: number | undefined;
  for (const specification of offerRecords(offer.priceSpecification)) {
    const specificationPrice = finitePrice(specification.price);
    if (specificationPrice === undefined) continue;
    const priceType = boundedText(specification.priceType, 120)?.toLowerCase() ?? "";
    if (/(?:list|regular|was)/.test(priceType)) listPrice ??= specificationPrice;
    if (/sale/.test(priceType)) salePrice ??= specificationPrice;
  }
  if (price === undefined) price = salePrice ?? listPrice;
  if (price === undefined) return {};
  const priceKind = listPrice !== undefined && listPrice > price
    ? "sale"
    : price === listPrice
      ? "regular"
      : "current";
  return { price, ...(listPrice === undefined ? {} : { listPrice }), priceKind };
}

function productEvidenceFromNode(
  node: Record<string, unknown>,
  source: ProductPageStructuredEvidence["source"],
): ProductPageStructuredEvidence[] {
  const name = boundedText(node.name, 240);
  const sku = boundedText(node.sku ?? node.productID, 240);
  const variant = boundedText(node.color ?? node.model ?? node.size, 240);
  const offers = offerRecords(node.offers);
  if (offers.length === 0) {
    return [{ source, ...(name ? { name } : {}), ...(sku ? { sku } : {}), ...(variant ? { variant } : {}) }];
  }
  return offers.map((offer) => {
    const priceDetails = offerPriceDetails(offer);
    const currency = boundedText(offer.priceCurrency, 16)?.toUpperCase();
    const availability = boundedText(offer.availability, 120);
    return {
      source,
      ...(name ? { name } : {}),
      ...(sku ? { sku } : {}),
      ...(variant ? { variant } : {}),
      ...priceDetails,
      ...(currency ? { currency } : {}),
      ...(availability ? { availability } : {}),
    };
  });
}

/**
 * Parse only compact, server-rendered product facts. JSON-LD remains
 * untrusted page data: values are normalized and later require URL, identity,
 * availability, niche, and price-range validation before persistence.
 */
export function extractProductPageStructure(
  jsonLdPayloads: readonly string[],
  metaValues: Readonly<{
    price?: string;
    currency?: string;
    name?: string;
    sku?: string;
    variant?: string;
    openGraphType?: string;
  }> = {},
): ProductPageStructure {
  const structured: ProductPageStructuredEvidence[] = [];
  const pageTypes = new Set<string>();
  for (const payload of jsonLdPayloads) {
    try {
      for (const node of jsonLdNodes(JSON.parse(payload))) {
        for (const pageType of schemaTypes(node["@type"])) pageTypes.add(pageType);
        if (!isProductType(node["@type"])) continue;
        structured.push(...productEvidenceFromNode(node, "json_ld"));
      }
    } catch {
      // Invalid JSON-LD is untrusted page data, not a reason to fail the page.
    }
  }
  const metaPrice = finitePrice(metaValues.price);
  const metaCurrency = boundedText(metaValues.currency, 16)?.toUpperCase();
  if (metaPrice !== undefined && metaCurrency) {
    structured.push({
      source: "meta",
      price: metaPrice,
      priceKind: "current",
      currency: metaCurrency,
      ...(boundedText(metaValues.name, 240) ? { name: boundedText(metaValues.name, 240) } : {}),
      ...(boundedText(metaValues.sku, 240) ? { sku: boundedText(metaValues.sku, 240) } : {}),
      ...(boundedText(metaValues.variant, 240) ? { variant: boundedText(metaValues.variant, 240) } : {}),
    });
  }
  for (const pageType of schemaTypes(metaValues.openGraphType)) pageTypes.add(pageType);
  return { products: structured, pageTypes: [...pageTypes] };
}

export function extractStructuredProductEvidence(
  jsonLdPayloads: readonly string[],
  metaValues: Readonly<{ price?: string; currency?: string; name?: string; sku?: string; variant?: string; openGraphType?: string }> = {},
): ProductPageStructuredEvidence[] {
  return extractProductPageStructure(jsonLdPayloads, metaValues).products;
}

function isUnavailableStructuredOffer(evidence: ProductPageStructuredEvidence): boolean {
  return /(?:outofstock|soldout|discontinued|notavailable)/i.test(evidence.availability ?? "");
}

function matchingStructuredProducts(
  lead: DiscoveryLead,
  structuredProducts: readonly ProductPageStructuredEvidence[],
): ProductPageStructuredEvidence[] {
  return structuredProducts.filter((item) => item.name && textHasProductIdentity(lead, item.name));
}

function requestedVariant(finalUrl: URL): Readonly<{ value: string; label: string }> | null {
  for (const key of ["sku", "variant", "variantId", "variant_id"]) {
    const value = boundedText(finalUrl.searchParams.get(key), 240);
    if (value) return { value, label: `${key.toUpperCase()} ${value}` };
  }
  return null;
}

function sourceMethod(source: ProductPageStructuredEvidence["source"]): "product_json_ld" | "product_metadata" | "product_microdata" {
  return source === "json_ld"
    ? "product_json_ld"
    : source === "meta"
      ? "product_metadata"
      : "product_microdata";
}

function priceObservationText(source: ProductPageStructuredEvidence["source"], variant: string | null): string {
  const location = source === "json_ld"
    ? "matched primary Product JSON-LD offer"
    : source === "meta"
      ? "matched primary product metadata"
      : "matched scoped Product microdata offer";
  return variant ? `${location}; selected ${variant}.` : `${location}.`;
}

function isListingUrl(url: URL): boolean {
  return /(?:^|\/)(?:collections?|categories|search|bestsellers?)(?:\/|$)|\/(?:q|zgbs)(?:\/|$)/i.test(url.pathname);
}

function isListingSchema(
  pageTypes: readonly string[],
  structuredProducts: readonly ProductPageStructuredEvidence[],
): boolean {
  if (pageTypes.some((type) => /^(?:collectionpage|searchresultspage|categorypage)$/i.test(type))) {
    return true;
  }
  // A Product graph attached to an ItemList is not proof that one of those
  // items is the page's primary product. Reject an item-list graph with
  // multiple product identities instead of selecting a convenient price.
  const productNames = new Set(
    structuredProducts
      .map((product) => product.name?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  return pageTypes.some((type) => type.toLowerCase() === "itemlist") && productNames.size > 1;
}

type ResolvedProductPrice = Readonly<{
  item: ProductPageStructuredEvidence;
  price: number;
  listPrice: number | null;
  priceKind: "current" | "sale" | "regular";
  selectedVariant: string | null;
}>;

function resolveProductPrice(
  lead: DiscoveryLead,
  finalUrl: URL,
  structuredProducts: readonly ProductPageStructuredEvidence[],
  expectedCurrency: "USD",
): ResolvedProductPrice | ProductPageVerificationCode {
  const identityMatches = matchingStructuredProducts(lead, structuredProducts);
  if (identityMatches.length === 0) return "PAGE_IDENTITY_MISMATCH";
  const selected = requestedVariant(finalUrl);
  const selectedMatches = selected
    ? identityMatches.filter((item) => item.sku === selected.value || item.variant === selected.value)
    : identityMatches;
  if (selected && selectedMatches.length === 0) return "PAGE_VARIANT_UNRESOLVED";
  if (selectedMatches.some(isUnavailableStructuredOffer)) return "PAGE_UNAVAILABLE";
  const priced = selectedMatches.filter((item) => item.price !== undefined);
  if (priced.length === 0) return "PAGE_PRICE_NOT_OBSERVED";
  if (!priced.some((item) => item.currency === expectedCurrency)) return "PAGE_CURRENCY_MISMATCH";
  const expectedCurrencyPrices = priced.filter((item) => item.currency === expectedCurrency);
  const prices = new Set(expectedCurrencyPrices.map((item) => item.price));
  if (prices.size !== 1) return "PAGE_PRICE_AMBIGUOUS";
  const sourcePriority: Record<ProductPageStructuredEvidence["source"], number> = {
    json_ld: 0,
    microdata: 1,
    meta: 2,
  };
  const item = [...expectedCurrencyPrices].sort((left, right) => sourcePriority[left.source] - sourcePriority[right.source])[0];
  return {
    item,
    price: item.price!,
    listPrice: item.listPrice ?? null,
    priceKind: item.priceKind ?? "current",
    selectedVariant: selected?.label ?? item.variant ?? (item.sku ? `SKU ${item.sku}` : null),
  };
}

async function collectProductPageEvidence(page: Page): Promise<ProductPageStructure> {
  const jsonLdPayloads = await page
    .locator('script[type="application/ld+json"]')
    .allTextContents()
    .catch(() => [] as string[]);
  const metaValues = await page.locator(
    'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"], meta[property="product:price:currency"], meta[property="og:price:currency"], meta[itemprop="priceCurrency"], meta[itemprop="sku"], meta[property="og:type"]',
  ).evaluateAll((elements) => {
    const values: { price?: string; currency?: string; sku?: string; openGraphType?: string } = {};
    for (const element of elements) {
      const key = element.getAttribute("property") ?? element.getAttribute("itemprop");
      const value = element.getAttribute("content") ?? element.getAttribute("value") ?? undefined;
      if (!value) continue;
      if (key === "product:price:amount" || key === "og:price:amount" || key === "price") values.price ??= value;
      if (key === "product:price:currency" || key === "og:price:currency" || key === "priceCurrency") values.currency ??= value;
      if (key === "sku") values.sku ??= value;
      if (key === "og:type") values.openGraphType ??= value;
    }
    return values;
  }).catch(() => ({}));
  const primaryName = await page.locator("main h1, h1").first().innerText().then((value) => boundedText(value, 240)).catch(() => undefined);
  const microdataProducts = await page.locator('[itemscope][itemtype*="Product"]').evaluateAll((scopes) =>
    scopes.slice(0, 12).map((scope) => {
      const valueFor = (root: Element, property: string): string | undefined => {
        const element = root.querySelector(`[itemprop="${property}"]`);
        if (!element) return undefined;
        return element.getAttribute("content") ?? element.getAttribute("value") ?? element.textContent?.trim() ?? undefined;
      };
      const offer = scope.querySelector('[itemprop="offers"]') ?? scope;
      return {
        name: valueFor(scope, "name"),
        sku: valueFor(scope, "sku") ?? valueFor(scope, "productID"),
        variant: valueFor(scope, "color") ?? valueFor(scope, "model") ?? valueFor(scope, "size"),
        price: valueFor(offer, "price"),
        currency: valueFor(offer, "priceCurrency"),
        availability: valueFor(offer, "availability"),
      };
    }),
  ).catch(() => [] as Array<Record<string, string | undefined>>);
  const structured = extractProductPageStructure(jsonLdPayloads, { ...metaValues, name: primaryName });
  const microdata = microdataProducts.flatMap((record) => {
    const name = boundedText(record.name, 240);
    const price = finitePrice(record.price);
    const currency = boundedText(record.currency, 16)?.toUpperCase();
    const sku = boundedText(record.sku, 240);
    const variant = boundedText(record.variant, 240);
    const availability = boundedText(record.availability, 120);
    return [{
      source: "microdata" as const,
      ...(name ? { name } : {}),
      ...(sku ? { sku } : {}),
      ...(variant ? { variant } : {}),
      ...(price === undefined ? {} : { price }),
      ...(price === undefined ? {} : { priceKind: "current" as const }),
      ...(currency ? { currency } : {}),
      ...(availability ? { availability } : {}),
    }];
  });
  return {
    products: [...structured.products, ...microdata],
    pageTypes: [...new Set([...structured.pageTypes, ...(microdata.length ? ["product"] : [])])],
  };
}

function pageMatchesNiche(pageText: string, niche: string): boolean {
  const terms = niche.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  const normalizedPageText = pageText.toLowerCase();
  return terms.length > 0 && terms.every((term) => normalizedPageText.includes(term));
}

function sameHostname(left: URL, right: URL): boolean {
  return left.hostname.toLowerCase() === right.hostname.toLowerCase();
}

function verificationFailure(
  lead: DiscoveryLead,
  code: ProductPageVerificationCode,
): ProductPageVerification {
  return { lead, code };
}

/**
 * Applies deterministic product-detail, identity, variant, and price checks.
 * Arbitrary body-text prices are intentionally never accepted: product prices
 * must be tied to a matching Product JSON-LD record, product metadata, or a
 * scoped Product microdata block. The caller must still enforce URL and
 * browser navigation policy before invoking this helper.
 */
export function assessDiscoveredProductPage(
  lead: DiscoveryLead,
  evidence: ProductPageVerificationEvidence,
  criteria: Readonly<{ niche: string; minimumPrice: number; maximumPrice: number; currency?: "USD" }>,
): ProductPageVerification {
  let initialUrl: URL;
  let finalUrl: URL;
  try {
    initialUrl = new URL(lead.sourceUrl);
    finalUrl = new URL(evidence.finalUrl);
  } catch {
    return verificationFailure(lead, "PAGE_URL_REJECTED");
  }
  if (!sameHostname(initialUrl, finalUrl)) {
    return verificationFailure(lead, "PAGE_REDIRECT_REJECTED");
  }
  if (isListingUrl(finalUrl) || isListingSchema(evidence.pageTypes ?? [], evidence.structuredProducts ?? [])) {
    return verificationFailure(lead, "PAGE_NOT_PRODUCT_DETAIL");
  }
  const pageText = `${evidence.title}\n${evidence.bodyText}`.replace(/\s+/g, " ").trim();
  if (
    evidence.httpStatus === null ||
    evidence.httpStatus < 200 ||
    evidence.httpStatus >= 400 ||
    pageText.length === 0 ||
    unavailablePagePattern.test(pageText.slice(0, 20_000))
  ) {
    return verificationFailure(lead, "PAGE_UNAVAILABLE");
  }
  if (!textHasProductIdentity(lead, pageText)) {
    return verificationFailure(lead, "PAGE_IDENTITY_MISMATCH");
  }
  const structuredProducts = evidence.structuredProducts ?? [];
  const resolvedPrice = resolveProductPrice(
    lead,
    finalUrl,
    structuredProducts,
    criteria.currency ?? "USD",
  );
  if (typeof resolvedPrice === "string") return verificationFailure(lead, resolvedPrice);
  const price = resolvedPrice.price;
  if (price < criteria.minimumPrice || price > criteria.maximumPrice) {
    return verificationFailure(lead, "PAGE_PRICE_OUT_OF_RANGE");
  }

  const verifiedAt = evidence.verifiedAt ?? new Date().toISOString();
  const verifiedProduct = normalizeProduct(
    {
      externalId: lead.externalId,
      // A matching Product JSON-LD name is product-page evidence and is more
      // specific than an untrusted search-citation title.
      name: resolvedPrice.item.name ?? lead.title,
      // The browser obtains the full page only for deterministic validation.
      // Do not persist unrestricted page text or provider snippets as a
      // product description; the page title remains traceable provenance.
      description: evidence.title,
      category: null,
      price,
      listPrice: resolvedPrice.listPrice,
      priceKind: resolvedPrice.priceKind,
      variant: resolvedPrice.selectedVariant,
      priceObservation: {
        method: sourceMethod(resolvedPrice.item.source),
        supportingObservation: priceObservationText(
          resolvedPrice.item.source,
          resolvedPrice.selectedVariant,
        ),
        sourceUrl: finalUrl.toString(),
        selectedVariant: resolvedPrice.selectedVariant,
        priceKind: resolvedPrice.priceKind,
        observedAt: verifiedAt,
      },
      sourceUrl: finalUrl.toString(),
      evidenceConfidence: "high",
      evidenceStatus: "product_page_verified",
      collectedAt: verifiedAt,
    },
    lead.sourceId,
    finalUrl.toString(),
  );
  if (!verifiedProduct) return verificationFailure(lead, "PAGE_FETCH_FAILED");
  if (!productMatchesNiche(verifiedProduct, criteria.niche) && !pageMatchesNiche(pageText, criteria.niche)) {
    return verificationFailure(lead, "PAGE_NICHE_MISMATCH");
  }
  return {
    lead,
    code: "VERIFIED",
    verifiedProduct: ProductCandidateSchema.parse({
      ...verifiedProduct,
      sourceUrl: finalUrl.toString(),
      evidenceStatus: "product_page_verified",
      evidence: [
        ...verifiedProduct.evidence,
        {
          field: "product-page verification",
          value: "Individual product page responded successfully with matching identity, niche, selected variant, and observed price.",
          sourceUrl: finalUrl.toString(),
          observedAt: verifiedAt,
          confidence: "high",
        },
        {
          field: "product-page price source",
          value: priceObservationText(resolvedPrice.item.source, resolvedPrice.selectedVariant),
          sourceUrl: finalUrl.toString(),
          observedAt: verifiedAt,
          confidence: "high",
        },
        {
          field: "product-page price observation",
          value: `${resolvedPrice.priceKind === "sale" ? "Sale" : resolvedPrice.priceKind === "regular" ? "Regular" : "Current"} price ${price.toFixed(2)} ${criteria.currency ?? "USD"}${resolvedPrice.listPrice !== null ? `; list price ${resolvedPrice.listPrice.toFixed(2)} ${criteria.currency ?? "USD"}` : ""}.`,
          sourceUrl: finalUrl.toString(),
          observedAt: verifiedAt,
          confidence: "high",
        },
        ...(resolvedPrice.selectedVariant
          ? [{
              field: "product-page variant",
              value: resolvedPrice.selectedVariant,
              sourceUrl: finalUrl.toString(),
              observedAt: verifiedAt,
              confidence: "high" as const,
            }]
          : []),
        {
          field: "product-page niche verification",
          value: "Product page text contained every selected niche term.",
          sourceUrl: finalUrl.toString(),
          observedAt: verifiedAt,
          confidence: "high",
        },
      ],
      collectedAt: verifiedAt,
    }),
  };
}

function verificationErrorCode(error: unknown): ProductPageVerificationCode {
  if (error instanceof SourceAccessError) return "PAGE_URL_REJECTED";
  if (error instanceof BrowserCollectionError && error.code === "COLLECTION_CANCELLED") {
    return "PAGE_CANCELLED";
  }
  if (error instanceof Error && /timeout/i.test(error.message)) return "PAGE_TIMEOUT";
  return "PAGE_FETCH_FAILED";
}

/**
 * Verify only product URLs that were already returned by the configured Web
 * Search tool and accepted into this job. Each check is bounded by the
 * existing browser page limit, permits only same-host document navigation,
 * disables JavaScript, and rejects redirects, private addresses, unavailable
 * pages, identity mismatches, and missing observed prices.
 */
export async function verifyDiscoveredProductPages(
  options: DynamicPageVerificationOptions,
): Promise<ProductPageVerificationResult> {
  const permitted = options.leads.slice(0, Math.max(0, options.maxPages));
  const rejected: ProductPageVerification[] = options.leads
    .slice(permitted.length)
    .map((lead) => verificationFailure(lead, "PAGE_VERIFICATION_LIMIT"));
  const verifiedProducts: ProductCandidate[] = [];
  let attemptedLeadCount = 0;
  if (permitted.length === 0) {
    return {
      queuedLeadCount: options.leads.length,
      attemptedLeadCount: 0,
      verifiedProducts,
      rejected,
    };
  }

  let browser: Browser | undefined;
  const stopBrowser = () => {
    void browser?.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", stopBrowser, { once: true });
  try {
    assertNotAborted(options.signal);
    browser = await (options.launchBrowser ?? createDefaultBrowserLauncher())({
      headless: options.headless,
    });
    for (const lead of permitted) {
      if (options.signal?.aborted) {
        rejected.push(verificationFailure(lead, "PAGE_CANCELLED"));
        continue;
      }
      attemptedLeadCount += 1;
      let context: BrowserContext | undefined;
      let blockedCrossHostDocument = false;
      try {
        const sourceUrl = await assertObservedWebUrl(lead.sourceUrl, options.resolveAddresses);
        const expectedHostname = sourceUrl.hostname.toLowerCase();
        context = await browser.newContext({ javaScriptEnabled: false });
        await context.route("**/*", (route) => {
          const request = route.request();
          let requestUrl: URL;
          try {
            requestUrl = new URL(request.url());
          } catch {
            return route.abort("blockedbyclient");
          }
          // Only the original public host may serve the top-level document.
          // No scripts, frames, trackers, or arbitrary redirect destinations
          // are available to dynamic page verification.
          if (
            request.resourceType() !== "document" ||
            requestUrl.protocol !== "https:" ||
            requestUrl.hostname.toLowerCase() !== expectedHostname
          ) {
            if (
              request.resourceType() === "document" &&
              requestUrl.hostname.toLowerCase() !== expectedHostname
            ) {
              blockedCrossHostDocument = true;
            }
            return route.abort("blockedbyclient");
          }
          return route.continue();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(options.timeoutMs);
        const response = await page.goto(sourceUrl.toString(), {
          waitUntil: "domcontentloaded",
          timeout: options.timeoutMs,
        });
        const finalUrl = await assertObservedWebUrl(page.url(), options.resolveAddresses);
        if (!sameHostname(sourceUrl, finalUrl)) {
          rejected.push(verificationFailure(lead, "PAGE_REDIRECT_REJECTED"));
          continue;
        }
        const pageEvidence = await collectProductPageEvidence(page);
        const assessed = assessDiscoveredProductPage(lead, {
          finalUrl: finalUrl.toString(),
          httpStatus: response?.status() ?? null,
          title: await page.title(),
          bodyText: (await page.locator("body").innerText()).slice(0, 40_000),
          structuredProducts: pageEvidence.products,
          pageTypes: pageEvidence.pageTypes,
        }, options);
        if (assessed.verifiedProduct) verifiedProducts.push(assessed.verifiedProduct);
        else rejected.push(assessed);
      } catch (error) {
        rejected.push(verificationFailure(
          lead,
          blockedCrossHostDocument ? "PAGE_REDIRECT_REJECTED" : verificationErrorCode(error),
        ));
      } finally {
        await context?.close().catch(() => undefined);
      }
    }
  } catch (error) {
    const code = verificationErrorCode(error);
    const handled = new Set(rejected.map((item) => item.lead.id));
    for (const lead of permitted) {
      if (!handled.has(lead.id) && !verifiedProducts.some((item) => item.id === lead.id)) {
        rejected.push(verificationFailure(lead, code));
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", stopBrowser);
    await browser?.close().catch(() => undefined);
  }

  return {
    queuedLeadCount: options.leads.length,
    attemptedLeadCount,
    verifiedProducts,
    rejected,
  };
}

export async function extractWebScraperCatalogProducts(
  page: Page,
  source: SourceDescriptor,
  limit: number,
): Promise<ProductCandidate[]> {
  const cardSelector = ".thumbnail";
  const cards = page.locator(cardSelector);
  const cardCount = await cards.count();

  if (cardCount === 0) {
    throw new BrowserCollectionError(
      "SOURCE_EXTRACTION_FAILED",
      "The configured catalog has no readable product cards.",
    );
  }

  const extractionUrl = page.url();
  const rawRecords = await cards.evaluateAll(
    (elements, options) =>
      elements.slice(0, options.maximum).map((card, index) => {
        const title = card.querySelector(".title");
        const price = card.querySelector(".price");
        const description = card.querySelector(".description");
        const image = card.querySelector("img");
        const href = title instanceof HTMLAnchorElement ? title.href : null;

        return {
          externalId: card.getAttribute("data-id") ?? `catalog-card-${index + 1}`,
          name: title?.getAttribute("title") ?? title?.textContent,
          price: price?.textContent,
          description: description?.textContent,
          category: options.category,
          sourceUrl: href,
          imageUrl: image instanceof HTMLImageElement ? image.src : null,
        };
      }),
    { maximum: limit, category: source.canonicalCategory ?? source.supportedCategories[0] },
  );

  const normalized = rawRecords
    .map((record) => normalizeProduct(record as RawProductRecord, source.id, extractionUrl))
    .filter((product): product is ProductCandidate => product !== null);
  return deduplicateProducts(normalized).products;
}

export async function extractStructuredSearchProducts(
  page: Page,
  source: SourceDescriptor,
  limit: number,
): Promise<ProductCandidate[]> {
  const extractionUrl = page.url();
  const category = source.canonicalCategory ?? source.supportedCategories[0];
  const rawRecords = await page.evaluate(
    ({ maximum, fallbackCategory }) => {
      type RecordShape = {
        externalId?: string | null;
        name?: string | null;
        description?: string | null;
        category?: string | null;
        price?: string | number | null;
        sourceUrl?: string | null;
        imageUrl?: string | null;
      };
      const records: RecordShape[] = [];
      const add = (record: RecordShape) => {
        if (record.name && records.length < maximum) records.push(record);
      };
      const visitJson = (value: unknown) => {
        if (Array.isArray(value)) {
          value.forEach(visitJson);
          return;
        }
        if (!value || typeof value !== "object") return;
        const candidate = value as Record<string, unknown>;
        if (candidate["@graph"]) visitJson(candidate["@graph"]);
        if (candidate["@type"] === "Product" || candidate["@type"] === "ProductGroup") {
          const offers = candidate.offers as Record<string, unknown> | undefined;
          const image = Array.isArray(candidate.image) ? candidate.image[0] : candidate.image;
          add({
            externalId: typeof candidate.sku === "string" ? candidate.sku : typeof candidate.productID === "string" ? candidate.productID : null,
            name: typeof candidate.name === "string" ? candidate.name : null,
            description: typeof candidate.description === "string" ? candidate.description : null,
            category: typeof candidate.category === "string" ? candidate.category : fallbackCategory,
            price: typeof offers?.price === "number" || typeof offers?.price === "string" ? offers.price : null,
            sourceUrl: typeof candidate.url === "string" ? candidate.url : null,
            imageUrl: typeof image === "string" ? image : null,
          });
        }
      };
      document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
        try { visitJson(JSON.parse(script.textContent ?? "")); } catch { /* ignore malformed publisher JSON */ }
      });
      // Some approved retailers expose their server-rendered listing model in an
      // inline JSON payload rather than JSON-LD or visible cards. Read only
      // product URLs on the allowlisted page and keep the surrounding price
      // text as provenance; never execute the payload as code.
      if (records.length < maximum) {
        const html = document.documentElement.outerHTML.replaceAll('\\"', '"').replaceAll('\\/', '/');
        const visiblePrices = Array.from(html.matchAll(/\$\s*(\d{1,4}(?:\.\d{2})?)/g)).map((entry) => entry[1]);
        const productPattern = /"title":"([^"]{2,200})","url":"(https:[^"]+\/p\/[^"\\]+)"/g;
        let match: RegExpExecArray | null;
        while (records.length < maximum && (match = productPattern.exec(html))) {
          const context = html.slice(Math.max(0, match.index - 20_000), match.index + 20_000);
          const price = context.match(/(?:price|current_retail_price|formatted_price)[^0-9$]{0,80}\$?\s*(\d{1,4}(?:\.\d{2})?)/i)?.[1]
            ?? context.match(/\$\s*(\d{1,4}(?:\.\d{2})?)/)?.[1]
            ?? visiblePrices[records.length]
            ?? null;
          add({
            externalId: match[2],
            name: match[1],
            description: null,
            category: fallbackCategory,
            price,
            sourceUrl: match[2].replaceAll('\\/', '/'),
            imageUrl: null,
          });
        }
      }
      const selectors = [
        '[data-at="product_tile"]',
        '[data-testid*="product"]',
        'article',
        'li.product-item',
        '.product-item',
      ];
      for (const card of Array.from(document.querySelectorAll(selectors.join(",")))) {
        if (records.length >= maximum) break;
        const anchor = card.querySelector("a[href]") as HTMLAnchorElement | null;
        const nameNode = card.querySelector("[data-at*='product'], [data-testid*='product-name'], .product-name, h2, h3, h4") ?? anchor;
        const text = card.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const priceMatch = text.match(/(?:USD|US\$|\$)\s?\d+(?:[.,]\d{1,2})?/i);
        const image = card.querySelector("img") as HTMLImageElement | null;
        add({
          externalId: anchor?.href ?? null,
          name: nameNode?.textContent?.trim() ?? null,
          description: null,
          category: fallbackCategory,
          price: priceMatch?.[0] ?? null,
          sourceUrl: anchor?.href ?? null,
          imageUrl: image?.src ?? null,
        });
      }
      return records.slice(0, maximum);
    },
    { maximum: limit, fallbackCategory: category },
  );

  const normalized = rawRecords
    .map((record) => {
      try {
        if (!record.sourceUrl) return null;
        const url = new URL(record.sourceUrl, extractionUrl);
        if (url.protocol !== "https:" || !source.allowedHosts.includes(url.hostname)) return null;
        return normalizeProduct(
          { ...record, sourceUrl: url.toString() } as RawProductRecord,
          source.id,
          extractionUrl,
        );
      } catch {
        return null;
      }
    })
    .filter((product): product is ProductCandidate => product !== null);
  return deduplicateProducts(normalized).products;
}

export async function collectWebScraperCatalogProducts(
  options: BrowserCollectionOptions,
): Promise<{ products: ProductCandidate[]; extractedCount: number; duplicateCount: number }> {
  const { source, niche, limit, timeoutMs, maxPages } = options;
  if (source.type !== "browser" || !source.baseUrl || maxPages < 1) {
    throw new BrowserCollectionError(
      "SOURCE_EXTRACTION_FAILED",
      "The configured browser source is invalid.",
    );
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let stage: BrowserCollectionStage = "source_validation";
  const stopCollection = () => {
    void context?.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", stopCollection, { once: true });
  try {
    assertNotAborted(options.signal);
    await assertApprovedSourceUrl(source.baseUrl, source);
    stage = "browser_launch";
    browser = await (options.launchBrowser ?? createDefaultBrowserLauncher())({
      headless: options.headless,
    });
    context = await browser.newContext();
    try {
      await context.route("**/*", (route) => {
        if (isAllowedBrowserRequest(route.request().url(), source)) {
          return route.continue();
        }
        return route.abort("blockedbyclient");
      });

      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      assertNotAborted(options.signal);
      stage = "navigation";
      const targetUrl = buildCollectionUrl(source, niche, options.searchQuery);
      if (!targetUrl) throw new BrowserCollectionError("SOURCE_EXTRACTION_FAILED", "The approved source has no collection URL.");
      await assertApprovedSourceUrl(targetUrl, source);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      assertNotAborted(options.signal);
      await assertApprovedSourceUrl(page.url(), source);
      stage = "extraction";
      const products = source.collectionStrategy === "structured-search"
        ? await extractStructuredSearchProducts(page, source, limit)
        : await extractWebScraperCatalogProducts(page, source, limit);
      const deduplicated = deduplicateProducts(products);

      return {
        products: deduplicated.products,
        extractedCount: products.length,
        duplicateCount: deduplicated.duplicateCount,
      };
    } finally {
      await context.close();
    }
  } catch (error) {
    if (options.signal?.aborted) {
      throw new BrowserCollectionError(
        "COLLECTION_CANCELLED",
        "Product collection was cancelled.",
      );
    }
    throw classifyBrowserError(error, stage);
  } finally {
    options.signal?.removeEventListener("abort", stopCollection);
    await context?.close().catch(() => undefined);
    await browser?.close();
  }
}

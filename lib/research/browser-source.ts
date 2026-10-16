import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

import type { ProductCandidate, SourceDescriptor } from "./contracts";
import {
  type RawProductRecord,
  deduplicateProducts,
  normalizeProduct,
} from "./normalize";
import {
  SourceAccessError,
  assertApprovedSourceUrl,
  isAllowedBrowserRequest,
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

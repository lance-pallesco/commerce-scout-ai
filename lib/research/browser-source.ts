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
    | "BROWSER_TIMEOUT"
    | "SOURCE_EXTRACTION_FAILED"
    | "SOURCE_ACCESS_REJECTED"
    | "COLLECTION_CANCELLED";

  constructor(
    code:
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

export type BrowserLauncher = (options: { headless: boolean }) => Promise<Browser>;

type BrowserCollectionOptions = Readonly<{
  source: SourceDescriptor;
  limit: number;
  headless: boolean;
  timeoutMs: number;
  maxPages: number;
  signal?: AbortSignal;
  launchBrowser?: BrowserLauncher;
}>;

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new BrowserCollectionError(
      "COLLECTION_CANCELLED",
      "Product collection was cancelled.",
    );
  }
}

function classifyBrowserError(error: unknown): BrowserCollectionError {
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
    (elements, maximum) =>
      elements.slice(0, maximum).map((card, index) => {
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
          category: "electronics",
          sourceUrl: href,
          imageUrl: image instanceof HTMLImageElement ? image.src : null,
        };
      }),
    limit,
  );

  const normalized = rawRecords
    .map((record) => normalizeProduct(record as RawProductRecord, source.id, extractionUrl))
    .filter((product): product is ProductCandidate => product !== null);
  return deduplicateProducts(normalized).products;
}

export async function collectWebScraperCatalogProducts(
  options: BrowserCollectionOptions,
): Promise<{ products: ProductCandidate[]; extractedCount: number; duplicateCount: number }> {
  const { source, limit, timeoutMs, maxPages } = options;
  if (source.type !== "browser" || !source.baseUrl || maxPages < 1) {
    throw new BrowserCollectionError(
      "SOURCE_EXTRACTION_FAILED",
      "The configured browser source is invalid.",
    );
  }

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  const stopCollection = () => {
    void context?.close().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", stopCollection, { once: true });
  try {
    assertNotAborted(options.signal);
    await assertApprovedSourceUrl(source.baseUrl, source);
    browser = await (options.launchBrowser ?? chromium.launch)({
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
      await page.goto(source.baseUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      assertNotAborted(options.signal);
      await assertApprovedSourceUrl(page.url(), source);
      const products = await extractWebScraperCatalogProducts(page, source, limit);
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
    throw classifyBrowserError(error);
  } finally {
    options.signal?.removeEventListener("abort", stopCollection);
    await context?.close().catch(() => undefined);
    await browser?.close();
  }
}

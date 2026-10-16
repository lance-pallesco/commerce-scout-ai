import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserCollectionError,
  collectWebScraperCatalogProducts,
  extractWebScraperCatalogProducts,
} from "@/lib/research/browser-source";
import { getResearchSource } from "@/lib/research/source-registry";

const source = getResearchSource("webscraper-ecommerce-demo", "live");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

describe("webscraper product extraction", () => {
  it("extracts structured products from a deterministic catalog page", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <base href="https://webscraper.io/test-sites/e-commerce/allinone/">
      <article class="thumbnail" data-id="phone-1">
        <a class="title" title="Test Phone" href="product/phone-1">Test Phone</a>
        <h4 class="price">$299.99</h4>
        <p class="description">A verified test catalog record.</p>
        <img src="images/phone-1.jpg" alt="Test Phone" />
      </article>
    `);

    const products = await extractWebScraperCatalogProducts(page, source, 10);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: "Test Phone",
      price: 299.99,
      category: "electronics",
      missingFields: [],
    });
  });

  it("marks omitted catalog fields as unavailable", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <article class="thumbnail" data-id="phone-2">
        <a class="title" title="Sparse Phone" href="https://webscraper.io/product/phone-2">Sparse Phone</a>
      </article>
    `);

    const [product] = await extractWebScraperCatalogProducts(page, source, 10);
    expect(product.missingFields).toEqual(
      expect.arrayContaining(["price", "description", "imageUrl"]),
    );
  });

  it("fails safely when the expected catalog layout is absent", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent("<main>Catalog unavailable</main>");

    await expect(extractWebScraperCatalogProducts(page, source, 10)).rejects.toMatchObject({
      code: "SOURCE_EXTRACTION_FAILED",
    } satisfies Partial<BrowserCollectionError>);
  });

  it("does not launch a browser when the collection has already been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const launchBrowser = vi.fn();

    await expect(
      collectWebScraperCatalogProducts({
        source,
        limit: 2,
        headless: true,
        timeoutMs: 1_000,
        maxPages: 1,
        signal: controller.signal,
        launchBrowser,
      }),
    ).rejects.toMatchObject({ code: "COLLECTION_CANCELLED" });
    expect(launchBrowser).not.toHaveBeenCalled();
  });
});

import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BrowserCollectionError,
  assessDiscoveredProductPage,
  buildCollectionUrl,
  collectWebScraperCatalogProducts,
  createDefaultBrowserLauncher,
  extractStructuredProductEvidence,
  extractStructuredSearchProducts,
  extractWebScraperCatalogProducts,
} from "@/lib/research/browser-source";
import type { DiscoveryLead } from "@/lib/research/contracts";
import { getResearchSource } from "@/lib/research/source-registry";

const source = getResearchSource("webscraper-ecommerce-demo", "live");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

function discoveryLead(): DiscoveryLead {
  return {
    id: "anthropic-web-discovery:verified-glow-serum",
    sourceId: "anthropic-web-discovery",
    externalId: "verified-glow-serum",
    title: "Verified Glow Serum",
    snippet: null,
    observedPrice: null,
    currency: null,
    sourceUrl: "https://shop.example/products/verified-glow-serum",
    observedAt: "2026-10-17T00:00:00.000Z",
  };
}

afterEach(async () => {
  await browser?.close();
  browser = undefined;
});

describe("webscraper product extraction", () => {
  it("preserves Playwright BrowserType binding for the default launcher", async () => {
    const browser = {} as Awaited<ReturnType<typeof chromium.launch>>;
    const browserType = {
      launch: vi.fn(function (this: unknown, options: { headless: boolean }) {
        expect(this).toBe(browserType);
        expect(options).toEqual({ headless: true });
        return Promise.resolve(browser);
      }),
    } as unknown as Pick<typeof chromium, "launch">;

    await expect(createDefaultBrowserLauncher(browserType)({ headless: true })).resolves.toBe(browser);
  });

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

  it("extracts allowlisted structured-search product evidence", async () => {
    const searchSource = getResearchSource("target-public-skincare", "live");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        sku: "serum-1",
        name: "Evidence Serum",
        description: "A public product description.",
        category: "skincare",
        offers: { price: "29.00" },
        url: "https://www.target.com/p/evidence-serum/-/A-12345678",
      })}</script>
    `);

    const products = await extractStructuredSearchProducts(page, searchSource, 5);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      name: "Evidence Serum",
      price: 29,
      category: "skincare",
      sourceId: "target-public-skincare",
    });
  });

  it("builds a bounded provider search URL from Claude's focused query", () => {
    const searchSource = getResearchSource("target-public-skincare", "live");
    expect(buildCollectionUrl(searchSource, "skincare", "fragrance free serum")).toBe(
      "https://www.target.com/s?searchTerm=fragrance%20free%20serum",
    );
  });

  it("reads a bounded retailer listing payload without executing it", async () => {
    const searchSource = getResearchSource("target-public-skincare", "live");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(`
      <main>$29.00</main>
      <script>window.__listing = {"title":"Payload Serum","url":"https://www.target.com/p/payload-serum/-/A-123"}</script>
    `);

    const products = await extractStructuredSearchProducts(page, searchSource, 5);

    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ name: "Payload Serum", price: 29 });
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

  it("rejects a missing discovered page instead of producing a verified candidate", () => {
    const lead = discoveryLead();

    const verification = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 404,
      title: "Page not found",
      bodyText: "The requested product is no longer available.",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verification).toMatchObject({ code: "PAGE_UNAVAILABLE" });
    expect(verification.verifiedProduct).toBeUndefined();
  });

  it("requires same-host identity and observed-price evidence before promoting a discovery lead", () => {
    const lead = discoveryLead();
    const verified = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum skincare is available now for $29.00.",
      verifiedAt: "2026-10-17T00:00:00.000Z",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });
    const redirected = assessDiscoveredProductPage(lead, {
      finalUrl: "https://untrusted.example/products/verified-glow-serum",
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum skincare is available now for $29.00.",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verified.verifiedProduct).toMatchObject({
      evidenceStatus: "product_page_verified",
      sourceUrl: lead.sourceUrl,
      price: 29,
    });
    expect(redirected).toMatchObject({ code: "PAGE_REDIRECT_REJECTED" });
    expect(redirected.verifiedProduct).toBeUndefined();
  });

  it("uses a page-observed price when a discovery citation had no price", () => {
    const lead = discoveryLead();

    const verification = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum skincare is $31.50 on this product page.",
      verifiedAt: "2026-10-17T00:00:00.000Z",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(lead.observedPrice).toBeNull();
    expect(verification).toMatchObject({ code: "VERIFIED" });
    expect(verification.verifiedProduct).toMatchObject({
      price: 31.5,
      currency: "USD",
      evidenceStatus: "product_page_verified",
    });
  });

  it("promotes a matching direct product page when its price is only in server-rendered JSON-LD", () => {
    const lead = discoveryLead();
    const structuredProducts = extractStructuredProductEvidence([
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Verified Glow Serum",
        offers: {
          "@type": "Offer",
          price: "31.50",
          priceCurrency: "USD",
          availability: "https://schema.org/InStock",
        },
      }),
    ]);

    const verification = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Glow serum product page",
      bodyText: "A skincare product with server-rendered structured data.",
      structuredProducts,
      verifiedAt: "2026-10-17T00:00:00.000Z",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verification).toMatchObject({ code: "VERIFIED" });
    expect(verification.verifiedProduct).toMatchObject({
      name: "Verified Glow Serum",
      price: 31.5,
      evidenceStatus: "product_page_verified",
    });
    expect(verification.verifiedProduct?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "product-page price source",
        value: "Observed in server-rendered Product JSON-LD.",
      }),
    ]));
  });

  it("uses product metadata only after visible page identity is verified", () => {
    const lead = discoveryLead();
    const structuredProducts = extractStructuredProductEvidence([], {
      price: "31.50",
      currency: "USD",
    });

    const verified = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum is a skincare product.",
      structuredProducts,
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });
    const rejected = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Another product skincare",
      bodyText: "A skincare product.",
      structuredProducts,
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verified).toMatchObject({ code: "VERIFIED" });
    expect(verified.verifiedProduct?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "product-page price source",
        value: "Observed in server-rendered product price metadata.",
      }),
    ]));
    expect(rejected).toMatchObject({ code: "PAGE_IDENTITY_MISMATCH" });
  });

  it("does not accept an unavailable structured offer as a verified recommendation", () => {
    const lead = discoveryLead();
    const structuredProducts = extractStructuredProductEvidence([
      JSON.stringify({
        "@type": "Product",
        name: "Verified Glow Serum",
        offers: {
          price: "31.50",
          priceCurrency: "USD",
          availability: "https://schema.org/OutOfStock",
        },
      }),
    ]);

    const verification = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum skincare product.",
      structuredProducts,
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verification).toMatchObject({ code: "PAGE_UNAVAILABLE" });
    expect(verification.verifiedProduct).toBeUndefined();
  });

  it("rejects a page-observed price outside the submitted range", () => {
    const lead = discoveryLead();

    const verification = assessDiscoveredProductPage(lead, {
      finalUrl: lead.sourceUrl,
      httpStatus: 200,
      title: "Verified Glow Serum skincare",
      bodyText: "Verified Glow Serum skincare is $125.00 on this product page.",
    }, { niche: "skincare", minimumPrice: 15, maximumPrice: 60 });

    expect(verification).toMatchObject({ code: "PAGE_PRICE_OUT_OF_RANGE" });
    expect(verification.verifiedProduct).toBeUndefined();
  });
});

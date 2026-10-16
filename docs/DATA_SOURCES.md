# Data sources

## Synthetic skincare fixture

`fixtures/products.skincare.json` is local, reproducible development data. It includes strong records, lower-price/out-of-range records, duplicates, and deliberately missing fields. It contains no real performance, demand, advertising, or sales metrics.

## Registered live browser sources

The configured live browser adapter targets `https://webscraper.io/test-sites/e-commerce/allinone`. It is a public practice catalog and represents electronics only.

The registry also contains bounded structured-search adapters for public Target skincare/beauty pages and IKEA home/living search pages. They accept only niche keywords registered for that provider, navigate only to the provider's HTTPS allowlist, and retain product-page provenance. The optional browser suite has observed Target product names, prices, and URLs through the real Playwright path; retailer markup and availability can change, so run the deterministic extraction tests before changing selectors and perform a manual live verification before making portfolio claims about a new provider.

Any future source needs an explicit registry entry, owner/terms review, allowed-host controls, a bounded adapter, tests, and documentation. Unsupported niches are rejected rather than mapped to an unrelated source.

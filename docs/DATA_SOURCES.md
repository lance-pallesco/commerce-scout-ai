# Data sources

## Synthetic skincare fixture

`fixtures/products.skincare.json` is local, reproducible development data. It includes strong records, lower-price/out-of-range records, duplicates, and deliberately missing fields. It contains no real performance, demand, advertising, or sales metrics.

## Web Scraper demonstration catalog

The configured live browser adapter targets `https://webscraper.io/test-sites/e-commerce/allinone`. It is a public practice catalog and currently represents electronics. The source registry marks it as electronics, so a skincare job cannot select it and its records cannot be presented as skincare evidence.

Any future source needs an explicit registry entry, owner/terms review, allowed-host controls, a bounded adapter, tests, and documentation. Authorized Shopify catalogs, CSV imports, and legitimate research APIs are possible future adapters; paid ad-spy integrations are not part of this MVP.

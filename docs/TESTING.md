# Testing

Run checks with `npm.cmd` in Windows PowerShell:

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:browser
npm.cmd run test:e2e
npm.cmd run build
```

Unit/integration coverage includes configuration bounds, normalization, price filtering, fixture deduplication, source restrictions, MCP action limits, malformed/turn-limited agent results, scoring, SQLite job claims/cancellation, worker processing, API request validation, reports, and export responses.

`test:browser` launches Chromium against local HTML to validate selector extraction, missing fields, and layout failure behavior. `RUN_LIVE_BROWSER_TESTS=true npm.cmd run test:browser` adds an optional external demo-catalog smoke test.

`test:e2e` uses an isolated, uniquely named ignored SQLite file and local production server, submits a fixture request through the UI, invokes the worker, verifies the persisted ranking/CSV UI, and checks a narrow viewport. The live Claude integration requires a real API key and is intentionally not treated as passed by mocked tests.

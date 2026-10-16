# CommerceScout AI

CommerceScout AI is an evidence-grounded e-commerce product-research MVP. It combines a Next.js dashboard, a separate local research worker, allowlisted Playwright catalog collection, deterministic scoring, local SQLite persistence, and a narrowly scoped Claude Agent SDK integration.

Codex develops and maintains this repository. At runtime, `@anthropic-ai/claude-agent-sdk` powers the optional Claude research agent; it is not replaced by an OpenAI agent framework.

## What works

- Fixture-mode research: synthetic skincare records are collected, normalized, deduplicated, filtered, scored, persisted, rendered, and exported as CSV without an API key.
- Browser collection: allowlisted Playwright adapters can collect the Web Scraper electronics demonstration catalog plus bounded, query-driven Target and IKEA search pages. Claude may add a focused search phrase, but the backend always appends the submitted niche, enforces approved hosts, filters observed prices, and rejects unrelated records. Records retain source URLs and are never presented as fixture evidence.
- Claude runtime tools: six in-process MCP tools expose approved sources, bounded dynamic discovery, and collected evidence only. Built-in shell, filesystem, and arbitrary browsing tools are disabled.
- Direct Agent SDK `WebSearch`/`WebFetch` remain restricted, but Claude can call the controlled `discover_products` MCP tool. It uses Anthropic's Messages API Web Search with a two-search job cap, validates observed public HTTPS URLs, and sends only niche/price-filtered evidence into the existing pipeline. See [the web-research audit](docs/WEB_RESEARCH_AUDIT.md).
- Autonomous source selection: the dashboard asks only for niche, price range, and candidate count. The backend resolves compatible registry sources and Claude chooses among the approved MCP tools; no source selector is exposed to ordinary users.
- Live Claude path: a bounded smoke run has completed against Anthropic using the real Agent SDK, registered MCP tools, Playwright collection, validated structured output, SQLite persistence, and a `claude_agent` report (2 products, 18.3 seconds, $0.0305 estimated cost).
- Local worker: atomic job claiming, worker leases, cancellation requests, terminal states, events, costs, reports, and product evidence persist to `data/commerce-scout.db`.
- Dashboard: create a job, monitor genuine persisted status, inspect rankings and score charts, review limitations, view history, and download a CSV.

## Architecture

```text
Dashboard → Route Handlers → SQLite job record → research worker
                                               ├─ fixture or Playwright collection
                                               ├─ Claude SDK + in-process MCP tools (live only)
                                               └─ deterministic scoring → report/evidence → dashboard
```

See [architecture details](docs/ARCHITECTURE.md), [agent design](docs/AGENT_DESIGN.md), and [security guardrails](docs/SECURITY_AND_GUARDRAILS.md).

## Setup (Windows PowerShell)

Prerequisites: Node.js 20.18+ (this workspace was validated on Node 26), npm, and Playwright Chromium. PowerShell execution policy can block `npm.ps1`; use `npm.cmd` and `npx.cmd` below.

```powershell
npm.cmd install
npx.cmd playwright install chromium
Copy-Item .env.example .env.local
```

The default `.env.example` runs deterministic fixtures. Do not commit `.env.local` or anything under `data/`.

For live Claude runs, create an Anthropic API key in the Anthropic Console and set:

```text
ANTHROPIC_API_KEY=...
RESEARCH_MODE=live
```

The key stays server-only. The standalone worker loads `.env*` through `@next/env`; the Agent SDK itself receives the key through its process environment.

## Environment and safe live activation

`.env.example` is the committed reference. `.env.local` is local-only and ignored by Git. Do not put a key in any `NEXT_PUBLIC_*` variable.

Open the local file in Windows PowerShell and change only these two lines when you are ready for a live run:

```powershell
notepad .env.local
```

```text
ANTHROPIC_API_KEY=your_key_here
RESEARCH_MODE=live
```

The web server automatically loads `.env.local`. The separate worker and live smoke command call `loadEnvConfig(process.cwd())` from `@next/env`, so they receive the same server-only variables. `RESEARCH_MODE=fixtures` is the safe default. In live mode without a key, the UI shows **Live runtime blocked** and the API refuses to create a job.

Start the web app and persistent worker in two PowerShell windows:

```powershell
npm.cmd run dev
npm.cmd run worker
```

Restart the worker after pulling or changing research-agent code; the worker is
a long-lived Node process and does not hot-reload its MCP tool set.

After a key is present, this one-off command creates and processes only a new, small live electronics job. Leave the web app running, but stop or do not start the persistent worker while this command runs: the command is its own worker. It refuses when another job is pending/running and enforces the lower of your configured values or: 5 turns, $0.10 estimated API budget, 90 seconds, one browser page, two records, and the approved Web Scraper demonstration source.

```powershell
npm.cmd run smoke:live
```

It succeeds only after a real `claude_agent` report, persisted products, a validated structured output, and a logged `collect_products` MCP tool completion are present. It never prints the key. On either outcome it prints a sanitized summary of SDK initialization, observable Anthropic response state, invoked MCP tools, output validation, persistence, terminal status, duration, cost estimate, and failure category. The smoke command itself is the worker for this single request; do not run it until you accept the bounded Anthropic API and approved-source request.

## Run locally

Start these in separate PowerShell terminals:

```powershell
# Terminal 1
npm.cmd run dev

# Terminal 2
npm.cmd run worker
```

Open `http://localhost:3000`. Submit a fixture job, then leave the worker running to claim and process it.

## Testing and verification

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run test:browser
npm.cmd run test:e2e
npm.cmd run build
```

`test:browser` uses local HTML with Chromium. The external browser smoke test is intentionally skipped unless `RUN_LIVE_BROWSER_TESTS=true`; it never requires a Claude key. A real Claude tool-call run is available only in live mode with valid Anthropic credentials and is not claimed by the fixture suite.

## Important limitations

- Fixture records are clearly synthetic; they make no market, ad-performance, sales, or profitability claims.
- The Web Scraper source is a public demonstration catalog, not an authorized ad-intelligence integration.
- The SQLite MVP uses a local file lock and is designed for one local worker, not multi-host deployment.
- Public retailer adapters may change markup, availability, or prices. Searchable adapters can try new niches without a per-niche catalog entry, but a run may still return no matching evidence; the agent reports that limitation instead of substituting another category. Records are product-page evidence, not market-demand, sales, or profitability evidence.
- Dynamic discovery is now available through the bounded `anthropic-web-discovery` capability. It does not grant arbitrary browser navigation: only observable, validated search-result URLs become provenance, and Playwright remains restricted to registry-approved hosts.

## Verification status (2026-10-16)

- Fixture research is verified end to end: a request is queued, claimed by the worker, collected from local fixture data, deterministically scored, persisted, rendered, and exported.
- Playwright extraction is verified against deterministic local catalog markup and, with `RUN_LIVE_BROWSER_TESTS=true`, the approved public Web Scraper electronics catalog and Target skincare catalog. The production browser path remains restricted to registry-approved hosts; retailer availability can still change.
- The live SDK request, MCP registration, strict tool configuration, structured-output validation, cancellation, budget/turn error handling, duplicate-action limit, and no-progress guard have unit coverage. A bounded authenticated live Agent SDK run also completed end to end: Anthropic responded, all five approved MCP tools were registered, `collect_products` persisted two Playwright records, structured output validated, and the report was saved. The dashboard and worker share this same persisted execution path; one manual dashboard-triggered live run remains the final demonstration check.
- `npm audit` currently reports 12 advisories (2 critical, 9 high, 1 moderate), all through development/build tooling: Vitest/Tinypool, `eslint-config-next` globbing, and the shadcn CLI dependency tree. Available audit remediations require major-version changes; none were applied blindly. See the roadmap before deploying this project.

Read the [demo guide](docs/DEMO_GUIDE.md) for an interview walkthrough and [roadmap](docs/ROADMAP.md) for deliberately deferred capabilities.

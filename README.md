# CommerceScout AI

CommerceScout AI is an evidence-grounded e-commerce product-research MVP. It combines a Next.js dashboard, a separate local research worker, allowlisted Playwright catalog collection, deterministic scoring, local SQLite persistence, and a narrowly scoped Claude Agent SDK integration.

Codex develops and maintains this repository. At runtime, `@anthropic-ai/claude-agent-sdk` powers the optional Claude research agent; it is not replaced by an OpenAI agent framework.

## What works

- Fixture-mode research: synthetic skincare records are collected, normalized, deduplicated, filtered, scored, persisted, rendered, and exported as CSV without an API key.
- Browser collection: an allowlisted Playwright adapter can collect from the public Web Scraper demonstration catalog in live mode. It labels that catalog as electronics, never skincare.
- Claude runtime tools: five in-process MCP tools expose approved sources and collected evidence only. Built-in shell, filesystem, and arbitrary browsing tools are disabled.
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
- Live Claude execution has not been demonstrated in this environment because no Anthropic credential was supplied.

## Verification status (2026-10-16)

- Fixture research is verified end to end: a request is queued, claimed by the worker, collected from local fixture data, deterministically scored, persisted, rendered, and exported.
- Playwright extraction is verified against deterministic local catalog markup and the production browser path is restricted to the approved Web Scraper host. The optional external smoke test was not run here, so no real external product extraction is claimed.
- The live SDK request, MCP registration, strict tool configuration, structured-output validation, cancellation, budget/turn error handling, duplicate-action limit, and no-progress guard have unit coverage. A genuine Anthropic API-backed Claude tool call is blocked by the missing `ANTHROPIC_API_KEY` and is not represented as verified.
- `npm audit` currently reports 12 advisories (2 critical, 9 high, 1 moderate), all through development/build tooling: Vitest/Tinypool, `eslint-config-next` globbing, and the shadcn CLI dependency tree. Available audit remediations require major-version changes; none were applied blindly. See the roadmap before deploying this project.

Read the [demo guide](docs/DEMO_GUIDE.md) for an interview walkthrough and [roadmap](docs/ROADMAP.md) for deliberately deferred capabilities.

# Portfolio summary

CommerceScout AI is a bounded, evidence-first product-research application built with Next.js, TypeScript, SQLite, Playwright, and the Claude Agent SDK.

## Technical demonstration

- **Runtime separation:** Codex maintains the application; the runtime research agent is powered by `@anthropic-ai/claude-agent-sdk` with `ANTHROPIC_API_KEY` kept server-side.
- **Tool safety:** Claude receives five in-process MCP tools with strict names, an allowlist, no shell/filesystem tools, approved-source checks, cancellation, duplicate-action detection, and no-progress protection.
- **Browser automation:** Playwright is restricted to the approved Web Scraper demonstration catalog and returns normalized, deduplicated product evidence.
- **Structured output:** The SDK JSON schema and Zod validation reject malformed reports or findings that cite uncollected products.
- **Persistence:** A separate worker atomically claims jobs and stores status, event timeline, products, evidence, deterministic evaluations, report, elapsed time, and SDK cost estimate in SQLite.
- **Dashboard:** The UI distinguishes synthetic fixture data from live Claude data, shows progress and MCP events, exposes score breakdowns and limitations, retains history, and exports CSV.

## Verified live evidence

The successful bounded live run used the real Anthropic API and Agent SDK: five approved MCP tools registered, `collect_products` invoked Playwright, two electronics products were persisted, structured output validated, and a `claude_agent` report completed in 18.3 seconds with an estimated $0.0305 SDK cost.

The remaining demonstration boundary is intentional: run one manual live job from the dashboard to prove the queue/API path creates the same kind of worker execution. Do not run that paid check automatically.

## Interview talking points

1. Explain why tool access is narrower than general browser or shell access.
2. Show the persisted event timeline from SDK initialization through MCP collection and structured-output validation.
3. Compare fixture and live labels, then explain why the evidence score is not a demand or profitability prediction.
4. Point to the bounded turns, timeout, budget, browser-page, source, and no-progress safeguards.
5. Export the persisted report as CSV and discuss how failures remain inspectable without leaking credentials or raw model output.

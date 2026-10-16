# Web research capability audit

**Decision (2026-10-16): built-in WebSearch/WebFetch remain disabled.**

The installed `@anthropic-ai/claude-agent-sdk` is `0.3.301`. Its bundled
tool definitions include `WebSearch` and `WebFetch`, so the package can expose
those Claude server tools. Anthropic's current API supports domain allowlists
and a per-request `max_uses` limit for both tools:

- [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [Server-tool domain restrictions](https://platform.claude.com/docs/en/managed-agents/secure-deployment)

That capability is not sufficient for this application to enable the tools
safely today:

1. `lib/agent/research-agent.ts` deliberately passes `tools: []`,
   `strictMcpConfig: true`, `permissionMode: "dontAsk"`, and an explicit
   allowlist containing only the five in-process CommerceScout MCP tools. This
   is required by `AGENTS.md`; built-in browser, shell, and filesystem tools
   are not part of the runtime trust boundary.
2. The SDK's local `WebSearchInput` type exposes `query`, `allowed_domains`,
   and `blocked_domains`, but not the API-level `max_uses` field. Relying on a
   model-supplied field would not give the worker an independently enforced
   search budget. `canUseTool` is also not a workaround while `dontAsk` is in
   force: the SDK documents that `dontAsk` denies tools that are not already
   approved.
3. Web-search and web-fetch results arrive as SDK server-tool result messages,
   not as `ProductCandidate` records. Enabling them would require a new
   ingestion boundary that extracts only observable result URLs, re-validates
   every URL against SSRF/redirect/host policy, verifies product evidence, and
   persists provenance before the report can cite it. Passing a URL generated
   only by Claude to Playwright would violate that boundary.
4. `allowed_domains` must be selected before a search. Allowing arbitrary
   discovered domains would defeat the registry's destination authorization;
   allowing only pre-approved domains would still be a curated provider list,
   not unrestricted discovery.

## Current safe behavior

Claude is still the runtime researcher and orchestrator. It receives only the
registered MCP tools and can formulate a bounded search phrase for a
registry-approved searchable adapter. Playwright then navigates only to that
adapter's HTTPS host allowlist, filters observed products by the submitted
niche and price range, and returns source-page provenance. Deterministic
scoring and SQLite persistence remain downstream of that evidence.

This supports genuine query-driven discovery within approved provider
adapters, including niches that do not have a dedicated catalog category. It
does **not** claim arbitrary-web discovery. A run with no matching approved
provider returns a partial/empty result rather than substituting another
category.

## What would be required to enable built-in web tools later

This should be a separately reviewed feature, not a flag flip. It would need:

- an Agent SDK/API path that exposes a worker-enforced search/fetch quota;
- a server-side policy for approved domains and redirect validation;
- capture of WebSearch/WebFetch result blocks and an observable-URL ledger;
- a Playwright verification tool that accepts only ledger URLs;
- product-evidence schemas and persistence tests for server-tool results;
- prompt-injection handling for fetched page text and a cost/timeout budget;
- deterministic tests proving that unobserved, private, redirected, and
  out-of-policy URLs are rejected.

Until those controls exist, enabling `WebSearch` or `WebFetch` would make the
agent appear more capable while weakening the independently enforced security
and provenance guarantees. No live Anthropic request was made for this audit.

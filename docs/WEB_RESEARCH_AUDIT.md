# Web research capability audit

**Decision (2026-10-16): direct Agent SDK WebSearch/WebFetch remain disabled;
controlled Web Search discovery is enabled inside one backend MCP tool.**

The installed `@anthropic-ai/claude-agent-sdk` is `0.3.301`. Its bundled
tool definitions include `WebSearch` and `WebFetch`, so the package can expose
those Claude server tools. Anthropic's current API supports domain allowlists
and a per-request `max_uses` limit for both tools:

- [Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)
- [Web fetch tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool)
- [Server-tool domain restrictions](https://platform.claude.com/docs/en/managed-agents/secure-deployment)

The Agent SDK capability is not sufficient for the primary agent to enable
those tools directly, so the implementation keeps the agent's tool surface
MCP-only and exposes a bounded `discover_products` MCP tool. That tool makes a
separate Messages API request using the selected provider credential, requests
Anthropic's `web_search_20250305` server tool in direct mode or OpenRouter's
`openrouter:web_search` server tool in OpenRouter mode, has a maximum of two
searches, and validates every returned URL before creating candidates.

Direct Agent SDK WebSearch/WebFetch remain disabled because:

1. `lib/agent/research-agent.ts` deliberately passes `tools: []`,
   `strictMcpConfig: true`, `permissionMode: "dontAsk"`, and an explicit
   allowlist containing only the six in-process CommerceScout MCP tools. This
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
registered MCP tools and can formulate a bounded search phrase for
`discover_products`. The backend makes the nested Web Search request, treats
search text as untrusted, validates HTTPS/public-DNS result URLs, extracts
only observed title/snippet/price evidence, and filters candidates by niche
and price before returning them to Claude. Deterministic scoring and SQLite
persistence remain downstream of that evidence. Existing Playwright adapters
remain available as bounded fallbacks.

This supports genuine query-driven discovery for niches that do not have a
dedicated catalog category. Search-result URLs are provenance observations,
not implicit permission to navigate arbitrary pages. A run with no matching
evidence returns a partial/empty result rather than substituting another
category.

## Evidence-quality boundary (2026-10-17)

`discover_products` is a discovery capability, not product-page verification.
Only a result title, snippet, URL, and an explicitly observed price string are
retained. The request niche is never copied into a candidate category, every
meaningful niche term and the full requested price range are checked again on
the server, and unsafe URLs are discarded.

The scoring layer marks those records as `search_discovery`, caps them at
65/100, adds a product-page verification gap, and the dashboard and CSV expose
that scope. If every retained record came from Web Search, the worker forces
the agent report to `partial` even when the model returned `completed`.
Playwright is used only for registered browser adapters; it does not fetch a
dynamic result URL merely because Claude mentioned it.

MCP evidence operations are tracked until settled before the worker snapshots
candidates, costs, and the final report. This prevents a concurrently issued
Web Search result from arriving after job finalization. The search-use charge
and response token estimate are added to the Agent SDK estimate when Anthropic
returns usage metadata. A transport timeout cannot expose final server usage,
so it remains an explicitly uncertain cost outcome rather than a claim of zero
cost. In OpenRouter mode the fixed Exa Web Search cost is conservatively
reserved before the request from its bounded maximum result count; model-token
cost continues to be reported only when the Agent SDK exposes it. The Agent
SDK budget and the direct Web Search budget are independently
enforced; this local MVP does not yet have a provider-wide, in-flight aggregate
spend ledger. The two-search cap, output-token cap, timeout, and per-lane
budget still bound the request surface, but a production deployment should add
that ledger before treating the configured value as an absolute total bill cap.

## What would be required to enable built-in web tools later

This should be a separately reviewed feature, not a flag flip. It would need:

- a worker-enforced fetch quota if WebFetch is added;
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

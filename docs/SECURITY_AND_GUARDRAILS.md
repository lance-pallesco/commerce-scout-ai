# Security and guardrails

- Sources are server-side registry entries. Models cannot supply arbitrary URLs.
- Browser navigation requires HTTPS, an exact allowed host, public DNS addresses, standard HTTPS port, and an allowlisted final redirect target. Localhost, private networks, link-local/cloud-metadata ranges, local files, and non-HTTPS protocols are rejected.
- Playwright routes block out-of-registry requests and always close context/browser resources.
- Catalog fields are untrusted text. The agent prompt explicitly prohibits treating them as instructions; tests cover the instruction boundary.
- Agent SDK built-ins are disabled. The runtime gets only the five read-only MCP tools above—not Bash, file read/edit, unrestricted browser, or user/project MCP configuration.
- Turn, budget, timeout, tool timeout, duplicate action, collection size, page count, source, and concurrency limits are enforced in code. Cancellation uses an abort signal and a persisted cancellation flag.
- `ANTHROPIC_API_KEY` is parsed only from server process configuration; no `NEXT_PUBLIC_` variant exists. API responses and error handling never include it.
- Errors become accurate failed/partial/cancelled records. No failure path produces a fabricated success or invented evidence.
- Repeated zero-evidence collection is stopped by a dedicated no-progress action limit. A cancellation signal closes an active Playwright context before the browser is closed, rather than waiting for a navigation timeout.
- In live mode without a server-side key, the UI reports `live_agent_blocked` and the create-job route returns a configuration error before persisting an unusable job.
- Automatic source selection is an allowlisted registry operation, not an unrestricted discovery request. Searchable registry entries accept only a bounded query derived from the saved niche/objective, navigate only to registered HTTPS hosts, and are filtered for niche/price compatibility before persistence. The worker/MCP tools re-check source, mode, niche, price, cancellation, and action limits before collection.

Remaining limitations: local SQLite locking is not a distributed lock; external catalog terms can change; and this MVP has no authentication/rate limiting, so it must not be deployed as a public expensive-agent endpoint without an auth layer.

# Agent design

The live runtime agent uses `@anthropic-ai/claude-agent-sdk` and `query()`. It receives a custom system prompt requiring evidence/inference separation and structured draft output. SDK `tools` is an empty array, `strictMcpConfig` is enabled, settings sources are disabled, and the only auto-approved capabilities are these MCP tools:

- `list_research_sources`
- `collect_products`
- `get_product_details`
- `get_research_candidates`
- `get_research_criteria`

All tools use Zod schemas and execute in-process. They scope reads and collection to the active job's approved source IDs, input niche, candidate limit, price range, cancellation signal, and duplicate-action limit. Product detail access accepts an already discovered identifier, not an arbitrary URL. Recoverable failures return structured `isError` results without raw exceptions.

The agent must first read criteria and sources, collect an approved batch, inspect evidence, and return a structured completion/partial report. The report is rejected if it cites a product not collected for the job. Its narrative is supplemental only: deterministic scoring never accepts model-generated score values.

`maxTurns`, `maxBudgetUsd`, timeout abort, estimated result cost, and tool-action fingerprints form separate boundaries. See the official [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart), [custom tools guide](https://code.claude.com/docs/en/agent-sdk/custom-tools), [structured outputs guide](https://code.claude.com/docs/en/agent-sdk/structured-outputs), and [cost tracking guide](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

# Demo guide

1. Copy `.env.example` to `.env.local`; keep `RESEARCH_MODE=fixtures`.
2. In one PowerShell terminal run `npm.cmd run dev`.
3. In another run `npm.cmd run worker`.
4. Open `http://localhost:3000`, enter skincare / 15–60 USD / 5 candidates, and start research. No source selector is required; Claude and the registry handle source selection.
5. Show that the job initially remains genuinely pending until the worker claims it. Then show collection, deterministic scoring, persisted history, missing-field badges, chart, and CSV download.
6. Explain that “Synthetic fixture data” is deliberate: it demonstrates the full workflow but makes no live market claims.
7. Request cancellation for a running live job to demonstrate the persisted flag and terminal cancelled state.
8. To demonstrate Claude tools, set `RESEARCH_MODE=live`, set a valid `ANTHROPIC_API_KEY`, restart both processes, enter an approved niche, and inspect persisted tool events. The bounded smoke run has already verified the Agent SDK/MCP/Playwright path; a dashboard-triggered run is still the final manual demonstration check.

The dashboard distinguishes fixture, live-ready, and live-blocked runtime states. In a completed run, show the persisted execution timeline, collected-record count, evidence coverage, score criterion charts, source links, limitations, and CSV. Scores are evidence-completeness rankings only, never a demand or profitability prediction.

The verified portfolio walkthrough includes the fixture workflow, local and approved-source Playwright extraction tests, and a successful bounded live smoke run. That live run reached Anthropic, registered five approved MCP tools, collected two products with Playwright, validated structured output, persisted a `claude_agent` report, and completed in 18.3 seconds at an estimated $0.0305. Do not present the smoke evidence as a dashboard-triggered run until you perform the final manual check below.

For a safeguard demo, use the unit test `npm.cmd run test:unit` to show the duplicate tool-action and unapproved-source protections. For browser controls, show `npm.cmd run test:browser` and describe the allowlisted host/DNS checks.

## Windows live smoke test

1. Run `notepad .env.local` and set a real `ANTHROPIC_API_KEY` plus `RESEARCH_MODE=live`. `.env.local` is Git-ignored; do not add the key to a `NEXT_PUBLIC_*` variable.
2. Ensure the dashboard has no pending or running research job, and stop or do not start the persistent `npm.cmd run worker` process: the smoke command is its own one-off worker.
3. Run `npm.cmd run smoke:live` from the repository root.
4. The command uses the real separate-worker path with a 5-turn / $0.10 / 90-second / one-page cap, two electronics records, and only the approved Web Scraper source. It verifies a persisted `claude_agent` report, validated structured output, products, and a `collect_products` MCP event before reporting success. A safe summary identifies the exact failed boundary without revealing credentials or raw model output.
5. Use the printed job ID in the dashboard history to inspect the source evidence and tool-event trail. The dashboard should show the Live Claude badge, model/turn cap, collected records, estimated cost, persisted MCP timeline, rankings, limitations, and CSV export.

## Final dashboard verification

After the bounded smoke run, leave the web app and persistent worker running, enter **electronics**, and submit a two-candidate request. This is the only remaining manual paid check because the dashboard queues the same live worker path but creates a new Anthropic job. Confirm the job reaches completed, then inspect its events, report, rankings, history, and CSV before showing it in a portfolio demo. A skincare run through the registered Target catalog requires a separate manual provider check; never describe it as verified from fixtures.

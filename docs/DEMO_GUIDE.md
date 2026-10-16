# Demo guide

1. Copy `.env.example` to `.env.local`; keep `RESEARCH_MODE=fixtures`.
2. In one PowerShell terminal run `npm.cmd run dev`.
3. In another run `npm.cmd run worker`.
4. Open `http://localhost:3000`, leave skincare / 15–60 USD / fixture source selected, and start research.
5. Show that the job initially remains genuinely pending until the worker claims it. Then show collection, deterministic scoring, persisted history, missing-field badges, chart, and CSV download.
6. Explain that “Synthetic fixture data” is deliberate: it demonstrates the full workflow but makes no live market claims.
7. Request cancellation for a running live job to demonstrate the persisted flag and terminal cancelled state.
8. To demonstrate Claude tools, set `RESEARCH_MODE=live`, set a valid `ANTHROPIC_API_KEY`, choose the electronics demo source, restart both processes, and inspect persisted tool events. Only claim this step after observing a real run.

The dashboard distinguishes fixture, live-ready, and live-blocked runtime states. In a completed run, show the persisted execution timeline, collected-record count, evidence coverage, score criterion charts, source links, limitations, and CSV. Scores are evidence-completeness rankings only, never a demand or profitability prediction.

The verified portfolio walkthrough is the fixture workflow plus local and approved-source Playwright extraction tests. An initial authenticated smoke run reached Claude and its MCP tools but failed before collection because of a corrected Playwright launcher binding defect; an interviewer-facing live-agent demonstration still requires a newly successful bounded run.

For a safeguard demo, use the unit test `npm.cmd run test:unit` to show the duplicate tool-action and unapproved-source protections. For browser controls, show `npm.cmd run test:browser` and describe the allowlisted host/DNS checks.

## Windows live smoke test

1. Run `notepad .env.local` and set a real `ANTHROPIC_API_KEY` plus `RESEARCH_MODE=live`. `.env.local` is Git-ignored; do not add the key to a `NEXT_PUBLIC_*` variable.
2. Ensure the dashboard has no pending or running research job, and stop or do not start the persistent `npm.cmd run worker` process: the smoke command is its own one-off worker.
3. Run `npm.cmd run smoke:live` from the repository root.
4. The command uses the real separate-worker path with a 5-turn / $0.10 / 90-second / one-page cap, two electronics records, and only the approved Web Scraper source. It verifies a persisted `claude_agent` report, validated structured output, products, and a `collect_products` MCP event before reporting success. A safe summary identifies the exact failed boundary without revealing credentials or raw model output.
5. Use the printed job ID in the dashboard history to inspect the source evidence and tool-event trail. A failed command is not a verified live demonstration.

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

This environment has not run step 8. The verified portfolio walkthrough is the fixture workflow plus local Playwright extraction tests; an interviewer-facing live-agent demonstration requires a bounded real run with a valid key and the documented electronics source.

For a safeguard demo, use the unit test `npm.cmd run test:unit` to show the duplicate tool-action and unapproved-source protections. For browser controls, show `npm.cmd run test:browser` and describe the allowlisted host/DNS checks.

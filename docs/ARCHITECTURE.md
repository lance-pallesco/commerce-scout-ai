# Architecture

```mermaid
flowchart LR
  UI[Next.js dashboard] --> API[Route Handlers]
  API --> DB[(Local SQLite file)]
  Worker[Separate Node worker] --> DB
  Worker --> Collect[Fixture or Playwright collection]
  Worker --> Score[Deterministic scoring]
  Worker --> Agent[Claude Agent SDK, live mode]
  Agent --> MCP[In-process, allowlisted MCP research tools]
  MCP --> Collect
  Score --> DB
  Agent --> DB
  DB --> API
```

Presentation components use API responses only. Route Handlers validate requests and create/read job records; they do not run long browser or model work. The worker claims one pending job under a local database lock, owns a lease, records events, observes cancellation, and writes terminal state.

`sql.js` supplies SQLite without a native Windows compiler requirement. Each operation acquires an adjacent lock file, migrates the schema if required, writes an atomic temporary database file, then replaces the database. This is suitable for the single-worker local MVP only.

The live worker runs the real Agent SDK `query()` entry point with no built-in tools, strict MCP configuration, a bounded model budget/turn count, and an abort controller. Fixture mode deliberately uses a deterministic pipeline when no API key exists; it is never represented as Claude execution.

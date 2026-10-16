import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import initSqlJs, { type Database, type SqlValue } from "sql.js";

import type { ServerConfig } from "@/lib/config/env";

const LOCK_RETRY_MS = 25;
const LOCK_MAX_ATTEMPTS = 200;
const STALE_LOCK_MS = 5 * 60 * 1_000;

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `,
  `
    CREATE TABLE IF NOT EXISTS research_jobs (
      id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      progress_percent INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      cancellation_requested_at TEXT,
      error_code TEXT,
      sanitized_error_message TEXT,
      agent_model TEXT NOT NULL,
      maximum_turns INTEGER NOT NULL,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      elapsed_time_ms INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_research_jobs_status_created
      ON research_jobs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_research_jobs_lease
      ON research_jobs(status, lease_expires_at);

    CREATE TABLE IF NOT EXISTS research_products (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      product_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_products_job_id ON research_products(job_id);

    CREATE TABLE IF NOT EXISTS product_evidence (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL REFERENCES research_products(id) ON DELETE CASCADE,
      evidence_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_evidence_product_id ON product_evidence(product_id);

    CREATE TABLE IF NOT EXISTS product_evaluations (
      product_id TEXT PRIMARY KEY REFERENCES research_products(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      evaluation_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_product_evaluations_job_id ON product_evaluations(job_id);

    CREATE TABLE IF NOT EXISTS research_events (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_events_job_id_created
      ON research_events(job_id, created_at);

    CREATE TABLE IF NOT EXISTS research_reports (
      job_id TEXT PRIMARY KEY REFERENCES research_jobs(id) ON DELETE CASCADE,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
];

let sqlPromise: ReturnType<typeof initSqlJs> | undefined;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getDatabasePath(databaseUrl: string): string {
  const match = /^file:\.\/data\/([a-zA-Z0-9._-]+\.db)$/.exec(databaseUrl);
  if (!match) {
    throw new Error("DATABASE_URL must point to a database inside ./data.");
  }
  return path.join(process.cwd(), "data", match[1]);
}

async function getSql() {
  sqlPromise ??= initSqlJs({
    locateFile: (file) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });
  return sqlPromise;
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx");
      await lock.writeFile(`${process.pid}:${randomUUID()}`);
      return async () => {
        await lock.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const lockStats = await stat(lockPath);
        if (Date.now() - lockStats.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  throw new Error("Timed out while waiting for the local research database lock.");
}

function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    database
      .exec("SELECT version FROM schema_migrations")[0]
      ?.values.map(([version]) => Number(version)) ?? [],
  );

  migrations.forEach((migration, index) => {
    const version = index + 1;
    if (applied.has(version)) return;
    database.exec("BEGIN");
    try {
      database.exec(migration);
      database.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        version,
        new Date().toISOString(),
      ]);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
}

function backfillObservedJobCosts(database: Database): void {
  const rows = queryRows(
    database,
    `SELECT jobs.id, events.detail
       FROM research_jobs AS jobs
       JOIN research_events AS events ON events.job_id = jobs.id
      WHERE jobs.estimated_cost_usd = 0
        AND events.type = 'agent_terminal_result'
      ORDER BY events.created_at DESC`,
  );
  const updated = new Set<string>();
  for (const row of rows) {
    const jobId = typeof row.id === "string" ? row.id : null;
    const detail = typeof row.detail === "string" ? row.detail : null;
    if (!jobId || updated.has(jobId) || !detail) continue;
    const match = detail.match(/\b(\d+(?:\.\d{1,6})?)\s+USD estimated\b/);
    const cost = match ? Number(match[1]) : NaN;
    if (!Number.isFinite(cost) || cost < 0) continue;
    database.run(
      "UPDATE research_jobs SET estimated_cost_usd = ? WHERE id = ? AND estimated_cost_usd = 0",
      [cost, jobId],
    );
    updated.add(jobId);
  }
}

export async function withDatabase<T>(
  config: Pick<ServerConfig, "databaseUrl">,
  operation: (database: Database) => Promise<T> | T,
): Promise<T> {
  const databasePath = getDatabasePath(config.databaseUrl);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const releaseLock = await acquireLock(`${databasePath}.lock`);
  let database: Database | undefined;

  try {
    const Sql = await getSql();
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFile(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    database = bytes ? new Sql.Database(bytes) : new Sql.Database();
    database.exec("PRAGMA foreign_keys = ON");
    runMigrations(database);
    backfillObservedJobCosts(database);
    const result = await operation(database);
    const temporaryPath = `${databasePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, database.export());
    await rename(temporaryPath, databasePath);
    return result;
  } finally {
    database?.close();
    await releaseLock();
  }
}

export function queryRows(
  database: Database,
  sql: string,
  values: SqlValue[] = [],
): Record<string, SqlValue>[] {
  const statement = database.prepare(sql, values);
  const rows: Record<string, SqlValue>[] = [];
  try {
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
  } finally {
    statement.free();
  }
  return rows;
}

import { randomUUID } from "node:crypto";
import type { Database, SqlValue } from "sql.js";

import { assertLiveResearchAvailable, type ServerConfig } from "@/lib/config/env";
import type { AgentResearchReport } from "@/lib/agent/contracts";
import type { ProductCandidate, ResearchRequest } from "@/lib/research/contracts";
import type { ProductEvaluation } from "@/lib/scoring/score-product";
import { queryRows, withDatabase } from "@/lib/persistence/database";
import {
  assertSourceSupportsNiche,
  getResearchSource,
} from "@/lib/research/source-registry";

import {
  PersistedEventSchema,
  PersistedReportSchema,
  ResearchJobSchema,
  assertJobTransition,
  type PersistedEvent,
  type PersistedReport,
  type ResearchJob,
  type ResearchJobStage,
  type ResearchJobStatus,
} from "./contracts";

type DatabaseRow = Record<string, SqlValue>;

function asString(value: SqlValue): string {
  if (typeof value !== "string") throw new Error("Unexpected local database value.");
  return value;
}

function optionalString(value: SqlValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: SqlValue): number {
  if (typeof value !== "number") throw new Error("Unexpected local database value.");
  return value;
}

function parseJob(row: DatabaseRow): ResearchJob {
  return ResearchJobSchema.parse({
    id: asString(row.id),
    request: JSON.parse(asString(row.request_json)),
    status: asString(row.status),
    currentStage: asString(row.current_stage),
    progressPercent: asNumber(row.progress_percent),
    createdAt: asString(row.created_at),
    startedAt: optionalString(row.started_at),
    completedAt: optionalString(row.completed_at),
    cancellationRequestedAt: optionalString(row.cancellation_requested_at),
    errorCode: optionalString(row.error_code),
    sanitizedErrorMessage: optionalString(row.sanitized_error_message),
    agentModel: asString(row.agent_model),
    maximumTurns: asNumber(row.maximum_turns),
    estimatedCostUsd: asNumber(row.estimated_cost_usd),
    elapsedTimeMs: asNumber(row.elapsed_time_ms),
    workerId: optionalString(row.worker_id),
    leaseExpiresAt: optionalString(row.lease_expires_at),
  });
}

function jobRow(database: Database, id: string): ResearchJob | null {
  const [row] = queryRows(database, "SELECT * FROM research_jobs WHERE id = ?", [id]);
  return row ? parseJob(row) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeFailure(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000);
  }
  return "The research job could not complete.";
}

export class JobNotFoundError extends Error {
  readonly code = "JOB_NOT_FOUND";

  constructor() {
    super("The requested research job was not found.");
    this.name = "JobNotFoundError";
  }
}

export async function createResearchJob(
  request: ResearchRequest,
  config: ServerConfig,
): Promise<ResearchJob> {
  if (request.mode !== config.researchMode) {
    throw new Error("The requested research mode does not match the configured server mode.");
  }
  if (request.mode === "live") {
    assertLiveResearchAvailable(config);
  }
  for (const sourceId of request.sourceIds) {
    const source = getResearchSource(sourceId, request.mode);
    assertSourceSupportsNiche(source, request.niche);
  }

  const job: ResearchJob = {
    id: randomUUID(),
    request,
    status: "pending",
    currentStage: "queued",
    progressPercent: 0,
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    cancellationRequestedAt: null,
    errorCode: null,
    sanitizedErrorMessage: null,
    agentModel: config.agentModel,
    maximumTurns: config.agentMaxTurns,
    estimatedCostUsd: 0,
    elapsedTimeMs: 0,
    workerId: null,
    leaseExpiresAt: null,
  };

  await withDatabase(config, (database) => {
    database.run(
      `INSERT INTO research_jobs (
        id, request_json, status, current_stage, progress_percent, created_at,
        started_at, completed_at, cancellation_requested_at, error_code,
        sanitized_error_message, agent_model, maximum_turns, estimated_cost_usd,
        elapsed_time_ms, worker_id, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        JSON.stringify(job.request),
        job.status,
        job.currentStage,
        job.progressPercent,
        job.createdAt,
        null,
        null,
        null,
        null,
        null,
        job.agentModel,
        job.maximumTurns,
        job.estimatedCostUsd,
        job.elapsedTimeMs,
        null,
        null,
      ],
    );
  });
  await appendJobEvent(config, job.id, "job_created", "Research job queued.");
  const sourceNames = request.sourceIds.map((sourceId) => getResearchSource(sourceId, request.mode).name);
  await appendJobEvent(
    config,
    job.id,
    "source_selection",
    request.sourceSelection === "automatic"
      ? `Automatic source selection enabled for ${sourceNames.length} compatible source${sourceNames.length === 1 ? "" : "s"}: ${sourceNames.join(", ")}.`
      : `Manual approved source selected: ${sourceNames[0]}.`,
  );
  return job;
}

export async function getResearchJob(
  config: ServerConfig,
  jobId: string,
): Promise<ResearchJob | null> {
  return withDatabase(config, (database) => jobRow(database, jobId));
}

export async function listResearchJobs(
  config: ServerConfig,
  limit = 30,
): Promise<ResearchJob[]> {
  return withDatabase(config, (database) =>
    queryRows(
      database,
      "SELECT * FROM research_jobs ORDER BY created_at DESC LIMIT ?",
      [Math.min(Math.max(limit, 1), 100)],
    ).map(parseJob),
  );
}

export async function appendJobEvent(
  config: ServerConfig,
  jobId: string,
  type: string,
  detail?: string,
): Promise<PersistedEvent> {
  const event: PersistedEvent = {
    id: randomUUID(),
    jobId,
    type: type.slice(0, 120),
    detail: detail?.slice(0, 1_000) ?? null,
    createdAt: nowIso(),
  };
  await withDatabase(config, (database) => {
    if (!jobRow(database, jobId)) throw new JobNotFoundError();
    database.run(
      "INSERT INTO research_events (id, job_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)",
      [event.id, event.jobId, event.type, event.detail, event.createdAt],
    );
  });
  return PersistedEventSchema.parse(event);
}

export async function getJobEvents(
  config: ServerConfig,
  jobId: string,
): Promise<PersistedEvent[]> {
  return withDatabase(config, (database) =>
    queryRows(
      database,
      "SELECT id, job_id, type, detail, created_at FROM research_events WHERE job_id = ? ORDER BY created_at ASC",
      [jobId],
    ).map((row) =>
      PersistedEventSchema.parse({
        id: asString(row.id),
        jobId: asString(row.job_id),
        type: asString(row.type),
        detail: optionalString(row.detail),
        createdAt: asString(row.created_at),
      }),
    ),
  );
}

export async function claimNextResearchJob(
  config: ServerConfig,
  workerId: string,
): Promise<ResearchJob | null> {
  return withDatabase(config, (database) => {
    const running = queryRows(
      database,
      "SELECT id FROM research_jobs WHERE status = 'running' AND lease_expires_at > ? LIMIT 1",
      [nowIso()],
    );
    if (running.length >= config.maxConcurrentResearchJobs) return null;

    let candidate = queryRows(
      database,
      "SELECT * FROM research_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
    )[0];
    while (candidate && candidate.cancellation_requested_at) {
      database.run(
        `UPDATE research_jobs
          SET status = 'cancelled', current_stage = 'completed', progress_percent = 100,
            completed_at = ?, lease_expires_at = NULL
          WHERE id = ?`,
        [nowIso(), asString(candidate.id)],
      );
      candidate = queryRows(
        database,
        "SELECT * FROM research_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1",
      )[0];
    }
    if (!candidate) return null;

    const job = parseJob(candidate);
    assertJobTransition(job.status, "running");
    const startedAt = nowIso();
    const leaseExpiresAt = new Date(Date.now() + config.agentTimeoutMs + 30_000).toISOString();
    database.run(
      `UPDATE research_jobs
        SET status = 'running', current_stage = 'collecting', progress_percent = 5,
          started_at = ?, worker_id = ?, lease_expires_at = ?
        WHERE id = ? AND status = 'pending'`,
      [startedAt, workerId.slice(0, 160), leaseExpiresAt, job.id],
    );
    return jobRow(database, job.id);
  });
}

export async function updateJobProgress(
  config: ServerConfig,
  jobId: string,
  input: { currentStage: ResearchJobStage; progressPercent: number; workerId?: string },
): Promise<ResearchJob> {
  return withDatabase(config, (database) => {
    const job = jobRow(database, jobId);
    if (!job) throw new JobNotFoundError();
    if (job.status !== "running") return job;
    if (input.workerId && job.workerId !== input.workerId) {
      throw new Error("The worker does not own this research job.");
    }
    const progress = Math.min(Math.max(input.progressPercent, job.progressPercent), 99);
    database.run(
      "UPDATE research_jobs SET current_stage = ?, progress_percent = ? WHERE id = ?",
      [input.currentStage, progress, jobId],
    );
    return jobRow(database, jobId)!;
  });
}

export async function renewJobLease(
  config: ServerConfig,
  jobId: string,
  workerId: string,
): Promise<void> {
  await withDatabase(config, (database) => {
    database.run(
      "UPDATE research_jobs SET lease_expires_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
      [new Date(Date.now() + config.agentTimeoutMs + 30_000).toISOString(), jobId, workerId],
    );
  });
}

export async function requestResearchJobCancellation(
  config: ServerConfig,
  jobId: string,
): Promise<ResearchJob> {
  return withDatabase(config, (database) => {
    const job = jobRow(database, jobId);
    if (!job) throw new JobNotFoundError();
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) return job;
    const requestedAt = nowIso();
    if (job.status === "pending") {
      database.run(
        `UPDATE research_jobs
          SET cancellation_requested_at = ?, status = 'cancelled', current_stage = 'completed',
            progress_percent = 100, completed_at = ? WHERE id = ?`,
        [requestedAt, requestedAt, jobId],
      );
    } else {
      database.run(
        "UPDATE research_jobs SET cancellation_requested_at = ? WHERE id = ?",
        [requestedAt, jobId],
      );
    }
    return jobRow(database, jobId)!;
  });
}

export async function isCancellationRequested(
  config: ServerConfig,
  jobId: string,
): Promise<boolean> {
  const job = await getResearchJob(config, jobId);
  return Boolean(job?.cancellationRequestedAt);
}

export async function finishResearchJob(
  config: ServerConfig,
  jobId: string,
  input: {
    status: Extract<ResearchJobStatus, "completed" | "partial" | "failed" | "cancelled">;
    estimatedCostUsd?: number;
    elapsedTimeMs?: number;
    errorCode?: string;
    sanitizedErrorMessage?: string;
  },
): Promise<ResearchJob> {
  return withDatabase(config, (database) => {
    const job = jobRow(database, jobId);
    if (!job) throw new JobNotFoundError();
    if (job.status !== input.status) assertJobTransition(job.status, input.status);
    const completedAt = nowIso();
    database.run(
      `UPDATE research_jobs
        SET status = ?, current_stage = 'completed', progress_percent = 100, completed_at = ?,
          estimated_cost_usd = ?, elapsed_time_ms = ?, error_code = ?, sanitized_error_message = ?,
          lease_expires_at = NULL
        WHERE id = ?`,
      [
        input.status,
        completedAt,
        input.estimatedCostUsd ?? job.estimatedCostUsd,
        input.elapsedTimeMs ?? job.elapsedTimeMs,
        input.errorCode?.slice(0, 120) ?? null,
        input.sanitizedErrorMessage?.slice(0, 1_000) ?? null,
        jobId,
      ],
    );
    return jobRow(database, jobId)!;
  });
}

export async function recoverInterruptedResearchJobs(config: ServerConfig): Promise<number> {
  return withDatabase(config, (database) => {
    const expired = queryRows(
      database,
      "SELECT id FROM research_jobs WHERE status = 'running' AND lease_expires_at <= ?",
      [nowIso()],
    );
    for (const row of expired) {
      database.run(
        `UPDATE research_jobs
          SET status = 'failed', current_stage = 'completed', progress_percent = 100,
            completed_at = ?, error_code = 'WORKER_INTERRUPTED',
            sanitized_error_message = 'Research stopped because its worker lease expired.',
            lease_expires_at = NULL
          WHERE id = ?`,
        [nowIso(), asString(row.id)],
      );
    }
    return expired.length;
  });
}

export async function persistResearchResults(
  config: ServerConfig,
  jobId: string,
  products: readonly ProductCandidate[],
  evaluations: readonly ProductEvaluation[],
): Promise<void> {
  await withDatabase(config, (database) => {
    if (!jobRow(database, jobId)) throw new JobNotFoundError();
    database.run("DELETE FROM research_products WHERE job_id = ?", [jobId]);
    const evaluationByProductId = new Map(evaluations.map((evaluation) => [evaluation.productId, evaluation]));
    for (const product of products) {
      const createdAt = nowIso();
      database.run(
        "INSERT INTO research_products (id, job_id, product_json, created_at) VALUES (?, ?, ?, ?)",
        [product.id, jobId, JSON.stringify(product), createdAt],
      );
      for (const evidence of product.evidence) {
        database.run(
          "INSERT INTO product_evidence (id, job_id, product_id, evidence_json, created_at) VALUES (?, ?, ?, ?, ?)",
          [randomUUID(), jobId, product.id, JSON.stringify(evidence), createdAt],
        );
      }
      const evaluation = evaluationByProductId.get(product.id);
      if (evaluation) {
        database.run(
          "INSERT INTO product_evaluations (product_id, job_id, evaluation_json, created_at) VALUES (?, ?, ?, ?)",
          [product.id, jobId, JSON.stringify(evaluation), createdAt],
        );
      }
    }
  });
}

export async function getResearchProducts(
  config: ServerConfig,
  jobId: string,
): Promise<Array<{ product: ProductCandidate; evaluation: ProductEvaluation | null }>> {
  return withDatabase(config, (database) =>
    queryRows(
      database,
      `SELECT products.product_json, evaluations.evaluation_json
        FROM research_products AS products
        LEFT JOIN product_evaluations AS evaluations ON evaluations.product_id = products.id
        WHERE products.job_id = ?`,
      [jobId],
    ).map((row) => ({
      product: JSON.parse(asString(row.product_json)) as ProductCandidate,
      evaluation: row.evaluation_json
        ? (JSON.parse(asString(row.evaluation_json)) as ProductEvaluation)
        : null,
    })),
  );
}

export async function persistResearchReport(
  config: ServerConfig,
  jobId: string,
  report: {
    mode: "deterministic_fixture" | "claude_agent";
    agentReport?: AgentResearchReport;
    limitations: string[];
  },
): Promise<PersistedReport> {
  const persisted: PersistedReport = {
    jobId,
    report,
    createdAt: nowIso(),
  };
  await withDatabase(config, (database) => {
    if (!jobRow(database, jobId)) throw new JobNotFoundError();
    database.run(
      `INSERT INTO research_reports (job_id, report_json, created_at) VALUES (?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET report_json = excluded.report_json, created_at = excluded.created_at`,
      [jobId, JSON.stringify(report), persisted.createdAt],
    );
  });
  return PersistedReportSchema.parse(persisted);
}

export async function getResearchReport(
  config: ServerConfig,
  jobId: string,
): Promise<PersistedReport | null> {
  return withDatabase(config, (database) => {
    const [row] = queryRows(
      database,
      "SELECT job_id, report_json, created_at FROM research_reports WHERE job_id = ?",
      [jobId],
    );
    if (!row) return null;
    return PersistedReportSchema.parse({
      jobId: asString(row.job_id),
      report: JSON.parse(asString(row.report_json)),
      createdAt: asString(row.created_at),
    });
  });
}

export function sanitizeJobFailure(error: unknown): string {
  return sanitizeFailure(error);
}

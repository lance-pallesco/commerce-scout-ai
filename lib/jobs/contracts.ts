import { z } from "zod";

import { ResearchRequestSchema } from "@/lib/research/contracts";

export const ResearchJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
export const ResearchJobStageSchema = z.enum([
  "queued",
  "collecting",
  "analyzing",
  "scoring",
  "finalizing",
  "completed",
]);

export type ResearchJobStatus = z.infer<typeof ResearchJobStatusSchema>;
export type ResearchJobStage = z.infer<typeof ResearchJobStageSchema>;

export const ResearchJobSchema = z.object({
  id: z.string().uuid(),
  request: ResearchRequestSchema,
  status: ResearchJobStatusSchema,
  currentStage: ResearchJobStageSchema,
  progressPercent: z.number().int().min(0).max(100),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  cancellationRequestedAt: z.string().datetime().nullable(),
  errorCode: z.string().max(120).nullable(),
  sanitizedErrorMessage: z.string().max(1_000).nullable(),
  agentModel: z.string().max(120),
  maximumTurns: z.number().int().positive(),
  estimatedCostUsd: z.number().finite().nonnegative(),
  elapsedTimeMs: z.number().int().nonnegative(),
  workerId: z.string().max(160).nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
});

export type ResearchJob = z.infer<typeof ResearchJobSchema>;

export const PersistedEventSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  type: z.string().min(1).max(120),
  detail: z.string().max(1_000).nullable(),
  createdAt: z.string().datetime(),
});

export type PersistedEvent = z.infer<typeof PersistedEventSchema>;

export const PersistedReportSchema = z.object({
  jobId: z.string().uuid(),
  report: z.unknown(),
  createdAt: z.string().datetime(),
});

export type PersistedReport = z.infer<typeof PersistedReportSchema>;

const allowedTransitions: Readonly<Record<ResearchJobStatus, readonly ResearchJobStatus[]>> = {
  pending: ["running", "failed", "cancelled"],
  running: ["completed", "partial", "failed", "cancelled"],
  completed: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export function assertJobTransition(
  current: ResearchJobStatus,
  next: ResearchJobStatus,
): void {
  if (!allowedTransitions[current].includes(next)) {
    throw new Error(`Invalid research-job transition from ${current} to ${next}.`);
  }
}

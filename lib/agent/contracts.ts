import { z } from "zod";

export const AgentProductFindingSchema = z.object({
  productId: z.string().min(1).max(160),
  summary: z.string().trim().min(1).max(1_500),
  customerAppeal: z.string().trim().min(1).max(1_000),
  differentiationConsiderations: z.array(z.string().trim().min(1).max(500)).max(8),
  risks: z.array(z.string().trim().min(1).max(500)).max(8),
  missingInformation: z.array(z.string().trim().min(1).max(200)).max(12),
  confidence: z.enum(["high", "medium", "low"]),
});

export const AgentResearchReportSchema = z.object({
  completion: z.enum(["completed", "partial"]),
  executiveSummary: z.string().trim().min(1).max(2_000),
  limitations: z.array(z.string().trim().min(1).max(800)).max(15),
  findings: z.array(AgentProductFindingSchema).max(50),
});

export type AgentProductFinding = z.infer<typeof AgentProductFindingSchema>;
export type AgentResearchReport = z.infer<typeof AgentResearchReportSchema>;

export const AgentReportJsonSchema = z.toJSONSchema(AgentResearchReportSchema, {
  target: "draft-7",
});

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getServerConfig } from "@/lib/config/env";
import { AgentResearchReportSchema } from "@/lib/agent/contracts";
import {
  appendJobEvent,
  claimNextResearchJob,
  createResearchJob,
  finishResearchJob,
  getJobEvents,
  getResearchJob,
  getResearchProducts,
  getResearchReport,
  persistResearchResults,
  requestResearchJobCancellation,
} from "@/lib/jobs/repository";
import { reconcileVerifiedResearchReport, runResearchWorkerOnce } from "@/lib/jobs/worker";
import { ResearchRequestSchema } from "@/lib/research/contracts";
import { collectFixtureProducts } from "@/lib/research/fixture-source";
import { evaluateProducts } from "@/lib/scoring/score-product";

const databaseFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    databaseFiles.splice(0).flatMap((file) => [
      rm(file, { force: true }),
      rm(`${file}.lock`, { force: true }),
    ]),
  );
});

function testConfig() {
  const fileName = `commerce-scout-test-${randomUUID()}.db`;
  const databasePath = path.resolve(process.cwd(), "data", fileName);
  databaseFiles.push(databasePath);
  return getServerConfig({
    RESEARCH_MODE: "fixtures",
    DATABASE_URL: `file:./data/${fileName}`,
  });
}

function testRequest() {
  return ResearchRequestSchema.parse({
    niche: "skincare",
    minimumPrice: 15,
    maximumPrice: 60,
    requestedProductCount: 5,
    sourceIds: ["fixture-skincare-catalog"],
    mode: "fixtures",
    objective: "Identify evidence-backed skincare candidates worth further investigation.",
  });
}

describe("SQLite research jobs", () => {
  it("persists jobs and atomically lets only one worker claim the pending job", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);

    const [firstClaim, secondClaim] = await Promise.all([
      claimNextResearchJob(config, "worker-a"),
      claimNextResearchJob(config, "worker-b"),
    ]);

    expect([firstClaim, secondClaim].filter(Boolean)).toHaveLength(1);
    const persisted = await getResearchJob(config, job.id);
    expect(persisted).toMatchObject({ status: "running", currentStage: "collecting" });
    expect((await getJobEvents(config, job.id))[0]).toMatchObject({ type: "job_created" });
  });

  it("honors a cancellation request for a running job", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);
    await claimNextResearchJob(config, "worker-a");

    const cancelled = await requestResearchJobCancellation(config, job.id);
    expect(cancelled.cancellationRequestedAt).toBeTruthy();
    expect(cancelled.status).toBe("running");
  });

  it("runs a complete deterministic fixture job through the separate worker flow", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);

    await expect(runResearchWorkerOnce(config, "fixture-worker")).resolves.toMatchObject({
      processedJobId: job.id,
    });

    const completed = await getResearchJob(config, job.id);
    const products = await getResearchProducts(config, job.id);
    const report = await getResearchReport(config, job.id);
    expect(completed).toMatchObject({ status: "completed", progressPercent: 100 });
    expect(products).toHaveLength(3);
    expect(products[0].evaluation?.score.total).toBeGreaterThan(0);
    expect(report?.report).toMatchObject({ mode: "deterministic_fixture" });
  });

  it("uses job-scoped database identities for repeated source products", async () => {
    const config = testConfig();
    const first = await createResearchJob(testRequest(), config);
    const second = await createResearchJob(testRequest(), config);

    await runResearchWorkerOnce(config, "fixture-worker-a");
    await runResearchWorkerOnce(config, "fixture-worker-b");

    expect(await getResearchJob(config, first.id)).toMatchObject({ status: "completed" });
    expect(await getResearchJob(config, second.id)).toMatchObject({ status: "completed" });
    expect(await getResearchProducts(config, first.id)).toHaveLength(3);
    expect(await getResearchProducts(config, second.id)).toHaveLength(3);
  });

  it("deduplicates repeated provenance within a job and keeps evaluations linked", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);
    const products = collectFixtureProducts({ niche: "skincare", limit: 5 }).products;
    const evaluations = evaluateProducts(products, testRequest());

    await persistResearchResults(config, job.id, [...products, products[0]], evaluations);

    const persisted = await getResearchProducts(config, job.id);
    expect(persisted).toHaveLength(products.length);
    expect(persisted.every((entry) => entry.evaluation?.productId === entry.product.id)).toBe(true);
  });

  it("rolls back product persistence when a later product iteration fails", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);
    const product = collectFixtureProducts({ niche: "skincare", limit: 1 }).products[0];
    const evaluations = evaluateProducts([product], testRequest());
    const failingProducts = {
      *[Symbol.iterator]() {
        yield product;
        throw new Error("deterministic persistence failure");
      },
    } as unknown as readonly typeof product[];

    await expect(persistResearchResults(config, job.id, failingProducts, evaluations)).rejects.toThrow(
      "deterministic persistence failure",
    );
    expect(await getResearchProducts(config, job.id)).toEqual([]);
  });

  it("retains observed SDK cost when a terminal job step fails", async () => {
    const config = testConfig();
    const job = await createResearchJob(testRequest(), config);
    await appendJobEvent(config, job.id, "agent_terminal_result", "success; 5 turns; 0.0226 USD estimated");

    await finishResearchJob(config, job.id, {
      status: "failed",
      errorCode: "RESEARCH_PERSISTENCE_FAILED",
      sanitizedErrorMessage: "Research results could not be saved safely. No partial records were committed.",
    });

    expect((await getResearchJob(config, job.id))?.estimatedCostUsd).toBe(0.0226);
  });

  it("removes failed discovery leads from the report before persistence and ranking", () => {
    const report = AgentResearchReportSchema.parse({
      completion: "completed",
      executiveSummary: "One search citation was returned.",
      limitations: [],
      findings: [{
        productId: "anthropic-web-discovery:missing-page",
        summary: "A result snippet named a product.",
        customerAppeal: "Unverified.",
        differentiationConsiderations: [],
        risks: ["The page could be unavailable."],
        missingInformation: ["Product-page verification"],
        confidence: "low",
      }],
    });

    const reconciled = reconcileVerifiedResearchReport(report, [], {
      attemptedLeadCount: 1,
      verifiedCandidateCount: 0,
      rejectedLeads: [{
        name: "Missing page product",
        sourceUrl: "https://shop.example/products/missing-page",
        reason: "PAGE_UNAVAILABLE",
      }],
    }, "partial");

    expect(reconciled).toMatchObject({ completion: "partial", findings: [] });
    expect(reconciled?.limitations.join(" ")).toContain("not saved or ranked");
  });
});

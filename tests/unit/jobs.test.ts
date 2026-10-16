import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getServerConfig } from "@/lib/config/env";
import {
  claimNextResearchJob,
  createResearchJob,
  getJobEvents,
  getResearchJob,
  getResearchProducts,
  getResearchReport,
  requestResearchJobCancellation,
} from "@/lib/jobs/repository";
import { runResearchWorkerOnce } from "@/lib/jobs/worker";
import { ResearchRequestSchema } from "@/lib/research/contracts";

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
});

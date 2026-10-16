import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GET as getExport } from "@/app/api/research-jobs/[jobId]/export/route";
import { GET as getReport } from "@/app/api/research-jobs/[jobId]/report/route";
import { POST as cancelJob } from "@/app/api/research-jobs/[jobId]/cancel/route";
import { GET as getJob, } from "@/app/api/research-jobs/[jobId]/route";
import { GET as listJobs, POST as createJob } from "@/app/api/research-jobs/route";
import { GET as getSources } from "@/app/api/research-sources/route";
import { getServerConfig } from "@/lib/config/env";
import { runResearchWorkerOnce } from "@/lib/jobs/worker";

const databaseFiles: string[] = [];
const originalEnvironment = { ...process.env };

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  await Promise.all(
    databaseFiles.splice(0).flatMap((file) => [
      rm(file, { force: true }),
      rm(`${file}.lock`, { force: true }),
    ]),
  );
});

function configureFixtureEnvironment() {
  const fileName = `commerce-scout-api-${randomUUID()}.db`;
  databaseFiles.push(path.resolve(process.cwd(), "data", fileName));
  process.env.RESEARCH_MODE = "fixtures";
  process.env.DATABASE_URL = `file:./data/${fileName}`;
}

const submission = {
  niche: "skincare",
  minimumPrice: 15,
  maximumPrice: 60,
  requestedProductCount: 5,
  sourceIds: ["fixture-skincare-catalog"],
  objective: "Identify evidence-backed skincare candidates worth further investigation.",
};

describe("research job API", () => {
  it("creates, processes, reads, exports, and cancels research jobs through route handlers", async () => {
    configureFixtureEnvironment();
    const createdResponse = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify(submission),
      }),
    );
    expect(createdResponse.status).toBe(201);
    const { job } = (await createdResponse.json()) as { job: { id: string } };

    const history = await listJobs();
    expect(history.status).toBe(200);
    expect(((await history.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);

    await runResearchWorkerOnce(getServerConfig(), "api-test-worker");
    const context = { params: Promise.resolve({ jobId: job.id }) } as never;
    const statusResponse = await getJob(new Request("http://localhost"), context);
    expect(statusResponse.status).toBe(200);
    expect(((await statusResponse.json()) as { job: { status: string } }).job.status).toBe("completed");

    const reportResponse = await getReport(new Request("http://localhost"), context);
    expect(reportResponse.status).toBe(200);
    expect(((await reportResponse.json()) as { products: unknown[] }).products).toHaveLength(3);

    const exportResponse = await getExport(new Request("http://localhost"), context);
    expect(exportResponse.headers.get("content-type")).toContain("text/csv");
    expect(await exportResponse.text()).toContain("Niacinamide 10% Barrier Serum");

    const cancellationResponse = await cancelJob(new Request("http://localhost", { method: "POST" }), context);
    expect(cancellationResponse.status).toBe(200);
    expect(((await cancellationResponse.json()) as { job: { status: string } }).job.status).toBe("completed");
  });

  it("returns consistent client errors for invalid and unknown resources", async () => {
    configureFixtureEnvironment();
    const invalid = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({ ...submission, requestedProductCount: 0 }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as unknown).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });

    const unknown = await getJob(
      new Request("http://localhost"),
      { params: Promise.resolve({ jobId: randomUUID() }) } as never,
    );
    expect(unknown.status).toBe(404);
  });

  it("lists only fixture-compatible configured sources", async () => {
    configureFixtureEnvironment();
    const response = await getSources(
      new Request("http://localhost/api/research-sources?niche=skincare"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      mode: "fixtures",
      sources: [expect.objectContaining({ id: "fixture-skincare-catalog" })],
    });
  });
});

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
import { createResearchJob, persistResearchBundle } from "@/lib/jobs/repository";
import { ResearchRequestSchema } from "@/lib/research/contracts";
import { collectFixtureProducts } from "@/lib/research/fixture-source";
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
    const csv = await exportResponse.text();
    expect(csv).toContain("Niacinamide 10% Barrier Serum");
    expect(csv).toContain("evidence_scope");
    expect(csv).toContain("source_verified");

    const cancellationResponse = await cancelJob(new Request("http://localhost", { method: "POST" }), context);
    expect(cancellationResponse.status).toBe(200);
    expect(((await cancellationResponse.json()) as { job: { status: string } }).job.status).toBe("completed");
  });

  it("does not export a legacy search-only discovery lead", async () => {
    configureFixtureEnvironment();
    const config = getServerConfig();
    const request = ResearchRequestSchema.parse({ ...submission, mode: "fixtures" });
    const job = await createResearchJob(request, config);
    const [fixtureProduct] = collectFixtureProducts({ niche: "skincare", limit: 1 }).products;
    const discoveryLead = {
      ...fixtureProduct,
      id: "anthropic-web-discovery:legacy-search-lead",
      sourceId: "anthropic-web-discovery",
      externalId: "legacy-search-lead",
      name: "Legacy unverified search lead",
      sourceUrl: "https://shop.example/products/legacy-search-lead",
      evidenceStatus: "search_discovery" as const,
    };
    await persistResearchBundle(config, job.id, [discoveryLead], [], {
      mode: "claude_agent",
      limitations: ["Legacy lead for export regression coverage."],
    });

    const response = await getExport(
      new Request("http://localhost"),
      { params: Promise.resolve({ jobId: job.id }) } as never,
    );
    const csv = await response.text();

    expect(csv).not.toContain("Legacy unverified search lead");
    expect(csv.trim().split("\n")).toHaveLength(1);
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

  it("resolves automatic selection to compatible registry sources and persists the selection", async () => {
    configureFixtureEnvironment();
    const response = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({
          ...submission,
          sourceIds: [],
          sourceSelection: "automatic",
        }),
      }),
    );
    expect(response.status).toBe(201);
    const { job } = (await response.json()) as {
      job: { request: { sourceIds: string[]; sourceSelection?: string } };
    };
    expect(job.request).toMatchObject({
      sourceIds: ["fixture-skincare-catalog"],
      sourceSelection: "automatic",
    });
  });

  it("rejects unsupported automatic niches and incompatible manual sources", async () => {
    configureFixtureEnvironment();
    const unsupported = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({
          ...submission,
          niche: "electronics",
          sourceIds: [],
          sourceSelection: "automatic",
        }),
      }),
    );
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()) as unknown).toMatchObject({
      error: { code: "NO_COMPATIBLE_SOURCE" },
    });

    const incompatible = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({
          ...submission,
          niche: "electronics",
          sourceSelection: "manual",
          sourceIds: ["fixture-skincare-catalog"],
        }),
      }),
    );
    expect(incompatible.status).toBe(400);
    expect((await incompatible.json()) as unknown).toMatchObject({
      error: { code: "SOURCE_NICHE_MISMATCH" },
    });

    const modeOverride = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({
          ...submission,
          mode: "live",
          sourceSelection: "automatic",
          sourceIds: [],
        }),
      }),
    );
    expect(modeOverride.status).toBe(400);
    expect((await modeOverride.json()) as unknown).toMatchObject({
      error: { code: "MODE_MISMATCH" },
    });
  });

  it("lists only fixture-compatible configured sources", async () => {
    configureFixtureEnvironment();
    const response = await getSources(
      new Request("http://localhost/api/research-sources?niche=skincare"),
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({
      mode: "fixtures",
      runtime: "deterministic_fixture",
      liveAgentAvailable: false,
      sources: [expect.objectContaining({ id: "fixture-skincare-catalog" })],
    });
  });

  it("identifies an uncredentialed live runtime and rejects live jobs before queueing", async () => {
    const fileName = `commerce-scout-api-${randomUUID()}.db`;
    databaseFiles.push(path.resolve(process.cwd(), "data", fileName));
    process.env.RESEARCH_MODE = "live";
    process.env.DATABASE_URL = `file:./data/${fileName}`;
    delete process.env.ANTHROPIC_API_KEY;

    const sourceResponse = await getSources(
      new Request("http://localhost/api/research-sources?niche=electronics"),
    );
    expect((await sourceResponse.json()) as unknown).toMatchObject({
      mode: "live",
      runtime: "live_agent_blocked",
      liveAgentAvailable: false,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: "webscraper-ecommerce-demo" }),
        expect.objectContaining({ id: "anthropic-web-discovery", searchable: true }),
      ]),
    });

    const jobResponse = await createJob(
      new Request("http://localhost/api/research-jobs", {
        method: "POST",
        body: JSON.stringify({
          ...submission,
          niche: "electronics",
          sourceIds: ["webscraper-ecommerce-demo"],
        }),
      }),
    );
    expect(jobResponse.status).toBe(503);
    expect((await jobResponse.json()) as unknown).toMatchObject({
      error: { code: "INVALID_CONFIGURATION" },
    });
  });

  it("reports a credentialed OpenRouter live runtime without requiring an Anthropic key", async () => {
    process.env.RESEARCH_MODE = "live";
    process.env.AI_PROVIDER = "openrouter";
    process.env.OPENROUTER_API_KEY = "openrouter-test-key";
    delete process.env.ANTHROPIC_API_KEY;

    const sourceResponse = await getSources(
      new Request("http://localhost/api/research-sources?niche=camping%20lantern"),
    );

    expect((await sourceResponse.json()) as unknown).toMatchObject({
      mode: "live",
      runtime: "claude_agent",
      liveAgentAvailable: true,
      sources: expect.arrayContaining([
        expect.objectContaining({ id: "anthropic-web-discovery", searchable: true }),
      ]),
    });
  });
});

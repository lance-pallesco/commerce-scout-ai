import { rm } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { getServerConfig } from "../../lib/config/env";
import { runResearchWorkerOnce } from "../../lib/jobs/worker";

const e2eDatabaseFile = process.env.E2E_DATABASE_FILE;
if (!e2eDatabaseFile || !/^commerce-scout-e2e-\d+-\d+\.db$/.test(e2eDatabaseFile)) {
  throw new Error("E2E_DATABASE_FILE must be a generated test database name.");
}
process.env.RESEARCH_MODE = "fixtures";
process.env.DATABASE_URL = `file:./data/${e2eDatabaseFile}`;
const e2eDatabase = path.resolve(process.cwd(), "data", e2eDatabaseFile);

test.afterAll(async () => {
  await Promise.all([rm(e2eDatabase, { force: true }), rm(`${e2eDatabase}.lock`, { force: true })]);
});

test("submits a fixture job and displays persisted rankings", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByText("CommerceScout AI").first()).toBeVisible();
  await expect(page.getByLabel("Approved source")).toHaveValue("fixture-skincare-catalog");

  await page.getByRole("button", { name: "Start research" }).click();
  await expect(page.getByText("skincare opportunity research")).toBeVisible();
  await expect(page.getByText("pending").first()).toBeVisible();

  await runResearchWorkerOnce(getServerConfig(), "playwright-worker");
  await page.reload();
  await page.getByRole("button", { name: /skincare.*fixture-skincare-catalog/i }).click();

  await expect(page.getByText("Product ranking")).toBeVisible();
  await expect(page.getByText("Niacinamide 10% Barrier Serum")).toBeVisible();
  await expect(page.getByRole("link", { name: "CSV" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("populated-dashboard.png"), fullPage: true });
});

test("keeps the research form usable on a narrow viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start research" })).toBeVisible();
  await expect(page.getByText("Evidence-backed results will appear here")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-empty-dashboard.png"), fullPage: true });
});

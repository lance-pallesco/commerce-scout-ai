import { defineConfig, devices } from "@playwright/test";

const e2eDatabaseFile =
  process.env.E2E_DATABASE_FILE ?? `commerce-scout-e2e-${process.pid}-${Date.now()}.db`;
process.env.E2E_DATABASE_FILE = e2eDatabaseFile;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "node ./node_modules/next/dist/bin/next start --port 3100",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      ...process.env,
      RESEARCH_MODE: "fixtures",
      DATABASE_URL: `file:./data/${e2eDatabaseFile}`,
    },
  },
});

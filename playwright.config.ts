import { defineConfig, devices } from "@playwright/test";

const e2eDatabaseFile =
  process.env.E2E_DATABASE_FILE ?? `commerce-scout-e2e-${process.pid}-${Date.now()}.db`;
const e2ePort = Number(process.env.E2E_PORT ?? "3101");
if (!Number.isInteger(e2ePort) || e2ePort < 1 || e2ePort > 65_535) {
  throw new Error("E2E_PORT must be a valid local TCP port.");
}
process.env.E2E_DATABASE_FILE = e2eDatabaseFile;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `node ./node_modules/next/dist/bin/next start --port ${e2ePort}`,
    url: `http://127.0.0.1:${e2ePort}`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      RESEARCH_MODE: "fixtures",
      DATABASE_URL: `file:./data/${e2eDatabaseFile}`,
    },
  },
});

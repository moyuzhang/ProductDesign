import { defineConfig } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  // Integrated tests share one mutable local ProductDesign backend.
  // Running files in parallel makes project-count and workspace assertions race.
  workers: 1,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120_000
  }
});

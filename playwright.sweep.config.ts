import { defineConfig, devices } from "@playwright/test";

/**
 * Interaction perf sweep (#1174), separate from the correctness suite: a
 * serial Chromium run (CPU throttling needs CDP) on its own dev-server port.
 * `PORT` lets an old-release checkout run beside this one for an A/B baseline.
 */
const port = Number(process.env.PORT ?? 1440);

export default defineConfig({
  testDir: "./e2e-sweep",
  outputDir: "./test-results-sweep",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 240_000,
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run dev -- --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

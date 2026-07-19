import { defineConfig, devices } from "@playwright/test";

/**
 * High-load stress-test config (separate from the correctness suite in
 * playwright.config.ts). Runs the specs under e2e-load/ against a dedicated
 * dev server on port 1430 so it never collides with the default 1420 suite.
 *
 * Load tests are intentionally slow (thousands of synthetic commits, many
 * tabs, forced GC, CPU throttling), so timeouts are generous and the whole
 * suite runs serially (workers: 1) to keep memory/CPU measurements meaningful.
 *
 * Two projects:
 *  - `load`:               normal Chromium with --expose-gc for heap probes.
 *  - `constrained-memory`: a 256MB old-space cap, only the survival spec.
 */
export default defineConfig({
  testDir: "./e2e-load",
  outputDir: "./test-results-load",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-load", open: "never" }]],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: "http://localhost:1430",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "load",
      testIgnore: /constrained-memory\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Precise (unquantized) performance.memory readings — without this
          // the heap-delta leak assertions compare bucketed values and can
          // report 0 growth regardless of actual behavior.
          args: ["--js-flags=--expose-gc", "--enable-precise-memory-info"],
        },
      },
    },
    {
      name: "constrained-memory",
      testMatch: /constrained-memory\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // Hard heap cap to prove the app survives memory pressure.
          args: [
            "--js-flags=--max-old-space-size=256 --expose-gc",
            "--enable-precise-memory-info",
          ],
        },
      },
    },
  ],
  webServer: {
    command: "DEV_PORT=1430 bun run dev",
    url: "http://localhost:1430",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

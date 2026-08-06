import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Local default is capped so a full run doesn't saturate every core and
  // freeze the desktop (Playwright's default is 50% of cores — 12 chromium
  // workers on this machine). Override per-run with PW_WORKERS=N.
  workers: process.env.CI ? 1 : Number(process.env.PW_WORKERS ?? 4),
  reporter: "html",
  use: {
    baseURL: "http://localhost:1420",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // Nix hosts can supply their wrapped browser when Playwright's downloaded
      // Chromium cannot load the host's shared libraries. CI leaves this unset.
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
          : undefined,
      },
    },
    // WebKit ≈ WKWebView: the closest automated proxy for the macOS webview
    // (no WKWebView WebDriver exists). Opt-in: WEBKIT=1 locally, or
    // --project=webkit (the CI webkit job does this).
    ...(process.env.WEBKIT
      ? [
          {
            name: "webkit",
            use: { ...devices["Desktop Safari"] },
          },
        ]
      : []),
  ],
  webServer: {
    command: "bun run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});

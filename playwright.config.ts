import { defineConfig, devices } from "@playwright/test";
import { DEV_BESIDE_BUNDLE_PORT } from "./e2e/app-server";

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Local default is capped so a full run doesn't saturate every core and
  // freeze the desktop (Playwright's default is 50% of cores — 12 chromium
  // workers on this machine). Override per-run with PW_WORKERS=N; CI
  // defaults to 1 and sets 2 on the Chromium jobs (#1368).
  workers: Number(process.env.PW_WORKERS ?? (process.env.CI ? 1 : 4)),
  reporter: "html",
  use: {
    baseURL: "http://localhost:1420",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
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
  // CI's browser shards serve one prebuilt browser-test bundle (#1381:
  // E2E_BROWSER_BUILD=1 bun run build, scripts/serve-e2e-build.mjs) instead of
  // transforming modules on demand per shard; dev pushes also record the
  // impact map there, through the bundle's hidden source maps (#1386). Local
  // runs and the nightly e2e-impact-map.yml keep the dev server. Beside the
  // bundle, a dev server serves the specs that intercept module requests
  // (e2e/app-server.ts).
  webServer: process.env.E2E_BUILD_DIR
    ? [
        {
          command: "node scripts/serve-e2e-build.mjs",
          url: "http://localhost:1420",
          reuseExistingServer: !process.env.CI,
          timeout: 30 * 1000,
        },
        {
          command: "bun run dev",
          env: { DEV_PORT: String(DEV_BESIDE_BUNDLE_PORT) },
          url: `http://localhost:${DEV_BESIDE_BUNDLE_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 120 * 1000,
        },
      ]
    : {
        command: "bun run dev",
        url: "http://localhost:1420",
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
      },
});

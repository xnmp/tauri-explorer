/**
 * Shared Playwright fixtures for e2e tests.
 *
 * LOCAL-ONLY FIX — do not remove without re-reading this comment.
 *
 * Root cause: Chromium reports the REAL host OS via `navigator.platform`
 * (verified empirically: on Windows it's always "Win32", regardless of
 * `userAgent` context overrides — only `addInitScript` can change it). On a
 * Windows dev machine this flips `isWindows` true in
 * src/lib/domain/platform.ts, which is exactly the signal
 * src/lib/state/explorer.svelte.ts uses to rewrite every navigated path to
 * backslashes (correct behavior for a real Windows Tauri build talking to
 * the real backend). But `src/lib/api/mock-invoke.ts` — the fake filesystem
 * used by e2e tests — only ever serves POSIX-style paths (`/home/user/...`).
 * So on a Windows dev machine, the very first navigation rewrites
 * `/home/user` to `\home\user`, the mock lookup misses, and `.entry-item`
 * never renders — cascading into mass failures across unrelated specs
 * (address bar, breadcrumbs, AI rename, ...). CI's `ubuntu-latest` runners
 * report a Linux platform, so `isWindows` is false there and the mismatch
 * never surfaces — hence green CI on the same commit.
 *
 * This fixture pins `navigator.platform` to a non-Windows value for every
 * page, matching CI's Linux Chromium behavior regardless of the host OS the
 * suite actually runs on. Spec files import `test`/`expect` from here
 * instead of "@playwright/test" so the pin applies uniformly (and so the
 * impact-coverage collector sees every spec: tests/e2e-fixture-imports.test.ts).
 */
import { test as base, expect } from "@playwright/test";
import { baseURLFor } from "./app-server";
import { collectImpactCoverage, impactCoverageEnabled } from "./impact-coverage";

// E2E_COVERAGE=1 records which source files each test executes, for the
// test-impact map (#1368). An auto fixture, so tests that use only `browser`
// are recorded too. Unset, specs get exactly the fixtures below.
const covered = impactCoverageEnabled
  ? base.extend<{ impactCoverage: void }>({
    // `baseURL` resolves to the override below: the spec's own app server.
    impactCoverage: [async ({ browser, context, baseURL }, use, testInfo) => {
      await collectImpactCoverage(browser, context, testInfo, () => use(), baseURL);
    }, { auto: true }],
  })
  : base;

// Against CI's shared bundle, specs that intercept requests use the dev server
// beside it (e2e/app-server.ts, #1381); everywhere else this is the config's.
const recorded = covered.extend({
  baseURL: async ({ baseURL }, use, testInfo) => {
    await use(baseURLFor(testInfo.file, baseURL));
  },
});

export const test = recorded.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", {
        get: () => "Linux x86_64",
        // A later init script may opt one spec into another engine's paths.
        configurable: true,
      });
    });
    await use(page);
  },
});

/**
 * Playwright's own `test` without the platform pin, for specs that set up
 * another platform's contexts themselves; still recorded under E2E_COVERAGE.
 */
export const unpinnedTest = recorded;

export { expect };
export type { Page } from "@playwright/test";

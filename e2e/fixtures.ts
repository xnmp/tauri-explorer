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
 * instead of "@playwright/test" so the pin applies uniformly.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      Object.defineProperty(window.navigator, "platform", {
        get: () => "Linux x86_64",
      });
    });
    await use(page);
  },
});

export { expect };
export type { Page } from "@playwright/test";

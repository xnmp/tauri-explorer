/**
 * Automatic updates (#1679): with the setting on and a self-updatable install,
 * the backend has downloaded the release by the time the notice appears, and
 * "Restart now" installs it. Turning the setting off keeps the notify-only
 * notice. The real download/install path is native (Rust + updater plugin);
 * these specs cover the frontend contract against the mock backend.
 */

import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { pressShortcut, waitForEntries } from "./helpers";
import { MOCK_LOCAL_KEYS } from "../src/lib/api/mock-control";

// The check waits 5s after startup (UpdateNotice.svelte); the page clock
// jumps over that delay instead of sleeping through it (#1123).
const PAST_STARTUP_DELAY_MS = 6_000;
const SHOTS = "screenshots/feat/auto-update";

async function seedUpdate(page: Page, opts: { selfUpdatable: boolean; installFails?: boolean }) {
  await page.addInitScript(
    ({ keys, selfUpdatable, installFails }) => {
      localStorage.setItem(keys.updateAvailable, "1");
      if (selfUpdatable) localStorage.setItem(keys.updateSelfUpdatable, "1");
      if (installFails && localStorage.getItem(keys.updateInstalled) === null) {
        localStorage.setItem(keys.updateInstalled, "fail");
      }
    },
    { keys: MOCK_LOCAL_KEYS, ...opts },
  );
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test("auto-update offers a restart into the downloaded release and installs it", async ({ page }) => {
  await page.clock.install();
  await seedUpdate(page, { selfUpdatable: true });
  await page.goto("/");
  await waitForEntries(page);
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);

  const notice = page.getByTestId("update-notice");
  await expect(notice).toContainText("9.9.9 is ready to install");
  await expect(notice).toHaveAttribute("data-ready", "true");
  expect(await stored(page, MOCK_LOCAL_KEYS.updateAutoInstallArg)).toBe("true");
  await page.screenshot({ path: `${SHOTS}/update-ready-restart-notice.png`, animations: "disabled" });

  const restart = notice.getByRole("button", { name: "Restart now" });
  await restart.click();
  await expect.poll(() => stored(page, MOCK_LOCAL_KEYS.updateInstalled)).toBe("1");
  // The app is restarting: the action is no longer offered twice.
  await expect(notice.getByRole("button", { name: "Restarting…" })).toBeDisabled();
});

test("Later dismisses the ready notice without installing", async ({ page }) => {
  await page.clock.install();
  await seedUpdate(page, { selfUpdatable: true });
  await page.goto("/");
  await waitForEntries(page);
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);

  const notice = page.getByTestId("update-notice");
  await notice.getByRole("button", { name: "Later" }).click();
  await expect(notice).not.toBeVisible();
  expect(await stored(page, MOCK_LOCAL_KEYS.updateInstalled)).toBeNull();
});

test("a failed install reports the error and keeps the restart available", async ({ page }) => {
  await page.clock.install();
  await seedUpdate(page, { selfUpdatable: true, installFails: true });
  await page.goto("/");
  await waitForEntries(page);
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);

  const notice = page.getByTestId("update-notice");
  await notice.getByRole("button", { name: "Restart now" }).click();
  await expect(page.locator(".toast.error")).toContainText("authentication was cancelled");
  await expect(notice.getByRole("button", { name: "Restart now" })).toBeEnabled();
});

test("installs that cannot self-update keep the notify-only notice", async ({ page }) => {
  await page.clock.install();
  await seedUpdate(page, { selfUpdatable: false });
  await page.goto("/");
  await waitForEntries(page);
  await page.clock.runFor(PAST_STARTUP_DELAY_MS);

  const notice = page.getByTestId("update-notice");
  await expect(notice).toContainText("9.9.9 is available");
  await expect(notice.getByRole("button", { name: "View release" })).toBeVisible();
  await expect(notice.getByRole("button", { name: "Restart now" })).toHaveCount(0);
});

test("turning automatic updates off in Settings keeps updates notify-only", async ({ page }) => {
  // The installed clock still advances with real time; pause it once the
  // page is ready so the startup check cannot run while Settings is open.
  await page.clock.install();
  await seedUpdate(page, { selfUpdatable: true });
  await page.goto("/");
  await waitForEntries(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 10));

  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator(".settings-search").fill("updates");
  const toggle = dialog.getByTestId("auto-update-toggle");
  await expect(toggle).toBeChecked();
  // The checkbox is visually restyled; users click its slider.
  await dialog.locator(".setting-row", { has: page.getByTestId("auto-update-toggle") }).locator(".toggle-slider").click();
  await expect(toggle).not.toBeChecked();
  await page.screenshot({ path: `${SHOTS}/settings-auto-update-toggle.png`, animations: "disabled" });
  // The first Escape clears the filter, the second closes the dialog. Resume
  // the clock first: Svelte's exit transition runs on animation frames.
  await page.clock.resume();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();

  await page.clock.runFor(PAST_STARTUP_DELAY_MS);
  const notice = page.getByTestId("update-notice");
  await expect(notice).toContainText("9.9.9 is available");
  await expect(notice).toHaveAttribute("data-ready", "false");
  expect(await stored(page, MOCK_LOCAL_KEYS.updateAutoInstallArg)).toBe("false");
});

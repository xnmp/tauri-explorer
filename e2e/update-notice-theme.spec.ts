/**
 * Update notice (#650): the available-release surface must participate in the
 * same theme and control language as the application's dialogs.
 */

import { test, expect } from "./fixtures";

test("update notice uses themed dialog chrome and preserves its actions", async ({ page }) => {
  const releaseUrl = "https://github.com/xnmp/tauri-explorer/releases/tag/v1.8.0";
  await page.addInitScript(() => {
    localStorage.setItem("mockUpdateAvailable", "1");
    localStorage.setItem("theme", JSON.stringify("dark"));
    localStorage.setItem("mock-update-url", "https://github.com/xnmp/tauri-explorer/releases/tag/v1.8.0");
  });
  await page.goto("/");

  const notice = page.getByTestId("update-notice");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toHaveClass(/modal-card/);

  await expect(notice).toHaveCSS("background-color", "rgba(38, 38, 40, 0.92)");
  await expect(notice).toHaveCSS("border-top-color", "rgba(255, 255, 255, 0.1)");
  await expect(notice).toHaveCSS("color", "rgb(232, 232, 237)");
  const viewRelease = notice.getByRole("button", { name: "View release" });
  await expect(viewRelease).toHaveClass(/btn.*primary/);
  await expect(viewRelease).toHaveCSS("background-color", "rgb(76, 194, 244)");
  await expect(notice.getByRole("button", { name: "Dismiss" })).toHaveClass(/btn.*secondary/);
  await page.screenshot({ path: "evidence/ac-1-themed-update-notice.png" });

  await viewRelease.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBe(releaseUrl);
  await expect(notice).not.toBeVisible();
});

test("light-themed update notice uses dialog chrome and can be dismissed", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mockUpdateAvailable", "1");
    localStorage.setItem("theme", JSON.stringify("light"));
  });
  await page.goto("/");

  const notice = page.getByTestId("update-notice");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toHaveClass(/modal-card/);
  await expect(notice).toHaveCSS("background-color", "rgba(255, 255, 255, 0.72)");
  await expect(notice).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0.03)");
  await expect(notice).toHaveCSS("color", "rgb(29, 29, 31)");
  const viewRelease = notice.getByRole("button", { name: "View release" });
  await expect(viewRelease).toHaveClass(/btn.*primary/);
  await expect(viewRelease).toHaveCSS("background-color", "rgb(0, 102, 204)");
  await page.screenshot({ path: "evidence/ac-1-themed-update-notice-light.png" });
  await notice.getByRole("button", { name: "Dismiss" }).focus();
  await page.screenshot({ path: "evidence/ac-2-dialog-controls.png" });
  const checkedAt = await page.evaluate(() => localStorage.getItem("updateCheck.lastCheckedAt"));
  expect(checkedAt).not.toBeNull();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).not.toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("updateCheck.lastCheckedAt")))
    .toBe(checkedAt);
});

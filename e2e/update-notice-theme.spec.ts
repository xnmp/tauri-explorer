/**
 * Update notice (#650): the available-release surface must participate in the
 * same theme and control language as the application's dialogs.
 */

import { test, expect } from "./fixtures";

test("update notice uses themed dialog chrome and preserves its actions", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("mockUpdateAvailable", "1");
    document.documentElement.dataset.theme = "dark";
  });
  await page.goto("/");

  const notice = page.getByTestId("update-notice");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toHaveClass(/modal-card/);

  await expect(notice).toHaveCSS("background-color", "rgba(38, 38, 40, 0.92)");
  await expect(notice).toHaveCSS("border-top-color", "rgba(76, 194, 244, 0.15)");
  await expect(notice).toHaveCSS("color", "rgb(232, 232, 237)");
  await expect(notice.getByRole("button", { name: "View release" })).toHaveClass(/btn.*primary/);
  await expect(notice.getByRole("button", { name: "Dismiss" })).toHaveClass(/btn.*secondary/);

  await notice.getByRole("button", { name: "View release" }).click();
  await expect(notice).not.toBeVisible();
  await expect(page.locator("html")).toHaveJSProperty(
    "dataset",
    expect.objectContaining({ theme: "dark" }),
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
    .toBe("https://github.com/xnmp/tauri-explorer/releases/tag/v9.9.9");
});

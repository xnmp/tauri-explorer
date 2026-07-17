/**
 * E2E test: git status indicators feature.
 * Asserts badges actually render on files in a git repo, not just that the
 * settings toggle exists.
 * Issue: feat/git-status-indicators
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

test.describe("Git status indicators", () => {
  test("settings dialog has git status toggle", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await page.keyboard.press("Control+,");
    const dialog = page.locator(".settings-dialog, .dialog-overlay");
    await dialog.waitFor({ state: "visible", timeout: 2000 });

    await expect(page.locator("text=Git Status Indicators")).toBeVisible();
  });

  test("badges render on entries inside a git repo when enabled", async ({ page }) => {
    // Enable the (default-off) indicator setting before the app boots.
    await page.addInitScript(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    // The mock treats /home/user/Documents/project as a git repo with
    // CHANGELOG.md Modified and .env.example Untracked.
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    const changelogRow = page.locator(".entry-item", { hasText: "CHANGELOG.md" });
    await expect(changelogRow.locator(".git-indicator")).toBeVisible();
    await expect(changelogRow.locator(".git-indicator")).toHaveText("M");

    const srcRow = page.locator(".entry-item", { hasText: "src" }).first();
    await expect(srcRow.locator(".git-indicator")).toHaveText("M");
  });

  test("no badges render outside a git repo", async ({ page }) => {
    await page.addInitScript(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await expect(page.locator(".git-indicator")).toHaveCount(0);
  });
});

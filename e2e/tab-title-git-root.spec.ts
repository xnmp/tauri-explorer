/**
 * E2E: the "Git Repo Root in Tab Title" setting. When on, a tab inside a git
 * repo shows a git icon and "repoRoot › currentFolder"; at the repo root it
 * shows just the repo name. When off, the plain folder name.
 * (Mock: /home/user/Documents/project is a git repo root.)
 * Issue: feat/tab-title (git repo root in tab title)
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

const enableGitTitles = (page: import("@playwright/test").Page) =>
  page.addInitScript(() => {
    const k = "explorer-settings";
    const s = JSON.parse(localStorage.getItem(k) || "{}");
    s.tabTitleGitRoot = true;
    localStorage.setItem(k, JSON.stringify(s));
  });

test.describe("Git repo root in tab title", () => {
  test("shows the plain folder name when the setting is off (default)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project/src");
    await waitForEntries(page);
    await expect(page.locator(".tab-title").first()).toHaveText("src");
    await expect(page.locator(".tab-icon-git")).toHaveCount(0);
  });

  test("shows a git icon and repo › folder for a subfolder when on", async ({ page }) => {
    await enableGitTitles(page);
    await page.goto("/?path=/home/user/Documents/project/src");
    await waitForEntries(page);
    // Repo root is resolved async after first paint; the title then updates.
    await expect(page.locator(".tab-repo").first()).toHaveText("project");
    await expect(page.locator(".tab-cwd").first()).toHaveText("src");
    await expect(page.locator(".tab-icon-git").first()).toBeVisible();
  });

  test("shows just the repo name (no folder part) at the repo root when on", async ({ page }) => {
    await enableGitTitles(page);
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await expect(page.locator(".tab-icon-git").first()).toBeVisible();
    await expect(page.locator(".tab-cwd").first()).toHaveText("project");
    await expect(page.locator(".tab-repo")).toHaveCount(0);
  });
});

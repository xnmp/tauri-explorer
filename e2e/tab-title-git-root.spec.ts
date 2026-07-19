/**
 * E2E: the "Git Repo Root in Tab Title" setting. When on (the default,
 * #471), a tab inside a git repo shows a git icon and
 * "repoRoot › currentFolder"; at the repo root it shows just the repo name.
 * When explicitly turned off, the plain folder name.
 * (Mock: /home/user/Documents/project is a git repo root.)
 * Issue: feat/tab-title (git repo root in tab title), #471 (default-on fix)
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const setGitTitles = (page: import("@playwright/test").Page, enabled: boolean) =>
  page.addInitScript((value) => {
    const k = "explorer-settings";
    const s = JSON.parse(localStorage.getItem(k) || "{}");
    s.tabTitleGitRoot = value;
    localStorage.setItem(k, JSON.stringify(s));
  }, enabled);

/** Tabs are per-pane (#140) and the strip only renders with 2+ tabs (or in
 *  dual-pane mode) — open a second tab so the strip is visible. */
const showTabStrip = async (page: import("@playwright/test").Page) => {
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
};

test.describe("Git repo root in tab title", () => {
  test("shows a git icon and repo › folder for a subfolder by default, with no setup", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project/src");
    await waitForEntries(page);
    await showTabStrip(page);
    // Repo root is resolved async after first paint; the title then updates.
    await expect(page.locator(".tab-repo").first()).toHaveText("project");
    await expect(page.locator(".tab-cwd").first()).toHaveText("src");
    await expect(page.locator(".tab-icon-git").first()).toBeVisible();
  });

  test("shows just the repo name (no folder part) at the repo root by default", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await showTabStrip(page);
    await expect(page.locator(".tab-icon-git").first()).toBeVisible();
    await expect(page.locator(".tab-cwd").first()).toHaveText("project");
    await expect(page.locator(".tab-repo")).toHaveCount(0);
  });

  test("shows the plain folder name when the setting is explicitly turned off", async ({ page }) => {
    await setGitTitles(page, false);
    await page.goto("/?path=/home/user/Documents/project/src");
    await waitForEntries(page);
    await showTabStrip(page);
    await expect(page.locator(".tab-title").first()).toHaveText("src");
    await expect(page.locator(".tab-icon-git")).toHaveCount(0);
  });
});

/**
 * E2E: the "Git Repo Root in Tab Title" setting. When on, a folder inside a git
 * repo shows the repo's root folder name; when off, the folder's own name.
 * (Mock: /home/user/Documents/project is a git repo root.)
 * Issue: feat/tab-title (git repo root in tab title)
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

const NESTED = "/?path=/home/user/Documents/project/src";

test.describe("Git repo root in tab title", () => {
  test("shows the folder name when the setting is off (default)", async ({ page }) => {
    await page.goto(NESTED);
    await waitForEntries(page);
    await expect(page.locator(".tab-title").first()).toHaveText("src");
  });

  test("shows the repo root name when the setting is on", async ({ page }) => {
    await page.addInitScript(() => {
      const k = "explorer-settings";
      const s = JSON.parse(localStorage.getItem(k) || "{}");
      s.tabTitleGitRoot = true;
      localStorage.setItem(k, JSON.stringify(s));
    });
    await page.goto(NESTED);
    await waitForEntries(page);
    // Async: the repo root is resolved after first paint, then the title updates.
    await expect(page.locator(".tab-title").first()).toHaveText("project");
  });
});

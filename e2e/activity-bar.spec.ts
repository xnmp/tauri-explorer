/**
 * Activity bar + sidebar view (#52).
 *
 * With SCM moved to its own panel, the activity bar only has the Explorer view.
 * Asserts that the icon strip renders and Explorer is the default (and only) view.
 */
import { test, expect } from "@playwright/test";

test.describe("Activity bar + sidebar views", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.removeItem("explorer-sidebar-active-view"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('.activity-button[data-view-id="files"]').waitFor({ state: "visible" });
  });

  const activityBar = (page: import("@playwright/test").Page) =>
    page.getByRole("tablist", { name: /Sidebar views/i });

  test("activity bar renders with Explorer tab only", async ({ page }) => {
    const explorerTab = activityBar(page).getByRole("tab", { name: /Explorer/i });
    await expect(explorerTab).toBeVisible();

    const tabs = activityBar(page).getByRole("tab");
    await expect(tabs).toHaveCount(1);
  });

  test("Explorer view is active by default and shows Bookmarks section", async ({ page }) => {
    const explorerTab = activityBar(page).getByRole("tab", { name: /Explorer/i });
    await expect(explorerTab).toHaveAttribute("aria-selected", "true");

    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });

  test("SCM panel is independent of sidebar and toggled via settings", async ({ page }) => {
    // SCM panel should not be visible by default
    await expect(page.locator(".scm-panel")).toHaveCount(0);

    // Enable SCM panel via settings
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator(".scm-panel")).toBeVisible();
    // Sidebar is still visible alongside SCM panel
    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });
});

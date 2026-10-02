/**
 * Sidebar views (#52, #101).
 *
 * With SCM moved to its own panel and the activity bar removed,
 * the sidebar renders the files view directly.
 */
import { test, expect } from "./fixtures";
import { applySettingsAndReload } from "./helpers";

test.describe("Sidebar views", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
  });

  test("sidebar shows Bookmarks section by default", async ({ page }) => {
    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });

  test("SCM panel is independent of sidebar and toggled via settings", async ({ page }) => {
    // SCM panel should not be visible by default
    await expect(page.locator(".scm-panel")).toHaveCount(0);

    // Enable SCM panel via settings
    await applySettingsAndReload(page, { showGitStatus: true, showScmPanel: true });
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator(".scm-panel")).toBeVisible();
    // Sidebar is still visible alongside SCM panel
    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });
});

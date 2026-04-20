/**
 * Activity bar + sidebar view switching (#52).
 *
 * Asserts that the VSCode-style icon strip renders, that Explorer is the
 * default view, and that switching between views preserves the mounted
 * instance of each (scroll/selection lives on the mounted DOM nodes).
 */
import { test, expect } from "@playwright/test";

test.describe("Activity bar + sidebar views", () => {
  test.beforeEach(async ({ page }) => {
    // Clear active-view preference once before navigation (not re-run on reload,
    // so per-window persistence can still be asserted).
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.removeItem("explorer-sidebar-active-view"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    // Wait for the sidebar activity bar to mount — parallel runs can race
    // on the tab list showing up without this.
    await page.locator('.activity-button[data-view-id="files"]').waitFor({ state: "visible" });
  });

  // Scope queries to the activity-bar tablist so window-tabs (which also use
  // role=tab and can carry an "Explorer" label) don't collide with the strict
  // locator mode.
  const activityBar = (page: import("@playwright/test").Page) =>
    page.getByRole("tablist", { name: /Sidebar views/i });

  test("activity bar renders with Explorer and Source Control", async ({ page }) => {
    const explorerTab = activityBar(page).getByRole("tab", { name: /Explorer/i });
    const scmTab = activityBar(page).getByRole("tab", { name: /Source Control/i });

    await expect(explorerTab).toBeVisible();
    await expect(scmTab).toBeVisible();
  });

  test("Explorer view is active by default and shows Bookmarks section", async ({ page }) => {
    const explorerTab = activityBar(page).getByRole("tab", { name: /Explorer/i });
    await expect(explorerTab).toHaveAttribute("aria-selected", "true");

    const filesPanel = page.getByRole("tabpanel", { name: /Explorer/i });
    await expect(filesPanel).toBeVisible();

    // Bookmarks header lives in the Files view
    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });

  test("switching to Source Control replaces the files panel, switching back restores it", async ({ page }) => {
    const scmTab = activityBar(page).getByRole("tab", { name: /Source Control/i });
    const explorerTab = activityBar(page).getByRole("tab", { name: /Explorer/i });
    const filesPanel = page.getByRole("tabpanel", { name: /Explorer/i });
    const scmPanel = page.getByRole("tabpanel", { name: /Source Control/i });

    await scmTab.click();

    await expect(scmTab).toHaveAttribute("aria-selected", "true");
    await expect(scmPanel).toBeVisible();
    await expect(filesPanel).toBeHidden();

    await explorerTab.click();

    await expect(explorerTab).toHaveAttribute("aria-selected", "true");
    await expect(filesPanel).toBeVisible();
    await expect(scmPanel).toBeHidden();
    // Files content survived the view switch — Bookmarks region is still there.
    await expect(page.getByRole("region", { name: /Bookmarks/i })).toBeVisible();
  });

  test("inactive views remain mounted (hidden, not destroyed)", async ({ page }) => {
    const scmTab = activityBar(page).getByRole("tab", { name: /Source Control/i });
    // `hidden` elements drop out of the a11y tree, so use CSS selectors here
    // to assert DOM presence regardless of visibility.
    const filesHost = page.locator('.sidebar-view-host[data-view-id="files"]');
    const scmHost = page.locator('.sidebar-view-host[data-view-id="scm"]');

    // Both panels exist in DOM from initial render
    await expect(filesHost).toHaveCount(1);
    await expect(scmHost).toHaveCount(1);

    await scmTab.click();
    // After switching, both still present — just the hidden attribute flips.
    await expect(filesHost).toHaveCount(1);
    await expect(scmHost).toHaveCount(1);
    await expect(filesHost).toHaveAttribute("hidden", /.*/);
  });

  test("active view persists across reload (per-window)", async ({ page }) => {
    const scmPanel = page.getByRole("tabpanel", { name: /Source Control/i });

    await activityBar(page).getByRole("tab", { name: /Source Control/i }).click();
    await expect(scmPanel).toBeVisible();

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.locator('.activity-button[data-view-id="scm"]').waitFor({ state: "visible" });

    await expect(activityBar(page).getByRole("tab", { name: /Source Control/i })).toHaveAttribute("aria-selected", "true");
    await expect(scmPanel).toBeVisible();
  });
});

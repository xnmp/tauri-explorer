/**
 * E2E: empty-folder markers + manually-hidden items (#296).
 *
 *  - Empty directories are resolved lazily via `is_directory_empty` and get an
 *    `.empty-folder` class (a dimmed cue). `/home/user/Archive` is seeded empty.
 *  - The right-click "Hide" action adds an entry to a per-folder manual-hidden
 *    registry (`manual-hidden.svelte.ts`), which `displayEntries` filters out
 *    while the "Show Manually Hidden Items" setting is off. The registry
 *    persists to localStorage, so hides survive navigation and reload. Turning
 *    the setting on reveals hidden items dimmed so they can be unhidden.
 */
import { test, expect, type Page } from "@playwright/test";
import { waitForEntries, pressShortcut } from "./helpers";

function entry(page: Page, name: string) {
  return page.locator(".entry-item", { hasText: name }).first();
}

async function rightClickMenu(page: Page, name: string) {
  const item = entry(page, name);
  await item.click();
  await expect(item).toHaveClass(/selected/);
  await item.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

test.describe("Empty-folder markers", () => {
  test("an empty directory is marked and a non-empty one is not", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    // Archive is seeded empty → resolves to the empty-folder cue (a frame late).
    await expect(entry(page, "Archive")).toHaveClass(/empty-folder/, { timeout: 5000 });

    // Documents has contents → never gets the marker.
    await expect(entry(page, "Documents")).not.toHaveClass(/empty-folder/);
  });
});

test.describe("Manually-hidden items", () => {
  test("hiding an item removes it from the listing and persists", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await expect(entry(page, "readme.txt")).toBeVisible();

    const menu = await rightClickMenu(page, "readme.txt");
    await menu.getByText("Hide", { exact: true }).click();

    // Removed from the current listing.
    await expect(page.locator(".entry-item .entry-name", { hasText: "readme.txt" })).toHaveCount(0);

    // Persists across navigation: into Documents and back.
    await entry(page, "Documents").dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
    await waitForEntries(page);
    await page.keyboard.press("Control+Alt+ArrowUp");
    await waitForEntries(page);
    await expect(page.locator(".entry-item .entry-name", { hasText: "readme.txt" })).toHaveCount(0);

    // Persists across a full reload (registry is restored from localStorage).
    await page.reload();
    await waitForEntries(page);
    await expect(page.locator(".entry-item .entry-name", { hasText: "readme.txt" })).toHaveCount(0);
    // Sibling files are unaffected.
    await expect(entry(page, "notes.md")).toBeVisible();
  });

  test("revealing hidden items lets you unhide, restoring the entry", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForEntries(page);

    // Hide it first.
    const hideMenu = await rightClickMenu(page, "readme.txt");
    await hideMenu.getByText("Hide", { exact: true }).click();
    await expect(page.locator(".entry-item .entry-name", { hasText: "readme.txt" })).toHaveCount(0);

    // Enable "Show Manually Hidden Items" in settings.
    await pressShortcut(page, ",", { ctrlKey: true });
    const settings = page.locator(".settings-dialog");
    await expect(settings).toBeVisible({ timeout: 2000 });
    await settings.locator(".settings-search").fill("Manually Hidden");
    const row = settings.locator('.setting-row:has-text("Show Manually Hidden Items")');
    // The checkbox is visually hidden behind a styled slider; click the slider.
    await row.locator(".toggle-slider").click();
    await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    await settings.locator(".close-btn").click();
    await expect(settings).toBeHidden();

    // The item reappears, dimmed (hidden-entry).
    await expect(entry(page, "readme.txt")).toBeVisible();
    await expect(entry(page, "readme.txt")).toHaveClass(/hidden-entry/);

    // Unhide it via the context menu.
    const unhideMenu = await rightClickMenu(page, "readme.txt");
    await unhideMenu.getByText("Unhide", { exact: true }).click();

    // Restored as a normal (no longer dimmed) entry.
    await expect(entry(page, "readme.txt")).toBeVisible();
    await expect(entry(page, "readme.txt")).not.toHaveClass(/hidden-entry/);
  });
});

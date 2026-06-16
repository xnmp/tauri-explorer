import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries, switchViewMode } from "./helpers";

/**
 * Regression coverage for the batch of Windows-branch fixes:
 *  - back/forward right-click history popup
 *  - context menu in empty folders
 *  - List/Tiles always sort by name (ignore Details' per-folder sort pref)
 *  - removable-drive-removed pane state
 */

test.describe("Navigation history popup", () => {
  test("right-clicking Back shows the full history; clicking an entry jumps", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Build some history: home -> Documents -> project
    await page.locator('.entry-item:has-text("Documents")').first().dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("Documents");
    await page.locator('.entry-item:has-text("project")').first().dblclick();
    await expect(page.locator(".breadcrumbs-container")).toContainText("project");

    // Right-click Back -> history popup with all three slots, current checked
    await page.locator('button[aria-label="Go back"]').click({ button: "right" });
    const menu = page.locator(".history-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".history-item")).toHaveCount(3);
    await expect(menu.locator(".history-item.current")).toContainText("project");

    // Jump straight to the oldest entry (home/user)
    await menu.locator('.history-item:has-text("user")').last().click();
    await expect(menu).toBeHidden();
    await expect(page.locator(".breadcrumbs-container")).not.toContainText("project");
  });
});

test.describe("Context menu in empty folder", () => {
  test("right-click in an empty folder still opens the directory context menu", async ({ page }) => {
    await page.goto("/?path=/home/user/Archive");
    await page.waitForSelector(".file-list");
    await expect(page.locator(".empty-state")).toBeVisible();

    // Right-click the empty-state placeholder (previously swallowed the event)
    await page.locator(".empty-state").click({ button: "right" });
    const menu = page.locator(".context-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator('.menu-item:has-text("New folder")')).toBeVisible();
  });
});

test.describe("List/Tiles always sort by name", () => {
  test("List view stays name-ascending even when Details is sorted name-descending", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    // Details: Name defaults to ascending, so one click toggles to descending.
    await page.locator(".column-header.name-column").click();
    // Confirm Details is descending (report.pdf before budget.xlsx)
    const detailsNames = await page.locator(".list-view .entry-name, .details-view .entry-name").allTextContents();
    expect(detailsNames.indexOf("report.pdf")).toBeLessThan(detailsNames.indexOf("budget.xlsx"));

    // Switch to List view -> must be name ascending regardless
    await switchViewMode(page, "list");
    const listNames = (await page.locator(".list-view .entry-name").allTextContents()).filter(Boolean);
    const files = listNames.filter((n) => n !== "project");
    const sorted = [...files].sort((a, b) => a.localeCompare(b));
    expect(files).toEqual(sorted);
  });
});

test.describe("Removable drive removed", () => {
  test("ejecting the drive a pane sits on shows the drive-gone state", async ({ page }) => {
    await page.goto("/?path=/media/user/USB_DRIVE");
    await waitForEntries(page);

    // Simulate unplugging the drive (mock test hook); store re-polls every ~1.5s
    await page.evaluate(() => (window as unknown as { __mockEjectDrive: (p: string) => void }).__mockEjectDrive("/media/user/USB_DRIVE"));

    await expect(page.locator(".drive-gone-state")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".drive-gone-state")).toContainText("Removable drive gone");
  });
});

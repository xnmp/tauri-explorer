/**
 * E2E Tests for recently implemented features:
 * - Themed icons (tauri-pghn / tauri-enf4)
 * - Configurable nav bar buttons (tauri-k4ec)
 * - Status bar (tauri-on1c)
 * - Symlink badge (tauri-vozb)
 * - Drag move default (tauri-2dgf)
 * - Bookmarks config file persistence (tauri-ti0l)
 */

import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, MULTI_SELECT_MODIFIER } from "./helpers";

async function waitForFileList(page: import("@playwright/test").Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function closeSettings(page: import("@playwright/test").Page) {
  const closeBtn = page.locator(".settings-dialog .close-btn");
  await closeBtn.click();
  await expect(page.locator(".settings-dialog")).not.toBeVisible();
}

/**
 * Find a setting row by exact label text, scroll it into view, and return helpers
 * for interacting with its toggle checkbox.
 *
 * The checkbox <input> is hidden (opacity:0, width:0, height:0) behind a custom
 * .toggle-slider UI, so we click the wrapping <label class="toggle"> for interactions
 * and read the hidden <input> for assertion state.
 */
async function getSettingToggle(
  page: import("@playwright/test").Page,
  labelText: string,
) {
  // Use exact text matching via a filter function to avoid partial matches
  // (e.g., "Back" must not match "Background Opacity")
  const rows = page.locator(".setting-row");
  const row = rows.filter({
    has: page.locator(".setting-label", { hasText: new RegExp(`^${labelText}$`) }),
  });

  // Scroll the row into view within the dialog's scrollable .dialog-content
  await row.scrollIntoViewIfNeeded();

  const input = row.locator('input[type="checkbox"]');
  const toggleLabel = row.locator("label.toggle");

  return {
    /** The hidden checkbox input — use for toBeChecked() / not.toBeChecked() assertions */
    input,
    /** Click the visible toggle label to change state */
    async check() {
      if (!(await input.isChecked())) {
        await toggleLabel.click();
      }
    },
    async uncheck() {
      if (await input.isChecked()) {
        await toggleLabel.click();
      }
    },
  };
}

// ==========================================================
// 1. Theme System
// ==========================================================
test.describe("Theme System", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("theme selector shows available themes including hacker", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");
    await expect(themeSelect).toBeVisible();

    // Get all options
    const options = await themeSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThanOrEqual(6);

    // Hacker theme should be available
    expect(options.some((o) => /hacker/i.test(o))).toBe(true);
  });

  test("switching themes changes data-theme attribute @smoke", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");

    // Switch to dark
    await themeSelect.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // Switch to hacker
    await themeSelect.selectOption("hacker");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");
  });

  test("hacker theme defines monospace font in stylesheet", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");
    await themeSelect.selectOption("hacker");
    await closeSettings(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");

    // Verify the hacker theme's monospace font rule exists in the loaded stylesheets.
    // (The CSS variable on :root may be overridden by component styles due to specificity,
    // so we check the stylesheet rule directly.)
    const hasMonospaceRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule.cssText?.includes('data-theme="hacker"') &&
              rule.cssText?.includes("monospace")
            ) {
              return true;
            }
          }
        } catch {
          // Cross-origin stylesheet, skip
        }
      }
      return false;
    });
    expect(hasMonospaceRule).toBe(true);
  });

  test("hacker theme shows powerline breadcrumbs", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");
    await themeSelect.selectOption("hacker");
    await closeSettings(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "hacker");

    // Powerline separators should be visible, chevrons hidden
    const powerline = page.locator(".breadcrumb-powerline").first();
    const chevron = page.locator(".breadcrumb-chevron").first();

    // Check display values - powerline should be visible in hacker theme
    if (await powerline.count() > 0) {
      const powerlineDisplay = await powerline.evaluate((el) =>
        getComputedStyle(el).display
      );
      expect(powerlineDisplay).not.toBe("none");
    }
    if (await chevron.count() > 0) {
      const chevronDisplay = await chevron.evaluate((el) =>
        getComputedStyle(el).display
      );
      expect(chevronDisplay).toBe("none");
    }
  });

  test("theme persists after page reload", async ({ page }) => {
    await openSettings(page);
    await page.locator(".color-theme-select").selectOption("ocean-blue");
    await closeSettings(page);

    // Reload the page
    await page.reload();
    await waitForFileList(page);

    const theme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(theme).toBe("ocean-blue");
  });
});

// ==========================================================
// 2. Configurable Navigation Bar Buttons
// ==========================================================
test.describe("Navigation Bar Buttons", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("back, forward, and up buttons are visible by default", async ({ page }) => {
    await expect(page.locator('button[title*="Back"]')).toBeVisible();
    await expect(page.locator('button[title*="Forward"]')).toBeVisible();
    await expect(page.locator('button[title*="Up"]')).toBeVisible();
  });

  test("refresh button is hidden by default", async ({ page }) => {
    await expect(page.locator('button[title*="Refresh"]')).not.toBeVisible();
  });

  test("toggling back button hides it from nav bar", async ({ page }) => {
    await openSettings(page);

    const backToggle = await getSettingToggle(page, "Back");
    await expect(backToggle.input).toBeChecked();

    await backToggle.uncheck();

    await closeSettings(page);

    // Back button should be gone
    await expect(page.locator('button[title*="Back"]')).not.toBeVisible();
  });

  test("enabling refresh button shows it in nav bar", async ({ page }) => {
    await openSettings(page);

    const refreshToggle = await getSettingToggle(page, "Refresh");
    await expect(refreshToggle.input).not.toBeChecked();

    await refreshToggle.check();

    await closeSettings(page);

    // Refresh button should now be visible
    await expect(page.locator('button[title*="Refresh"]')).toBeVisible();
  });

  test("nav button settings persist after reload", async ({ page }) => {
    await openSettings(page);

    const refreshToggle = await getSettingToggle(page, "Refresh");
    await refreshToggle.check();
    await closeSettings(page);

    // Reload
    await page.reload();
    await waitForFileList(page);

    // Refresh should still be visible
    await expect(page.locator('button[title*="Refresh"]')).toBeVisible();
  });
});

// ==========================================================
// 3. Status Bar
// ==========================================================
test.describe("Status Bar", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("status bar shows item count", async ({ page }) => {
    const statusLeft = page.locator(".status-left");
    // Should show "N items" text
    await expect(statusLeft).toContainText(/\d+ items?/);
  });

  test("selecting files updates status bar", async ({ page }) => {
    // Click a file to select it
    const fileItem = page.locator(".entry-item").first();
    await fileItem.click();

    // Status bar should show selection info
    const selectedInfo = page.locator(".selected-info");
    await expect(selectedInfo).toBeVisible();
    await expect(selectedInfo).toContainText(/1 selected/);
  });

  test("selecting multiple files shows count", async ({ page }) => {
    const items = page.locator(".entry-item");
    const itemCount = await items.count();
    if (itemCount >= 2) {
      // Click first item
      await items.first().click();
      // Ctrl+click second item
      await items.nth(1).click({ modifiers: [MULTI_SELECT_MODIFIER] });

      const selectedInfo = page.locator(".selected-info");
      await expect(selectedInfo).toContainText(/2 selected/);
    }
  });

  test("settings toggle hides/shows status bar", async ({ page }) => {
    await openSettings(page);

    const toggle = await getSettingToggle(page, "Show Status Bar");
    await expect(toggle.input).toBeChecked();

    await toggle.uncheck();
    await closeSettings(page);

    // Status bar should be hidden
    await expect(page.locator(".status-bar")).not.toBeVisible();

    // Re-enable
    await openSettings(page);
    const toggle2 = await getSettingToggle(page, "Show Status Bar");
    await toggle2.check();
    await closeSettings(page);

    await expect(page.locator(".status-bar")).toBeVisible();
  });

  test("status bar visibility persists after reload", async ({ page }) => {
    // Hide status bar
    await openSettings(page);
    const toggle = await getSettingToggle(page, "Show Status Bar");
    await toggle.uncheck();
    await closeSettings(page);

    // Reload
    await page.reload();
    await waitForFileList(page);

    // Should still be hidden
    await expect(page.locator(".status-bar")).not.toBeVisible();
  });
});

// ==========================================================
// 4. Bookmarks (Quick Access)
// ==========================================================
test.describe("Bookmarks", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("default system folders are shown", async ({ page }) => {
    const sidebar = page.locator(".sidebar");
    // Check for common system folders
    await expect(sidebar.getByText("Downloads")).toBeVisible();
    await expect(sidebar.getByText("Documents")).toBeVisible();
    await expect(sidebar.getByText("Pictures")).toBeVisible();
  });

  // Browser/mock contracts: these gestures exercise the DOM bookmark adapter,
  // not native GTK/Windows file transport.
  const paths = ["/home/user/Documents", "/home/user/Downloads"];
  const bookmarks = (page: Page) => page.locator(".sidebar .user-bookmark");
  const bookmarkPaths = (page: Page) => bookmarks(page).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-path")),
  );

  async function pinFolder(page: Page, path: string) {
    const folder = page.locator(
      `.pane-tree:not(.retained) .entry-item.directory[data-path="${path}"]`,
    );
    await expect(folder).toBeVisible();
    await folder.dragTo(page.locator(".quick-access .section-header"));
    await expect(page.locator(`.sidebar .user-bookmark[data-path="${path}"]`)).toBeVisible();
    await expect(folder).toBeVisible();
  }

  test("clicking a system folder navigates to it", async ({ page }) => {
    const documentsBtn = page
      .locator(".sidebar .folder-item")
      .filter({ hasText: "Documents" });
    await documentsBtn.click();

    // Breadcrumbs should contain "Documents"
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("Documents");
  });

  for (const mode of ALL_VIEW_MODES) {
    test.describe(`bookmark outcomes (${mode})`, () => {
      test.beforeEach(async ({ page }) => {
        await page.goto(`/?path=/home/user&viewMode=${mode}`);
        await waitForFileList(page);
        await expect(page.locator(`.${mode}-view:visible`)).toBeVisible();
        await expect(bookmarks(page)).toHaveCount(0);
      });

      test("dragging a folder to Quick Access adds bookmark", async ({ page }) => {
        await pinFolder(page, paths[0]);
        await expect.poll(() => bookmarkPaths(page)).toEqual([paths[0]]);
        await expect(bookmarks(page).locator(":scope > span")).toHaveText(["Documents"]);
      });

      test("removing a bookmark works", async ({ page }) => {
        for (const path of paths) await pinFolder(page, path);
        await expect.poll(() => bookmarkPaths(page)).toEqual(paths);
        const removed = page.locator(`.sidebar .user-bookmark[data-path="${paths[0]}"]`);
        await removed.hover();
        await removed.getByTitle("Unpin from Bookmarks").click();
        await expect.poll(() => bookmarkPaths(page)).toEqual([paths[1]]);
        await page.reload();
        await waitForFileList(page);
        await expect.poll(() => bookmarkPaths(page)).toEqual([paths[1]]);
      });

      test("bookmarks persist after reload", async ({ page }) => {
        for (const path of paths) await pinFolder(page, path);
        await expect.poll(() => bookmarkPaths(page)).toEqual(paths);
        await page.reload();
        await waitForFileList(page);
        await expect.poll(() => bookmarkPaths(page)).toEqual(paths);
        await expect(bookmarks(page).locator(":scope > span")).toHaveText(["Documents", "Downloads"]);
      });

      test("bookmark reordering via drag", async ({ page }) => {
        for (const path of paths) await pinFolder(page, path);
        await expect.poll(() => bookmarkPaths(page)).toEqual(paths);
        await bookmarks(page).first().dragTo(bookmarks(page).nth(1));
        await expect.poll(() => bookmarkPaths(page)).toEqual([...paths].reverse());
        await page.reload();
        await waitForFileList(page);
        await expect.poll(() => bookmarkPaths(page)).toEqual([...paths].reverse());
      });
    });
  }
});

// ==========================================================
// 5. Combined Feature Interactions
// ==========================================================
test.describe("Feature Interactions", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?path=/home/user");
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);
  });

  test("status bar updates when navigating via sidebar", async ({ page }) => {
    const statusPath = page.locator(".status-path");
    const initialPath = await statusPath.textContent();

    // Navigate via sidebar
    const documentsBtn = page
      .locator(".sidebar .folder-item")
      .filter({ hasText: "Documents" });
    await documentsBtn.click();

    await expect(statusPath).not.toHaveText(initialPath ?? "");
    await expect(statusPath).toContainText("Documents");
  });

  test("theme change preserves status bar visibility", async ({ page }) => {
    // Status bar visible
    await expect(page.locator(".status-bar")).toBeVisible();

    // Change theme
    await openSettings(page);
    await page.locator(".color-theme-select").selectOption("dark");
    await closeSettings(page);

    // Status bar still visible
    await expect(page.locator(".status-bar")).toBeVisible();
  });

  test("hiding sidebar preserves status bar and nav buttons", async ({ page }) => {
    // Both should be visible initially
    await expect(page.locator(".status-bar")).toBeVisible();
    await expect(page.locator(".sidebar")).toBeVisible();

    // Toggle sidebar via settings
    await openSettings(page);
    const sidebarToggle = await getSettingToggle(page, "Show Sidebar");
    await sidebarToggle.uncheck();
    await closeSettings(page);

    // Sidebar hidden, but status bar and nav buttons still visible
    await expect(page.locator(".sidebar")).not.toBeVisible();
    await expect(page.locator(".status-bar")).toBeVisible();
    await expect(page.locator('button[title*="Back"]')).toBeVisible();
  });

  test("all settings reset clears nav button customization", async ({ page }) => {
    // First, customize: enable refresh button
    await openSettings(page);
    const refreshToggle = await getSettingToggle(page, "Refresh");
    await refreshToggle.check();
    await closeSettings(page);

    // Verify refresh is visible
    await expect(page.locator('button[title*="Refresh"]')).toBeVisible();

    // Clear all settings
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await waitForFileList(page);

    // Refresh should be hidden again (default)
    await expect(page.locator('button[title*="Refresh"]')).not.toBeVisible();
  });
});

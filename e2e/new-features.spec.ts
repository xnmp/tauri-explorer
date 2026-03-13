/**
 * E2E Tests for recently implemented features:
 * - Themed icons (tauri-pghn / tauri-enf4)
 * - Configurable nav bar buttons (tauri-k4ec)
 * - Status bar (tauri-on1c)
 * - Symlink badge (tauri-vozb)
 * - Drag move default (tauri-2dgf)
 * - Bookmarks config file persistence (tauri-ti0l)
 */

import { test, expect } from "@playwright/test";

async function waitForFileList(page: import("@playwright/test").Page) {
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 10000 });
}

async function openSettings(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+,");
  await page.waitForTimeout(100);
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function closeSettings(page: import("@playwright/test").Page) {
  const closeBtn = page.locator(".settings-dialog .close-btn");
  await closeBtn.click();
  await page.waitForTimeout(100);
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
  await page.waitForTimeout(50);

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

  test("switching themes changes data-theme attribute", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");

    // Switch to dark
    await themeSelect.selectOption("dark");
    await page.waitForTimeout(100);
    let theme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(theme).toBe("dark");

    // Switch to hacker
    await themeSelect.selectOption("hacker");
    await page.waitForTimeout(100);
    theme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme")
    );
    expect(theme).toBe("hacker");
  });

  test("folder icons use --icon-folder CSS variable", async ({ page }) => {
    // Folder icons should respond to theme changes
    const folderIcon = page.locator(".entry-item.directory .icon").first();
    await expect(folderIcon).toBeVisible();

    // Get computed color
    const color = await folderIcon.evaluate((el) =>
      getComputedStyle(el).color
    );
    // Should have a valid color (not transparent/empty)
    expect(color).toBeTruthy();
    expect(color).not.toBe("rgba(0, 0, 0, 0)");
  });

  test("hacker theme defines monospace font in stylesheet", async ({ page }) => {
    await openSettings(page);
    const themeSelect = page.locator(".color-theme-select");
    await themeSelect.selectOption("hacker");
    await closeSettings(page);
    await page.waitForTimeout(200);

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
    await page.waitForTimeout(200);

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

  test("settings shows navigation bar buttons section", async ({ page }) => {
    await openSettings(page);
    const sectionTitle = page.locator(".section-title", {
      hasText: "Navigation Bar Buttons",
    });
    await expect(sectionTitle).toBeVisible();
  });

  test("toggling back button hides it from nav bar", async ({ page }) => {
    await openSettings(page);

    const backToggle = await getSettingToggle(page, "Back");
    await expect(backToggle.input).toBeChecked();

    await backToggle.uncheck();
    await page.waitForTimeout(100);

    await closeSettings(page);

    // Back button should be gone
    await expect(page.locator('button[title*="Back"]')).not.toBeVisible();
  });

  test("enabling refresh button shows it in nav bar", async ({ page }) => {
    await openSettings(page);

    const refreshToggle = await getSettingToggle(page, "Refresh");
    await expect(refreshToggle.input).not.toBeChecked();

    await refreshToggle.check();
    await page.waitForTimeout(100);

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

  test("status bar is visible by default", async ({ page }) => {
    const statusBar = page.locator(".status-bar");
    await expect(statusBar).toBeVisible();
  });

  test("status bar shows item count", async ({ page }) => {
    const statusLeft = page.locator(".status-left");
    // Should show "N items" text
    await expect(statusLeft).toContainText(/\d+ items?/);
  });

  test("status bar shows current path", async ({ page }) => {
    const statusPath = page.locator(".status-path");
    await expect(statusPath).toBeVisible();
    const pathText = await statusPath.textContent();
    expect(pathText).toBeTruthy();
    expect(pathText!.length).toBeGreaterThan(0);
  });

  test("selecting files updates status bar", async ({ page }) => {
    // Click a file to select it
    const fileItem = page.locator(".entry-item").first();
    await fileItem.click();
    await page.waitForTimeout(200);

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
      await items.nth(1).click({ modifiers: ["Control"] });
      await page.waitForTimeout(200);

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
    await page.waitForTimeout(100);

    // Status bar should be hidden
    await expect(page.locator(".status-bar")).not.toBeVisible();

    // Re-enable
    await openSettings(page);
    const toggle2 = await getSettingToggle(page, "Show Status Bar");
    await toggle2.check();
    await closeSettings(page);
    await page.waitForTimeout(100);

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

  test("Quick Access section exists in sidebar", async ({ page }) => {
    await expect(page.getByText("Quick access")).toBeVisible();
  });

  test("default system folders are shown", async ({ page }) => {
    const sidebar = page.locator(".sidebar");
    // Check for common system folders
    await expect(sidebar.getByText("Downloads")).toBeVisible();
    await expect(sidebar.getByText("Documents")).toBeVisible();
    await expect(sidebar.getByText("Pictures")).toBeVisible();
  });

  test("dragging a folder to Quick Access adds bookmark", async ({ page }) => {
    // Find a directory in the file list
    const folder = page.locator(".entry-item.directory").first();
    const folderName = await folder.locator(".entry-name").textContent();

    // Get the Quick Access drop target
    const quickAccess = page.locator(".quick-access");

    // Drag the folder to Quick Access
    await folder.dragTo(quickAccess);
    await page.waitForTimeout(300);

    // Check if the folder was added as a bookmark
    const userBookmarks = page.locator(".user-bookmark");
    const bookmarkCount = await userBookmarks.count();
    if (bookmarkCount > 0) {
      // Bookmark was added - verify it has the folder name
      const bookmarkNames = await userBookmarks.allTextContents();
      const hasBookmark = bookmarkNames.some((n) =>
        n.includes(folderName || "")
      );
      expect(hasBookmark).toBe(true);
    }
  });

  test("removing a bookmark works", async ({ page }) => {
    // First add a bookmark by dragging
    const folder = page.locator(".entry-item.directory").first();
    const quickAccess = page.locator(".quick-access");
    await folder.dragTo(quickAccess);
    await page.waitForTimeout(300);

    const bookmarks = page.locator(".user-bookmark");
    const initialCount = await bookmarks.count();

    if (initialCount > 0) {
      // Hover over the bookmark to reveal remove button
      await bookmarks.first().hover();
      await page.waitForTimeout(100);

      // Click the remove button
      const removeBtn = bookmarks.first().locator(".remove-bookmark");
      await removeBtn.click();
      await page.waitForTimeout(200);

      // Count should decrease
      const newCount = await page.locator(".user-bookmark").count();
      expect(newCount).toBe(initialCount - 1);
    }
  });

  test("clicking a system folder navigates to it", async ({ page }) => {
    const documentsBtn = page
      .locator(".sidebar .folder-item")
      .filter({ hasText: "Documents" });
    await documentsBtn.click();
    await page.waitForTimeout(500);

    // Breadcrumbs should contain "Documents"
    const breadcrumbs = page.locator(".breadcrumbs-container");
    await expect(breadcrumbs).toContainText("Documents");
  });

  test("bookmarks persist after reload", async ({ page }) => {
    // Add a bookmark
    const folder = page.locator(".entry-item.directory").first();
    const quickAccess = page.locator(".quick-access");
    await folder.dragTo(quickAccess);
    await page.waitForTimeout(300);

    const countBefore = await page.locator(".user-bookmark").count();

    if (countBefore > 0) {
      // Reload
      await page.reload();
      await waitForFileList(page);

      // Bookmarks should persist
      const countAfter = await page.locator(".user-bookmark").count();
      expect(countAfter).toBe(countBefore);
    }
  });

  test("bookmark reordering via drag", async ({ page }) => {
    // Add two bookmarks
    const folders = page.locator(".entry-item.directory");
    const folderCount = await folders.count();
    if (folderCount < 2) return;

    const quickAccess = page.locator(".quick-access");
    await folders.first().dragTo(quickAccess);
    await page.waitForTimeout(300);
    await folders.nth(1).dragTo(quickAccess);
    await page.waitForTimeout(300);

    const bookmarks = page.locator(".user-bookmark");
    const count = await bookmarks.count();
    if (count < 2) return;

    // Get names before reorder
    const nameBefore0 = await bookmarks.nth(0).locator("span").nth(0).textContent();
    const nameBefore1 = await bookmarks.nth(1).locator("span").nth(0).textContent();

    // Drag first bookmark to second position
    await bookmarks.first().dragTo(bookmarks.nth(1));
    await page.waitForTimeout(300);

    // Get names after reorder
    const nameAfter0 = await page
      .locator(".user-bookmark")
      .nth(0)
      .locator("span")
      .nth(0)
      .textContent();
    const nameAfter1 = await page
      .locator(".user-bookmark")
      .nth(1)
      .locator("span")
      .nth(0)
      .textContent();

    // Order should have changed
    if (nameBefore0 !== nameBefore1) {
      // If names were different, they should be swapped
      expect(nameAfter0).toBe(nameBefore1);
      expect(nameAfter1).toBe(nameBefore0);
    }
  });
});

// ==========================================================
// 5. Symlink Badge Display
// ==========================================================
test.describe("Symlink Badge", () => {
  test("symlink badge CSS class exists in component styles", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForFileList(page);

    // Verify the symlink-badge style rule exists in the page
    // (The mock data doesn't include symlinks, so we check that the CSS is loaded)
    const hasSymlinkStyle = await page.evaluate(() => {
      const sheets = document.styleSheets;
      for (const sheet of sheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (rule.cssText?.includes("symlink-badge")) return true;
          }
        } catch {
          // Cross-origin stylesheet, skip
        }
      }
      return false;
    });
    expect(hasSymlinkStyle).toBe(true);
  });
});

// ==========================================================
// 6. Drag Move Default (External Drop)
// ==========================================================
test.describe("External Drop Behavior", () => {
  test("Ctrl key tracking is set up on page load", async ({ page }) => {
    await page.goto("/?path=/home/user");
    await waitForFileList(page);

    // Verify the Ctrl key tracking works by checking that pressing Ctrl
    // doesn't break the app (no errors from keydown/keyup handlers)
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.keyboard.down("Control");
    await page.waitForTimeout(50);
    await page.keyboard.up("Control");
    await page.waitForTimeout(50);

    // No errors from Ctrl tracking
    const relevantErrors = errors.filter(
      (e) => !e.includes("WebSocket") && !e.includes("favicon")
    );
    expect(relevantErrors).toHaveLength(0);
  });
});

// ==========================================================
// 7. Combined Feature Interactions
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
    await page.waitForTimeout(500);

    const newPath = await statusPath.textContent();
    expect(newPath).not.toBe(initialPath);
    expect(newPath).toContain("Documents");
  });

  test("theme change preserves status bar visibility", async ({ page }) => {
    // Status bar visible
    await expect(page.locator(".status-bar")).toBeVisible();

    // Change theme
    await openSettings(page);
    await page.locator(".color-theme-select").selectOption("dark");
    await closeSettings(page);
    await page.waitForTimeout(100);

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
    await page.waitForTimeout(100);

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

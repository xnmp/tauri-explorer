/**
 * E2E: plugin system foundation (#142).
 *
 * Exercises every plugin seam through the built-in demo plugin (ships disabled,
 * enabled here via the Settings toggle):
 *   - command appears in the palette and runs (toast)
 *   - context-menu item appears on a file and runs (toast)
 *   - demo:// virtual folder renders synthetic entries
 *   - disabling removes the command and the context-menu item
 */
import { test, expect, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

async function openSettings(page: Page) {
  await page.keyboard.press("Control+,");
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible({ timeout: 2000 });
  return dialog;
}

async function closeSettings(page: Page) {
  await page.locator(".settings-dialog .close-btn").click();
  await expect(page.locator(".settings-dialog")).toBeHidden();
}

async function setDemoPluginEnabled(page: Page, enabled: boolean) {
  const dialog = await openSettings(page);
  const row = dialog.locator('.setting-row:has-text("Demo Plugin")').first();
  const toggle = row.locator('input[type="checkbox"]').first();
  await expect(toggle).toHaveCount(1);
  // The native checkbox is visually hidden behind the toggle-slider; click the
  // visible toggle label (only when a change is needed) to fire the handler.
  if ((await toggle.isChecked()) !== enabled) {
    await row.locator("label.toggle").click();
  }
  await expect(toggle).toBeChecked({ checked: enabled });
  await closeSettings(page);
}

async function openPalette(page: Page) {
  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await palette.waitFor({ state: "visible", timeout: 2000 });
  return palette;
}

test.describe("Plugin system (demo plugin)", () => {
  test("enabling the plugin exposes its command, which runs and shows a toast", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    // Not present before enabling.
    let palette = await openPalette(page);
    await palette.locator(".search-input").fill("Demo: Hello");
    await expect(palette.locator('.command-item:has-text("Demo: Hello")')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    await setDemoPluginEnabled(page, true);

    // Now the command is available and runs.
    palette = await openPalette(page);
    await palette.locator(".search-input").fill("Demo: Hello");
    const cmd = palette.locator('.command-item:has-text("Demo: Hello")');
    await expect(cmd).toBeVisible();
    await cmd.click();

    await expect(page.locator(".toast").filter({ hasText: "Hello from the demo plugin" })).toBeVisible({ timeout: 2000 });
  });

  test("context-menu item appears on a file and runs", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setDemoPluginEnabled(page, true);

    const entry = page.locator(".entry-item").filter({ hasText: "readme.txt" }).first();
    await entry.click();
    await entry.click({ button: "right" });

    const menu = page.locator(".context-menu");
    await menu.waitFor({ state: "visible", timeout: 2000 });
    const item = menu.locator('.menu-item:has-text("Demo: Greet Selection")');
    await expect(item).toBeVisible();
    await item.click();

    await expect(page.locator(".toast").filter({ hasText: "Demo greets: readme.txt" })).toBeVisible({ timeout: 2000 });
  });

  test("navigating to demo:// renders synthetic entries", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setDemoPluginEnabled(page, true);

    // Use the plugin-registered command to navigate to the virtual folder.
    const palette = await openPalette(page);
    await palette.locator(".search-input").fill("Demo: Open Virtual Folder");
    const cmd = palette.locator('.command-item:has-text("Demo: Open Virtual Folder")');
    await expect(cmd).toBeVisible();
    await cmd.click();
    await expect(palette).toBeHidden();

    // Synthetic entries from the demo:// provider must render in the file list.
    await expect(page.locator(".entry-item").filter({ hasText: "hello.txt" }).first()).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".entry-item").filter({ hasText: "readme.md" }).first()).toBeVisible();
    await expect(page.locator(".entry-item").filter({ hasText: "subfolder" }).first()).toBeVisible();
  });

  test("disabling the plugin removes its command and context-menu item", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await setDemoPluginEnabled(page, true);
    await setDemoPluginEnabled(page, false);

    // Command gone from the palette.
    const palette = await openPalette(page);
    await palette.locator(".search-input").fill("Demo: Hello");
    await expect(palette.locator('.command-item:has-text("Demo: Hello")')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // Context-menu item gone.
    const entry = page.locator(".entry-item").filter({ hasText: "readme.txt" }).first();
    await entry.click();
    await entry.click({ button: "right" });
    const menu = page.locator(".context-menu");
    await menu.waitFor({ state: "visible", timeout: 2000 });
    await expect(menu.locator('.menu-item:has-text("Demo: Greet Selection")')).toHaveCount(0);
  });
});

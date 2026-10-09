/**
 * Regression coverage for grouped AI context-menu actions (#589, #992).
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("groups applicable AI actions in a submenu and keeps destination suggestions reachable", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);

  const entry = page.locator(".entry-item").filter({ hasText: "notes.md" }).first();
  await entry.click();
  await entry.click({ button: "right" });

  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();

  // AI actions must not compete with file operations in the top-level menu.
  const topLevelItems = menu.locator(":scope > .menu-item");
  await expect(topLevelItems.filter({ hasText: "Suggest destination" })).toHaveCount(0);
  const aiTrigger = menu.getByRole("menuitem", { name: "AI", exact: true });
  const aiMenu = menu.locator(".ai-submenu");
  await expect(aiTrigger).toBeVisible();
  await expect(aiMenu).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-1-ai-submenu-entry.png" });

  // Clicking the trigger must open the submenu even though the pointer also
  // enters its hover target.
  await aiTrigger.click();
  await expect(aiMenu.getByText("Suggest destination…", { exact: true })).toBeVisible();
  await expect(aiMenu.getByText("Suggest rename…", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-2-ai-actions.png" });

  // Closing the root menu must not leave the component's local submenu state
  // open for the next right-click.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await entry.click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(aiMenu).toHaveCount(0);

  await aiTrigger.click();
  await aiMenu.getByText("Suggest destination…", { exact: true }).click();
  const dialog = page.locator('[aria-labelledby="ai-organize-title"]');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "evidence/ac-3-destination-dialog.png" });
});

test("groups image-theme actions under AI and keeps other plugin actions in place", async ({ page }) => {
  await page.goto("/?path=/home/user/Downloads");
  await waitForEntries(page);

  const entry = page.locator(".entry-item").filter({ hasText: "image.png" }).first();
  await entry.click();
  await entry.click({ button: "right" });

  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  const topLevelItems = menu.locator(":scope > .menu-item");
  await expect(topLevelItems.filter({ hasText: "Edit with Nano Banana" })).toHaveCount(0);
  await expect(topLevelItems.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-2-theme-image-not-top-level.png" });

  const aiTrigger = menu.getByRole("menuitem", { name: "AI", exact: true });
  await aiTrigger.hover();
  const aiMenu = menu.locator(".ai-submenu");
  const createTheme = aiMenu.getByText("Create Theme from Image", { exact: true });
  await expect(createTheme).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-theme-image-in-ai.png" });
  await page.screenshot({ path: "evidence/ac-5-context-menu-coverage.png" });
  await expect(aiMenu.getByText("Edit with Nano Banana", { exact: true })).toBeVisible();
  await expect(aiMenu.getByText("Upscale Image", { exact: true })).toBeVisible();

  // A supported image remains unavailable when selection is not singular.
  await page.keyboard.press("Escape");
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const firstImage = page.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]');
  const secondImage = page.locator('.entry-item[data-path="/home/user/Pictures/photo2.jpg"]');
  await firstImage.click();
  await secondImage.click({ modifiers: ["Control"] });
  await secondImage.click({ button: "right" });
  const multipleMenu = page.locator(".context-menu");
  await expect(multipleMenu).toBeVisible();
  await expect(multipleMenu.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);

  // Non-image selections do not expose the action either.
  await page.keyboard.press("Escape");
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  const documentMenu = page.locator(".context-menu");
  await expect(documentMenu).toBeVisible();
  await expect(documentMenu.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);

  // A virtual PNG is unsupported even though its extension is a real image type.
  await page.keyboard.press("Escape");
  await page.goto("/");
  await waitForEntries(page);
  await page.keyboard.press("Control+,");
  await expect(page.locator(".settings-dialog")).toBeVisible();
  await page.getByRole("button", { name: "Open Plugins", exact: true }).click();
  const plugins = page.locator(".plugins-dialog");
  const demoRow = plugins.locator('.setting-row:has-text("Demo Plugin")').first();
  const demoToggle = demoRow.locator('input[type="checkbox"]').first();
  if (!(await demoToggle.isChecked())) await demoRow.locator("label.toggle").click();
  await expect(demoToggle).toBeChecked();
  await plugins.locator(".close-btn").click();
  await expect(plugins).toBeHidden();

  await page.keyboard.press("Control+Shift+p");
  const palette = page.locator(".command-palette-dialog");
  await expect(palette).toBeVisible();
  await palette.locator(".search-input").fill("Demo: Open Virtual Folder");
  await palette.locator('.command-item:has-text("Demo: Open Virtual Folder")').click();
  await expect(palette).toBeHidden();
  const virtualImage = page.locator('.entry-item[data-path="demo://theme-source.png"]');
  await expect(virtualImage).toBeVisible();
  await virtualImage.click({ button: "right" });
  const virtualMenu = page.locator(".context-menu");
  await expect(virtualMenu).toBeVisible();
  await expect(virtualMenu.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-4-theme-image-unavailable.png" });
});

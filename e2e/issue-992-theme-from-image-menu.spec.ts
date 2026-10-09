/** Observable context-menu placement and selection restrictions for #992. */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("Create Theme from Image is in AI and unavailable for unsupported selections", async ({ page }) => {
  await page.goto("/?path=/home/user/Downloads");
  await waitForEntries(page);

  const image = page.locator('.entry-item[data-path="/home/user/Downloads/image.png"]');
  await image.click({ button: "right" });

  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  const topLevelItems = menu.locator(":scope > .menu-item");
  await expect(topLevelItems.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-2-theme-image-not-top-level.png" });

  const aiTrigger = menu.getByRole("menuitem", { name: "AI", exact: true });
  await aiTrigger.hover();
  const aiMenu = menu.locator(".ai-submenu");
  const createTheme = aiMenu.getByText("Create Theme from Image", { exact: true });
  await expect(createTheme).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-theme-image-in-ai.png" });
  await page.screenshot({ path: "evidence/ac-5-context-menu-coverage.png" });

  await page.keyboard.press("Escape");
  await page.goto("/?path=/home/user/Pictures");
  await waitForEntries(page);
  const firstImage = page.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]');
  const secondImage = page.locator('.entry-item[data-path="/home/user/Pictures/photo2.jpg"]');
  await firstImage.click();
  await secondImage.click({ modifiers: ["Control"] });
  await secondImage.click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(page.locator(".context-menu").getByText("Create Theme from Image", { exact: true })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  await expect(page.locator(".context-menu")).toBeVisible();
  await expect(page.locator(".context-menu").getByText("Create Theme from Image", { exact: true })).toHaveCount(0);

  // Enable the demo virtual filesystem and verify that a virtual PNG remains
  // unavailable even though its filename has a supported image extension.
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

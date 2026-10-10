/** Unsupported context-menu selections remain ineligible for #992. */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("hides the image-theme action for non-images, multiple selection, and virtual images", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await page.locator('.entry-item[data-path="/home/user/Documents/notes.md"]').click({ button: "right" });
  const documentMenu = page.locator(".context-menu");
  await expect(documentMenu).toBeVisible();
  await expect(documentMenu.getByText("Create Theme from Image", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-4-theme-image-non-image.png" });

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
  await page.screenshot({ path: "evidence/ac-6-theme-image-multi-selection.png" });

  // A virtual PNG is unsupported even though its extension is an image type.
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
  await page.screenshot({ path: "evidence/ac-5-theme-image-virtual.png" });
});

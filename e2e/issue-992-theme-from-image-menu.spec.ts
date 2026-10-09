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
  await page.screenshot({ path: "evidence/ac-4-theme-image-unavailable.png" });
});

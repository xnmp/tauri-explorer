/**
 * Regression coverage for grouped AI context-menu actions (#589).
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
  await expect(aiTrigger).toBeVisible();
  await page.mouse.move(0, 0);
  await page.screenshot({ path: "evidence/ac-1-ai-submenu-entry.png" });

  const aiMenu = menu.locator(".ai-submenu");
  await aiTrigger.hover();
  await expect(aiMenu.getByText("Suggest destination…", { exact: true })).toBeVisible();
  await expect(aiMenu.getByText("Suggest rename…", { exact: true })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-2-ai-actions.png" });

  await aiMenu.getByText("Suggest destination…", { exact: true }).click();
  const dialog = page.locator('[aria-labelledby="ai-organize-title"]');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: "evidence/ac-3-destination-dialog.png" });
});

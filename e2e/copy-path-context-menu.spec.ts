/**
 * E2E: Copy Path context-menu action (#606).
 *
 * Covers the observable text-clipboard result for files and folders in every
 * supported view mode while keeping the pre-existing context-menu suite
 * immutable.
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, waitForEntries, switchViewMode } from "./helpers";

async function rightClick(page: Page, name: string) {
  const item = page.locator(".entry-item", { hasText: name }).first();
  await item.click();
  await expect(item).toHaveClass(/selected/);
  await item.click({ button: "right" });
  const menu = page.locator(".context-menu");
  await menu.waitFor({ state: "visible", timeout: 2000 });
  return menu;
}

for (const viewMode of VIEW_MODES) {
  test.describe(`Copy Path [${viewMode}]`, () => {
    for (const [name, expectedPath] of [
      ["report.pdf", "/home/user/Documents/report.pdf"],
      ["project", "/home/user/Documents/project"],
    ]) {
      test(`writes ${name}'s full path to the text clipboard`, async ({
        page,
        context,
        browserName,
      }) => {
        test.skip(
          browserName === "webkit",
          "WebKit does not support Playwright clipboard permissions",
        );
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto("/?path=/home/user/Documents");
        await waitForEntries(page);
        if (viewMode !== "details") await switchViewMode(page, viewMode);

        const menu = await rightClick(page, name);
        await expect(menu.getByText("Copy Path", { exact: true })).toBeVisible();
        await menu.getByText("Copy Path", { exact: true }).click();

        await expect(page.locator(".toast.clipboard")).toBeVisible();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(expectedPath);
      });
    }
  });
}

test("existing folder actions remain available and Rename still starts editing", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);
  await switchViewMode(page, "tiles");

  const menu = await rightClick(page, "project");
  for (const action of ["Cut", "Copy", "Rename", "Delete", "Add to Bookmarks"]) {
    await expect(menu.getByText(action, { exact: true })).toBeVisible();
  }
  await page.screenshot({ path: "evidence/ac-2-existing-context-menu-actions.png" });

  await menu.getByText("Rename", { exact: true }).click();
  await expect(page.locator(".rename-input")).toHaveValue("project");
});

/**
 * Observable clipboard coverage for the Copy Path context-menu action (#606).
 */
import { test, expect, type Page } from "./fixtures";
import { VIEW_MODES, waitForEntries, switchViewMode, pressShortcut } from "./helpers";

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
        test.skip(browserName === "webkit", "WebKit does not support Playwright clipboard permissions");
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.goto("/?path=/home/user/Documents");
        await waitForEntries(page);
        if (viewMode !== "details") await switchViewMode(page, viewMode);

        const menu = await rightClick(page, name);
        await expect(menu.getByText("Copy Path", { exact: true })).toBeVisible();
        if (viewMode === "details" && name === "report.pdf") {
          await page.screenshot({ path: "evidence/ac-1-copy-path-menu.png" });
        }
        await menu.getByText("Copy Path", { exact: true }).click();

        await expect(page.locator(".toast.clipboard")).toBeVisible();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedPath);
      });
    }
  });
}

test("existing Copy action still pastes a selected file into another folder", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await waitForEntries(page);

  const menu = await rightClick(page, "report.pdf");
  await menu.getByText("Copy", { exact: true }).click();
  await expect(page.locator(".toast.clipboard")).toBeVisible();

  await page.keyboard.press("Control+Alt+ArrowUp");
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "Pictures" }).first().dblclick();
  await waitForEntries(page);
  await pressShortcut(page, "v", { ctrlKey: true });
  await expect
    .poll(() => page.locator(".entry-item .entry-name").allTextContents(), { timeout: 5000 })
    .toContain("report.pdf");
  await page.screenshot({ path: "evidence/ac-2-copy-paste-existing-action.png" });
});

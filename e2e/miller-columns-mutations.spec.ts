/**
 * E2E regressions for local file mutations visible in Miller columns.
 * Issue: #598
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openProjectWithMillerColumns(page: Page): Promise<void> {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);

  await page.evaluate(() => {
    const settings = JSON.parse(localStorage.getItem("explorer-settings") || "{}");
    settings.millerLayers = 2;
    localStorage.setItem("explorer-settings", JSON.stringify(settings));
    location.reload();
  });

  await waitForEntries(page);
  await expect(page.locator('.miller-col[data-path="/home/user"]')).toBeVisible();
}

test.describe("Miller columns local mutations", () => {
  test("removes a deleted sibling from its Miller source column", async ({ page }) => {
    await openProjectWithMillerColumns(page);

    const downloads = page.locator('.miller-col[data-path="/home/user"] .col-entry[data-path="/home/user/Downloads"]');
    await expect(downloads).toBeVisible();
    await downloads.click({ button: "right" });
    await page.locator(".context-menu").getByText("Delete", { exact: true }).click();
    await page.locator("[role='alertdialog']").getByRole("button", { name: /^Delete/ }).click();

    await expect(downloads).toHaveCount(0);
    await page.screenshot({ path: "evidence/ac-1-deleted-folder-removed.png" });
  });

  test("removes a moved sibling from its Miller source column", async ({ page }) => {
    await openProjectWithMillerColumns(page);

    const downloads = page.locator('.miller-col[data-path="/home/user"] .col-entry[data-path="/home/user/Downloads"]');
    await expect(downloads).toBeVisible();
    await downloads.click({ button: "right" });
    await page.locator(".context-menu").getByText("Cut", { exact: true }).click();
    await page.keyboard.press("Control+v");

    await expect(downloads).toHaveCount(0);
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project/Downloads"]')).toBeVisible();
    await page.screenshot({ path: "evidence/ac-2-moved-folder-refreshed.png" });
  });
});

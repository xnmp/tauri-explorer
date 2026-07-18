/**
 * Inline new-file creation from the background context menu (#436).
 *
 * Mirrors the New Folder flow: the "New file" action opens an inline editor
 * as the first row inside the virtualized list; naming it (touch) creates a
 * real empty file entry in the listing.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function startInlineNewFile(page: import("@playwright/test").Page) {
  await page.locator(".file-list .content").click({ button: "right", position: { x: 400, y: 400 } });
  await page.getByText("New file", { exact: true }).click();
  await expect(page.locator(".new-folder-input")).toBeVisible();
}

test.describe("Inline new file", () => {
  test("context menu exposes New file and creating it adds a real entry @smoke", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    await startInlineNewFile(page);

    // Editor rides inside the virtualized viewport as the first item.
    const editorItem = page.locator(".virtual-viewport .virtual-item").first();
    await expect(editorItem.locator(".new-folder-input")).toBeVisible();

    // Naming it creates a real file entry in the listing.
    await page.locator(".new-folder-input").fill("e2e-inline-file.txt");
    await page.keyboard.press("Enter");
    await expect(page.getByText("e2e-inline-file.txt", { exact: true })).toBeVisible();
    await expect(page.locator(".new-folder-input")).toHaveCount(0);
  });

  test("Escape cancels without creating a file", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    await startInlineNewFile(page);
    await page.keyboard.press("Escape");
    await expect(page.locator(".new-folder-input")).toHaveCount(0);
  });
});

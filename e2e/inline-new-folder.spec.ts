/**
 * Inline new-folder editor placement (#257).
 *
 * Since the views were DOM-virtualized (#128) the editor rendered as its own
 * band ABOVE the whole scroller. It must ride inside the virtual list as the
 * first row/cell, and creating the folder must still work end to end.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function startInlineNewFolder(page: import("@playwright/test").Page) {
  await page.locator(".file-list .content").click({ button: "right", position: { x: 400, y: 400 } });
  await page.getByText("New folder", { exact: true }).click();
  await expect(page.locator(".new-folder-input")).toBeVisible();
}

test.describe("Inline new folder", () => {
  test("editor renders as the first row inside the virtual list and creates the folder @smoke", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);

    await startInlineNewFolder(page);

    // Placement: inside the virtualized viewport, in the FIRST virtual item —
    // not a band above the scroller.
    const editorItem = page.locator(".virtual-viewport .virtual-item").first();
    await expect(editorItem.locator(".new-folder-input")).toBeVisible();

    // Outcome: naming it creates a real entry in the listing.
    await page.locator(".new-folder-input").fill("e2e inline folder");
    await page.keyboard.press("Enter");
    await expect(page.getByText("e2e inline folder", { exact: true })).toBeVisible();
    await expect(page.locator(".new-folder-input")).toHaveCount(0);
  });

  test("tiles view: editor occupies a grid cell inside the virtualized grid", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Tiles View");
    await page.keyboard.press("Enter");
    await expect(page.locator(".tile-item").first()).toBeVisible();

    await startInlineNewFolder(page);

    // The editor is a cell of the first virtualized tile row, next to real
    // tiles — not stacked above the grid.
    const firstRow = page.locator(".virtual-viewport .tile-row").first();
    await expect(firstRow.locator(".tile-inline-new-folder")).toBeVisible();
    // …sharing the row with real tiles, i.e. it took a grid cell.
    expect(await firstRow.locator("[data-drag-name]").count()).toBeGreaterThan(0);

    // Escape cancels without leaving artifacts.
    await page.keyboard.press("Escape");
    await expect(page.locator(".tile-inline-new-folder")).toHaveCount(0);
  });
});

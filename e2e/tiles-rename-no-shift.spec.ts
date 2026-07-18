/**
 * E2E test: starting an inline rename in Tiles view must NOT move any other
 * tile. The rename box floats above its own tile; the tile keeps its
 * pre-rename height (held open by an invisible name placeholder), so tiles in
 * later rows stay put.
 * Issue: feat/rename-box (tiles rename must not shift neighbours)
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries, switchViewMode } from "./helpers";

test.describe("Tiles rename does not shift other tiles", () => {
  test("entering rename keeps a lower-row tile in place", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await switchViewMode(page, "tiles");
    // Narrow the viewport so the (small) tiles wrap into multiple rows.
    await page.setViewportSize({ width: 720, height: 640 });
    await page.locator(".tile-item").first().waitFor();

    const tiles = page.locator(".tile-item");
    const count = await tiles.count();
    expect(count).toBeGreaterThan(2);

    // Record each tile's top, then find one in a row below the first.
    const tops: number[] = [];
    for (let i = 0; i < count; i++) {
      const box = await tiles.nth(i).boundingBox();
      tops.push(box ? box.y : NaN);
    }
    const firstRowTop = Math.min(...tops);
    const lowerIndex = tops.findIndex((y) => y > firstRowTop + 5);
    expect(
      lowerIndex,
      "test needs at least two rows of tiles — widen the listing or narrow the viewport",
    ).toBeGreaterThan(-1);

    const lowerTopBefore = tops[lowerIndex];

    // Start renaming a first-row tile (index 0 is top-left).
    await tiles.nth(0).click();
    await page.keyboard.press("F2");
    await page.locator(".tile-rename").waitFor({ state: "visible", timeout: 2000 });

    // The lower-row tile must not have moved a pixel.
    const lowerTopAfter = (await tiles.nth(lowerIndex).boundingBox())!.y;
    expect(Math.abs(lowerTopAfter - lowerTopBefore)).toBeLessThanOrEqual(1);
  });

  test("rename box at the pane's left edge is not cropped", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await switchViewMode(page, "tiles");

    // The first tile sits at the pane's left edge; a centered long-name box
    // would overflow off-screen without the inward nudge.
    await page.locator(".tile-item").first().click();
    await page.keyboard.press("F2");
    const box = page.locator(".tile-rename");
    await box.waitFor({ state: "visible", timeout: 2000 });
    await box.fill("luca-micheli-r9RW20TrQ0Y-unsplash-a-long-enough-name.jpg");

    const edges = await page.evaluate(() => {
      const el = document.querySelector(".tile-rename")!;
      const scroller = el.closest(".tiles-view")!;
      const b = el.getBoundingClientRect();
      const a = scroller.getBoundingClientRect();
      return { boxLeft: b.left, areaLeft: a.left };
    });
    expect(edges.boxLeft).toBeGreaterThanOrEqual(edges.areaLeft - 1);
  });
});

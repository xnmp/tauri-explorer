/**
 * E2E test: List view layout must stay put. Neither a long filename nor an
 * open rename box may resize/shift the equal-width columns — they truncate /
 * overflow instead (grid uses minmax(0,1fr), not 1fr).
 * Issue: feat/rename-box (list layout stability)
 */
import { test, expect } from "@playwright/test";
import { HOME_URL, waitForEntries, switchViewMode } from "./helpers";

const LONG_NAME =
  "4F7F6867D2195D2B19EEB0C460017958AB54092BD604447A41A6C98250AB9034.jpeg";

/** Index of the first item that sits in a column to the right of item 0. */
async function rightNeighbourIndex(page: import("@playwright/test").Page) {
  return page.locator(".list-item").evaluateAll((els) => {
    const left0 = els[0].getBoundingClientRect().left;
    return els.findIndex((e) => e.getBoundingClientRect().left > left0 + 5);
  });
}

test.describe("List view layout stability", () => {
  test("a long display name does not shift or widen other columns", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await switchViewMode(page, "list");

    const items = page.locator(".list-item");
    const before = await items.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().left)),
    );
    expect(before.length).toBeGreaterThan(1);

    // Simulate a very long filename in the first item.
    const changed = await items.first().evaluate((el, name) => {
      const span = el.querySelector(".name-list");
      if (!span) return false;
      span.textContent = name;
      void document.body.offsetWidth; // force reflow
      return true;
    }, LONG_NAME);
    expect(changed).toBe(true);

    const after = await items.evaluateAll((els) =>
      els.map((e) => Math.round(e.getBoundingClientRect().left)),
    );
    expect(after).toEqual(before);
  });

  test("opening a rename box does not shift the column to its right", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await switchViewMode(page, "list");

    const neighbour = await rightNeighbourIndex(page);
    expect(neighbour, "need at least two columns of list items").toBeGreaterThan(-1);

    const items = page.locator(".list-item");
    const neighbourLeftBefore = (await items.nth(neighbour).boundingBox())!.x;

    await items.first().click();
    await page.keyboard.press("F2");
    const input = page.locator(".rename-input.rename-row");
    await input.waitFor({ state: "visible", timeout: 2000 });
    await input.fill(LONG_NAME);

    const neighbourLeftAfter = (await items.nth(neighbour).boundingBox())!.x;
    expect(Math.abs(neighbourLeftAfter - neighbourLeftBefore)).toBeLessThanOrEqual(1);
  });
});

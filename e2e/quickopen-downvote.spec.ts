/**
 * E2E test: QuickOpen frecency downvote.
 * Issue: #438 (feat/quickopen-frecency-downvote)
 *
 * A result can be downvoted to penalise its frecency — via the hover button or
 * Ctrl+Delete. It is a soft penalty (recovers on re-access), not a blacklist,
 * but the immediate effect is that the item drops from the visible list. Here
 * we seed the Recent list (deterministic, empty-query view) and assert the
 * downvoted item is removed from it.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

const RECENTS = [
  { name: "alpha.txt", path: "/home/user/alpha.txt", kind: "file", timestamp: 2 },
  { name: "beta.txt", path: "/home/user/beta.txt", kind: "file", timestamp: 1 },
];

test.describe("QuickOpen downvote", () => {
  test.beforeEach(async ({ page }) => {
    // Seed the recent-files store before the app boots (stores read localStorage
    // at module-load time).
    await page.addInitScript((recents) => {
      localStorage.setItem("explorer-recent-files", JSON.stringify(recents));
    }, RECENTS);
  });

  test("hover button and Ctrl+Delete remove a result from the recents list", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);

    await page.keyboard.press("Control+p");
    const quickOpen = page.locator(".quick-open-dialog");
    await expect(quickOpen).toBeVisible({ timeout: 2000 });

    // Empty query → Recent list shows both seeded entries.
    const rows = quickOpen.locator(".result-item");
    await expect(rows).toHaveCount(2);
    await expect(quickOpen.locator(".result-name", { hasText: "alpha.txt" })).toBeVisible();

    // The downvote affordance carries an explanatory tooltip.
    const alphaRow = rows.filter({ hasText: "alpha.txt" });
    const downvote = alphaRow.locator(".downvote-btn");
    await expect(downvote).toHaveAttribute("title", /recovers if you open it again/i);

    // Click the hover button → alpha.txt drops out of the list.
    await alphaRow.hover();
    await downvote.click();
    await expect(rows).toHaveCount(1);
    await expect(quickOpen.locator(".result-name", { hasText: "alpha.txt" })).toHaveCount(0);
    await expect(quickOpen.locator(".result-name", { hasText: "beta.txt" })).toBeVisible();

    // Ctrl+Delete downvotes the remaining highlighted result too.
    await page.keyboard.press("Control+Delete");
    await expect(rows).toHaveCount(0);
  });
});

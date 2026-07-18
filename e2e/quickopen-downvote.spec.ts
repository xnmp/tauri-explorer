/**
 * E2E test: QuickOpen frecency downvote.
 * Issue: #438 (feat/quickopen-frecency-downvote)
 *
 * A result can be downvoted to penalise its frecency — via the hover button or
 * Ctrl+Delete. It is a soft penalty (recovers on re-access), not a blacklist,
 * but the immediate effect is that the item drops from the visible list. Here
 * we seed the Recent list (deterministic, empty-query view) and assert the
 * downvoted item is removed from it.
 *
 * NB: the seeded paths MUST exist in the mock filesystem (see mock-invoke.ts).
 * QuickOpen prunes non-existent recents on open (`pruneNonExistent`), so
 * pointing at made-up paths would silently empty the list. Navigating to
 * /home/user also auto-adds that folder as a recent (explorer.svelte.ts), so we
 * assert on named rows rather than a fixed total count.
 */
import { test, expect } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

const RECENTS = [
  { name: "readme.txt", path: "/home/user/readme.txt", kind: "file", timestamp: 3 },
  { name: "notes.md", path: "/home/user/notes.md", kind: "file", timestamp: 2 },
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
    const readmeRow = quickOpen.locator(".result-item", { hasText: "readme.txt" });
    const notesRow = quickOpen.locator(".result-item", { hasText: "notes.md" });
    await expect(readmeRow).toHaveCount(1);
    await expect(notesRow).toHaveCount(1);

    // The downvote affordance carries an explanatory tooltip.
    const downvote = readmeRow.locator(".downvote-btn");
    await expect(downvote).toHaveAttribute("title", /recovers if you open it again/i);

    // Click the hover button → readme.txt drops out of the list immediately,
    // while other recents remain (soft downvote, not a bulk clear).
    await readmeRow.hover();
    await downvote.click();
    await expect(readmeRow).toHaveCount(0);
    await expect(notesRow).toHaveCount(1);

    // Ctrl+Delete downvotes the currently highlighted result too — the visible
    // list shrinks by exactly one more.
    const rows = quickOpen.locator(".result-item");
    const before = await rows.count();
    expect(before).toBeGreaterThan(0);
    await page.keyboard.press("Control+Delete");
    await expect(rows).toHaveCount(before - 1);
  });
});

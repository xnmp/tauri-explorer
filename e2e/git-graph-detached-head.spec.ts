/**
 * Persistent detached-HEAD indicator (#524).
 *
 * "(detached)" inside the checkout menu disappears with the menu, so the state
 * is easy to forget. The graph carries a standing badge for as long as HEAD is
 * detached: it appears after a detached checkout, stays up with no menu open,
 * and survives a tab remount (which repaints from the snapshot cache).
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page, expectGraph = true) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  if (expectGraph) {
    await expect(
      page.locator('[data-testid="git-graph-view"] .commit-row').first(),
    ).toContainText("Uncommitted Changes");
  }
}

test.describe("git graph detached-HEAD indicator", () => {
  test("stands until HEAD is reattached, not just while the menu is open", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    const badge = page.locator('[data-testid="git-graph-detached-badge"]');

    // AC 3: HEAD is on `main` — nothing to warn about.
    await expect(badge).toHaveCount(0);

    // "Update README with usage" carries no branch, so checking it out
    // detaches HEAD (the menu item spells that out).
    const row = view.locator(".commit-row", { hasText: "Update README with usage" });
    await expect(row).toBeVisible();
    const shortOid = await row.getAttribute("data-oid");
    expect(shortOid).toBeTruthy();
    await row.click({ button: "right" });

    const menu = page.locator('[data-testid="git-graph-menu"]');
    const checkoutItem = menu.locator(".menu-item", { hasText: "Checkout (detached)" });
    await expect(checkoutItem).toBeVisible();
    await checkoutItem.click();

    // AC 1 + AC 2: the menu is gone, and the badge is up and names the commit
    // HEAD now sits on.
    await expect(menu).toHaveCount(0);
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("DETACHED HEAD");
    await expect(badge).toContainText(shortOid!);

    // AC 2: closing and reopening the graph tab remounts the view (painting
    // from the snapshot cache) — the badge must not blink out.
    await openGraphViaPalette(page, false);
    await expect(view).toHaveCount(0);
    await openGraphViaPalette(page);
    await expect(badge).toBeVisible();
    await expect(badge).toContainText("DETACHED HEAD");

    // Reattaching to a branch clears it.
    const mainRow = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
    await mainRow.click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"] .menu-item', { hasText: "Checkout main" }).click();
    await expect(badge).toHaveCount(0);
  });
});

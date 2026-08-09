/**
 * Bulk "hide remote-only branches" toggle in the git-graph branch filter
 * (#515): remote refs no local branch tracks leave the walked set in one
 * click, composing with the per-branch/author selection.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page, expectGraph = true) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  // The synthetic "Uncommitted Changes" row arrives with the async git
  // summary and shifts every row index when it lands.
  if (expectGraph) {
    await expect(
      page.locator('[data-testid="git-graph-view"] .commit-row').first(),
    ).toContainText("Uncommitted Changes");
  }
}

test.describe("Git graph branch filter", () => {
  test("hide remote-only branches bulk-hides untracked remote refs (#515)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row")).toHaveCount(18);

    const filterBtn = page.locator('[data-testid="branch-filter-btn"]');
    await filterBtn.click();
    const popover = page.locator('[data-testid="branch-popover"]');
    // Exact-name row lookup: `main` must not also match `origin/main`.
    const branchBox = (name: string) =>
      popover
        .locator("label.bf-row")
        .filter({ has: page.getByText(name, { exact: true }) })
        .locator("input");
    const hideRemoteOnly = popover.locator('[data-testid="bf-hide-remote-only"] input');
    const search = popover.locator(".bf-search");
    const backdrop = page.locator('[aria-label="Close branch filter"]');

    // AC 1: the toggle exists, is off, and the remote-only branch is listed
    // and selected.
    await expect(hideRemoteOnly).not.toBeChecked();
    await expect(branchBox("origin/legacy-import")).toBeChecked();
    await expect(branchBox("main")).toBeChecked();
    await expect(branchBox("feature")).toBeChecked();
    // The full list is taller than the 320px popover; narrow it to the remote
    // refs this criterion is about so they and the toggle fit in one frame.
    await search.fill("origin");
    await expect(branchBox("origin/legacy-import")).toBeChecked();
    await expect(branchBox("origin/main")).toBeChecked();
    await expect(branchBox("origin/hotfix")).toBeChecked();
    await page.screenshot({ path: "evidence/ac-1-toggle-off.png" });

    // AC 2: one click hides every remote ref with no local counterpart, and
    // leaves locals + tracked remotes (origin/main, origin/hotfix) selected.
    await hideRemoteOnly.click();
    await expect(branchBox("origin/legacy-import")).not.toBeChecked();
    await expect(branchBox("origin/main")).toBeChecked();
    await expect(branchBox("origin/hotfix")).toBeChecked();
    await expect(filterBtn).toHaveClass(/filtered/);
    // Local history is untouched: main's tip is still drawn.
    await expect(view.locator(".commit-row").filter({ hasText: "Merge hotfix into main" })).toHaveCount(1);
    await page.screenshot({ path: "evidence/ac-2-toggle-on.png" });
    // …and the local branches the search box was hiding are still selected.
    await search.fill("");
    await expect(branchBox("main")).toBeChecked();
    await expect(branchBox("feature")).toBeChecked();

    // AC 3: narrow the per-branch filter to the remote-only branch alone —
    // the graph reduces to its ancestry (8 commits + the uncommitted row).
    await hideRemoteOnly.click();
    await expect(branchBox("origin/legacy-import")).toBeChecked();
    const legacyRow = popover
      .locator("label.bf-row")
      .filter({ has: page.getByText("origin/legacy-import", { exact: true }) });
    await legacyRow.hover();
    await legacyRow.locator(".bf-only").click();
    await expect(view.locator(".commit-row")).toHaveCount(9);
    await expect(view.locator(".commit-row").filter({ hasText: "Refactor config loader" })).toHaveCount(1);
    await expect(view.locator(".commit-row").filter({ hasText: "Merge hotfix into main" })).toHaveCount(0);
    // Close the popover so the shot shows the graph it is describing.
    await backdrop.click();
    await expect(view.locator(".commit-row")).toHaveCount(9);
    await page.screenshot({ path: "evidence/ac-3-remote-only-history.png" });

    // AC 4: with the toggle on, that history is gone from the graph — the
    // toggle changes what the graph walks, not just the checkbox UI.
    await filterBtn.click();
    await hideRemoteOnly.click();
    await expect(view.locator(".commit-row")).toHaveCount(0);
    await expect(view.locator(".commit-row").filter({ hasText: "Refactor config loader" })).toHaveCount(0);
    await backdrop.click();
    await expect(view.locator(".commit-row")).toHaveCount(0);
    await page.screenshot({ path: "evidence/ac-4-history-hidden.png" });

    // Reversible: turning it off restores the same rows.
    await filterBtn.click();
    await hideRemoteOnly.click();
    await expect(view.locator(".commit-row")).toHaveCount(9);

    // Composes with the per-branch filter: a hand-unchecked branch survives a
    // toggle on → off cycle, and the bulk toggle never clears the selection.
    await popover.locator(".bf-all").click(); // back to "all branches"
    await expect(view.locator(".commit-row")).toHaveCount(18);
    await branchBox("feature").click();
    await expect(branchBox("feature")).not.toBeChecked();
    await hideRemoteOnly.click();
    await expect(branchBox("feature")).not.toBeChecked();
    await expect(branchBox("origin/legacy-import")).not.toBeChecked();
    await hideRemoteOnly.click();
    await expect(branchBox("feature")).not.toBeChecked();
    await expect(branchBox("origin/legacy-import")).toBeChecked();

    // Persists per repo across closing and reopening the graph.
    await hideRemoteOnly.click();
    await expect(hideRemoteOnly).toBeChecked();
    await page.keyboard.press("Escape");
    await openGraphViaPalette(page, false);
    await expect(view).toHaveCount(0);
    await openGraphViaPalette(page);
    await filterBtn.click();
    await expect(popover.locator('[data-testid="bf-hide-remote-only"] input')).toBeChecked();
    await expect(branchBox("origin/legacy-import")).not.toBeChecked();
  });
});

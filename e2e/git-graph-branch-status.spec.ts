import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText(
    "Uncommitted Changes",
  );
}

test("branch-status badges sit beside their chips and never mute rows (#1081)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&gitBranchStatusFixture=1");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const row = (summary: string) => view.locator(".commit-row", { hasText: summary });
  const squashedRow = row("Try alternative parser");
  const staleRow = row("Hotfix: crash on empty input");
  const mergedRow = row("Add tests for feature X");
  const mergeCommitRow = row("Merge branch 'feature'");

  // Each badge follows its own branch chip.
  const squashed = squashedRow.locator(".ref-branch", { hasText: "experiment" }).locator("+ .ref-status");
  await expect(squashed).toHaveText("squashed");
  await expect(squashed).toHaveAttribute("title", "Squash-merged into origin/main");
  const merged = mergedRow.locator(".ref-branch", { hasText: "feature" }).locator("+ .ref-status");
  await expect(merged).toHaveText("merged");
  const stale = staleRow.locator(".ref-branch", { hasText: "hotfix" }).locator("+ .ref-status");
  await expect(stale).toHaveText("stale");
  await expect(staleRow.locator('[data-branch-status="merged"], [data-branch-status="squash_merged"]')).toHaveCount(0);
  // Trunk and unclassified branches get no badge.
  await expect(row("Merge hotfix into main").locator(".ref-status")).toHaveCount(0);

  // "Mute merge commits" (on by default) still dims exactly the 2+ parent rows.
  await expect(mergeCommitRow).toHaveClass(/is-merge/);
  for (const badged of [squashedRow, staleRow, mergedRow]) {
    await expect(badged).not.toHaveClass(/is-merge/);
    await expect(badged.locator(".summary")).toHaveCSS("opacity", "1");
  }
  await squashedRow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "evidence/ac-1-squash-merged-badge.png" });
  await page.screenshot({ path: "evidence/ac-2-stale-not-muted.png" });

  // Turning the toggle off un-dims merge rows and leaves badges untouched.
  await page.locator(".graph-header").click({ button: "right" });
  await page.locator('[data-testid="toggle-mute-merges"]').click();
  await page.keyboard.press("Escape");
  await expect(mergeCommitRow).not.toHaveClass(/is-merge/);
  await expect(squashed).toHaveText("squashed");
  await expect(stale).toHaveText("stale");
});

test("no badges render without a classification (#1081)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);
  await expect(page.locator('[data-testid="git-graph-view"] .ref-branch').first()).toBeVisible();
  await expect(page.locator('[data-testid="git-graph-view"] .ref-status')).toHaveCount(0);
});

/** PR conversation threads in the Git Graph's existing inline PR expansion. */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(
    page.locator('[data-testid="git-graph-view"] .commit-row').first(),
  ).toContainText("Uncommitted Changes");
}

test("PR badge renders its inline review conversation and tokenless fallback (#525)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const featureRow = view.locator(".commit-row", { hasText: "Add tests for feature X" });
  await featureRow.locator(".ref-pr").click();
  const detail = page.locator('[data-testid="git-graph-pr-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Implements feature X end to end.");
  await expect(detail).toContainText("Nice work! Left a couple of small notes on the diff.");

  const threads = detail.locator(".pr-detail-thread");
  await expect(threads).toHaveCount(2);
  const resolvedThread = threads.filter({ hasText: "Please use the shared parser here." });
  await expect(resolvedThread).toContainText("Resolved");
  await expect(resolvedThread).toContainText("src/lib/parser.ts:42");
  await expect(resolvedThread).toContainText("Please use the shared parser here.");
  const openThread = threads.filter({ hasText: "Could this retain the previous error context?" });
  await expect(openThread).toContainText("Open");
  await expect(openThread).toContainText("src/lib/parser.ts:87");
  await expect(openThread).toContainText("Could this retain the previous error context?");
  await detail.screenshot({ path: "evidence/ac-1-pr-conversation-threads.png" });

  const hotfixRow = view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" });
  await hotfixRow.locator(".ref-pr").click();
  await expect(detail).toContainText("Hotfix login redirect");
  await expect(detail).toContainText("Sign in to GitHub to view review threads.");
});

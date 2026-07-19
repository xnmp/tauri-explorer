/**
 * Inline commit panel on the git graph's uncommitted-changes node (#466).
 *
 * Outcome-focused: staging a file moves it into the Staged section and the
 * commit button surfaces the staged count; typing a message + committing makes
 * a new commit row with that message appear in the graph.
 */
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

test.describe("Git graph inline commit panel", () => {
  test("stage a file, type a message, commit → new commit row appears", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');

    // Open the uncommitted node's panel.
    await view.locator(".commit-row", { hasText: "Uncommitted Changes" }).first().click();
    const commitBox = view.locator('[data-testid="git-graph-commit-box"]');
    await expect(commitBox).toBeVisible();

    // Grouped file list: the seed has 1 staged file, so the button starts as
    // "Commit (1)" but is disabled while the message is empty.
    const commitBtn = view.locator('[data-testid="git-graph-commit-btn"]');
    await expect(commitBtn).toHaveText("Commit (1)");
    await expect(commitBtn).toBeDisabled();

    // Stage an unstaged change: it leaves the Changes section and the staged
    // count rises to 2.
    await view.getByLabel("Stage src/index.css").click();
    await expect(commitBtn).toHaveText("Commit (2)");
    const stagedGroup = view.locator('.stage-group[data-section="staged"]');
    await expect(stagedGroup.locator(".detail-file", { hasText: "src/index.css" })).toBeVisible();

    // Still disabled until a message is typed.
    await expect(commitBtn).toBeDisabled();
    const message = "feat: inline commit from the graph";
    await view.locator('[data-testid="git-graph-commit-message"]').fill(message);
    await expect(commitBtn).toBeEnabled();

    // Commit → a new commit row with the message appears in the graph history.
    await commitBtn.click();
    await expect(view.locator(".commit-row", { hasText: message })).toBeVisible();

    // The commit landed against the mock backend (recorded), and the staged
    // section is now empty (those changes are committed).
    const committed = await page.evaluate(
      () =>
        (window as unknown as { __mockGitCommits?: Array<{ message: string }> })
          .__mockGitCommits?.map((c) => c.message) ?? [],
    );
    expect(committed).toContain(message);
    await expect(view.locator('.stage-group[data-section="staged"]')).toHaveCount(0);
  });

  test("Ctrl+Enter in the message box commits", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row", { hasText: "Uncommitted Changes" }).first().click();

    const message = "chore: commit via keyboard";
    const box = view.locator('[data-testid="git-graph-commit-message"]');
    await box.fill(message);
    await box.press("Control+Enter");

    await expect(view.locator(".commit-row", { hasText: message })).toBeVisible();
  });
});

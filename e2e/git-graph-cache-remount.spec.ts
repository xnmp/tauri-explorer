/** Cached git-graph tab remount behavior (#505). */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function toggleGraph(page: import("@playwright/test").Page, expectGraph = true) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  if (expectGraph) {
    await expect(
      page.locator('[data-testid="git-graph-view"] .commit-row').first(),
    ).toContainText("Uncommitted Changes");
  }
}

test("re-showing a cached graph restores rows without another history request", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await toggleGraph(page);

  const historyRequestsBefore = await page.evaluate(
    () => (window as unknown as { __mockInvokeCounts?: Record<string, number> })
      .__mockInvokeCounts?.git_log ?? 0,
  );

  await toggleGraph(page, false);
  await expect(page.locator(".entry-item").first()).toBeVisible();
  await toggleGraph(page, false);

  const rows = page.locator('[data-testid="git-graph-view"] .commit-row');
  await expect(rows.first()).toContainText("Uncommitted Changes");
  await page.screenshot({ path: "evidence/ac-2-cached-git-graph-tab.png" });

  const historyRequestsAfter = await page.evaluate(
    () => (window as unknown as { __mockInvokeCounts?: Record<string, number> })
      .__mockInvokeCounts?.git_log ?? 0,
  );
  expect(historyRequestsAfter).toBe(historyRequestsBefore);
});

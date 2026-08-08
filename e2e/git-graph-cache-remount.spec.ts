/** Regression coverage for #505: returning to a cached graph must not start
 * another history walk. The optional capture is taken after the same restored
 * rows the assertion observes, so the evidence cannot drift from the test. */
import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

const evidencePath = process.env.CAPTURE_EVIDENCE
  ? "evidence/ac-2-cached-graph-rows.png"
  : "test-results/ac-2-cached-graph-rows.png";

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

test("returning to a cached graph restores rows without another history request (#505)", async ({ page }) => {
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

  const restoredRows = page.locator('[data-testid="git-graph-view"] .commit-row');
  await expect(restoredRows.first()).toContainText("Uncommitted Changes");
  await page.screenshot({ path: evidencePath });

  const historyRequestsAfter = await page.evaluate(
    () => (window as unknown as { __mockInvokeCounts?: Record<string, number> })
      .__mockInvokeCounts?.git_log ?? 0,
  );
  expect(historyRequestsAfter).toBe(historyRequestsBefore);
});

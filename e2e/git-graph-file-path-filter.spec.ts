import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("filters the commit graph to commits touching a file path (#529)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");

  const view = page.locator('[data-testid="git-graph-view"]');
  await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");

  const filter = view.getByTestId("git-graph-file-path-filter");
  await filter.fill("src/file-9.ts");

  const rows = view.locator(".commit-row");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Implement feature X");
  await expect(rows.filter({ hasText: "Refactor config loader" })).toHaveCount(0);
  await page.screenshot({ path: "evidence/ac-1-file-path-filter.png" });

  await filter.fill("");
  await expect(rows).toHaveCount(18);
  await expect(rows.filter({ hasText: "Refactor config loader" })).toHaveCount(1);
});

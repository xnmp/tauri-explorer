import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

test("a running graph fetch can be cancelled and leaves the graph usable", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project&mockGitFetch=pending");
  await waitForEntries(page);

  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");

  const graph = page.locator('[data-testid="git-graph-view"]');
  await expect(graph).toBeVisible();
  await expect(graph.locator(".commit-row").first()).toContainText("Uncommitted Changes");

  await page.keyboard.press("F5");
  const cancel = graph.getByRole("button", { name: "Cancel fetch" });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect(page.locator(".toast", { hasText: "Git fetch cancelled" })).toBeVisible();
  await expect(cancel).toHaveCount(0);
  await expect(graph.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  await page.screenshot({
    path: "evidence/ac-1-network-operation-cancelled.png",
    animations: "disabled",
  });

  await page.keyboard.press("F5");
  await expect(graph.getByRole("button", { name: "Cancel fetch" })).toBeVisible();
});

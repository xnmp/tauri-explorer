import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function graph(page: import("@playwright/test").Page) {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText("Uncommitted Changes");
  return page.locator('[data-testid="git-graph-view"]');
}
test("create PR from the current branch reports URL and refreshes badge", async ({ page }) => {
  const view = await graph(page);
  await view.getByRole("button", { name: "Create PR", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create pull request" });
  await dialog.getByLabel("Title", { exact: true }).fill("Create graph PR actions");
  await dialog.getByLabel("Base branch").fill("dev");
  await dialog.getByLabel("Description").fill("Created from the graph pane.");
  await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("PR created");
  await expect(view.getByRole("status")).toContainText("https://github.com/mock/project/pull/99");
  await expect(view.locator(".ref-pr", { hasText: "#99" }).first()).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-create-pr.png" });
});
for (const action of ["merge", "approve"] as const) {
  test(`${action} PR requires confirmation and refreshes graph badges`, async ({ page }) => {
    const view = await graph(page);
    await view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" }).locator(".ref-pr").click();
    const detail = view.locator('[data-testid="git-graph-pr-detail"]');
    const label = action === "merge" ? "Merge PR" : "Approve PR";
    await detail.getByRole("button", { name: label, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: action === "merge" ? "Merge pull request" : "Approve pull request" });
    await expect(dialog).toContainText("#15");
    if (action === "merge") await dialog.getByLabel("Merge method").selectOption("rebase");
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(view.getByRole("status")).toContainText(action === "merge" ? "PR #15 merged" : "PR #15 approved");
    if (action === "merge") await expect(view.locator(".ref-pr", { hasText: "#15" })).toHaveCount(0);
    else await expect(detail).toContainText("Approved");
    await page.screenshot({ path: `evidence/ac-${action === "merge" ? 2 : 3}-${action}-pr.png` });
  });
}

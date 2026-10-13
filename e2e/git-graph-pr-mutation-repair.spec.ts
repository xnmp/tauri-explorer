import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

const repo = "/home/user/Documents/project";
async function graph(page: import("@playwright/test").Page) {
  await page.goto(`/?path=${repo}`);
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  const view = page.getByTestId("git-graph-view");
  await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  return view;
}
async function approval(page: import("@playwright/test").Page) {
  const view = page.getByTestId("git-graph-view");
  await view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" }).locator(".ref-pr").click();
  await view.getByTestId("git-graph-pr-detail").getByRole("button", { name: "Approve PR", exact: true }).click();
  return page.getByRole("dialog", { name: "Approve pull request" });
}
test("pending approval remains owned after the pane remounts and reports its outcome", async ({ page }) => {
  const view = await graph(page);
  await page.clock.install();
  await page.evaluate(() => { (window as any).__mockControl.latency = { git_pr_action: 120_000 }; });
  const dialog = await approval(page);
  await dialog.getByRole("button", { name: "Approve PR", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Working…" })).toBeDisabled();
  // Exercise the production pane teardown/remount seam while native work runs.
  await page.evaluate(async () => { const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts"); windowTabsManager.toggleGitGraphInActivePane(null); });
  await expect(view).toHaveCount(0);
  await page.evaluate(async path => { const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts"); windowTabsManager.toggleGitGraphInActivePane(path); }, repo);
  await expect(view.getByRole("status")).toHaveText("GitHub PR action in progress…");
  await expect(view.getByRole("button", { name: "Create PR", exact: true })).toBeDisabled();
  await view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" }).locator(".ref-pr").click();
  await expect(view.getByRole("button", { name: "Approve PR", exact: true })).toBeDisabled();
  await page.screenshot({ animations: "disabled", path: "evidence/ac-3-approval-remount-pending.png" });
  await page.clock.runFor(120_100);
  await expect(view.getByRole("status")).toHaveText("PR #15 approved");
  await expect(view.getByTestId("git-graph-pr-detail")).toContainText("Approved");
  expect(await page.evaluate(() => (window as any).__mockControl.invokeCounts.git_pr_action)).toBe(1);
});
test("uncertain approval stays visible and cannot retry until GitHub is checked", async ({ page }) => {
  await graph(page);
  // Inject the typed IPC failure at the production outcome owner; native fixture
  // tests independently prove this code follows accepted work with a lost ack.
  await page.evaluate(async path => {
    const { getPrMutationOwner } = await import("/src/lib/state/git-pr-mutations.svelte.ts");
    await getPrMutationOwner(path).run({ action: "approve", repoSlug: "mock/project", prNumber: 15 }, async () => {
      throw { kind: "pr_mutation_uncertain", message: "GitHub may have applied this PR action; check GitHub before retrying. Connection lost after remote acceptance." };
    }, false);
  }, repo);
  const dialog = await approval(page);
  await expect(dialog.getByRole("alert")).toContainText("GitHub may have applied");
  await expect(dialog.getByRole("button", { name: "Approve PR", exact: true })).toBeDisabled();
  await page.screenshot({ animations: "disabled", path: "evidence/ac-3-approval-uncertain.png" });
  await dialog.getByLabel("I checked GitHub and want to retry this action").check();
  await dialog.getByRole("button", { name: "Approve PR", exact: true }).click();
  await expect(page.getByTestId("git-graph-view").getByRole("status")).toHaveText("PR #15 approved");
  expect(await page.evaluate(() => (window as any).__mockControl.invokeCounts.git_pr_action)).toBe(1);
});

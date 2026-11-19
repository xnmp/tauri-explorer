import { test, expect } from "./fixtures";
import { waitForEntries, seedSettings } from "./helpers";

// The commit graph is an opt-in experimental feature (#1675).
test.beforeEach(async ({ page }) => {
  await seedSettings(page, { enableGitGraph: true });
});

async function graph(page: import("@playwright/test").Page, query = "") {
  await page.goto(`/?path=/home/user/Documents/project${query}`);
  await waitForEntries(page);
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText("Uncommitted Changes");
  return page.locator('[data-testid="git-graph-view"]');
}
/** Right-click a local branch pill and choose "Create pull request…" (#1847). */
async function createPrFromPill(page: import("@playwright/test").Page, view: import("@playwright/test").Locator, branch: string, screenshot?: string) {
  await view.locator(".ref-branch", { hasText: new RegExp(`^\\s*${branch}\\b`) }).first().click({ button: "right" });
  const item = page.getByTestId("git-graph-menu").getByRole("menuitem", { name: /Create pull request…/ });
  await expect(item).toBeEnabled();
  if (screenshot) await page.screenshot({ path: screenshot });
  await item.click();
  return page.getByRole("dialog", { name: "Create pull request" });
}

test("create PR from a non-checked-out branch pill reports URL and refreshes badge", async ({ page }) => {
  const view = await graph(page);
  // The toolbar no longer offers creation, and stays absent while idle.
  await expect(view.getByRole("button", { name: "Create PR", exact: true })).toHaveCount(0);
  await expect(view.getByTestId("git-graph-pr-status")).toHaveCount(0);
  // `release` sits on the HEAD commit but HEAD is `main`.
  const dialog = await createPrFromPill(page, view, "release", "screenshots/refactor/branch-pill-create-pr/branch-pill-menu.png");
  await expect(dialog).toContainText("Repository: mock/project");
  await expect(dialog).toContainText("Branch: release");
  await dialog.getByLabel("Title", { exact: true }).fill("Create graph PR actions");
  await dialog.getByLabel("Base branch").fill("dev");
  await dialog.getByLabel("Description").fill("Created from the graph pane.");
  await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("PR created");
  await expect(view.getByRole("status")).toContainText("https://github.com/mock/project/pull/99");
  await expect(view.locator(".commit-row", { has: page.locator(".ref-branch", { hasText: "release" }) }).locator(".ref-pr", { hasText: "#99" })).toBeVisible();
  await page.screenshot({ path: "evidence/ac-1-create-pr.png" });
});

test("create PR is disabled for a branch with an open PR and absent on remote and tag pills", async ({ page }) => {
  const view = await graph(page);
  await view.locator(".ref-branch", { hasText: /^\s*feature\b/ }).first().click({ button: "right" });
  const menu = page.getByTestId("git-graph-menu");
  const item = menu.getByRole("menuitem", { name: /Create pull request…/ });
  await expect(item).toBeDisabled();
  await expect(item).toContainText("PR #7 is already open");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("git-graph-menu")).toHaveCount(0);

  await view.locator(".ref-remote", { hasText: "origin/legacy-import" }).first().click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: /Checkout legacy-import/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Create pull request…/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("git-graph-menu")).toHaveCount(0);

  await view.locator(".ref-tag", { hasText: "v1.0" }).first().click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: /Delete Tag 'v1.0'/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /Create pull request…/ })).toHaveCount(0);
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
    await expect(dialog).toContainText("Repository: mock/project");
    if (action === "merge") await dialog.getByLabel("Merge method").selectOption("rebase");
    await dialog.getByRole("button", { name: label, exact: true }).click();
    await expect(view.getByRole("status")).toContainText(action === "merge" ? "Merge requested for PR #15" : "PR #15 approved");
    if (action === "merge") await expect(view.locator(".ref-pr", { hasText: "#15" })).toHaveCount(0);
    else await expect(detail).toContainText("Approved");
    await page.screenshot({ path: `evidence/ac-${action === "merge" ? 2 : 3}-${action}-pr.png` });
  });
}

test("cancel sends no mutation and CLI errors keep the dialog retryable", async ({ page }) => {
  const view = await graph(page);
  const count = () => page.evaluate(() => (globalThis as { __mockControl?: { invokeCounts?: Record<string, number> } }).__mockControl?.invokeCounts?.git_pr_action ?? 0);
  let dialog = await createPrFromPill(page, view, "main");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await count()).toBe(0);
  await page.evaluate(() => { (globalThis as { __mockControl?: { failures?: Record<string, string> } }).__mockControl!.failures = { git_pr_action: "GitHub CLI (`gh`) is not installed" }; });
  dialog = await createPrFromPill(page, view, "main");
  await dialog.getByLabel("Title", { exact: true }).fill("Retryable PR");
  await dialog.getByLabel("Base branch").fill("dev");
  await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("GitHub CLI (`gh`) is not installed");
  await expect(dialog.getByRole("button", { name: "Create PR", exact: true })).toBeEnabled();
  await expect(view.getByRole("status")).toHaveCount(0);
  await page.evaluate(() => { (globalThis as { __mockControl?: { failures?: Record<string, string> } }).__mockControl!.failures = {}; });
  await dialog.getByRole("button", { name: "Create PR", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("PR created");
  expect(await count()).toBe(2);
});

test("a queued merge remains an open PR and never claims it merged", async ({ page }) => {
  const view = await graph(page, "&gitPrMergeQueued=1");
  await view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" }).locator(".ref-pr").click();
  await view.locator('[data-testid="git-graph-pr-detail"]').getByRole("button", { name: "Merge PR", exact: true }).click();
  await page.getByRole("dialog", { name: "Merge pull request" }).getByRole("button", { name: "Merge PR", exact: true }).click();
  await expect(view.getByRole("status")).toContainText("Merge requested for PR #15");
  await expect(view.getByRole("status")).not.toContainText("merged");
  await expect(view.locator(".ref-pr", { hasText: "#15" }).first()).toBeVisible();
});

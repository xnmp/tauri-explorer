/**
 * Git graph tab (#51/#57/#58): the palette command opens a git-graph tab for
 * the current repo, the renderer draws the mocked 12-commit history with
 * lanes/edges and refs decoration, and the tab closes back to the explorer.
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Show Commit Graph");
  await page.keyboard.press("Enter");
}

test.describe("Git graph tab", () => {
  test("opens from the palette and renders the commit graph with refs", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    await openGraphViaPalette(page);

    // The graph view replaces the explorer pane content.
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view).toBeVisible();
    await expect(view).toContainText("12 commits");

    // Commit rows render with the mocked history (newest first: the merge).
    const rows = view.locator(".commit-row");
    await expect(rows).toHaveCount(12);
    await expect(rows.first()).toContainText("Merge branch 'feature'");
    await expect(rows.last()).toContainText("Initial commit");

    // Refs decoration: HEAD + main on the tip, tag on v1.0's commit.
    await expect(rows.first().locator(".ref-head")).toHaveText("HEAD");
    await expect(rows.first().locator(".ref-branch")).toHaveText("main");
    await expect(view.locator(".ref-tag").first()).toHaveText("v1.0");

    // Graph cells draw lane dots and edges (the merge row has 2 outgoing edges).
    await expect(rows.first().locator("svg circle")).toHaveCount(1);
    const mergeEdges = await rows.first().locator("svg path").count();
    expect(mergeEdges).toBeGreaterThanOrEqual(2);

    // The tab strip shows the graph tab; closing it returns to the explorer.
    const graphTab = page.locator(".tab").filter({ hasText: "Graph: project" });
    await expect(graphTab).toBeVisible();
    await graphTab.hover();
    await graphTab.locator(".tab-close").click();
    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
    await expect(page.locator(".entry-item").first()).toBeVisible();
  });

  test("re-invoking the command reuses the existing graph tab", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    await openGraphViaPalette(page);
    await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible();
    await openGraphViaPalette(page);

    await expect(page.locator(".tab").filter({ hasText: "Graph: project" })).toHaveCount(1);
  });

  test("outside a repo the command toasts instead of opening a tab", async ({ page }) => {
    await page.goto("/?path=/home/user/Downloads");
    await waitForEntries(page);

    await openGraphViaPalette(page);

    await expect(page.locator(".toast").first()).toContainText("Not inside a git repository");
    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
  });
});

test("clicking a commit opens the detail panel with its changed files", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await view.locator(".commit-row").first().click(); // the merge commit

  const detail = page.locator('[data-testid="git-graph-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Merge branch 'feature'");
  await expect(detail).toContainText("merge of 2 parents");
  await expect(detail.locator(".detail-files li")).toHaveCount(2);
  await expect(detail).toContainText("src/feature-x.ts");

  // Clicking the same row again collapses the panel.
  await view.locator(".commit-row").first().click();
  await expect(detail).toHaveCount(0);
});

test.describe("Git graph commit context actions", () => {
  test("right-click opens the commit menu with the expected actions", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").first().click({ button: "right" });

    const menu = page.locator('[data-testid="git-graph-menu"]');
    await expect(menu).toBeVisible();
    for (const label of [
      "Create Branch",
      "Create Tag",
      "Checkout",
      "Cherry-pick",
      "Revert",
      "Merge into current branch",
      "Rebase current branch on this Commit",
      "Reset current branch to this Commit",
      "Copy Commit Hash",
      "Copy Commit Subject",
    ]) {
      await expect(menu).toContainText(label);
    }

    // Escape dismisses the menu.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("create branch adds a branch ref chip at that commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    const tip = view.locator(".commit-row").first();
    await tip.click({ button: "right" });

    await page.locator('[data-testid="git-graph-menu"]').getByText("Create Branch…").click();
    const prompt = page.locator('[data-testid="git-graph-prompt"]');
    await expect(prompt).toBeVisible();
    await prompt.locator("input").fill("hotfix/login");
    await prompt.getByText("Create branch", { exact: true }).click();

    // The new local-branch chip decorates the tip commit after the reload.
    await expect(
      view.locator(".commit-row").first().locator(".ref-branch", { hasText: "hotfix/login" }),
    ).toBeVisible();
  });

  test("checkout moves the HEAD chip to the target commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    // HEAD starts on the tip (merge) commit.
    await expect(view.locator(".commit-row").first().locator(".ref-head")).toHaveText("HEAD");

    // Checkout the `feature` branch (on commit #10).
    const featureRow = view.locator(".commit-row").filter({ hasText: "Add tests for feature X" });
    await featureRow.click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout feature").click();

    // HEAD chip now decorates the feature commit, not the old tip.
    await expect(featureRow.locator(".ref-head")).toHaveText("HEAD");
    await expect(view.locator(".commit-row").first().locator(".ref-head")).toHaveCount(0);
  });

  test("copy commit hash writes the full OID to the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").first().click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Copy Commit Hash").click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toHaveLength(40);
    // The tip commit's deterministic OID starts with "000c" (commit #12 = 0xc).
    expect(clip.startsWith("000c")).toBe(true);
  });
});

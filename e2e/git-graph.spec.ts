/**
 * Git graph tab (#51/#57/#58): the palette command opens a git-graph tab for
 * the current repo, the renderer draws the mocked 12-commit history with
 * lanes/edges and refs decoration, and the tab closes back to the explorer.
 */
import { test, expect } from "@playwright/test";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page, expectGraph = true) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Show Commit Graph");
  await page.keyboard.press("Enter");
  // The synthetic "Uncommitted Changes" row arrives with the async git
  // summary and shifts every row index when it lands (a real race on slower
  // engines) — anchor on it before any nth() addressing.
  if (expectGraph) {
    await expect(
      page.locator('[data-testid="git-graph-view"] .commit-row').first(),
    ).toContainText("Uncommitted Changes");
  }
}

test.describe("Git graph tab", () => {
  test("opens from the palette and renders the commit graph with refs", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    await openGraphViaPalette(page);

    // The graph view replaces the explorer pane content.
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view).toBeVisible();
    await expect(view).toContainText("17 commits");

    // Commit rows render with the mocked history (newest first: the merge).
    const rows = view.locator(".commit-row");
    // 17 history rows (incl. the woven stash) + the synthetic uncommitted row.
    await expect(rows).toHaveCount(18);
    await expect(rows.first()).toContainText("Uncommitted Changes");
    // The stash's base is the tip, so it weaves in directly above it.
    await expect(rows.nth(1)).toContainText("WIP on main");
    await expect(rows.nth(2)).toContainText("Merge hotfix into main");
    await expect(rows.last()).toContainText("Initial commit");

    // Refs decoration: HEAD + main on the tip, tag on v1.0's commit.
    // Combined chip: local main groups its in-sync remote as a nested
    // sub-chip; the checked-out branch chip is highlighted.
    const tipRow = rows.nth(2);
    await expect(tipRow.locator(".ref-branch.ref-active")).toContainText("main");
    await expect(tipRow.locator(".ref-branch .ref-remote-sub")).toHaveText("origin");
    await expect(view.locator(".ref-tag").first()).toHaveText("v1.0");
    // Stash renders as a woven row with its selector chip.
    await expect(view.locator(".ref-stash")).toHaveText("stash@{0}");

    // Graph cells draw lane dots and edges (the merge row has 2 outgoing edges).
    // Continuous rendering: one SVG underlay with per-branch paths (plus a
    // halo under each), not per-row segments.
    const underlay = view.locator(".graph-underlay");
    await expect(underlay).toHaveCount(1);
    const pathCount = await underlay.locator("path").count();
    expect(pathCount).toBeGreaterThanOrEqual(8);
    const circleCount = await underlay.locator("circle").count();
    expect(circleCount).toBeGreaterThanOrEqual(18);

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

    await openGraphViaPalette(page, false);

    await expect(page.locator(".toast").first()).toContainText("Not inside a git repository");
    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
  });
});

test("clicking a commit opens the detail panel with its changed files", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await view.locator(".commit-row").nth(2).click(); // the tip merge commit

  const detail = page.locator('[data-testid="git-graph-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Merge hotfix into main");
  await expect(detail).toContainText("merge of 2 parents");
  await expect(detail.locator(".detail-files li")).toHaveCount(1);
  await expect(detail).toContainText("src/file-16.ts");

  // Clicking the same row again collapses the panel.
  await view.locator(".commit-row").nth(2).click();
  await expect(detail).toHaveCount(0);
});

test("details expand inline below the clicked row (#221)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const row = view.locator(".commit-row").nth(2);
  await row.click();

  const detail = page.locator('[data-testid="git-graph-detail"]');
  await expect(detail).toBeVisible();
  // Inline: the details sit directly below the clicked row, above the next one.
  const rowBox = (await row.boundingBox())!;
  const detailBox = (await detail.boundingBox())!;
  const nextRowBox = (await view.locator(".commit-row").nth(3).boundingBox())!;
  expect(detailBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  expect(nextRowBox.y).toBeGreaterThanOrEqual(detailBox.y + detailBox.height - 1);
});

test("clicking a changed file shows its diff below the file row (#221)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await view.locator(".commit-row").nth(2).click();

  const detail = page.locator('[data-testid="git-graph-detail"]');
  await detail.locator(".detail-file").first().click();

  const diff = page.locator('[data-testid="git-graph-file-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff).toContainText("new line");
  await expect(diff.locator(".diff-line.add")).toHaveCount(1);
  await expect(diff.locator(".diff-line.remove")).toHaveCount(1);

  // Clicking the file again collapses the diff.
  await detail.locator(".detail-file").first().click();
  await expect(diff).toHaveCount(0);
});

test("uncommitted-changes row expands its working-tree files and diffs (#221)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const uncommitted = view.locator(".commit-row.uncommitted");
  await expect(uncommitted).toBeVisible();
  await uncommitted.click();

  const detail = page.locator('[data-testid="git-graph-detail"]');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("src/index.css");
  // Staged files are marked.
  await expect(detail.locator(".file-staged-badge")).toHaveCount(1);

  // A working-tree file's diff renders inline.
  await detail.locator(".detail-file", { hasText: "src/index.css" }).click();
  const diff = page.locator('[data-testid="git-graph-file-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff.locator(".diff-line.add").first()).toBeVisible();
});

test("Ctrl+Alt+G opens the commit graph (#221)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await page.keyboard.press("Control+Alt+g");
  await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible({ timeout: 3000 });
});

test.describe("Git graph commit context actions", () => {
  test("right-click opens the commit menu with the expected actions", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").nth(2).click({ button: "right" });

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
    const tip = view.locator(".commit-row").nth(2);
    await tip.click({ button: "right" });

    await page.locator('[data-testid="git-graph-menu"]').getByText("Create Branch…").click();
    const prompt = page.locator('[data-testid="git-graph-prompt"]');
    await expect(prompt).toBeVisible();
    await prompt.locator("input").fill("hotfix/login");
    await prompt.getByText("Create branch", { exact: true }).click();

    // The new local-branch chip decorates the tip commit after the reload.
    await expect(
      view.locator(".commit-row").nth(2).locator(".ref-branch", { hasText: "hotfix/login" }),
    ).toBeVisible();
  });

  test("checkout moves the HEAD chip to the target commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    // HEAD starts on the tip (merge) commit.
    await expect(view.locator(".commit-row").nth(2)).toHaveClass(/is-head/);

    // Checkout the `feature` branch (on commit #10).
    const featureRow = view.locator(".commit-row").filter({ hasText: "Add tests for feature X" });
    await featureRow.click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Checkout feature").click();

    // HEAD chip now decorates the feature commit, not the old tip.
    await expect(featureRow).toHaveClass(/is-head/);
    await expect(view.locator(".commit-row").nth(2)).not.toHaveClass(/is-head/);
  });

  test("copy commit hash writes the full OID to the clipboard", async ({ page, context, browserName }) => {
    test.skip(browserName === "webkit", "WebKit does not support Playwright clipboard permissions");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").nth(2).click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Copy Commit Hash").click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toHaveLength(40);
    // The tip commit's deterministic OID starts with "0010" (commit #16 = 0x10).
    expect(clip.startsWith("0010")).toBe(true);
  });
});

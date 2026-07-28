/**
 * Git graph tab (#51/#57/#58): the palette command opens a git-graph tab for
 * the current repo, the renderer draws the mocked 12-commit history with
 * lanes/edges and refs decoration, and the tab closes back to the explorer.
 */
import { test, expect } from "./fixtures";
import { waitForEntries } from "./helpers";

async function openGraphViaPalette(page: import("@playwright/test").Page, expectGraph = true) {
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
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
  test("opens from the palette and renders the commit graph with refs @smoke", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    await openGraphViaPalette(page);

    // The graph view replaces the explorer pane content.
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view).toBeVisible();

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
    // Only the checked-out branch highlights (#433): `release` also sits on the
    // HEAD commit but renders as an ordinary chip, so exactly one is active.
    await expect(tipRow.locator(".ref-branch.ref-active")).toHaveCount(1);
    await expect(
      tipRow.locator(".ref-branch", { hasText: "release" }),
    ).not.toHaveClass(/ref-active/);
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

    // Per-pane (#272): the graph renders inside the current pane — no
    // separate tab appears. Re-invoking the command toggles back to files.
    await expect(page.locator(".tab").filter({ hasText: "Graph:" })).toHaveCount(0);
    await openGraphViaPalette(page, false);
    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
    await expect(page.locator(".entry-item").first()).toBeVisible();
  });

  test("PR badges show CI status + review/comment glyphs and mark drafts (#448/#459)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');

    // #7 (feature): passing CI (green class), approved (✓ glyph), 3 comments.
    const featureRow = view.locator(".commit-row", { hasText: "Add tests for feature X" });
    const prBadge = featureRow.locator(".ref-pr");
    await expect(prBadge).toHaveCount(1);
    await expect(prBadge).toContainText("#7");
    await expect(prBadge).toHaveClass(/ci-success/);
    await expect(prBadge).not.toHaveClass(/draft/);
    await expect(prBadge.locator(".pr-review")).toHaveText("✓");
    await expect(prBadge.locator(".pr-comments")).toContainText("3");

    // #12 (experiment): a DRAFT — grey styling wins over its failing CI, so
    // no ci-failure class; changes-requested shows the ± glyph, 0 comments
    // means no comment glyph.
    const experimentRow = view.locator(".commit-row", { hasText: "Try alternative parser" });
    const draftBadge = experimentRow.locator(".ref-pr");
    await expect(draftBadge).toHaveCount(1);
    await expect(draftBadge).toContainText("#12");
    await expect(draftBadge).toHaveClass(/draft/);
    await expect(draftBadge).not.toHaveClass(/ci-failure/);
    await expect(draftBadge.locator(".pr-review")).toHaveText("±");
    await expect(draftBadge.locator(".pr-comments")).toHaveCount(0);

    // #15 (hotfix): pending CI (amber class), no review / no comments (the
    // tokenless-style null fields) — badge still renders, no glyphs.
    const hotfixRow = view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" });
    const pendingBadge = hotfixRow.locator(".ref-pr");
    await expect(pendingBadge).toHaveClass(/ci-pending/);
    await expect(pendingBadge.locator(".pr-review")).toHaveCount(0);
    await expect(pendingBadge.locator(".pr-comments")).toHaveCount(0);

    // A branch with no open PR gets no badge at all (no error, no empty chip).
    const tipRow = view.locator(".commit-row", { hasText: "Merge hotfix into main" });
    await expect(tipRow.locator(".ref-pr")).toHaveCount(0);
  });

  test("PR badge click opens the in-app details dropdown, not the browser (#459)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');

    const featureRow = view.locator(".commit-row", { hasText: "Add tests for feature X" });
    const prBadge = featureRow.locator(".ref-pr");

    // Clicking the badge opens the in-app dropdown (NOT the browser) and does
    // not select the commit row (the click must not bubble into the row).
    await prBadge.click();
    const detail = page.locator('[data-testid="git-graph-pr-detail"]');
    await expect(detail).toBeVisible();
    // Outcome: the dropdown shows the PR's title and its status content.
    await expect(detail).toContainText("Add feature X");
    await expect(detail).toContainText("#7");
    await expect(detail).toContainText("Checks passing");
    await expect(detail).toContainText("Approved");
    await expect(detail).toContainText("feature"); // head branch
    // No browser navigation happened on the plain badge click.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
      .toBeNull();
    await expect(featureRow).not.toHaveClass(/selected/);
    await expect(page.locator('[data-testid="git-graph-detail"]')).toHaveCount(0);

    // "Open on GitHub" records the PR URL via the mocked open_external_url and
    // stays in-app.
    await detail.locator(".pr-detail-open").click();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
      .toBe("https://github.com/mock/project/pull/7");
    await expect(page).toHaveURL(/\/\?path=/);
    await expect(view).toBeVisible();

    // Clicking the badge again toggles the dropdown closed.
    await prBadge.click();
    await expect(detail).toHaveCount(0);

    // Reopening then pressing Escape also closes it.
    await prBadge.click();
    await expect(detail).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(detail).toHaveCount(0);

    // Opening commit details closes the PR dropdown (one expansion at a time).
    await prBadge.click();
    await expect(detail).toBeVisible();
    await featureRow.click();
    await expect(detail).toHaveCount(0);
    await expect(page.locator('[data-testid="git-graph-detail"]')).toBeVisible();
  });

  test("opens a failed CI check log inline from its PR badge (#521)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    // The experiment PR has a failed check. Its badge is the entry point; the
    // log must remain in the graph instead of opening GitHub in a browser.
    const failedPrRow = page.locator(".commit-row", { hasText: "Try alternative parser" });
    await failedPrRow.locator(".ref-pr").click();
    const detail = page.locator('[data-testid="git-graph-pr-detail"]');
    await expect(detail).toBeVisible();

    await detail.getByRole("button", { name: "Unit tests" }).click();
    const log = page.locator('[data-testid="git-graph-ci-check-log"]');
    await expect(log).toBeVisible();
    await expect(log).toContainText("Unit tests");
    await expect(log).toContainText("AssertionError: expected true to be false");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("mock-opened-url")))
      .toBeNull();

    await log.getByRole("button", { name: "Close CI check log" }).click();
    await expect(log).toHaveCount(0);
    await expect(detail).toBeVisible();
  });

  test("branch filter shows only the selected branch's history (#342)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row")).toHaveCount(18);

    // Open the popover; the text box filters the branch list itself.
    await page.locator('[data-testid="branch-filter-btn"]').click();
    const popover = page.locator('[data-testid="branch-popover"]');
    await expect(popover).toBeVisible();
    await popover.locator(".bf-search").fill("feat");
    // Branch rows only — the persistent "Local branches only" toggle (#381),
    // the select-all row (#413) and the author rows (#412) are also
    // label.bf-row but are not part of the filtered branch list.
    await expect(
      popover.locator("label.bf-row:not(.bf-local-only):not(.bf-all):not(.bf-author-row)"),
    ).toHaveCount(1);

    // "only feature": the graph reduces to feature's ancestry — 10 commits
    // plus the synthetic uncommitted row; the stash (based on main's tip)
    // and everything merge-only drops out.
    const row = popover.locator("label.bf-row", { hasText: "feature" });
    await row.hover();
    await row.locator(".bf-only").click();
    await expect(view.locator(".commit-row")).toHaveCount(11);
    await expect(view.locator(".commit-row").filter({ hasText: "Merge hotfix into main" })).toHaveCount(0);
    await expect(view.locator(".commit-row").filter({ hasText: "Implement feature X" })).toHaveCount(1);
    await expect(page.locator('[data-testid="branch-filter-btn"] .bf-count')).toHaveText("1");

    // The filter persists across closing and reopening the graph.
    await page.keyboard.press("Escape");
    await openGraphViaPalette(page, false);
    await expect(view).toHaveCount(0);
    await openGraphViaPalette(page);
    await expect(view.locator(".commit-row")).toHaveCount(11);

    // "All branches" restores the full graph.
    await page.locator('[data-testid="branch-filter-btn"]').click();
    await popover.locator(".bf-all").click();
    await expect(view.locator(".commit-row")).toHaveCount(18);
  });

  test("F5 refreshes the graph with visible feedback (#370, #417)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    await page.keyboard.press("F5");
    // Immediate feedback, then the post-fetch confirmation.
    await expect(page.locator(".toast", { hasText: "Refreshing graph" })).toBeVisible();
    await expect(page.locator(".toast", { hasText: "Fetched from remotes" })).toBeVisible();
    // The graph is still painted after the reload.
    await expect(page.locator('[data-testid="git-graph-view"] .commit-row')).toHaveCount(18);
  });

  test("remote-only branch chip offers a tracking checkout (#432)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');

    // origin/legacy-import is a remote-only branch (no local tracks it) — it
    // renders as a .ref-remote chip. Right-clicking it opens the row menu
    // scoped to a tracking checkout.
    const remoteChip = view.locator(".ref-remote", { hasText: "origin/legacy-import" });
    await expect(remoteChip).toBeVisible();
    await remoteChip.click({ button: "right" });

    const trackingItem = page.locator('[data-testid="git-graph-checkout-tracking"]');
    await expect(trackingItem).toBeVisible();
    await expect(trackingItem).toHaveText("Checkout legacy-import (tracking origin/legacy-import)");

    // Invoking it creates the local branch tracking the remote (mock resolves
    // it and moves HEAD) — a success toast confirms.
    await trackingItem.click();
    await expect(
      page.locator(".toast", { hasText: "Checked out legacy-import (tracking origin/legacy-import)" }),
    ).toBeVisible();
  });

  test("F5 with the sync setting reports diverged branches (#432)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    // Enable "F5 Syncs Local Branches" via the palette toggle.
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("F5 Syncs Local Branches");
    await page.keyboard.press("Enter");

    await openGraphViaPalette(page);
    await page.keyboard.press("F5");
    // The mock reports `experiment` diverged and `hotfix` fast-forwarded.
    await expect(
      page.locator(".toast", { hasText: "Diverged (not synced): experiment" }),
    ).toBeVisible();
  });

  test("select-all checkbox and author checkboxes drive the branch filter (#411–#413)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row")).toHaveCount(18);

    await page.locator('[data-testid="branch-filter-btn"]').click();
    const popover = page.locator('[data-testid="branch-popover"]');
    const selectAll = popover.locator('[data-testid="bf-select-all"]');
    await expect(selectAll).toBeChecked();

    // Deselect all: every branch checkbox clears and the graph empties down
    // to the synthetic uncommitted row.
    await selectAll.click();
    await expect(selectAll).not.toBeChecked();
    const branchBoxes = popover.locator(
      "label.bf-row:not(.bf-local-only):not(.bf-all):not(.bf-author-row) input",
    );
    for (const box of await branchBoxes.all()) {
      await expect(box).not.toBeChecked();
    }
    await expect(view.locator(".commit-row")).toHaveCount(0);

    // Author checkboxes are themed rows, not a native select (#411): ticking
    // Bob Dev selects exactly the branches he created (#412).
    const bob = popover.locator("label.bf-author-row", { hasText: "Bob Dev" });
    await expect(bob.locator("input")).not.toBeChecked();
    await bob.locator("input").click();
    await expect(bob.locator("input")).toBeChecked();
    const experiment = popover.locator("label.bf-row:not(.bf-author-row)", { hasText: "experiment" });
    await expect(experiment.locator("input")).toBeChecked();
    const main = popover.locator("label.bf-row:not(.bf-author-row):not(.bf-local-only):not(.bf-all)", { hasText: "main" }).first();
    await expect(main.locator("input")).not.toBeChecked();
    // The graph now shows experiment's + origin/legacy-import's ancestry.
    expect(await view.locator(".commit-row").count()).toBeGreaterThan(0);

    // Unticking Bob deselects his branches again.
    await bob.locator("input").click();
    await expect(experiment.locator("input")).not.toBeChecked();
    await expect(view.locator(".commit-row")).toHaveCount(0);

    // Re-select all restores everything.
    await selectAll.click();
    await expect(view.locator(".commit-row")).toHaveCount(18);
  });

  test("graph columns resize by dragging header handles and persist (#341)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const authorCell = page.locator(".gh-author");
    expect(Math.round((await authorCell.boundingBox())!.width)).toBe(120);

    // Drag the author handle 40px LEFT — the handle sits on the column's
    // left edge, so the column grows to 160px, and rows follow.
    const handle = (await page.locator('[data-testid="handle-author"]').boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 40, handle.y + handle.height / 2, { steps: 4 });
    await page.mouse.up();
    expect(Math.round((await authorCell.boundingBox())!.width)).toBe(160);
    const rowAuthor = page.locator(".commit-row .author").first();
    expect(Math.round((await rowAuthor.boundingBox())!.width)).toBe(160);

    // Narrow the graph gutter: rows shift left by the same amount.
    const summaryBefore = (await page.locator(".commit-row .summary").nth(1).boundingBox())!;
    const gh = (await page.locator('[data-testid="handle-graph"]').boundingBox())!;
    await page.mouse.move(gh.x + gh.width / 2, gh.y + gh.height / 2);
    await page.mouse.down();
    await page.mouse.move(gh.x + gh.width / 2 - 20, gh.y + gh.height / 2, { steps: 4 });
    await page.mouse.up();
    const summaryAfter = (await page.locator(".commit-row .summary").nth(1).boundingBox())!;
    expect(summaryBefore.x - summaryAfter.x).toBeGreaterThan(10);

    // Widths persist across a reload.
    await page.reload();
    await waitForEntries(page);
    await openGraphViaPalette(page);
    expect(Math.round((await authorCell.boundingBox())!.width)).toBe(160);
  });

  test("SCM panel stays visible alongside the graph (#333)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await page.evaluate(() => {
      const raw = localStorage.getItem("explorer-settings");
      const s = raw ? JSON.parse(raw) : {};
      s.showGitStatus = true;
      s.showScmPanel = true;
      localStorage.setItem("explorer-settings", JSON.stringify(s));
    });
    await page.reload();
    await waitForEntries(page);
    await expect(page.locator(".scm-panel")).toBeVisible();

    await openGraphViaPalette(page);

    // Both surfaces at once: the graph renders commit rows while the SCM
    // panel keeps its real working-tree content (not just an empty shell).
    await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible();
    await expect(page.locator(".scm-panel")).toBeVisible();
    await expect(page.locator('.scm-panel [data-section="changes"] .count-badge')).toHaveText("2");

    // Toggling the graph off returns to the file list with the panel intact.
    await openGraphViaPalette(page, false);
    await expect(page.locator(".entry-item").first()).toBeVisible();
    await expect(page.locator(".scm-panel")).toBeVisible();
  });

  test("re-invoking the command toggles the graph off in the pane (#272)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    await openGraphViaPalette(page);
    await expect(page.locator('[data-testid="git-graph-view"]')).toBeVisible();
    await openGraphViaPalette(page, false);

    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
    await expect(page.locator(".entry-item").first()).toBeVisible();
  });

  test("graph is per-pane: one pane shows the graph, the split shows files (#272)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);

    // Split, then toggle the graph in the (focused) new pane.
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Split Pane Right");
    await page.keyboard.press("Enter");
    await expect(page.locator(".explorer-pane")).toHaveCount(2);

    await openGraphViaPalette(page);

    // The graph lives inside ONE pane; the other pane still lists files.
    await expect(page.locator(".explorer-pane [data-testid='git-graph-view']")).toHaveCount(1);
    await expect(page.locator(".explorer-pane .entry-item").first()).toBeVisible();
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
  // Hash/parents/author/date are hidden by default (#402).
  await expect(detail).not.toContainText("merge of 2 parents");
  await expect(detail.locator(".detail-files li")).toHaveCount(1);
  await expect(detail).toContainText("src/file-16.ts");

  // Toggling "Details metadata" in the header context menu reveals them.
  await page.locator(".graph-header").click({ button: "right" });
  await page.locator('[data-testid="toggle-detail-meta"]').click();
  await page.keyboard.press("Escape");
  await expect(detail).toContainText("merge of 2 parents");
  await expect(detail).toContainText("Alice Coder");

  // Clicking the same row again collapses the panel.
  await view.locator(".commit-row").nth(2).click();
  await expect(detail).toHaveCount(0);
});

test("mutes merge commits and shows compact relative dates (#458)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  // nth(2) is the tip merge ("Merge hotfix into main", 2 parents); nth(4) is a
  // normal commit ("Try alternative parser", 1 parent). Both are dated today.
  const mergeRow = view.locator(".commit-row").nth(2);
  const normalRow = view.locator(".commit-row").nth(4);
  await expect(mergeRow).toContainText("Merge hotfix into main");
  await expect(normalRow).toContainText("Try alternative parser");

  // Muting is on by default: the merge row is dimmed, the normal row isn't.
  await expect(mergeRow).toHaveClass(/is-merge/);
  await expect(normalRow).not.toHaveClass(/is-merge/);

  // Compact relative date for a today-dated commit: "now" / "5m" / "2h".
  // The tip (seconds old) is reliably today regardless of run time-of-day.
  await expect(mergeRow.locator(".date")).toHaveText(/^\d+[mh]$|^now$/);

  // Turning "Mute merge commits" off removes the dimming from merge rows.
  await page.locator(".graph-header").click({ button: "right" });
  await page.locator('[data-testid="toggle-mute-merges"]').click();
  await page.keyboard.press("Escape");
  await expect(mergeRow).not.toHaveClass(/is-merge/);
  await expect(normalRow).not.toHaveClass(/is-merge/);
});

test("traces a hovered or selected branch lineage and can restore the undimmed graph", async ({
  page,
}) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  const feature = view.locator(".commit-row", { hasText: "Add tests for feature X" });
  const featureParent = view.locator(".commit-row", { hasText: "Implement feature X" });
  const sharedAncestor = view.locator(".commit-row", { hasText: "Refactor config loader" });
  const unrelated = view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" });

  await feature.hover();
  await expect(feature).toHaveAttribute("data-trace", "lit");
  await expect(featureParent).toHaveAttribute("data-trace", "lit");
  await expect(sharedAncestor).toHaveAttribute("data-trace", "lit");
  await expect(unrelated).toHaveAttribute("data-trace", "dim");
  await expect(view.locator('.graph-underlay path[data-trace="lit"]').first()).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(view.locator('.graph-underlay path[data-trace="dim"]').first()).toHaveCSS(
    "opacity",
    "0.16",
  );
  await page.screenshot({ path: "evidence/ac-1-hover-lineage.png" });

  await feature.click();
  await view.locator(".graph-header").hover();
  await expect(feature).toHaveAttribute("data-trace", "lit");
  await expect(unrelated).toHaveAttribute("data-trace", "dim");
  await page.screenshot({ path: "evidence/ac-2-selected-lineage.png" });

  const experiment = view.locator(".commit-row", { hasText: "Try alternative parser" });
  await experiment.click();
  await view.locator(".graph-header").hover();
  await expect(experiment).toHaveAttribute("data-trace", "lit");
  await expect(feature).toHaveAttribute("data-trace", "dim");

  await page.locator(".graph-header").click({ button: "right" });
  const toggle = page.locator('[data-testid="toggle-branch-tracing"]');
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await page.keyboard.press("Escape");
  await expect(view.locator("[data-trace]")).toHaveCount(0);
  await page.locator(".graph-header").click({ button: "right" });
  await expect(page.locator('[data-testid="toggle-branch-tracing"]')).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.screenshot({ path: "evidence/ac-3-trace-disabled.png" });
  await page.keyboard.press("Escape");
  await feature.hover();
  await expect(view.locator("[data-trace]")).toHaveCount(0);
});

test("traces hover in a two-lane branchy graph", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await page.locator('[data-testid="branch-filter-btn"]').click();
  const popover = page.locator('[data-testid="branch-popover"]');
  await popover.locator('[data-testid="bf-select-all"]').click();
  for (const name of ["feature", "hotfix"]) {
    await popover
      .locator("label.bf-row:not(.bf-author-row):not(.bf-all):not(.bf-local-only)")
      .filter({ has: page.getByText(name, { exact: true }) })
      .locator("input")
      .click();
  }
  await page.keyboard.press("Escape");
  await expect(view).toHaveAttribute("data-lane-count", "2");
  const feature = view.locator(".commit-row", { hasText: "Add tests for feature X" });
  const ancestor = view.locator(".commit-row", { hasText: "Implement feature X" });
  const unrelated = view.locator(".commit-row", { hasText: "Hotfix: crash on empty input" });

  await feature.hover();
  await expect(feature).toHaveAttribute("data-trace", "lit");
  await expect(ancestor).toHaveAttribute("data-trace", "lit");
  await expect(unrelated).toHaveAttribute("data-trace", "dim");
});

test("parent is a viewable column, off by default (#402)", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/project");
  await waitForEntries(page);
  await openGraphViaPalette(page);

  const view = page.locator('[data-testid="git-graph-view"]');
  await expect(view.locator(".gh-parent")).toHaveCount(0);

  await page.locator(".graph-header").click({ button: "right" });
  const colMenu = page.locator('[data-testid="git-graph-column-menu"]');
  await colMenu.getByText("Parent", { exact: true }).click();
  await page.keyboard.press("Escape");

  await expect(view.locator(".gh-parent")).toHaveText("Parent");
  // The tip merge commit lists two parent OIDs.
  const tipParents = view.locator(".commit-row").nth(2).locator(".parent-col");
  await expect(tipParents).toContainText("000f000");
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
  // Files are grouped by stage status (#466): the seed's one staged file sits
  // under a "Staged Changes" section; unstaged edits under "Changes".
  await expect(detail.locator('.stage-group[data-section="staged"]')).toHaveCount(1);
  await expect(
    detail.locator('.stage-group[data-section="staged"] .detail-file', { hasText: "src/App.tsx" }),
  ).toBeVisible();

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

test.describe("Git graph snapshot cache (#255)", () => {
  test("re-showing the graph in a pane paints instantly from cache (#272)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    // Watch for any appearance of the loading placeholder from now on.
    await page.evaluate(() => {
      (window as unknown as { __loadingFlashes: number }).__loadingFlashes = 0;
      new MutationObserver(() => {
        if (document.querySelector(".graph-status")) {
          (window as unknown as { __loadingFlashes: number }).__loadingFlashes++;
        }
      }).observe(document.body, { subtree: true, childList: true });
    });

    // Toggle the pane back to the file listing, then to the graph again.
    await openGraphViaPalette(page, false);
    await expect(page.locator(".entry-item").first()).toBeVisible();
    await openGraphViaPalette(page, false);

    // The graph must be there immediately — rows painted from the snapshot,
    // never the "Loading history…" placeholder.
    const view = page.locator('[data-testid="git-graph-view"]');
    await expect(view.locator(".commit-row").first()).toContainText("Uncommitted Changes");
    const flashes = await page.evaluate(
      () => (window as unknown as { __loadingFlashes: number }).__loadingFlashes,
    );
    expect(flashes).toBe(0);
  });
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

  test("right-clicking another commit while a menu is open opens its menu in one click (#263)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").nth(8).click({ button: "right" });
    const menu = page.locator('[data-testid="git-graph-menu"]');
    await expect(menu).toBeVisible();
    const firstBox = (await menu.boundingBox())!;

    // Second right-click on a row ABOVE the open menu lands on the backdrop
    // (force: the backdrop intercepting the pointer is the point) — it must
    // open that row's menu in one click, not merely cancel the first.
    await view.locator(".commit-row").nth(2).click({ button: "right", force: true });
    await expect(menu).toBeVisible();
    const secondBox = (await menu.boundingBox())!;
    expect(secondBox.y).not.toBe(firstBox.y);
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
    await page.screenshot({ path: "evidence/ac-1-checked-out-branch-lane.png" });
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

  test("copy commit subject writes the commit summary to the clipboard", async ({ page, context, browserName }) => {
    test.skip(browserName === "webkit", "WebKit does not support Playwright clipboard permissions");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view.locator(".commit-row").nth(2).click({ button: "right" }); // the tip merge commit
    await page.locator('[data-testid="git-graph-menu"]').getByText("Copy Commit Subject").click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toBe("Merge hotfix into main");
  });

  test("hard reset moves the current branch and HEAD chips to the target commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    // HEAD + main start on the tip (merge) commit at row 2.
    const tip = view.locator(".commit-row").nth(2);
    await expect(tip).toHaveClass(/is-head/);
    await expect(tip.locator(".ref-branch", { hasText: "main" })).toBeVisible();

    // Hard-reset onto an older commit.
    const target = view.locator(".commit-row").filter({ hasText: "Add core module" });
    await target.click({ button: "right" });
    const menu = page.locator('[data-testid="git-graph-menu"]');
    // Reset suboptions open in a modal (#406); pick Hard there.
    await menu.getByText("Reset current branch to this Commit…").click();
    const modal = page.locator('[data-testid="git-graph-action-modal"]');
    await expect(modal).toBeVisible();
    await modal.getByText("Hard", { exact: true }).click();

    // The mock moves main + HEAD to the target: its chips now decorate it, and
    // the old tip is no longer HEAD.
    const movedTarget = view.locator(".commit-row").filter({ hasText: "Add core module" });
    await expect(movedTarget).toHaveClass(/is-head/);
    await expect(movedTarget.locator(".ref-branch", { hasText: "main" })).toBeVisible();
    await expect(view.locator(".commit-row").nth(2)).not.toHaveClass(/is-head/);
  });

  test("soft reset also moves HEAD to the target commit", async ({ page }) => {
    // The mock does not differentiate reset modes, so this is the lighter
    // assertion: soft reset still relocates the HEAD marker.
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    const target = view.locator(".commit-row").filter({ hasText: "Project scaffolding" });
    await target.click({ button: "right" });
    const menu = page.locator('[data-testid="git-graph-menu"]');
    await menu.getByText("Reset current branch to this Commit…").click();
    const modal = page.locator('[data-testid="git-graph-action-modal"]');
    await expect(modal).toBeVisible();
    await modal.getByText("Soft", { exact: true }).click();

    await expect(
      view.locator(".commit-row").filter({ hasText: "Project scaffolding" }),
    ).toHaveClass(/is-head/);
    await expect(view.locator(".commit-row").nth(2)).not.toHaveClass(/is-head/);
  });

  test("branch badge right-click scopes Delete Branch to that badge; options open in a modal (#405, #406)", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);
    const view = page.locator('[data-testid="git-graph-view"]');
    const menu = page.locator('[data-testid="git-graph-menu"]');

    // Row right-click on the commit where both hotfix and experiment sit —
    // find a row with a non-active local branch chip.
    const hotfixChip = view.locator(".ref-branch", { hasText: "hotfix" }).first();
    const hotfixRow = view
      .locator(".commit-row")
      .filter({ has: page.locator(".ref-branch", { hasText: "hotfix" }) })
      .first();
    await hotfixRow.click({ button: "right" });
    await expect(menu).toBeVisible();
    const rowDeleteItems = await menu.locator(".menu-item", { hasText: "Delete Branch" }).allInnerTexts();
    await page.keyboard.press("Escape");

    // Badge right-click: only the clicked branch's delete entry shows.
    await hotfixChip.click({ button: "right" });
    await expect(menu).toBeVisible();
    const badgeDeleteItems = await menu.locator(".menu-item", { hasText: "Delete Branch" }).allInnerTexts();
    expect(badgeDeleteItems).toHaveLength(1);
    expect(badgeDeleteItems[0]).toContain("hotfix");
    expect(badgeDeleteItems.length).toBeLessThanOrEqual(rowDeleteItems.length);

    // The delete entry opens a modal with the variants (#406), not a submenu.
    await menu.getByText("Delete Branch 'hotfix'…").click();
    const modal = page.locator('[data-testid="git-graph-action-modal"]');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Delete branch 'hotfix'");
    await expect(modal).toContainText("Force delete");
    // Confirm the safe delete: the modal closes and the action reports done
    // (the mock's git_delete_branch is a no-op, so the chip itself persists).
    await modal.getByText("Delete", { exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator(".toast", { hasText: "Delete branch 'hotfix' done" })).toBeVisible();
  });

  test("cherry-pick appends a new top commit with the picked summary", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view
      .locator(".commit-row")
      .filter({ hasText: "Bump version to 1.0" })
      .click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Cherry-pick").click();

    // The mock appends a commit onto HEAD carrying the picked commit's summary;
    // it lands as the newest real commit, directly below the uncommitted row.
    await expect(view.locator(".commit-row").nth(1)).toContainText("Bump version to 1.0");
  });

  test("revert appends a new top commit titled Revert \"…\"", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view
      .locator(".commit-row")
      .filter({ hasText: "Add structured logging" })
      .click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Revert").click();

    await expect(view.locator(".commit-row").nth(1)).toContainText(
      'Revert "Add structured logging"',
    );
  });

  test("merge into current branch appends the merge commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    // The feature branch commit — merge resolves the target to its branch name.
    await view
      .locator(".commit-row")
      .filter({ hasText: "Add tests for feature X" })
      .click({ button: "right" });
    await page.locator('[data-testid="git-graph-menu"]').getByText("Merge into current branch").click();

    await expect(view.locator(".commit-row").nth(1)).toContainText(
      "Merge feature into current branch",
    );
  });

  test("rebase current branch on a commit appends the rebased commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    await view
      .locator(".commit-row")
      .filter({ hasText: "Add core module" })
      .click({ button: "right" });
    await page
      .locator('[data-testid="git-graph-menu"]')
      .getByText("Rebase current branch on this Commit")
      .click();

    // The mock records the rebase as a synthetic top commit.
    await expect(view.locator(".commit-row").nth(1)).toContainText("Rebased onto");
  });

  test("create tag adds a tag ref chip at that commit", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    const tip = view.locator(".commit-row").nth(2);
    await tip.click({ button: "right" });

    await page.locator('[data-testid="git-graph-menu"]').getByText("Create Tag…").click();
    const prompt = page.locator('[data-testid="git-graph-prompt"]');
    await expect(prompt).toBeVisible();
    await prompt.locator("input").fill("v2.0");
    await prompt.getByText("Create tag", { exact: true }).click();

    // The new tag chip decorates the tip commit after the reload.
    await expect(
      view.locator(".commit-row").nth(2).locator(".ref-tag", { hasText: "v2.0" }),
    ).toBeVisible();
  });

  test("a commit with no local branch offers a detached checkout that moves HEAD", async ({ page }) => {
    await page.goto("/?path=/home/user/Documents/project");
    await waitForEntries(page);
    await openGraphViaPalette(page);

    const view = page.locator('[data-testid="git-graph-view"]');
    // "Add core module" carries no local-branch ref, so checkout is detached.
    const bare = view.locator(".commit-row").filter({ hasText: "Add core module" });
    await bare.click({ button: "right" });
    const menu = page.locator('[data-testid="git-graph-menu"]');
    await expect(menu.getByText("Checkout (detached)")).toBeVisible();

    await menu.getByText("Checkout (detached)").click();

    // HEAD detaches onto that commit; the marker moves off the old tip.
    await expect(
      view.locator(".commit-row").filter({ hasText: "Add core module" }),
    ).toHaveClass(/is-head/);
    await expect(view.locator(".commit-row").nth(2)).not.toHaveClass(/is-head/);
    await page.screenshot({ path: "evidence/ac-2-detached-head-lane.png" });
  });
});

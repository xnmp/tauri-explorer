/** Regression coverage for #505: returning to a cached graph must not start
 * another history walk. The optional capture is taken after the same restored
 * rows the assertion observes, so the evidence cannot drift from the test. */
import { expect, test } from "./fixtures";
import { waitForEntries } from "./helpers";

const evidencePath = process.env.CAPTURE_EVIDENCE
  ? "evidence/ac-2-cached-graph-rows.png"
  : "test-results/ac-2-cached-graph-rows.png";

test("restored panes react to graph opening and closing, including unusual pane IDs", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("explorer-tabs", JSON.stringify({
      version: 3,
      activeTabId: "restored",
      tabs: [{
        id: "restored", kind: "explorer", activePaneId: "__proto__",
        layout: { type: "leaf", id: "__proto__", path: "/home/user/Documents/project" },
      }],
    }));
  });
  await page.goto("/");
  await waitForEntries(page);
  await page.keyboard.press("Control+Alt+g");
  await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText("Uncommitted Changes");
  await page.keyboard.press("Control+Alt+g");
  await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
  await expect(page.locator('.entry-item[data-path="/home/user/Documents/project/package.json"]')).toBeVisible();
});

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

async function scrollToOldestSyntheticCommit(page: import("@playwright/test").Page) {
  const view = page.locator('[data-testid="git-graph-view"]');
  const oldest = view.locator(".commit-row", { hasText: "(#1)" });
  for (let pageIndex = 0; pageIndex < 5 && !(await oldest.isVisible().catch(() => false)); pageIndex++) {
    await view.locator(".graph-scroller").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect(view.getByTestId("git-graph-loading-more")).toBeHidden({ timeout: 10_000 });
  }
  await expect(oldest).toBeVisible({ timeout: 10_000 });
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
  await page.evaluate(() => {
    const probe = { placeholders: 0, observer: null as MutationObserver | null };
    probe.observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && (node.matches(".graph-load-status") || node.querySelector(".graph-load-status"))) {
          probe.placeholders++;
        }
      }
    });
    probe.observer.observe(document.body, { childList: true, subtree: true });
    (window as unknown as { graphRemountProbe: typeof probe }).graphRemountProbe = probe;
  });
  await toggleGraph(page, false);

  const restoredRows = page.locator('[data-testid="git-graph-view"] .commit-row');
  await expect(restoredRows.first()).toContainText("Uncommitted Changes");
  await page.screenshot({ path: evidencePath });

  const historyRequestsAfter = await page.evaluate(
    () => (window as unknown as { __mockInvokeCounts?: Record<string, number> })
      .__mockInvokeCounts?.git_log ?? 0,
  );
  expect(historyRequestsAfter).toBe(historyRequestsBefore);
  const placeholders = await page.evaluate(() => {
    const probe = (window as unknown as { graphRemountProbe: { placeholders: number; observer: MutationObserver } }).graphRemountProbe;
    probe.observer.disconnect();
    return probe.placeholders;
  });
  expect(placeholders, "a cached graph must not briefly return to its loading placeholder").toBe(0);
});

test("a cached and refreshed large graph can paginate to its oldest commit", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents/load-repo-0&mockGitCommits=750");
  await waitForEntries(page);
  await toggleGraph(page, false);
  await expect(page.locator(".commit-row", { hasText: "Release build 750 [load-repo-0]" })).toBeVisible();

  // Remount from the bounded page-0 cache, then prove its cursor still reaches
  // the final backend page rather than stopping at the cached prefix.
  await toggleGraph(page, false);
  await toggleGraph(page, false);
  await expect(page.locator(".commit-row", { hasText: "Release build 750 [load-repo-0]" })).toBeVisible();
  await scrollToOldestSyntheticCommit(page);

  // A full query refresh replaces page 0. Pagination must remain wired to the
  // replacement session and still reach the same observable history tail.
  await page.keyboard.press("F5");
  await expect(page.locator(".toast", { hasText: "Fetched from remotes" })).toBeVisible();
  await scrollToOldestSyntheticCommit(page);
  await page.screenshot({
    path: "screenshots/refactor/repo-health-cleanup/graph-pagination-oldest-commit.png",
  });
});

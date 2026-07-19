/**
 * A single very large graph (5000 commits). Verifies:
 *  - initial render completes within a generous budget,
 *  - the list is virtualized — the DOM row count stays bounded while more
 *    history is paged in and scroll position advances,
 *  - selecting a deep commit still responds quickly (< 1s).
 */
import { test, expect } from "@playwright/test";
import { openApp, loadRepoPath, openGraphInActivePane, graphRowCount, measureMs } from "./load-helpers";

const COMMITS = 5000;
const INITIAL_RENDER_BUDGET_MS = 12_000;
const MAX_DOM_ROWS = 120; // viewport + overscan; must NOT grow with history
const SELECT_BUDGET_MS = 1000;

test("5000-commit graph renders, virtualizes, and stays responsive", async ({ page }) => {
  await openApp(page, { commits: COMMITS, path: loadRepoPath(0) });

  const renderMs = await measureMs(async () => {
    await openGraphInActivePane(page);
  });
  // eslint-disable-next-line no-console
  console.log(`[LOAD] 5000-commit initial render: ${renderMs.toFixed(0)}ms`);
  expect(renderMs).toBeLessThan(INITIAL_RENDER_BUDGET_MS);

  const scroller = page.locator(".graph-scroller");
  await expect(scroller).toBeVisible();

  const bodyHeight = () =>
    page.locator(".graph-body").evaluate((el) => (el as HTMLElement).offsetHeight);

  const initialHeight = await bodyHeight();
  // The initial page is one PAGE_SIZE (300) worth of rows, far short of 5000.
  const initialRows = await graphRowCount(page);
  expect(initialRows).toBeLessThanOrEqual(MAX_DOM_ROWS);

  // Scroll deep, paging in more history. The DOM row count must stay bounded
  // the whole way (virtualization), while the total content height grows as
  // pages load.
  let maxRows = initialRows;
  for (let k = 0; k < 25; k++) {
    await scroller.evaluate((el) => {
      (el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight;
    });
    await page.waitForTimeout(200);
    const rows = await graphRowCount(page);
    maxRows = Math.max(maxRows, rows);
    expect(rows, `DOM rows must stay bounded (iteration ${k})`).toBeLessThanOrEqual(MAX_DOM_ROWS);
    // Rows must keep rendering — never collapse to an empty viewport.
    expect(rows).toBeGreaterThan(0);
  }

  const grownHeight = await bodyHeight();
  // eslint-disable-next-line no-console
  console.log(
    `[LOAD] body height ${initialHeight}px -> ${grownHeight}px, max DOM rows=${maxRows}`,
  );
  // More history actually paged in (content grew well past the first page).
  expect(grownHeight).toBeGreaterThan(initialHeight * 2);

  // Select a deep commit (last one currently rendered) — detail must open fast.
  const lastRow = page.locator('[data-testid="git-graph-view"] .commit-row').last();
  await lastRow.scrollIntoViewIfNeeded();
  const selectMs = await measureMs(async () => {
    await lastRow.click();
    await expect(page.locator('[data-testid="git-graph-detail"]')).toBeVisible();
  });
  // eslint-disable-next-line no-console
  console.log(`[LOAD] deep commit selection: ${selectMs.toFixed(0)}ms`);
  expect(selectMs).toBeLessThan(SELECT_BUDGET_MS);
});

/**
 * Survival under a 256 MiB V8 old-space cap (see the constrained-memory project
 * in playwright.load.config.ts). Opens 8 graph tabs at 1000 commits each, then
 * browses directories — the app must NOT crash the renderer, tabs must stay
 * switchable, and graphs must still render. This is a survival test, not a
 * timing test: there are no latency budgets.
 */
import { test, expect } from "@playwright/test";
import {
  openApp,
  loadRepoPath,
  createTabAndOpenGraph,
  switchToTabById,
  activeTabId,
  waitForGraphRows,
  DOCUMENTS,
} from "./load-helpers";

const REPO_COUNT = 8;

test("8 heavy graph tabs + directory browsing survive a 256 MiB V8 old-space cap", async ({ page }) => {
  let crashed = false;
  page.on("crash", () => {
    crashed = true;
  });

  await openApp(page, { commits: 1000, path: DOCUMENTS });

  const opened: Array<{ tabId: string; repoIndex: number }> = [];
  for (let i = 0; i < REPO_COUNT; i++) {
    await createTabAndOpenGraph(page, loadRepoPath(i));
    await waitForGraphRows(page);
    opened.push({ tabId: await activeTabId(page), repoIndex: i });
    expect(crashed, `renderer crashed while opening tab ${i}`).toBe(false);
  }

  // Every tab is still switchable and its graph still paints.
  for (const { tabId, repoIndex } of opened) {
    await switchToTabById(page, tabId);
    await waitForGraphRows(page);
    await expect(
      page.locator('[data-testid="git-graph-view"] .commit-row').first(),
    ).toContainText(`[load-repo-${repoIndex}]`);
    expect(crashed).toBe(false);
  }

  // Browse directories under the same memory pressure. Switch to the base tab
  // (Documents) and walk down into repos and back up — directory listings must
  // keep rendering, no crash. Uses the Up nav button (a real UI click) rather
  // than a keyboard shortcut so it doesn't depend on pane focus.
  const baseTabId = await page.locator(".tab").first().getAttribute("data-tab-id");
  await switchToTabById(page, baseTabId!);
  await expect(page.locator(`.entry-item[data-path="${loadRepoPath(0)}"]`).first()).toBeVisible();
  const upButton = page.locator('button[title="Up (Alt+Up)"]').first();
  for (let k = 0; k < 4; k++) {
    // Down into a repo directory.
    await page.locator(`.entry-item[data-path="${loadRepoPath(k)}"]`).first().dblclick();
    await expect(page.locator(`.entry-item[data-path="${loadRepoPath(k)}/README.md"]`).first()).toBeVisible();
    // Back up to Documents.
    await upButton.click();
    await expect(page.locator(`.entry-item[data-path="${loadRepoPath(0)}"]`).first()).toBeVisible();
    expect(crashed, `renderer crashed while browsing (iteration ${k})`).toBe(false);
  }

  expect(crashed).toBe(false);
  expect(page.isClosed()).toBe(false);
});

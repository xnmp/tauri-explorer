/**
 * Behaviour under a 4x CPU throttle. Opening several graph tabs, switching
 * between them, and selecting commits must still complete — within relaxed
 * budgets (~4x the unthrottled ones) — and always render real rows.
 */
import { test, expect } from "@playwright/test";
import {
  openApp,
  loadRepoPath,
  createTabAndOpenGraph,
  switchToTabById,
  activeTabId,
  waitForGraphRows,
  measureMs,
  setCpuThrottling,
} from "./load-helpers";

const REPO_COUNT = 6;
const SWITCH_BUDGET_MS = 8000; // 4x the 2s unthrottled budget
const SELECT_BUDGET_MS = 4000; // 4x the 1s unthrottled budget

test("graph tabs stay usable under a 4x CPU throttle", async ({ page }) => {
  const cdp = await setCpuThrottling(page, 4);
  try {
    await openApp(page, { commits: 300 });

    const opened: Array<{ tabId: string; repoIndex: number }> = [];
    for (let i = 0; i < REPO_COUNT; i++) {
      await createTabAndOpenGraph(page, loadRepoPath(i));
      await waitForGraphRows(page);
      await expect(
        page.locator('[data-testid="git-graph-view"] .commit-row').first(),
      ).toContainText(`[load-repo-${i}]`);
      opened.push({ tabId: await activeTabId(page), repoIndex: i });
    }

    // Switch across every tab within the relaxed budget, landing on the right
    // painted graph each time.
    for (const { tabId, repoIndex } of opened) {
      const ms = await measureMs(async () => {
        await switchToTabById(page, tabId);
        await waitForGraphRows(page);
        await expect(
          page.locator('[data-testid="git-graph-view"] .commit-row').first(),
        ).toContainText(`[load-repo-${repoIndex}]`);
      });
      // eslint-disable-next-line no-console
      console.log(`[LOAD] throttled switch repo ${repoIndex}: ${ms.toFixed(0)}ms`);
      expect(ms).toBeLessThan(SWITCH_BUDGET_MS);
    }

    // Commit selection still responds under throttle.
    const row = page.locator('[data-testid="git-graph-view"] .commit-row').nth(2);
    const selectMs = await measureMs(async () => {
      await row.click();
      await expect(page.locator('[data-testid="git-graph-detail"]')).toBeVisible();
    });
    // eslint-disable-next-line no-console
    console.log(`[LOAD] throttled commit selection: ${selectMs.toFixed(0)}ms`);
    expect(selectMs).toBeLessThan(SELECT_BUDGET_MS);
  } finally {
    // Always reset throttling so the session/browser reuse isn't affected.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach().catch(() => {});
  }
});

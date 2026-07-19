/**
 * Tab fan-out under load: open 12 git-graph tabs, one per synthetic repo of
 * 300 commits each. Asserts every tab actually renders the *correct* repo's
 * graph, that per-tab open latency doesn't blow up as tabs accumulate
 * (ratio-based, to survive CI variance), and that switching between all of
 * them stays within a generous absolute budget and always lands on a painted
 * graph.
 */
import { test, expect } from "@playwright/test";
import {
  openApp,
  loadRepoPath,
  createTabAndOpenGraph,
  switchToTabById,
  activeTabId,
  measureMs,
  waitForGraphRows,
  mean,
} from "./load-helpers";

const REPO_COUNT = 12;
const SWITCH_BUDGET_MS = 2000;

test("12 git-graph tabs render correctly and stay responsive", async ({ page }) => {
  await openApp(page, { commits: 300 });

  const opened: Array<{ tabId: string; repoIndex: number }> = [];
  const openLatencies: number[] = [];

  for (let i = 0; i < REPO_COUNT; i++) {
    const ms = await createTabAndOpenGraph(page, loadRepoPath(i));
    openLatencies.push(ms);

    // The graph renders rows, and they are THIS repo's rows: the tip commit
    // summary embeds the repo index (synthetic generator).
    await waitForGraphRows(page);
    await expect(page.locator('[data-testid="git-graph-view"] .commit-row').first()).toContainText(
      `[load-repo-${i}]`,
    );

    opened.push({ tabId: await activeTabId(page), repoIndex: i });
    // eslint-disable-next-line no-console
    console.log(`[LOAD] open tab repo ${i}: ${ms.toFixed(0)}ms`);
  }

  expect(opened).toHaveLength(REPO_COUNT);

  // Degradation curve: opening the last few tabs must not be dramatically
  // slower than the first few. Ratio-based (3x) to absorb CI noise.
  const firstMean = mean(openLatencies.slice(0, 3));
  const lastMean = mean(openLatencies.slice(-3));
  // eslint-disable-next-line no-console
  console.log(`[LOAD] open latency first3=${firstMean.toFixed(0)}ms last3=${lastMean.toFixed(0)}ms`);
  expect(lastMean).toBeLessThanOrEqual(firstMean * 3);

  // Switch across every graph tab: each must land on a painted graph showing
  // the right repo, within a generous absolute budget.
  const switchLatencies: number[] = [];
  for (const { tabId, repoIndex } of opened) {
    const ms = await measureMs(async () => {
      await switchToTabById(page, tabId);
      await waitForGraphRows(page);
      await expect(
        page.locator('[data-testid="git-graph-view"] .commit-row').first(),
      ).toContainText(`[load-repo-${repoIndex}]`);
    });
    switchLatencies.push(ms);
    // eslint-disable-next-line no-console
    console.log(`[LOAD] switch to repo ${repoIndex}: ${ms.toFixed(0)}ms`);
    expect(ms).toBeLessThan(SWITCH_BUDGET_MS);
  }

  // eslint-disable-next-line no-console
  console.log(`[LOAD] switch latency mean=${mean(switchLatencies).toFixed(0)}ms`);

  // Peak-load screenshot for the issue's screenshot requirement (env-gated so
  // routine runs don't rewrite committed assets).
  if (process.env.LOAD_SCREENSHOT_PATH) {
    await page.screenshot({ path: process.env.LOAD_SCREENSHOT_PATH });
  }
});

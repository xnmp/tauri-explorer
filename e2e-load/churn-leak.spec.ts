/**
 * Memory churn / leak detection. Two churn patterns that each remount the
 * GitGraphView many times — the exact surface that historically leaked
 * watchers/timers/cache entries:
 *   1) open-tab-with-graph -> close-tab, 25x
 *   2) toggle the graph on/off in one pane, 25x
 * After forced GC the heap must return to near its post-warmup baseline
 * (baseline + 25 MiB). Requires performance.memory (Chromium) — fails loudly
 * otherwise rather than silently passing.
 */
import { test, expect } from "@playwright/test";
import {
  openApp,
  loadRepoPath,
  createTabAndOpenGraph,
  closeGraphTabToBase,
  openGraphInActivePane,
  waitForGraphRows,
  forceGcAndGetHeap,
  MB,
} from "./load-helpers";

// Env-tunable so a leak hypothesis can be checked by scaling: a real leak's
// heap delta grows linearly with LOAD_CYCLES; GC noise does not.
const CYCLES = Number(process.env.LOAD_CYCLES ?? 25);
const HEAP_BUDGET = 25 * MB;

async function heapOrFail(page: import("@playwright/test").Page, label: string): Promise<number> {
  const heap = await forceGcAndGetHeap(page);
  expect(heap, `performance.memory unavailable — cannot measure heap for ${label}`).not.toBeNull();
  return heap as number;
}

test("open/close graph-tab churn stays within its retained JS heap budget", async ({ page }) => {
  await openApp(page, { commits: 300 });

  // Warm up: one open+close so one-time module/cache allocations are already
  // counted in the baseline.
  await createTabAndOpenGraph(page, loadRepoPath(0));
  await closeGraphTabToBase(page);
  const baseline = await heapOrFail(page, "open/close baseline");

  for (let i = 0; i < CYCLES; i++) {
    await createTabAndOpenGraph(page, loadRepoPath(i % 12));
    await closeGraphTabToBase(page);
  }

  const final = await heapOrFail(page, "open/close final");
  // eslint-disable-next-line no-console
  console.log(
    `[LOAD] open/close heap baseline=${(baseline / MB).toFixed(1)} MiB final=${(final / MB).toFixed(1)} MiB delta=${((final - baseline) / MB).toFixed(1)} MiB`,
  );
  expect(final - baseline).toBeLessThanOrEqual(HEAP_BUDGET);
});

test("graph on/off toggle churn stays within its retained JS heap budget", async ({ page }) => {
  await openApp(page, { commits: 300 });

  // A single pane sitting on a repo, graph open.
  await createTabAndOpenGraph(page, loadRepoPath(1));
  const baseline = await heapOrFail(page, "toggle baseline");

  for (let i = 0; i < CYCLES; i++) {
    // Off: back to the file list.
    await page.keyboard.press("Control+Alt+g");
    await expect(page.locator('[data-testid="git-graph-view"]')).toHaveCount(0);
    await expect(page.locator(".entry-item").first()).toBeVisible();
    // On: graph repaints.
    await openGraphInActivePane(page);
  }
  await waitForGraphRows(page);

  const final = await heapOrFail(page, "toggle final");
  // eslint-disable-next-line no-console
  console.log(
    `[LOAD] toggle heap baseline=${(baseline / MB).toFixed(1)} MiB final=${(final / MB).toFixed(1)} MiB delta=${((final - baseline) / MB).toFixed(1)} MiB`,
  );
  expect(final - baseline).toBeLessThanOrEqual(HEAP_BUDGET);
});

/**
 * Shared helpers for the high-load stress suite (playwright.load.config.ts).
 *
 * Everything here drives the app through real UI — keyboard shortcuts, folder
 * double-clicks, tab clicks — never by mutating window/store globals. The only
 * privileged calls are measurement probes (window.gc(), performance.memory,
 * CDP CPU throttling), which observe rather than change app state.
 */

import { expect, type Page } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

/** Where the synthetic load-repos live in the mock filesystem. */
export const LOAD_REPO_PREFIX = "/home/user/Documents/load-repo-";
export const DOCUMENTS = "/home/user/Documents";

export function loadRepoPath(index: number): string {
  return `${LOAD_REPO_PREFIX}${index}`;
}

/** Open the app at Documents with a synthetic commit count for load-repos. */
export async function openApp(
  page: Page,
  opts: { commits?: number; path?: string } = {},
): Promise<void> {
  const path = opts.path ?? DOCUMENTS;
  const query = new URLSearchParams({ path });
  // Always present: this param is also the opt-in switch that makes the mock
  // FS inject the load-repo-<i> directories (absent in regular E2E runs).
  query.set("mockGitCommits", String(opts.commits ?? 300));
  await page.goto(`/?${query.toString()}`);
  await page.waitForSelector(".file-list");
  await page.locator(".entry-item").first().waitFor({ timeout: 15_000 });
}

/** Measure the wall-clock duration (ms) of an async operation. */
export async function measureMs(fn: () => Promise<void>): Promise<number> {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}

export const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const GRAPH = '[data-testid="git-graph-view"]';

/** Wait until the git graph has painted commit rows. */
export async function waitForGraphRows(page: Page, timeout = 30_000): Promise<void> {
  await expect(page.locator(`${GRAPH} .commit-row`).first()).toBeVisible({ timeout });
}

export function graphRowCount(page: Page): Promise<number> {
  return page.locator(`${GRAPH} .commit-row`).count();
}

/** Open the commit graph in the currently active pane (Ctrl+Alt+G). */
export async function openGraphInActivePane(page: Page): Promise<void> {
  await page.keyboard.press("Control+Alt+g");
  await waitForGraphRows(page);
}

/** Navigate the active pane into `repoPath` by double-clicking its folder entry
 *  (the repo must be listed in the current directory — the load-repos all sit
 *  directly under Documents). Real UI, no store access. */
async function navigateInto(page: Page, repoPath: string): Promise<void> {
  const entry = page.locator(`.entry-item[data-path="${repoPath}"]`).first();
  await entry.waitFor({ timeout: 15_000 });
  await entry.dblclick();
  // Confirm the pane actually entered the repo (a child entry is listed).
  await page
    .locator(`.entry-item[data-path="${repoPath}/README.md"]`)
    .first()
    .waitFor({ timeout: 15_000 });
}

/**
 * Create a fresh tab and open `repoPath`'s commit graph in it, all through the
 * UI: switch to the base (Documents) tab so the new tab inherits Documents,
 * Ctrl+T, double-click the repo folder, then Ctrl+Alt+G.
 *
 * Returns the measured open latency (ms) from Ctrl+T to graph rows painted.
 */
export async function createTabAndOpenGraph(page: Page, repoPath: string): Promise<number> {
  // Return focus to the base (first) tab so the new tab inherits Documents.
  // The tab strip is hidden while only one tab exists (showWindowTabBar), so
  // guard the click on the strip actually being present.
  if ((await page.locator(".tab").count()) > 0) {
    const first = page.locator(".tab").first();
    await first.click();
    await expect(first).toHaveClass(/active/);
  }
  // The base tab lists Documents (all load-repos visible there).
  await page
    .locator(`.entry-item[data-path="${LOAD_REPO_PREFIX}0"]`)
    .first()
    .waitFor({ timeout: 15_000 });

  const before = await page.locator(".tab").count();
  return measureMs(async () => {
    await page.keyboard.press("Control+t");
    // The strip appears at 2 tabs, so the DOM count jumps 0->2 the first time;
    // afterwards each Ctrl+T adds one. Wait for strictly more than before.
    await expect
      .poll(() => page.locator(".tab").count())
      .toBeGreaterThan(Math.max(before, 1));
    await navigateInto(page, repoPath);
    await openGraphInActivePane(page);
  });
}

/** Close the active (graph) tab and land back on the base Documents tab. */
export async function closeGraphTabToBase(page: Page): Promise<void> {
  await page.keyboard.press("Control+w");
  await expect(page.locator(GRAPH)).toHaveCount(0);
  await expect(page.locator(`.entry-item[data-path="${LOAD_REPO_PREFIX}0"]`).first()).toBeVisible();
}

/** Click the nth tab (0-based) and wait for it to become active. */
export async function switchToTab(page: Page, index: number): Promise<void> {
  const tab = page.locator(".tab").nth(index);
  await tab.click();
  await expect(tab).toHaveClass(/active/);
}

/** The id of the currently active tab (its stable data-tab-id). */
export async function activeTabId(page: Page): Promise<string> {
  const id = await page.locator(".tab.active").getAttribute("data-tab-id");
  if (!id) throw new Error("no active tab");
  return id;
}

/** Click a tab by its stable id (insertion reorders indices; ids don't). */
export async function switchToTabById(page: Page, id: string): Promise<void> {
  const tab = page.locator(`.tab[data-tab-id="${id}"]`);
  await tab.click();
  await expect(tab).toHaveClass(/active/);
}

export function tabCount(page: Page): Promise<number> {
  return page.locator(".tab").count();
}

/**
 * Force garbage collection (requires --expose-gc) and read the JS heap size.
 * Returns null when performance.memory is unavailable (non-Chromium).
 */
export async function forceGcAndGetHeap(page: Page): Promise<number | null> {
  // Repeated GC passes with settle time between them: a single gc() call does
  // not fully drain finalizers/weak refs, which showed up as multi-MB
  // run-to-run variance in the leak specs.
  for (let pass = 0; pass < 3; pass++) {
    await page.evaluate(() => {
      const g = (globalThis as unknown as { gc?: () => void }).gc;
      if (typeof g === "function") g();
    });
    await page.waitForTimeout(150);
  }
  return page.evaluate(() => {
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    return mem ? mem.usedJSHeapSize : null;
  });
}

export const MB = 1024 * 1024;

/** Set Chromium CPU throttling via CDP. rate=1 is no throttle; 4 is 4x slower.
 *  Returns the session so the caller can reset it. */
export async function setCpuThrottling(page: Page, rate: number): Promise<CDPSession> {
  const client = await page.context().newCDPSession(page);
  await client.send("Emulation.setCPUThrottlingRate", { rate });
  return client;
}

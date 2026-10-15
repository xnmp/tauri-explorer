/**
 * Tab switching keeps recently active tabs mounted (#1173).
 *
 * A switch used to remount the whole pane tree, rebuilding the pane chrome and
 * every visible row of the target tab. Retained tabs only toggle visibility:
 * their rows keep their DOM identity and scroll offset, no listing is
 * requested again, and a switch stays within a frame budget however often it
 * is repeated.
 */
import { test, expect, type Page } from "./fixtures";

const HUGE = "/perf/huge-5000";
/** Input to the frame after the switch; the issue's stated budget. */
const SWITCH_BUDGET_MS = 100;
/** Renderer main-thread time per switch (CDP TaskDuration) under 4x throttling. */
const SWITCH_WORK_BUDGET_MS = 75;

const shownTab = (page: Page) => page.locator(".pane-tree:not(.retained)");
const shownRows = (page: Page) => shownTab(page).locator(".entry-item");

async function listingRequests(page: Page): Promise<number> {
  return page.evaluate(() => {
    const counts = (window as any).__mockControl?.invokeCounts ?? {};
    return ["list_directory", "list_directory_fresh", "start_observed_directory", "list_directory_stream"]
      .reduce((sum, cmd) => sum + (counts[cmd] ?? 0), 0);
  });
}

/** Switch with a trusted-equivalent window keydown; resolves at the next frame. */
async function timedShortcutSwitch(page: Page, shift: boolean): Promise<number> {
  return page.evaluate((shift) => new Promise<number>((resolve) => {
    const start = performance.now();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", ctrlKey: true, shiftKey: shift, bubbles: true }));
    requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start), 0));
  }), shift);
}

async function goTo(page: Page, path: string, row: string): Promise<void> {
  await page.keyboard.press("Control+l");
  await page.locator(".path-input").fill(path);
  await page.locator(".path-input").press("Enter");
  await shownRows(page).filter({ hasText: row }).first().waitFor();
}

/** Two tabs: the 5000-entry folder, then a new tab showing `second`. */
async function openTwoTabs(page: Page, second: [path: string, row: string]): Promise<void> {
  await page.goto(`/?path=${HUGE}`);
  await shownRows(page).filter({ hasText: "folder-00000" }).waitFor();
  await page.keyboard.press("Control+t");
  await expect(page.locator(".tab")).toHaveCount(2);
  await goTo(page, ...second);
}

test("switching back to a tab reuses its rows and scroll offset without reloading", async ({ page }) => {
  await openTwoTabs(page, ["/home/user", "Documents"]);
  await page.locator(".tab").first().click();
  const viewport = shownTab(page).locator(".virtual-viewport");
  await viewport.evaluate((el) => { el.scrollTop = 12_000; });
  const offset = await viewport.evaluate((el) => el.scrollTop);
  expect(offset).toBeGreaterThan(0);
  await expect(shownRows(page).filter({ hasText: "folder-00000" })).toHaveCount(0);
  const path = await shownRows(page).nth(8).getAttribute("data-path");
  const marked = shownRows(page).and(page.locator(`[data-path="${path}"]`));
  await marked.evaluate((el) => { (el as any).__retainedMarker = true; });
  const requests = await listingRequests(page);

  for (let i = 0; i < 3; i++) {
    await page.locator(".tab").nth(1).click();
    await shownRows(page).filter({ hasText: "Documents" }).waitFor();
    await page.keyboard.press("Control+Shift+Tab");
    await expect(marked).toBeVisible();
  }

  // Same DOM node: the row was not rebuilt, and the viewport kept its offset.
  expect(await marked.evaluate((el) => (el as any).__retainedMarker === true)).toBe(true);
  expect(await viewport.evaluate((el) => el.scrollTop)).toBe(offset);
  expect(await listingRequests(page)).toBe(requests);
  // Focus leaves a tab that is hidden, as it did when the tab unmounted.
  await marked.click();
  await expect(marked).toBeFocused();
  await page.keyboard.press("Control+Tab");
  await shownRows(page).filter({ hasText: "Documents" }).waitFor();
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest(".pane-tree.retained"))).toBe(false);
  await page.keyboard.press("Control+Shift+Tab");
  await expect(marked).toBeVisible();
  // The hidden tab is neither visible nor reachable.
  await expect(page.locator(".pane-tree.retained")).toHaveCount(1);
  await expect(page.locator(".pane-tree.retained")).toHaveAttribute("inert", "");
  await expect(page.locator(".pane-tree.retained .entry-item").first()).toBeHidden();
});

test.describe("tab switch latency", () => {
  // Timing budgets flake under full-suite worker contention; a genuine
  // regression still fails every retry (as in performance.spec.ts).
  test.describe.configure({ retries: 2 });

  test("repeated tab switches stay within the frame budget and do not slow down", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "CPU throttling and task metrics need CDP");
    // A large folder in both tabs: the expensive case for a remount.
    await openTwoTabs(page, [HUGE, "folder-00000"]);
    const cdp = await page.context().newCDPSession(page);
    // A slower machine than the CI runner; main-thread time, not wall time,
    // so driver round trips and runner load do not count against the switch.
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await cdp.send("Performance.enable");
    const taskMs = async () => {
      const { metrics } = await cdp.send("Performance.getMetrics");
      return (metrics.find((m) => m.name === "TaskDuration")?.value ?? 0) * 1000;
    };
    // Warm both tabs once.
    await timedShortcutSwitch(page, false);
    await timedShortcutSwitch(page, false);

    const wall: number[] = [];
    const work: number[] = [];
    for (let i = 0; i < 20; i++) {
      const before = await taskMs();
      wall.push(await timedShortcutSwitch(page, i % 2 === 1));
      work.push(await taskMs() - before);
      await expect(shownRows(page).first()).toBeVisible();
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const early = median(work.slice(0, 8));
    const late = median(work.slice(-8));
    console.log(`[PERF] tab switch (4x CPU): wall median ${median(wall).toFixed(1)}ms, `
      + `main-thread median ${median(work).toFixed(1)}ms (early ${early.toFixed(1)}, late ${late.toFixed(1)})`);
    expect(median(wall)).toBeLessThan(SWITCH_BUDGET_MS);
    // Remounting the 5000-entry tab cost 90-200ms of main-thread time here.
    expect(median(work)).toBeLessThan(SWITCH_WORK_BUDGET_MS);
    expect(late).toBeLessThan(Math.max(early * 1.5, early + 10));
  });
});

import { expect, test, type Page } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

// A peek's first listing is a read, not a watcher refresh: it must not wait
// out refresh-manager's debounce (150ms) or storm interval (2s), and its
// "Loading…" row appears only when the listing itself takes over 150ms.
const root = "/folder-peek";
const row = (page: Page, path: string) => page.locator(`.pane-tree:not(.retained) .entry-item[data-path="${path}"]`);
const caret = (page: Page, name: string, state: "Expand" | "Collapse" = "Expand") =>
  row(page, `${root}/${name}`).getByRole("button", { name: `${state} ${name}`, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.evaluate(async path => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
    settingsStore.update({ showHidden: false });
    const explorer = windowTabsManager.getActiveExplorer()!; explorer.setViewMode("details");
    await explorer.navigateTo(path, { autoEnterSingleSubdir: false });
  }, root);
  await expect(row(page, `${root}/Alpha`)).toBeVisible();
  // Record every Loading row the page ever renders, with its time.
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { __peekLoading: number[] }).__peekLoading = seen;
    new MutationObserver(() => {
      // Details and List (card pseudo-row) Loading rows.
      if ([...document.querySelectorAll(".peek-state, .list-peek-state")].some(node => node.textContent?.includes("Loading…"))) seen.push(performance.now());
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
});
const loadingSeen = (page: Page) => page.evaluate(() => (window as unknown as { __peekLoading: number[] }).__peekLoading);
const now = (page: Page) => page.evaluate(() => performance.now());

test("expanding with an instant listing never flashes Loading", async ({ page }) => {
  await caret(page, "Alpha").click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  expect(await loadingSeen(page)).toEqual([]);
});

test("collapse and re-open inside the watcher interval are immediate", async ({ page }) => {
  await caret(page, "Alpha").click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await caret(page, "Alpha", "Collapse").click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  await caret(page, "Alpha").click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  expect(await loadingSeen(page)).toEqual([]);
});

test("List shows the open peek as a card, and returning to Details restores it, without Loading", async ({ page }) => {
  await caret(page, "Alpha").click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  for (const mode of ["list", "details"] as const) {
    await page.evaluate(async mode => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      windowTabsManager.getActiveExplorer()!.setViewMode(mode);
    }, mode);
    if (mode === "list") {
      // List loads lazily: wait for its canvas, then for the settled card (#1240).
      await expect(page.locator(".pane-tree:not(.retained) .list-canvas")).toBeVisible();
      await expect(page.locator(`.pane-tree:not(.retained) [data-card-scroll] .entry-item[data-path="${root}/Alpha/same.txt"]`)).toBeVisible();
    }
  }
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  expect(await loadingSeen(page)).toEqual([]);
});

test("a slow listing shows Loading only after 150ms, then its result", async ({ page }) => {
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().latency = { list_directory_fresh: 600 };
  });
  const clicked = await now(page);
  await caret(page, "Empty").click();
  await expect(page.locator(".peek-state")).toHaveText("Loading…");
  const [first] = await loadingSeen(page);
  expect(first - clicked).toBeGreaterThanOrEqual(150);
  await expect(page.locator(".peek-state")).toHaveText("Empty folder");
});

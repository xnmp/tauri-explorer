/** The pane filter applies inside Folder Peek (#1510): a folder whose name
 * does not match stays for a matching descendant, and its peek shows only the
 * matches and the folders on the path to them. */
import { expect, test, type Page } from "./fixtures";
import { waitForEntries, HOME_URL } from "./helpers";

const root = "/home/user/Documents/project";
const shown = ".pane-tree:not(.retained)";
const row = (page: Page, path: string) => page.locator(`${shown} .entry-item[data-path="${path}"]`);
const shotDir = "screenshots/feat/make-the-filter-apply-to-peeked-folders-too";

async function start(page: Page, mode: "details" | "list" | "tiles") {
  await page.goto(HOME_URL);
  await waitForEntries(page);
  await page.evaluate(async ([path, mode]) => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.setViewMode(mode as "details");
    await explorer.navigateTo(path, { autoEnterSingleSubdir: false });
  }, [root, mode]);
  await expect(row(page, `${root}/src`)).toBeVisible();
}
async function filter(page: Page, query: string) {
  await page.evaluate(async query => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    explorer.openFilter();
    explorer.setFilter(query);
  }, query);
}
async function peek(page: Page, path: string) {
  await page.evaluate(async path => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.togglePeek(path);
  }, path);
}

test("Details: a non-matching folder stays for a deeper match and its peek shows only the path to it", async ({ page }) => {
  await start(page, "details");
  await filter(page, "Modal");
  // src/components/Modal is two levels below src: src stays, unrelated folders go.
  await expect(row(page, `${root}/src`)).toBeVisible();
  await expect(row(page, `${root}/docs`)).toHaveCount(0);
  await expect(row(page, `${root}/README.md`)).toHaveCount(0);
  await peek(page, `${root}/src`);
  await expect(row(page, `${root}/src/components`)).toBeVisible();
  await expect(row(page, `${root}/src/utils`)).toHaveCount(0);
  await expect(row(page, `${root}/src/App.tsx`)).toHaveCount(0);
  await peek(page, `${root}/src/components`);
  await expect(row(page, `${root}/src/components/Modal`)).toBeVisible();
  await expect(row(page, `${root}/src/components/Button`)).toHaveCount(0);
  await expect(row(page, `${root}/src/components/Header.tsx`)).toHaveCount(0);
  await peek(page, `${root}/src/components/Modal`);
  await expect(row(page, `${root}/src/components/Modal/Modal.tsx`)).toBeVisible();
  await expect(row(page, `${root}/src/components/Modal/index.ts`)).toHaveCount(0);
  await page.screenshot({ path: `${shotDir}/details-filtered-peek.png`, animations: "disabled" });

  // Clearing the filter restores every entry of the open peeks (rows past the
  // viewport are virtualized, so read the pane's entries).
  await filter(page, "");
  await expect(row(page, `${root}/src/components/Button`)).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    return windowTabsManager.getActiveExplorer()!.displayEntries.map(entry => entry.path);
  })).toEqual(expect.arrayContaining([`${root}/src/App.tsx`, `${root}/src/components/Header.tsx`, `${root}/docs`]));
});

test("List: the open card shows only the path to the match", async ({ page }) => {
  await start(page, "list");
  await peek(page, `${root}/src`);
  await expect(row(page, `${root}/src/App.tsx`)).toBeVisible();
  await filter(page, "Modal");
  await expect(row(page, `${root}/src/components`)).toBeVisible();
  await expect(row(page, `${root}/src/App.tsx`)).toHaveCount(0);
  await expect(row(page, `${root}/docs`)).toHaveCount(0);
  await peek(page, `${root}/src/components`);
  await expect(row(page, `${root}/src/components/Modal`)).toBeVisible();
  await expect(row(page, `${root}/src/components/Header.tsx`)).toHaveCount(0);
  await page.screenshot({ path: `${shotDir}/list-filtered-peek.png`, animations: "disabled" });
});

test("Tiles: the panel shows only the path to the match", async ({ page }) => {
  await start(page, "tiles");
  await peek(page, `${root}/src`);
  await expect(page.locator(`${shown} .tile-panel[data-path="${root}/src"] .entry-item[data-path="${root}/src/App.tsx"]`)).toBeVisible();
  await filter(page, "Modal");
  await expect(page.locator(`${shown} .tile-panel[data-path="${root}/src"] .entry-item[data-path="${root}/src/components"]`)).toBeVisible();
  await expect(row(page, `${root}/src/App.tsx`)).toHaveCount(0);
  await expect(row(page, `${root}/docs`)).toHaveCount(0);
  await page.screenshot({ path: `${shotDir}/tiles-filtered-peek.png`, animations: "disabled" });
});

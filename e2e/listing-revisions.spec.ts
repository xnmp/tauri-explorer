import { expect, test } from "./fixtures";
import { VIEW_MODES, waitForEntries } from "./helpers";

for (const mode of VIEW_MODES) {
  test(`immutable listing revisions update rendered entries in ${mode}`, async ({ page }) => {
    await page.goto("/?path=/home/user/Documents");
    await waitForEntries(page);
    const identity = await page.evaluate(async (mode) => {
      const loadExplorer = new Function("return import('/src/lib/state/explorer.svelte.ts')");
      const loadManager = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const [{ createExplorerState }, { windowTabsManager }] = await Promise.all([loadExplorer(), loadManager()]);
      const entries = [{ name: "snapshot.txt", path: "/snapshot/snapshot.txt", kind: "file", size: 1, modified: "2026-01-01" }];
      const seeded = createExplorerState({ currentPath: "/snapshot", entries, sortBy: "name", sortAscending: true, viewMode: mode });
      const result = {
        sameRevision: seeded.state.entries === entries,
        sameEntry: seeded.displayEntries[0] === entries[0],
      };
      await seeded.destroy();
      windowTabsManager.getActiveExplorer().setViewMode(mode);
      return result;
    }, mode);
    // Run in the browser: SSR unit compilation does not exercise Svelte proxies.
    expect(identity).toEqual({ sameRevision: true, sameEntry: true });

    const name = `revision-${mode}.txt`;
    const publication = await page.evaluate(async (name) => {
      const loadManager = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const loadApi = new Function("return import('/src/lib/api/files.ts')");
      const [{ windowTabsManager }, api] = await Promise.all([loadManager(), loadApi()]);
      const explorer = windowTabsManager.getActiveExplorer();
      const previous = explorer.state.entries;
      const created = await api.createEmptyFile(explorer.currentPath, name);
      if (!created.ok) throw new Error(created.error);
      await explorer.refresh({ silent: true });
      const changed = explorer.state.entries;
      await explorer.refresh({ silent: true });
      return { replaced: previous !== changed, unchanged: explorer.state.entries === changed, count: explorer.displayEntries.length };
    }, name);
    expect(publication.replaced).toBe(true);
    expect(publication.unchanged).toBe(true);
    const row = page.locator('.entry-item').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(page.locator('.status-bar')).toContainText(`${publication.count} items`);
    await row.click();
    await expect(row).toHaveClass(/selected/);
    await expect(page.locator('.status-bar')).toContainText('1 selected');
  });
}

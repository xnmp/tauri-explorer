import { expect, test } from "./fixtures";
import { HOME_URL, waitForEntries } from "./helpers";

const shown = ".pane-tree:not(.retained)";

for (const mode of ["details", "list"] as const) {
  test(`${mode}: caretless Open action placement`, async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.evaluate(async mode => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
      settingsStore.update({ folderPeek: true, folderPeekCarets: false });
      const explorer = windowTabsManager.getActiveExplorer()!;
      explorer.setViewMode(mode);
      await explorer.navigateTo("/folder-peek", { autoEnterSingleSubdir: false });
    }, mode);
    const row = page.locator(`${shown} .entry-item[data-path="/folder-peek/Alpha"]`);
    await row.hover();
    await expect(row.getByRole("button", { name: "Open Alpha", exact: true })).toHaveCSS("opacity", "1");
    const placement = await row.evaluate((element, mode) => {
      const title = element.querySelector(".entry-name")!;
      const text = document.createRange();
      text.selectNodeContents(title);
      const titleGap = element.querySelector(".peek-open")!.getBoundingClientRect().left - text.getBoundingClientRect().right;
      const rowRect = mode === "list" ? element.getBoundingClientRect() : element.querySelector(".name-cell")!.getBoundingClientRect();
      const buttonRect = element.querySelector(".peek-open")!.getBoundingClientRect();
      return { titleGap, rowRightGap: rowRect.right - buttonRect.right };
    }, mode);
    // List: row edge. Details: right end of the Name column (#1359).
    expect(placement.rowRightGap).toBeGreaterThanOrEqual(mode === "list" ? 7 : 3);
    expect(placement.rowRightGap).toBeLessThanOrEqual(mode === "list" ? 10 : 8);
    const placementName = mode === "list" ? "at-row-edge" : "at-name-column-end";
    await page.screenshot({ path: `screenshots/fix/peek/open-${placementName}-${mode}.png` });
    await row.getByRole("button", { name: "Open Alpha", exact: true }).click();
    await expect(page.locator(`${shown} .entry-item[data-path="/folder-peek/Alpha/same.txt"]`)).toBeVisible();
  });
  test(`${mode}: long caretless folder titles truncate while Open remains usable`, async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await page.evaluate(async mode => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
      settingsStore.update({ folderPeek: true, folderPeekCarets: false });
      const explorer = windowTabsManager.getActiveExplorer()!;
      explorer.setViewMode(mode);
      const { mockFiles } = await import("/src/lib/api/mock-fixtures.ts");
      for (const entry of mockFiles["/home/preview-containment/long-names"]) {
        if (entry.kind === "directory") mockFiles[entry.path] = [];
      }
      await explorer.navigateTo("/home/preview-containment/long-names", { autoEnterSingleSubdir: false });
    }, mode);
    const row = page.locator(`${shown} .entry-item.directory`).first();
    const path = await row.getAttribute("data-path");
    await row.hover();
    const button = row.getByRole("button", { name: /^Open / });
    await expect(button).toHaveCSS("opacity", "1");
    const geometry = await row.evaluate(element => {
      const title = element.querySelector("[data-drag-name]")!;
      const button = element.querySelector(".peek-open")!.getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(element.querySelector(".entry-name")!);
      return { clipped: text.getBoundingClientRect().width > title.getBoundingClientRect().width + 1, outside: button.right > element.getBoundingClientRect().right + 1 };
    });
    expect(geometry).toEqual({ clipped: true, outside: false });
    await button.click();
    await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.currentPath)).toBe(path);
  });

}

import { expect, test } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

const shown = ".pane-tree:not(.retained)";

for (const mode of ["details", "list"] as const) {
  test(`${mode}: caretless Open action sits at the row's far right edge (#1328)`, async ({ page }) => {
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
    const geometry = await row.evaluate(element => {
      // Details: the Name cell's right edge; List: the row's content edge.
      const container = element.querySelector(".name-cell") ?? element;
      const style = getComputedStyle(container);
      const edge = container.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
      const text = document.createRange();
      text.selectNodeContents(element.querySelector(".entry-name")!);
      const button = element.querySelector(".peek-open")!.getBoundingClientRect();
      return { fromEdge: edge - button.right, gap: button.left - text.getBoundingClientRect().right };
    });
    expect(Math.abs(geometry.fromEdge)).toBeLessThanOrEqual(1);
    // A short title leaves the action well away from the name.
    expect(geometry.gap).toBeGreaterThan(40);
    await page.screenshot({ path: `screenshots/fix/list-view-peek/1328-open-far-right-${mode}.png` });
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
      return {
        clipped: text.getBoundingClientRect().width > title.getBoundingClientRect().width + 1,
        outside: button.right > element.getBoundingClientRect().right + 1,
        overlaps: title.getBoundingClientRect().right > button.left + 0.5,
        width: Math.round(button.width),
      };
    });
    expect(geometry).toEqual({ clipped: true, outside: false, overlaps: false, width: 22 });
    await button.click();
    await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.currentPath)).toBe(path);
  });

}

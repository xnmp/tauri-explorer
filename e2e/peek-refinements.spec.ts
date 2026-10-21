import { expect, test } from "@playwright/test";
import { HOME_URL, waitForEntries } from "./helpers";

const shown = ".pane-tree:not(.retained)";

for (const mode of ["details", "list"] as const) {
  test(`${mode}: caretless Open action sits at the folder row's far edge`, async ({ page }) => {
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
    const rightGap = await row.evaluate(element => {
      const rowRight = element.getBoundingClientRect().right;
      const openRight = element.querySelector(".peek-open")!.getBoundingClientRect().right;
      return rowRight - openRight;
    });
    expect(rightGap).toBeGreaterThanOrEqual(0);
    expect(rightGap).toBeLessThanOrEqual(16);
    await page.screenshot({ path: `screenshots/fix/peek/open-at-row-edge-${mode}.png` });
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

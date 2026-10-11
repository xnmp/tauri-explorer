import { test, expect, type Page } from "./fixtures";

const pane = (page: Page, index: number) => page.locator(".explorer-pane").nth(index);
const file = (page: Page, index: number, path: string) => pane(page, index).locator(`.entry-item[data-path="${path}"]`);
const pictures = "/home/user/Pictures";
const photo1 = `${pictures}/photo1.jpg`, photo2 = `${pictures}/photo2.jpg`;
const beach = `${pictures}/vacation/beach.jpg`, sunset = `${pictures}/vacation/sunset.png`;

async function combinedPaths(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    // Read through a real plugin context, exercising the public capability.
    // @ts-expect-error Vite serves source modules for browser tests.
    const { createPluginContext } = await import("/src/lib/plugins/api.ts");
    const { ctx, dispose } = createPluginContext("cross-pane-selection-test");
    try { return ctx.workspace.getCombinedSelection().map((entry: { path: string }) => entry.path); }
    finally { dispose(); }
  });
}

for (const mode of ["details", "list", "tiles"] as const) {
  test.describe(`Cross-pane selection (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/?path=${pictures}`);
      await expect(file(page, 0, photo1)).toBeVisible();
      await page.keyboard.press("Control+\\");
      await expect(pane(page, 1)).toBeVisible();
      await page.evaluate(async (mode) => {
        // @ts-expect-error Vite serves source modules for browser tests.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        const ids = manager.activePaneIds;
        await manager.getExplorer(ids[1]).navigateTo("/home/user/Pictures/vacation");
        manager.getExplorer(ids[1]).clearSelection();
        for (const id of ids) manager.getExplorer(id).viewMode = mode;
      }, mode);
      await expect(file(page, 1, beach)).toBeVisible();
      await file(page, 0, photo2).click();
      await file(page, 0, photo1).click({ modifiers: ["Control"] });
      await expect(pane(page, 0)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
    });

    test("Ctrl-click selects and toggles across panes while retaining focus and combined order", async ({ page }) => {
      const originalFocus = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.path);
      await file(page, 1, sunset).click({ modifiers: ["Control"] });
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await expect(pane(page, 0)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      for (const [index, path] of [[0, photo1], [0, photo2], [1, beach], [1, sunset]] as const) {
        await expect(file(page, index, path)).toHaveAttribute("aria-selected", "true");
        await expect(file(page, index, path)).toHaveClass(/selected/);
      }
      expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.path)).toBe(originalFocus);
      // The host's per-pane selection order is listing order, independent of click order.
      expect(await combinedPaths(page)).toEqual([photo1, photo2, beach, sunset]);
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "false");
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "true");
      await expect(pane(page, 0)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      await page.mouse.move(0, 0);
      const selectedFill = await file(page, 1, sunset).evaluate((element) => getComputedStyle(element).backgroundColor);
      const unselectedFill = await file(page, 1, beach).evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(selectedFill).not.toBe(unselectedFill);
      expect(await combinedPaths(page)).toEqual([photo1, photo2, sunset]);
    });

    test("combined selection deduplicates a file selected in both panes", async ({ page }) => {
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves source modules for browser tests.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        await manager.getExplorer(manager.activePaneIds[1]).navigateTo("/home/user/Pictures");
        manager.getExplorer(manager.activePaneIds[1]).clearSelection();
      });
      await file(page, 1, photo1).click({ modifiers: ["Control"] });
      await expect(pane(page, 0)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      await expect(file(page, 1, photo1)).toHaveAttribute("aria-selected", "true");
      expect(await combinedPaths(page)).toEqual([photo1, photo2]);
    });

    test("plain click moves focus and replaces only the target pane's selection", async ({ page }) => {
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await file(page, 1, sunset).click();
      await expect(pane(page, 1)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "false");
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "true");
      expect(await combinedPaths(page)).toEqual([sunset, photo1, photo2]);
    });

    test("focused pane keyboard selection never changes the other pane", async ({ page }) => {
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await page.keyboard.press("Control+a");
      await expect(pane(page, 0).locator('.entry-item[aria-selected="true"]')).toHaveCount(4);
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "true");
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "false");
      await page.keyboard.press("Escape");
      await expect(pane(page, 0).locator('.entry-item[aria-selected="true"]')).toHaveCount(0);
      await page.keyboard.press("ArrowDown");
      await expect(pane(page, 0).locator('.entry-item[aria-selected="true"]')).toHaveCount(1);
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "true");
      await expect(pane(page, 0)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
    });

    test("Shift-click retains target-pane range and focus behavior", async ({ page }) => {
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await file(page, 1, sunset).click({ modifiers: ["Shift"] });
      await expect(pane(page, 1)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "true");
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "true");
      await expect(file(page, 0, photo1)).toHaveAttribute("aria-selected", "true");
    });

    test("right-click still opens the target file's menu and activates its pane", async ({ page }) => {
      await file(page, 1, beach).click({ button: "right" });
      await expect(page.locator(".context-menu")).toBeVisible();
      await expect(pane(page, 1)).toHaveClass(/(?:^|\s)active(?:\s|$)/);
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "true");
      await expect(file(page, 0, photo1)).toHaveAttribute("aria-selected", "true");
    });

    test("Ctrl-drag from the other pane still copies into a folder", async ({ page }) => {
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves source modules for browser tests.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        await manager.getExplorer(manager.activePaneIds[0]).navigateTo("/home/user");
      });
      const documents = file(page, 0, "/home/user/Documents");
      await expect(documents).toBeVisible();
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      const source = await file(page, 1, beach).boundingBox();
      const target = await documents.boundingBox();
      if (!source || !target) throw new Error("Drag source or target is not visible");
      await page.keyboard.down("Control");
      try {
        await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
        await page.mouse.down();
        await page.mouse.move(source.x + source.width / 2 + 15, source.y + source.height / 2, { steps: 5 });
        await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 15 });
        await page.mouse.up();
      } finally { await page.keyboard.up("Control"); }
      await documents.dblclick();
      await expect(file(page, 0, "/home/user/Documents/beach.jpg")).toBeVisible();
      await expect(file(page, 1, beach)).toBeVisible();
    });
  });
}

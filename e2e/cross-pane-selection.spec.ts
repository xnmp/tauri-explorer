import type { Locator } from "@playwright/test";
import { test, expect, type Page } from "./fixtures";

const pane = (page: Page, index: number) => page.locator(".explorer-pane").nth(index);
const file = (page: Page, index: number, path: string) => pane(page, index).locator(`.entry-item[data-path="${path}"]`);
const pictures = "/home/user/Pictures";
const photo1 = `${pictures}/photo1.jpg`, photo2 = `${pictures}/photo2.jpg`;
const beach = `${pictures}/vacation/beach.jpg`, sunset = `${pictures}/vacation/sunset.png`;

const isActive = /(?:^|\s)active(?:\s|$)/;

/** A real mouse drag (HTML5 DnD) from `source` onto `target`, with optional held keys. */
async function dragBetween(page: Page, source: Locator, target: Locator, keys: readonly string[] = []): Promise<void> {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Drag source or target is not visible");
  // Details rows can be wider than their pane (horizontal scroll), so the row's
  // geometric centre may be clipped; grab the leading, always-visible edge.
  const grab = (box: { x: number; width: number }) => box.x + Math.min(box.width / 2, 60);
  const fromX = grab(from), fromY = from.y + from.height / 2;
  for (const key of keys) await page.keyboard.down(key);
  try {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(fromX + 15, fromY, { steps: 5 });
    await page.mouse.move(grab(to), to.y + to.height / 2, { steps: 15 });
    await page.mouse.up();
  } finally { for (const key of [...keys].reverse()) await page.keyboard.up(key); }
}

/** Which pane element contains DOM focus (-1 for none). */
const focusedPaneIndex = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll(".explorer-pane")].findIndex((pane) => pane.contains(document.activeElement)));

async function navigatePane(page: Page, index: number, path: string): Promise<void> {
  await page.evaluate(async ({ index, path }) => {
    // @ts-expect-error Vite serves source modules for browser tests.
    const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await manager.getExplorer(manager.activePaneIds[index]).navigateTo(path);
  }, { index, path });
}

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
      await navigatePane(page, 0, "/home/user");
      const documents = file(page, 0, "/home/user/Documents");
      await expect(documents).toBeVisible();
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await dragBetween(page, file(page, 1, beach), documents, ["Control"]);
      await expect(page.locator(".toast").first()).toContainText("Copied 1 item to Documents");
      await documents.dblclick();
      await expect(file(page, 0, "/home/user/Documents/beach.jpg")).toBeVisible();
      await expect(file(page, 1, beach)).toBeVisible();
    });

    test("dragging a multi-selection built in the other pane moves every file, and keys follow the focused pane", async ({ page }) => {
      await navigatePane(page, 0, "/home/user");
      const documents = file(page, 0, "/home/user/Documents");
      await expect(documents).toBeVisible();
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await file(page, 1, sunset).click({ modifiers: ["Control"] });
      await expect(pane(page, 0)).toHaveClass(isActive);
      await dragBetween(page, file(page, 1, beach), documents);
      await expect(page.locator(".toast").first()).toContainText("Moved 2 items to Documents");
      await expect(file(page, 1, beach)).toHaveCount(0);
      await expect(file(page, 1, sunset)).toHaveCount(0);
      await expect(pane(page, 1).locator(".entry-item")).toHaveCount(1);
      await navigatePane(page, 0, "/home/user/Documents");
      await expect(file(page, 0, "/home/user/Documents/beach.jpg")).toBeVisible();
      await expect(file(page, 0, "/home/user/Documents/sunset.png")).toBeVisible();
      // Keys go to whichever pane is active after the drag and nowhere else; which
      // pane that is depends on the engine's drag path (HTML5 dragstart activates
      // the source pane, pointer drag does not), so the product must not rely on it.
      // (The moved files' focused row is gone, so DOM focus has nothing to land on.)
      const active = (await pane(page, 1).getAttribute("class"))?.match(isActive) ? 1 : 0;
      const before = await pane(page, 1 - active).locator('.entry-item[aria-selected="true"]').count();
      await page.keyboard.press("Control+a");
      await expect(pane(page, active).locator('.entry-item[aria-selected="true"]'))
        .toHaveCount(await pane(page, active).locator(".entry-item").count());
      expect(await pane(page, 1 - active).locator('.entry-item[aria-selected="true"]').count()).toBe(before);
    });

    test("stale DOM focus left in another pane is never restored, so that pane does not become active", async ({ page }) => {
      await file(page, 1, beach).click();
      await expect(pane(page, 1)).toHaveClass(isActive);
      // Keyboard pane switch: pane A becomes active while DOM focus stays on beach.
      await page.keyboard.press("Alt+ArrowRight");
      await expect(pane(page, 0)).toHaveClass(isActive);
      await file(page, 1, sunset).click({ modifiers: ["Control"] });
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "true");
      await expect(pane(page, 0)).toHaveClass(isActive);
      await expect(pane(page, 1)).not.toHaveClass(isActive);
      expect(await focusedPaneIndex(page)).toBe(0);
      // Commands target the active pane's own selection.
      await page.keyboard.press("Delete");
      const dialog = page.getByRole("alertdialog", { name: "Delete 2 items?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("photo1.jpg");
      await expect(dialog).toContainText("photo2.jpg");
      await expect(dialog).not.toContainText("beach");
      await expect(dialog).not.toContainText("sunset");
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    });

    test("restores focus to the focused pane when the previous focus owner was document.body", async ({ page }) => {
      // Clicking inert status text leaves nothing focused while pane A stays active.
      await page.locator(".status-bar .status-item").first().click();
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await file(page, 1, beach).click({ modifiers: ["Control"] });
      await expect(file(page, 1, beach)).toHaveAttribute("aria-selected", "true");
      await expect(pane(page, 0)).toHaveClass(isActive);
      expect(await focusedPaneIndex(page)).toBe(0);
      // Keyboard input reaches the focused pane and leaves the other alone.
      await page.keyboard.press("Control+a");
      await expect(pane(page, 0).locator('.entry-item[aria-selected="true"]')).toHaveCount(4);
      await expect(file(page, 1, sunset)).toHaveAttribute("aria-selected", "false");
    });
  });
}

test.describe("Cross-pane selection in a plugin file view (SDK file tiles)", () => {
  const viewId = "e2e-cross-pane-tiles";

  test.beforeEach(async ({ page }) => {
    await page.goto(`/?path=${pictures}`);
    await expect(file(page, 0, photo1)).toBeVisible();
    await page.keyboard.press("Control+\\");
    await expect(pane(page, 1)).toBeVisible();
    await page.evaluate(async (viewId) => {
      // @ts-expect-error Vite serves source modules for browser tests.
      const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
      // @ts-expect-error Vite serves source modules for browser tests.
      const { fileViewRegistry } = await import("/src/lib/plugins/file-view-registry.svelte.ts");
      // @ts-expect-error Vite serves source modules for browser tests.
      const { exposePluginSDK } = await import("/src/lib/plugins/runtime-sdk.ts");
      exposePluginSDK();
      const sdk = (window as any).__TAURI_EXPLORER_PLUGIN_SDK__;
      const { mount } = sdk.modules["svelte"];
      const FileTiles = sdk.modules["ui/file-tiles"].default;
      // A precompiled plugin view: a component function that mounts the SDK
      // tiles and forwards click modifiers to pane.select, as plugins do.
      const component = (anchor: Comment, props: { pane: any }) => {
        const host = document.createElement("div");
        anchor.parentNode!.insertBefore(host, anchor);
        mount(FileTiles, { target: host, props: {
          get entries() { return props.pane.entries; },
          get selected() { return new Set(props.pane.selection.map((entry: { path: string }) => entry.path)); },
          label: "E2E tiles",
          onselect: (entry: unknown, event: MouseEvent) =>
            props.pane.select(entry, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey }),
          onopen: (entry: unknown) => props.pane.open(entry),
          onmenu: (entry: unknown, event: MouseEvent) => props.pane.contextMenu(event, entry),
        } });
      };
      fileViewRegistry.register("e2e-plugin", { id: viewId, title: "E2E tiles", component });
      const ids = manager.activePaneIds;
      await manager.getExplorer(ids[1]).navigateTo("/home/user/Pictures/vacation");
      manager.getExplorer(ids[1]).clearSelection();
      manager.setPaneFileView(ids[1], viewId);
    }, viewId);
    await expect(pane(page, 1).locator(`.file-tiles-grid [data-entry-path="${beach}"]`)).toBeVisible();
    await file(page, 0, photo2).click();
    await file(page, 0, photo1).click({ modifiers: ["Control"] });
    await expect(pane(page, 0)).toHaveClass(isActive);
  });

  const tile = (page: Page, path: string) => pane(page, 1).locator(`.file-tiles-grid [data-entry-path="${path}"]`);

  test("Ctrl-click in the plugin view toggles its selection without taking focus", async ({ page }) => {
    const originalFocus = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.path);
    await tile(page, sunset).click({ modifiers: ["Control"] });
    await tile(page, beach).click({ modifiers: ["Control"] });
    await expect(tile(page, beach)).toHaveAttribute("aria-selected", "true");
    await expect(tile(page, sunset)).toHaveAttribute("aria-selected", "true");
    await expect(pane(page, 0)).toHaveClass(isActive);
    expect(await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.path)).toBe(originalFocus);
    expect(await combinedPaths(page)).toEqual([photo1, photo2, beach, sunset]);
    await tile(page, beach).click({ modifiers: ["Control"] });
    await expect(tile(page, beach)).toHaveAttribute("aria-selected", "false");
    expect(await combinedPaths(page)).toEqual([photo1, photo2, sunset]);
    // Keys still go to the focused pane.
    await page.keyboard.press("Control+a");
    await expect(pane(page, 0).locator('.entry-item[aria-selected="true"]')).toHaveCount(4);
    await expect(tile(page, sunset)).toHaveAttribute("aria-selected", "true");
    await expect(tile(page, beach)).toHaveAttribute("aria-selected", "false");
  });

  test("a plain click in the plugin view focuses its pane, DOM focus included", async ({ page }) => {
    await tile(page, sunset).click();
    await expect(pane(page, 1)).toHaveClass(isActive);
    await expect(tile(page, sunset)).toHaveAttribute("aria-selected", "true");
    expect(await focusedPaneIndex(page)).toBe(1);
    expect(await combinedPaths(page)).toEqual([sunset, photo1, photo2]);
  });
});

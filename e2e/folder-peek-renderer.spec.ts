import { expect, test } from "./fixtures";
import { HOME_URL, waitForEntries, switchViewMode, focusBeforeFileList } from "./helpers";

for (const action of ["cancel", "focus"] as const) {
  test(`pending Details renderer preserves inline creation ${action} ownership`, async ({ page }) => {
    let requested = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/src\/lib\/components\/DetailsView\.svelte(?:\?|$)/, async route => {
      requested = true; await pending; await route.continue();
    });
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
    await expect.poll(() => requested).toBe(true);
    const ids = await page.evaluate(async action => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      const explorer = windowTabsManager.getActiveExplorer()!;
      const owner = windowTabsManager.activePaneId;
      explorer.startInlineNewFolder();
      if (action === "cancel") explorer.escapeSelectionOrPeek();
      else {
        windowTabsManager.splitPane("right");
        windowTabsManager.getActiveExplorer()!.setViewMode("list");
      }
      return { owner, active: windowTabsManager.activePaneId };
    }, action);
    release();
    const owner = page.locator(`.pane-tree:not(.retained) .explorer-pane[data-pane-id="${ids.owner}"]`);
    await expect(owner.locator(".entry-item").first()).toBeVisible();
    await expect(owner.locator(".new-folder-input")).toHaveCount(action === "cancel" ? 0 : 1);
    if (action === "focus") await expect(page.locator(".pane-tree:not(.retained) .explorer-pane.active")).toHaveAttribute("data-pane-id", ids.active);
    else await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.activePaneId)).toBe(ids.active);
  });
}

for (const mode of ["details", "list", "tiles"] as const) {
  test(`${mode} copied selection keeps its keyboard focus ring after lazy view loading`, async ({ page }) => {
    await page.goto("/?path=/folder-peek"); await waitForEntries(page);
    if (mode !== "details") await switchViewMode(page, mode);
    const entry = page.locator('.pane-tree:not(.retained) .entry-item[data-path="/folder-peek/root.txt"]');
    await entry.click(); await page.keyboard.press("ControlOrMeta+C");
    await expect(entry).toHaveClass(/in-clipboard/);
    await focusBeforeFileList(page); await page.keyboard.press("Tab");
    await expect(entry).toBeFocused();
    await expect(entry).toHaveCSS("outline-style", "solid");
    const indicator = await entry.evaluate((element, mode) => {
      const css = getComputedStyle(element);
      return { border: mode === "tiles" ? css.borderBottomColor : css.borderLeftColor, outline: css.outlineColor };
    }, mode);
    expect(indicator.border).toBe(indicator.outline);
  });
}

for (const mode of ["details", "list", "tiles"] as const) {
  test(`${mode} seeded navigation completion preserves newer toolbar focus`, async ({ page }) => {
    await page.goto(HOME_URL); await waitForEntries(page);
    await switchViewMode(page, mode);
    await page.evaluate(async () => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      const { getMockControl } = await import("/src/lib/api/mock-control.ts");
      const source = windowTabsManager.getActiveExplorer()!;
      const entries = [...source.ownDisplayEntries, { path: `${source.currentPath}/loaded.txt`, name: "loaded.txt", kind: "file" as const, size: 1, modified: "" }];
      getMockControl().directoryEntries = () => new Promise(resolve => {
        (window as unknown as { finishSeededLoad: () => void }).finishSeededLoad = () => resolve(entries);
      });
      windowTabsManager.createTab();
    });
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.waitForFunction(() => typeof (window as unknown as { finishSeededLoad?: unknown }).finishSeededLoad === "function");
    await expect(page.locator(".entry-item:visible").first()).toBeVisible();
    await focusBeforeFileList(page);
    await page.evaluate(() => document.activeElement!.setAttribute("data-focus-owner", "seeded-toolbar"));
    await page.evaluate(() => (window as unknown as { finishSeededLoad: () => void }).finishSeededLoad());
    await expect(page.locator('.pane-tree:not(.retained) .entry-item[data-path="/home/user/loaded.txt"]')).toBeVisible();
    await expect(page.locator('[data-focus-owner="seeded-toolbar"]')).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(".pane-tree:not(.retained) .file-list .entry-item:focus")).toHaveCount(1);
  });
}

for (const mode of ["details", "list", "tiles"] as const) {
  test(`${mode} submitted address returns keyboard focus to its listing`, async ({ page }) => {
    await page.goto(HOME_URL); await waitForEntries(page); await switchViewMode(page, mode);
    await page.keyboard.press("ControlOrMeta+l");
    await page.locator(".path-input").fill("/home/user/Documents");
    await page.keyboard.press("Enter");
    await expect(page.locator('.entry-item[data-path="/home/user/Documents/project"]:visible')).toBeFocused();
  });
}

// The column List (Folder Peek on) loads through the same renderer seam; a
// navigation that settles before its chunk arrives still owns focus only while
// nothing newer has claimed it.
for (const moved of [false, true] as const) {
  test(`pending column List renderer ${moved ? "keeps focus moved during its load" : "returns submitted-address focus to its listing"}`, async ({ page }) => {
    await page.goto(HOME_URL); await waitForEntries(page);
    let requested = false;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route(/\/src\/lib\/components\/ListColumnsView\.svelte(?:\?|$)/, async route => {
      requested = true; await pending; await route.continue();
    });
    await page.evaluate(async () => {
      const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
      windowTabsManager.getActiveExplorer()!.setViewMode("list");
    });
    await expect.poll(() => requested).toBe(true);
    await page.keyboard.press("ControlOrMeta+l");
    await page.locator(".path-input").fill("/home/user/Documents");
    await page.keyboard.press("Enter");
    await expect(page.locator(".status-path")).toHaveAttribute("title", "/home/user/Documents");
    await expect(page.locator(".pane-tree:not(.retained) .list-canvas")).toHaveCount(0);
    if (moved) {
      await page.getByRole("button", { name: "New tab", exact: true }).focus();
      await page.evaluate(() => document.activeElement!.setAttribute("data-focus-owner", "pending-list-toolbar"));
    }
    release();
    const project = page.locator('.pane-tree:not(.retained) .list-canvas .entry-item[data-path="/home/user/Documents/project"]');
    await expect(project).toBeVisible();
    if (moved) await expect(page.locator('[data-focus-owner="pending-list-toolbar"]')).toBeFocused();
    else await expect(project).toBeFocused();
  });
}

test("auto-enter descent cannot reclaim focus moved during its preflight listing", async ({ page }) => {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
    settingsStore.update({ autoEnterSingleSubdir: true });
    getMockControl().directoryEntries = path => path === "/descent" ? new Promise(resolve => {
      (window as unknown as { finishDescent: () => void }).finishDescent = () => resolve([{ path: "/descent/child", name: "child", kind: "directory", size: 0, modified: "" }]);
    }) : [{ path: "/descent/child/loaded.txt", name: "loaded.txt", kind: "file", size: 1, modified: "" }];
    void windowTabsManager.getActiveExplorer()!.navigateTo("/descent");
  });
  await page.waitForFunction(() => typeof (window as unknown as { finishDescent?: unknown }).finishDescent === "function");
  await page.getByRole("button", { name: "New tab", exact: true }).focus();
  await page.evaluate(() => document.activeElement!.setAttribute("data-focus-owner", "descent-toolbar"));
  await page.evaluate(() => (window as unknown as { finishDescent: () => void }).finishDescent());
  await expect(page.locator('.entry-item[data-path="/descent/child/loaded.txt"]:visible')).toBeVisible();
  await expect(page.locator('[data-focus-owner="descent-toolbar"]')).toBeFocused();
});

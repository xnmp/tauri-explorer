import { expect, test, type Page } from "./fixtures";
import { HOME_URL, MULTI_SELECT_MODIFIER, waitForEntries, runPaletteCommand } from "./helpers";
const root = "/folder-peek";
const row = (page: Page, path: string) => page.locator(`.pane-tree:not(.retained) .entry-item[data-path="${path}"]`);
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    return { selected: [...explorer.selectedPaths], expanded: [...explorer.expandedPaths], cursor: explorer.focusedEntry?.path, entries: explorer.displayEntries.map(e => e.path) };
  });
}
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
});
async function listed(page: Page, directory: string) {
  return page.evaluate(async target => {
    const { fetchDirectory } = await import("/src/lib/api/files.ts");
    const result = await fetchDirectory(target);
    return result.ok ? result.data.entries.map(entry => entry.path) : [];
  }, directory);
}
async function bulkRename(page: Page, find: string, replace: string) {
  await runPaletteCommand(page, "Bulk Rename");
  const dialog = page.locator(".dialog", { hasText: "Bulk Rename" });
  await dialog.locator('input[placeholder="Text to find..."]').fill(find);
  await dialog.locator('input[placeholder="Replacement..."]').fill(replace);
  await dialog.locator(".btn-primary").click();
  await expect(dialog).toHaveCount(0);
}
async function expand(page: Page, name = "Alpha", parent = root) {
  await row(page, `${parent}/${name}`).getByRole("button", { name: `Expand ${name}`, exact: true }).click();
}

test("dropping into a nested peek moves the file and refreshes both owners", async ({ page }) => {
  await expand(page); await expand(page, "Nested", `${root}/Alpha`);
  const source = row(page, `${root}/root.txt`);
  const destination = row(page, `${root}/Alpha/Nested`);
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  await source.dragTo(destination);
  await expect(page.locator(".toast").filter({ hasText: /Moved/ })).toHaveCount(1);
  await expect(source).toHaveCount(0);
  const moved = await page.evaluate(async target => {
    const { fetchDirectory } = await import("/src/lib/api/files.ts");
    const result = await fetchDirectory(target);
    return result.ok ? result.data.entries.map(entry => entry.path) : [];
  }, `${root}/Alpha/Nested`);
  expect(moved).toContain(`${root}/Alpha/Nested/root.txt`);
  // Rust publishes a settled mutation event for every affected directory.
  // The browser mock has no native event source; replay that notification.
  await page.evaluate(async path => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    windowTabsManager.getActiveExplorer()!.directoryChanged({ path, origin: "mutation" });
  }, `${root}/Alpha/Nested`);
  await expect(row(page, `${root}/Alpha/Nested/root.txt`)).toBeVisible();
});

test("cross-level ranges, Ctrl+A, collapse pruning and two-step Escape", async ({ page }) => {
  await expand(page);
  const child = row(page, `${root}/Alpha/same.txt`);
  await child.click();
  await row(page, `${root}/Beta`).click({ modifiers: ["Shift"] });
  expect((await snapshot(page)).selected).toEqual([`${root}/Alpha/same.txt`, `${root}/Beta`]);
  await page.keyboard.press("ControlOrMeta+A");
  expect((await snapshot(page)).selected).toHaveLength(6);
  expect((await snapshot(page)).selected.every(path => !path.includes("/Alpha/"))).toBe(true);
  await child.click();
  await page.keyboard.press("Escape");
  expect((await snapshot(page)).selected).toEqual([]);
  await expect(child).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(child).toHaveCount(0);
  expect((await snapshot(page)).cursor).toBe(`${root}/Alpha`);
  expect((await snapshot(page)).selected).toEqual([]);
  await expand(page); await child.click();
  await row(page, `${root}/Alpha`).getByRole("button", { name: "Collapse Alpha", exact: true }).click();
  expect((await snapshot(page)).selected).toEqual([]);
  expect((await snapshot(page)).cursor).toBe(`${root}/Alpha`);
});

test("palette toggle, child open/rename/delete/copy, preview and status use full paths", async ({ page }) => {
  await row(page, `${root}/Alpha`).click();
  await runPaletteCommand(page, "Peek into Folder");
  const child = row(page, `${root}/Alpha/same.txt`);
  await expect(child).toBeVisible(); await child.click();
  await expect(page.locator(".status-bar .selected-info")).toContainText("12 bytes");
  await page.evaluate(async () => {
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
    settingsStore.update({ showPreviewPane: true });
  });
  await expect(page.locator(".preview-pane")).toContainText("Peek preview content");
  await child.dblclick();
  await expect.poll(() => page.evaluate(async () => (await import("/src/lib/state/recent-files.svelte.ts")).recentFilesStore.list[0]?.path)).toBe(`${root}/Alpha/same.txt`);
  await page.keyboard.press("ControlOrMeta+C");
  await expect(child).toHaveClass(/in-clipboard/);
  await page.keyboard.press("F2");
  await page.locator(".rename-input").fill("renamed.txt"); await page.keyboard.press("Enter");
  const renamed = row(page, `${root}/Alpha/renamed.txt`);
  await expect(renamed).toBeVisible(); await expect(child).toHaveCount(0);
  await renamed.click();
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const explorer = windowTabsManager.getActiveExplorer()!;
    await explorer.confirmDelete(explorer.getSelectedEntries(), true);
  });
  await expect(renamed).toHaveCount(0);
  await runPaletteCommand(page, "Collapse All Peeks");
  expect((await snapshot(page)).expanded).toEqual([]);
});

test("delayed, empty and error rows do not enter selection, and 10k children virtualize", async ({ page }) => {
  await page.evaluate(async () => {
    const { getMockControl } = await import("/src/lib/api/mock-control.ts");
    getMockControl().latency = { list_directory_fresh: 450 };
  });
  await expand(page, "Empty");
  await expect(page.locator(".peek-state")).toHaveText("Loading…");
  await expect(page.locator(".peek-state")).toHaveText("Empty folder");
  await expand(page, "Error");
  await expect(page.locator(".peek-state").filter({ hasText: "Can't open folder: Permission denied" })).toBeVisible();
  await expand(page, "Large");
  await expect.poll(async () => (await snapshot(page)).entries.length).toBe(10_006);
  expect(await page.locator(".entry-item").count()).toBeLessThan(100);
  await row(page, `${root}/Large`).click(); await page.keyboard.press("ControlOrMeta+End");
  await expect(row(page, `${root}/root.txt`)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, `${root}/Large/item-09999.txt`)).toBeFocused();
});

test("a caret click keeps focus and selection, so arrows continue from the cursor row", async ({ page }) => {
  const parent = row(page, `${root}/Alpha`); await parent.click();
  await expect(parent).toBeFocused();
  await parent.getByRole("button", { name: "Expand Alpha", exact: true }).click();
  await expect(row(page, `${root}/Alpha/Nested`)).toBeVisible();
  // The caret is a pointer affordance: the row keeps DOM focus.
  await expect(parent).toBeFocused();
  expect((await snapshot(page)).selected).toEqual([`${root}/Alpha`]);
  await page.keyboard.press("ArrowDown");
  await expect(row(page, `${root}/Alpha/Nested`)).toBeFocused();
  expect((await snapshot(page)).cursor).toBe(`${root}/Alpha/Nested`);
  // Typeahead belongs to the focused row grid, scoped to the root level.
  await page.keyboard.type("be");
  await expect(row(page, `${root}/Beta`)).toBeFocused();
});

test("Tab and Shift+Tab never stop on a caret", async ({ page }) => {
  await expand(page);
  const parent = row(page, `${root}/Alpha`); await parent.click();
  const onCaret = () => page.evaluate(() => !!document.activeElement?.closest(".peek-caret"));
  const stops: boolean[] = [];
  for (const key of ["Tab", "Shift+Tab", "Shift+Tab", "Tab", "Tab"]) {
    await page.keyboard.press(key); stops.push(await onCaret());
  }
  await parent.click();
  await page.keyboard.press("Shift+Tab"); stops.push(await onCaret());
  expect(stops).not.toContain(true);
  expect(await page.locator(".pane-tree:not(.retained) .peek-caret").evaluateAll(carets => carets.map(caret => (caret as HTMLElement).tabIndex))).not.toContain(0);
});

test("rename of an expanded folder prunes its old subtree and reopening uses renamed listings", async ({ page }) => {
  await expand(page); await expand(page, "Nested", `${root}/Alpha`);
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  await row(page, `${root}/Alpha`).click(); await page.keyboard.press("F2");
  await page.locator(".rename-input").fill("Renamed"); await page.keyboard.press("Enter");
  await expect(row(page, `${root}/Renamed`)).toBeVisible();
  expect((await snapshot(page)).expanded).toEqual([]);
  await expand(page, "Renamed");
  await expect(row(page, `${root}/Renamed/Nested`)).toBeVisible();
});

test("a drag started on a covered child shows its reduced folder primary", async ({ page }) => {
  await expand(page); const child = row(page, `${root}/Alpha/same.txt`); await expect(child).toBeVisible();
  await page.evaluate(async paths => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    windowTabsManager.getActiveExplorer()!.selectPaths(paths);
  }, [`${root}/Alpha`, `${root}/Alpha/same.txt`]);
  const drag = await child.evaluate(async element => {
    const { dragState } = await import("/src/lib/state/drag.svelte.ts");
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    const label = document.querySelector(".pointer-drag-ghost")?.textContent;
    const data = dragState.current;
    const dragged = { label, primary: data?.path, paths: data?.paths ?? (data ? [data.path] : []) };
    element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return dragged;
  });
  // The covered child reduces into its selected folder: one operation root.
  expect(drag).toEqual({ label: "Alpha", primary: `${root}/Alpha`, paths: [`${root}/Alpha`] });
});

test("expansions survive DOM retention eviction and remain independent in a split pane", async ({ page }) => {
  await expand(page); await expand(page, "Nested", `${root}/Alpha`);
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const original = windowTabsManager.activeTabId!;
    for (let i = 0; i < 14; i++) windowTabsManager.createTab(i % 2 ? "/home/user/Documents" : "/home/user/Downloads");
    windowTabsManager.setActiveTab(original);
  });
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  const leftId = await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const left = windowTabsManager.activePaneId; windowTabsManager.splitPane("right"); return left;
  });
  const right = page.locator('.pane-tree:not(.retained) .explorer-pane.active');
  await expect(right.locator(`.entry-item[data-path="${root}/Alpha"]`)).toBeVisible();
  await expect(right.locator(`.entry-item[data-path="${root}/Alpha/same.txt"]`)).toHaveCount(0);
  await page.evaluate(async id => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts"); windowTabsManager.setActivePane(id);
  }, leftId);
  await expect(page.locator(`.explorer-pane[data-pane-id="${leftId}"]`)).toHaveClass(/active/);
  await expect(page.locator(`.explorer-pane[data-pane-id="${leftId}"] .entry-item[data-path="${root}/Alpha/Nested/deep.txt"]`)).toBeVisible();
});

test("root filtering retains child names, typeahead stays at root, and virtual providers have no peeks", async ({ page }) => {
  await expand(page);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts"); windowTabsManager.getActiveExplorer()!.setFilter("Alpha");
  });
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await row(page, `${root}/Alpha`).click(); await page.keyboard.type("same");
  expect((await snapshot(page)).selected).toEqual([`${root}/Alpha`]);
  await page.evaluate(async () => {
    const { registerFsProvider } = await import("/src/lib/plugins/fs-providers.ts");
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    registerFsProvider("peek", { list: async path => ({ path, entries: [{ path: "peek://root/folder", name: "folder", kind: "directory", size: 0, modified: "" }] }) });
    await windowTabsManager.getActiveExplorer()!.navigateTo("peek://root", { autoEnterSingleSubdir: false });
  });
  await expect(row(page, "peek://root/folder")).toBeVisible(); await expect(page.locator(".peek-caret")).toHaveCount(0);
  await page.evaluate(async () => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    await windowTabsManager.getActiveExplorer()!.navigateTo("trash://", { autoEnterSingleSubdir: false });
  });
  await expect(page.locator(".peek-caret")).toHaveCount(0);
});

test("marquee ranges skip multiple status rows at fractional zoom", async ({ page }) => {
  await expand(page); await expand(page, "Empty"); await expand(page, "Error");
  await expect(page.locator(".peek-state")).toHaveCount(2);
  await page.evaluate(async () => {
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts"); settingsStore.update({ zoomLevel: 130 });
  });
  await expect(page.locator("html")).toHaveCSS("zoom", "1.3");
  const content = await page.locator('.pane-tree:not(.retained) .file-list .content').boundingBox();
  const child = await row(page, `${root}/Alpha/same.txt`).boundingBox();
  expect(content).not.toBeNull(); expect(child).not.toBeNull();
  await page.mouse.move(content!.x + content!.width - 40, content!.y + content!.height - 20);
  await page.mouse.down();
  await page.mouse.move(content!.x + 30, child!.y + 1, { steps: 8 });
  await page.mouse.up();
  expect((await snapshot(page)).selected.sort()).toEqual([`${root}/Alpha/same.txt`, `${root}/Beta`, `${root}/Empty`, `${root}/Error`, `${root}/Large`, `${root}/root.txt`].sort());
});

test("bulk rename of a folder and its peeked child renames the child before the folder", async ({ page }) => {
  await expand(page);
  await row(page, `${root}/Alpha`).click();
  await row(page, `${root}/Alpha/same.txt`).click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await bulkRename(page, "a", "4");
  expect(await listed(page, root)).toContain(`${root}/4lph4`);
  expect(await listed(page, `${root}/4lph4`)).toContain(`${root}/4lph4/s4me.txt`);
});

test("bulk rename allows one new name in two peeked folders", async ({ page }) => {
  await expand(page); await expand(page, "Beta");
  await row(page, `${root}/Alpha/same.txt`).click();
  await row(page, `${root}/Beta/same.txt`).click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await bulkRename(page, "same", "other");
  expect(await listed(page, `${root}/Alpha`)).toContain(`${root}/Alpha/other.txt`);
  expect(await listed(page, `${root}/Beta`)).toContain(`${root}/Beta/other.txt`);
});

test("compressing same-named children of two peeks is refused before any archive is written", async ({ page }) => {
  await expand(page); await expand(page, "Beta");
  await row(page, `${root}/Alpha/same.txt`).click();
  await row(page, `${root}/Beta/same.txt`).click({ modifiers: [MULTI_SELECT_MODIFIER] });
  await row(page, `${root}/Beta/same.txt`).click({ button: "right" });
  await page.locator(".menu-item", { hasText: "Compress to ZIP" }).click();
  await expect(page.locator(".toast").filter({ hasText: "Selected items have the same name" })).toHaveCount(1);
  expect((await listed(page, `${root}/Alpha`)).filter(path => path.endsWith(".zip"))).toEqual([]);
});

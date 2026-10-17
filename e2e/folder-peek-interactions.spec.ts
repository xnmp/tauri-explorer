import { expect, test, type Page } from "@playwright/test";
import { HOME_URL, waitForEntries, runPaletteCommand } from "./helpers";
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

test("caret keyboard activation keeps selection and ignores typeahead", async ({ page }) => {
  const parent = row(page, `${root}/Alpha`); await parent.click();
  const caret = parent.getByRole("button", { name: "Expand Alpha", exact: true });
  await caret.focus(); await page.keyboard.press("Space");
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  expect((await snapshot(page)).selected).toEqual([`${root}/Alpha`]);
  await page.keyboard.press("Enter");
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  expect((await snapshot(page)).selected).toEqual([`${root}/Alpha`]);
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
  const label = await child.evaluate(element => {
    const dataTransfer = new DataTransfer();
    element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
    const label = document.querySelector(".pointer-drag-ghost")?.textContent;
    element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer }));
    return label;
  });
  expect(label).toBe("Alpha");
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

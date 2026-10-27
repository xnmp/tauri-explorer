import { test, expect, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";
import { waitForEntries } from "./helpers";

const dialog = (page: Page) => page.getByRole("dialog", { name: "Pane test dialog", exact: true });
const draft = (page: Page) => page.getByLabel("Dialog draft", { exact: true });
const pane = (page: Page, index: number) => page.locator(".explorer-pane").nth(index);

async function install(page: Page, direction: "right" | "down" = "right") {
  await page.evaluate(async direction => {
    // @ts-expect-error Vite serves test source modules.
    const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
    // @ts-expect-error Vite serves test source modules.
    const { createPluginContext } = await import("/src/lib/plugins/api.ts");
    // @ts-expect-error Vite serves test source modules.
    const component = (await import("/src/test-support/modal/PaneTestDialog.svelte")).default;
    manager.splitPane(direction);
    const context = createPluginContext("pane-dialog-test");
    context.ctx.registerDialog({ id: "test.pane", component });
    const [a, b] = manager.activePaneIds;
    const owner = context.ctx.workspace.capturePane(a);
    Object.assign(window, { __paneDialogTest: { ...context, a, b, owner, tab: manager.activeTabId } });
    context.ctx.openDialog("test.pane", {}, { scope: "pane", pane: owner });
  }, direction);
  await expect(dialog(page)).toBeVisible();
  await expect(draft(page)).toBeFocused();
  await expect(dialog(page)).not.toHaveAttribute("aria-modal", "true");
}

async function assertBounds(page: Page) {
  await expect.poll(async () => {
    const owner = await pane(page, 0).boundingBox();
    const overlay = await dialog(page).boundingBox();
    if (!owner || !overlay) return Infinity;
    // Positioned inset:0 follows the pane's padding box, inside its 1px border.
    return Math.max(Math.abs(owner.x + 1 - overlay.x), Math.abs(owner.y + 1 - overlay.y),
      Math.abs(owner.width - 2 - overlay.width), Math.abs(owner.height - 2 - overlay.height));
  }).toBeLessThan(1);
}

async function tabAway(page: Page) {
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves test source modules.
    const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
    manager.createTab("/home/user");
  });
  await expect(dialog(page)).toBeHidden();
}

async function tabBack(page: Page) {
  await page.evaluate(async () => {
    // @ts-expect-error Vite serves test source modules.
    const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
    manager.setActiveTab((window as any).__paneDialogTest.tab);
  });
  await expect(dialog(page)).toBeVisible();
}

const modes = process.env.ALL_VIEW_MODES ? ["details", "list", "tiles"] : ["list"];
for (const retirement of ["dialog", "pane"] as const) {
  test(`a pane caller's window child settles when its ${retirement} closes`, async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page); await install(page);
    await page.evaluate(async () => {
      const t = (window as any).__paneDialogTest;
      // @ts-expect-error Vite serves test source modules.
      const component = (await import("/src/test-support/modal/PaneTestDialog.svelte")).default;
      t.ctx.registerDialog({ id: "test.window-child", component });
      t.result = undefined;
      void t.ctx.presentation.openDialog("test.window-child").then((result: unknown) => { t.result = result; });
    });
    await expect(page.locator('.modal-overlay[aria-modal="true"]')).toBeVisible();
    await page.evaluate(async retirement => {
      const t = (window as any).__paneDialogTest;
      // @ts-expect-error Vite serves test source modules.
      const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
      if (retirement === "pane") manager.closePane(t.a);
      else t.ctx.closeDialog("test.pane");
    }, retirement);
    await expect.poll(() => page.evaluate(() => (window as any).__paneDialogTest.result)).toEqual({ reason: "caller-closed" });
    await expect(page.locator('.modal-overlay[aria-modal="true"]')).toHaveCount(0);
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
  });
}
for (const mode of modes) {
  test.describe(`pane dialogs (${mode})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/?path=/home/user/Pictures&viewMode=${mode}`);
      await waitForEntries(page);
    });

    test("empty pane dialog slots have no box before opening and after closing", async ({ page }) => {
      const emptySlotSizes = () => page.locator(".pane-dialog-slot:empty").evaluateAll(slots =>
        slots.map(slot => {
          const { width, height } = slot.getBoundingClientRect();
          return { width, height };
        }));
      await expect.poll(emptySlotSizes).toEqual([{ width: 0, height: 0 }]);
      await install(page);
      await assertBounds(page);
      await expect.poll(emptySlotSizes).toEqual([{ width: 0, height: 0 }]);
      await page.getByRole("button", { name: "Close test dialog" }).click();
      await expect(dialog(page)).toHaveCount(0);
      await expect.poll(emptySlotSizes).toEqual([{ width: 0, height: 0 }, { width: 0, height: 0 }]);
    });

    test("pane B navigation, selection and Escape preserve pane A's draft", async ({ page }) => {
      await install(page);
      await draft(page).fill("Keep this image prompt");
      const b = pane(page, 1);
      await b.locator('.entry-item[data-path="/home/user/Pictures/vacation"]').dblclick();
      const beach = b.locator('.entry-item[data-path="/home/user/Pictures/vacation/beach.jpg"]');
      await beach.click();
      await expect(beach).toHaveClass(/selected/);
      await expect(b).toHaveClass(/active/);
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toBeVisible();
      await expect(draft(page)).toHaveValue("Keep this image prompt");
      // Uncovered B retains its normal Escape/Clear Selection behavior.
      await expect(beach).not.toHaveClass(/selected/);
      // A's covered navigation and listing, unlike B's, are inert.
      await expect(pane(page, 0).locator(".pane-base-content")).toHaveAttribute("inert", "");
      await expect(b.locator(".pane-base-content")).not.toHaveAttribute("inert", "");
    });

    test("hoisted Miller columns cannot navigate their covered owner", async ({ page }) => {
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
        // @ts-expect-error Vite serves test source modules.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        settingsStore.update({ layoutTheme: "floating-islands", showSidebar: false });
        manager.getActiveExplorer().setMillerLayers(2);
      });
      await install(page);
      const columns = page.locator(".miller-island .miller-columns");
      await expect(columns).toHaveAttribute("inert", "");
      const before = await pane(page, 0).locator(".content").getAttribute("data-current-path");
      const entry = columns.locator('.col-entry[data-kind="directory"]').first();
      const bounds = await entry.boundingBox();
      if (!bounds) throw new Error("Hoisted Miller entry is missing");
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await expect(pane(page, 0).locator(".content")).toHaveAttribute("data-current-path", before!);
      await expect(dialog(page)).toBeVisible();
      await page.getByRole("button", { name: "Close test dialog" }).click();
      await expect(columns).not.toHaveAttribute("inert", "");
      await entry.click();
      await expect(pane(page, 0).locator(".content")).not.toHaveAttribute("data-current-path", before!);
    });

    test("covered pane preview cannot obscure the dialog and Escape closes the visible surface", async ({ page }) => {
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
        settingsStore.update({ showPreviewPane: true });
      });
      await pane(page, 0).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      const image = page.locator(".preview-image");
      await expect(image).toBeVisible();
      await install(page);
      await image.click();
      await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await image.click();
      await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
      await page.keyboard.press("Escape");
      await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
    });

    test("opening a pane dialog exits an already active preview fullscreen", async ({ page }) => {
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
        settingsStore.update({ showPreviewPane: true });
      });
      await pane(page, 0).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      await page.locator(".preview-image").click();
      await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
      await install(page);
      await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
      await expect(dialog(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    });

    test("pane navigation works from the editor and returns focus to its dialog", async ({ page }) => {
      await install(page);
      await draft(page).fill("Submit locally");
      await page.keyboard.press("Control+Enter");
      await expect(page.getByLabel("Submitted draft")).toHaveText("Submit locally");
      await page.keyboard.press("Alt+ArrowRight");
      await expect(pane(page, 1)).toHaveClass(/active/);
      await expect.poll(() => pane(page, 1).evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect(pane(page, 1).locator(".entry-item.selected")).toHaveCount(1);
      // Returning via a pane command restores the remembered draft control.
      await page.keyboard.press("Alt+l");
      await expect(pane(page, 0)).toHaveClass(/active/);
      await expect(draft(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
    });

    test("Tab leaves the pane dialog and closing it does not steal pane B's focus", async ({ page }) => {
      await install(page);
      await page.getByRole("button", { name: "Close test dialog" }).focus();
      await page.keyboard.press("Tab");
      await expect.poll(() => dialog(page).evaluate(el => el.contains(document.activeElement))).toBe(false);
      const photo = pane(page, 1).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]');
      await photo.click();
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-path"));
      await page.evaluate(() => (window as any).__paneDialogTest.ctx.closeDialog("test.pane"));
      await expect(dialog(page)).toHaveCount(0);
      await expect(pane(page, 1)).toHaveClass(/active/);
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-path"))).toBe(focused);
    });

    test("tab parking keeps the same component, open prop and draft", async ({ page }) => {
      await install(page);
      await draft(page).fill("Parked draft");
      const instance = await page.getByLabel("Dialog instance").textContent();
      await tabAway(page);
      await expect(page.locator(".pane-dialog-container")).toHaveAttribute("inert", "");
      await tabBack(page);
      await expect(draft(page)).toHaveValue("Parked draft");
      await expect(page.getByLabel("Dialog instance")).toHaveText(instance!);
      await expect(page.getByLabel("Dialog openings")).toHaveText("1");
      // Tab commands are permitted from editable dialog controls as well.
      await draft(page).focus(); await page.keyboard.press("Control+Tab");
      await expect(dialog(page)).toBeHidden();
      await page.keyboard.press("Control+Shift+Tab");
      await expect(draft(page)).toHaveValue("Parked draft");
    });

    test("reopening from pane B restores the existing owner without replacing its draft", async ({ page }) => {
      await install(page); await draft(page).fill("Original prompt");
      await pane(page, 1).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      await page.evaluate(() => {
        const t = (window as any).__paneDialogTest;
        t.ctx.openDialog("test.pane", { initialDraft: "Replacement" }, { scope: "pane", pane: t.ctx.workspace.capturePane(t.b) });
      });
      await expect(pane(page, 0)).toHaveClass(/active/);
      await expect(draft(page)).toHaveValue("Original prompt");
      await expect(page.getByLabel("Dialog openings")).toHaveText("1");
    });

    test("closing a captured A opening does not restore the earlier B control", async ({ page }) => {
      await install(page);
      await page.evaluate(() => (window as any).__paneDialogTest.ctx.closeDialog("test.pane"));
      await expect(dialog(page)).toHaveCount(0);
      await pane(page, 1).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      await page.evaluate(() => {
        const t = (window as any).__paneDialogTest;
        t.ctx.openDialog("test.pane", {}, { scope: "pane", pane: t.owner });
      });
      await expect(draft(page)).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(dialog(page)).toHaveCount(0);
      await expect(pane(page, 0)).toHaveClass(/active/);
      await expect.poll(() => pane(page, 0).evaluate(el => el.contains(document.activeElement))).toBe(true);
    });

    test("closing the owner pane retires its dialog even while busy", async ({ page }) => {
      await install(page); await page.getByLabel("Busy dialog").check();
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        manager.closePane((window as any).__paneDialogTest.a);
      });
      await expect(dialog(page)).toHaveCount(0);
      await pane(page, 0).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      await expect(pane(page, 0).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]')).toHaveClass(/selected/);
    });

    test("remounting the surviving owner pane keeps its dialog visible and editable", async ({ page }) => {
      await install(page); await draft(page).fill("Survives layout remount");
      const instance = await page.getByLabel("Dialog instance").textContent();
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        manager.closePane((window as any).__paneDialogTest.b);
      });
      await expect(draft(page)).toBeVisible();
      await expect(draft(page)).toHaveValue("Survives layout remount");
      await expect(page.getByLabel("Dialog instance")).toHaveText(instance!);
      await draft(page).fill("Still editable");
      await page.keyboard.press("Control+Enter");
      await expect(page.getByLabel("Submitted draft")).toHaveText("Still editable");
    });

    test("contribution teardown and owner tab closure remove the dialog", async ({ page }) => {
      await install(page);
      await page.evaluate(() => (window as any).__paneDialogTest.dispose());
      await expect(dialog(page)).toHaveCount(0);
      await pane(page, 1).locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]').click();
      await install(page);
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
        manager.createTab("/home/user"); manager.closeTab((window as any).__paneDialogTest.tab);
      });
      await expect(dialog(page)).toHaveCount(0);
    });

    test("window dialogs suspend pane dialogs and block both panes", async ({ page }) => {
      await install(page); await draft(page).fill("Suspended prompt");
      const b = pane(page, 1), photo = b.locator('.entry-item[data-path="/home/user/Pictures/photo1.jpg"]');
      await photo.click();
      // Calls without options retain window-wide modality.
      await page.evaluate(async () => {
        // @ts-expect-error Vite serves test source modules.
        const { dialogStore } = await import("/src/lib/state/dialogs.svelte.ts");
        dialogStore.openSettings();
      });
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      await expect(settings).toBeVisible();
      await expect(dialog(page)).toBeHidden();
      await expect(settings).toHaveAttribute("aria-modal", "true");
      const oldPath = await b.locator(".content").getAttribute("data-current-path");
      await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Alt+ArrowUp");
      await expect(photo).toHaveClass(/selected/);
      await expect(b.locator(".content")).toHaveAttribute("data-current-path", oldPath!);
      // A click over B lands on the window backdrop, not its file rows.
      const bounds = await photo.boundingBox();
      if (!bounds) throw new Error("Pane B file is missing");
      await page.mouse.click(bounds.x + 5, bounds.y + 5);
      await expect(photo).toHaveClass(/selected/);
      if (await settings.isVisible()) await page.keyboard.press("Escape");
      await expect(settings).toBeHidden();
      await expect(draft(page)).toHaveValue("Suspended prompt");
    });
  });
}

for (const direction of ["right", "down"] as const) {
  test(`pane overlay follows ${direction} split and window resizing`, async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page);
    await install(page, direction); await draft(page).fill("Resized draft");
    const instance = await page.getByLabel("Dialog instance").textContent();
    await assertBounds(page);
    const separator: Locator = page.getByRole("separator", { name: "Resize panes" });
    await separator.focus();
    await page.keyboard.press(direction === "right" ? "ArrowRight" : "ArrowDown");
    await page.keyboard.press(direction === "right" ? "ArrowRight" : "ArrowDown");
    await assertBounds(page);
    await page.setViewportSize({ width: 1100, height: 850 });
    await assertBounds(page);
    await expect(draft(page)).toHaveValue("Resized draft");
    await expect(page.getByLabel("Dialog instance")).toHaveText(instance!);
  });
}

for (const action of ["click", "Enter"] as const) {
  test(`sidebar ${action} blocks navigation to covered A and permits uncovered B`, async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page); await install(page);
    await draft(page).fill("Preserved pane caller");
    const shortcut = page.locator('.quick-access .bookmark-drop-target[data-path="/home/user/Downloads"]').first();
    if (action === "click") await shortcut.click();
    else { await shortcut.focus(); await shortcut.press("Enter"); }
    await expect(pane(page, 0).locator(".content")).toHaveAttribute("data-current-path", "/home/user/Pictures");
    await expect(draft(page)).toHaveValue("Preserved pane caller");
    await pane(page, 1).locator(".entry-item").first().click();
    await expect(pane(page, 1)).toHaveClass(/active/);
    if (action === "click") await shortcut.click();
    else { await shortcut.focus(); await shortcut.press("Enter"); }
    await expect(pane(page, 1).locator(".content")).toHaveAttribute("data-current-path", "/home/user/Downloads");
    await expect(pane(page, 0).locator(".content")).toHaveAttribute("data-current-path", "/home/user/Pictures");
    await expect(draft(page)).toHaveValue("Preserved pane caller");
  });
}

for (const outcome of ["path", "directory result"] as const) {
  test(`Quick Open ${outcome} blocks navigation to covered A and permits uncovered B`, async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page); await install(page);
    await draft(page).fill("Preserved pane caller");
    const quickOpen = page.locator(".quick-open-dialog");
    const go = async (focusDialog: boolean) => {
      if (focusDialog) await page.getByRole("button", { name: "Close test dialog" }).focus();
      await page.keyboard.press("Control+p");
      await expect(quickOpen).toBeVisible();
      const input = quickOpen.locator("input").first();
      if (outcome === "path") { await input.fill("/home/user/Downloads"); await input.press("Enter"); }
      else {
        await input.fill("vacation");
        const row = quickOpen.locator(".result-item", { hasText: "vacation" }).first();
        await expect(row).toBeVisible(); await row.click();
      }
      await expect(quickOpen).toBeHidden();
    };
    await go(true);
    await expect(pane(page, 0).locator(".content")).toHaveAttribute("data-current-path", "/home/user/Pictures");
    await expect(draft(page)).toHaveValue("Preserved pane caller");
    await pane(page, 1).locator(".entry-item").first().click();
    await expect(pane(page, 1)).toHaveClass(/active/);
    await go(false);
    await expect(pane(page, 1).locator(".content")).toHaveAttribute("data-current-path", outcome === "path" ? "/home/user/Downloads" : "/home/user/Pictures/vacation");
    await expect(pane(page, 0).locator(".content")).toHaveAttribute("data-current-path", "/home/user/Pictures");
    await expect(draft(page)).toHaveValue("Preserved pane caller");
  });
}

for (const retirement of ["dialog", "pane"] as const) {
  test(`pane caller's image editor closes and releases the window when its ${retirement} retires`, async ({ page }) => {
    await page.goto("/?path=/home/user/Pictures"); await waitForEntries(page); await install(page);
    await page.evaluate(async () => {
      // @ts-expect-error Vite serves test source modules.
      const component = (await import("/src/lib/components/InstalledPluginSettings.svelte")).default;
      const t = (window as any).__paneDialogTest;
      t.ctx.registerImageEditorTool({ id: "caller.editor", title: "Caller tool", component, when: () => true });
      t.editorClosed = false;
      void t.ctx.presentation.openImageEditor({ path: "/home/user/Pictures/screenshot.png", tool: "caller.editor" })
        .then(() => { t.editorClosed = true; });
    });
    const editor = page.getByRole("dialog", { name: "Caller tool", exact: true });
    await expect(editor).toBeVisible();
    await page.evaluate(async retirement => {
      const t = (window as any).__paneDialogTest;
      // @ts-expect-error Vite serves test source modules.
      const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
      if (retirement === "pane") manager.closePane(t.a);
      else t.ctx.closeDialog("test.pane");
    }, retirement);
    await expect(editor).toBeHidden();
    await expect.poll(() => page.evaluate(() => (window as any).__paneDialogTest.editorClosed)).toBe(true);
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
  });
}

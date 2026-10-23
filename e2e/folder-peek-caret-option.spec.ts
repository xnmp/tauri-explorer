import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { HOME_URL, waitForEntries, runPaletteCommand, pressShortcut } from "./helpers";

// The Show Folder Peek Carets option (#1248): with carets off, a plain click on
// a folder toggles its peek, in addition to selecting it, and Enter (not a
// double-click) navigates into it (#1298).
const root = "/folder-peek";
const pane = (page: Page) => page.locator(".pane-tree:not(.retained) .explorer-pane");
const row = (page: Page, path: string) => pane(page).locator(`.entry-item[data-path="${path}"]`);
const setting = (page: Page, patch: Record<string, boolean>) => page.evaluate(async values => {
  const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
  settingsStore.update(values);
}, patch);
const nameLeft = (page: Page, path: string) => row(page, path).evaluate(element => {
  const text = element.querySelector<HTMLElement>(".name-text")!;
  return text.getBoundingClientRect().left - element.getBoundingClientRect().left;
});

test.beforeEach(async ({ page }) => {
  await page.goto(HOME_URL); await waitForEntries(page);
  await page.evaluate(async path => {
    const { windowTabsManager } = await import("/src/lib/state/window-tabs.svelte.ts");
    const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
    settingsStore.update({ showHidden: false, folderPeek: true, folderPeekCarets: false });
    const explorer = windowTabsManager.getActiveExplorer()!; explorer.setViewMode("details");
    await explorer.navigateTo(path, { autoEnterSingleSubdir: false });
  }, root);
  await expect(row(page, `${root}/Alpha`)).toBeVisible();
});

test("a single click toggles a folder open and closed and selects it", async ({ page }) => {
  const alpha = row(page, `${root}/Alpha`);
  await alpha.click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await expect(alpha).toHaveClass(/selected/);
  await expect(alpha.locator(".entry-name")).toHaveCSS("font-weight", "600");
  await row(page, `${root}/Alpha/Nested`).click();
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  await alpha.click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toHaveCount(0);
  await expect(alpha.locator(".entry-name")).not.toHaveCSS("font-weight", "600");
});

test("a file click never expands anything", async ({ page }) => {
  await row(page, `${root}/root.txt`).click();
  await expect(row(page, `${root}/root.txt`)).toHaveClass(/selected/);
  await expect(pane(page).locator(".peek-guide")).toHaveCount(0);
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
});

const currentPath = (page: Page) => page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.currentPath);
const caretlessToast = (page: Page) => page.locator(".toast.info").filter({ hasText: "Double-click is disabled while peek carets are off" });

for (const mode of ["details", "list"] as const) {
  test(`${mode}: a hovered folder offers an Open action that navigates without toggling its peek`, async ({ page }) => {
    await page.evaluate(async mode => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.setViewMode(mode), mode);
    const alpha = row(page, `${root}/Alpha`);
    const open = alpha.getByRole("button", { name: "Open Alpha", exact: true });
    await row(page, `${root}/root.txt`).click();
    await page.mouse.move(0, 0);
    await expect(open).toHaveCSS("opacity", "0");
    await alpha.focus();
    await expect(open).toHaveCSS("opacity", "1");
    await row(page, `${root}/root.txt`).focus();
    await alpha.hover();
    await expect(open).toHaveCSS("opacity", "1");
    await expect(row(page, `${root}/root.txt`).getByRole("button", { name: /^Open / })).toHaveCount(0);
    await alpha.click();
    await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
    const nested = row(page, `${root}/Alpha/Nested`);
    await nested.hover();
    expect((await new AxeBuilder({ page }).include(".pane-tree:not(.retained) .file-list")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `screenshots/fix/peek-navigation/open-${mode}.png` });
    await nested.getByRole("button", { name: "Open Nested", exact: true }).click();
    await expect.poll(() => currentPath(page)).toBe(`${root}/Alpha/Nested`);
    await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
    await expect(caretlessToast(page)).toHaveCount(0);
    await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.goBack());
    await expect(alpha).toBeVisible();
    // The Open control did not create an expansion in the old listing.
    await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toHaveCount(0);
    await alpha.click();
    await page.keyboard.press("F2");
    await expect(alpha.locator(".rename-input")).toBeVisible();
    await expect(alpha.getByRole("button", { name: "Open Alpha", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(alpha.locator(".rename-input")).toHaveCount(0);
    await setting(page, { folderPeekCarets: true });
    await expect(alpha.getByRole("button", { name: "Open Alpha", exact: true })).toHaveCount(0);
    await setting(page, { folderPeekCarets: false, folderPeek: false });
    await expect(alpha.getByRole("button", { name: "Open Alpha", exact: true })).toHaveCount(0);
  });
}

// A double-click is two toggles here, so it must not also navigate (#1298).
test("a folder double-click stays put, leaves it closed and says Enter opens it", async ({ page }) => {
  const beta = row(page, `${root}/Beta`);
  await beta.dblclick();
  await expect(caretlessToast(page)).toHaveText("Double-click is disabled while peek carets are off. Use Enter to navigate into folders.");
  expect(await currentPath(page)).toBe(root);
  await expect(row(page, `${root}/Beta/same.txt`)).toHaveCount(0);
  await expect(beta).toHaveClass(/selected/);
  // The toast's advice works: Enter opens the selected folder.
  await page.keyboard.press("Enter");
  await expect(row(page, `${root}/Beta/same.txt`)).toBeVisible();
  expect(await currentPath(page)).toBe(`${root}/Beta`);
});

test("List refuses a folder double-click too, while a file double-click shows no notice", async ({ page }) => {
  await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.setViewMode("list"));
  await row(page, `${root}/root.txt`).dblclick();
  await expect(row(page, `${root}/root.txt`)).toHaveClass(/selected/);
  await row(page, `${root}/Beta`).dblclick();
  await expect(caretlessToast(page)).toHaveCount(1);
  expect(await currentPath(page)).toBe(root);
  await expect(row(page, `${root}/Beta/same.txt`)).toHaveCount(0);
});

test("with carets shown a folder double-click navigates and leaves it unexpanded on return", async ({ page }) => {
  await setting(page, { folderPeekCarets: true });
  await row(page, `${root}/Beta`).dblclick();
  await expect(row(page, `${root}/Beta/same.txt`)).toBeVisible();
  expect(await currentPath(page)).toBe(`${root}/Beta`);
  await expect(caretlessToast(page)).toHaveCount(0);
  await page.evaluate(async () => (await import("/src/lib/state/window-tabs.svelte.ts")).windowTabsManager.getActiveExplorer()!.goBack());
  await expect(row(page, `${root}/Beta`)).toBeVisible();
  await expect(row(page, `${root}/Beta/same.txt`)).toHaveCount(0);
  await expect(row(page, `${root}/Beta`).locator(".entry-name")).not.toHaveCSS("font-weight", "600");
});

test("Ctrl-click and Shift-click only change the selection", async ({ page }) => {
  await row(page, `${root}/root.txt`).click();
  await expect(row(page, `${root}/root.txt`)).toHaveClass(/selected/);
  await row(page, `${root}/Alpha`).click({ modifiers: ["ControlOrMeta"] });
  await expect(row(page, `${root}/Alpha`)).toHaveClass(/selected/);
  await row(page, `${root}/Beta`).click({ modifiers: ["Shift"] });
  await expect(row(page, `${root}/Beta`)).toHaveClass(/selected/);
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  await expect(row(page, `${root}/Beta/same.txt`)).toHaveCount(0);
});

test("carets off draws no caret and aligns names with the Folder Peek off layout", async ({ page }) => {
  await row(page, `${root}/Alpha`).click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await expect(pane(page).locator(".peek-caret, .peek-caret-slot")).toHaveCount(0);
  await expect(row(page, `${root}/Alpha/same.txt`).locator(".name-cell")).toHaveCSS("padding-left", "22px");
  await expect(pane(page).locator(".peek-guide").first()).toHaveCSS("width", "1.5px");
  const peeked = await nameLeft(page, `${root}/Beta`);
  await setting(page, { folderPeek: false });
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  expect(await nameLeft(page, `${root}/Beta`)).toBeCloseTo(peeked, 1);
});

test("the palette command switches between click-toggle and carets live", async ({ page }) => {
  await runPaletteCommand(page, "Toggle Folder Peek Carets");
  const caret = row(page, `${root}/Alpha`).getByRole("button", { name: "Expand Alpha", exact: true });
  await expect(caret).toHaveCount(1);
  await row(page, `${root}/Alpha`).click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  await caret.click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await runPaletteCommand(page, "Toggle Folder Peek Carets");
  await expect(pane(page).locator(".peek-caret")).toHaveCount(0);
  await row(page, `${root}/Alpha`).click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
});

test("the Settings checkbox switches modes live", async ({ page }) => {
  const settings = page.locator(".settings-dialog");
  await pressShortcut(page, ",", { ctrlKey: true });
  await expect(settings).toBeVisible();
  await settings.locator(".settings-search").fill("Folder Peek Carets");
  const checkbox = settings.locator(".folder-peek-carets-toggle");
  await expect(checkbox).not.toBeChecked();
  await checkbox.locator("xpath=..").locator(".toggle-slider").click();
  await expect(checkbox).toBeChecked();
  await settings.locator(".close-btn").click();
  await expect(settings).toBeHidden();
  await expect(row(page, `${root}/Alpha`).getByRole("button", { name: "Expand Alpha", exact: true })).toHaveCount(1);
  await row(page, `${root}/Alpha`).click();
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
});


test("repeated refused double-clicks do not renew or repeat the notice for a minute", async ({ page }) => {
  await page.clock.install();
  await row(page, `${root}/Beta`).dblclick();
  await expect(caretlessToast(page)).toBeVisible();
  await page.clock.fastForward(3100);
  await expect(caretlessToast(page)).toHaveCount(0);
  await row(page, `${root}/Beta`).dblclick();
  expect(await caretlessToast(page).count()).toBe(0);
  expect(await currentPath(page)).toBe(root);
  await page.clock.fastForward(60000);
  await row(page, `${root}/Beta`).dblclick();
  await expect(caretlessToast(page)).toBeVisible();
  await page.screenshot({ path: "screenshots/fix/peek/notice-cooldown.png" });
});

for (const mode of ["details", "list", "tiles"] as const) {
  test(`${mode}: restored tabs recover their own peeks and fresh tabs start closed`, async ({ page }) => {
    await setting(page, { folderPeekCarets: true });
    await page.evaluate(async ({ root, mode }) => {
      const { windowTabsManager: manager } = await import("/src/lib/state/window-tabs.svelte.ts");
      const { settingsStore } = await import("/src/lib/state/settings.svelte.ts");
      settingsStore.update({ viewMode: mode });
      const explorer = manager.getActiveExplorer()!;
      explorer.setViewMode(mode);
      await explorer.togglePeek(`${root}/Alpha`);
      await explorer.togglePeek(`${root}/Beta`);
      await explorer.togglePeek(`${root}/Beta`);
    }, { root, mode });
    await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
    await page.keyboard.press("Control+t");
    await expect(row(page, `${root}/Beta`)).toBeVisible();
    await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+Tab");
    await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
    await page.keyboard.press("Control+w");
    await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
    await page.keyboard.press("Control+Shift+t");
    await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
    await expect(row(page, `${root}/Beta/same.txt`)).toHaveCount(0);
    await page.screenshot({ path: `screenshots/fix/peek/restored-${mode}.png` });
  });
}

// #1359: like List (#1328), Details keeps a caretless folder's Open action at
// the row's far-right edge, clear of the name, and it still navigates.
test("details: with peek carets off the hovered Open action sits at the row's right edge and navigates", async ({ page }) => {
  const alpha = row(page, `${root}/Alpha`);
  const open = alpha.getByRole("button", { name: "Open Alpha", exact: true });
  await alpha.hover();
  await expect(open).toHaveCSS("opacity", "1");
  await expect.poll(async () => {
    const [buttonBox, rowBox] = await Promise.all([open.boundingBox(), alpha.boundingBox()]);
    return buttonBox && rowBox ? rowBox.x + rowBox.width - buttonBox.x - buttonBox.width : Number.POSITIVE_INFINITY;
  }).toBeLessThanOrEqual(12);
  await page.screenshot({ path: "evidence/issue-1359-details-open-right-edge.png" });
  await open.click();
  await expect.poll(() => currentPath(page)).toBe(`${root}/Alpha`);
});

test("details: with peek carets on there is no Open action and the caret stays beside the name", async ({ page }) => {
  await setting(page, { folderPeekCarets: true });
  const alpha = row(page, `${root}/Alpha`);
  await alpha.hover();
  await expect(alpha.locator(".peek-open")).toHaveCount(0);
  await expect(alpha.locator(".peek-caret")).toBeVisible();
});

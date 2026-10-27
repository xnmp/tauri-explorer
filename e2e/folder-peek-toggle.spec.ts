import { expect, test, type Page } from "./fixtures";
import { HOME_URL, waitForEntries, runPaletteCommand, pressShortcut } from "./helpers";

// The Folder Peek setting (#1238): off is the classic flat Details view, and
// on again restores the expansions the pane remembered meanwhile.
const root = "/folder-peek";
const pane = (page: Page) => page.locator(".pane-tree:not(.retained) .explorer-pane");
const row = (page: Page, path: string) => pane(page).locator(`.entry-item[data-path="${path}"]`);
const caret = (page: Page, name: string, state: "Expand" | "Collapse" = "Expand") =>
  row(page, `${root}/${name}`).getByRole("button", { name: `${state} ${name.split("/").at(-1)}`, exact: true });

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
  await caret(page, "Alpha").click();
  await caret(page, "Alpha/Nested").click();
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
});

/** Classic Details geometry: the name cell starts at the row's content edge
 * (selection border + 16px padding) and its first child is the icon. */
async function nameGeometry(page: Page, path: string) {
  return row(page, path).evaluate(element => {
    const style = getComputedStyle(element);
    const cell = element.querySelector<HTMLElement>(".name-cell")!;
    const icon = cell.querySelector<HTMLElement>("[data-drag-icon]")!;
    const rowLeft = element.getBoundingClientRect().left;
    return {
      contentEdge: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      padding: style.paddingLeft,
      cell: cell.getBoundingClientRect().left - rowLeft,
      cellPadding: getComputedStyle(cell).paddingLeft,
      icon: icon.getBoundingClientRect().left - rowLeft,
      rowAttributes: element.parentElement!.getAttributeNames().filter(name => name.startsWith("aria-")).sort(),
      selectionBar: getComputedStyle(element, "::after").content,
    };
  });
}

async function expectClassicDetails(page: Page) {
  await expect(row(page, `${root}/Alpha/same.txt`)).toHaveCount(0);
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toHaveCount(0);
  await expect(pane(page).locator(".peek-caret, .peek-caret-slot, .peek-guide, .peek-state")).toHaveCount(0);
  await expect(pane(page).getByRole("grid", { name: "Files" })).toBeVisible();
  await expect(pane(page).getByRole("treegrid")).toHaveCount(0);
  for (const path of [`${root}/Alpha`, `${root}/root.txt`]) {
    const geometry = await nameGeometry(page, path);
    expect(geometry.padding).toBe("16px");
    expect(geometry.cell).toBeCloseTo(geometry.contentEdge, 1);
    expect(geometry.cellPadding).toBe("0px");
    expect(geometry.icon).toBeCloseTo(geometry.cell, 1);
    expect(geometry.rowAttributes).toEqual(["aria-rowindex"]);
  }
  await expect(row(page, `${root}/Alpha`).locator("..")).toHaveAttribute("role", "row");
  await expect(row(page, `${root}/Alpha`).locator(".entry-name")).not.toHaveCSS("font-weight", "600");
  // Escape is the classic Clear Selection, and the palette has no peek commands.
  await row(page, `${root}/root.txt`).click();
  expect((await nameGeometry(page, `${root}/root.txt`)).selectionBar).toBe("none");
  await page.keyboard.press("Escape");
  await expect(pane(page).locator(".entry-item.selected")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+P");
  const palette = page.locator(".command-palette-dialog");
  for (const label of ["Peek into Folder", "Collapse All Peeks"]) {
    await palette.locator(".search-input").fill(label);
    await expect(palette.locator(".command-item").filter({ hasText: label })).toHaveCount(0);
  }
  await page.keyboard.press("Escape");
  await expect(palette).toBeHidden();
}

async function expectRestoredPeeks(page: Page) {
  await expect(row(page, `${root}/Alpha/Nested/deep.txt`)).toBeVisible();
  await expect(row(page, `${root}/Alpha/same.txt`)).toBeVisible();
  await expect(caret(page, "Alpha", "Collapse")).toBeVisible();
  await expect(pane(page).getByRole("treegrid", { name: "Files" })).toBeVisible();
  await expect(row(page, `${root}/Alpha/Nested`).locator("..")).toHaveAttribute("aria-level", "2");
}

test("the palette toggle turns Details back into the classic grid and restores expansions", async ({ page }) => {
  await runPaletteCommand(page, "Toggle Folder Peek");
  await expectClassicDetails(page);
  await runPaletteCommand(page, "Toggle Folder Peek");
  await expectRestoredPeeks(page);
});

test("the Settings checkbox toggles Folder Peek live", async ({ page }) => {
  const settings = page.locator(".settings-dialog");
  const toggle = async (checked: boolean) => {
    await pressShortcut(page, ",", { ctrlKey: true });
    await expect(settings).toBeVisible();
    await settings.locator(".settings-search").fill("Folder Peek");
    const setting = settings.locator(".setting-row", { has: page.locator(".folder-peek-toggle") });
    await setting.locator(".toggle-slider").click();
    await expect(setting.locator(".folder-peek-toggle")).toBeChecked({ checked });
    await settings.locator(".close-btn").click();
    await expect(settings).toBeHidden();
  };
  await toggle(false);
  await expectClassicDetails(page);
  await toggle(true);
  await expectRestoredPeeks(page);
});

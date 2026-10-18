/**
 * Folder Peek is one switch for the whole peek feature. Off, List is the classic
 * row-major view (vertical scroll, List Columns controls); on, it is the
 * column-flow view that scrolls sideways. The switch applies live, no reload.
 */
import { test, expect, type Page } from "./fixtures";
import { runPaletteCommand, waitForEntries } from "./helpers";

const shown = ".pane-tree:not(.retained)";
const scroller = (page: Page) => page.locator(`${shown} .list-view .virtual-viewport`);
const items = (page: Page) => page.locator(`${shown} .list-item`);

async function openList(page: Page, path: string, settings: Record<string, unknown> = {}) {
  await page.addInitScript((seed) => {
    if (!sessionStorage.getItem("folder-peek-seeded")) {
      localStorage.setItem("explorer-settings", JSON.stringify(seed));
      sessionStorage.setItem("folder-peek-seeded", "1");
    }
  }, settings);
  await page.goto(`/?path=${path}&viewMode=list`);
  await waitForEntries(page);
  await expect(page.locator(`${shown} .list-view`)).toBeVisible();
}

/** Scroll extents after a wheel gesture over the list. */
async function wheelOutcome(page: Page) {
  const box = (await scroller(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  return scroller(page).evaluate((el) => ({
    overflowsX: el.scrollWidth > el.clientWidth + 2,
    overflowsY: el.scrollHeight > el.clientHeight + 2,
    left: el.scrollLeft,
    top: el.scrollTop,
  }));
}

/** Geometry of the first two entries: same row/right of, or stacked. */
async function firstTwo(page: Page) {
  const a = (await items(page).nth(0).boundingBox())!;
  const b = (await items(page).nth(1).boundingBox())!;
  return { rightOfFirst: b.x > a.x + 5, belowFirst: b.y > a.y + 5, sameRow: Math.abs(b.y - a.y) < 2, sameColumn: Math.abs(b.x - a.x) < 2 };
}

async function expectColumnFlow(page: Page) {
  await expect.poll(async () => (await firstTwo(page)).sameColumn).toBe(true);
  expect((await firstTwo(page)).belowFirst).toBe(true);
  const wheel = await wheelOutcome(page);
  expect(wheel.overflowsX).toBe(true);
  expect(wheel.top).toBe(0);
}

async function expectClassicRows(page: Page) {
  await expect.poll(async () => (await firstTwo(page)).sameRow).toBe(true);
  expect((await firstTwo(page)).rightOfFirst).toBe(true);
  const wheel = await wheelOutcome(page);
  expect(wheel.overflowsY).toBe(true);
  expect(wheel.left).toBe(0);
  expect(wheel.top).toBeGreaterThan(0);
}

async function backgroundMenu(page: Page) {
  const content = page.locator(`${shown} .file-list .content`).first();
  const box = (await content.boundingBox())!;
  await content.click({ button: "right", position: { x: 10, y: Math.round(box.height) - 12 } });
  const menu = page.locator(".context-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("Folder Peek setting", () => {
  test("on (default): List flows into columns and scrolls sideways", async ({ page }) => {
    await openList(page, "/perf/huge-500");
    await expectColumnFlow(page);
  });

  test("palette toggle switches the same folder live to row-major List and back", async ({ page }) => {
    await openList(page, "/perf/huge-500");
    await expectColumnFlow(page);
    const firstName = await items(page).first().locator(".entry-name").textContent();

    await runPaletteCommand(page, "Toggle Folder Peek");
    await expect(page.locator(`${shown} .list-canvas`)).toHaveCount(0);
    // Same folder, same sort order: the switch must not reset the listing.
    await expect(items(page).first().locator(".entry-name")).toHaveText(firstName!);
    await expectClassicRows(page);

    await runPaletteCommand(page, "Toggle Folder Peek");
    await expect(page.locator(`${shown} .list-canvas`)).toHaveCount(1);
    await expectColumnFlow(page);
  });

  test("Settings dialog checkbox switches layouts live", async ({ page }) => {
    await openList(page, "/perf/huge-500");
    await expectColumnFlow(page);

    await page.keyboard.press("Control+,");
    const search = page.locator(".settings-search");
    await expect(search).toBeFocused();
    await search.fill("Folder Peek");
    const toggle = page.locator(".folder-peek-toggle");
    await expect(toggle).toBeChecked();
    await page.locator("label.toggle", { has: toggle }).click();
    await expect(toggle).not.toBeChecked();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toHaveCount(0);

    await expectClassicRows(page);

    await page.keyboard.press("Control+,");
    await page.locator(".settings-search").fill("Folder Peek");
    await page.locator("label.toggle", { has: page.locator(".folder-peek-toggle") }).click();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(page.locator(".settings-dialog")).toHaveCount(0);
    await expectColumnFlow(page);
  });

  test("off at load: classic row-major List honours the persisted column count", async ({ page }) => {
    await openList(page, "/perf/huge-500", { folderPeek: false, listViewColumns: 2 });
    await expect(page.locator(`${shown} .list-view`)).toHaveAttribute("data-columns", "2");
    await expectClassicRows(page);
  });

  test("List Columns submenu exists only while Folder Peek is off", async ({ page }) => {
    await openList(page, "/home/user");
    const peekOn = await backgroundMenu(page);
    await expect(peekOn.locator(".menu-item", { hasText: "List" }).first()).toBeVisible();
    await peekOn.locator(".menu-item", { hasText: "List" }).first().hover();
    await expect(peekOn.locator(".submenu", { hasText: "Columns" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await runPaletteCommand(page, "Toggle Folder Peek");
    const peekOff = await backgroundMenu(page);
    await peekOff.locator(".submenu-wrapper", { hasText: "List" }).first().hover();
    const submenu = peekOff.locator(".submenu", { hasText: "Columns" });
    await expect(submenu).toBeVisible();
    await expect(submenu.locator('[role="menuitemradio"]')).toHaveCount(4);
  });

  test("Set List View Column Count command is available only while Folder Peek is off", async ({ page }) => {
    await openList(page, "/home/user");
    const search = async () => {
      await page.keyboard.press("ControlOrMeta+Shift+P");
      const palette = page.locator(".command-palette-dialog");
      await palette.locator(".search-input").fill("Set List View Column Count");
      return palette;
    };
    let palette = await search();
    await expect(palette.locator(".command-item").filter({ hasText: "Set List View Column Count" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await runPaletteCommand(page, "Toggle Folder Peek");
    palette = await search();
    await expect(palette.locator(".command-item").filter({ hasText: "Set List View Column Count" })).toHaveCount(1);
  });

  test("classic List keeps horizontal arrows as +/-1 and yazi navigation in a single column", async ({ page }) => {
    await openList(page, "/home/user", { folderPeek: false, listViewColumns: 1 });
    const second = items(page).nth(1);
    await second.click();
    const path = await second.getAttribute("data-path");
    await page.keyboard.press("ArrowLeft");
    // Yazi: ArrowLeft leaves the folder for its parent.
    await expect(page.locator(".explorer-pane .crumb.current")).toHaveText("home");
    expect(path).toBeTruthy();
  });
});

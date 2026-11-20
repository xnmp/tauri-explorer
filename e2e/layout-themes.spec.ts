/**
 * Layout themes (#1306): built-in Default / Floating Islands / Hairline
 * Ledger / Compact / Soft Cards (#1548), user CSS layouts from `<config>/layouts/`, independence from the
 * colour theme, persistence, live reload and fallback to Default.
 *
 * Assertions measure rendered geometry and computed styles, not just the
 * root attributes: a layout that sets its attribute but paints nothing is a
 * failure.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, VIEW_VARIANTS, applySettingsAndReload, pressShortcut, runPaletteCommand, seedSettings, switchViewMode, waitForEntries } from "./helpers";

const SEED_KEY = "mock-config-files";

/** Example user layout: the documented hooks are enough to change spacing,
 *  borders, rounding, surfaces and row density. */
const ROOMY = `/*
 * @name Roomy Cards
 * @description Wide gaps, large radii.
 */
:root {
  --layout-gap: 20px;
  --layout-inset: 20px;
  --layout-radius: 22px;
  --layout-border: 3px solid rgb(255, 0, 128);
  --layout-row-height: 40px;
  --layout-surface: rgb(250, 240, 200);
}
`;

let pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

async function seedLayouts(page: Page, files: Record<string, string>) {
  await page.addInitScript(({ key, files }) => {
    const prefixed = Object.fromEntries(Object.entries(files).map(([name, css]) => [`layouts/${name}`, css]));
    // Seed once: later edits stand in for the file on disk across reloads.
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(prefixed));
  }, { key: SEED_KEY, files });
}

async function openSettings(page: Page) {
  await pressShortcut(page, ",", { ctrlKey: true });
  const dialog = page.locator(".settings-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

const css = (page: Page, selector: string, property: string) =>
  page.locator(selector).first().evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), property);
const pseudoCss = (page: Page, selector: string, pseudo: string, property: string) =>
  page.locator(selector).first().evaluate((el, [p, prop]) => getComputedStyle(el, p).getPropertyValue(prop), [pseudo, property]);
const rect = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(el => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
/** Channels of a computed `rgb()`/`rgba()`/`color(srgb ...)` colour, 0-255. */
const rgb = (color: string): number[] => {
  const srgb = color.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map(value => Number(value) * 255);
  return color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
};
/** Name cell's left edge relative to the Name header: the rows' 3px
 *  selection edge, in Default and in any layout that insets its rows. */
const DEFAULT_NAME_CELL_OFFSET = 3;
const nameCellOffset = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector(".details-view .name-column")!.getBoundingClientRect().left;
    const cell = document.querySelector('.details-view [data-region="row"] [data-cell="name"]')!.getBoundingClientRect().left;
    return cell - header;
  });
const firstRowHeight = (page: Page) =>
  page.locator(".details-view:visible .entry-item").first().evaluate(el => el.getBoundingClientRect().height);

test.describe("Layout themes (#1306)", () => {
  test("built-in layouts are selectable, change geometry, and persist", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-layout", "default");
    expect(await firstRowHeight(page)).toBe(32);
    expect(parseFloat(await css(page, ".sidebar-container", "border-radius"))).toBe(0);

    const dialog = await openSettings(page);
    const select = dialog.locator(".layout-theme-select");
    await expect(select.locator("option")).toHaveText(["Default", "Floating Islands", "Hairline Ledger", "Compact", "Soft Cards"]);

    await select.selectOption("floating-islands");
    await expect(html).toHaveAttribute("data-layout-base", "floating-islands");
    expect(parseFloat(await css(page, ".sidebar-container", "border-radius"))).toBe(14);

    await select.selectOption("hairline-ledger");
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Hairline Ledger: square panels, 28px rows, monospaced column headers.
    await expect.poll(() => firstRowHeight(page)).toBe(28);
    expect(parseFloat(await css(page, ".sidebar-container", "border-radius"))).toBe(0);
    expect(await css(page, '[data-region="status-bar"]', "font-family")).toMatch(/Mono|monospace/);

    await page.reload();
    await waitForEntries(page);
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");
    expect(await firstRowHeight(page)).toBe(28);
  });

  test("Compact tightens the chrome and fits more Details rows (#1548)", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const height = (selector: string) =>
      page.locator(selector).first().evaluate(el => el.getBoundingClientRect().height);
    const listHeight = () => page.locator(".details-view:visible").first().evaluate(el => el.clientHeight);
    const defaults = {
      row: await firstRowHeight(page),
      titlebar: await height('[data-region="titlebar"]'),
      toolbar: await height('[data-region="toolbar"]:visible'),
      status: await height('[data-region="status-bar"]'),
      list: await listHeight(),
    };

    await applySettingsAndReload(page, { layoutTheme: "compact" });
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "compact");
    await expect.poll(() => firstRowHeight(page)).toBe(22);
    expect(await height('[data-region="titlebar"]')).toBe(30);
    expect(await height('[data-region="toolbar"]:visible')).toBe(32);
    expect(await height('[data-region="status-bar"]')).toBe(20);
    // Every chrome strip shrinks, so the same window shows more rows.
    expect(await height('[data-region="titlebar"]')).toBeLessThan(defaults.titlebar);
    expect(await height('[data-region="toolbar"]:visible')).toBeLessThan(defaults.toolbar);
    expect(await height('[data-region="status-bar"]')).toBeLessThan(defaults.status);
    const rowsThatFit = (list: number, row: number) => Math.floor(list / row);
    expect(rowsThatFit(await listHeight(), 22)).toBeGreaterThan(rowsThatFit(defaults.list, defaults.row) + 5);
    await page.screenshot({ path: "screenshots/feat/compact-soft-cards-layouts/compact-details.png" });
  });

  test("Soft Cards spaces the tab and cards evenly, 6px apart (#1548, #1854)", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await seedSettings(page, { layoutTheme: "soft-cards", theme: "dark" });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "soft-cards");

    const app = await rect(page, '[data-region="app"]');
    const tab = await rect(page, '[data-region="tab"][aria-selected="true"]:visible');
    const sidebar = await rect(page, ".sidebar-container");
    const panes = await rect(page, '[data-region="panes"]:visible');
    // The tab sits 6px from the window's top and left edges, so it lines up
    // with the sidebar card, and the cards sit 6px below it, 6px apart and
    // 6px from the window's right edge.
    expect(tab.top - app.top).toBe(6);
    expect(tab.left - app.left).toBe(6);
    expect(sidebar.left - app.left).toBe(6);
    for (const card of [sidebar, panes]) expect(card.top - tab.bottom).toBe(6);
    expect(panes.left - sidebar.right).toBe(6);
    expect(app.right - panes.right).toBe(6);
    expect((await rect(page, '[data-region="status-bar"]')).top).toBeGreaterThanOrEqual(panes.bottom);

    for (const card of [".sidebar-container", '[data-region="panes"]']) {
      expect(parseFloat(await css(page, card, "border-top-left-radius"))).toBe(8);
      expect(await css(page, card, "border-top-width")).toBe("1px");
      expect(await css(page, card, "box-shadow")).toBe("none");
      // Dark themes catch a faint highlight along each card's top edge.
      expect(await pseudoCss(page, card, "::after", "box-shadow")).toMatch(/rgba\(255, 255, 255, 0\.05\) 0px 1px 0px 0px inset/);
    }
    // The address bar is a small rounded field, not a pill.
    expect(parseFloat(await css(page, '[data-region="address-bar"]:visible', "border-top-left-radius"))).toBeLessThanOrEqual(6);
    // Title and status bars sit on the backdrop; the sticky column header
    // stays opaque so scrolled rows never show through it.
    expect(await css(page, '[data-region="status-bar"]', "background-color")).toBe("rgba(0, 0, 0, 0)");
    const header = await css(page, '[data-region="column-header"]:visible', "background-color");
    expect(header).not.toBe("rgba(0, 0, 0, 0)");
    expect(header).not.toMatch(/rgba\(.*, 0\)$/);
    await expect(page.locator('[data-region="tab-fillet"]:visible')).toHaveCount(0);
    await page.locator(".entry-item:visible").nth(1).click();
    await page.mouse.move(600, 650);
    await page.screenshot({ path: "screenshots/feat/soft-cards-polish/soft-cards-dark.png" });
  });

  test("Soft Cards gives light themes a cool light backdrop and no top highlight (#1854)", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await seedSettings(page, { layoutTheme: "soft-cards", theme: "light" });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "soft-cards");
    const backdrop = rgb(await css(page, '[data-region="app"]', "background-color"));
    // The backdrop the light theme had before: its base mixed 14% toward black.
    const base = rgb(await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.color = "var(--background-solid)";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }));
    const blackMix = base.map(channel => channel * 0.86);
    backdrop.forEach((channel, i) => expect(channel).toBeGreaterThan(blackMix[i] + 10));
    // Lighter than the black mix, a step below the card, and cool (blue-leaning).
    expect(backdrop[2]).toBeGreaterThan(backdrop[0]);
    expect(Math.max(...backdrop)).toBeLessThan(250);
    expect(await pseudoCss(page, '[data-region="panes"]', "::after", "box-shadow")).toMatch(/^rgba\(0, 0, 0, 0\)/);
    await page.locator(".entry-item:visible").nth(1).click();
    await page.mouse.move(600, 650);
    await page.screenshot({ path: "screenshots/feat/soft-cards-polish/soft-cards-light.png" });
  });

  for (const variant of VIEW_VARIANTS) {
    test(`Soft Cards insets the selected row inside the pane card in ${variant.name} view (#1854)`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 700 });
      // Details columns that fit the card, so both row ends are in view.
      await seedSettings(page, {
        layoutTheme: "soft-cards", theme: "dark", folderPeek: !variant.classic,
        columnVisibility: { prompt: false, date: true, type: true, size: true, length: false, resolution: false, opened: false },
      });
      await page.goto(HOME_URL);
      await waitForEntries(page);
      if (variant.viewMode !== "details") await switchViewMode(page, variant.viewMode);
      await expect(page.locator("html")).toHaveAttribute("data-layout", "soft-cards");
      await page.locator(".entry-item:visible").first().click();
      const selected = page.locator('[data-region="row"][aria-selected="true"]:visible').first();
      await expect(selected).toBeVisible();
      // Keyboard focus draws its ring on the same, inset box.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowUp");
      const focused = page.locator('[data-region="row"][aria-selected="true"]:visible').first();
      const card = await rect(page, '[data-region="panes"]:visible');
      const row = await focused.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      expect(row.left - card.left).toBeGreaterThanOrEqual(4);
      expect(card.right - row.right).toBeGreaterThanOrEqual(4);
      expect(parseFloat(await focused.evaluate(el => getComputedStyle(el).borderTopLeftRadius))).toBe(4);
      // Selection is an accent wash with a thin accent ring, not a side bar.
      expect(await focused.evaluate(el => getComputedStyle(el).boxShadow)).toMatch(/0px 0px 0px 1px inset/);
      expect(await focused.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      if (variant.viewMode === "details") {
        // The header text moves with the inset rows: columns keep Default's
        // alignment.
        expect(await nameCellOffset(page)).toBe(DEFAULT_NAME_CELL_OFFSET);
      }
    });
  }

  test("Soft Cards draws split panes, preview, terminal and source control as cards (#1548, #1854)", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 800 });
    await seedSettings(page, { layoutTheme: "soft-cards", theme: "dark", showPreviewPane: true, showGitStatus: true, showScmPanel: false });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "soft-cards");

    // A split turns each pane into its own card, separated by the gap.
    await runPaletteCommand(page, "Split Pane Right");
    const panes = page.locator('.pane-tree:not(.retained) [data-region="pane"]');
    await expect(panes).toHaveCount(2);
    await expect(page.locator('[data-region="panes"][data-split]:visible')).toHaveCount(1);
    expect(await css(page, '[data-region="panes"][data-split]:visible', "border-top-width")).toBe("0px");
    const boxes = await panes.evaluateAll(els => els.map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), border: getComputedStyle(el).borderTopWidth };
    }));
    for (const box of boxes) {
      expect(box.radius).toBe(8);
      expect(box.border).toBe("1px");
    }
    expect(boxes[1].left - boxes[0].right).toBe(6);

    // The preview is a card of the same kind, a gap beside the panes.
    const preview = page.locator('[data-region="preview"]:visible');
    await expect(preview).toHaveCount(1);
    const previewBox = await rect(page, '[data-region="preview"]:visible');
    expect(previewBox.left - boxes[1].right).toBe(6);
    expect(parseFloat(await css(page, '[data-region="preview"]:visible', "border-top-left-radius"))).toBe(8);
    expect(await css(page, '[data-region="preview"]:visible', "border-top-width")).toBe("1px");

    // The split grip shows only while the pointer is over the divider.
    const divider = page.locator('[data-region="split-divider"]:visible').first();
    const grip = divider.locator('[data-region="split-grip"]');
    await page.mouse.move(600, 650);
    await expect.poll(() => grip.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    await divider.hover();
    await expect.poll(() => grip.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    await page.mouse.move(600, 650);
    await expect.poll(() => grip.evaluate(el => getComputedStyle(el).opacity)).toBe("0");
    // Click near the name: a centred click would scroll the narrow pane sideways.
    await page.locator('.pane-tree:not(.retained) .entry-item:visible').nth(1).click({ position: { x: 80, y: 10 } });
    await page.mouse.move(600, 690);
    await page.waitForTimeout(300);
    await page.screenshot({ path: "screenshots/feat/soft-cards-polish/soft-cards-split.png" });

    // The grip also stays shown while the split is dragged, wherever the pointer is.
    const dividerBox = (await divider.boundingBox())!;
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + dividerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dividerBox.x - 20, dividerBox.y + dividerBox.height - 40, { steps: 4 });
    await expect(divider).toHaveAttribute("data-dragging", /.*/);
    await expect.poll(() => grip.evaluate(el => getComputedStyle(el).opacity)).toBe("1");
    await page.mouse.up();
    await expect(divider).not.toHaveAttribute("data-dragging", /.*/);
    await page.mouse.move(600, 650);
    await expect.poll(() => grip.evaluate(el => getComputedStyle(el).opacity)).toBe("0");

    // The terminal docks under the panes as its own card, a gap below them.
    await runPaletteCommand(page, "Toggle Terminal");
    const terminal = page.locator('[data-region="terminal"]:visible');
    await expect(terminal).toHaveCount(1);
    const terminalBox = await rect(page, '[data-region="terminal"]:visible');
    const main = await rect(page, '[data-region="main"]');
    expect(terminalBox.top - main.bottom).toBe(6);
    expect(terminalBox.left).toBe(6);
    expect(parseFloat(await css(page, '[data-region="terminal"]:visible', "border-top-left-radius"))).toBe(8);
    expect(await css(page, '[data-region="terminal"]:visible', "border-top-width")).toBe("1px");
    await runPaletteCommand(page, "Toggle Terminal");

    // Source control sits in the pane as an inset card.
    await page.getByText("Documents", { exact: true }).first().dblclick();
    await page.getByText("project", { exact: true }).first().dblclick();
    await runPaletteCommand(page, "Toggle Source Control Panel");
    const scm = page.locator('[data-region="scm"]:visible').first();
    await expect(scm).toBeVisible();
    const scmBox = await scm.evaluate(el => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), border: getComputedStyle(el).borderTopWidth }; });
    const scmPane = await scm.evaluate(el => el.closest('[data-region="pane"]')!.getBoundingClientRect().left);
    expect(scmBox.radius).toBe(8);
    expect(scmBox.border).toBe("1px");
    expect(scmBox.left - scmPane).toBeGreaterThanOrEqual(6);
  });

  test("Default keeps square, edge-to-edge panels with the split grip always shown (#1854)", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "default");
    expect((await rect(page, '[data-region="titlebar"]')).height).toBe(38);
    const row = await rect(page, ".details-view:visible .entry-item");
    const list = await rect(page, '[data-region="file-list"]:visible');
    expect(row.left).toBe(list.left);
    expect(await nameCellOffset(page)).toBe(DEFAULT_NAME_CELL_OFFSET);
    await runPaletteCommand(page, "Split Pane Right");
    const grip = page.locator('[data-region="split-divider"]:visible [data-region="split-grip"]').first();
    await expect(grip).toBeVisible();
    expect(Number(await grip.evaluate(el => getComputedStyle(el).opacity))).toBeGreaterThan(0);
  });

  test("layout and colour theme change independently", async ({ page }) => {
    await seedSettings(page, { theme: "nord" });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "nord");
    const nordText = await css(page, ".explorer-pane", "color");

    const dialog = await openSettings(page);
    await dialog.locator(".layout-theme-select").selectOption("hairline-ledger");
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");
    await expect(html).toHaveAttribute("data-theme", "nord");
    expect(await css(page, ".explorer-pane", "color")).toBe(nordText);

    await dialog.locator(".color-theme-select").selectOption("light");
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");
  });

  test("a user CSS layout is listed, applies through the hooks, and reloads on edit", async ({ page }) => {
    await seedLayouts(page, { "roomy.css": ROOMY });
    await seedSettings(page, { theme: "dark" });
    await page.goto(HOME_URL);
    await waitForEntries(page);

    const dialog = await openSettings(page);
    const select = dialog.locator(".layout-theme-select");
    await expect(select.locator("option", { hasText: "Roomy Cards" })).toHaveCount(1);
    await select.selectOption("roomy.css");
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-layout", "roomy.css");
    await expect(html).toHaveAttribute("data-theme", "dark");
    await page.keyboard.press("Escape");

    // Spacing, borders/radii, surfaces and density all follow the file.
    expect(await css(page, ".main-content", "gap")).toBe("20px");
    expect(parseFloat(await css(page, ".sidebar-container", "border-radius"))).toBe(22);
    expect(await css(page, ".sidebar-container", "border-top-color")).toBe("rgb(255, 0, 128)");
    expect(await css(page, ".explorer-pane", "background-color")).toBe("rgb(250, 240, 200)");
    await expect.poll(() => firstRowHeight(page)).toBe(40);

    // Edit the file on "disk" and deliver the watcher notification.
    await page.evaluate(async ({ key, next }) => {
      const disk = JSON.parse(localStorage.getItem(key) ?? "{}");
      localStorage.setItem(key, JSON.stringify({ ...disk, "layouts/roomy.css": next }));
      const config = await (new Function("return import('/src/lib/api/config.ts')"))();
      await config.writeConfigFile("layouts/roomy.css", next);
      const watch = await (new Function("return import('/src/lib/state/config-watch.ts')"))();
      await watch.handleConfigFileChanged("layouts/roomy.css");
    }, { key: SEED_KEY, next: ROOMY.replace("22px", "4px").replace("40px", "30px") });
    await expect.poll(() => css(page, ".sidebar-container", "border-radius")).toBe("4px");
    await expect.poll(() => firstRowHeight(page)).toBe(30);

    // A reload paints the cached layout immediately and keeps the selection.
    await page.reload();
    await waitForEntries(page);
    await expect(html).toHaveAttribute("data-layout", "roomy.css");
    expect(await css(page, ".sidebar-container", "border-radius")).toBe("4px");
  });

  test("the layout picker previews live, survives a layouts reload, and reverts on Escape", async ({ page }) => {
    await seedLayouts(page, { "roomy.css": ROOMY });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const html = page.locator("html");
    await runPaletteCommand(page, "Switch Layout...");
    const picker = page.locator(".theme-picker-dialog");
    await expect(picker).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");

    // A layouts/ change while previewing keeps the preview on screen.
    await page.evaluate(async () => {
      const watch = await (new Function("return import('/src/lib/state/config-watch.ts')"))();
      await watch.handleConfigFileChanged("layouts/roomy.css");
    });
    await expect(html).toHaveAttribute("data-layout", "hairline-ledger");
    await expect(picker).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(picker).toBeHidden();
    await expect(html).toHaveAttribute("data-layout", "default");
  });

  test("a missing layout falls back to Default with a notice and a reset", async ({ page }) => {
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await applySettingsAndReload(page, { layoutTheme: "deleted.css" });
    await waitForEntries(page);

    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-layout", "default");
    await expect(page.locator(".toast.error", { hasText: "deleted.css" })).toBeVisible();
    expect(await firstRowHeight(page)).toBe(32);

    const dialog = await openSettings(page);
    await expect(dialog.locator(".layout-fallback")).toContainText("not found in the layouts folder");
    await expect(dialog.locator(".layout-theme-select")).toHaveValue("deleted.css");
    await dialog.locator(".reset-layout").click();
    await expect(dialog.locator(".layout-theme-select")).toHaveValue("default");
    await expect(dialog.locator(".layout-fallback")).toHaveCount(0);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("explorer-settings") ?? "{}").layoutTheme);
    expect(saved).toBe("default");
  });

  test("a layout file with no usable rules falls back to Default", async ({ page }) => {
    await seedLayouts(page, { "prose.css": "This is not CSS at all, just a note." });
    await seedSettings(page, { layoutTheme: "prose.css" });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "default");
    await expect(page.locator(".toast.error", { hasText: "prose.css" })).toBeVisible();
    await expect(page.locator("style[data-layout-sheet]")).toHaveCount(0);
  });

  test("the legacy Floating Islands toggle migrates to the layout setting", async ({ page }) => {
    await seedSettings(page, { floatingIslands: true, settingsVersion: 1 }, { replace: true });
    await page.goto(HOME_URL);
    await waitForEntries(page);
    await expect(page.locator("html")).toHaveAttribute("data-layout", "floating-islands");
    const dialog = await openSettings(page);
    await expect(dialog.locator(".layout-theme-select")).toHaveValue("floating-islands");
  });

  test("Hairline Ledger's sidebar markers take the folder colour, not the text's (#1871)", async ({ page }) => {
    await seedSettings(page, { layoutTheme: "hairline-ledger", theme: "dark" });
    // A visited folder is listed under Recent, whose icon has no colour of its own.
    await page.addInitScript(() => localStorage.setItem("explorer-frecency", JSON.stringify([
      { path: "/home/user/Documents/project", accesses: [Date.now() - 60_000, Date.now()] },
    ])));
    await page.goto(HOME_URL);
    await waitForEntries(page);
    const marker = page.locator('.recent-item [data-region="sidebar-icon"]').first();
    await expect(marker).toBeVisible();
    const [fill, text, folder] = await marker.evaluate(el => {
      const probe = document.createElement("i");
      probe.style.color = "var(--icon-folder)";
      document.body.append(probe);
      const folder = getComputedStyle(probe).color;
      probe.remove();
      const label = el.closest('[data-region="sidebar-item"]')!.querySelector('[data-region="sidebar-label"]')!;
      return [getComputedStyle(el).backgroundColor, getComputedStyle(label).color, folder];
    });
    expect(rgb(fill)).toEqual(rgb(folder));
    expect(rgb(fill)).not.toEqual(rgb(text));
  });

  for (const variant of VIEW_VARIANTS) {
    test(`Hairline Ledger renders entries in ${variant.name} view`, async ({ page }) => {
      await seedSettings(page, { layoutTheme: "hairline-ledger", folderPeek: !variant.classic });
      await page.goto(HOME_URL);
      await waitForEntries(page);
      if (variant.viewMode !== "details") await switchViewMode(page, variant.viewMode);
      await expect(page.locator("html")).toHaveAttribute("data-layout", "hairline-ledger");
      const entry = page.locator(".entry-item:visible").first();
      await expect(entry).toBeVisible();
      const nameColor = () => entry.locator('[data-region="entry-name"]').first().evaluate(el => getComputedStyle(el).color);
      const unselectedName = await nameColor();
      await entry.click();
      const selected = page.locator('[data-region="row"][aria-selected="true"]:visible').first();
      await expect(selected).toBeVisible();
      const [bg, fg, ring, ink] = await selected.evaluate(el => {
        const style = getComputedStyle(el);
        return [style.backgroundColor, style.color, style.boxShadow, getComputedStyle(document.documentElement).getPropertyValue("--text-primary")];
      });
      expect(bg).not.toBe("rgba(0, 0, 0, 0)");
      expect(bg).not.toBe(fg);
      if (variant.viewMode === "tiles") {
        // A selected tile is ruled, not inverted: no block of ink (white in
        // dark themes) round its picture (#1871).
        expect(rgb(bg)).not.toEqual(rgb(await page.evaluate(c => { const el = document.createElement("i"); el.style.color = c; document.body.append(el); const out = getComputedStyle(el).color; el.remove(); return out; }, ink)));
        expect(ring).toContain("inset");
      } else {
        // A selected row inverts ink and background.
        expect(rgb(fg)).not.toEqual(rgb(bg));
        expect(ring).not.toContain("inset 0px 0px 0px 1px");
      }
      expect(parseFloat(await selected.evaluate(el => getComputedStyle(el).borderTopLeftRadius))).toBe(0);
      await expect(page.locator(`[data-region="file-list"][data-view="${variant.viewMode}"]:visible`)).toHaveCount(1);
      // The chrome is the ledger's monospace; file names keep the theme's
      // face, in every view (#1879).
      const font = (selector: string) => css(page, selector, "font-family");
      for (const chrome of ['[data-region="tab"]', '[data-region="status-bar"]', '[data-region="sidebar-label"]']) {
        expect(await font(chrome), chrome).toMatch(/^"IBM Plex Mono"/);
      }
      const names = page.locator('[data-region="entry-name"]:visible');
      expect(await names.first().evaluate(el => getComputedStyle(el).fontFamily)).toMatch(/^"Inter Variable"/);
      if (variant.viewMode === "tiles") {
        // A selected (and hovered) tile's name keeps its own colour, readable
        // on the tint; inverted, it faded to the background's (#1879).
        expect(rgb(await nameColor())).toEqual(rgb(unselectedName));
      }
    });
  }

  for (const layout of ["default", "hairline-ledger"]) {
    test(`a rule separates the sidebar from the file pane in ${layout} (#1879)`, async ({ page }) => {
      await page.setViewportSize({ width: 1100, height: 700 });
      await seedSettings(page, { layoutTheme: layout });
      await page.goto(HOME_URL);
      await waitForEntries(page);
      const sidebar = await rect(page, '[data-region="sidebar-body"]');
      const y = Math.round(sidebar.bottom - 40);
      // The sidebar's last column, the column inside it, and the pane beside it.
      const pixel = async (x: number) => {
        const png = (await page.screenshot({ clip: { x: Math.floor(x), y, width: 1, height: 1 } })).toString("base64");
        return page.evaluate(async (data) => {
          const image = new Image();
          image.src = `data:image/png;base64,${data}`;
          await image.decode();
          const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d")!;
          context.drawImage(image, 0, 0);
          return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        }, png);
      };
      const edge = await pixel(sidebar.right - 0.5);
      const inside = await pixel(sidebar.right - 3.5);
      const pane = await pixel(sidebar.right + 3.5);
      // Sidebar and pane are one surface (to rounding); the rule is darker.
      inside.forEach((channel, i) => expect(Math.abs(channel - pane[i])).toBeLessThanOrEqual(2));
      const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      expect(luma(inside) - luma(edge)).toBeGreaterThan(8);
    });
  }
});

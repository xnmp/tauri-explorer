/**
 * Layout themes (#1306): built-in Default / Floating Islands / Hairline
 * Ledger, user CSS layouts from `<config>/layouts/`, independence from the
 * colour theme, persistence, live reload and fallback to Default.
 *
 * Assertions measure rendered geometry and computed styles, not just the
 * root attributes: a layout that sets its attribute but paints nothing is a
 * failure.
 */
import { test, expect, type Page } from "./fixtures";
import { HOME_URL, VIEW_VARIANTS, applySettingsAndReload, pressShortcut, seedSettings, switchViewMode, waitForEntries } from "./helpers";

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
    await expect(select.locator("option")).toHaveText(["Default", "Floating Islands", "Hairline Ledger"]);

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

  for (const variant of VIEW_VARIANTS) {
    test(`Hairline Ledger renders entries in ${variant.name} view`, async ({ page }) => {
      await seedSettings(page, { layoutTheme: "hairline-ledger", folderPeek: !variant.classic });
      await page.goto(HOME_URL);
      await waitForEntries(page);
      if (variant.viewMode !== "details") await switchViewMode(page, variant.viewMode);
      await expect(page.locator("html")).toHaveAttribute("data-layout", "hairline-ledger");
      const entry = page.locator(".entry-item:visible").first();
      await expect(entry).toBeVisible();
      await entry.click();
      // Selection inverts ink and background in every view.
      const selected = page.locator('[data-region="row"][aria-selected="true"]:visible').first();
      if (await selected.count()) {
        const [bg, fg] = await selected.evaluate(el => [getComputedStyle(el).backgroundColor, getComputedStyle(el).color]);
        expect(bg).not.toBe("rgba(0, 0, 0, 0)");
        expect(bg).not.toBe(fg);
      }
    });
  }
});

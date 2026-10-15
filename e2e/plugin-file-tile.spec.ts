import { test, expect, type Page, type Locator } from "./fixtures";
import { applySettingsAndReload, switchViewMode, waitForEntries } from "./helpers";

const ROOT = "/home/user/Pictures";
const PATH = `${ROOT}/photo1.jpg`;

async function mountTile(page: Page, size = "medium", selected = true) {
  await page.evaluate(async ({ path, size, selected }) => {
    const { exposePluginSDK } = await import("/src/lib/plugins/runtime-sdk.ts");
    exposePluginSDK();
    const sdk = (window as any).__TAURI_EXPLORER_PLUGIN_SDK__;
    if (!sdk.capabilities.includes("fileTile")) throw new Error("Missing fileTile capability");
    const entry = { path, name: "photo1.jpg", kind: "file", size: 1024, modified: "2026-01-01T00:00:00Z" };
    // The plugin owns all grid/row semantics. There is deliberately no host
    // TileSurface ancestor to mask missing standalone cell styles.
    const grid = document.createElement("div");
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-label", "Plugin grid");
    grid.style.cssText = "position:fixed;left:0;top:0;width:220px;z-index:10000;background:var(--background-solid)";
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    grid.append(row);
    document.body.append(grid);
    const calls: string[] = [];
    (window as any).__singleTileCalls = calls;
    // This single-cell grid owns these keys. Leaving Enter unhandled invokes
    // the underlying Explorer's Open command and its navigation focus return.
    grid.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "Enter") return;
      calls.push(`grid-key:${event.key}:${event.defaultPrevented}`);
      event.preventDefault();
    });
    sdk.modules.svelte.mount(sdk.modules["ui/file-tile"].default, {
      target: row,
      props: {
        entry, selected, focused: true, size, column: 1,
        onselect: (entry: { path: string }, event: MouseEvent) => calls.push(`select:${entry.path}:${event.ctrlKey}:${event.shiftKey}:${event.metaKey}`),
        onopen: (entry: { path: string }) => calls.push(`open:${entry.path}`),
        onmenu: (entry: { path: string }, event: MouseEvent) => calls.push(`menu:${entry.path}:${event.defaultPrevented}`),
        onfocus: () => calls.push("focus"),
        onkeydown: (event: KeyboardEvent) => calls.push(`key:${event.key}:${event.defaultPrevented}`),
      },
    });
  }, { path: PATH, size, selected });
  return page.getByRole("grid", { name: "Plugin grid" }).getByRole("gridcell");
}

async function appearance(cell: Locator) {
  return cell.evaluate((el) => {
    const css = getComputedStyle(el);
    const icon = el.querySelector<HTMLElement>(".tile-icon")!;
    const name = el.querySelector<HTMLElement>(".name-tiles")!;
    const nameCSS = getComputedStyle(name);
    return {
      classes: [...el.classList].filter((name) => name !== "tile-surface" && name !== "entry-item" && !name.startsWith("svelte-")).sort(),
      selected: el.getAttribute("aria-selected"),
      name: name.textContent,
      nameClass: [...name.classList].filter((name) => !name.startsWith("svelte-")).sort(),
      iconChildren: [...icon.children].map((child) => child.tagName),
      image: icon.querySelector(".thumbnail-full")?.getAttribute("src"),
      display: css.display, direction: css.flexDirection, height: el.getBoundingClientRect().height,
      padding: css.padding, borderWidth: css.borderBottomWidth, borderColor: css.borderBottomColor,
      background: css.backgroundColor, color: css.color, radius: css.borderRadius,
      iconWidth: icon.getBoundingClientRect().width, iconHeight: icon.getBoundingClientRect().height,
      opacity: getComputedStyle(icon).opacity, font: nameCSS.font, clamp: nameCSS.webkitLineClamp,
    };
  });
}

test.describe("Plugin single file tile", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?path=${ROOT}`);
    await waitForEntries(page);
  });

  for (const size of ["small", "medium", "large", "xlarge"] as const) {
    test(`matches the built-in ${size} image tile, including selected and cut styling`, async ({ page }) => {
      await applySettingsAndReload(page, { thumbnailSize: size });
      await waitForEntries(page);
      await switchViewMode(page, "tiles");
      const native = page.locator(`.tiles-view .tile-item[data-path="${PATH}"]`);
      await native.click();
      await page.keyboard.press("Control+x");
      await expect(native).toHaveClass(/cut/);
      await expect(native.locator(".tile-icon .thumbnail-full")).toBeVisible();
      // Remove pointer hover/focus before comparing visual selection chrome.
      await native.evaluate((el: HTMLElement) => el.blur());
      await page.mouse.move(1100, 700);
      // Grid items stretch to the tallest sibling. Another tile in this row
      // ("screenshot.png") wraps to two lines, which is 37.4px against the
      // 37px reserved name area, so the stretched native tile reads 131.375.
      // The standalone plugin cell has no siblings; compare the native tile's
      // own height by opting it out of stretching.
      await native.evaluate((el: HTMLElement) => { el.style.alignSelf = "start"; });
      const expected = await appearance(native);
      const plugin = await mountTile(page, size);
      await expect(plugin.locator(".tile-icon .thumbnail-full")).toBeVisible();
      await expect(plugin).toHaveAttribute("role", "gridcell");
      await expect(plugin).toHaveAttribute("aria-colindex", "1");
      await expect(page.getByRole("grid", { name: "Plugin grid" }).getByRole("row")).toHaveCount(1);
      expect(await appearance(plugin)).toEqual(expected);
    });
  }

  test("forwards modifiers and callbacks while leaving keyboard navigation to its grid", async ({ page }) => {
    const cell = await mountTile(page, "medium", false);
    await expect(cell).toHaveAttribute("aria-selected", "false");
    await cell.click({ modifiers: ["Control", "Shift"] });
    await cell.dblclick();
    await cell.click({ button: "right" });
    await cell.focus();
    await expect(cell).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const calls = await page.evaluate(() => (window as any).__singleTileCalls as string[]);
    expect(calls.filter((call) => call !== "focus")).toEqual([
      `select:${PATH}:true:true:false`,
      `select:${PATH}:false:false:false`,
      `select:${PATH}:false:false:false`,
      `open:${PATH}`,
      `menu:${PATH}:true`,
      "key:ArrowDown:false", "grid-key:ArrowDown:false",
      "key:Enter:false", "grid-key:Enter:false",
    ]);
    await expect(cell).toBeFocused();
    await expect(page.locator(".crumb.current")).toHaveText("Pictures");
  });
});

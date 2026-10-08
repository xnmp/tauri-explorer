/**
 * E2E: the plugin SDK's `ui/file-tiles` module. A plugin mounts it the way a
 * precompiled package does (through the SDK's own Svelte runtime) and must
 * get the built-in Tiles view's tiles: same chrome, thumbnails and names,
 * with every interaction reported through its callbacks.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, switchViewMode, waitForEntries } from "./helpers";

const PICTURES = "/home/user/Pictures";

/** Mounts the module into a fixed-width host and records every callback. */
async function mountTiles(page: Page, width: number): Promise<void> {
  await page.evaluate(async ({ width, root }) => {
    const { exposePluginSDK } = await import("/src/lib/plugins/runtime-sdk.ts");
    exposePluginSDK();
    const sdk = (window as any).__TAURI_EXPLORER_PLUGIN_SDK__;
    const { mount } = sdk.modules["svelte"];
    const FileTiles = sdk.modules["ui/file-tiles"].default;
    const entry = (name: string, kind: "file" | "directory", size = 1024) =>
      ({ name, path: `${root}/${name}`, kind, size, modified: "2026-01-01T00:00:00Z" });
    const entries = [entry("vacation", "directory", 0), entry("photo1.jpg", "file"), entry("photo2.jpg", "file"), entry("screenshot.png", "file"), entry("notes.txt", "file")];
    const calls: string[] = [];
    (window as any).__tileCalls = calls;
    const host = document.createElement("div");
    host.dataset.testid = "tiles-host";
    host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;z-index:10000;background:var(--background-solid)`;
    document.body.append(host);
    (window as any).__tileHost = host;
    mount(FileTiles, {
      target: host,
      props: {
        entries,
        selected: new Set([`${root}/photo2.jpg`]),
        label: "Trace images",
        onselect: (e: { path: string }, event: MouseEvent) => calls.push(`select:${e.path}:${event instanceof MouseEvent}:${event.ctrlKey}`),
        onopen: (e: { path: string }) => calls.push(`open:${e.path}`),
        onmenu: (e: { path: string }, event: MouseEvent) => calls.push(`menu:${e.path}:${event.defaultPrevented}`),
      },
    });
  }, { width, root: PICTURES });
}

const calls = (page: Page) => page.evaluate(() => (window as any).__tileCalls as string[]);

test.describe("Plugin SDK file tiles", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/?path=${PICTURES}`);
    await waitForEntries(page);
  });

  test("announces the fileTiles capability and exports a component", async ({ page }) => {
    const sdk = await page.evaluate(async () => {
      const { exposePluginSDK } = await import("/src/lib/plugins/runtime-sdk.ts");
      exposePluginSDK();
      const value = (window as any).__TAURI_EXPLORER_PLUGIN_SDK__;
      return { capabilities: value.capabilities as string[], component: typeof value.modules["ui/file-tiles"]?.default };
    });
    expect(sdk.capabilities).toContain("fileTiles");
    expect(sdk.component).toBe("function");
  });

  test("renders named, thumbnailed tiles with the selection and reports interactions", async ({ page }) => {
    await mountTiles(page, 640);
    const grid = page.getByRole("grid", { name: "Trace images" });
    await expect(grid).toBeVisible();
    const tile = (name: string) => grid.locator(`[data-entry-path="${PICTURES}/${name}"]`);

    await expect(grid.locator(".name-tiles")).toHaveText(["vacation", "photo1.jpg", "photo2.jpg", "screenshot.png", "notes.txt"]);
    await expect(tile("photo1.jpg").locator(".tile-icon img")).toBeVisible();
    await expect(tile("photo2.jpg")).toHaveAttribute("aria-selected", "true");
    await expect(tile("photo2.jpg")).toHaveClass(/selected/);
    await expect(tile("photo1.jpg")).toHaveAttribute("aria-selected", "false");
    // The selected underline is the accent-coloured bottom edge.
    const [selectedEdge, plainEdge] = await Promise.all([
      tile("photo2.jpg").evaluate((el) => getComputedStyle(el).borderBottomColor),
      tile("photo1.jpg").evaluate((el) => getComputedStyle(el).borderBottomColor),
    ]);
    expect(selectedEdge).not.toBe(plainEdge);

    await tile("photo1.jpg").click({ modifiers: ["Control"] });
    await tile("screenshot.png").dblclick();
    await tile("notes.txt").click({ button: "right" });
    await tile("vacation").focus();
    await page.keyboard.press("Enter");
    expect(await calls(page)).toEqual([
      `select:${PICTURES}/photo1.jpg:true:true`,
      `select:${PICTURES}/screenshot.png:true:false`,
      `select:${PICTURES}/screenshot.png:true:false`,
      `open:${PICTURES}/screenshot.png`,
      `menu:${PICTURES}/notes.txt:true`,
      `open:${PICTURES}/vacation`,
    ]);
    // Arrow keys move focus between tiles; only one tile is a Tab stop.
    await page.keyboard.press("ArrowRight");
    await expect(tile("photo1.jpg")).toBeFocused();
    await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  });

  test("columns follow the component's own width and the tile-size setting", async ({ page }) => {
    await applySettingsAndReload(page, { thumbnailSize: "medium" });
    await waitForEntries(page);
    await mountTiles(page, 640);
    const grid = page.getByRole("grid", { name: "Trace images" });
    // 640px less 16px padding fits five 108px medium columns with 6px gaps.
    await expect(grid).toHaveAttribute("aria-colcount", "5");
    await expect(grid.getByRole("row")).toHaveCount(1);
    await page.evaluate(() => { (window as any).__tileHost.style.width = "300px"; });
    await expect(grid).toHaveAttribute("aria-colcount", "2");
    await expect(grid.getByRole("row")).toHaveCount(3);
  });

  test("tiles match the built-in Tiles view's", async ({ page }) => {
    await switchViewMode(page, "tiles");
    const builtIn = page.locator(".tiles-view .tile-item", { hasText: "photo1.jpg" }).first();
    await expect(builtIn).toBeVisible();
    const styleOf = (locator: ReturnType<Page["locator"]>) => locator.evaluate((el) => {
      const tile = getComputedStyle(el);
      const icon = el.querySelector(".tile-icon")!.getBoundingClientRect();
      const name = getComputedStyle(el.querySelector(".name-tiles")!);
      return {
        height: Math.round(el.getBoundingClientRect().height),
        padding: tile.padding, borderBottomWidth: tile.borderBottomWidth, borderRadius: tile.borderRadius,
        icon: [Math.round(icon.width), Math.round(icon.height)],
        nameFont: name.font, nameClamp: name.webkitLineClamp,
      };
    });
    const expected = await styleOf(builtIn);
    await mountTiles(page, 640);
    const mounted = page.getByRole("grid", { name: "Trace images" }).locator(`[data-entry-path="${PICTURES}/photo1.jpg"]`);
    expect(await styleOf(mounted)).toEqual(expected);
  });
});

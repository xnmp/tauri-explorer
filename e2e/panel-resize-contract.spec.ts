import { test, expect, type Page } from "./fixtures";

let pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

async function openPanels(page: Page, zoomLevel = 100) {
  await page.addInitScript(zoom => {
    localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: zoom, showGitStatus: true, showScmPanel: true, millerLayers: 1 }));
  }, zoomLevel);
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/?path=/home/user/Documents");
  await expect(page.locator('.file-list .entry-item[data-path="/home/user/Documents/notes.md"]')).toBeVisible();
}

for (const zoom of [80, 150]) {
  test(`sidebar drag follows the pointer at ${zoom}% and persists its CSS width`, async ({ page }) => {
    await openPanels(page, zoom);
    const panel = page.locator(".sidebar-container");
    const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true });
    const before = (await panel.boundingBox())!;
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 3 }); await page.mouse.up();
    await expect.poll(async () => (await panel.boundingBox())!.width - before.width).toBeCloseTo(60, 0);
    const saved = await page.evaluate(() => Number(localStorage.getItem("explorer-sidebar-width")));
    expect(saved).toBeCloseTo(240 + 60 / (zoom / 100), 0);
  });
}

test("blur retires a panel drag before later pointer movement", async ({ page }) => {
  await openPanels(page);
  const panel = page.locator(".sidebar-container");
  const handle = (await page.getByRole("separator", { name: "Resize sidebar", exact: true }).boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + 100;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const before = (await panel.boundingBox())!.width;
  await page.mouse.move(x + 60, y); await page.mouse.up();
  expect((await panel.boundingBox())!.width).toBeCloseTo(before, 0);
  await expect(panel).not.toHaveClass(/resizing/);
});

for (const name of ["Resize sidebar", "Resize source control panel", "Resize miller columns"]) {
  test(`${name} supports keyboard sizing without moving file selection`, async ({ page }) => {
    await openPanels(page);
    const file = page.locator('.file-list .entry-item[data-path="/home/user/Documents/notes.md"]');
    await file.click();
    const handle = page.getByRole("separator", { name, exact: true });
    await expect(handle).toHaveAttribute("tabindex", "0");
    await handle.focus();
    const before = Number(await handle.getAttribute("aria-valuenow"));
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
    await expect(file).toHaveClass(/selected/);
    await page.keyboard.press("Home");
    expect(await handle.getAttribute("aria-valuenow")).toBe(await handle.getAttribute("aria-valuemin"));
    await page.keyboard.press("End");
    expect(await handle.getAttribute("aria-valuenow")).toBe(await handle.getAttribute("aria-valuemax"));
  });
}

for (const mode of ["details", "list", "tiles"]) {
  test(`inline panels retain usable ${mode} files in a narrow split`, async ({ page }, info) => {
    await openPanels(page);
    await page.evaluate(async viewMode => {
      const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
      const manager = (await load()).windowTabsManager;
      const leaf = (id: string) => ({ type: "leaf", id, path: "/home/user/Documents", millerLayers: 1, viewMode });
      manager.restoreFromState({ version: 3, activeTabId: "panels", tabs: [{ id: "panels", kind: "explorer", activePaneId: "right", layout: {
        type: "split", id: "split", direction: "row", ratio: 0.5, first: leaf("left"), second: leaf("right"),
      } }] });
      for (const explorer of manager.getAllExplorers()) explorer.setViewMode(viewMode);
    }, mode);
    await page.setViewportSize({ width: 800, height: 600 });
    const active = page.locator(".explorer-pane.active");
    await expect(active.locator(".miller-columns")).toHaveCount(1);
    await expect(active.locator(".scm-panel")).toHaveCount(1);
    await expect.poll(() => active.locator(".file-list").evaluate(el => el.clientWidth)).toBeGreaterThanOrEqual(238);
    const file = active.locator('.file-list .entry-item[data-path="/home/user/Documents/notes.md"]');
    for (const paneId of ["left", "right"]) {
      await page.evaluate(async id => {
        const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
        (await load()).windowTabsManager.setActivePane(id);
      }, paneId);
      await expect.poll(() => file.locator(".entry-name").evaluate(element => {
        const container = element.closest(".pane-container");
        if (!container || element.textContent !== "notes.md") return false;
        const clip = container.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        return text.width > 0
          && text.left >= Math.max(0, clip.left)
          && text.right <= Math.min(window.innerWidth, clip.right);
      })).toBe(true);
      await file.click(); await expect(file).toHaveClass(/selected/);
    }
    await page.screenshot({ path: info.outputPath(`inline-panels-${mode}.png`) });
  });
}

test("failed pointer capture rolls back the resize lifetime", async ({ page }) => {
  await openPanels(page);
  const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  await handle.evaluate(el => { el.setPointerCapture = () => { throw new DOMException("inactive pointer", "NotFoundError"); }; });
  const box = (await handle.boundingBox())!, x = box.x + box.width / 2, y = box.y + 100;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60, y); await page.mouse.up();
  await expect(page.locator(".sidebar-container")).not.toHaveClass(/resizing/);
  expect((await page.locator(".sidebar-container").boundingBox())!.width).toBeCloseTo(240, 0);
});

test("zoom change retires old-scale pointer work", async ({ page }) => {
  await openPanels(page);
  const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const box = (await handle.boundingBox())!, x = box.x + box.width / 2, y = box.y + 100;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.evaluate(() => { document.documentElement.style.zoom = "1.5"; });
  await expect(page.locator(".sidebar-container")).not.toHaveClass(/resizing/);
  await page.mouse.move(x + 60, y); await page.mouse.up();
  expect(await page.locator(".sidebar-container").evaluate(el => parseFloat((el as HTMLElement).style.width))).toBe(240);
});


test("inline panels release geometry on hide and island hoist", async ({ page }) => {
  await openPanels(page);
  await page.setViewportSize({ width: 640, height: 600 });
  const canvasWidth = () => page.locator(".pane-tree").evaluate(el => parseFloat((el as HTMLElement).style.width));
  await expect.poll(canvasWidth).toBe(720);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    (await load()).windowTabsManager.toggleScmInActivePane();
  });
  await expect(page.locator(".scm-panel")).toHaveCount(0);
  await expect.poll(canvasWidth).toBe(440);
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/settings.svelte.ts')");
    (await load()).settingsStore.update({ showSidebar: false, floatingIslands: true });
  });
  await expect(page.locator(".miller-island .miller-columns")).toHaveCount(1);
  await expect(page.locator(".explorer-pane .miller-columns")).toHaveCount(0);
  await expect.poll(canvasWidth).toBeLessThan(440);
  await expect(page.locator('.file-list .entry-item[data-path="/home/user/Documents/notes.md"] .entry-name')).toBeInViewport();
});

for (const zoom of [80, 150]) {
  test(`left-edge Git columns follow zoomed pointer movement at ${zoom}%`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value })), zoom);
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto("/?path=/home/user/Documents/project");
    await expect(page.locator(".file-list .entry-item").first()).toBeVisible();
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Toggle Commit Graph");
    await page.keyboard.press("Enter");
    await expect(page.locator(".commit-row").first()).toContainText("Uncommitted Changes");
    for (const column of ["author", "date"]) {
      const cell = page.locator(`.gh-${column}`);
      const handle = page.getByRole("separator", { name: `Resize ${column} column`, exact: true });
      const before = (await cell.boundingBox())!.width, box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y); await page.mouse.down();
      await page.mouse.move(x - 30, y, { steps: 3 }); await page.mouse.up();
      await expect.poll(async () => (await cell.boundingBox())!.width - before).toBeCloseTo(30, 0);
      await handle.focus(); await page.keyboard.press("Home");
      expect(await handle.getAttribute("aria-valuenow")).toBe(await handle.getAttribute("aria-valuemin"));
    }
  });
}

test("inline panel drag remains continuous while its contribution grows a narrow workspace", async ({ page }) => {
  await openPanels(page, 150);
  await page.setViewportSize({ width: 800, height: 600 });
  const handle = page.getByRole("separator", { name: "Resize source control panel", exact: true });
  await handle.scrollIntoViewIfNeeded();
  const box = (await handle.boundingBox())!, x = box.x + box.width / 2, y = box.y + 100;
  await page.mouse.move(x, y); await page.mouse.down();
  for (const dx of [15, 30, 45, 60]) {
    await page.mouse.move(x + dx, y);
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeCloseTo(280 + dx / 1.5, 0);
  }
  await page.mouse.up();
  expect(await page.evaluate(() => Number(localStorage.getItem("explorer-scm-panel-width")))).toBeCloseTo(320, 0);
});

test("sidebar drag remains continuous with a scrolled constrained workspace", async ({ page }) => {
  await openPanels(page, 150);
  await page.setViewportSize({ width: 800, height: 600 });
  await expect.poll(() => page.locator(".pane-tree").evaluate(el => parseFloat((el as HTMLElement).style.width))).toBe(720);
  await page.locator(".pane-container").evaluate(el => { el.scrollLeft = 100; });
  await expect.poll(() => page.locator(".pane-container").evaluate(el => el.scrollLeft)).toBe(100);
  const handle = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const box = (await handle.boundingBox())!, x = box.x + box.width / 2, y = box.y + 100;
  await page.mouse.move(x, y); await page.mouse.down();
  for (const dx of [15, 30, 45, 60]) {
    await page.mouse.move(x + dx, y);
    await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeCloseTo(240 + dx / 1.5, 0);
  }
  await page.mouse.up();
});

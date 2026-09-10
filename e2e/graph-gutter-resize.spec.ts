import { test, expect, type Page } from "./fixtures";

let pageErrors: string[] = [];
test.beforeEach(({ page }) => { pageErrors = []; page.on("pageerror", error => pageErrors.push(error.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

async function graph(page: Page, zoom = 100) {
  await page.addInitScript(value => localStorage.setItem("explorer-settings", JSON.stringify({ zoomLevel: value })), zoom);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/?path=/home/user/Documents/project");
  await expect(page.locator(".file-list .entry-item").first()).toBeVisible();
  await page.keyboard.press("Control+Shift+p");
  await page.locator("input:focus").fill("Toggle Commit Graph");
  await page.keyboard.press("Enter");
  await expect(page.locator(".commit-row").first()).toContainText("Uncommitted Changes");
}
for (const zoom of [80, 150]) {
  test(`graph gutter follows pointer distance at ${zoom}%`, async ({ page }) => {
    await graph(page, zoom);
    const gutter = page.locator(".graph-clip"), handle = page.getByRole("separator", { name: "Resize graph column", exact: true });
    const before = (await gutter.boundingBox())!.width, box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 }); await page.mouse.up();
    await expect.poll(async () => (await gutter.boundingBox())!.width - before).toBeCloseTo(60, 0);
    expect(await page.evaluate(() => Number(localStorage.getItem("git-graph-col-graph")))).toBeCloseTo((before + 60) / (zoom / 100), 0);
  });
}

test("graph gutter keyboard sizing changes rows and preserves commit selection", async ({ page }, testInfo) => {
  await graph(page);
  const selected = page.locator(".commit-row", { hasText: "Merge hotfix into main" });
  await selected.locator(".summary").click(); await expect(selected).toHaveClass(/selected/);
  const handle = page.getByRole("separator", { name: "Resize graph column", exact: true });
  await expect(handle).toHaveAttribute("tabindex", "0"); await handle.focus();
  const row = page.locator(".commit-row .summary").nth(1);
  const before = (await row.boundingBox())!.x;
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await row.boundingBox())!.x - before).toBeCloseTo(10, 0);
  await expect(selected).toHaveClass(/selected/);
  await page.screenshot({ path: testInfo.outputPath("graph-gutter-keyboard.png") });
  await page.keyboard.press("Home");
  expect(await handle.getAttribute("aria-valuenow")).toBe("28");
  await page.keyboard.press("End");
  expect(await handle.getAttribute("aria-valuenow")).toBe("800");
  await expect(selected).toHaveClass(/selected/);
});

test("retiring the graph during a gutter drag prevents late width persistence", async ({ page }) => {
  await graph(page);
  const handle = (await page.getByRole("separator", { name: "Resize graph column", exact: true }).boundingBox())!;
  const x = handle.x + handle.width / 2, y = handle.y + handle.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.evaluate(async () => {
    const load = new Function("return import('/src/lib/state/window-tabs.svelte.ts')");
    const manager = (await load()).windowTabsManager;
    manager.setPaneGitGraph(manager.activePaneId, null);
  });
  await expect(page.locator(".graph-clip")).toHaveCount(0);
  await page.mouse.move(x + 60, y); await page.mouse.up();
  expect(await page.evaluate(() => localStorage.getItem("git-graph-col-graph"))).toBeNull();
  expect(await page.evaluate(() => document.body.style.cursor)).toBe("");
});

test("failed pane divider capture rolls back input ownership", async ({ page }) => {
  await page.goto("/?path=/home/user/Documents");
  await expect(page.locator(".file-list .entry-item").first()).toBeVisible();
  await page.keyboard.press("Control+\\");
  const divider = page.getByRole("separator", { name: "Resize panes", exact: true });
  await divider.evaluate(el => { el.setPointerCapture = () => { throw new DOMException("inactive pointer", "NotFoundError"); }; });
  const box = (await divider.boundingBox())!, x = box.x + box.width / 2, y = box.y + 80;
  const before = await divider.getAttribute("aria-valuenow");
  await page.mouse.move(x, y); await page.mouse.down();
  await expect(page.locator(".pane-split.resizing")).toHaveCount(0);
  await page.mouse.move(x + 60, y);
  await expect(divider).toHaveAttribute("aria-valuenow", before!);
  await page.mouse.up();
});


test("gutter follows topology automatically until manually sized, then restores its preference", async ({ page }) => {
  await graph(page);
  const gutter = page.locator(".graph-clip");
  const width = () => gutter.evaluate(el => parseFloat((el as HTMLElement).style.width));
  const view = page.getByTestId("git-graph-view");
  const initial = await width();
  await expect(view).toHaveAttribute("data-lane-count", "4");
  await page.getByTestId("branch-filter-btn").click();
  const pathFilter = page.getByTestId("git-graph-file-path-filter");
  await pathFilter.fill("src/feature-x.ts");
  const summaries = page.locator(".commit-row .summary");
  await expect(summaries).toHaveCount(1);
  await expect(summaries).toHaveText("Merge branch 'feature'");
  await expect(view).toHaveAttribute("data-lane-count", "1");
  await expect.poll(width).toBeLessThan(initial);
  expect(await page.evaluate(() => localStorage.getItem("git-graph-col-graph"))).toBeNull();
  await pathFilter.fill("");
  await expect(page.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  await expect(view).toHaveAttribute("data-lane-count", "4");
  await expect.poll(width).toBe(initial);
  await page.keyboard.press("Escape");
  const handle = page.getByRole("separator", { name: "Resize graph column", exact: true });
  await handle.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(width).toBe(initial + 10);
  await page.getByTestId("branch-filter-btn").click();
  await pathFilter.fill("src/feature-x.ts");
  await expect(summaries).toHaveCount(1);
  await expect(summaries).toHaveText("Merge branch 'feature'");
  await expect(view).toHaveAttribute("data-lane-count", "1");
  await expect.poll(width).toBe(initial + 10);
  expect(await page.evaluate(() => Number(localStorage.getItem("git-graph-col-graph")))).toBe(initial + 10);
  await pathFilter.fill("");
  await expect(view).toHaveAttribute("data-lane-count", "4");
  await page.keyboard.press("Escape");
  // Closing and reopening mounts a fresh width owner from the saved preference.
  for (const open of [false, true]) {
    await page.keyboard.press("Control+Shift+p");
    await page.locator("input:focus").fill("Toggle Commit Graph");
    await page.keyboard.press("Enter");
    await expect(view).toHaveCount(open ? 1 : 0);
  }
  await expect(page.locator(".commit-row").first()).toContainText("Uncommitted Changes");
  await expect.poll(width).toBe(initial + 10);
});

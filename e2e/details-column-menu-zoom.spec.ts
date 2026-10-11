import { test, expect, type Page } from "./fixtures";
import { HOME_URL, pressShortcut, seedSettings, waitForEntries } from "./helpers";

async function openAtHeader(page: Page, edge = false) {
  const header = await page.locator(".column-headers").boundingBox();
  expect(header).not.toBeNull();
  const point = {
    // Stay inside the header rather than WebKit's non-overlay scrollbar.
    x: edge ? Math.min(header!.x + header!.width, page.viewportSize()!.width) - 24 : header!.x + 120,
    y: header!.y + header!.height / 2,
  };
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.locator(".column-menu")).toBeVisible();
  await expect(page.locator(".context-menu")).toHaveCount(0);
  return point;
}

async function menuBox(page: Page) {
  const box = await page.locator(".column-menu").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function capturePlacement(page: Page, point: { x: number; y: number }, zoom: number, path: string) {
  // Annotate the real click position: headless screenshots omit the cursor.
  // This adds only a non-interactive evidence marker, after layout assertions.
  await page.evaluate(({ point, zoom }) => {
    const scale = zoom / 100;
    const marker = document.createElement("div");
    marker.id = "placement-evidence";
    marker.style.cssText = `position:absolute;left:${point.x / scale}px;top:${point.y / scale}px;width:10px;height:10px;border:2px solid #d02030;border-radius:50%;transform:translate(-50%,-50%);z-index:99999;pointer-events:none`;
    const label = document.createElement("div");
    label.textContent = `${zoom}% zoom · red ring marks header right-click`;
    label.style.cssText = `position:absolute;left:${480 / scale}px;top:${8 / scale}px;padding:4px;background:white;color:#a01020;font:12px sans-serif;z-index:99999;pointer-events:none`;
    label.id = "placement-label";
    document.body.append(marker, label);
  }, { point, zoom });
  await page.screenshot({ path });
  await page.evaluate(() => {
    document.getElementById("placement-evidence")?.remove();
    document.getElementById("placement-label")?.remove();
  });
}

async function setZoom(page: Page, zoom: number) {
  const key = zoom < 100 ? "-" : "=";
  for (let step = 0; step < Math.abs(zoom - 100) / 10; step++) {
    await pressShortcut(page, key, { ctrlKey: true });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(`${zoom}%`);
}

async function captureColumnState(page: Page, label: string, column: string, state: "hidden" | "restored") {
  // Caption the asserted running-app state without changing its columns.
  await page.evaluate((text) => {
    const caption = document.createElement("div");
    caption.id = "column-state-evidence";
    caption.textContent = text;
    caption.style.cssText = "position:absolute;left:400px;top:8px;padding:4px;background:white;color:#a01020;font:12px sans-serif;z-index:99999;pointer-events:none";
    document.body.append(caption);
  }, `130% zoom · ${label} ${state}`);
  await page.screenshot({ path: `evidence/ac-4-${column}-${state}.png` });
  await page.evaluate(() => document.getElementById("column-state-evidence")?.remove());
}

test.beforeEach(async ({ page }) => {
  await seedSettings(page, {
    viewMode: "details", zoomLevel: 100,
    columnVisibility: { date: true, type: true, size: true },
  });
  await page.goto(HOME_URL);
  await waitForEntries(page);
});

for (const [index, zoom] of [80, 130, 100].entries()) {
  test(`Details column popup opens at pointer at ${zoom}%`, async ({ page }) => {
    await setZoom(page, zoom);
    const point = await openAtHeader(page);
    await expect.poll(async () => {
      const box = await menuBox(page);
      return Math.max(Math.abs(box.x - point.x), Math.abs(box.y - point.y));
    }).toBeLessThanOrEqual(2);
    await capturePlacement(page, point, zoom, `evidence/ac-${index + 1}-details-menu-${zoom}.png`);
  });
}

test("Details column popup stays onscreen and toggles all optional columns", async ({ page }) => {
  await setZoom(page, 130);
  const point = await openAtHeader(page, true);
  await expect.poll(async () => {
    const box = await menuBox(page);
    const viewport = page.viewportSize()!;
    return box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  }).toBe(true);
  await capturePlacement(page, point, 130, "evidence/ac-4-details-menu-edge.png");

  for (const [label, column] of [["Date modified", "date"], ["Type", "type"], ["Size", "size"]]) {
    const header = page.locator(`.column-headers .${column}-column`);
    const rows = page.locator(".file-rows .file-item");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(0);
    const cells = rows.locator(`.${column}-cell`);
    await expect(header).toBeVisible();
    await expect(cells).toHaveCount(rowCount);
    await expect(cells.first()).toBeVisible();
    await page.locator(".column-menu-item").filter({ hasText: label }).click();
    await expect(header).toHaveCount(0);
    await expect(cells).toHaveCount(0);
    await expect(page.locator(".column-menu")).toHaveCount(0);
    await captureColumnState(page, label, column, "hidden");
    await openAtHeader(page, true);
    await page.locator(".column-menu-item").filter({ hasText: label }).click();
    await expect(header).toBeVisible();
    await expect(cells).toHaveCount(rowCount);
    await expect(cells.first()).toBeVisible();
    await captureColumnState(page, label, column, "restored");
    await openAtHeader(page, true);
  }
  await page.locator(".column-menu-backdrop").click({ position: { x: 10, y: 10 } });
  await expect(page.locator(".column-menu")).toHaveCount(0);
});

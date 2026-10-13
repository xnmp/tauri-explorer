import { test, expect, type Page } from "./fixtures";
import { HOME_URL, pressShortcut, seedSettings, waitForEntries } from "./helpers";

async function setZoom(page: Page, zoom: number) {
  const key = zoom < 100 ? "-" : "=";
  for (let step = 0; step < Math.abs(zoom - 100) / 10; step++) {
    await pressShortcut(page, key, { ctrlKey: true });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(`${zoom}%`);
}

async function openMenuAt(page: Page, point: { x: number; y: number }) {
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.locator(".context-menu.revealed");
  await expect(menu).toBeVisible();
  return menu;
}

async function markPointer(page: Page, point: { x: number; y: number }, zoom: number) {
  // Headless screenshots omit the OS cursor; mark the real click point.
  await page.evaluate(({ point, zoom }) => {
    const scale = zoom / 100;
    const ring = document.createElement("div");
    ring.id = "placement-evidence";
    ring.style.cssText = `position:absolute;left:${point.x / scale}px;top:${point.y / scale}px;width:10px;height:10px;border:2px solid #d02030;border-radius:50%;transform:translate(-50%,-50%);z-index:99999;pointer-events:none`;
    const label = document.createElement("div");
    label.id = "placement-label";
    label.textContent = `${zoom}% zoom, Tiles Medium · red ring marks the right-click`;
    label.style.cssText = `position:absolute;left:${400 / scale}px;top:${8 / scale}px;padding:4px;background:white;color:#a01020;font:12px sans-serif;z-index:99999;pointer-events:none`;
    document.body.append(ring, label);
  }, { point, zoom });
}

test.beforeEach(async ({ page }) => {
  await seedSettings(page, { viewMode: "tiles", thumbnailSize: "medium", zoomLevel: 100 });
  await page.goto(HOME_URL);
  await waitForEntries(page);
});

for (const [index, zoom] of [120, 80].entries()) {
  test(`Tiles/Medium context menu opens at the pointer at ${zoom}% zoom`, async ({ page }) => {
    await setZoom(page, zoom);
    const viewport = page.viewportSize()!;
    // Far enough right that a mis-scaled conversion drifts well past tolerance,
    // but with room for the menu so the edge clamp stays out of the measurement.
    const point = { x: Math.round(viewport.width * 0.5), y: 120 };
    const menu = await openMenuAt(page, point);
    await expect.poll(async () => {
      const box = (await menu.boundingBox())!;
      return Math.max(Math.abs(box.x - point.x), Math.abs(box.y - point.y));
    }).toBeLessThanOrEqual(2);
    await markPointer(page, point, zoom);
    await page.screenshot({ path: `evidence/ac-${index + 1}-tiles-context-menu-${zoom}.png` });
  });
}

test("Tiles/Medium context menu stays fully on-screen near the bottom-right at 120%", async ({ page }) => {
  await setZoom(page, 120);
  const viewport = page.viewportSize()!;
  const point = { x: viewport.width - 40, y: viewport.height - 40 };
  const menu = await openMenuAt(page, point);
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!;
    return box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  }).toBe(true);
  await markPointer(page, point, 120);
  await page.screenshot({ path: "evidence/ac-3-tiles-context-menu-edge.png" });
});

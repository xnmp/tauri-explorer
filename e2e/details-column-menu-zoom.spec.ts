import { test, expect, type Page } from "./fixtures";
import { HOME_URL, pressShortcut, seedSettings, waitForEntries } from "./helpers";

async function openAtHeader(page: Page, edge = false) {
  const header = await page.locator(".column-headers").boundingBox();
  expect(header).not.toBeNull();
  const point = {
    x: edge ? header!.x + header!.width - 4 : header!.x + 120,
    y: header!.y + header!.height / 2,
  };
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.locator(".column-menu")).toBeVisible();
  return point;
}

async function menuBox(page: Page) {
  const box = await page.locator(".column-menu").boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function setZoom(page: Page, zoom: number) {
  const key = zoom < 100 ? "-" : "=";
  for (let step = 0; step < Math.abs(zoom - 100) / 10; step++) {
    await pressShortcut(page, key, { ctrlKey: true });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(`${zoom}%`);
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
    await page.screenshot({ path: `evidence/ac-${index + 1}-details-menu-${zoom}.png` });
  });
}

test("Details column popup stays onscreen and toggles all optional columns", async ({ page }) => {
  await setZoom(page, 130);
  await openAtHeader(page, true);
  await expect.poll(async () => {
    const box = await menuBox(page);
    const viewport = page.viewportSize()!;
    return box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
  }).toBe(true);
  await page.screenshot({ path: "evidence/ac-4-details-menu-edge.png" });

  for (const [label, column] of [["Date modified", "date"], ["Type", "type"], ["Size", "size"]]) {
    const header = page.locator(`.column-headers .${column}-column`);
    await expect(header).toBeVisible();
    await page.locator(".column-menu-item").filter({ hasText: label }).click();
    await expect(header).toHaveCount(0);
    await expect(page.locator(".column-menu")).toHaveCount(0);
    await openAtHeader(page, true);
    await page.locator(".column-menu-item").filter({ hasText: label }).click();
    await expect(header).toBeVisible();
    await openAtHeader(page, true);
  }
  await page.locator(".column-menu-backdrop").click({ position: { x: 10, y: 10 } });
  await expect(page.locator(".column-menu")).toHaveCount(0);
});

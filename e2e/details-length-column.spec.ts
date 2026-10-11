/**
 * Details view Length column (#995): video playback durations, column menu
 * visibility and resizing against the mock backend's `get_media_durations`.
 */
import { test, expect, type Page } from "./fixtures";
import { seedSettings } from "./helpers";

const EVIDENCE = "evidence";

async function openVideos(page: Page, settings: Record<string, unknown> = {}) {
  await seedSettings(page, { zoomLevel: 100, ...settings }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/?path=/home/user/Videos&viewMode=details");
  await expect(page.locator(".details-view .entry-item").first()).toBeVisible();
}

function lengthCell(page: Page, name: string) {
  return page.locator(`.details-view .entry-item[data-path="/home/user/Videos/${name}"] .length-cell`);
}

test("Length column is visible by default, even for settings saved before it existed", async ({ page }) => {
  // Legacy saved visibility has no `length` key.
  await openVideos(page, { columnVisibility: { date: true, type: true, size: true } });
  const header = page.locator(".details-view .column-header.length-column");
  await expect(header).toHaveText(/Length/i);
  await expect(lengthCell(page, "recording.mp4")).toHaveText("12:34");
  await page.screenshot({ path: `${EVIDENCE}/ac-1-length-column-default.png` });
});

test("video rows show m:ss / h:mm:ss; non-video rows stay blank", async ({ page }) => {
  await openVideos(page);
  await expect(lengthCell(page, "recording.mp4")).toHaveText("12:34");
  await expect(lengthCell(page, "tutorial.mkv")).toHaveText("1:02:05");
  await page.locator(".details-view").screenshot({ path: `${EVIDENCE}/ac-4-video-durations.png` });
  await expect(lengthCell(page, "soundtrack.mp3")).toHaveText("");
  await expect(lengthCell(page, "unreadable.avi")).toHaveText("");
  await expect(page.locator(".details-view .length-cell").filter({ hasText: /0:00|NaN/ })).toHaveCount(0);
});

test("directories and documents keep an empty Length cell", async ({ page }) => {
  await seedSettings(page, { zoomLevel: 100 }, { replace: true });
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/?path=/home/user/Documents&viewMode=details");
  const cells = page.locator(".details-view .entry-item .length-cell");
  await expect(page.locator(".details-view .entry-item").first()).toBeVisible();
  await expect(cells.first()).toBeAttached();
  await expect(page.locator(".details-view .column-header.length-column")).toBeVisible();
  expect(await cells.count()).toBeGreaterThanOrEqual(5);
  for (const text of await cells.allTextContents()) expect(text.trim()).toBe("");
  await page.locator(".details-view").screenshot({ path: `${EVIDENCE}/ac-5-blank-for-non-video.png` });
});

test("column menu toggles the Length column", async ({ page }) => {
  await openVideos(page);
  await page.locator(".details-view .column-headers").click({ button: "right" });
  const item = page.locator(".column-menu-item", { hasText: "Length" });
  await expect(item).toContainText("✓");
  // The header owns its right-click: the folder background menu stays closed.
  await expect(page.locator(".context-menu")).toHaveCount(0);
  await page.screenshot({ path: `${EVIDENCE}/ac-2-column-menu-length.png` });
  await item.click();
  await expect(page.locator(".details-view .column-header.length-column")).toHaveCount(0);
  await expect(page.locator(".details-view .length-cell")).toHaveCount(0);

  await page.locator(".details-view .column-headers").click({ button: "right" });
  await page.locator(".column-menu-item", { hasText: "Length" }).click();
  await expect(page.locator(".details-view .column-header.length-column")).toBeVisible();
  await expect(lengthCell(page, "recording.mp4")).toHaveText("12:34");
});

test("Length column resizes through its own separator", async ({ page }) => {
  await openVideos(page);
  const handle = page.getByRole("separator", { name: "Resize Length column" });
  const header = page.locator(".details-view .column-header-wrapper").filter({ has: page.locator(".length-column") });
  const cell = lengthCell(page, "recording.mp4");
  const before = (await header.boundingBox())!.width;
  const cellBefore = (await cell.boundingBox())!.width;
  await handle.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await header.boundingBox())!.width - before).toBeCloseTo(60, 0);
  await expect.poll(async () => (await cell.boundingBox())!.width - cellBefore).toBeCloseTo(60, 0);
  await page.locator(".details-view").screenshot({ path: `${EVIDENCE}/ac-3-length-column-resized.png` });
});

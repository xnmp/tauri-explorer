/**
 * Regression (#1040): previewing a huge folder must window its child list.
 *
 * The Preview pane rendered one `.folder-item` (with a FileIcon component) for
 * EVERY child of the selected folder, so selecting a folder with thousands of
 * entries mounted thousands of components and lagged the whole UI. Asserts the
 * observable outcome in a real browser: only a windowed slice of rows is in the
 * DOM, the first children show immediately, and the last entry is reachable.
 */
import { test, expect } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

// `/perf/huge-200` lists 200 entries; its `folder-00000` child is served by the
// mock as the default 5000-entry synthetic directory.
const PARENT = "/perf/huge-200";
const HUGE_CHILD = "folder-00000";

test.skip(({ browserName }) => browserName !== "chromium", "layout outcome; chromium is the calibrated engine");

test("previewing a 5000-entry folder renders a windowed slice of its children (#1040)", async ({ page }) => {
  await page.goto(`/?path=${PARENT}&viewMode=details`);
  await waitForEntries(page);

  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await expect(previewPane).toBeVisible();

  await page.locator(".entry-item", { hasText: HUGE_CHILD }).first().click();

  const list = page.locator(".preview-folder-list");
  const names = list.locator(".folder-item-name");
  // Directories sort first, so the huge folder's first child is its first folder.
  await expect(names.first()).toHaveText("folder-00000", { timeout: 10000 });
  await expect(names.first()).toBeVisible();

  // 5000 children exist; pre-fix every one rendered. A generous cap proves
  // windowing without being brittle to the preview pane's height.
  const rendered = await list.locator(".folder-item").count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(200);

  await page.screenshot({ path: "evidence/ac-1-large-folder-preview-windowed.png" });
  await previewPane.screenshot({ path: "evidence/ac-2-large-folder-first-children.png" });

  // Every child stays reachable: scrolling the list to the end renders the
  // last entry (names sort case-insensitively, so the highest-numbered image)
  // while the rendered slice stays small.
  await list.locator(".virtual-viewport").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(names.last()).toHaveText("image-04994.png");
  expect(await list.locator(".folder-item").count()).toBeLessThan(200);

  await page.screenshot({ path: "evidence/ac-3-large-folder-preview-last-entry.png" });
});

test("a single-root ZIP still shows the collapsed indicator above its windowed list (#1040)", async ({ page }) => {
  await page.goto("/?path=/home/user/Downloads&viewMode=details");
  await waitForEntries(page);

  const previewPane = page.locator(".preview-pane");
  if (!(await previewPane.isVisible())) {
    await pressShortcut(page, " ", {});
  }
  await expect(previewPane).toBeVisible();

  await page.locator(".entry-item", { hasText: "bundle.zip" }).first().click();

  const list = page.locator(".preview-folder-list");
  const indicator = list.locator(".collapsed-root-indicator");
  await expect(indicator.locator(".collapsed-root-name")).toHaveText("bundle/");
  // The indicator sits above the rows, outside the scrolling viewport.
  await expect(list.locator(".virtual-viewport .collapsed-root-indicator")).toHaveCount(0);
  await expect(list.locator(".folder-item-name").first()).toBeVisible();

  await previewPane.screenshot({ path: "evidence/ac-4-zip-collapsed-indicator.png" });
});

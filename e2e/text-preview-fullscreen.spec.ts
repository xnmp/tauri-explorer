/**
 * E2E: fullscreen Preview of text files (#1039).
 *
 * Arrowing from an image to a text file must show the text at its docked
 * on-screen size even under an app zoom (fullscreen cancels the root zoom for
 * images), and the mouse wheel zooms the text like it zooms an image.
 */
import { test, expect, type Page } from "./fixtures";
import { waitForEntries, pressShortcut } from "./helpers";

const TEXT = Array.from({ length: 120 }, (_, i) => `Day ${i + 1}: beach`).join("\n");

async function open(page: Page, appZoom: number) {
  await page.addInitScript((text) => {
    ((globalThis as { __mockControl?: Record<string, unknown> }).__mockControl ??= {}).previewReadText = () => text;
  }, TEXT);
  await page.goto("/?path=/home/user/Pictures/vacation");
  await waitForEntries(page);
  if (!(await page.locator(".preview-pane").isVisible())) await pressShortcut(page, " ", {});
  for (let step = 0; step < (appZoom - 100) / 10; step++) await pressShortcut(page, "=", { ctrlKey: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(`${appZoom}%`);
}

/** On-screen height of the first character: font size times every zoom above it. */
const glyphHeight = (page: Page) =>
  page.locator(".preview-text").evaluate((pre) => {
    const range = document.createRange();
    range.setStart(pre.firstChild!, 0);
    range.setEnd(pre.firstChild!, 1);
    return range.getBoundingClientRect().height;
  });

async function fullscreenText(page: Page) {
  await page.locator(".entry-item").filter({ hasText: "beach.jpg" }).first().click();
  await expect(page.locator(".preview-image")).toBeVisible();
  await page.locator(".preview-image").click();
  await expect(page.locator(".preview-pane")).toHaveClass(/fullscreen/);
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".preview-text")).toBeVisible();
}

test.describe("Fullscreen text preview", () => {
  for (const appZoom of [100, 150]) {
    test(`text reached by arrowing from an image keeps its docked size at ${appZoom}% app zoom`, async ({ page }) => {
      await open(page, appZoom);
      await page.locator(".entry-item").filter({ hasText: "itinerary.txt" }).first().click();
      await expect(page.locator(".preview-text")).toBeVisible();
      const docked = await glyphHeight(page);

      await fullscreenText(page);
      expect(await glyphHeight(page)).toBeCloseTo(docked, 0);
    });
  }

  test("the wheel zooms the text and shows the percentage; the keys still step", async ({ page }) => {
    await open(page, 100);
    await fullscreenText(page);
    const base = await glyphHeight(page);
    const pane = page.locator(".preview-pane");
    await expect(pane.locator(".fs-text-zoom-indicator")).toHaveText("100%");

    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -100);
    await expect(pane.locator(".fs-text-zoom-indicator")).toHaveText("115%");
    expect(await glyphHeight(page)).toBeCloseTo(base * 1.15, 0);

    // A zoomed image would pan on ArrowRight; zoomed text still steps on.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".preview-image")).toHaveAttribute("alt", "sunset.png");
    await expect(pane).toHaveClass(/fullscreen/);
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".preview-text")).toBeVisible();
    // Stepping resets the zoom.
    await expect(pane.locator(".fs-text-zoom-indicator")).toHaveText("100%");
    expect(await glyphHeight(page)).toBeCloseTo(base, 0);

    await page.mouse.wheel(0, 100);
    await expect(pane.locator(".fs-text-zoom-indicator")).toHaveText("100%");
  });

  test("Up/Down scroll the long text and the wheel does not", async ({ page }) => {
    await open(page, 100);
    await fullscreenText(page);
    const content = page.locator(".preview-content");
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 100);
    expect(await content.evaluate((el) => el.scrollTop)).toBe(0);
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  });

  test("the docked text pane still scrolls with the wheel", async ({ page }) => {
    await open(page, 100);
    await page.locator(".entry-item").filter({ hasText: "itinerary.txt" }).first().click();
    const content = page.locator(".preview-content");
    await expect(page.locator(".preview-text")).toBeVisible();
    const box = (await content.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 200);
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator(".preview-pane")).not.toHaveClass(/fullscreen/);
  });
});

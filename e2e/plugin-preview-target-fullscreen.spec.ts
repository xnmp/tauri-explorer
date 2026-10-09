/**
 * E2E: fullscreen for plugin Preview targets (#1033).
 *
 * An unsaved generated image exists only in a plugin's temp directory and is
 * shown through a Preview target, not as a file. It fullscreens like a file
 * image: double-click on the pane or click at fit zoom, Esc exits, +/-/0 and
 * the wheel zoom, and the window chrome and the target's actions hide. The
 * pane shows a 1024px thumbnail; fullscreen shows the full-resolution image.
 * The demo plugin's "Virtual card" target supplies the subject.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, runPaletteCommand, waitForEntries } from "./helpers";

/** Directory for the PR screenshots; unset in normal runs. */
const SHOTS = process.env.TARGET_FULLSCREEN_SHOTS;
const TARGET_PATH = "/home/user/Pictures/screenshot.png";
const FULL_WIDTH = 2400;
const FULL_HEIGHT = 1600;

/** Serves a 2400×1600 image from the backend full-image read, recording each requested path. */
async function installFullResolutionImage(page: Page): Promise<void> {
  await page.addInitScript(([width, height]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2f6f4f";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#f2d16b";
    context.fillRect(width / 4, height / 4, width / 2, height / 2);
    const url = canvas.toDataURL("image/png");
    const w = globalThis as { __fullReads?: string[]; __mockControl?: { previewReadImage?: (path: string) => string } };
    w.__fullReads = [];
    (w.__mockControl ??= {}).previewReadImage = (path) => {
      w.__fullReads!.push(path);
      return url;
    };
  }, [FULL_WIDTH, FULL_HEIGHT]);
}

async function showVirtualCard(page: Page) {
  await installFullResolutionImage(page);
  await page.goto("/?path=/home/user");
  await applySettingsAndReload(page, { showPreviewPane: true, showPreviewInfo: true, integratedTitleBar: true, pluginsEnabled: { demo: true } });
  await waitForEntries(page);
  await runPaletteCommand(page, "Demo: Toggle Cards View");
  const view = page.getByTestId("demo-file-view");
  await expect(view).toBeVisible();
  await view.getByRole("button", { name: "Virtual card" }).click();
  const pane = page.locator(".preview-pane");
  const image = pane.locator("img.preview-image");
  await expect(image).toHaveAttribute("alt", "Virtual card");
  await expect.poll(() => naturalWidth(image)).toBeGreaterThan(0);
  return { pane, image };
}

function naturalWidth(image: ReturnType<Page["locator"]>): Promise<number> {
  return image.evaluate((element: HTMLImageElement) => element.naturalWidth);
}

function fullReads(page: Page): Promise<string[]> {
  return page.evaluate(() => (globalThis as { __fullReads?: string[] }).__fullReads ?? []);
}

test.describe("Plugin Preview target fullscreen", () => {
  test("double-click shows the target's full-resolution image fullscreen; Esc exits", async ({ page }) => {
    const { pane, image } = await showVirtualCard(page);

    // In the pane: the 1024px thumbnail, and no full-resolution read yet.
    expect(await naturalWidth(image)).toBeLessThanOrEqual(1024);
    expect(await fullReads(page)).toEqual([]);
    await expect(pane.getByRole("button", { name: "Greet" })).toBeVisible();
    await expect(page.locator(".titlebar")).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/plugin-target-in-pane.png` });

    // Double-click on the pane (its header) toggles fullscreen.
    await pane.locator(".preview-header").dblclick();
    await expect(pane).toHaveClass(/fullscreen/);
    await expect(page.locator("html")).toHaveAttribute("data-preview-fullscreen", "");
    await expect(page.locator(".titlebar")).toBeHidden();
    // The target's chrome hides like a file's.
    await expect(pane.locator(".preview-header")).toBeHidden();
    await expect(pane.getByRole("button", { name: "Greet" })).toBeHidden();
    await expect(pane.locator(".preview-info")).toBeHidden();
    await expect(pane.getByTestId("demo-preview-info")).toBeHidden();

    // The full-resolution image, read from the target's own path.
    await expect.poll(() => naturalWidth(image)).toBe(FULL_WIDTH);
    expect(await image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(FULL_HEIGHT);
    expect(await fullReads(page)).toEqual([TARGET_PATH]);
    // It fits the screen, centred.
    const viewport = page.viewportSize()!;
    const box = (await image.boundingBox())!;
    expect(Math.max(box.width / viewport.width, box.height / viewport.height)).toBeCloseTo(1, 2);
    expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/plugin-target-fullscreen.png` });

    await page.keyboard.press("Escape");
    await expect(pane).not.toHaveClass(/fullscreen/);
    await expect(page.locator("html")).not.toHaveAttribute("data-preview-fullscreen", "");
    await expect(page.locator(".titlebar")).toBeVisible();
    await expect(pane.getByRole("button", { name: "Greet" })).toBeVisible();
    await expect(pane.getByTestId("demo-preview-info")).toHaveText("Demo info: Virtual card");
    // The target is still previewed.
    await expect(image).toHaveAttribute("alt", "Virtual card");
  });

  test("zoom and pan work in fullscreen; Left/Right do nothing at fit zoom", async ({ page }) => {
    const { pane, image } = await showVirtualCard(page);

    // A clean click on the image at fit zoom also enters fullscreen.
    await image.click();
    await expect(pane).toHaveClass(/fullscreen/);
    const indicator = pane.locator(".fs-zoom-indicator");
    await expect(indicator).toHaveText("100%");

    // Left/Right at fit zoom: no sibling stepping for a target.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect(pane).toHaveClass(/fullscreen/);
    await expect(image).toHaveAttribute("alt", "Virtual card");
    await expect(page.getByTestId("demo-file-view").locator(".card.selected")).toHaveText("Virtual card");

    await page.keyboard.press("+");
    await expect(indicator).toHaveText("125%");
    await expect(image).toHaveClass(/zoomed/);
    await expect(image).toHaveAttribute("style", /scale\(1\.25\)/);
    const before = (await image.boundingBox())!;

    // Arrows pan while zoomed: Left moves the image right.
    await page.keyboard.press("ArrowLeft");
    await expect(image).toHaveAttribute("style", /translate\(60px(, 0px)?\) scale\(1\.25\)/);

    // A click while zoomed stays fullscreen.
    await image.click();
    await expect(pane).toHaveClass(/fullscreen/);

    // The wheel zooms in further.
    const centre = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, -120);
    await expect(indicator).toHaveText("144%");
    expect((await image.boundingBox())!.width).toBeGreaterThan(before.width);

    await page.keyboard.press("0");
    await expect(indicator).toHaveText("100%");
    await expect(image).not.toHaveClass(/zoomed/);

    // At fit zoom a click leaves fullscreen.
    await image.click();
    await expect(pane).not.toHaveClass(/fullscreen/);
  });

  test("a file image still fullscreens, zooms and steps between siblings", async ({ page }) => {
    await installFullResolutionImage(page);
    await page.goto("/?path=/home/user/Pictures");
    await applySettingsAndReload(page, { showPreviewPane: true, showPreviewInfo: true, pluginsEnabled: { demo: true } });
    await waitForEntries(page);
    await page.locator(".entry-item").filter({ hasText: "photo1.jpg" }).first().click();
    const pane = page.locator(".preview-pane");
    await expect(pane.getByTestId("demo-preview-info")).toHaveText("Demo info: photo1.jpg");
    const image = pane.locator("img.preview-image");
    await expect(image).toHaveAttribute("alt", "photo1.jpg");
    await expect.poll(() => naturalWidth(image)).toBe(FULL_WIDTH);

    await pane.locator(".preview-header").dblclick();
    await expect(pane).toHaveClass(/fullscreen/);
    await expect(page.locator("html")).toHaveAttribute("data-preview-fullscreen", "");
    await expect(pane.locator(".preview-header")).toBeHidden();
    // Plugin Preview-info sections hide in fullscreen too.
    await expect(pane.getByTestId("demo-preview-info")).toBeHidden();

    await page.keyboard.press("=");
    await expect(pane.locator(".fs-zoom-indicator")).toHaveText("125%");
    await page.keyboard.press("-");
    await expect(pane.locator(".fs-zoom-indicator")).toHaveText("100%");

    await page.keyboard.press("ArrowRight");
    await expect(image).toHaveAttribute("alt", "photo2.jpg");
    await expect(pane).toHaveClass(/fullscreen/);

    await page.keyboard.press("Escape");
    await expect(pane).not.toHaveClass(/fullscreen/);
    await expect(page.locator("html")).not.toHaveAttribute("data-preview-fullscreen", "");
    await expect(pane.getByTestId("demo-preview-info")).toHaveText("Demo info: photo2.jpg");
  });
});

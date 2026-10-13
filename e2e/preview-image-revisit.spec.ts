/**
 * E2E (#1014): going back to an image the Preview pane already showed is
 * immediate. photo1's read is deliberately slow, so its first visit shows the
 * spinner; the revisit must show photo1 again without a busy frame or another
 * read. A changed file (new mtime/size) is read again and the new image shown.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const PHOTO1 = "/home/user/Pictures/photo1.jpg";
const SLOW_READ_MS = 1500;

interface Probe {
  __previewReads: Record<string, number>;
  __frames: Array<{ busy: boolean; spinner: boolean; src: string | null }>;
}

/** photo1 reads slowly (1536 px wide, 1200 px after its first read); others read at once. */
async function installImages(page: Page): Promise<void> {
  await page.addInitScript((slowMs) => {
    const image = (color: string, width: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.round((width * 2) / 3);
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    };
    const w = window as unknown as Probe & { __mockControl?: MockControl };
    const reads: Record<string, number> = {};
    w.__previewReads = reads;
    (w.__mockControl ??= {}).previewReadImage = (path) => {
      reads[path] = (reads[path] ?? 0) + 1;
      if (!path.endsWith("photo1.jpg")) return image("#ff7c4a", 1536);
      const data = reads[path] === 1 ? image("#4a7cff", 1536) : image("#3fbf6f", 1200);
      return new Promise((resolve) => setTimeout(() => resolve(data), slowMs));
    };
  }, SLOW_READ_MS);
}

const preview = (page: Page) => page.locator(".preview-pane");
const shownImage = (page: Page) => preview(page).locator("img.preview-image");
const readsOf = (page: Page, path: string) =>
  page.evaluate((target) => (window as unknown as Probe).__previewReads[target] ?? 0, path);

async function select(page: Page, name: string): Promise<void> {
  await page.locator(".entry-item", { hasText: name }).first().click();
}

/** Records every animation frame's busy/spinner state and image source while `act` runs. */
async function framesDuring(page: Page, act: () => Promise<void>): Promise<Probe["__frames"]> {
  await page.evaluate(() => {
    const frames: Probe["__frames"] = [];
    (window as unknown as Probe).__frames = frames;
    const tick = () => {
      const content = document.querySelector(".preview-pane .preview-content");
      frames.push({
        busy: content?.getAttribute("aria-busy") === "true",
        spinner: document.querySelector(".preview-pane .preview-loading") !== null,
        src: document.querySelector(".preview-pane img.preview-image")?.getAttribute("src") ?? null,
      });
      if (frames.length < 45) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  await expect.poll(() => page.evaluate(() => (window as unknown as Probe).__frames.length), { timeout: 5000 }).toBe(45);
  return page.evaluate(() => (window as unknown as Probe).__frames);
}

test.describe("Revisiting a previewed image (#1014)", () => {
  test.beforeEach(async ({ page }) => {
    await installImages(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/?path=/home/user/Pictures");
    await applySettingsAndReload(page, { showPreviewPane: true, previewPanePosition: "right", previewPaneWidth: 420 });
    await waitForEntries(page);
  });

  test("going back to a slow image shows it at once, without the spinner or another read", async ({ page }) => {
    await select(page, "photo1.jpg");
    // The first visit is slow: the deferred spinner shows.
    await expect(preview(page).locator(".preview-loading .spinner")).toBeVisible();
    await expect(preview(page).locator(".preview-content")).toHaveAttribute("aria-busy", "false", { timeout: 5000 });
    await expect.poll(() => shownImage(page).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
    const firstSrc = await shownImage(page).getAttribute("src");

    await select(page, "photo2.jpg");
    await expect(shownImage(page)).not.toHaveAttribute("src", firstSrc!);
    await expect(preview(page).locator(".preview-content")).toHaveAttribute("aria-busy", "false");

    const frames = await framesDuring(page, () => select(page, "photo1.jpg"));
    expect(frames.filter((frame) => frame.busy || frame.spinner), `busy frames: ${JSON.stringify(frames)}`).toEqual([]);
    expect(frames.at(-1)?.src).toBe(firstSrc);
    await expect(shownImage(page)).toHaveAttribute("src", firstSrc!);
    expect(await readsOf(page, PHOTO1)).toBe(1);

    // Arrow keys revisit the same way.
    await page.keyboard.press("ArrowDown");
    await expect(shownImage(page)).not.toHaveAttribute("src", firstSrc!);
    await page.keyboard.press("ArrowUp");
    await expect(shownImage(page)).toHaveAttribute("src", firstSrc!);
    await expect(preview(page).locator(".preview-content")).toHaveAttribute("aria-busy", "false");
    expect(await readsOf(page, PHOTO1)).toBe(1);
  });

  test("an image changed on disk since its last preview is read again and shows the new image", async ({ page }) => {
    await select(page, "photo1.jpg");
    await expect.poll(() => shownImage(page).evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 5000 }).toBe(1536);
    const firstSrc = await shownImage(page).getAttribute("src");
    await select(page, "photo2.jpg");
    await expect(shownImage(page)).not.toHaveAttribute("src", firstSrc!);

    await page.evaluate((target) => (window as unknown as { __mockControl?: MockControl }).__mockControl?.previewRevision?.(target), PHOTO1);
    await page.keyboard.press("F5");
    await waitForEntries(page);
    await select(page, "photo1.jpg");

    await expect.poll(() => readsOf(page, PHOTO1)).toBe(2);
    await expect.poll(() => shownImage(page).evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 5000 }).toBe(1200);
    await expect(shownImage(page)).not.toHaveAttribute("src", firstSrc!);
  });
});

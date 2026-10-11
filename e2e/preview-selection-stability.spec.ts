/**
 * E2E: changing the selected image does not blank or move the Preview, and
 * plugin Preview-info sections share the host's horizontal inset.
 *
 * Image to image, the previous image stays on screen until the next one is
 * decoded; blanking it for the decode emptied the content area and re-laid
 * out the pane for those frames.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";

type Dock = "right" | "bottom" | "top";

/** photo1 and photo2 get distinct 3:2 images; photo2's read takes `delay` ms or fails. */
async function installImages(page: Page, delay: number, failSecond = false): Promise<void> {
  await page.addInitScript(({ delay, failSecond }) => {
    const image = (color: string) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1536;
      canvas.height = 1024;
      const context = canvas.getContext("2d")!;
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png");
    };
    const first = image("#4a7cff");
    const second = image("#ff7c4a");
    ((globalThis as { __mockControl?: { previewReadImage?: (path: string) => string | Promise<string> } }).__mockControl ??= {}).previewReadImage = (path) => {
      if (!path.includes("photo2")) return first;
      return new Promise((resolve, reject) => setTimeout(() => (failSecond ? reject(new Error("unreadable")) : resolve(second)), delay));
    };
  }, { delay, failSecond });
}

async function open(page: Page, dock: Dock): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, {
    showPreviewPane: true,
    showPreviewInfo: true,
    previewPanePosition: dock,
    previewPaneHeight: 480,
    previewPaneWidth: 380,
    pluginsEnabled: { demo: true },
  });
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "photo1.jpg" }).first().click();
  await expect(page.locator(".preview-pane img.preview-image")).toBeVisible();
  await expect.poll(() => page.locator(".preview-pane img.preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
}

/** Per-frame image box while photo2 is selected and loads. */
async function framesWhileSelectingSecond(page: Page): Promise<Array<string | null>> {
  await page.evaluate(() => {
    const frames: Array<string | null> = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const tick = () => {
      const image = document.querySelector(".preview-pane img.preview-image");
      const box = image?.getBoundingClientRect();
      frames.push(box && box.height > 0 ? `${Math.round(box.top)}:${Math.round(box.height)}` : null);
      if (frames.length < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.locator(".entry-item", { hasText: "photo2.jpg" }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __frames: unknown[] }).__frames.length), { timeout: 5000 }).toBe(40);
  return page.evaluate(() => (window as unknown as { __frames: Array<string | null> }).__frames);
}

test.describe("Preview stability when the selection changes", () => {
  for (const dock of ["right", "bottom"] as const) {
    test(`switching images in the ${dock} dock keeps an image in place in every frame`, async ({ page }) => {
      await installImages(page, 120);
      await open(page, dock);
      const before = await page.locator(".preview-pane img.preview-image").getAttribute("src");
      const frames = await framesWhileSelectingSecond(page);
      expect(frames.filter((frame) => frame === null), `frames without an image: ${JSON.stringify(frames)}`).toEqual([]);
      expect(new Set(frames).size, `image boxes: ${JSON.stringify([...new Set(frames)])}`).toBe(1);
      await expect(page.locator(".preview-pane img.preview-image")).not.toHaveAttribute("src", before!);
      await expect(page.locator(".preview-pane .preview-content")).toHaveAttribute("aria-busy", "false");
    });
  }

  test("a slow next image shows the spinner over the previous one", async ({ page }) => {
    await installImages(page, 1200);
    await open(page, "right");
    const pane = page.locator(".preview-pane");
    const before = await pane.locator("img.preview-image").getAttribute("src");
    await page.locator(".entry-item", { hasText: "photo2.jpg" }).first().click();
    await expect(pane.locator(".preview-content")).toHaveAttribute("aria-busy", "true");
    await expect(pane.locator(".preview-loading .spinner")).toBeVisible();
    await expect(pane.locator("img.preview-image")).toHaveAttribute("src", before!);
    await expect(pane.locator(".preview-loading")).toHaveCount(0, { timeout: 5000 });
    await expect(pane.locator("img.preview-image")).not.toHaveAttribute("src", before!);
  });

  test("when the next image cannot be read, the previous image gives way to the error", async ({ page }) => {
    await installImages(page, 60, true);
    await open(page, "right");
    await page.locator(".entry-item", { hasText: "photo2.jpg" }).first().click();
    const pane = page.locator(".preview-pane");
    await expect(pane.locator(".preview-error-text")).toHaveText("Cannot preview image");
    await expect(pane.locator("img.preview-image")).toHaveCount(0);
  });

  test("switching from an image to a text file does not keep the image", async ({ page }) => {
    await installImages(page, 0);
    await page.addInitScript(() => {
      ((globalThis as { __mockControl?: { previewReadText?: (path: string) => string } }).__mockControl ??= {}).previewReadText = () => "Day 1: beach";
    });
    await open(page, "right");
    await page.goto("/?path=/home/user/Pictures/vacation");
    await waitForEntries(page);
    await page.locator(".entry-item", { hasText: "beach.jpg" }).first().click();
    await expect(page.locator(".preview-pane img.preview-image")).toBeVisible();
    await page.locator(".entry-item", { hasText: "itinerary.txt" }).first().click();
    await expect(page.locator(".preview-pane .preview-text")).toContainText("Day 1: beach");
    await expect(page.locator(".preview-pane img.preview-image")).toHaveCount(0);
  });
});

test.describe("Plugin Preview-info sections", () => {
  for (const dock of ["right", "bottom", "top"] as const) {
    test(`share the host's inset in the ${dock} dock`, async ({ page }) => {
      await installImages(page, 0);
      await open(page, dock);
      const left = await page.locator(".preview-pane").evaluate((pane) => {
        const textLeft = (element: Element) => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects()[0].left; };
        return {
          name: textLeft(pane.querySelector(".preview-filename")!),
          label: textLeft(pane.querySelector(".info-label")!),
          section: textLeft(pane.querySelector("[data-testid=demo-preview-info]")!),
        };
      });
      expect(left.section).toBeCloseTo(left.name, 0);
      if (dock === "right") expect(left.section).toBeCloseTo(left.label, 0);
    });
  }
});

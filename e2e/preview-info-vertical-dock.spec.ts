/**
 * E2E: plugin Preview-info sections in a vertical (bottom/top) preview dock.
 *
 * A Preview-info section must take the height its content needs — no inner
 * scrollbar at a normal dock size — and the image must follow the info
 * directly instead of leaving dead space between them. The right dock keeps
 * its stacked layout, and an image larger than the remaining space still
 * scales down to fit.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, runPaletteCommand, waitForEntries } from "./helpers";

const SHOTS = process.env.PREVIEW_INFO_SHOTS;
type Dock = "bottom" | "top" | "right";

async function installLargeImage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1536;
    canvas.height = 1024;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#4a7cff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    ((globalThis as { __mockControl?: { previewReadImage?: (path: string) => string } }).__mockControl ??= {}).previewReadImage = () => url;
  });
}

async function openDocked(page: Page, dock: Dock, size: number): Promise<void> {
  await installLargeImage(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, {
    showPreviewPane: true,
    showPreviewInfo: true,
    previewPanePosition: dock,
    previewPaneHeight: size,
    previewPaneWidth: size,
    pluginsEnabled: { demo: true },
  });
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "screenshot.png" }).first().click();
  const pane = page.locator(".preview-pane");
  await expect(pane.getByTestId("demo-preview-info")).toHaveText("Demo info: screenshot.png");
  await expect(pane.locator("img.preview-image")).toBeAttached();
  await expect.poll(() => pane.locator("img.preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
}

interface Measured {
  sectionsOverflow: number;
  infoTop: number;
  infoBottom: number;
  imageTop: number;
  imageBottom: number;
  imageLeft: number;
  imageRight: number;
  paneTop: number;
  paneBottom: number;
  paneLeft: number;
  paneRight: number;
}

async function measure(page: Page): Promise<Measured> {
  return page.locator(".preview-pane").evaluate((pane) => {
    const rect = (selector: string) => pane.querySelector(selector)!.getBoundingClientRect();
    const sections = pane.querySelector<HTMLElement>(".preview-sections")!;
    const info = [...pane.querySelectorAll(":scope > :is(.preview-info, .preview-sections)")].map((element) => element.getBoundingClientRect());
    const chrome = [...pane.querySelectorAll(":scope > :is(.preview-header, .preview-info, .preview-sections, .target-actions-area)")]
      .map((element) => element.getBoundingClientRect());
    const infoTop = Math.min(...info.map((box) => box.top));
    const infoBottom = Math.max(...chrome.map((box) => box.bottom));
    const image = rect("img.preview-image");
    const box = pane.getBoundingClientRect();
    return {
      sectionsOverflow: sections.scrollHeight - sections.clientHeight,
      infoTop,
      infoBottom,
      imageTop: image.top,
      imageBottom: image.bottom,
      imageLeft: image.left,
      imageRight: image.right,
      paneTop: box.top,
      paneBottom: box.bottom,
      paneLeft: box.left,
      paneRight: box.right,
    };
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.locator(".preview-pane").screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe("Preview-info sections in a vertical dock", () => {
  for (const dock of ["bottom", "top"] as const) {
    test(`the ${dock} dock fits the section without a scrollbar and puts the image right after it`, async ({ page }) => {
      await openDocked(page, dock, 480);
      await expect(page.locator(".preview-pane img.preview-image")).toBeVisible();
      await shoot(page, `vertical-${dock}`);
      const m = await measure(page);
      expect(m.sectionsOverflow, "the info section must not scroll at a normal dock size").toBeLessThanOrEqual(1);
      expect(m.imageTop - m.infoBottom, "no dead space between the info and the image").toBeLessThanOrEqual(32);
      expect(m.imageTop).toBeGreaterThanOrEqual(m.infoBottom);
      // The 1024px-tall image scales down into the space left below the info.
      expect(m.imageBottom).toBeLessThanOrEqual(m.paneBottom + 0.5);
      expect(m.imageBottom - m.imageTop).toBeLessThan(1024);
    });
  }

  test("a plugin Preview target in the bottom dock lays out like a file", async ({ page }) => {
    await openDocked(page, "bottom", 480);
    await runPaletteCommand(page, "Demo: Toggle Cards View");
    const pane = page.locator(".preview-pane");
    await page.getByTestId("demo-file-view").getByRole("button", { name: "Virtual card" }).click();
    await expect(pane.getByTestId("demo-preview-info")).toHaveText("Demo info: Virtual card");
    await expect(pane.locator("img.preview-image")).toBeVisible();
    await shoot(page, "vertical-bottom-target");
    const m = await measure(page);
    expect(m.sectionsOverflow).toBeLessThanOrEqual(1);
    expect(m.imageTop - m.infoBottom).toBeLessThanOrEqual(32);
    expect(m.imageTop).toBeGreaterThanOrEqual(m.infoBottom);
    expect(m.imageBottom).toBeLessThanOrEqual(m.paneBottom + 0.5);
    // Name and details share the first row, as for a file.
    const [header, info] = await Promise.all([pane.locator(":scope > .preview-header").boundingBox(), pane.locator(":scope > .preview-info").boundingBox()]);
    expect(Math.abs(header!.y - info!.y)).toBeLessThanOrEqual(1);
    expect(info!.x).toBeGreaterThan(header!.x);
    await expect(pane.getByRole("button", { name: "Greet" })).toBeVisible();
  });

  for (const subject of ["file", "target"] as const) {
    test(`a dock too small for the ${subject}'s info scrolls only the section and keeps a usable image`, async ({ page }) => {
      // 240px is the default vertical dock height: too short for the name row,
      // the whole section and the image at once.
      await openDocked(page, "bottom", 240);
      if (subject === "target") {
        await runPaletteCommand(page, "Demo: Toggle Cards View");
        await page.getByTestId("demo-file-view").getByRole("button", { name: "Virtual card" }).click();
        await expect(page.locator(".preview-pane").getByTestId("demo-preview-info")).toHaveText("Demo info: Virtual card");
      }
      await expect(page.locator(".preview-pane img.preview-image")).toBeVisible();
      await shoot(page, `vertical-bottom-small-${subject}`);
      const m = await measure(page);
      const paneOverflow = await page.locator(".preview-pane").evaluate((pane) => pane.scrollHeight - pane.clientHeight);
      expect(m.sectionsOverflow, "the section is the one scroll container").toBeGreaterThan(0);
      expect(paneOverflow, "nothing else overflows the dock").toBeLessThanOrEqual(1);
      expect(m.imageBottom - m.imageTop, "the image keeps a usable height").toBeGreaterThanOrEqual(48);
      expect(m.imageTop).toBeGreaterThanOrEqual(m.infoBottom);
      expect(m.imageBottom).toBeLessThanOrEqual(m.paneBottom + 0.5);
    });
  }

  test("the right dock keeps the image above the info, scaled to fit", async ({ page }) => {
    await openDocked(page, "right", 420);
    await expect(page.locator(".preview-pane img.preview-image")).toBeVisible();
    await shoot(page, "right");
    const m = await measure(page);
    expect(m.sectionsOverflow).toBeLessThanOrEqual(1);
    // The image sits above the size/modified rows and the section, scaled
    // into the pane's width.
    expect(m.imageBottom).toBeLessThanOrEqual(m.infoTop);
    expect(m.imageRight - m.imageLeft).toBeLessThanOrEqual(m.paneRight - m.paneLeft);
    expect(m.imageTop).toBeGreaterThanOrEqual(m.paneTop);
  });
});

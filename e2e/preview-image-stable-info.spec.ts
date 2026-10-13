/**
 * E2E: in the side dock the image's box does not depend on how much Preview
 * info the selected file has. Stepping through same-size images used to move
 * and resize the image because the info sections shared the pane with it.
 * Info taller than its region scrolls inside the region.
 */
import { test, expect, type Page } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";

async function open(page: Page): Promise<void> {
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
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, {
    showPreviewPane: true,
    showPreviewInfo: true,
    previewPanePosition: "right",
    previewPaneWidth: 380,
    pluginsEnabled: { demo: true },
  });
  await waitForEntries(page);
  await page.locator(".entry-item", { hasText: "photo1.jpg" }).first().click();
  await expect(page.locator(".preview-pane").getByTestId("demo-preview-info")).toHaveText("Demo info: photo1.jpg");
  await expect.poll(() => page.locator(".preview-pane img.preview-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
}

const imageRect = (page: Page) =>
  page.locator(".preview-pane img.preview-image").evaluate((img) => {
    const r = img.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map(Math.round);
  });

/** Make the Demo section as tall as a long prompt would, in place. */
const growInfo = (page: Page, px: number) =>
  page.getByTestId("demo-preview-section").evaluate((section, height) => {
    const filler = document.createElement("div");
    filler.dataset.testid = "filler";
    filler.style.height = `${height}px`;
    section.appendChild(filler);
  }, px);

test.describe("Preview image is independent of Preview info height (side dock)", () => {
  test("the image rect is identical whether the info is short or very tall", async ({ page }) => {
    await open(page);
    const short = await imageRect(page);
    await growInfo(page, 900);
    await expect(page.getByTestId("filler")).toBeAttached();
    expect(await imageRect(page)).toEqual(short);
    // And across a real selection change.
    await page.locator(".entry-item", { hasText: "photo2.jpg" }).first().click();
    await expect(page.locator(".preview-pane").getByTestId("demo-preview-info")).toHaveText("Demo info: photo2.jpg");
    await expect(page.locator(".preview-pane .preview-content")).toHaveAttribute("aria-busy", "false");
    expect(await imageRect(page)).toEqual(short);
  });

  test("long info is reachable by scrolling its own region", async ({ page }) => {
    await open(page);
    await growInfo(page, 900);
    const sections = page.locator(".preview-pane .preview-sections");
    const metrics = await sections.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(metrics.scroll).toBeGreaterThan(metrics.client);
    await sections.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(page.getByTestId("filler")).toBeInViewport();
    const paneOverflow = await page.locator(".preview-pane").evaluate((pane) => pane.scrollHeight - pane.clientHeight);
    expect(paneOverflow).toBeLessThanOrEqual(1);
  });
});

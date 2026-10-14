/**
 * E2E: the Preview info shows an image's pixel size and updates it when the
 * selection moves to another image (#1118). Set CAPTURE_EVIDENCE to commit
 * screenshots under evidence/.
 */
import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";
import type { MockControl } from "../src/lib/api/mock-control";

const DIR = "/home/preview-containment";

test("preview info shows the selected image's pixel size and follows selection", async ({ page }) => {
  await page.addInitScript(() => {
    const png = (width: number, height: number) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#4a7cff";
      context.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/png");
    };
    ((globalThis as { __mockControl?: MockControl }).__mockControl ??= {}).previewReadImage = (path) =>
      path.endsWith("tall.png") ? png(300, 4000) : png(4000, 300);
  });
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.goto(`/?path=${DIR}`);
  await applySettingsAndReload(page, { showPreviewPane: true, showPreviewInfo: true, previewPanePosition: "right" });
  await waitForEntries(page);

  const row = page.locator(".preview-pane .preview-info .info-row", { hasText: "Pixels" });
  const shot = (name: string) =>
    process.env.CAPTURE_EVIDENCE
      ? page.screenshot({ path: `evidence/1118-${name}.png` })
      : Promise.resolve(undefined);

  await page.locator(`[data-path="${DIR}/panorama.png"]`).click();
  await expect(row.locator(".info-value")).toHaveText("4000 × 300");
  await shot("panorama");

  await page.locator(`[data-path="${DIR}/tall.png"]`).click();
  await expect(row.locator(".info-value")).toHaveText("300 × 4000");
  await shot("tall");

  // A non-image has no pixel row at all (no blank placeholder).
  await page.locator(`[data-path="${DIR}/blob.bin"]`).click();
  await expect(page.locator(".preview-pane .preview-info")).toBeVisible();
  await expect(row).toHaveCount(0);
});

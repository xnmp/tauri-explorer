/** #1044: a symlinked folder's tile icon must match a real folder's size at every tile size. */
import { test, expect } from "./fixtures";
import { seedSettings, waitForEntries, switchViewMode } from "./helpers";

const root = "/linked-folder-proof";
const SIZES = { small: 48, medium: 64, large: 96, xlarge: 128 } as const;

for (const [preset, px] of Object.entries(SIZES)) {
  test(`symlinked folder icon matches a real folder at ${preset} tile size`, async ({ page }) => {
    await seedSettings(page, { thumbnailSize: preset });
    await page.goto("/?path=/home/user");
    await waitForEntries(page);
    await page.evaluate(async (root) => {
      const moduleUrl = "/src/lib/api/mock-fixtures.ts";
      const { mockFiles } = await import(/* @vite-ignore */ moduleUrl);
      const base = { size: 0, modified: "2026-10-01T00:00:00Z", kind: "directory" };
      mockFiles[root] = [
        { ...base, name: "Real", path: `${root}/Real` },
        { ...base, name: "Linked", path: `${root}/Linked`, is_symlink: true, symlink_target: "/home/user/Documents" },
      ];
    }, root);
    await page.keyboard.press("Control+l");
    await page.locator(".path-input").fill(root);
    await page.locator(".path-input").press("Enter");
    await switchViewMode(page, "tiles");

    const real = page.locator(`.entry-item[data-path="${root}/Real"] .tile-icon svg`).first();
    const linked = page.locator(`.entry-item[data-path="${root}/Linked"] .tile-icon svg`).first();
    await expect(real).toBeVisible();
    await expect(linked).toBeVisible();
    const realBox = (await real.boundingBox())!;
    const linkedBox = (await linked.boundingBox())!;
    expect(linkedBox.width).toBeCloseTo(realBox.width, 0);
    expect(linkedBox.height).toBeCloseTo(realBox.height, 0);
    expect(realBox.width).toBeCloseTo(px, 0);
    expect(linkedBox.width).toBeCloseTo(px, 0);
    await page.screenshot({ path: `evidence/ac-${preset === "small" ? "1-small" : "2-" + preset}-tile-linked-folder.png` });
  });
}

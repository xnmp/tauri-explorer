/** #821: HTML aliases use a balanced web-document icon in the actual file list. */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings, waitForEntries, switchViewMode } from "./helpers";

const root = "/html-icon-proof";
const names = ["index.html", "about.htm", "UPPER.HTML", "script.js", "scene.svg", "notes.txt", "Folder"];
const htmlNames = names.slice(0, 3);
const proof = "screenshots/fix/821-change-icon-for-html-files";

for (const theme of ["light", "dark"] as const) {
  for (const iconTheme of ["default", "material", "minimal"] as const) {
    test(`${theme} ${iconTheme} HTML aliases stay legible across views`, async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const zoomLevel = theme === "light" ? 100 : 150;
      await seedSettings(page, { theme, iconTheme, zoomLevel });
      await page.goto("/?path=/home/user");
      await waitForEntries(page);
      await page.evaluate(async ({ root, names }) => {
        const moduleUrl = "/src/lib/api/mock-fixtures.ts";
        const { mockFiles } = await import(/* @vite-ignore */ moduleUrl);
        mockFiles[root] = names.map((name) => ({
          name, path: `${root}/${name}`, kind: name === "Folder" ? "directory" : "file",
          size: 120, modified: "2026-10-01T00:00:00Z",
          ...(name === "about.htm" ? { is_symlink: true, symlink_target: `${root}/index.html` } : {}),
        }));
      }, { root, names });
      await page.keyboard.press("Control+l");
      await page.locator(".path-input").fill(root);
      await page.locator(".path-input").press("Enter");
      await expect(page.locator(`.entry-item[data-path="${root}/index.html"]`)).toBeVisible();
      for (const mode of ALL_VIEW_MODES) {
        await switchViewMode(page, mode);
        for (const name of htmlNames) {
          const entry = page.locator(`.entry-item[data-path="${root}/${name}"]`);
          const icon = entry.locator(".icon-html svg");
          await expect(icon).toBeVisible();
          const box = await icon.boundingBox();
          const row = await entry.boundingBox();
          expect(box).not.toBeNull();
          expect(row).not.toBeNull();
          expect(box!.width).toBeGreaterThanOrEqual(16);
          expect(box!.x).toBeGreaterThanOrEqual(row!.x);
          expect(box!.y).toBeGreaterThanOrEqual(row!.y);
          expect(box!.x + box!.width).toBeLessThanOrEqual(row!.x + row!.width + 1);
          expect(box!.y + box!.height).toBeLessThanOrEqual(row!.y + row!.height + 1);
        }
        for (const name of names.slice(3)) {
          await expect(page.locator(`.entry-item[data-path="${root}/${name}"] .icon-html`)).toHaveCount(0);
        }
        const selected = page.locator(`.entry-item[data-path="${root}/index.html"]`);
        await expect(page.locator(`.entry-item[data-path="${root}/about.htm"] .symlink-badge`)).toBeVisible();
        await selected.click();
        await expect(selected).toHaveClass(/selected/);
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Tab");
        await expect(selected).toBeFocused();
        for (const name of htmlNames) {
          await expect(page.locator(`.entry-item[data-path="${root}/${name}"] .icon-html svg`)).toBeInViewport();
        }
        await page.locator(`.entry-item[data-path="${root}/about.htm"]`).hover();
        if (process.env.CAPTURE_821 === "1") {
          fs.mkdirSync(proof, { recursive: true });
          await page.screenshot({ path: path.join(proof, `${theme}-${iconTheme}-${mode}-${zoomLevel}.png`) });
        }
      }
    });
  }
}

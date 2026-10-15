/**
 * E2E (#1169): a marquee drag keeps the pointer's work to the band and the
 * selection highlight. The preview pane follows the selection the drag
 * settles on, not every file the band crosses, and entries under the
 * pointer take no hover highlight while the band is being dragged.
 */
import { test, expect } from "./fixtures";
import { applySettingsAndReload, waitForEntries } from "./helpers";

test("a marquee drag loads no preview until it ends, then previews the settled selection", async ({ page }) => {
  await page.addInitScript(() => {
    const loads: string[] = [];
    (window as unknown as { __previewLoads: string[] }).__previewLoads = loads;
    ((globalThis as { __mockControl?: Record<string, unknown> }).__mockControl ??= {}).previewImageSource = (path: string) => {
      loads.push(path);
      return { kind: "original" };
    };
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?path=/home/user/Pictures");
  await applySettingsAndReload(page, { showPreviewPane: true, previewPanePosition: "right", previewPaneWidth: 380 });
  await waitForEntries(page);
  const preview = page.locator(".preview-pane .preview-filename");
  // Opening the folder selects its first entry, the vacation folder.
  await expect(preview).toHaveText("vacation");

  const geometry = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".file-list .entry-item"));
    const last = rows.at(-1)!;
    const rect = last.getBoundingClientRect();
    const start = { x: Math.round(rect.left + 40), y: Math.round(rect.bottom + 14) };
    const end = { x: Math.round(rect.left + 120), y: Math.round(rect.top + 6) };
    return { name: last.dataset.path!.split("/").at(-1)!, start, end, background: !document.elementFromPoint(start.x, start.y)?.closest(".entry-item") };
  });
  expect(geometry.name).toBe("screenshot.png");
  expect(geometry.background).toBe(true);

  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 6 });

  // The band's selection highlight is live while the button is held...
  await expect(page.locator(".file-list .entry-item.selected")).toHaveCount(1);
  await expect(page.locator(".file-list .entry-item.selected")).toContainText("screenshot.png");
  // ...and the entry under the pointer is not hover-highlighted.
  const hovered = await page.evaluate(({ x, y }) => {
    const row = document.elementFromPoint(x, y)?.closest(".entry-item");
    const under = Array.from(document.querySelectorAll(".file-list .entry-item")).find((el) => {
      const r = el.getBoundingClientRect();
      return x > r.left && x < r.right && y > r.top && y < r.bottom;
    });
    return { hitEntry: !!row, hover: under?.matches(":hover") ?? null };
  }, geometry.end);
  expect(hovered).toEqual({ hitEntry: false, hover: false });

  // Give a mid-drag preview load every chance to start.
  await page.evaluate(() => new Promise<void>((resolve) => setTimeout(() => requestAnimationFrame(() => resolve()), 300)));
  expect(await page.evaluate(() => (window as unknown as { __previewLoads: string[] }).__previewLoads)).toEqual([]);
  await expect(preview).toHaveText("vacation");

  await page.mouse.up();
  await expect(preview).toHaveText("screenshot.png");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __previewLoads: string[] }).__previewLoads)).toEqual(["/home/user/Pictures/screenshot.png"]);
  // Hover feedback returns once the band is released.
  await expect.poll(() => page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest(".entry-item"), geometry.end)).toBe(true);
});

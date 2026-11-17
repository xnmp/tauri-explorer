/**
 * The preview holds its file while a new tab or pane loads (#1729).
 *
 * A new tab is seeded with the source tab's rows but selected nothing until
 * its listing settled, so the preview flashed "Select a file to preview" for a
 * frame or two. A rAF sampler records the preview's DOM state in every frame
 * from the keypress until the new pane's listing has settled.
 *
 * Ctrl+T covers the seeded tab (whose first row is selected at creation); the
 * dual-pane split opens the parent folder unseeded, so only the preview's own
 * hold (`previewFileFor`) keeps the file there until that listing selects a row.
 */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings } from "./helpers";

const DIR = "/home/csv-preview";
const LISTING_LATENCY_MS = 400;
const LISTING_COMMANDS = ["list_directory", "list_directory_fresh", "start_observed_directory", "list_directory_stream"];

interface Frame { panes: number; tabs: number; empty: boolean; name: string | null }

async function startPreviewSampler(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frames: Frame[] = [];
    let running = true;
    const tick = () => {
      if (!running) return;
      frames.push({
        panes: document.querySelectorAll(".pane-tree:not(.retained) .explorer-pane").length,
        tabs: document.querySelectorAll(".tab").length,
        empty: !!document.querySelector(".preview-empty"),
        name: document.querySelector(".preview-filename")?.textContent ?? null,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    (window as any).__stopPreviewSampler = () => { running = false; return frames; };
  });
}

const stopPreviewSampler = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => (window as any).__stopPreviewSampler());

async function slowListings(page: Page): Promise<void> {
  await page.evaluate(({ commands, ms }) => {
    const control = ((window as any).__mockControl ??= {});
    control.latency = { ...(control.latency ?? {}), ...Object.fromEntries(commands.map((cmd: string) => [cmd, ms])) };
  }, { commands: LISTING_COMMANDS, ms: LISTING_LATENCY_MS });
}

/** Opens DIR with the preview showing its first (auto-selected) file. */
async function open(page: Page, viewMode: string): Promise<string> {
  await seedSettings(page, { viewMode, showPreviewPane: true, showPreviewInfo: true });
  await page.goto(`/?path=${DIR}`);
  const selected = page.locator(".pane-tree:not(.retained) .entry-item.selected");
  await expect(selected).toHaveCount(1);
  const name = (await selected.getAttribute("data-path"))!.split("/").pop()!;
  await expect(page.locator(".preview-filename")).toHaveText(name);
  return name;
}

for (const viewMode of ALL_VIEW_MODES) {
  test(`${viewMode}: Ctrl+T keeps the preview on its file in every frame`, async ({ page }) => {
    const name = await open(page, viewMode);
    await slowListings(page);
    await startPreviewSampler(page);
    await page.keyboard.press("Control+t");
    await expect(page.locator(".tab")).toHaveCount(2);
    await page.waitForTimeout(LISTING_LATENCY_MS + 400);
    const frames = (await stopPreviewSampler(page)).filter((frame) => frame.tabs === 2);

    expect(frames.length).toBeGreaterThan(5);
    const changed = frames.filter((frame) => frame.empty || frame.name !== name);
    expect(changed, `frames not previewing ${name}: ${JSON.stringify(changed.slice(0, 5))}`).toEqual([]);
  });
}

test("an unseeded split pane holds the preview until its listing selects a row", async ({ page }) => {
  const name = await open(page, "details");
  await slowListings(page);
  await startPreviewSampler(page);
  // Toggle Dual Pane opens the parent folder: a different path, so no seed.
  await page.keyboard.press("Control+Shift+D");
  await expect(page.locator(".pane-tree:not(.retained) .explorer-pane")).toHaveCount(2);
  const newPane = page.locator(".pane-tree:not(.retained) .explorer-pane.active");
  await expect(newPane.locator(".entry-item.selected")).toHaveCount(1, { timeout: LISTING_LATENCY_MS + 5000 });
  const settled = (await newPane.locator(".entry-item.selected").getAttribute("data-path"))!.split("/").pop()!;
  await expect(page.locator(".preview-filename")).toHaveText(settled);
  // Keep sampling past the settle, so a loaded runner still records enough frames.
  await page.waitForTimeout(400);
  const frames = (await stopPreviewSampler(page)).filter((frame) => frame.panes === 2);

  expect(frames.length).toBeGreaterThan(5);
  expect(frames.filter((frame) => frame.empty), "the preview never shows its empty state").toEqual([]);
  // The held file until the listing settles, then the new pane's selection.
  expect(frames[0].name).toBe(name);
  const firstSettled = frames.findIndex((frame) => frame.name === settled);
  expect(firstSettled).toBeGreaterThan(0);
  expect(frames.slice(0, firstSettled).every((frame) => frame.name === name)).toBe(true);
});

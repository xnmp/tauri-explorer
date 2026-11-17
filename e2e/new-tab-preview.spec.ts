/**
 * The preview holds its file while a new tab or pane loads (#1729).
 *
 * A new tab is seeded with the source tab's rows but selected nothing until
 * its listing settled, so the preview flashed "Select a file to preview" for a
 * frame or two. A rAF sampler records the preview's DOM state in every frame
 * from the keypress until the new pane's listing has settled.
 *
 * Ctrl+T covers the seeded tab (whose first row is selected at creation). The
 * preview's own hold (`previewFileFor`) only keeps a file of the loading pane's
 * folder: the dual-pane split opens the parent folder, so it shows the empty
 * state rather than a file from another folder until its listing selects a row.
 */
import { test, expect, type Page } from "./fixtures";
import { ALL_VIEW_MODES, seedSettings } from "./helpers";

const DIR = "/home/csv-preview";
const LISTING_LATENCY_MS = 400;
const LISTING_COMMANDS = ["list_directory", "list_directory_fresh", "start_observed_directory", "list_directory_stream"];

interface Frame { panes: number; tabs: number; empty: boolean; name: string | null }

/** Frames recorded once the new tab or pane appears: at least this many, and
 * for at least the listing's latency plus a margin. Counting frames as well as
 * time keeps a slow runner from ending the window with too few samples. */
const MIN_FRAMES = 30;
const MIN_WINDOW_MS = LISTING_LATENCY_MS + 400;
/** Frames still recorded after the preview first shows `settledAway`'s replacement. */
const AFTER_SETTLE_FRAMES = 5;

/**
 * Records the preview's DOM state in every animation frame from the frame the
 * second tab (`count: "tabs"`) or pane (`"panes"`) appears until the minimums
 * are met. With `settledAway`, it also waits (bounded) until the preview has
 * shown another file than that one for a few frames. `trigger` opens the tab.
 */
async function samplePreviewFrames(
  page: Page, count: "tabs" | "panes", trigger: () => Promise<void>, settledAway: string | null = null,
): Promise<Frame[]> {
  await page.evaluate(({ count, minFrames, minMs, settledAway, afterSettle }) => {
    const frames: Frame[] = [];
    let start: number | null = null;
    let settledAt: number | null = null;
    (window as any).__previewFrames = new Promise<Frame[]>((resolve) => {
      const tick = (now: number) => {
        const frame: Frame = {
          panes: document.querySelectorAll(".pane-tree:not(.retained) .explorer-pane").length,
          tabs: document.querySelectorAll(".tab").length,
          empty: !!document.querySelector(".preview-empty"),
          name: document.querySelector(".preview-filename")?.textContent ?? null,
        };
        if (frame[count] === 2) {
          start ??= now;
          frames.push(frame);
          if (settledAway !== null && settledAt === null && frame.name !== null && frame.name !== settledAway) settledAt = frames.length;
        }
        const settled = settledAway === null
          || (settledAt !== null && frames.length - settledAt >= afterSettle)
          || (start !== null && now - start > 15_000);
        if (start !== null && frames.length >= minFrames && now - start >= minMs && settled) resolve(frames);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, { count, minFrames: MIN_FRAMES, minMs: MIN_WINDOW_MS, settledAway, afterSettle: AFTER_SETTLE_FRAMES });
  await trigger();
  return page.evaluate(() => (window as any).__previewFrames as Promise<Frame[]>);
}

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
    test.setTimeout(60_000); // a slow runner takes longer to draw MIN_FRAMES frames
    await slowListings(page);
    const frames = await samplePreviewFrames(page, "tabs", () => page.keyboard.press("Control+t"));

    expect(frames.length).toBeGreaterThanOrEqual(MIN_FRAMES);
    const changed = frames.filter((frame) => frame.empty || frame.name !== name);
    expect(changed, `frames not previewing ${name}: ${JSON.stringify(changed.slice(0, 5))}`).toEqual([]);
  });
}

test("a split pane of another folder never previews the source folder's file", async ({ page }) => {
  test.setTimeout(60_000);
  const name = await open(page, "details");
  await slowListings(page);
  // Toggle Dual Pane opens the parent folder: a different path, so no seed.
  const frames = await samplePreviewFrames(page, "panes", () => page.keyboard.press("Control+Shift+D"), name);
  const newPane = page.locator(".pane-tree:not(.retained) .explorer-pane.active");
  await expect(newPane.locator(".entry-item.selected")).toHaveCount(1);
  const settled = (await newPane.locator(".entry-item.selected").getAttribute("data-path"))!.split("/").pop()!;

  expect(frames.length).toBeGreaterThanOrEqual(MIN_FRAMES);
  expect(frames.filter((frame) => frame.name === name), `${name} is not in the new pane's folder`).toEqual([]);
  const firstSettled = frames.findIndex((frame) => frame.name === settled);
  expect(firstSettled).toBeGreaterThan(0);
  expect(frames.slice(0, firstSettled).every((frame) => frame.empty)).toBe(true);
});

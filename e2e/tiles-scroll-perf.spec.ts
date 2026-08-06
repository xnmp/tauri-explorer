/**
 * Regression guard: scrolling a directory full of image thumbnails in Tiles
 * view must not jank. Issue #593 — a per-tile animated loading spinner forced
 * WebKitGTK into per-frame software rasterization across the whole grid
 * during a cold scroll, measured to halve the frame rate. That fix (removing
 * the spinner, per-item thumbnail IPC instead of batching, `decoding="async"`
 * on thumbnail <img>s, a backend decode gate) had no durable test: the
 * existing perf suite doesn't cover Tiles scrolling, and `mock-invoke.ts`
 * served ONE hardcoded JPEG for every thumbnail request, so the browser could
 * satisfy every tile from a single cached decoded bitmap — a regression that
 * only shows up when N tiles each decode a genuinely distinct image would
 * have been invisible to it.
 *
 * `mock-invoke.ts` now renders a small deterministic canvas per (path, size)
 * for `get_thumbnail_data`/`get_micro_thumbnail`, and `/perf/images-N` is an
 * all-image synthetic directory (every entry requests a thumbnail, unlike
 * `/perf/huge` which is mostly non-image files).
 *
 * Per docs/lessons_learnt.md (#469 postmortem): headless absolute frame times
 * are untrustworthy (uniform ~46ms rAF/vsync pacing was observed even for
 * views that were never janky) — this spec asserts ratios/DOM invariants,
 * not absolute milliseconds. The long-frame-fraction bound below is
 * calibrated generously against this repo's headless baseline (see PR notes)
 * so it fails on a real regression (e.g. the #593 spinner coming back)
 * without flaking on ordinary headless CPU contention.
 */
import { test, expect } from "./fixtures";

const IMAGES_DIR = "/perf/images-500"; // synthetic all-image dir served by mock-invoke

test.skip(({ browserName }) => browserName !== "chromium", "perf budgets are chromium-calibrated");

interface SweepReport {
  frames: number;
  longFrames: number;
  worstFrameMs: number;
  durationMs: number;
  maxVirtualItems: number;
  spinnerSightings: number;
}

test("Tiles view scrolls a large image directory without long-frame jank (#593)", async ({ page }) => {
  // Large thumbnail size: fewer tiles per row, bigger decode surface per
  // tile, which is closest to the reported "lots of image thumbnails" case.
  await page.addInitScript(() => {
    const raw = localStorage.getItem("explorer-settings");
    const settings = raw ? JSON.parse(raw) : {};
    settings.thumbnailSize = "xlarge";
    localStorage.setItem("explorer-settings", JSON.stringify(settings));
  });

  await page.goto(`/?path=${IMAGES_DIR}&viewMode=tiles`);

  const viewport = page.locator(".tiles-view .virtual-viewport");
  await viewport.waitFor({ timeout: 10000 });
  await viewport.locator(".virtual-item").first().waitFor({ timeout: 10000 });

  // At least one thumbnail must actually resolve before we start scrolling,
  // so the sweep exercises real decode/paint work, not empty placeholders.
  await expect
    .poll(() => page.locator(".thumbnail-container img").count(), { timeout: 10000 })
    .toBeGreaterThan(0);

  const report = await page.evaluate(async () => {
    const viewportEl = document.querySelector(".tiles-view .virtual-viewport") as HTMLElement;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Regression watchdog: the #593 fix deleted the animated loading spinner
    // overlay entirely. Watch for the whole run (before + during + after the
    // sweep) so a reintroduced spinner is caught even if it only appears
    // transiently on cold tiles.
    let spinnerSightings = 0;
    const spinnerObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          const el = n as Element;
          if (el.nodeType !== 1) continue;
          if (el.matches?.(".spinner, .loading-overlay") || el.querySelector?.(".spinner, .loading-overlay")) {
            spinnerSightings++;
          }
        }
      }
    });
    spinnerObserver.observe(document.body, { subtree: true, childList: true });

    let maxVirtualItems = document.querySelectorAll(".virtual-item").length;

    // Inline re-implementation of src/lib/domain/scroll-jank-monitor.ts's rAF
    // gap sampler (kept import-free: this runs inside page.evaluate, which
    // serializes only the function body, not module imports).
    let rafId: number | null = null;
    let lastTs: number | null = null;
    let firstTs: number | null = null;
    let frames = 0;
    let longFrames = 0;
    let worstFrameMs = 0;
    // 64ms (a quadruple vsync miss / 15fps) rather than the app's own 32ms
    // scroll-jank-monitor default: measured headless-Chromium baseline for
    // THIS scenario (real distinct-image decode load while row-virtualized
    // tiles recycle) already misses every other frame under pure software
    // rasterization — a steady ~30fps, i.e. plenty of ~33ms gaps even with
    // no bug present (see PR calibration notes). 64ms isolates genuine
    // additional jank (e.g. the #593 spinner's per-frame overlay repaint)
    // from that expected headless-only baseline.
    const LONG_FRAME_MS = 64;

    function tick(ts: number) {
      if (lastTs !== null) {
        const gap = ts - lastTs;
        frames++;
        if (gap > LONG_FRAME_MS) longFrames++;
        if (gap > worstFrameMs) worstFrameMs = gap;
      } else {
        firstTs = ts;
      }
      lastTs = ts;
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);

    // Fast scripted scroll sweep: ~30 steps of 600px every ~100ms (~3000px,
    // well past a screenful of xlarge tiles), sampling rAF gaps throughout.
    for (let i = 0; i < 30; i++) {
      viewportEl.scrollTop += 600;
      maxVirtualItems = Math.max(maxVirtualItems, document.querySelectorAll(".virtual-item").length);
      await sleep(100);
    }
    // Let the last frame settle before stopping the sampler.
    await sleep(300);

    if (rafId !== null) cancelAnimationFrame(rafId);
    spinnerObserver.disconnect();

    return {
      frames,
      longFrames,
      worstFrameMs,
      durationMs: lastTs !== null && firstTs !== null ? lastTs - firstTs : 0,
      maxVirtualItems,
      spinnerSightings,
    } satisfies SweepReport;
  });

  console.log(
    `[PERF] tiles-scroll: ${report.frames} frames, ${report.longFrames} long (>64ms), ` +
      `worst ${report.worstFrameMs.toFixed(1)}ms, maxVirtualItems ${report.maxVirtualItems}`
  );

  // (b) No scroll/rAF starvation: the sweep runs ~3.3s of scripted scrolling
  // plus settle time — a wedged main thread would starve rAF far below this.
  // Observed baseline is ~110-116 frames; 60 leaves headroom for slower CI
  // runners while still catching a main thread that's actually stuck.
  expect(report.frames).toBeGreaterThanOrEqual(60);

  // (a) Long-frame fraction stays under a lenient, headless-safe bound.
  // Calibrated (3 local runs, chromium headless) against the >64ms threshold
  // above: 0/111-114 frames exceeded it in every run, worst gap topped out at
  // 50ms. 0.1 leaves an order of magnitude of headroom over that observed
  // baseline while still catching a regression like #593's per-tile animated
  // overlay, which compounds the existing ~30fps decode-load baseline into
  // materially worse (15fps-or-lower) stretches.
  const longFrameFraction = report.longFrames / Math.max(1, report.frames);
  expect(longFrameFraction).toBeLessThan(0.1);

  // Worst single-frame gap: observed baseline topped out at 50ms across 3
  // runs (a plain double-miss from the ~30fps decode-load baseline); 120ms
  // gives ~2x headroom while still catching a genuinely stalled frame.
  expect(report.worstFrameMs).toBeLessThan(120);

  // (c) Virtualization not defeated: even a big scroll sweep over 500 xlarge
  // tiles keeps the live DOM to a small windowed slice, never anywhere near
  // the full 500-entry directory.
  expect(report.maxVirtualItems).toBeGreaterThan(0);
  expect(report.maxVirtualItems).toBeLessThan(200);

  // (d) After the sweep settles, visible tiles show real resolved thumbnails
  // (not placeholders) — the actual outcome scrolling is supposed to produce.
  const resolvedThumbs = await page.locator(".thumbnail-micro, .thumbnail-full").evaluateAll((imgs) =>
    imgs.filter((img) => (img as HTMLImageElement).src.startsWith("blob:")).length
  );
  expect(resolvedThumbs).toBeGreaterThan(3);

  // (e) Regression guard: the #593 fix deleted the animated loading spinner
  // entirely — it must never come back, at any point during the run.
  expect(report.spinnerSightings).toBe(0);
  await expect(page.locator(".spinner, .loading-overlay")).toHaveCount(0);
});

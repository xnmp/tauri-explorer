/**
 * Per-frame layout sampling for "no stale frame" tests (#1061).
 *
 * The sampler records `snapshot()` during each frame's ResizeObserver delivery,
 * through an observer created after the app's observers that exist when it
 * starts, so it runs after their first-pass callbacks and before the browser
 * paints. Its probe element changes size every animation frame, so it reports
 * every frame. Observers created later (a component mounted after sampling
 * starts) and deeper delivery passes run after it: a correction they paint in
 * the same frame can still be sampled as wrong. That errs towards a false
 * failure, never a missed stale frame.
 *
 * `snapshot` is serialized into the page: it must be self-contained.
 */
import type { Page } from "./fixtures";

declare global {
  interface Window {
    __frameSampler?: { samples: unknown[]; stop(): void };
  }
}

/** Runs in the page. With `ready`, sampling begins once that selector matches. */
function install({ source, ready }: { source: string; ready?: string }) {
  const begin = () => {
    const take = new Function(`return (${source})`)() as () => unknown;
    const samples: unknown[] = [];
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-10px;top:-10px;width:1px;height:1px;pointer-events:none";
    document.body.append(probe);
    // A zero-size report means this rendering update ran no layout for the
    // probe: WebKit builds no render tree while a lazy chunk's stylesheet is
    // pending, so nothing laid out is painted. Snapshotting then would force
    // that layout inside delivery and resize the probe, the shallowest
    // observed node, which the engine cannot redeliver: WebKit reports a
    // ResizeObserver loop the app never causes (#1384).
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) samples.push(take());
    });
    observer.observe(probe);
    let running = true;
    let frame = 0;
    const tick = () => {
      if (!running) return;
      probe.style.width = `${1 + (++frame % 2)}px`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__frameSampler = {
      samples,
      stop: () => { running = false; observer.disconnect(); probe.remove(); },
    };
  };
  if (!ready) return begin();
  const watcher = new MutationObserver(() => {
    if (!document.querySelector(ready)) return;
    watcher.disconnect();
    begin();
  });
  watcher.observe(document, { childList: true, subtree: true });
}

export async function startFrameSampler<T>(page: Page, snapshot: () => T): Promise<void> {
  await page.evaluate(install, { source: snapshot.toString() });
  // Act only once frames before the change have been sampled.
  await page.waitForFunction(() => (window.__frameSampler?.samples.length ?? 0) >= 2);
}

/** Samples from the first frame that renders `ready`, for startup layouts.
 * Call before navigating. */
export async function sampleFramesFromStartup<T>(page: Page, ready: string, snapshot: () => T): Promise<void> {
  await page.addInitScript(install, { source: snapshot.toString(), ready });
}

export async function stopFrameSampler<T>(page: Page, frames = 20): Promise<T[]> {
  // Sample enough frames after the change for any deferred correction to show.
  await page.evaluate((count) => new Promise<void>((resolve) => {
    let seen = 0;
    const wait = () => (++seen >= count ? resolve() : requestAnimationFrame(wait));
    requestAnimationFrame(wait);
  }), frames);
  return await page.evaluate(() => {
    window.__frameSampler!.stop();
    return window.__frameSampler!.samples;
  }) as T[];
}

/**
 * Frame-by-frame tab strip sampling (#1734).
 *
 * A requestAnimationFrame sampler runs before the app's own rAF work, so it
 * sees the previous frame's marks. ResizeObserver delivery runs after every
 * rAF callback and layout of a frame, just before paint, so a probe element
 * resized each frame reports exactly what that frame will show.
 */
import type { Page } from "./fixtures";

export interface TabFrame {
  /** Milliseconds since sampling started. */
  t: number;
  /** Active tab, CSS px relative to the viewport (zoom-independent). */
  active: { left: number; right: number; width: number; fillet: number } | null;
  /** Widths of every tab in DOM order, and the active tab's index. */
  widths: number[];
  activeIndex: number;
  /** `data-tab-hole` on the title bar ("left right"), islands only. */
  hole: [number, number] | null;
  /** Bounding boxes of the islands' SVG marks (title bar user space). */
  fill: [number, number] | null;
  edge: [number, number] | null;
  shade: [number, number] | null;
  titlebarWidth: number;
}

/** Start sampling every frame for `ms`. Read the result with `readTabFrames`. */
export async function sampleTabFrames(page: Page, ms = 500): Promise<void> {
  await page.evaluate((ms) => {
    const frames: unknown[] = [];
    (window as unknown as { __tabFrames: unknown[] }).__tabFrames = frames;
    const raw = document.documentElement.style.zoom;
    const zoom = raw.endsWith("%") ? parseFloat(raw) / 100 : parseFloat(raw) || 1;
    const titlebar = document.querySelector<HTMLElement>('[data-region="titlebar"]')!;
    const box = (selector: string): [number, number] | null => {
      const el = titlebar.querySelector<SVGGraphicsElement>(selector);
      if (!el?.getAttribute("d")) return null;
      const b = el.getBBox();
      return b.width > 0 ? [b.x, b.x + b.width] : null;
    };
    const start = performance.now();
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none";
    document.body.appendChild(probe);
    let flip = false;
    const observer = new ResizeObserver(() => {
      const bar = titlebar.getBoundingClientRect();
      const tab = titlebar.querySelector<HTMLElement>('.tab-viewport [data-region="tab"][aria-selected="true"]');
      const r = tab?.getBoundingClientRect();
      const fillet = tab?.querySelector<HTMLElement>('[data-region="tab-fillet"]')?.getBoundingClientRect().width ?? 0;
      const hole = titlebar.getAttribute("data-tab-hole")?.split(" ").map(Number) as [number, number] | undefined;
      const tabs = [...titlebar.querySelectorAll<HTMLElement>('.tab-viewport [data-region="tab"]')];
      frames.push({
        t: Math.round(performance.now() - start),
        active: r ? { left: (r.left - bar.left) / zoom, right: (r.right - bar.left) / zoom, width: r.width / zoom, fillet: Math.max(0, fillet / zoom - 1) } : null,
        widths: tabs.map((el) => el.getBoundingClientRect().width / zoom),
        activeIndex: tab ? tabs.indexOf(tab) : -1,
        hole: hole ?? null,
        fill: box(".tab-fill-panel"),
        edge: box(".tab-edge-stroke"),
        shade: box(".strip-shade"),
        titlebarWidth: bar.width / zoom,
      });
    });
    observer.observe(probe);
    const step = () => {
      flip = !flip;
      probe.style.width = flip ? "2px" : "1px";
      if (performance.now() - start < ms) requestAnimationFrame(step);
      else requestAnimationFrame(() => { observer.disconnect(); probe.remove(); });
    };
    requestAnimationFrame(step);
  }, ms);
}

export async function readTabFrames(page: Page): Promise<TabFrame[]> {
  return page.evaluate(() => (window as unknown as { __tabFrames: TabFrame[] }).__tabFrames);
}

/**
 * Sample while `action` runs a tab insertion, returning the frames from the
 * first one that shows the new tab.
 */
export async function framesOfNewTab(page: Page, action: () => Promise<void>, ms = 500): Promise<TabFrame[]> {
  const before = await page.locator('.tab-viewport [data-region="tab"]').count();
  await sampleTabFrames(page, ms);
  await action();
  await page.waitForTimeout(ms + 150);
  const frames = await readTabFrames(page);
  return frames.filter((frame) => frame.widths.length > before);
}

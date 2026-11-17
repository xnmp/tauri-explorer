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
  /** Right edge of the last tab (sliding-out tabs included) and left edge of
   *  the new-tab button, CSS px relative to the title bar. */
  lastRight: number | null;
  plusLeft: number | null;
  /** Tabs marked selected (exactly one, or none in an empty strip). */
  selectedCount: number;
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
        lastRight: tabs.length ? (tabs[tabs.length - 1].getBoundingClientRect().right - bar.left) / zoom : null,
        plusLeft: (() => {
          const plus = titlebar.querySelector(".new-tab-btn");
          return plus ? (plus.getBoundingClientRect().left - bar.left) / zoom : null;
        })(),
        selectedCount: tabs.filter((el) => el.getAttribute("aria-selected") === "true").length,
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
 * Play the title bar's animations (the tab slides) at `rate` of their speed.
 * The slide is still driven by the real document timeline and the app's own
 * frame loop, but each frame advances it a small step, so a frame the
 * engine spends elsewhere (WebKit mounts the new tab's pane for ~100ms)
 * cannot hide a jump or skip the first frames.
 */
async function slowTitlebarAnimations(page: Page, rate: number): Promise<void> {
  await page.evaluate((rate) => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      const timing = animation.effect?.getTiming();
      if (this.closest('[data-region="titlebar"]') && Number(timing?.duration) > 50) animation.playbackRate = rate;
      return animation;
    };
    // CSS transitions (tab widths easing to a new count) slow down with
    // them, from their first frame: scale the tabs' transition duration.
    const tab = document.querySelector('[data-region="titlebar"] [data-region="tab"]');
    const seconds = tab ? parseFloat(getComputedStyle(tab).transitionDuration) || 0 : 0;
    if (seconds > 0) {
      const style = document.createElement("style");
      style.textContent = `[data-region="titlebar"] [data-region="tab"] { transition-duration: ${seconds / rate}s !important; }`;
      document.head.appendChild(style);
    }
  }, rate);
}

/**
 * Sample every frame while `action` runs and the title bar settles, with its
 * animations playing at `rate` of their speed.
 */
export async function framesOf(page: Page, action: () => Promise<void>, rate = 0.1): Promise<TabFrame[]> {
  const ms = Math.ceil(250 / rate);
  await slowTitlebarAnimations(page, rate);
  await sampleTabFrames(page, ms);
  await action();
  await page.waitForTimeout(ms + 150);
  return readTabFrames(page);
}

/** Frames of a tab insertion, from the first one that shows the new tab. */
export async function framesOfNewTab(page: Page, action: () => Promise<void>, rate = 0.1): Promise<TabFrame[]> {
  const before = await page.locator('.tab-viewport [data-region="tab"]').count();
  const frames = await framesOf(page, action, rate);
  return frames.filter((frame) => frame.widths.length > before);
}

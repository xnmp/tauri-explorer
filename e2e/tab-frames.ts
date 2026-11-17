/**
 * Frame-by-frame tab strip sampling (#1734).
 *
 * A requestAnimationFrame sampler runs before the app's own rAF work, so it
 * sees the previous frame's marks. ResizeObserver delivery runs after every
 * rAF callback and layout of a frame, just before paint, so a probe element
 * resized each frame reports exactly what that frame will show.
 */
import { expect, type Page } from "./fixtures";

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
  /** Left edge of the first tab, CSS px relative to the title bar. */
  firstLeft: number | null;
  /** Tabs marked selected (exactly one, or none in an empty strip). */
  selectedCount: number;
  /** Opacity of the active tab's outline, and of its icon (1 = fully drawn). */
  edgeOpacity: number | null;
  iconOpacity: number | null;
  /** Islands whose top edge is open under the active tab. */
  seamed: number;
  /** The active tab's close button: opacity and right edge (CSS px). */
  closeOpacity: number | null;
  closeRight: number | null;
  /** A tab sliding out (inert while it leaves): its width and opacity. */
  closing: { width: number; opacity: number } | null;
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
        firstLeft: tabs.length ? (tabs[0].getBoundingClientRect().left - bar.left) / zoom : null,
        lastRight: tabs.length ? (tabs[tabs.length - 1].getBoundingClientRect().right - bar.left) / zoom : null,
        plusLeft: (() => {
          const plus = titlebar.querySelector(".new-tab-btn");
          return plus ? (plus.getBoundingClientRect().left - bar.left) / zoom : null;
        })(),
        selectedCount: tabs.filter((el) => el.getAttribute("aria-selected") === "true").length,
        edgeOpacity: (() => {
          const edge = titlebar.querySelector<SVGElement>(".tab-edge-stroke");
          return edge?.getAttribute("d") ? Number(edge.getAttribute("opacity") ?? 1) : null;
        })(),
        iconOpacity: (() => {
          const icon = tab?.querySelector<Element>(".tab-icon, .tab-icon-special");
          return icon ? Number(getComputedStyle(icon).opacity) : null;
        })(),
        seamed: document.querySelectorAll("[data-tab-seam]").length,
        ...(() => {
          const close = tab?.querySelector<HTMLElement>(".tab-close");
          const closeBox = close?.getBoundingClientRect();
          return {
            closeOpacity: close ? Number(getComputedStyle(close).opacity) : null,
            closeRight: closeBox ? (closeBox.right - bar.left) / zoom : null,
          };
        })(),
        closing: (() => {
          const leaving = tabs.find((el) => el.inert);
          return leaving ? { width: leaving.getBoundingClientRect().width / zoom, opacity: Number(getComputedStyle(leaving).opacity) } : null;
        })(),
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
 * Freeze every title bar animation and transition as it starts: it keeps
 * the "running" state (so the app's own frame loop keeps measuring) but
 * advances only when a test sets its time.
 */
async function holdTitlebarAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __tabHold?: boolean };
    if (w.__tabHold) return;
    w.__tabHold = true;
    const inTitlebar = (el: Element | null) => Boolean(el?.closest?.('[data-region="titlebar"]'));
    const hold = (animation: Animation) => { animation.playbackRate = 1e-6; };
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element["animate"]>) {
      const animation = animate.apply(this, args);
      if (inTitlebar(this) && Number(animation.effect?.getTiming().duration) > 50) hold(animation);
      return animation;
    };
    // A transition is only reachable from its first frame on, when it has
    // already advanced; stretch the tabs' transitions so that advance is
    // negligible, and step them in stretched time (TRANSITION_STRETCH).
    const tab = document.querySelector('[data-region="titlebar"] [data-region="tab"]');
    const seconds = tab ? parseFloat(getComputedStyle(tab).transitionDuration) || 0 : 0;
    if (seconds > 0) {
      const style = document.createElement("style");
      // Scale the strip's own duration (it is 0 while a tab closes).
      style.textContent = `[data-region="titlebar"] [data-region="tab"] { transition-duration: calc(var(--tab-width-ease, ${seconds}s) * 1000) !important; }`;
      document.head.appendChild(style);
    }
  });
}

/**
 * Run `action` with the title bar's animations held, then advance them in
 * `stepMs` steps of animation time, sampling one painted frame per step.
 * Stepping animation time (not wall time) makes every step the same on a
 * fast or a slow runner: a stalled engine cannot skip a step or merge two.
 * Returns the frame before the action, then one per step.
 */
export async function steppedFrames(page: Page, action: () => Promise<void>, { stepMs = 15, steps = 22 } = {}): Promise<TabFrame[]> {
  await holdTitlebarAnimations(page);
  await sampleTabFrames(page, 60_000);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = (await readTabFrames(page)).at(-1)!;
  await action();
  const frames = [before];
  for (let step = 0; step <= steps; step++) {
    frames.push(await page.evaluate(async (time) => {
      // Each animation's clock starts at the first step that sees it.
      const w = window as unknown as { __tabFrames: unknown[]; __tabSeen?: WeakMap<Animation, number> };
      const seen = (w.__tabSeen ??= new WeakMap());
      for (const animation of document.getAnimations()) {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        if (!target?.closest?.('[data-region="titlebar"]') || animation.playState === "finished") continue;
        if (!seen.has(animation)) seen.set(animation, time);
        const elapsed = time - seen.get(animation)!;
        animation.currentTime = animation instanceof CSSTransition ? elapsed * 1000 : elapsed;
      }
      // Two frames: the app's frame loop applies the new geometry, then the
      // sampler records what that frame paints.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return w.__tabFrames.at(-1);
    }, step * stepMs) as TabFrame);
  }
  return frames;
}

/** Stepped frames of a tab insertion, from the first one that shows the new tab. */
export async function steppedFramesOfNewTab(page: Page, action: () => Promise<void>): Promise<TabFrame[]> {
  const before = await page.locator('.tab-viewport [data-region="tab"]').count();
  return (await steppedFrames(page, action)).filter((frame) => frame.widths.length > before);
}

/** Widest a new active tab may be on its first frame: its padding and icon. */
export const TAB_SEED_MAX = 34;

/**
 * A new active tab opens from a small seed (its padding and icon, never
 * nothing) and grows monotonically to its final width through at least
 * three intermediate frames, with no frame jumping from the seed's end of
 * the growth to its full end. `frames` start at the first that shows it.
 */
export function expectSeededGrowth(frames: TabFrame[]): void {
  expect(frames.length).toBeGreaterThanOrEqual(4);
  const seed = frames[0].active!.width;
  const final = frames[frames.length - 1].active!.width;
  expect(seed, "seed width").toBeGreaterThanOrEqual(Math.min(final, 28));
  expect(seed, "seed width").toBeLessThanOrEqual(TAB_SEED_MAX + 0.5);
  const at = (fraction: number) => seed + (final - seed) * fraction;
  let previous = seed;
  for (const { t, active } of frames) {
    expect(active!.width, `t=${t}`).toBeGreaterThanOrEqual(previous - 0.5);
    expect(previous < at(0.1) && active!.width > at(0.9), `jump at t=${t}`).toBe(false);
    previous = active!.width;
  }
  expect(frames.filter(({ active }) => active!.width > at(0.1) && active!.width < at(0.9)).length).toBeGreaterThanOrEqual(3);
  expect(Math.abs(previous - final)).toBeLessThanOrEqual(0.5);
}

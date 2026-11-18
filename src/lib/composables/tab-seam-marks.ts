/**
 * DOM marking for the Floating Islands active tab (#1734, #1785). Loaded
 * lazily (it is not needed for first paint) and kept by
 * `use-tab-seam.svelte.ts`.
 *
 * The active tab owns the whole window below the strip: the tab is a hole in
 * the strip shade, through which the window body (the tab's surface) shows,
 * and that surface runs edge to edge under every island with rounded top
 * corners. Measures the active tab, the tab viewport and the title bar, then
 * writes, in place and in the same frame:
 * - the title bar's `data-tab-hole` mark and the strip shade path;
 * - the shade pockets outside the surface's rounded top corners;
 * - the key shadow and lift (inline SVG paths, `[data-region="tab-key-shadow"]`);
 * - the one outline (`[data-region="tab-edge"]`): the tab plus the surface's
 *   top edge and corners; inside the strip's viewport one stroke with the
 *   tab, outside it the surface's edge alone (`outlineClips`).
 *
 * Everything is an attribute or path update on long-lived inline elements:
 * never a per-frame `url(data:...)`, which WKWebView drops while it changes.
 * Geometry is pure (`domain/tab-seam.ts`); colours come from CSS.
 */
import {
  outlineClips, stripShadePath, stripShownView, surfaceCorners, surfaceEdgePath, surfacePocketsPath, tabContour, tabFootHole,
  tabHoleFor, tabKeyShadow, tabPresence, tabShownSpan, type Surface, type TabContour, type TabHole,
} from "$lib/domain/tab-seam";
import { paintedWidth, snapX, snapY, type DeviceGrid } from "$lib/domain/device-grid";
import { surfaceRadius } from "./tab-strip-start";
import { getZoomFactor, isChromiumEngine } from "$lib/domain/zoom";

/** Frames to keep measuring after the last change, to catch layout that settles late. */
const SETTLE_FRAMES = 3;

export interface TabSeam {
  /** Re-measure and repaint now (synchronously). */
  update(): void;
  destroy(): void;
}

const svg = (root: Element | null, selector: string) => root?.querySelector<SVGElement>(selector) ?? null;
const set = (el: Element | null, name: string, value: string) => {
  if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The tab drawn this frame: its contour, the hole it claims, and how strongly it shows. */
interface ShownTab {
  readonly contour: TabContour;
  readonly hole: TabHole;
  readonly foot: TabHole;
  readonly presence: number;
}

/** Attach the marks to one title bar. */
export function attachTabSeam(titlebar: HTMLElement): TabSeam {
  let raf = 0;
  let quiet = 0;
  let previous = "";
  let destroyed = false;

  const shadowLayer = svg(titlebar, '[data-region="tab-key-shadow"]');
  const edgeLayer = svg(titlebar, '[data-region="tab-edge"]');

  function clear(): void {
    titlebar.removeAttribute("data-tab-hole");
    for (const el of [
      svg(shadowLayer, ".strip-shade"), svg(shadowLayer, ".surface-pockets"), svg(shadowLayer, ".tab-key"),
      svg(shadowLayer, ".tab-lift"), svg(edgeLayer, ".tab-edge-clip"), svg(edgeLayer, ".tab-edge-stroke"),
      svg(edgeLayer, ".surface-edge-clip"), svg(edgeLayer, ".surface-edge-stroke"),
    ]) set(el, "d", "");
    previous = "";
  }

  function measure(): string {
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const css = (value: number, origin: number) => (value - origin) / zoom;
    // Device pixels: the surface's top edge and its stroke are painted on
    // them, as CSS borders are (domain/device-grid.ts).
    const dpr = window.devicePixelRatio || 1;
    const grid: DeviceGrid = { scale: zoom * dpr, x: bar.left * dpr, y: bar.top * dpr, unit: isChromiumEngine ? dpr : 1 };
    const width = bar.width / zoom;
    const height = snapY(grid, bar.height / zoom);
    const surface: Surface = {
      left: 0,
      right: width,
      radius: surfaceRadius(titlebar),
    };
    const tabEl = titlebar.querySelector<HTMLElement>('.tab-viewport [data-region="tab"][aria-selected="true"]');
    const viewport = tabEl?.closest<HTMLElement>(".tab-viewport") ?? null;
    // No tab strip (a single tab without window controls): the bar's own
    // background is the strip shade, and the surface's edge runs straight.
    const strip = Boolean(titlebar.querySelector('[data-region="tab-strip"]'));
    let base = height;
    let viewLeft = 0;
    let viewRight = width;
    let shown: ShownTab | null = null;

    if (tabEl && viewport) {
      const box = tabEl.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      // While a tab slides in, --fillet is an expression of its progress: the
      // fillet element's rendered width (fillet + 1px ring) is the resolved value.
      const filletEl = tabEl.querySelector<HTMLElement>('[data-region="tab-fillet"]');
      const fillet = filletEl ? Math.max(0, filletEl.getBoundingClientRect().width / zoom - 1) : 0;
      const left = css(box.left, bar.left);
      const tabWidth = box.width / zoom;
      base = snapY(grid, css(box.bottom, bar.top));
      // On device pixels, so the outline's two strokes meet without a seam.
      viewLeft = snapX(grid, css(view.left, bar.left));
      viewRight = snapX(grid, css(view.right, bar.left));
      const contour = tabContour(
        { left, width: tabWidth, top: css(box.top, bar.top), base },
        parseFloat(getComputedStyle(tabEl).borderTopLeftRadius) || 0,
        fillet,
      );
      const hole = tabHoleFor({ left, width: tabWidth }, contour.fillet)!;
      // The outline rises only out of the part of the strip that shows tabs:
      // a tab scrolled out of view leaves the surface's top edge straight.
      const viewStyle = getComputedStyle(viewport);
      const run = (parseFloat(viewStyle.getPropertyValue("--tab-bleed")) || 0) + (parseFloat(viewStyle.getPropertyValue("--tab-scroll-btn-w")) || 0);
      const faded = { start: viewport.classList.contains("fade-start"), end: viewport.classList.contains("fade-end") };
      if (tabShownSpan({ left, right: left + tabWidth }, stripShownView({ left: viewLeft, right: viewRight }, faded, run))) {
        shown = { contour, hole, foot: tabFootHole(hole, { left: viewLeft, right: viewRight }), presence: tabPresence(tabWidth) };
      }
    }

    const stroke = paintedWidth(grid, 1);
    const corners = surfaceCorners(surface, shown?.foot ?? null);
    const shade = strip ? stripShadePath(width, height, shown?.contour ?? null, { left: viewLeft, right: viewRight }) : "";
    const pockets = surfacePocketsPath(surface, base, corners);
    const edge = surfaceEdgePath(shown?.contour ?? null, stroke, surface, base, corners);
    const surfaceEdge = surfaceEdgePath(null, stroke, surface, base, corners);
    const clips = outlineClips({ left: viewLeft, right: viewRight });
    const shadow = shown ? tabKeyShadow(shown.contour) : null;
    const presence = shown?.presence ?? 0;

    const key = `${shade}|${pockets}|${edge}|${surfaceEdge}|${stroke}|${viewLeft},${viewRight}|${presence}|${width}x${height}`;
    if (key === previous) return key;

    if (shown) set(titlebar, "data-tab-hole", `${Math.round(shown.hole.left * 100) / 100} ${Math.round(shown.hole.right * 100) / 100}`);
    else titlebar.removeAttribute("data-tab-hole");
    set(svg(shadowLayer, ".strip-shade"), "d", shade);
    set(svg(shadowLayer, ".surface-pockets"), "d", pockets);
    const barClip = svg(shadowLayer, ".tab-bar-clip");
    set(barClip, "width", String(width));
    set(barClip, "height", String(height));
    // Shadows: the tab's own silhouette, cut out under the tab.
    set(svg(shadowLayer, ".tab-lift"), "d", shadow?.silhouette ?? "");
    set(svg(shadowLayer, ".tab-key"), "d", shadow?.silhouette ?? "");
    if (shadow) {
      set(svg(shadowLayer, ".tab-key"), "transform", `translate(${shadow.dx} ${shadow.dy})`);
      set(svg(shadowLayer, ".tab-cutout"), "d", `M-4096 -4096H8192V8192H-4096Z${shadow.silhouette}`);
      set(svg(shadowLayer, ".tab-key-blur"), "stdDeviation", String(shadow.blur));
      set(svg(shadowLayer, ".tab-lift-blur"), "stdDeviation", String(shadow.liftBlur));
    }
    for (const clip of titlebar.querySelectorAll(".tab-view-clip")) {
      set(clip, "x", String(viewLeft));
      set(clip, "width", String(Math.max(0, viewRight - viewLeft)));
      set(clip, "height", String(Math.max(0, base)));
    }
    set(svg(shadowLayer, ".tab-shadows"), "opacity", String(r3(presence)));
    // The outline: inside the strip's viewport, the surface's edge with the
    // tab (a tab half under a scroll button is cut there); outside it, the
    // surface's edge alone, so its top edge and corners run the whole width.
    set(svg(edgeLayer, ".tab-edge-clip"), "d", clips.inside);
    set(svg(edgeLayer, ".surface-edge-clip"), "d", clips.outside);
    for (const [selector, d] of [[".tab-edge-stroke", edge], [".surface-edge-stroke", surfaceEdge]] as const) {
      const path = svg(edgeLayer, selector);
      set(path, "d", d);
      set(path, "stroke-width", String(r3(stroke)));
    }
    previous = key;
    return key;
  }

  function update(): void {
    if (destroyed) return;
    const before = previous;
    if (measure() !== before) quiet = 0;
  }

  /** Measure every frame while anything moves, then stop. */
  function frames(): void {
    quiet = 0;
    if (raf || destroyed) return;
    const step = () => {
      raf = 0;
      if (destroyed) return;
      const before = previous;
      quiet = measure() === before ? quiet + 1 : 0;
      if (quiet < SETTLE_FRAMES || animating()) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  const animating = () =>
    titlebar.getAnimations?.({ subtree: true }).some((animation) => animation.playState === "running") ?? false;

  const resize = new ResizeObserver(() => { update(); frames(); });
  resize.observe(titlebar);
  // Tab slides are CSS animations Svelte starts on insertion and removal.
  const onAnimation = () => frames();
  // Scrolling also toggles the strip's end fades a frame later.
  const onScroll = () => { update(); frames(); };
  titlebar.addEventListener("animationstart", onAnimation, true);
  titlebar.addEventListener("transitionstart", onAnimation, true);
  titlebar.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onAnimation);

  update();
  frames();

  return {
    update() { update(); frames(); },
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      resize.disconnect();
      titlebar.removeEventListener("animationstart", onAnimation, true);
      titlebar.removeEventListener("transitionstart", onAnimation, true);
      titlebar.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onAnimation);
      clear();
    },
  };
}

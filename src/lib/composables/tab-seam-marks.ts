/**
 * DOM marking for the Floating Islands active tab (#1734). Loaded lazily (it
 * is not needed for first paint) and kept by `use-tab-seam.svelte.ts`.
 *
 * Measures the active tab, the tab viewport and the islands under the strip,
 * then writes, in place and in the same frame:
 * - the title bar's `data-tab-hole` mark and the strip shade path;
 * - the tab's fill (`data-tab-island` names the surface it wears: that of
 *   the island under it), reaching down into the island's seam;
 * - the key shadow and lift (inline SVG paths, `[data-region="tab-key-shadow"]`);
 * - the edge highlight stroke (`[data-region="tab-edge"]`);
 * - a `data-tab-seam` mark plus `--tab-seam-left/right` on each island whose
 *   top edge the tab opens into.
 *
 * Everything is an attribute or path update on long-lived inline elements:
 * never a per-frame `url(data:...)`, which WKWebView drops while it changes.
 * Geometry is pure (`domain/tab-seam.ts`); colours come from CSS.
 */
import {
  TAB_SEAM_DEPTH, gutterRowsFor, islandAt, islandSquareFor, islandUnder, seamRowFor, stripShadePath, tabContour, tabEdgePath, tabFillPath,
  tabHoleFor, tabKeyShadow, type IslandEdge, type IslandSquare, type TabContour, type TabSeamRow,
} from "$lib/domain/tab-seam";
import { getZoomFactor } from "$lib/domain/zoom";
import { ISLANDS, STRUCTURAL } from "./island-regions";

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

function clearSeams(except: Set<Element>): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-tab-seam]")) {
    if (except.has(el)) continue;
    el.removeAttribute("data-tab-seam");
    el.style.removeProperty("--tab-seam-left");
    el.style.removeProperty("--tab-seam-right");
  }
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
    titlebar.removeAttribute("data-tab-island");
    set(svg(shadowLayer, ".strip-shade"), "d", "");
    for (const el of shadowLayer?.querySelectorAll(".tab-fill path") ?? []) set(el, "d", "");
    for (const el of [svg(shadowLayer, ".tab-key"), svg(shadowLayer, ".tab-lift"), svg(edgeLayer, ".tab-edge-stroke")]) set(el, "d", "");
    clearSeams(new Set());
    for (const el of document.querySelectorAll("[data-tab-square]")) el.removeAttribute("data-tab-square");
  }

  function measure(): string {
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const css = (value: number, origin: number) => (value - origin) / zoom;
    const width = bar.width / zoom;
    const height = bar.height / zoom;
    const tab = titlebar.querySelector<HTMLElement>('.tab-viewport [data-region="tab"][aria-selected="true"]');
    const viewport = tab?.closest<HTMLElement>(".tab-viewport");
    if (!tab || !viewport) {
      clear();
      return "none";
    }
    const box = tab.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    const style = getComputedStyle(tab);
    // While a tab slides in, --fillet is an expression of its progress: the
    // fillet element's rendered width (fillet + 1px ring) is the resolved value.
    const filletEl = tab.querySelector<HTMLElement>('[data-region="tab-fillet"]');
    const fillet = filletEl ? Math.max(0, filletEl.getBoundingClientRect().width / zoom - 1) : 0;
    const left = css(box.left, bar.left);
    const tabWidth = box.width / zoom;
    // An active tab opens from a seed and is drawn whole from its first
    // frame. Only a tab narrower than that (a layout without the seed) fades
    // its outline and shadow, which would otherwise collapse into a 1px
    // vertical sliver.
    const presence = Math.min(1, Math.max(0, (tabWidth - 2) / 16));
    const base = css(box.bottom, bar.top);
    const contour: TabContour = tabContour(
      { left, width: tabWidth, top: css(box.top, bar.top), base },
      parseFloat(style.borderTopLeftRadius) || 0,
      fillet,
    );
    const hole = tabHoleFor({ left, width: tabWidth }, contour.fillet)!;
    const viewLeft = css(view.left, bar.left);
    const viewRight = css(view.right, bar.left);

    // Islands whose top edge sits on the strip base.
    const islands: (IslandEdge & { el: HTMLElement; structural: boolean })[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(ISLANDS)) {
      const r = el.getBoundingClientRect();
      if (!r.width || Math.abs(css(r.top, bar.top) - base) > 1) continue;
      islands.push({
        el,
        structural: el.matches(STRUCTURAL),
        left: css(r.left, bar.left),
        right: css(r.right, bar.left),
        // The layout's radius, not the rendered one: a corner squared under
        // the tab must not read as an island without corners.
        radius: parseFloat(getComputedStyle(el).getPropertyValue("--layout-radius")) || parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
      });
    }
    const edges: IslandEdge[] = islands;
    // The tab wears the surface of the island it stands on and opens into
    // the islands of that kind under it; another kind keeps its edge.
    const home = islandUnder(islands, hole);
    const kind = home ? (home.structural ? "structural" : "content") : "none";
    const seams: { el: HTMLElement; row: TabSeamRow; left: number }[] = [];
    const squared: (IslandEdge & { el: HTMLElement; square: IslandSquare })[] = [];
    for (const island of islands) {
      if (!home || island.structural !== home.structural) continue;
      const square = islandSquareFor(hole, island);
      if (square.left || square.right) squared.push({ ...island, square });
      const row = seamRowFor(hole, island, square);
      if (row) seams.push({ el: island.el, row, left: island.left });
    }
    const bridges = gutterRowsFor(hole, squared);
    const fill = tabFillPath(contour, [...seams.map((seam) => seam.row), ...bridges], TAB_SEAM_DEPTH);
    const squares = squared.map(({ el, square }) => `${el.dataset.region}:${square.left ? "l" : ""}${square.right ? "r" : ""}`).join(",");
    // The edge continues along the top of the tab's own kind of island only.
    const kin = home ? edges.filter((_, i) => islands[i].structural === home.structural) : [];
    const edge = tabEdgePath(contour, { left: islandAt(kin, hole.left), right: islandAt(kin, hole.right) });
    const shadow = tabKeyShadow(contour);
    const shade = stripShadePath(width, height, contour, { left: viewLeft, right: viewRight });

    const key = `${shade}|${fill}|${edge.d}|${kind}|${viewLeft},${viewRight}|${presence}|${squares}`;
    if (key === previous) return key;

    set(titlebar, "data-tab-hole", `${Math.round(hole.left * 100) / 100} ${Math.round(hole.right * 100) / 100}`);
    set(titlebar, "data-tab-island", kind);
    for (const el of shadowLayer?.querySelectorAll(".tab-fill path") ?? []) set(el, "d", fill);
    // Shade, shadows and edge: inline SVG, updated in place.
    set(svg(shadowLayer, ".strip-shade"), "d", shade);
    set(svg(shadowLayer, ".tab-lift"), "d", shadow.silhouette);
    set(svg(shadowLayer, ".tab-key"), "d", shadow.silhouette);
    set(svg(shadowLayer, ".tab-key"), "transform", `translate(${shadow.dx} ${shadow.dy})`);
    set(svg(shadowLayer, ".tab-cutout"), "d", `M-4096 -4096H8192V8192H-4096Z${shadow.silhouette}`);
    set(svg(shadowLayer, ".tab-key-blur"), "stdDeviation", String(shadow.blur));
    set(svg(shadowLayer, ".tab-lift-blur"), "stdDeviation", String(shadow.liftBlur));
    for (const clip of titlebar.querySelectorAll(".tab-view-clip")) {
      set(clip, "x", String(viewLeft));
      set(clip, "width", String(Math.max(0, viewRight - viewLeft)));
      set(clip, "height", String(Math.max(0, base)));
    }
    for (const clip of titlebar.querySelectorAll(".tab-below-clip")) set(clip, "y", String(base));
    set(svg(edgeLayer, ".tab-edge-stroke"), "d", edge.d);
    set(svg(edgeLayer, ".tab-edge-stroke"), "opacity", String(Math.round(presence * 1000) / 1000));
    set(svg(shadowLayer, ".tab-shadows"), "opacity", String(Math.round(presence * 1000) / 1000));
    const gradient = svg(edgeLayer, "linearGradient");
    set(gradient, "x1", String(edge.from));
    set(gradient, "x2", String(edge.to));
    const span = Math.max(1, edge.to - edge.from);
    const stops = edgeLayer?.querySelectorAll("stop") ?? [];
    const offsets = [0, Math.min(0.5, edge.fadeIn / span), Math.max(0.5, 1 - edge.fadeOut / span), 1];
    stops.forEach((stop, i) => set(stop, "offset", String(Math.round(offsets[i] * 10000) / 10000)));

    // Seams: islands the tab opens into lose their top edge under it.
    const seamed = new Set<Element>();
    for (const { el, row, left: islandLeft } of seams) {
      seamed.add(el);
      el.setAttribute("data-tab-seam", "");
      el.style.setProperty("--tab-seam-left", `${Math.round((row.left - islandLeft) * 100) / 100}px`);
      el.style.setProperty("--tab-seam-right", `${Math.round((row.right - islandLeft) * 100) / 100}px`);
      el.style.setProperty("--tab-seam-depth", `${TAB_SEAM_DEPTH}px`);
    }
    clearSeams(seamed);
    // Corners the foot reaches into are squared while it stands there.
    const square = new Map(squared.map(({ el, square }) => [el as Element, [square.left ? "left" : "", square.right ? "right" : ""].filter(Boolean).join(" ")]));
    for (const el of document.querySelectorAll<HTMLElement>("[data-tab-square]")) if (!square.has(el)) el.removeAttribute("data-tab-square");
    for (const [el, sides] of square) set(el, "data-tab-square", sides);
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
  const main = document.querySelector('[data-region="main"]');
  if (main) resize.observe(main);
  // Tab slides are CSS animations Svelte starts on insertion and removal.
  const onAnimation = () => frames();
  const onScroll = () => update();
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

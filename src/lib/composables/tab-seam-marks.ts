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
 * - the edge stroke (`[data-region="tab-edge"]`), which takes over the top
 *   edge of each island the tab opens into between its corner tangents;
 * - a `data-tab-seam` mark plus `--tab-seam-clip` on each such island: its
 *   clip removes the top border row the stroke takes over
 *   (`domain/island-outline.ts`).
 *
 * Everything is an attribute or path update on long-lived inline elements:
 * never a per-frame `url(data:...)`, which WKWebView drops while it changes.
 * Geometry is pure (`domain/tab-seam.ts`); colours come from CSS.
 */
import {
  islandAt, islandUnder, stripShadePath, tabFootFor, tabShownSpan, tabContour, tabEdgePath, tabFillPath,
  tabHoleFor, tabKeyShadow, type EdgeCorner, type IslandEdge, type TabContour,
} from "$lib/domain/tab-seam";
import {
  cutPath, islandClipPolygon, islandCut, paintedWidth, snapX, snapY, type CornerOwnership, type DeviceGrid,
} from "$lib/domain/island-outline";
import { getZoomFactor, isChromiumEngine } from "$lib/domain/zoom";
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
    el.style.removeProperty("--tab-seam-clip");
  }
}

/** The colour an island's CSS border paints on one side; transparent when it has none. */
function borderColor(el: HTMLElement, side: "left" | "right"): string {
  const style = getComputedStyle(el);
  const width = parseFloat(side === "left" ? style.borderLeftWidth : style.borderRightWidth) || 0;
  const kind = side === "left" ? style.borderLeftStyle : style.borderRightStyle;
  return width > 0 && kind !== "none" && kind !== "hidden" ? (side === "left" ? style.borderLeftColor : style.borderRightColor) : "transparent";
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
    set(svg(edgeLayer, ".tab-edge-clip"), "d", "");
    for (const el of [svg(shadowLayer, ".tab-key"), svg(shadowLayer, ".tab-lift"), ...(edgeLayer?.querySelectorAll(".tab-edge-stroke") ?? [])]) set(el, "d", "");
    clearSeams(new Set());
    for (const el of document.querySelectorAll("[data-tab-square]")) el.removeAttribute("data-tab-square");
  }

  /** Marks drawn for nothing: the next drawable state must draw again even
   *  when it repeats the last one drawn (a tab scrolled away and back). */
  function cleared(state: string): string {
    clear();
    previous = state;
    return state;
  }

  function measure(): string {
    const zoom = getZoomFactor() || 1;
    const bar = titlebar.getBoundingClientRect();
    const css = (value: number, origin: number) => (value - origin) / zoom;
    // Device pixels: the islands' top edges and borders are painted on them,
    // and the strip's base follows them (domain/island-outline.ts).
    const dpr = window.devicePixelRatio || 1;
    const grid: DeviceGrid = { scale: zoom * dpr, x: bar.left * dpr, y: bar.top * dpr, unit: isChromiumEngine ? dpr : 1 };
    const width = bar.width / zoom;
    const height = snapY(grid, bar.height / zoom);
    const tab = titlebar.querySelector<HTMLElement>('.tab-viewport [data-region="tab"][aria-selected="true"]');
    const viewport = tab?.closest<HTMLElement>(".tab-viewport");
    if (!tab || !viewport) return cleared("none");
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
    const base = snapY(grid, css(box.bottom, bar.top));
    const contour: TabContour = tabContour(
      { left, width: tabWidth, top: css(box.top, bar.top), base },
      parseFloat(style.borderTopLeftRadius) || 0,
      fillet,
    );
    const hole = tabHoleFor({ left, width: tabWidth }, contour.fillet)!;
    const viewLeft = css(view.left, bar.left);
    const viewRight = css(view.right, bar.left);
    // An island opens only under the part of the active tab the strip shows:
    // a tab scrolled out of the viewport leaves every island closed, and one
    // half under an edge opens it no further than that edge (#1734).
    // An overflowing strip's ends are transparent under its scroll buttons.
    // (the fade's transparent run: the fillet bleed plus the button).
    const viewStyle = getComputedStyle(viewport);
    const faded = (parseFloat(viewStyle.getPropertyValue("--tab-bleed")) || 0) + (parseFloat(viewStyle.getPropertyValue("--tab-scroll-btn-w")) || 0);
    const shown = tabShownSpan({ left, right: left + tabWidth }, {
      left: viewLeft + (viewport.classList.contains("fade-start") ? faded : 0),
      right: viewRight - (viewport.classList.contains("fade-end") ? faded : 0),
    });
    if (!shown) return cleared("hidden");
    const footHole = { left: Math.max(hole.left, viewLeft), right: Math.min(hole.right, viewRight) };

    // Islands whose top edge sits on the strip base.
    const islands: (IslandEdge & { el: HTMLElement; structural: boolean; top: number })[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(ISLANDS)) {
      const r = el.getBoundingClientRect();
      if (!r.width || Math.abs(css(r.top, bar.top) - base) > 1) continue;
      islands.push({
        el,
        structural: el.matches(STRUCTURAL),
        left: css(r.left, bar.left),
        right: css(r.right, bar.left),
        top: css(r.top, bar.top),
        // The layout's radius, not the rendered one: a corner squared under
        // the tab must not read as an island without corners.
        radius: parseFloat(getComputedStyle(el).getPropertyValue("--layout-radius")) || parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
      });
    }
    // The tab wears the surface of the island it stands on and opens into
    // the islands of that kind under it; another kind keeps its edge.
    const home = islandUnder(islands, hole);
    const kind = home ? (home.structural ? "structural" : "content") : "none";
    const foot = tabFootFor(footHole, islands.map((island) => ({ ...island, home: Boolean(home) && island.structural === home!.structural })));
    const squared = foot.squared;
    const bridges = foot.bridges;
    const squareOf = new Map(squared.map(({ el, square }) => [el, square]));

    // The edge stroke owns each seamed island's top edge and top corners, on
    // the device-pixel grid layout paints them on (domain/island-outline.ts).
    const stroke = paintedWidth(grid, home ? parseFloat(getComputedStyle(home.el).borderLeftWidth) || 1 : 1);
    const seamIslands = foot.seams.map(({ island }) => island);
    const leftIsland = (islandAt(seamIslands, hole.left) as (typeof seamIslands)[number] | null);
    const rightIsland = (islandAt(seamIslands, hole.right) as (typeof seamIslands)[number] | null);
    let leftCorner: EdgeCorner | null = null;
    let rightCorner: EdgeCorner | null = null;
    // The clip-path's reference box: Chromium clips against the layout box,
    // WebKit against the box as painted, snapped to device pixels.
    const clipOrigin = (island: { left: number; top: number }) =>
      isChromiumEngine ? island : { left: snapX(grid, island.left), top: snapY(grid, island.top) };
    const seams = foot.seams.map(({ island, row }) => {
      const square = squareOf.get(island.el) ?? { left: false, right: false };
      const own = (side: "left" | "right"): CornerOwnership => {
        if ((side === "left" ? leftIsland : rightIsland) !== island) return null;
        if (side === "left" ? island.left >= hole.left : island.right <= hole.right) return null;
        return square[side] ? "square" : "round";
      };
      const corners = { left: own("left"), right: own("right") };
      const cut = islandCut({ ...island, border: stroke }, grid, row, corners);
      const edge = (side: "left" | "right"): EdgeCorner => {
        const [x, y] = cut.handover[side];
        return corners[side] === "round" ? { kind: "round", x } : { kind: "square", edge: x, handover: y };
      };
      if (corners.left) leftCorner = edge("left");
      if (corners.right) rightCorner = edge("right");
      return { el: island.el, cut: cutPath(cut), clip: islandClipPolygon(clipOrigin(island), cut) };
    });
    const fill = tabFillPath(contour, bridges, stroke);
    const squares = squared.map(({ el, square }) => `${el.dataset.region}:${square.left ? "l" : ""}${square.right ? "r" : ""}`).join(",");
    const edge = tabEdgePath(contour, stroke, { left: leftCorner, right: rightCorner });
    // The stroke wears each island's own border colour.
    const tabColor = home ? borderColor(home.el, "left") : "";
    const leftColor = leftIsland ? borderColor(leftIsland.el, "left") : tabColor;
    const rightColor = rightIsland ? borderColor(rightIsland.el, "right") : tabColor;
    const oneColor = leftColor === tabColor && rightColor === tabColor;
    const strokes = oneColor
      ? [{ d: edge.d, color: tabColor }, { d: "", color: "" }, { d: "", color: "" }]
      : [{ d: edge.tab, color: tabColor }, { d: edge.left, color: leftColor }, { d: edge.right, color: rightColor }];
    const shadow = tabKeyShadow(contour);
    const shade = stripShadePath(width, height, contour, { left: viewLeft, right: viewRight });
    const cuts = seams.map((seam) => seam.cut).join("");
    const strokeKey = strokes.map((part) => `${part.d}~${part.color}`).join("/");
    const clipKey = seams.map((seam) => seam.clip).join("/");

    const key = `${shade}|${fill}|${strokeKey}|${stroke}|${kind}|${viewLeft},${viewRight}|${presence}|${squares}|${cuts}|${clipKey}|${width}x${height}`;
    if (key === previous) return key;

    set(titlebar, "data-tab-hole", `${Math.round(hole.left * 100) / 100} ${Math.round(hole.right * 100) / 100}`);
    set(titlebar, "data-tab-island", kind);
    for (const el of shadowLayer?.querySelectorAll(".tab-body path") ?? []) set(el, "d", fill);
    for (const el of shadowLayer?.querySelectorAll(".tab-corners path") ?? []) set(el, "d", cuts);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    set(svg(edgeLayer, ".tab-edge-clip"), "d", `M${r3(viewLeft)} 0H${r3(Math.max(viewLeft, viewRight))}V${r3(base)}H${r3(viewLeft)}Z${cuts}`);
    // Shade, shadows and edge: inline SVG, updated in place.
    set(svg(shadowLayer, ".strip-shade"), "d", shade);
    const barClip = svg(shadowLayer, ".tab-bar-clip");
    set(barClip, "width", String(width));
    set(barClip, "height", String(height));
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
    const opacity = String(Math.round(presence * 1000) / 1000);
    edgeLayer?.querySelectorAll<SVGPathElement>(".tab-edge-stroke").forEach((path, i) => {
      set(path, "d", strokes[i]?.d ?? "");
      set(path, "stroke-width", String(Math.round(stroke * 1000) / 1000));
      set(path, "opacity", opacity);
      if (path.style.stroke !== (strokes[i]?.color ?? "")) path.style.stroke = strokes[i]?.color ?? "";
    });
    set(svg(shadowLayer, ".tab-shadows"), "opacity", opacity);

    // Seams: islands the tab opens into give their top edge and corners to
    // the stroke (`--tab-seam-clip` removes the notch and the corner bands).
    const seamed = new Set<Element>();
    for (const { el, clip } of seams) {
      seamed.add(el);
      el.setAttribute("data-tab-seam", "");
      if (el.style.getPropertyValue("--tab-seam-clip") !== clip) el.style.setProperty("--tab-seam-clip", clip);
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

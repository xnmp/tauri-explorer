/**
 * Geometry of the Floating Islands active tab (#1734, #1785): the hole it
 * cuts in the strip shade, the outline its edge highlight strokes, and the
 * key shadow it casts. Pure: every length is a CSS pixel in the title bar's
 * coordinate space (x right, y down), and `base` is the strip base, where the
 * tabs end and the tab's surface begins.
 *
 * The active tab owns the whole window below the strip (#1785): its surface
 * runs edge to edge with rounded top corners, and every island sits on it.
 * The one outline is the tab plus the surface's top edge and corners.
 *
 * The silhouette is the tab box with rounded top corners plus two concave
 * fillets: true quarter circles tangent to the tab side and to the base.
 * `offset` grows (positive) or shrinks (negative) the silhouette along its
 * normal: the edge stroke's centre line sits half a stroke inside it, so the
 * stroke continues the islands' 1px inside border, and the strip shade's hole
 * is half a pixel smaller, so the shade runs under the tab's anti-aliased edge.
 */

/** Concave fillet radius of a fully open active tab. */
export const TAB_FILLET = 14;

/** Where the light comes from: the top left, so shadows fall down-right. */
export const TAB_LIGHT = { dx: 2.5, dy: 2.5, blur: 2.5, liftBlur: 2.5 } as const;

export interface TabBox {
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly base: number;
}

/** Horizontal extent the active tab claims in the strip, fillets included. */
export interface TabHole {
  readonly left: number;
  readonly right: number;
}

export interface TabContour {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly base: number;
  /** Top-corner radius, narrowed to fit the tab. */
  readonly radius: number;
  /** Concave fillet radius, narrowed to fit the tab's height. */
  readonly fillet: number;
}

/** The tab's surface: the window below the strip base, its top corners rounded. */
export interface Surface {
  readonly left: number;
  readonly right: number;
  readonly radius: number;
}

/** The radius of each of the surface's top corners. */
export interface SurfaceCorners {
  readonly left: number;
  readonly right: number;
}

/** Straight run between the surface's top corner and the first tab's foot. */
export const SURFACE_TAB_GAP = 2;

const num = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);
const nonNegative = (value: number): number => Math.max(0, num(value));
/** Short, stable path numbers: 3 decimals is far below a device pixel. */
const n = (value: number): string => String(Math.round(value * 1000) / 1000);

/**
 * The strip region the active tab owns, or null when there is no tab. A tab
 * that is just starting its slide-in (zero width) keeps a zero-width hole at
 * its position, so the title bar never loses its hole mark for a frame.
 */
export function tabHoleFor(
  tab: { readonly left: number; readonly width: number } | null | undefined,
  fillet: number,
): TabHole | null {
  if (!tab || !Number.isFinite(tab.left)) return null;
  const width = nonNegative(tab.width);
  if (width === 0) return { left: tab.left, right: tab.left };
  const flare = nonNegative(fillet);
  return { left: tab.left - flare, right: tab.left + width + flare };
}

/** The tab's contour, with radii narrowed so a narrow or short tab keeps a valid shape. */
export function tabContour(tab: TabBox, radius: number, fillet: number): TabContour {
  const left = num(tab.left);
  const width = nonNegative(tab.width);
  const base = num(tab.base);
  const top = Math.min(num(tab.top, base), base);
  const height = base - top;
  const flare = Math.min(nonNegative(fillet), height);
  const corner = Math.min(nonNegative(radius), width / 2, height - flare);
  return { left, right: left + width, top, base, radius: Math.max(0, corner), fillet: flare };
}

interface Outline {
  /** Left fillet foot, on the base line. */
  readonly start: { x: number; y: number };
  readonly end: { x: number; y: number };
  /** Path segments after the starting point. */
  readonly body: string;
}

/** The silhouette boundary from the left fillet foot over the tab to the right foot. */
function outline(c: TabContour, offset: number): Outline {
  const o = num(offset);
  const f = c.fillet;
  let xl = c.left - o;
  let xr = c.right + o;
  if (xr < xl) xl = xr = (c.left + c.right) / 2;
  const top = Math.min(c.top - o, c.base - f);
  const corner = Math.max(0, Math.min(c.radius + o, (xr - xl) / 2, c.base - f - top));
  const ring = Math.max(0, f - o);
  const footY = c.base - f + ring;
  const parts: string[] = [];
  const fillet = (x: number, y: number) =>
    parts.push(ring > 0 ? `A${n(ring)} ${n(ring)} 0 0 0 ${n(x)} ${n(y)}` : `L${n(x)} ${n(y)}`);
  const arc = (x: number, y: number) =>
    parts.push(corner > 0 ? `A${n(corner)} ${n(corner)} 0 0 1 ${n(x)} ${n(y)}` : `L${n(x)} ${n(y)}`);
  fillet(xl, c.base - f);
  parts.push(`L${n(xl)} ${n(top + corner)}`);
  arc(xl + corner, top);
  parts.push(`L${n(xr - corner)} ${n(top)}`);
  arc(xr, top + corner);
  parts.push(`L${n(xr)} ${n(c.base - f)}`);
  fillet(c.right + f, footY);
  return { start: { x: c.left - f, y: footY }, end: { x: c.right + f, y: footY }, body: parts.join("") };
}

/**
 * The closed silhouette (tab plus fillets), grown by `offset`, closed `below`
 * pixels under the base (by default one, so it covers the strip down to its
 * bottom edge).
 */
export function tabSilhouettePath(c: TabContour, offset = 0, below = 1): string {
  const { start, end, body } = outline(c, offset);
  const bottom = Math.max(start.y, c.base) + Math.max(0, num(below));
  return `M${n(start.x)} ${n(start.y)}${body}L${n(end.x)} ${n(bottom)}L${n(start.x)} ${n(bottom)}Z`;
}

/** Counter-clockwise rectangle (on screen, y down): winding opposite to the silhouette. */
const ccwRect = (left: number, right: number, height: number): string =>
  right > left ? `M${n(left)} 0V${n(height)}H${n(right)}V0Z` : "";

/**
 * The strip shade (fill-rule nonzero): the whole title bar minus the active
 * tab's silhouette, shrunk by half a pixel so the shade runs under the tab's
 * soft edge. The hole only opens inside the tab viewport (`view`): beside it
 * the strip is drawn twice over, so a tab scrolled under the scroll buttons
 * stays shaded there exactly where the scroller clips it.
 */
export function stripShadePath(
  width: number,
  height: number,
  c: TabContour | null,
  view?: { readonly left: number; readonly right: number } | null,
): string {
  const w = nonNegative(width);
  const h = nonNegative(height);
  if (!c) return ccwRect(0, w, h);
  const left = Math.min(w, Math.max(0, num(view?.left ?? 0)));
  const right = Math.max(left, Math.min(w, num(view?.right ?? w, w)));
  const outside = ccwRect(0, left, h) + ccwRect(right, w, h);
  return `${outside}${outside}${ccwRect(left, right, h)}${tabSilhouettePath(c, -0.5)}`;
}

/**
 * The radius of each top corner of the surface. A corner never meets the
 * tab's foot: where the foot (clamped to the strip's viewport) reaches into
 * a corner, as in a narrow window that gives the band before the first tab
 * back to its tabs, that corner narrows to end where the foot begins.
 */
export function surfaceCorners(surface: Surface, foot: TabHole | null): SurfaceCorners {
  const width = Math.max(0, num(surface.right) - num(surface.left));
  const radius = Math.min(nonNegative(surface.radius), width / 2);
  if (!foot) return { left: radius, right: radius };
  return {
    left: Math.max(0, Math.min(radius, num(foot.left) - num(surface.left))),
    right: Math.max(0, Math.min(radius, num(surface.right) - num(foot.right))),
  };
}

/**
 * The strip shade outside the surface's rounded top corners, below the base
 * (fill-rule nonzero). Each pocket's arc sits half a pixel inside the
 * corner, so the shade runs under the edge stroke's anti-aliased outer edge.
 */
export function surfacePocketsPath(surface: Surface, base: number, corners: SurfaceCorners): string {
  const l = num(surface.left);
  const r = num(surface.right);
  const y = num(base);
  const pocket = (radius: number, side: "left" | "right"): string => {
    const k = nonNegative(radius);
    if (k <= 0.5) return "";
    const inner = k - 0.5;
    return side === "left"
      ? `M${n(l)} ${n(y)}H${n(l + k)}V${n(y + 0.5)}A${n(inner)} ${n(inner)} 0 0 0 ${n(l + 0.5)} ${n(y + k)}H${n(l)}Z`
      : `M${n(r)} ${n(y)}V${n(y + k)}H${n(r - 0.5)}A${n(inner)} ${n(inner)} 0 0 0 ${n(r - k)} ${n(y + 0.5)}V${n(y)}Z`;
  };
  return `${pocket(corners.left, "left")}${pocket(corners.right, "right")}`;
}

/**
 * The one outline (#1785), `width` wide, as a single open path: up the
 * surface's left corner from the window's left edge, along its top edge, up
 * the active tab's fillet, over the tab and back down, on along the top edge
 * and down the right corner to the window's right edge. Its centre line sits
 * half a stroke inside the surface, so the stroke covers the surface's top
 * pixel row. Without a shown tab (`c` null) the top edge runs straight.
 */
export function surfaceEdgePath(c: TabContour | null, width: number, surface: Surface, base: number, corners: SurfaceCorners): string {
  const half = Math.max(0, num(width, 1)) / 2;
  const l = num(surface.left);
  const r = num(surface.right);
  const b = num(base);
  const y = b + half;
  const rl = nonNegative(corners.left);
  const rr = nonNegative(corners.right);
  const lead = rl > half
    ? `M${n(l + half)} ${n(b + rl)}A${n(rl - half)} ${n(rl - half)} 0 0 1 ${n(l + rl)} ${n(y)}`
    : `M${n(l)} ${n(y)}`;
  const tail = rr > half
    ? `L${n(r - rr)} ${n(y)}A${n(rr - half)} ${n(rr - half)} 0 0 1 ${n(r - half)} ${n(b + rr)}`
    : `L${n(r)} ${n(y)}`;
  if (!c) return `${lead}${tail}`;
  const { start, body } = outline({ ...c, base: b }, -half);
  return `${lead}L${n(start.x)} ${n(y)}${body}${tail}`;
}

export interface TabKeyShadow {
  /** The tab silhouette: the shadow's shape and its cut-out. */
  readonly silhouette: string;
  readonly dx: number;
  readonly dy: number;
  readonly blur: number;
  readonly liftBlur: number;
}

/**
 * The key shadow the tab casts on the strip: its own silhouette, offset away
 * from the top-left light and blurred, with the silhouette itself cut out so
 * nothing darkens the translucent tab. A fainter, centred lift sits under it.
 */
export function tabKeyShadow(c: TabContour, light: typeof TAB_LIGHT = TAB_LIGHT): TabKeyShadow {
  return {
    silhouette: tabSilhouettePath(c, 0),
    dx: light.dx,
    dy: light.dy,
    blur: light.blur,
    liftBlur: light.liftBlur,
  };
}

/** A horizontal span on the strip. */
export interface TabSeamRow {
  readonly left: number;
  readonly right: number;
}

/**
 * The span of the active tab its scroller shows, or null when it shows none
 * of it (#1734): a tab scrolled out of view leaves the surface's top edge
 * straight, with no outline rising out of it toward nothing.
 */
export function tabShownSpan(
  tab: { readonly left: number; readonly right: number },
  view: { readonly left: number; readonly right: number },
): TabSeamRow | null {
  if (![tab.left, tab.right, view.left, view.right].every(Number.isFinite)) return null;
  const left = Math.max(tab.left, view.left);
  const right = Math.min(tab.right, view.right);
  return right - left >= 1 ? { left, right } : null;
}

/**
 * How strongly the tab's outline and shadows show. An active tab opens from
 * a seed and is drawn whole from its first frame; only a tab narrower than
 * that (a layout without the seed) fades them, over its first 16px past 2px,
 * which would otherwise collapse into a 1px vertical sliver.
 */
export function tabPresence(width: number): number {
  return Number.isFinite(width) ? Math.min(1, Math.max(0, (width - 2) / 16)) : 0;
}

/**
 * The span of the tab viewport that shows tabs: an overflowing strip's ends
 * are transparent under its scroll buttons, over `run` (the fade's
 * transparent run: the fillet bleed plus the button) at each faded end.
 */
export function stripShownView(
  view: { readonly left: number; readonly right: number },
  faded: { readonly start: boolean; readonly end: boolean },
  run: number,
): TabSeamRow {
  const r = nonNegative(run);
  return { left: view.left + (faded.start ? r : 0), right: view.right - (faded.end ? r : 0) };
}

/**
 * The part of the tab's hole over the viewport (#1734): the surface's top
 * corners make room only for the foot the strip shows (`surfaceCorners`).
 */
export function tabFootHole(hole: TabHole, view: { readonly left: number; readonly right: number }): TabHole {
  return { left: Math.max(hole.left, view.left), right: Math.min(hole.right, view.right) };
}

/** Padding a tab strip keeps before its first tab when nothing aligns it. */
export const TAB_STRIP_PADDING = 12;

/**
 * Left padding that puts the first tab's foot past the surface's rounded
 * top-left corner (#1785), so even the first tab shows its whole left curve.
 * `areaLeft` is where the strip's padding box starts, in the same
 * coordinates as the surface. On macOS the traffic lights already push the
 * strip further right, so the floor applies.
 */
export function tabStripPadding(
  surface: Surface | null | undefined,
  areaLeft: number,
  minimum = TAB_STRIP_PADDING,
  fillet = TAB_FILLET,
): number {
  const floor = Math.max(0, num(minimum, TAB_STRIP_PADDING));
  if (!surface || !Number.isFinite(surface.left) || !Number.isFinite(areaLeft)) return floor;
  return Math.max(floor, surface.left + nonNegative(surface.radius) + SURFACE_TAB_GAP + nonNegative(fillet) - areaLeft);
}

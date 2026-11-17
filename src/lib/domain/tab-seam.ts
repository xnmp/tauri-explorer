/**
 * Geometry of the Floating Islands active tab (#1734): the hole it cuts in
 * the strip shade, the outline its edge highlight strokes, and the key shadow
 * it casts. Pure: every length is a CSS pixel in the title bar's coordinate
 * space (x right, y down), and `base` is the strip base, where the tabs end
 * and the islands' top edges begin.
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

/** Depth of the seam an island under the tab cuts into its top edge:
 *  its 1px border plus the half-pixel inset highlight below it. */
export const TAB_SEAM_DEPTH = 2;

/** Where the light comes from: the top left, so shadows fall down-right. */
export const TAB_LIGHT = { dx: 1.5, dy: 2, blur: 2.5, liftBlur: 3 } as const;

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

/** An island whose top edge meets the strip base under a fillet foot. */
export interface IslandEdge {
  readonly left: number;
  readonly right: number;
  readonly radius: number;
}

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

export interface TabEdge {
  /** Open path for a 1px stroke: island top, tab outline, island top. */
  readonly d: string;
  /** Horizontal extent of the stroke; it fades to nothing at both ends. */
  readonly from: number;
  readonly to: number;
  /** Where the stroke reaches full strength, measured inward from each end. */
  readonly fadeIn: number;
  readonly fadeOut: number;
}

/** How far the stroke runs along the base when no island meets a foot. */
const LOOSE_REACH = 2;

/**
 * The edge highlight: one stroke along the island top edge, up the fillet,
 * over the tab and back down, continuing the islands' 1px inside border and
 * fading out through each island's rounded top corner.
 */
export function tabEdgePath(
  c: TabContour,
  islands: { readonly left?: IslandEdge | null; readonly right?: IslandEdge | null } = {},
): TabEdge {
  const { start, end, body } = outline(c, -0.5);
  const y = start.y;
  const leftIsland = islands.left && islands.left.left < start.x ? islands.left : null;
  const rightIsland = islands.right && islands.right.right > end.x ? islands.right : null;
  const parts: string[] = [];
  let from: number;
  let fadeIn: number;
  if (leftIsland) {
    const r = Math.min(nonNegative(leftIsland.radius), start.x - leftIsland.left);
    from = leftIsland.left;
    fadeIn = Math.max(r, 1);
    if (r > 0.5) {
      parts.push(`M${n(leftIsland.left + 0.5)} ${n(c.base + r)}`);
      parts.push(`A${n(r - 0.5)} ${n(r - 0.5)} 0 0 1 ${n(leftIsland.left + r)} ${n(y)}`);
    } else parts.push(`M${n(leftIsland.left)} ${n(y)}`);
    parts.push(`L${n(start.x)} ${n(y)}`);
  } else {
    const reach = LOOSE_REACH * Math.max(c.fillet, 1);
    from = start.x - reach;
    fadeIn = reach;
    parts.push(`M${n(from)} ${n(y)}L${n(start.x)} ${n(y)}`);
  }
  parts.push(body);
  let to: number;
  let fadeOut: number;
  if (rightIsland) {
    const r = Math.min(nonNegative(rightIsland.radius), rightIsland.right - end.x);
    to = rightIsland.right;
    fadeOut = Math.max(r, 1);
    if (r > 0.5) {
      parts.push(`L${n(rightIsland.right - r)} ${n(y)}`);
      parts.push(`A${n(r - 0.5)} ${n(r - 0.5)} 0 0 1 ${n(rightIsland.right - 0.5)} ${n(c.base + r)}`);
    } else parts.push(`L${n(rightIsland.right)} ${n(y)}`);
  } else {
    const reach = LOOSE_REACH * Math.max(c.fillet, 1);
    to = end.x + reach;
    fadeOut = reach;
    parts.push(`L${n(to)} ${n(y)}`);
  }
  return { d: parts.join(""), from, to, fadeIn, fadeOut };
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

export interface TabSeamRow {
  readonly left: number;
  readonly right: number;
}

/** Which top corners of an island are squared under the tab's foot. */
export interface IslandSquare {
  readonly left: boolean;
  readonly right: boolean;
}

const ROUND: IslandSquare = { left: false, right: false };

/**
 * The top corners of an island the tab stands on that its foot (the hole)
 * reaches into. A foot never lands on a rounded corner (#1734): such a corner
 * is squared while the tab stands there, so the foot always meets a straight
 * top edge. That happens where the tab straddles the gutter between two
 * islands of its kind (split panes, panes and preview); the strip itself
 * starts past the first island's corner (`tabStripPadding`).
 */
export function islandSquareFor(hole: TabHole, island: IslandEdge): IslandSquare {
  const radius = Math.min(nonNegative(island.radius), Math.max(0, (island.right - island.left) / 2));
  if (!(hole.right > island.left && hole.left < island.right) || radius === 0) return ROUND;
  return { left: hole.left < island.left + radius, right: hole.right > island.right - radius };
}

/**
 * Where an island opens its top edge under the tab: the hole's overlap with
 * the island's straight top edge (a rounded corner keeps its outline; a
 * squared one is straight edge too), or null when they do not meet.
 */
export function seamRowFor(hole: TabHole, island: IslandEdge, square: IslandSquare = ROUND): TabSeamRow | null {
  const radius = Math.min(nonNegative(island.radius), Math.max(0, (island.right - island.left) / 2));
  const left = Math.max(hole.left, island.left + (square.left ? 0 : radius));
  const right = Math.min(hole.right, island.right - (square.right ? 0 : radius));
  return right > left ? { left, right } : null;
}

/**
 * The gutters the tab's foot bridges: between two islands of its kind whose
 * facing corners are both squared under it, the tab's fill continues across
 * the gap at the seam's depth, so the foot is one straight run.
 */
export function gutterRowsFor(
  hole: TabHole,
  islands: readonly (IslandEdge & { readonly square: IslandSquare })[],
): TabSeamRow[] {
  const sorted = [...islands].sort((a, b) => a.left - b.left);
  const rows: TabSeamRow[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    if (!a.square.right || !b.square.left || b.left <= a.right) continue;
    const left = Math.max(hole.left, a.right);
    const right = Math.min(hole.right, b.left);
    if (right > left) rows.push({ left, right });
  }
  return rows;
}

/**
 * The span of the active tab its scroller shows, or null when it shows none
 * of it (#1734): islands open only under a tab the strip shows, so a tab
 * scrolled out of view never leaves a seam with nothing above it.
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

/** An island under the strip, and whether it is the kind the tab wears. */
export interface FootIsland extends IslandEdge {
  readonly home: boolean;
}

export interface TabFoot<T extends FootIsland> {
  /** Islands with a corner squared under the foot. */
  readonly squared: readonly (T & { readonly square: IslandSquare })[];
  /** Islands of the tab's own kind that open their top edge under it. */
  readonly seams: readonly { readonly island: T; readonly row: TabSeamRow }[];
  /** Gutters the tab's fill bridges between squared neighbours. */
  readonly bridges: readonly TabSeamRow[];
}

/**
 * Where the tab's foot (its hole) meets the islands below (#1734). The foot
 * always stands on straight top edges: every island it reaches over has the
 * corners under it squared, whatever the island's kind, and the gutter
 * between two squared neighbours is bridged by the tab's fill. Only islands
 * of the tab's own kind (`home`) open their top edge into it; another kind
 * keeps its edge, which the tab then sits on. The strip normally starts past
 * the content island's corner, but a narrow window gives that room back to
 * the tabs (`tabStripStart`), so any tab can stand over any gutter.
 */
export function tabFootFor<T extends FootIsland>(hole: TabHole, islands: readonly T[]): TabFoot<T> {
  const squared: (T & { square: IslandSquare })[] = [];
  const seams: { island: T; row: TabSeamRow }[] = [];
  for (const island of islands) {
    const square = islandSquareFor(hole, island);
    if (square.left || square.right) squared.push({ ...island, square });
    if (!island.home) continue;
    const row = seamRowFor(hole, island, square);
    if (row) seams.push({ island, row });
  }
  return { squared, seams, bridges: gutterRowsFor(hole, squared) };
}

/**
 * The island the tab stands on, whose surface it wears: the one under most
 * of the tab's hole. Ties keep the earlier island.
 */
export function islandUnder<T extends IslandEdge>(islands: readonly T[], hole: TabHole): T | null {
  let best: T | null = null;
  let most = 0;
  for (const island of islands) {
    const overlap = Math.min(hole.right, island.right) - Math.max(hole.left, island.left);
    if (overlap > most) { best = island; most = overlap; }
  }
  return best;
}

/**
 * The tab's painted fill: its silhouette ending on the base, plus the seam
 * rows it reaches down into, `depth` pixels deep.
 */
export function tabFillPath(c: TabContour, rows: readonly TabSeamRow[], depth: number): string {
  const d = Math.max(0, num(depth));
  const seams = d > 0
    ? rows.map((row) => `M${n(row.left)} ${n(c.base)}H${n(row.right)}V${n(c.base + d)}H${n(row.left)}Z`).join("")
    : "";
  return `${tabSilhouettePath(c, 0, 0)}${seams}`;
}

/** Pick the island whose top edge spans `x` on the strip base, if any. */
export function islandAt(islands: readonly IslandEdge[], x: number): IslandEdge | null {
  return islands.find((island) => island.left <= x && x <= island.right) ?? null;
}

/** Padding a tab strip keeps before its first tab when nothing aligns it. */
export const TAB_STRIP_PADDING = 12;

/**
 * Left padding that puts the tab strip over the content islands (#1734).
 *
 * Tabs belong to the content they open, so in Floating Islands the strip
 * starts over the leftmost content island, as Safari's and VS Code's do
 * beside a sidebar: a fused tab then never straddles the gutter beside the
 * sidebar, and the first tab's fillet lands on the island's straight top
 * edge, past its rounded corner. `areaLeft` is where the strip's padding
 * box starts, in the same coordinates as the island.
 */
export function tabStripPadding(
  content: IslandEdge | null | undefined,
  areaLeft: number,
  minimum = TAB_STRIP_PADDING,
): number {
  const floor = Math.max(0, num(minimum, TAB_STRIP_PADDING));
  if (!content || !Number.isFinite(content.left) || !Number.isFinite(areaLeft)) return floor;
  return Math.max(floor, content.left + nonNegative(content.radius) + TAB_FILLET - areaLeft);
}

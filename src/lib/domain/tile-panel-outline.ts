/**
 * Tiles panel outlines (#1241, spec §9.3–§9.4): each attached panel and its
 * parent tile form one "tab and page" contour; a stacked panel's label tab joins
 * its parent's highlight through a ribbon. Pure SVG path geometry from a row
 * group's (possibly mid-motion) geometry, in group-local CSS px.
 */
import {
  R_FILLET, R_PANEL, R_TAB, RIBBON_HALF, ribbonChannel, tabX,
  type GroupGeometry, type Rect, type RowMetrics,
} from "./tile-panels";

const f2 = (n: number): number => +n.toFixed(2);
const P = (x: number, y: number): string => `${f2(x)} ${f2(y)}`;

export interface TabSpec { readonly tx0: number; readonly tx1: number; readonly ty: number }

/**
 * A panel's contour with an attached tab. d = +1 for a panel below its parent,
 * -1 above; yp is the parent-facing panel edge, yf the far edge and `tab.ty`
 * the tab's far end. A tab within r_panel + r_fillet of a panel side runs flush
 * with it. `tabTop` replaces the tab's far edge (the ribbon neck joins there);
 * it receives the tab corner radius and must end at (tx1 - rt, ty).
 */
export function outlinePath(o: { x0: number; x1: number; yp: number; yf: number; d: 1 | -1; tab: TabSpec; tabTop?: (rt: number) => string }): string {
  const { x0, x1, yp, yf, d } = o;
  const rp = Math.min(R_PANEL, Math.abs(yf - yp) / 2, Math.abs(x1 - x0) / 2);
  const rt = Math.min(R_TAB, Math.abs(yp - o.tab.ty) / 2, Math.abs(o.tab.tx1 - o.tab.tx0) / 2);
  const rf = R_FILLET;
  const sweep = (v: 0 | 1) => (d > 0 ? v : 1 - v);
  const A = (r: number, sw: 0 | 1, x: number, y: number) => `A${f2(r)} ${f2(r)} 0 0 ${sweep(sw)} ${P(x, y)}`;
  let { tx0, tx1 } = o.tab;
  const ty = o.tab.ty;
  const flushL = tx0 - x0 < rp + rf, flushR = x1 - tx1 < rp + rf;
  if (flushL) tx0 = x0;
  if (flushR) tx1 = x1;
  const path: string[] = [];
  if (flushL) path.push(`M${P(x0, yp)}`);
  else path.push(`M${P(x0, yp + d * rp)}`, A(rp, 1, x0 + rp, yp), `L${P(tx0 - rf, yp)}`, A(rf, 0, tx0, yp - d * rf));
  path.push(`L${P(tx0, ty + d * rt)}`, A(rt, 1, tx0 + rt, ty), o.tabTop ? o.tabTop(rt) : `L${P(tx1 - rt, ty)}`, A(rt, 1, tx1, ty + d * rt));
  if (flushR) path.push(`L${P(x1, yp)}`);
  else path.push(`L${P(tx1, yp - d * rf)}`, A(rf, 0, tx1 + rf, yp), `L${P(x1 - rp, yp)}`, A(rp, 1, x1, yp + d * rp));
  path.push(`L${P(x1, yf - d * rp)}`, A(rp, 1, x1 - rp, yf), `L${P(x0 + rp, yf)}`, A(rp, 1, x0, yf - d * rp), "Z");
  return path.join(" ");
}

export interface RibbonRoute {
  readonly sx: number;
  readonly sy: number;
  readonly ex: number;
  readonly ey: number;
  readonly channel: number;
  /** Intervening panels and labels (for the bend heights). */
  readonly obstacles: readonly Rect[];
}

interface Sample { x: number; y: number; dx: number; dy: number }
export interface RibbonGeometry {
  /** The centre line: straight runs and cubic bends (the hover hit stroke). */
  readonly path: string;
  /** Edge samples offset by the ribbon half-width, from the parent to the label. */
  readonly left: readonly Sample[];
  readonly right: readonly Sample[];
}

/**
 * The ribbon's centre line: down from the parent, across to its channel in the
 * gap before the first intervening band, down the channel, across to the label
 * after the last one. Bends have an 18px radius (k = 0.55228475); `compact`
 * (mid-motion) shrinks them into whatever gap exists. Analytic tangents give
 * parallel edges.
 */
export function ribbonGeometry(route: RibbonRoute, compact = false): RibbonGeometry {
  const { sx, sy, ex, ey, channel, obstacles } = route;
  const samples: Sample[] = [{ x: sx, y: sy, dx: 0, dy: 1 }];
  let path = `M${P(sx, sy)}`;
  let current = { x: sx, y: sy };
  const line = (x: number, y: number) => {
    if (x === current.x && y === current.y) return;
    path += ` L${P(x, y)}`;
    samples.push({ x, y, dx: x - current.x, dy: y - current.y });
    current = { x, y };
  };
  const curve = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
    const from = current;
    path += ` C${P(x1, y1)} ${P(x2, y2)} ${P(x, y)}`;
    for (let i = 1; i <= 32; i++) {
      const t = i / 32, u = 1 - t;
      samples.push({
        x: u * u * u * from.x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
        y: u * u * u * from.y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y,
        dx: 3 * u * u * (x1 - from.x) + 6 * u * t * (x2 - x1) + 3 * t * t * (x - x2),
        dy: 3 * u * u * (y1 - from.y) + 6 * u * t * (y2 - y1) + 3 * t * t * (y - y2),
      });
    }
    current = { x, y };
  };
  const shift = (x: number, y0: number, y1: number) => {
    const x0 = current.x, dx = x - x0, mid = (y0 + y1) / 2;
    line(x0, y0);
    if (Math.abs(dx) < 36) {
      curve(x0, mid, x, mid, x, y1);
    } else {
      const sign = Math.sign(dx), r = compact ? Math.min(18, Math.max(0, (y1 - y0) / 2)) : 18, k = 0.55228475;
      line(x0, mid - r);
      curve(x0, mid - r + k * r, x0 + sign * (r - k * r), mid, x0 + sign * r, mid);
      line(x - sign * r, mid);
      curve(x - sign * (r - k * r), mid, x, mid + r - k * r, x, mid + r);
      line(x, y1);
    }
  };
  if (sx !== channel) {
    const firstTop = obstacles.length ? Math.min(...obstacles.map(o => o.y0)) : ey;
    const gap = Math.max(0, firstTop - sy);
    const from = compact ? sy + Math.min(6, gap / 4) : sy + 6;
    const to = compact ? sy + Math.min(66, gap - Math.min(10, gap / 4)) : sy + 66;
    shift(channel, from, to);
  }
  if (ex !== channel) {
    const lastBottom = obstacles.length ? Math.max(...obstacles.map(o => o.y1)) : sy;
    const gap = Math.max(0, ey - Math.max(current.y, lastBottom));
    const fromY = compact ? Math.max(current.y, lastBottom + Math.min(10, gap / 4), ey - 66) : Math.max(current.y, lastBottom + 10, ey - 66);
    shift(ex, fromY, compact ? ey - Math.min(6, gap / 4) : ey - 6);
  }
  line(ex, ey);
  const edge = (sign: number): Sample[] => samples.map((sample, i) => {
    let { dx, dy } = sample;
    // A collapsed bend can have a zero derivative; carry its incoming tangent.
    if (!Math.hypot(dx, dy)) ({ dx, dy } = samples.slice(0, i).reverse().find(q => Math.hypot(q.dx, q.dy)) ?? samples[0]);
    const len = Math.hypot(dx, dy) || 1;
    return { x: sample.x + sign * RIBBON_HALF * dy / len, y: sample.y - sign * RIBBON_HALF * dx / len, dx: dx / len, dy: dy / len };
  });
  return { path, left: edge(-1), right: edge(1) };
}

/**
 * The neck that replaces a stacked label's top edge: up the ribbon's left edge
 * from the label (6px concave fillets at both mouths), around the parent's
 * highlight (a tab of radius r_tab over the parent tile), and down the right
 * edge back to the label's top edge, ending at (label.x1 - rt, ey).
 */
function ribbonNeck(route: RibbonRoute, geometry: RibbonGeometry, parent: Rect, labelRight: number, rt: number): string {
  const { sx, sy, ex, ey } = route;
  const rf = R_FILLET, rh = Math.min(R_TAB, (sy - parent.y0) / 2, (parent.x1 - parent.x0) / 2);
  const points = (xs: readonly Sample[]) => xs.map((q, i) => {
    if (!i) return `L${P(q.x, q.y)}`;
    const prev = xs[i - 1], h = Math.hypot(q.x - prev.x, q.y - prev.y) / 3;
    return `C${P(prev.x + prev.dx * h, prev.y + prev.dy * h)} ${P(q.x - q.dx * h, q.y - q.dy * h)} ${P(q.x, q.y)}`;
  }).join(" ");
  const left = geometry.left.slice(1, -1).reverse().map(q => ({ ...q, dx: -q.dx, dy: -q.dy }));
  const right = geometry.right.slice(1, -1);
  const a = parent.x0, b = parent.x1, top = parent.y0, H = RIBBON_HALF;
  return [
    `L${P(ex - H - rf, ey)}`, `Q${P(ex - H, ey)} ${P(ex - H, ey - rf)}`, points(left),
    `L${P(sx - H, sy + rf)}`, `Q${P(sx - H, sy)} ${P(sx - H - rf, sy)}`,
    `L${P(a + rh, sy)}`, `A${f2(rh)} ${f2(rh)} 0 0 1 ${P(a, sy - rh)}`,
    `L${P(a, top + rh)}`, `A${f2(rh)} ${f2(rh)} 0 0 1 ${P(a + rh, top)}`,
    `L${P(b - rh, top)}`, `A${f2(rh)} ${f2(rh)} 0 0 1 ${P(b, top + rh)}`,
    `L${P(b, sy - rh)}`, `A${f2(rh)} ${f2(rh)} 0 0 1 ${P(b - rh, sy)}`,
    `L${P(sx + H + rf, sy)}`, `Q${P(sx + H, sy)} ${P(sx + H, sy + rf)}`, points(right),
    `L${P(ex + H, ey - rf)}`, `Q${P(ex + H, ey)} ${P(ex + H + rf, ey)}`,
    `L${P(labelRight - rt, ey)}`,
  ].join(" ");
}

export interface GradientStop { readonly offset: number; readonly opacity: number }
/** A vertical userSpaceOnUse accent gradient. */
export interface AccentGradient { readonly y1: number; readonly y2: number; readonly stops: readonly GradientStop[] }

export interface PanelOutline {
  readonly path: string;
  /** Closed contour: fill, hairline and accent all stroke this path. */
  readonly d: string;
  readonly accent: AccentGradient;
  /** A stacked panel's ribbon centre line (the hover hit stroke). */
  readonly ribbon: string | null;
  /** An attached panel's tab across the band gap (between the parent tile and
   * the panel): a transparent hit area, so hovering the gap is hovering the
   * panel, and a spring-loaded panel (#1242) stays open while a drag crosses it. */
  readonly bridge: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  readonly opacity: number;
}

/** The accent fades into the hairline over min(64px, 60% of the panel height). */
export const accentFade = (panelHeight: number): number => Math.min(64, 0.6 * Math.max(0, panelHeight));

/**
 * Every panel outline in a row group. Attached panels join their parent tile's
 * tab; a stacked panel's label tab joins the parent's highlight through a
 * ribbon routed around the panels and labels between them.
 */
export function groupOutlines(geometry: GroupGeometry, m: RowMetrics, compact = false): PanelOutline[] {
  const rowTop = geometry.rowTop, rowBottom = rowTop + m.tileHeight;
  const outlines: PanelOutline[] = [];
  geometry.boxes.forEach((box, index) => {
    const tab = tabX(box.col, m);
    const x0 = box.x0, x1 = box.x0 + box.width;
    const fade = accentFade(box.height);
    if (box.side !== "stacked" || !box.label) {
      const d = box.side === "above" ? -1 : 1;
      const yp = d > 0 ? box.top : box.top + box.height;
      const near = d > 0 ? rowBottom : rowTop;
      const bridge = Math.abs(yp - near) > 0 && tab.x1 > tab.x0
        ? { x: tab.x0, y: Math.min(yp, near), width: tab.x1 - tab.x0, height: Math.abs(yp - near) } : null;
      outlines.push({
        path: box.path, opacity: box.opacity, ribbon: null, bridge,
        d: outlinePath({ x0, x1, yp, yf: d > 0 ? box.top + box.height : box.top, d, tab: { tx0: tab.x0, tx1: tab.x1, ty: d > 0 ? rowTop : rowBottom } }),
        accent: { y1: yp, y2: yp + d * fade, stops: [{ offset: 0, opacity: 1 }, { offset: 1, opacity: 0 }] },
      });
      return;
    }
    const labelTop = box.top - Math.max(0, box.labelHeight);
    const label = { x0: box.label.x0, x1: box.label.x0 + box.label.width };
    // Intervening: the below band and earlier stacked bands (boxes come in render order).
    const obstacles = geometry.boxes.slice(0, index).filter(other => other.side !== "above").flatMap(other => {
      const rects: Rect[] = [{ x0: other.x0, x1: other.x0 + other.width, y0: other.top, y1: other.top + other.height }];
      if (other.label) rects.push({ x0: other.label.x0, x1: other.label.x0 + other.label.width, y0: other.top - Math.max(0, other.labelHeight), y1: other.top });
      return rects;
    });
    const channel = ribbonChannel(tab, label, obstacles, m.width);
    const route: RibbonRoute = { ...channel, sy: rowBottom, ey: labelTop, obstacles };
    const ribbon = ribbonGeometry(route, compact);
    const parent: Rect = { x0: tab.x0, x1: tab.x1, y0: rowTop, y1: rowBottom };
    const d = outlinePath({
      x0, x1, yp: box.top, yf: box.top + box.height, d: 1,
      tab: { tx0: label.x0, tx1: label.x1, ty: labelTop },
      tabTop: rt => ribbonNeck(route, ribbon, parent, label.x1, rt),
    });
    // Accent on the parent highlight and the label, fading out along the ribbon.
    const start = rowTop, end = box.top + fade, span = Math.max(1e-6, end - start);
    const mid = (route.sy + route.ey) / 2;
    const at = (y: number, opacity: number): GradientStop => ({ offset: Math.max(0, Math.min(1, (y - start) / span)), opacity });
    outlines.push({
      path: box.path, opacity: box.opacity, ribbon: ribbon.path, bridge: null, d,
      accent: { y1: start, y2: end, stops: [at(start, 1), at(Math.min(route.sy + 64, mid), 0), at(Math.max(route.ey - 64, mid), 0), at(route.ey, 1), at(box.top, 1), at(end, 0)] },
    });
  });
  return outlines;
}

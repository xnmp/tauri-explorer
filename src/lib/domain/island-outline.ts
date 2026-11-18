/**
 * Where the Floating Islands active tab's edge stroke takes over the outline
 * of the islands it opens into (#1734). Pure geometry in the title bar's CSS
 * pixel space (x right, y down), on the device-pixel grid.
 *
 * A seamed island hands its straight top edge to the tab's SVG stroke, so
 * one line runs along the island's top, up the fillet, over the tab and
 * back down. The island clips out (and the tab's fill repaints) its whole
 * top border row between its corners; the corners stay its own. The two
 * painters meet on a device-pixel boundary of that straight 1px line, where
 * each corner's arc becomes the top edge: a rounded corner is drawn by the
 * engine's own border rasteriser, which an SVG arc can only approximate
 * (WebKit draws CSS corners up to 17/255 heavier than a geometric 1px ring),
 * so keeping it CSS keeps every island's corners identical. Ownership is
 * whole device pixels, never shared, so two translucent layers never meet
 * inside one anti-aliased pixel (a conflation seam). A squared corner under
 * the tab's foot is straight, and the stroke takes it over too.
 */

/**
 * CSS pixels to device pixels: `device = origin + css * scale` on each axis.
 * Layout snaps box edges and border widths to whole multiples of `unit`
 * device pixels: one device pixel in WebKit, one zoomed CSS pixel (the
 * device pixel ratio) in Chromium, which snaps before scaling by it.
 */
export interface DeviceGrid {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
  readonly unit?: number;
}

export type Point = readonly [number, number];

const num = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);
/** Short, stable numbers: 3 decimals is far below a device pixel. */
const n = (value: number): string => String(Math.round(value * 1000) / 1000);
const scaleOf = (grid: DeviceGrid): number => (grid.scale > 0 && Number.isFinite(grid.scale) ? grid.scale : 1);
const unitOf = (grid: DeviceGrid): number => (grid.unit && grid.unit > 0 && Number.isFinite(grid.unit) ? grid.unit : 1);
/** A device coordinate snapped as layout snaps a box edge (halves round up). */
const snapDevice = (grid: DeviceGrid, device: number): number => Math.round(device / unitOf(grid) + 1e-9) * unitOf(grid);

/** Snap a CSS x to where layout paints a box edge. */
export function snapX(grid: DeviceGrid, x: number): number {
  return (snapDevice(grid, num(grid.x) + num(x) * scaleOf(grid)) - num(grid.x)) / scaleOf(grid);
}

/** Snap a CSS y to where layout paints a box edge. */
export function snapY(grid: DeviceGrid, y: number): number {
  return (snapDevice(grid, num(grid.y) + num(y) * scaleOf(grid)) - num(grid.y)) / scaleOf(grid);
}

/** A border width as painted: whole snapping units, at least one. */
export function paintedWidth(grid: DeviceGrid, width: number): number {
  const s = scaleOf(grid);
  const unit = unitOf(grid);
  return Math.max(1, Math.floor((num(width, 1) * s) / unit + 1e-6)) * unit / s;
}

/** How the stroke meets one top corner of an island it opens into. */
export type CornerOwnership =
  /** A rounded corner: the island draws it, the stroke starts where it ends. */
  | "round"
  /** A squared corner (the tab's foot stands beside it): the stroke turns it. */
  | "square"
  /** The corner lies under the tab: no stroke there. */
  | null;

export interface CutIsland {
  /** Layout box edges (unsnapped), in bar coordinates. */
  readonly left: number;
  readonly right: number;
  readonly top: number;
  /** Rendered top-corner radius. */
  readonly radius: number;
  /** Painted border width (`paintedWidth`). */
  readonly border: number;
}

export interface IslandCut {
  /**
   * The pixels the island gives up, as an orthogonal outline on device
   * pixels running from the notch's left end on the top edge, west and
   * round the cut, to the notch's right end. Closed along the top edge it is
   * the region the tab's fill repaints and the stroke may paint.
   */
  readonly outline: readonly Point[];
  /** The notch under the tab, on the top edge. */
  readonly notch: { readonly left: number; readonly right: number };
  /** Where the stroke takes over from each corner: the point on the island's outline. */
  readonly handover: { readonly left: Point; readonly right: Point };
}

/**
 * The cut of an island the tab opens into: its top border row between the
 * corners it keeps (`corners`: a rounded corner keeps the island's own
 * border, a squared or covered one is cut too), on device pixels, with the
 * notch under the tab (`notch`, the seam row).
 */
export function islandCut(
  island: CutIsland,
  grid: DeviceGrid,
  notch: { readonly left: number; readonly right: number },
  corners: { readonly left: CornerOwnership; readonly right: CornerOwnership },
): IslandCut {
  const s = scaleOf(grid);
  const toCssX = (x: number) => (x - num(grid.x)) / s;
  const toCssY = (y: number) => (y - num(grid.y)) / s;
  const X0 = snapDevice(grid, num(grid.x) + num(island.left) * s);
  const X1 = Math.max(X0 + 1, snapDevice(grid, num(grid.x) + num(island.right) * s));
  const T = snapDevice(grid, num(grid.y) + num(island.top) * s);
  const w = Math.max(1, Math.round(num(island.border, 1) * s));
  const R = Math.min(Math.max(0, num(island.radius) * s), (X1 - X0) / 2);
  const rounded = (side: CornerOwnership) => side === "round" && R > 0;
  // The straight top edge runs between the corners' tangent points: the
  // first whole device pixel past each arc.
  const left = rounded(corners.left) ? Math.ceil(X0 + R) : X0;
  const right = Math.max(left, rounded(corners.right) ? Math.floor(X1 - R) : X1);
  const clampX = (x: number) => Math.min(right, Math.max(left, x));
  const nL = clampX(snapDevice({ ...grid, unit: 1 }, num(grid.x) + num(notch.left) * s));
  const nR = Math.max(nL, clampX(snapDevice({ ...grid, unit: 1 }, num(grid.x) + num(notch.right) * s)));
  const strip = T + w;
  const outline = dedupe([[nL, T], [left, T], [left, strip], [right, strip], [right, T], [nR, T]])
    .map(([x, y]) => [toCssX(x), toCssY(y)] as Point);
  const handover = (side: "left" | "right"): Point => {
    const x = side === "left" ? left : right;
    return corners[side] === "square" ? [toCssX(side === "left" ? X0 : X1), toCssY(strip)] : [toCssX(x), toCssY(T)];
  };
  return {
    outline,
    notch: { left: toCssX(nL), right: toCssX(nR) },
    handover: { left: handover("left"), right: handover("right") },
  };
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

/** The cut as a closed SVG path (closed along the island's top edge). */
export function cutPath(cut: IslandCut): string {
  const pts = cut.outline;
  if (pts.length < 3) return "";
  return `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join("L")}Z`;
}

/**
 * The island's clip-path polygon, in its own border-box coordinates
 * (`origin`: its layout top-left in bar coordinates). It reaches far past
 * the island, so overlays inside it are never cut, and removes the cut plus
 * everything above the notch (the island's shadow there would darken the tab).
 */
export function islandClipPolygon(origin: { readonly left: number; readonly top: number }, cut: IslandCut): string {
  const x = (v: number) => `${n(v - origin.left)}px`;
  const y = (v: number) => `${n(v - origin.top)}px`;
  return `polygon(${[
    "-100vw -100vh",
    `${x(cut.notch.left)} -100vh`,
    ...cut.outline.map(([px, py]) => `${x(px)} ${y(py)}`),
    `${x(cut.notch.right)} -100vh`,
    "calc(100% + 100vw) -100vh",
    "calc(100% + 100vw) calc(100% + 100vh)",
    "-100vw calc(100% + 100vh)",
  ].join(", ")})`;
}

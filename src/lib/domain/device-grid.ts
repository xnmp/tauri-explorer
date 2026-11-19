/**
 * The device-pixel grid layout paints box edges and borders on (#1734): the
 * Floating Islands tab outline snaps the strip base and its stroke width to
 * it, so the SVG outline lands on the same device pixels as CSS borders.
 * Pure geometry in the title bar's CSS pixel space (x right, y down).
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

const num = (value: number, fallback = 0): number => (Number.isFinite(value) ? value : fallback);
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

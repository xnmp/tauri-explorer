/** Trusted finite bounds: 0 < min <= default <= max. */
export interface ResizeSizeOptions {
  min: number;
  max: number;
  default: number;
  axis?: "x" | "y";
  /** Left/top handles grow the controlled size in the negative direction. */
  invert?: boolean;
  integer?: boolean;
}

export function clampResizeSize(value: unknown, options: ResizeSizeOptions): number {
  const finite = typeof value === "number" && Number.isFinite(value) ? value : options.default;
  return Math.max(options.min, Math.min(options.max, options.integer ? Math.round(finite) : finite));
}

/** Scale converts model units to visual pixels; counter-zoomed surfaces supply it explicitly. */
export function draggedResizeSize(initial: number, delta: number, scale: number, options: ResizeSizeOptions): number {
  if (!Number.isFinite(delta) || !Number.isFinite(scale) || scale <= 0) return initial;
  return clampResizeSize(initial + delta / scale * (options.invert ? -1 : 1), options);
}

export function resizeSizeFromKey(value: number, key: string, options: ResizeSizeOptions): number | undefined {
  if (key === "Home") return options.min;
  if (key === "End") return options.max;
  const [negative, positive] = options.axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (key !== negative && key !== positive) return undefined;
  return clampResizeSize(value + (key === positive ? 10 : -10) * (options.invert ? -1 : 1), options);
}

/** Trusted finite bounds: 0 < min <= default <= max. */
export interface ResizeSizeOptions {
  min: number;
  max: number;
  default: number;
  axis?: "x" | "y";
  /** Left/top handles grow the controlled size in the negative direction. */
  invert?: boolean;
  integer?: boolean;
  /** Source encoding only: zero means the configured default, never a drag value. */
  zeroIsDefault?: boolean;
}

function boundSize(value: number, options: ResizeSizeOptions): number {
  return Math.max(options.min, Math.min(options.max, options.integer ? Math.round(value) : value));
}

export function clampResizeSize(value: unknown, options: ResizeSizeOptions): number {
  const finite = typeof value === "number" && Number.isFinite(value)
    && !(options.zeroIsDefault && value === 0) ? value : options.default;
  return boundSize(finite, options);
}

/** Scale converts model units to visual pixels; counter-zoomed surfaces supply it explicitly. */
export function draggedResizeSize(initial: number, delta: number, scale: number, options: ResizeSizeOptions): number {
  if (!Number.isFinite(delta) || !Number.isFinite(scale) || scale <= 0) return initial;
  return boundSize(initial + delta / scale * (options.invert ? -1 : 1), options);
}

export function resizeSizeFromKey(value: number, key: string, options: ResizeSizeOptions): number | undefined {
  if (key === "Home") return options.min;
  if (key === "End") return options.max;
  const [negative, positive] = options.axis === "y" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
  if (key !== negative && key !== positive) return undefined;
  return boundSize(value + (key === positive ? 10 : -10) * (options.invert ? -1 : 1), options);
}

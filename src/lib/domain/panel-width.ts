/** Trusted configuration: 0 < min <= default <= max, all finite. */
export interface PanelWidthOptions {
  min: number;
  max: number;
  default: number;
  /** A handle on the left grows the panel when moved left. */
  invert?: boolean;
}

export function panelWidth(value: unknown, options: PanelWidthOptions): number {
  const width = typeof value === "number" && Number.isFinite(value) ? value : options.default;
  return Math.max(options.min, Math.min(options.max, width));
}

/** Client coordinates are visual pixels; persisted widths are unzoomed CSS pixels. */
export function draggedPanelWidth(initial: number, delta: number, scale: number, options: PanelWidthOptions): number {
  if (!Number.isFinite(delta) || !Number.isFinite(scale) || scale <= 0) return initial;
  return panelWidth(initial + delta / scale * (options.invert ? -1 : 1), options);
}

export function panelWidthFromKey(width: number, key: string, options: PanelWidthOptions): number | undefined {
  if (key === "Home") return options.min;
  if (key === "End") return options.max;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return undefined;
  return panelWidth(width + (key === "ArrowRight" ? 10 : -10) * (options.invert ? -1 : 1), options);
}

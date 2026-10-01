import { clampResizeSize, type ResizeSizeOptions } from "$lib/domain/resize-size";

export const DETAIL_COLUMNS = {
  name: { label: "Name", min: 150, max: 4096, default: 300 },
  date: { label: "Date modified", min: 80, max: 4096, default: 180 },
  type: { label: "Type", min: 80, max: 4096, default: 140 },
  size: { label: "Size", min: 80, max: 4096, default: 100 },
} as const satisfies Record<string, ResizeSizeOptions & { label: string }>;
// A generous finite layout bound keeps keyboard End useful and malformed widths
// from creating effectively unreachable columns. Widths remain session-local.
export type ColumnKey = keyof typeof DETAIL_COLUMNS;
export type ColumnWidths = Record<ColumnKey, number>;
export type ColumnVisibility = Record<Exclude<ColumnKey, "name">, boolean>;
export const COLUMN_KEYS = Object.keys(DETAIL_COLUMNS) as ColumnKey[];

export function normalizeColumnWidths(input?: Partial<Record<ColumnKey, unknown>> | null): ColumnWidths {
  return Object.fromEntries(COLUMN_KEYS.map(key => [key, clampResizeSize(input?.[key], DETAIL_COLUMNS[key])])) as ColumnWidths;
}

export function columnGridTemplate(widths: ColumnWidths, visible: ColumnVisibility): string {
  return COLUMN_KEYS.filter(key => key === "name" || visible[key]).map(key => `${widths[key]}px`).join(" ");
}

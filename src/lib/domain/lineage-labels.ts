/**
 * Lineage prompt labels (#1449): a provider's optional per-file text
 * (`EntryLineage.labels`) becomes the Details Prompt column and the row label
 * of lineage children. Pure: no Svelte, no IO. Loaded with the lazy lineage
 * controller (`state/pane-lineage.svelte.ts`), so the startup bundle only
 * holds the calls.
 *
 * - `title` is the short summary, preferred for the row label; `prompt` is the
 *   full text, used for the column and the tooltip.
 * - Text is untrusted: non-strings are ignored, whitespace (newlines included)
 *   collapses to one line, and an empty result counts as missing.
 * - A label replaces the filename only on lineage-child occurrences: depth > 0
 *   directly under a file or a lineage group, never under a folder peek.
 */
import { pathComparison } from "./path";

/** One file's provider text (SDK `EntryLineage.labels` values). */
export interface LineageLabel { prompt?: string; title?: string }

/** Bounds a hostile or accidental megabyte prompt; the cell ellipsizes long before. */
export const LINEAGE_PROMPT_MAX = 2000;
export const LINEAGE_TITLE_MAX = 200;

/** One display line: collapsed whitespace, bounded, or null when empty or not text. */
export function lineageText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A visible Details row's placement (`PeekRow` of kind "entry"). */
export interface LineageRowPlacement { entry: { path: string }; depth: number; parentPath: string; parentKey?: string }

/**
 * A lineage child occurrence: beneath a file or a lineage group. Lineage
 * frames place their files at the listing root with a parent occurrence key;
 * files inside a folder peek carry that folder as `parentPath` instead.
 */
export function isLineageChildRow(row: LineageRowPlacement, root: string): boolean {
  return row.depth > 0 && row.parentKey !== undefined && row.parentPath === root;
}

export interface LineageLabels {
  /** Prompt column text (the prompt, else the title), or null: the cell shows "—". */
  prompt(path: string): string | null;
  /** Row label: title → prompt → null (keep the filename). */
  label(path: string): string | null;
  /** The label for a Details row, or null where the filename stays (depth 0, folder peeks, no text). */
  rowLabel(row: LineageRowPlacement, root: string): string | null;
  /** Name-filter match on the prompt (`query` already lowercased). */
  matches(path: string, query: string): boolean;
}

interface Normalized { prompt: string | null; title: string | null; lower: string }

/**
 * Validates a provider's `labels`, keyed by the platform's path rules. Null
 * when absent or not a Map (feature detection: older providers send none),
 * so the host shows neither the column nor labels.
 */
export function normalizeLineageLabels(raw: unknown, windows: boolean): LineageLabels | null {
  if (!(raw instanceof Map)) return null;
  const paths = pathComparison(windows);
  const byKey = new Map<string, Normalized>();
  for (const [path, value] of raw) {
    const key = typeof path === "string" ? paths.key(path) : null;
    if (key === null || !value || typeof value !== "object") continue;
    const prompt = lineageText((value as LineageLabel).prompt, LINEAGE_PROMPT_MAX);
    const title = lineageText((value as LineageLabel).title, LINEAGE_TITLE_MAX);
    if (prompt === null && title === null) continue;
    byKey.set(key, { prompt, title, lower: `${prompt ?? ""}\n${title ?? ""}`.toLowerCase() });
  }
  const find = (path: string) => { const key = paths.key(path); return key === null ? undefined : byKey.get(key); };
  const label = (path: string) => { const item = find(path); return item ? item.title ?? item.prompt : null; };
  return {
    prompt: path => { const item = find(path); return item ? item.prompt ?? item.title : null; },
    label,
    rowLabel: (row, root) => isLineageChildRow(row, root) ? label(row.entry.path) : null,
    matches: (path, query) => !!query && !!find(path)?.lower.includes(query),
  };
}

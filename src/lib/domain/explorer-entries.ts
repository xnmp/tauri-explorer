/** Pure entry-list decisions of an explorer pane: multi-entry labels and
 * context-menu selection merging. */
import type { FileEntry } from "./file";

/** "name" for one entry, else "N items". */
export const entriesLabel = (entries: readonly FileEntry[]): string =>
  entries.length === 1 ? entries[0].name : `${entries.length} items`;

/** The selected listing entries, plus a selected context-menu entry the listing
 * does not hold (for example a search result from another folder). */
export function withExternalEntry(entries: FileEntry[], selected: ReadonlySet<string>, external: FileEntry | null): FileEntry[] {
  if (!external || !selected.has(external.path) || entries.some((e) => e.path === external.path)) return entries;
  return [...entries, external];
}

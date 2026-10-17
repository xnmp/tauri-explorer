/** Find/replace bulk rename over an Explorer selection, which can span a
 * folder and its peeked descendants. Pure: previews, collisions and the order
 * the renames must run in. */
import type { FileEntry } from "./file";
import { pathComparison } from "./path";

export interface BulkRenamePattern { find: string; replace: string; regex: boolean; caseSensitive: boolean }
export interface BulkRenamePreview { entry: FileEntry; original: string; renamed: string; changed: boolean }
export interface BulkRenamePlan {
  previews: BulkRenamePreview[];
  changedCount: number;
  /** New names that two selected entries of one folder would share. */
  duplicates: string[];
  /** Changed entries, descendants before the folders that contain them, so
   * renaming a folder never invalidates a pending path below it. */
  operations: { entry: FileEntry; name: string }[];
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function renamedName(name: string, pattern: BulkRenamePattern): string {
  // A leading dot marks a hidden file, not an extension (".bashrc" has no ext).
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  if (!pattern.regex && pattern.caseSensitive) return stem.split(pattern.find).join(pattern.replace) + ext;
  const source = pattern.regex ? pattern.find : escapeRegex(pattern.find);
  return stem.replace(new RegExp(source, pattern.caseSensitive ? "g" : "gi"), pattern.replace) + ext;
}

export function bulkRenamePlan(entries: readonly FileEntry[], pattern: BulkRenamePattern, windows: boolean): BulkRenamePlan {
  const paths = pathComparison(windows);
  const previews = entries.map((entry): BulkRenamePreview => {
    if (!pattern.find) return { entry, original: entry.name, renamed: entry.name, changed: false };
    try {
      const renamed = renamedName(entry.name, pattern);
      return { entry, original: entry.name, renamed, changed: renamed !== entry.name };
    } catch {
      // An invalid regex while typing previews as "no change".
      return { entry, original: entry.name, renamed: entry.name, changed: false };
    }
  });

  // Collisions are per folder: one name may recur across peeked folders.
  const targets = new Map<string, { name: string; count: number; changed: boolean }>();
  for (const preview of previews) {
    const id = `${paths.parent(preview.entry.path) ?? preview.entry.path}\0${preview.renamed}`;
    const target = targets.get(id) ?? { name: preview.renamed, count: 0, changed: false };
    target.count++; target.changed ||= preview.changed;
    targets.set(id, target);
  }
  const duplicates = [...new Set([...targets.values()].filter(t => t.count > 1 && t.changed).map(t => t.name))];

  const depth = (entry: FileEntry) => {
    const key = paths.key(entry.path);
    return key === null ? 0 : key.split("/").length;
  };
  const operations = previews
    .map((preview, index) => ({ preview, index, depth: depth(preview.entry) }))
    .filter(({ preview }) => preview.changed)
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map(({ preview }) => ({ entry: preview.entry, name: preview.renamed }));

  return { previews, changedCount: operations.length, duplicates, operations };
}

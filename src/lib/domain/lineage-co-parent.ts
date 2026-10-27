/** Display helpers for lineage group rows, kept apart from the grouping so
 * eager row components do not pull it into startup. */
import type { FileEntry } from "./file";
import type { LineageCoParent } from "./entry-lineage";
/** A file-shaped stand-in for a co-parent's icon or thumbnail (never listed). */
export function lineageCoParentEntry(parent: LineageCoParent): FileEntry {
  return parent.kind === "entry"
    ? { name: parent.name, path: parent.path, kind: "file", size: 0, modified: "" }
    : { name: parent.label, path: parent.thumbnailPath ?? parent.label, kind: "file", size: 0, modified: "" };
}

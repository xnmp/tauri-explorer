import type { FileEntry, ViewMode } from "./file";
import { resolveListMove, type ListNavigationSnapshot } from "./list-column-flow";
import type { TileNavigationSnapshot } from "./tile-panel-navigation";
import { occurrencePath } from "./folder-peek-flat";

/**
 * The cursor's index in the visible entries. `cursorKey` names the cursor's
 * occurrence when a path is listed more than once (lineage peek); it counts
 * only while it still names `cursorPath`, else the path's first occurrence
 * is the cursor. -1 for an empty listing.
 */
export function resolveCursorIndex(
  entries: readonly FileEntry[],
  keys: readonly string[] | undefined,
  cursorPath: string | null,
  cursorKey: string | null,
  selectedPaths: ReadonlySet<string>,
): number {
  if (cursorPath !== null) {
    if (keys && cursorKey !== null && occurrencePath(cursorKey) === cursorPath) {
      const index = keys.indexOf(cursorKey);
      if (index >= 0) return index;
    }
    const index = entries.findIndex((entry) => entry.path === cursorPath);
    if (index >= 0) return index;
  }
  const selected = selectedPaths.size ? entries.findIndex((entry) => selectedPaths.has(entry.path)) : -1;
  return selected >= 0 ? selected : entries.length ? 0 : -1;
}

/** A keyboard cursor is independent of the selected set and survives sorting. */
export function resolveFileCursor(
  entries: readonly FileEntry[],
  cursorPath: string | null,
  selectedPaths: ReadonlySet<string>,
): FileEntry | undefined {
  // Each skipped scan would hash every entry's path (#1416).
  return (cursorPath === null ? undefined : entries.find((entry) => entry.path === cursorPath))
    ?? (selectedPaths.size ? entries.find((entry) => selectedPaths.has(entry.path)) : undefined)
    ?? entries[0];
}

export interface FileListKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}
export type FileListMove =
  | { kind: "focus"; index: number; selection: "replace" | "extend" | "preserve" }
  | { kind: "handled" }
  | { kind: "parent" }
  | { kind: "open"; index: number };

/** PageUp/PageDown distance in visual lines (rows), shared by every grid view. */
export const PAGE_LINES = 10;

export function resolveFileListMove(
  event: FileListKey,
  layout: { viewMode: ViewMode; columns: number; count: number; cursorIndex: number; directory: boolean; yazi: boolean;
    /** "columns" = Folder Peek column flow (needs `list`); "rows" = classic row-major List. */
    listLayout?: "rows" | "columns"; list?: ListNavigationSnapshot | null;
    /** Tiles with open Folder Peek panels: spatial arrows (#1241). Null or
     * absent keeps the classic grid arithmetic. */
    tiles?: TileNavigationSnapshot | null },
): FileListMove | null {
  if (event.altKey || !Number.isSafeInteger(layout.count) || layout.count < 0
    || !Number.isSafeInteger(layout.cursorIndex) || layout.cursorIndex < -1 || layout.cursorIndex >= layout.count) return null;
  if (layout.viewMode === "list" && layout.listLayout === "columns") {
    return layout.list ? resolveListMove(event, layout.list.model, layout.cursorIndex, layout.list.usableWidth, layout.list.cardScrollTop) : null;
  }
  if (layout.viewMode === "tiles" && layout.tiles) return layout.tiles.resolve(event, layout.cursorIndex);
  const modified = event.ctrlKey || event.metaKey;
  const arrow = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key);
  const columns = Number.isFinite(layout.columns) ? Math.max(1, Math.floor(layout.columns)) : 1;
  const yazi = layout.yazi && (layout.viewMode === "details" || (layout.viewMode === "list" && columns === 1));
  if (arrow && yazi && !modified && !event.shiftKey) {
    if (event.key === "ArrowLeft") return { kind: "parent" };
    if (event.key === "ArrowRight" && layout.directory && layout.cursorIndex >= 0) return { kind: "open", index: layout.cursorIndex };
  }
  if (layout.count === 0) return null;
  let index: number;
  if (modified && (event.key === "Home" || event.key === "End")) {
    index = event.key === "Home" ? 0 : layout.count - 1;
  } else if (arrow) {
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (horizontal && layout.viewMode === "details") return null;
    const step = horizontal || layout.viewMode === "details" ? 1 : columns;
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    index = layout.cursorIndex < 0 ? 0 : layout.cursorIndex + (forward ? step : -step);
    if (index < 0 || index >= layout.count) return null;
  } else if (!modified && (event.key === "PageUp" || event.key === "PageDown")) {
    const page = (event.key === "PageDown" ? PAGE_LINES : -PAGE_LINES) * (layout.viewMode === "details" ? 1 : columns);
    index = layout.cursorIndex < 0 ? 0 : Math.max(0, Math.min(layout.count - 1, layout.cursorIndex + page));
  } else return null;
  return { kind: "focus", index, selection: event.shiftKey ? "extend" : modified && arrow ? "preserve" : "replace" };
}

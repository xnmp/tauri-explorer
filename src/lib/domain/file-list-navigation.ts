import type { FileEntry, ViewMode } from "./file";

/** A keyboard cursor is independent of the selected set and survives sorting. */
export function resolveFileCursor(
  entries: readonly FileEntry[],
  cursorPath: string | null,
  selectedPaths: ReadonlySet<string>,
): FileEntry | undefined {
  return entries.find((entry) => entry.path === cursorPath)
    ?? entries.find((entry) => selectedPaths.has(entry.path))
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
  | { kind: "parent" }
  | { kind: "open"; index: number };

export function resolveFileListMove(
  event: FileListKey,
  layout: { viewMode: ViewMode; columns: number; count: number; cursorIndex: number; directory: boolean; yazi: boolean },
): FileListMove | null {
  if (event.altKey || !Number.isSafeInteger(layout.count) || layout.count < 0
    || !Number.isSafeInteger(layout.cursorIndex) || layout.cursorIndex < -1 || layout.cursorIndex >= layout.count) return null;
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
    index = layout.cursorIndex < 0 ? 0
      : Math.max(0, Math.min(layout.count - 1, layout.cursorIndex + (event.key === "PageDown" ? 8 : -8)));
  } else return null;
  return { kind: "focus", index, selection: event.shiftKey ? "extend" : modified && arrow ? "preserve" : "replace" };
}

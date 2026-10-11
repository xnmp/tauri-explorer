import { admitFileDrop } from "$lib/state/dispatch-file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { isExplorerFileTransfer, domDropPaths, internalDragPaths, sameDropPathSet } from "$lib/domain/file-drop";
import { isWindows } from "$lib/domain/platform";

/** Returns whether the Quick Access file adapter handled this gesture. */
export function dropOnQuickAccess(event: DragEvent): boolean {
  if (!isExplorerFileTransfer(event.dataTransfer) || !event.dataTransfer) return false;
  event.preventDefault();
  event.stopPropagation();
  const source = event.dataTransfer ? dragState.domSource(event.dataTransfer) : dragState.current;
  const receipt = admitFileDrop(resolveDropTargetFromElement(event.target as Element | null), source, "dom");
  if (!receipt) return true;
  try {
    const payload = domDropPaths(event.dataTransfer, isWindows);
    const paths = internalDragPaths(source, isWindows);
    if (source?.kind === "directory" && payload && paths && sameDropPathSet(payload, paths, isWindows)) bookmarksStore.addBookmark(source.path, source.name);
  } finally { receipt.finish(); }
  return true;
}

export function dropBookmarkReorder(event: DragEvent, from: number | null, to: number): boolean {
  if (from === null || !event.dataTransfer?.types.includes("application/x-bookmark-index")) return false;
  event.preventDefault();
  const receipt = admitFileDrop(resolveDropTargetFromElement(event.target as Element | null), null, "dom");
  if (!receipt) return true;
  try { if (from !== to) bookmarksStore.reorderBookmarks(from, to); }
  finally { receipt.finish(); }
  return true;
}

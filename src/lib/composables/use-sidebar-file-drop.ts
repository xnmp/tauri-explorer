import { admitFileDrop } from "$lib/state/dispatch-file-drop";
import { resolveDropTargetFromElement } from "./use-native-drop-target.svelte";
import { dragState } from "$lib/state/drag.svelte";
import { bookmarksStore } from "$lib/state/bookmarks.svelte";
import { internalDragPaths, sameDropPathSet } from "$lib/domain/file-drop";
import { getDropSourcePaths } from "$lib/state/drop-operations";
import { isWindows } from "$lib/domain/platform";
import { isTrashPath } from "$lib/domain/virtual-path";
import { dropTrashEntries } from "$lib/state/trash-provider";

/** Returns whether the Quick Access file adapter handled this gesture. */
export function dropOnQuickAccess(event: DragEvent): boolean {
  if (!dragState.acceptsFileDrop(event.dataTransfer) || !event.dataTransfer) return false;
  const source = dragState.domSource(event.dataTransfer);
  if (!source) return false;
  event.preventDefault();
  event.stopPropagation();
  const target = resolveDropTargetFromElement(event.target as Element | null);
  const receipt = admitFileDrop(target, source, "dom");
  if (!receipt) return true;
  try {
    // A trashed folder is restored into a bookmark, never pinned (#1554).
    if (isTrashPath(source.path)) { void dropTrashEntries(source, target); return true; }
    const payload = getDropSourcePaths(event.dataTransfer);
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

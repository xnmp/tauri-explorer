/** Text for a Bookmarks drop, based on the operation the drop will perform. */
export function getBookmarkDropHint(kind: string | undefined, isBookmarkTarget: boolean, fromTrash = false): string {
  // Trash entries restore into a bookmarked folder and are never pinned (#1554).
  if (fromTrash) return isBookmarkTarget ? "Restore to bookmark" : "Drop on a bookmark to restore";
  if (kind === "directory") return "Drop to pin";
  return isBookmarkTarget ? "Move to bookmark" : "Drop not allowed";
}

/** Use the same in-memory-then-persisted precedence as native drop handling. */
export function getEffectiveDragKind(
  current: { kind: string } | null,
  crossWindow: { kind: string } | null,
): string | undefined {
  return (current ?? crossWindow)?.kind;
}

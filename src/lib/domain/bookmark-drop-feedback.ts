/** Text for a Bookmarks drop, based on the operation the drop will perform. */
export function getBookmarkDropHint(kind: string | undefined, isBookmarkTarget: boolean): string {
  if (kind === "directory") return "Drop to pin";
  return isBookmarkTarget ? "Move to bookmark" : "Drop not allowed";
}

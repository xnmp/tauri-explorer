/** A drag measures pointer movement from where it started, so it stays valid
 * until something moves its handle under the pointer. Among scrolls, only the
 * document's, an ancestor's, or one the handle is synced to from outside (a
 * header that follows a body's scrollLeft) can do that. Any other scroller,
 * such as a file list keeping its selection in view as the drag shrinks it,
 * leaves the handle alone. An unrecognised target counts as moving it.
 *
 * Structural types keep this rule testable without a DOM. */
export interface ContainingNode { contains(other: unknown): boolean }

export function scrollMovesHandle(target: unknown, handle: unknown, documentTarget: unknown,
  synced: readonly unknown[] = []): boolean {
  if (target === documentTarget || synced.includes(target)) return true;
  if (typeof (target as Partial<ContainingNode> | null)?.contains !== "function") return true;
  return (target as ContainingNode).contains(handle);
}

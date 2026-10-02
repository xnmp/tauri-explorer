/**
 * Which clipboard source a file-list Paste consumes (#865). The native worker
 * snapshot orders every accepted clipboard job across windows; this decides
 * between the app's own Copy/Cut and a file list another application put on
 * the system clipboard.
 */

export interface ClipboardSnapshotView<E> {
  readonly revision: number;
  readonly entries: readonly E[] | null;
  readonly paths: readonly string[];
  readonly operation: "copy" | "cut" | null;
}

export type PasteSource<E> =
  | { readonly kind: "internal"; readonly entries: readonly E[]; readonly operation: "copy" | "cut"; readonly revision: number }
  | { readonly kind: "external"; readonly paths: readonly string[] }
  | { readonly kind: "none" };

/**
 * The app's entries win while the system clipboard still mirrors them (a
 * non-empty path list), or when the system clipboard cannot be read and the
 * entries are a Copy. A Cut is never pasted from app state alone, because only
 * the mirrored system clipboard proves no other application replaced it.
 */
export function selectPasteSource<E>(
  snapshot: ClipboardSnapshotView<E> | null,
  readError: string | null,
): PasteSource<E> {
  if (snapshot?.entries && snapshot.operation) {
    const mirrored = snapshot.paths.length > 0;
    if (mirrored || (readError !== null && snapshot.operation === "copy")) {
      return { kind: "internal", entries: snapshot.entries, operation: snapshot.operation, revision: snapshot.revision };
    }
  }
  if (snapshot && snapshot.paths.length > 0) return { kind: "external", paths: snapshot.paths };
  return { kind: "none" };
}

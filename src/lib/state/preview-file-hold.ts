/** The preview's file across active-pane changes (#1729): the previous result
 * is an input of `previewFileFor`, so it lives here rather than in the
 * component. `next` is called from PreviewPane's derived selection; the held
 * value is plain (untracked) state, so only the pane's own state drives it. */
import type { FileEntry } from "$lib/domain/file";
import { previewFileFor } from "$lib/domain/preview-kind";

/** What the hold reads from the active explorer. */
export interface PreviewSource {
  getSettledSelectedEntries(): readonly FileEntry[];
  readonly awaitingFirstListing: boolean;
  readonly currentPath: string;
}

export function createPreviewFileHold() {
  let shown: FileEntry | null = null;
  return {
    /** The file to preview for `pane`, the active explorer (none: no file). */
    next(pane: PreviewSource | null | undefined): FileEntry | null {
      shown = pane ? previewFileFor({
        selected: pane.getSettledSelectedEntries(),
        awaitingFirstListing: pane.awaitingFirstListing,
        directory: pane.currentPath,
      }, shown) : null;
      return shown;
    },
  };
}

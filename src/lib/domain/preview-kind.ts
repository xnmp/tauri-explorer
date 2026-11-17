/** The single precedence order for file preview dispatch, including image holds. */
import type { FileEntry } from "./file";
import { nativeParentDir, sameNativeDirectory } from "./path";
import { getFileIconCategory, isImageFile, isSvgFile, isPdfFile, isVideoMediaFile, isVideoFile, isZipFile, isTextFile } from "./file-types";

export type PreviewKind = "directory" | "zip" | "pdf" | "video" | "image" | "audio-cover" | "csv" | "html" | "markdown" | "code" | "text" | "unsupported";

export function classifyPreview(file: FileEntry): PreviewKind {
  if (file.kind === "directory") return "directory";
  if (isZipFile(file)) return "zip";
  if (isPdfFile(file)) return "pdf";
  if (isVideoMediaFile(file)) return "video";
  if (isImageFile(file) || isSvgFile(file)) return "image";
  if (isVideoFile(file)) return "audio-cover";
  if (isTextFile(file)) {
    if (/\.html?$/i.test(file.name)) return "html";
    if (/\.csv$/i.test(file.name)) return "csv";
    if (/\.(md|markdown)$/i.test(file.name)) return "markdown";
    return getFileIconCategory(file) === "code" ? "code" : "text";
  }
  return "unsupported";
}

/** Cover art can be held too, but only the plain-image loader replaces a hold. */
export function shouldHoldPreviewImage(shown: PreviewKind | null, next: PreviewKind): boolean {
  return (shown === "image" || shown === "audio-cover") && next === "image";
}

/** The active pane as the preview sees it. */
export interface PreviewPaneState {
  readonly selected: readonly FileEntry[];
  readonly awaitingFirstListing: boolean;
  /** The pane's directory ("" before an unseeded pane's first listing). */
  readonly directory: string;
}

/** The file the preview shows for the active pane's settled selection. A pane
 * still waiting for its first listing (a new tab or split) that has selected
 * nothing keeps the file already shown when that file lives in the pane's own
 * directory, so the preview does not flash its empty state before the listing
 * selects a row (#1729). A file from another directory is never held. */
export function previewFileFor(pane: PreviewPaneState, shown: FileEntry | null): FileEntry | null {
  if (pane.selected.length === 1) return pane.selected[0];
  const holds = pane.selected.length === 0 && pane.awaitingFirstListing && !!shown && pane.directory !== ""
    && sameNativeDirectory(nativeParentDir(shown.path), pane.directory);
  return holds ? shown : null;
}

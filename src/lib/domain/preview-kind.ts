/** The single precedence order for file preview dispatch, including image holds. */
import type { FileEntry } from "./file";
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

/** The file the preview shows for the active pane's settled selection. A pane
 * still waiting for its first listing (a new tab or split) that has selected
 * nothing keeps the file already shown, so the preview does not flash its
 * empty state before that listing selects a row (#1729). */
export function previewFileFor<T>(
  selected: readonly T[],
  awaitingFirstListing: boolean,
  shown: T | null,
): T | null {
  if (selected.length === 1) return selected[0];
  return selected.length === 0 && awaitingFirstListing ? shown : null;
}

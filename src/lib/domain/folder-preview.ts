/**
 * Domain object for folder preview thumbnails (issue #146).
 *
 * A FolderPreview names the representative images shown inside a folder tile
 * at large/XL sizes, plus a fingerprint that changes whenever the preview
 * would change — so callers can skip re-rendering unchanged folders.
 *
 * The backend (`get_folder_preview`) applies the same selection rules over a
 * bounded directory scan; this module is the canonical spec for those rules
 * and powers the browser mock so E2E exercises real selection behavior.
 */

export const MAX_PREVIEW_IMAGES = 3;

export interface FolderPreview {
  /** Folder the preview describes. */
  readonly folder_path: string;
  /** Up to MAX_PREVIEW_IMAGES image paths, deterministic order (front first). */
  readonly image_paths: readonly string[];
  /**
   * Changes whenever the folder's mtime or chosen image set changes; equal
   * fingerprints mean the rendered preview would be identical.
   */
  readonly fingerprint: string;
}

/**
 * Raster image extensions eligible for folder previews. Mirrors the backend's
 * supported-decoder list (and the thumbnail pipeline both sides delegate to);
 * SVG is excluded because the raster thumbnailer can't decode it.
 */
const PREVIEW_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "icns",
  "avif",
]);

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** True if a file name is eligible to appear in a folder preview. */
export function isPreviewImageName(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("~$")) return false;
  return PREVIEW_IMAGE_EXTENSIONS.has(extension(name));
}

/**
 * Pure selection rule: from a folder's file names, pick up to `max` preview
 * images — eligible extensions only, hidden/temp files skipped, byte-order
 * sorted so the choice is deterministic regardless of input order (matching
 * the backend's lexicographic path sort).
 */
export function selectPreviewImages(
  names: readonly string[],
  max: number = MAX_PREVIEW_IMAGES
): string[] {
  if (max <= 0) return [];
  return names
    .filter(isPreviewImageName)
    .sort() // byte order, not locale collation — must match the Rust sort
    .slice(0, max);
}

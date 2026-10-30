/**
 * Row thumbnails in Details and List (#1465): the opt-in `rowThumbnails`
 * setting swaps each rendered row's 16px icon for a 48px image/video
 * thumbnail. Every row grows to one fixed, larger height so virtualization,
 * the keyboard cursor, marquee hit-testing and Details columns keep working
 * from a single number. Pure, no framework deps.
 */

import type { FileEntry } from "./file";
import { isImageFile, isVideoFile } from "./file-types";
import { THUMBNAIL_SIZE_CONFIG } from "./tile-layout";

/** Thumbnail edge in a row, in CSS px. */
export const ROW_THUMBNAIL_SIZE = 48;
/** Backend size/quality match the Tiles "small" preset (also 48px), so a
 *  thumbnail generated for either view is a cache hit in the other. */
export const ROW_THUMBNAIL_GEN_SIZE = THUMBNAIL_SIZE_CONFIG.small.genSize;
export const ROW_THUMBNAIL_QUALITY = THUMBNAIL_SIZE_CONFIG.small.quality;

/** Details row: 48px thumbnail + 4px padding each side + 1px borders. */
export const DETAILS_THUMBNAIL_ROW_HEIGHT = ROW_THUMBNAIL_SIZE + 10;
/** List row (classic and column flow): a 16px-icon item is 26px tall in a
 *  30px slot; a thumbnail item is 58px in a 62px slot. */
export const LIST_ROW_HEIGHT = 30;
export const LIST_THUMBNAIL_ROW_HEIGHT = ROW_THUMBNAIL_SIZE + 14;

/** The Details row height: a layout theme's own height, raised to fit a
 *  thumbnail when row thumbnails are on (a taller layout row stays). */
export function detailsRowHeight(layoutRowHeight: number, thumbnails: boolean): number {
  return thumbnails ? Math.max(layoutRowHeight, DETAILS_THUMBNAIL_ROW_HEIGHT) : layoutRowHeight;
}

/** The List row (slot) height. */
export function listRowHeight(thumbnails: boolean): number {
  return thumbnails ? LIST_THUMBNAIL_ROW_HEIGHT : LIST_ROW_HEIGHT;
}

export type RowThumbnailKind = "image" | "video";

/** What a row requests: an image thumbnail, a video frame (or audio cover
 *  art), or nothing — folders and other files keep their icon. Requests are
 *  made only by mounted (virtualized, on-screen) rows. */
export function rowThumbnailKind(entry: FileEntry): RowThumbnailKind | null {
  if (isImageFile(entry)) return "image";
  if (isVideoFile(entry)) return "video";
  return null;
}

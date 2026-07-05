/**
 * API client for image/video thumbnails, folder previews, and palette extraction.
 * Issue: refactor/audit-tier4-splits (#212)
 */

import type { FolderPreview } from "$lib/domain/folder-preview";
import { invoke, extractError, virtualPathGuard, dataUriToBlobUrl, type ApiResult } from "./common";

/**
 * Get the path to a cached thumbnail for an image file.
 * Generates the thumbnail if not already cached.
 *
 * @param path - Full path to image file
 * @param size - Optional thumbnail size (default 128)
 * @returns Result with cached thumbnail path or error
 */
export async function getThumbnail(
  path: string,
  size?: number
): Promise<ApiResult<string>> {
  try {
    const thumbnailPath = await invoke<string>("get_thumbnail", { path, size });
    return { ok: true, data: thumbnailPath };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get thumbnail as blob URL.
 *
 * @param path - Full path to image file
 * @param size - Optional thumbnail size (default 128)
 * @returns Result with blob URL or error
 */
export async function getThumbnailData(
  path: string,
  size?: number,
  quality?: number
): Promise<ApiResult<string>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    const dataUri = await invoke<string>("get_thumbnail_data", { path, size, quality });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get micro thumbnail (16x16) as blob URL for progressive loading.
 * Also pre-warms the full thumbnail cache as a side effect.
 *
 * @param path - Full path to image file
 * @returns Result with blob URL or error
 */
export async function getMicroThumbnail(
  path: string,
  prewarmSize?: number,
  prewarmQuality?: number
): Promise<ApiResult<string>> {
  const guard = virtualPathGuard(path);
  if (guard) return guard;
  try {
    const dataUri = await invoke<string>("get_micro_thumbnail", { path, prewarmSize, prewarmQuality });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get a video thumbnail (extracted frame) as a blob URL.
 * Requires ffmpeg on PATH; returns an error otherwise so callers can fall back
 * to the file-type icon.
 *
 * @param path - Full path to video file
 * @param size - Optional generation size
 * @param quality - Optional JPEG quality
 */
export async function getVideoThumbnailData(
  path: string,
  size?: number,
  quality?: number
): Promise<ApiResult<string>> {
  try {
    const dataUri = await invoke<string>("get_video_thumbnail_data", { path, size, quality });
    return { ok: true, data: dataUriToBlobUrl(dataUri) };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get the folder-preview descriptor for a directory: up to a few
 * representative image paths plus a change fingerprint (see
 * $lib/domain/folder-preview for the selection spec). Empty `image_paths`
 * means "no eligible images" — callers show the plain folder icon.
 *
 * @param path - Full path to folder
 */
export async function getFolderPreview(path: string): Promise<ApiResult<FolderPreview>> {
  try {
    const preview = await invoke<FolderPreview>("get_folder_preview", { path });
    return { ok: true, data: preview };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Thumbnail cache statistics.
 */
export interface ThumbnailCacheStats {
  count: number;
  totalSize: number;
  path: string;
}

/**
 * Clear the thumbnail cache.
 *
 * @returns Result with bytes cleared or error
 */
export async function clearThumbnailCache(): Promise<ApiResult<number>> {
  try {
    const bytesCleared = await invoke<number>("clear_thumbnail_cache");
    return { ok: true, data: bytesCleared };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Get thumbnail cache statistics.
 *
 * @returns Result with cache stats or error
 */
export async function getThumbnailCacheStats(): Promise<ApiResult<ThumbnailCacheStats>> {
  try {
    const stats = await invoke<ThumbnailCacheStats>("get_thumbnail_cache_stats");
    return { ok: true, data: stats };
  } catch (err) {
    return { ok: false, error: extractError(err) };
  }
}

/**
 * Extract a representative colour palette from an image (used to derive a
 * theme from a picture). Returns `count` hex colour strings.
 */
export async function extractPalette(path: string, count: number = 6): Promise<string[]> {
  return invoke<string[]>("extract_palette", { path, count });
}

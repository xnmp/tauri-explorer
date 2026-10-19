/**
 * Image loading for the Preview pane: file images and plugin Preview targets
 * (#1033) load the same way.
 *
 * With `rendition`, the backend is first asked for a display-sized rendition
 * of a large raster image (#1054); a small, animated or unsupported image is
 * its own original. Any rendition failure falls through to the original, so
 * the worst case is the full-resolution load the pane always used to do.
 * Plugin targets and fullscreen request the original directly.
 *
 * In Tauri the image streams through the `asset:` protocol and is decoded
 * off-screen. When that fails — cloud-mounted placeholders (Google Drive,
 * OneDrive) the asset server cannot stream, or a path outside its scope, such
 * as a plugin's temp directory on macOS — the bytes come through the backend
 * (`read_image_data_url`, capped at 32 MB) as a blob URL. In browser/E2E mode
 * the backend read is the only path; the mock serves a data URI.
 *
 * The caller owns any blob URL through `owner`, which also reports whether the
 * load is still wanted; a superseded load stops at the next step.
 */
import { isTauri } from "$lib/api/common";
import { readImageAsBlobUrl } from "$lib/api/files";
import { logFrontendDiagnostic } from "$lib/api/frontend-log";
import { getImageResolution } from "$lib/api/image-resolution";
import type { ImageResolution } from "$lib/domain/image-resolution";
import { getPreviewImage } from "$lib/api/thumbnails";
import { SKIPPED, type LatestOnlyRunner } from "$lib/domain/latest-only";
import { mayHaveRendition, type PreviewImageResolution } from "$lib/domain/preview-rendition";

export interface PreviewImageOwner {
  /** Whether this load is still the one the caller wants. */
  isCurrent(): boolean;
  /** Takes ownership of a returned blob URL; false (and released) if superseded. */
  adoptBlob(url: string): boolean;
  /** Releases a blob URL this load adopted but will not show. */
  releaseBlob(url: string): void;
}

export interface PreviewImageReady {
  readonly status: "ready";
  readonly url: string;
  /** The bytes came through the backend read rather than the asset protocol. */
  readonly viaBackend: boolean;
  /** A display-sized rendition, or the file itself. */
  readonly resolution: PreviewImageResolution;
  /** The off-screen element that decoded it; a cache keeps it referenced (#1014). */
  readonly decoded: HTMLImageElement;
  /** Original source header pixels; absent for original loads, null if unavailable. */
  readonly sourceSize?: ImageResolution | null;
}

export type PreviewImageLoad =
  | PreviewImageReady
  | { readonly status: "failed" }
  /** Superseded: the caller shows nothing from this load. */
  | { readonly status: "stale" };

export interface PreviewRenditionOptions {
  /** Longest rendition edge in device pixels (see `domain/preview-rendition`). */
  readonly maxEdge: number;
  /**
   * Serialises the backend requests of one surface so selections skipped
   * while a decode runs never queue decode work of their own.
   */
  readonly runner?: LatestOnlyRunner;
}

export interface PreviewImageOptions {
  /** Prefer a display-sized rendition; omitted, the original is loaded. */
  readonly rendition?: PreviewRenditionOptions;
}

const STALE: PreviewImageLoad = { status: "stale" };
const FAILED: PreviewImageLoad = { status: "failed" };

/** Decode an image off the main thread so selection/animation aren't blocked. */
export async function decodeImage(url: string): Promise<string> {
  await decodeImageElement(url);
  return url;
}

async function decodeImageElement(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function assetUrl(path: string, cacheBust: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return `${convertFileSrc(path)}?v=${encodeURIComponent(cacheBust)}`;
}

async function loadViaBackend(
  path: string,
  owner: PreviewImageOwner,
  resolution: PreviewImageResolution,
): Promise<PreviewImageLoad> {
  const fallback = await readImageAsBlobUrl(path);
  if (!owner.isCurrent()) {
    owner.adoptBlob(fallback.ok ? fallback.data : "");
    return STALE;
  }
  if (!fallback.ok) {
    console.warn("[preview] backend image read failed", { path, error: fallback.error });
    logFrontendDiagnostic("preview backend image read failed", { path, error: fallback.error });
    return FAILED;
  }
  if (!owner.adoptBlob(fallback.data)) return STALE;
  try {
    const decoded = await decodeImageElement(fallback.data);
    if (!owner.isCurrent()) return STALE;
    return { status: "ready", url: fallback.data, viaBackend: true, resolution, decoded };
  } catch (error) {
    if (!owner.isCurrent()) return STALE;
    owner.releaseBlob(fallback.data);
    console.warn("[preview] backend image decode failed", { path, error });
    logFrontendDiagnostic("preview backend image decode failed", { path, error: errorText(error) });
    return FAILED;
  }
}

/** The file itself: asset protocol, then the backend read. */
async function loadOriginal(path: string, cacheBust: string, owner: PreviewImageOwner): Promise<PreviewImageLoad> {
  if (!isTauri()) return loadViaBackend(path, owner, "original");
  try {
    const url = await assetUrl(path, cacheBust);
    if (!owner.isCurrent()) return STALE;
    // Decode off-screen — the caller's spinner stays visible until ready.
    const decoded = await decodeImageElement(url);
    if (!owner.isCurrent()) return STALE;
    return { status: "ready", url, viaBackend: false, resolution: "original", decoded };
  } catch (assetErr) {
    if (!owner.isCurrent()) return STALE;
    console.warn("[preview] asset image decode failed; using backend fallback", { path, error: assetErr });
    logFrontendDiagnostic("preview asset image decode failed", { path, error: errorText(assetErr) });
    return loadViaBackend(path, owner, "original");
  }
}

/** A cached rendition file; null when it cannot be shown (load the original). */
async function loadRenditionFile(
  renditionPath: string,
  cacheBust: string,
  owner: PreviewImageOwner,
): Promise<PreviewImageLoad | null> {
  if (!isTauri()) {
    const image = await loadViaBackend(renditionPath, owner, "rendition");
    return image.status === "failed" ? null : image;
  }
  try {
    const url = await assetUrl(renditionPath, cacheBust);
    if (!owner.isCurrent()) return STALE;
    const decoded = await decodeImageElement(url);
    if (!owner.isCurrent()) return STALE;
    return { status: "ready", url, viaBackend: false, resolution: "rendition", decoded };
  } catch (error) {
    if (!owner.isCurrent()) return STALE;
    // Pruned from the cache, or outside the asset scope (XDG_CACHE_HOME
    // outside $HOME): the original still works.
    console.warn("[preview] rendition decode failed; loading the original", { renditionPath, error });
    logFrontendDiagnostic("preview rendition decode failed", { path: renditionPath, error: errorText(error) });
    return null;
  }
}

/** The rendition when the backend has one; null to load the original instead. */
async function loadRendition(
  path: string,
  cacheBust: string,
  owner: PreviewImageOwner,
  options: PreviewRenditionOptions,
): Promise<PreviewImageLoad | null> {
  const request = () => getPreviewImage(path, options.maxEdge);
  const answer = options.runner
    ? await options.runner.run(request, () => owner.isCurrent())
    : await request();
  if (answer === SKIPPED || !owner.isCurrent()) return STALE;
  if (!answer.ok) {
    console.warn("[preview] rendition request failed; loading the original", { path, error: answer.error });
    logFrontendDiagnostic("preview rendition request failed", { path, error: answer.error });
    return null;
  }
  if (answer.data.kind === "original") return null;
  const [image, sourceSize] = await Promise.all([
    loadRenditionFile(answer.data.path, cacheBust, owner),
    getImageResolution(path).catch(() => null),
  ]);
  if (!owner.isCurrent()) return STALE;
  return image?.status === "ready" ? { ...image, sourceSize } : image;
}

/**
 * Loads `path` for the Preview pane. `cacheBust` versions the asset URL so the
 * webview re-fetches when the file changes (callers pass an mtime/size key).
 */
export async function loadPreviewImage(
  path: string,
  cacheBust: string,
  owner: PreviewImageOwner,
  options: PreviewImageOptions = {},
): Promise<PreviewImageLoad> {
  if (options.rendition && mayHaveRendition(path)) {
    const rendition = await loadRendition(path, cacheBust, owner, options.rendition);
    if (rendition) return rendition;
  }
  return loadOriginal(path, cacheBust, owner);
}

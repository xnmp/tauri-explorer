/**
 * Full-resolution image loading for the Preview pane: file images and plugin
 * Preview targets (#1033) load the same way.
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

export interface PreviewImageOwner {
  /** Whether this load is still the one the caller wants. */
  isCurrent(): boolean;
  /** Takes ownership of a returned blob URL; false (and released) if superseded. */
  adoptBlob(url: string): boolean;
  /** Releases a blob URL this load adopted but will not show. */
  releaseBlob(url: string): void;
}

export type PreviewImageLoad =
  /** Decoded and ready to show; `viaBackend` when the bytes came through the backend read. */
  | { readonly status: "ready"; readonly url: string; readonly viaBackend: boolean }
  | { readonly status: "failed" }
  /** Superseded: the caller shows nothing from this load. */
  | { readonly status: "stale" };

const STALE: PreviewImageLoad = { status: "stale" };
const FAILED: PreviewImageLoad = { status: "failed" };

/** Decode an image off the main thread so selection/animation aren't blocked. */
export async function decodeImage(url: string): Promise<string> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return url;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadViaBackend(path: string, owner: PreviewImageOwner): Promise<PreviewImageLoad> {
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
    await decodeImage(fallback.data);
    if (!owner.isCurrent()) return STALE;
    return { status: "ready", url: fallback.data, viaBackend: true };
  } catch (error) {
    if (!owner.isCurrent()) return STALE;
    owner.releaseBlob(fallback.data);
    console.warn("[preview] backend image decode failed", { path, error });
    logFrontendDiagnostic("preview backend image decode failed", { path, error: errorText(error) });
    return FAILED;
  }
}

/**
 * Loads `path` at full resolution. `cacheBust` versions the asset URL so the
 * webview re-fetches when the file changes (callers pass an mtime/size key).
 */
export async function loadPreviewImage(path: string, cacheBust: string, owner: PreviewImageOwner): Promise<PreviewImageLoad> {
  if (!isTauri()) return loadViaBackend(path, owner);
  try {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    if (!owner.isCurrent()) return STALE;
    const url = `${convertFileSrc(path)}?v=${encodeURIComponent(cacheBust)}`;
    // Decode off-screen — the caller's spinner stays visible until ready.
    await decodeImage(url);
    if (!owner.isCurrent()) return STALE;
    return { status: "ready", url, viaBackend: false };
  } catch (assetErr) {
    if (!owner.isCurrent()) return STALE;
    console.warn("[preview] asset image decode failed; using backend fallback", { path, error: assetErr });
    logFrontendDiagnostic("preview asset image decode failed", { path, error: errorText(assetErr) });
    return loadViaBackend(path, owner);
  }
}

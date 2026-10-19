/**
 * Preview pane image resolution policy (#1054).
 *
 * The pane shows a display-sized rendition of a large raster image, like Quick
 * Look and Explorer's preview: decoding a 33–50 MP original took WebKitGTK
 * 650–1550 ms per selection with main-thread stalls up to 1.6 s. The rendition
 * edge comes from the surface's device-pixel size, quantised to a few buckets
 * so resizing the pane does not keep generating new ones. Fullscreen and zoom
 * need detail the rendition lacks, so they use the original.
 */

import type { ImageResolution } from "./image-resolution";
import { isVirtualPath } from "./virtual-path";

/** The backend's answer: show the file itself, or a cached rendition file. */
export type PreviewImageSource =
  | { readonly kind: "original" }
  | { readonly kind: "rendition"; readonly path: string };

/** Which of the two an on-screen preview image is. */
export type PreviewImageResolution = "rendition" | "original";

/** Rendition edges the pane requests, smallest first (the backend clamps to 256–4096). */
export const RENDITION_EDGE_BUCKETS: readonly number[] = [1024, 2048, 3072];

/** Used before the surface has been laid out (or reports nonsense). */
export const DEFAULT_RENDITION_EDGE = 2048;

export interface PreviewSurface {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** `window.devicePixelRatio`; 1 when missing. */
  readonly devicePixelRatio?: number;
  /** The app's root CSS zoom factor (zoomLevel / 100); 1 when missing. */
  readonly zoom?: number;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The longest rendition edge, in device pixels, worth requesting for `surface`:
 * the smallest bucket covering its longest edge, capped at the largest bucket.
 */
export function renditionMaxEdge(surface: PreviewSurface): number {
  const scale = positiveOr(surface.devicePixelRatio, 1) * positiveOr(surface.zoom, 1);
  const needed = Math.max(nonNegative(surface.width), nonNegative(surface.height)) * scale;
  // Finite inputs can still overflow to Infinity; that falls to the largest bucket.
  if (!(needed > 0)) return DEFAULT_RENDITION_EDGE;
  return RENDITION_EDGE_BUCKETS.find((edge) => edge >= needed) ?? RENDITION_EDGE_BUCKETS[RENDITION_EDGE_BUCKETS.length - 1];
}

/**
 * Extensions the backend can make a rendition for (mirrors
 * `RENDITION_EXTENSIONS` in `thumbnails/preview_rendition.rs`). GIF, SVG,
 * AVIF and the rest are always their own original.
 */
const RENDITION_EXTENSIONS: ReadonlySet<string> = new Set(["jpg", "jpeg", "png", "webp", "bmp"]);

/**
 * Whether asking the backend for a rendition of `path` can ever pay off. Other
 * paths skip the request, so they never queue behind a running decode.
 */
export function mayHaveRendition(path: string): boolean {
  if (isVirtualPath(path)) return false;
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && RENDITION_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export interface PreviewViewState {
  readonly fullscreen: boolean;
  /** The fullscreen viewer's zoom; 1 is fit. */
  readonly zoom: number;
}

/** Whether the viewer needs the original rather than a rendition. */
export function needsFullResolution(view: PreviewViewState): boolean {
  return view.fullscreen || view.zoom > 1;
}

/** A display rendition's decoded dimensions never describe the source file. */
export function previewSourceSize(
  resolution: PreviewImageResolution,
  source: ImageResolution | null,
  decoded: ImageResolution,
): ImageResolution | null {
  const size = resolution === "rendition" ? source : decoded;
  return size && Number.isSafeInteger(size.width) && size.width > 0
    && Number.isSafeInteger(size.height) && size.height > 0 ? size : null;
}

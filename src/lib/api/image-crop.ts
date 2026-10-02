import { invoke, extractError, virtualPathGuard, type ApiResult } from "./common";
import { getNativeResourceSession } from "./native-resource-session";
import { invokeFileMutation } from "./file-mutations";
import type { ImageCropRect, ImagePixelSize } from "$lib/domain/image-crop";
import type { FileMutationReceipt } from "$lib/domain/file";

/** Opaque native source observation, echoed unchanged when saving. */
export interface ImageCropRevision {
  readonly digest: string;
  readonly size: number;
  readonly modifiedSeconds: number;
  readonly modifiedNanos: number;
  readonly identity: string;
  readonly readonly: boolean;
}
export interface ImageCropCapture {
  readonly path: string;
  readonly revision: ImageCropRevision;
  readonly dataUrl: string;
  readonly format: "JPEG" | "PNG" | "GIF" | "WebP" | "BMP" | "SVG" | "AVIF" | "ICNS";
}
export type ImageCropDestination = { readonly kind: "copy"; readonly name: string } | { readonly kind: "replace" };
export interface ImageCropSave {
  readonly path: string;
  readonly revision: ImageCropRevision;
  readonly rect: ImageCropRect;
  readonly viewport: ImagePixelSize;
  readonly destination: ImageCropDestination;
}

export async function captureImageCrop(path: string): Promise<ApiResult<ImageCropCapture>> {
  const refused = virtualPathGuard(path);
  if (refused) return refused;
  try {
    const sessionId = await getNativeResourceSession();
    return { ok: true, data: await invoke<ImageCropCapture>("capture_image_crop", { path, sessionId }) };
  } catch (error) { return { ok: false, error: extractError(error) }; }
}

export async function saveImageCrop(request: ImageCropSave): Promise<ApiResult<FileMutationReceipt>> {
  const refused = virtualPathGuard(request.path);
  if (refused) return refused;
  return invokeFileMutation("save_image_crop", { request });
}

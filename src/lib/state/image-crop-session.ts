import { fullImageCrop, setCropEdge, validImageCrop, validImageSize, type CropEdge, type ImageCropRect, type ImagePixelSize } from "$lib/domain/image-crop";
import type { ImageCropCapture, ImageCropDestination, ImageCropSave } from "$lib/api/image-crop";
import type { ApiResult } from "$lib/api/common";
import type { FileMutationReceipt } from "$lib/domain/file";

export interface ImageCropSessionState {
  readonly phase: "closed" | "loading" | "editing" | "saving";
  readonly name: string;
  readonly capture?: ImageCropCapture;
  readonly url?: string;
  readonly size?: ImagePixelSize;
  readonly rect?: ImageCropRect;
  readonly error?: string;
}
interface Dependencies {
  capture: (path: string) => Promise<ApiResult<ImageCropCapture>>;
  save: (request: ImageCropSave) => Promise<ApiResult<FileMutationReceipt>>;
  createUrl: (dataUrl: string) => string;
  revokeUrl: (url: string) => void;
  changed: (state: ImageCropSessionState) => void;
  saved: (receipt: FileMutationReceipt, warning?: string) => void;
}

export function croppedCopyName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} - Cropped${name.slice(dot)}` : `${name} - Cropped`;
}

/** One editor opening owns its source and URL. Late captures cannot reopen a
 * closed editor. Accepted saves retain their request and publish independently. */
export function createImageCropSession(deps: Dependencies) {
  let generation = 0;
  let state: ImageCropSessionState = { phase: "closed", name: "" };
  const update = (next: ImageCropSessionState) => { state = next; deps.changed(next); };
  const release = () => { if (state.url) deps.revokeUrl(state.url); };
  const dismiss = () => { generation++; release(); update({ phase: "closed", name: "" }); };

  return {
    get state() { return state; },
    async open(path: string, name: string): Promise<void> {
      if (state.phase === "saving") return;
      release();
      const current = ++generation;
      update({ phase: "loading", name });
      const result = await deps.capture(path);
      if (generation !== current) return;
      if (!result.ok) { update({ phase: "editing", name, error: result.error }); return; }
      try {
        update({ phase: "editing", name, capture: result.data, url: deps.createUrl(result.data.dataUrl) });
      } catch (error) {
        update({ phase: "editing", name, error: error instanceof Error ? error.message : String(error) });
      }
    },
    loaded(size: ImagePixelSize): void {
      if (state.phase !== "editing" || !state.capture || state.size) return;
      if (!validImageSize(size)) { update({ ...state, error: "The image has invalid dimensions" }); return; }
      update({ ...state, size: { ...size }, rect: fullImageCrop(size), error: undefined });
    },
    failedPreview(): void { if (state.phase === "editing") update({ ...state, error: "This image could not be displayed for cropping" }); },
    edge(edge: CropEdge, position: number): void {
      if (state.phase !== "editing" || !state.size || !state.rect) return;
      const rect = setCropEdge(state.rect, edge, position, state.size);
      if (rect !== state.rect || state.error) update({ ...state, rect, error: undefined });
    },
    select(rect: ImageCropRect): void {
      if (state.phase !== "editing" || !state.size || !validImageCrop(rect, state.size)) return;
      const previous = state.rect;
      if (previous && !state.error && (["left", "top", "right", "bottom"] as const).every((edge) => rect[edge] === previous[edge])) return;
      update({ ...state, rect: { ...rect }, error: undefined });
    },
    reset(): void {
      if (state.phase === "editing" && state.size) update({ ...state, rect: fullImageCrop(state.size), error: undefined });
    },
    close(): void { if (state.phase !== "saving") dismiss(); },
    dispose(): void { dismiss(); },
    async save(destination: ImageCropDestination): Promise<void> {
      if (state.phase !== "editing" || !state.capture || !state.size || !state.rect || !validImageCrop(state.rect, state.size)) return;
      const current = generation;
      const request: ImageCropSave = {
        path: state.capture.path, revision: { ...state.capture.revision },
        rect: { ...state.rect }, viewport: { ...state.size }, destination: { ...destination },
      };
      update({ ...state, phase: "saving", error: undefined });
      const result = await deps.save(request);
      if (result.ok) deps.saved(result.data, result.warning);
      if (generation !== current) return;
      if (result.ok) dismiss();
      else update({ ...state, phase: "editing", error: result.error });
    },
  };
}

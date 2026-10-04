/** Crop edges are full-resolution pixel boundaries, after image orientation. */
export interface ImagePixelSize {
  readonly width: number;
  readonly height: number;
}
export interface ImageCropRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export type CropEdge = keyof ImageCropRect;
const pixelBoundary = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 0xffff_ffff;

export function validImageSize(value: unknown): value is ImagePixelSize {
  if (!value || typeof value !== "object") return false;
  const size = value as Partial<ImagePixelSize>;
  return (
    pixelBoundary(size.width) &&
    pixelBoundary(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

export function validImageCrop(
  value: unknown,
  size: ImagePixelSize,
): value is ImageCropRect {
  if (!validImageSize(size) || !value || typeof value !== "object")
    return false;
  const rect = value as Partial<ImageCropRect>;
  return (
    pixelBoundary(rect.left) &&
    pixelBoundary(rect.top) &&
    pixelBoundary(rect.right) &&
    pixelBoundary(rect.bottom) &&
    rect.left < rect.right &&
    rect.top < rect.bottom &&
    rect.right <= size.width &&
    rect.bottom <= size.height
  );
}

export function fullImageCrop(size: ImagePixelSize): ImageCropRect {
  if (!validImageSize(size)) throw new Error("Invalid image dimensions");
  return { left: 0, top: 0, right: size.width, bottom: size.height };
}

/** Move one edge; retain the other three and at least one output pixel. */
export function setCropEdge(
  rect: ImageCropRect,
  edge: CropEdge,
  position: number,
  size: ImagePixelSize,
): ImageCropRect {
  if (!validImageCrop(rect, size) || !Number.isFinite(position)) return rect;
  const bounds: Record<CropEdge, readonly [number, number]> = {
    left: [0, rect.right - 1],
    right: [rect.left + 1, size.width],
    top: [0, rect.bottom - 1],
    bottom: [rect.top + 1, size.height],
  };
  if (!Object.hasOwn(bounds, edge)) return rect;
  const [minimum, maximum] = bounds[edge];
  const next = Math.max(minimum, Math.min(maximum, Math.round(position)));
  return next === rect[edge] ? rect : { ...rect, [edge]: next };
}

/** Translate a crop without changing its size, clamping the entire region to the image. */
export function translateImageCrop(
  rect: ImageCropRect,
  delta: { x: number; y: number },
  size: ImagePixelSize,
): ImageCropRect {
  if (!validImageCrop(rect, size) || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return rect;
  const x = Math.max(-rect.left, Math.min(size.width - rect.right, Math.round(delta.x)));
  const y = Math.max(-rect.top, Math.min(size.height - rect.bottom, Math.round(delta.y)));
  return x === 0 && y === 0 ? rect : {
    left: rect.left + x, top: rect.top + y, right: rect.right + x, bottom: rect.bottom + y,
  };
}

/** Measure the image itself, so app zoom, fitted layout and document transforms are applied once. */
export function cropPixelPoint(
  client: { x: number; y: number },
  imageRect: { left: number; top: number; width: number; height: number },
  size: ImagePixelSize,
): { x: number; y: number } | null {
  if (
    !validImageSize(size) ||
    ![
      client.x,
      client.y,
      imageRect.left,
      imageRect.top,
      imageRect.width,
      imageRect.height,
    ].every(Number.isFinite) ||
    imageRect.width <= 0 ||
    imageRect.height <= 0
  )
    return null;
  return {
    x: Math.max(
      0,
      Math.min(
        size.width,
        ((client.x - imageRect.left) / imageRect.width) * size.width,
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        size.height,
        ((client.y - imageRect.top) / imageRect.height) * size.height,
      ),
    ),
  };
}

export function croppedImageSize(rect: ImageCropRect): ImagePixelSize {
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

/** ICNS keeps each representation's fixed canvas. Crop the corresponding
 * pixel region and center it without resampling, leaving transparent padding.
 * Outward rounding keeps a narrow selection nonempty at small icon sizes. */
export function cropForIconCanvas(
  rect: ImageCropRect,
  source: ImagePixelSize,
  canvas: ImagePixelSize,
): {
  region: ImageCropRect;
  canvas: ImagePixelSize;
  offset: { x: number; y: number };
} | null {
  if (!validImageCrop(rect, source) || !validImageSize(canvas)) return null;
  const region = {
    left: Math.floor((rect.left / source.width) * canvas.width),
    top: Math.floor((rect.top / source.height) * canvas.height),
    right: Math.ceil((rect.right / source.width) * canvas.width),
    bottom: Math.ceil((rect.bottom / source.height) * canvas.height),
  };
  const crop = croppedImageSize(region);
  return {
    region,
    canvas: { width: canvas.width, height: canvas.height },
    offset: {
      x: Math.floor((canvas.width - crop.width) / 2),
      y: Math.floor((canvas.height - crop.height) / 2),
    },
  };
}

/** Intrinsic source pixels, never thumbnail or CSS dimensions. */
export interface ImageResolution {
  width: number;
  height: number;
}

export function formatImageResolution(value: ImageResolution | null): string {
  return value && Number.isInteger(value.width) && value.width > 0
    && Number.isInteger(value.height) && value.height > 0
    ? `${value.width} × ${value.height} px` : "—";
}

export function supportsImageResolution(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

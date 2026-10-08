/** Intrinsic source pixels, never thumbnail or CSS dimensions. */
export interface ImageResolution {
  width: number;
  height: number;
}

export function formatImageResolution(_value: ImageResolution | null): string {
  return "—";
}

export function supportsImageResolution(_name: string): boolean {
  return false;
}

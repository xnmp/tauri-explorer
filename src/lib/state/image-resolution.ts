import type { ImageResolution } from "$lib/domain/image-resolution";

export interface ResolutionRequest {
  cancel(): void;
}

/** Queue ownership lives outside virtualized cells. */
export function createResolutionQueue(_read: (path: string) => Promise<ImageResolution | null>, _limit = 4) {
  return {
    request(_path: string, _publish: (value: ImageResolution | null) => void): ResolutionRequest {
      return { cancel() {} };
    },
  };
}

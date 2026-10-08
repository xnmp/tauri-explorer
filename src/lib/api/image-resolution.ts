import { invoke } from "./common";
import type { ImageResolution } from "$lib/domain/image-resolution";
import { isVirtualPath } from "$lib/domain/virtual-path";

export function getImageResolution(path: string): Promise<ImageResolution | null> {
  return isVirtualPath(path) ? Promise.resolve(null) : invoke("get_image_resolution", { path });
}

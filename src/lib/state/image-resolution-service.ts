import { getImageResolution } from "$lib/api/image-resolution";
import type { ImageResolution } from "$lib/domain/image-resolution";
import { parentDir, sameDirectory } from "$lib/domain/path";
import { directoryEvents } from "./directory-events";
import { subscribeToLocalFileChanges } from "./file-events";
import { createResolutionQueue, observeResolution } from "./image-resolution";

const queue = createResolutionQueue(getImageResolution);

/** Uses the existing shared change stream; owns no filesystem watches or refresh policy. */
export function observeImageResolution(path: string, publish: (value: ImageResolution | null) => void): () => void {
  const directory = parentDir(path);
  return observeResolution(queue, path, publish, invalidate => {
    const subscription = directoryEvents.subscribe(change => {
      if (sameDirectory(directory, change.path)) invalidate();
    });
    void subscription.ready().catch(() => { /* Pane observation owns recovery. */ });
    const stopLocal = subscribeToLocalFileChanges(dirs => {
      if (dirs.some(dir => sameDirectory(directory, dir))) invalidate();
    });
    return () => { stopLocal(); subscription.stop(); };
  });
}

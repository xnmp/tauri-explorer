import type { ImageResolution } from "$lib/domain/image-resolution";

export interface ResolutionRequest {
  cancel(): void;
}

/** No persistent cache: replacement listings and remounts always read fresh headers.
 * Cancellation removes queued work immediately and retires in-flight publication. */
export function createResolutionQueue(read: (path: string) => Promise<ImageResolution | null>, limit = 4) {
  let active = 0;
  interface Job { path: string; publish: (value: ImageResolution | null) => void; cancelled: boolean }
  const pending: Job[] = [];
  function drain() {
    while (active < limit && pending.length) {
      const job = pending.shift()!;
      active++;
      Promise.resolve().then(() => job.cancelled ? null : read(job.path))
        .catch(() => null)
        .then(value => { if (!job.cancelled) job.publish(value); })
        .finally(() => { active--; drain(); });
    }
  }
  return {
    request(path: string, publish: (value: ImageResolution | null) => void): ResolutionRequest {
      const job: Job = { path, publish, cancelled: false };
      pending.push(job); drain();
      return { cancel() {
        job.cancelled = true;
        const index = pending.indexOf(job);
        if (index !== -1) pending.splice(index, 1);
      } };
    },
  };
}

/** Event invalidation is necessary even when a refresh reuses unchanged entry
 * objects (a replacement can preserve both byte count and mtime). */
export function observeResolution(
  queue: ReturnType<typeof createResolutionQueue>,
  path: string,
  publish: (value: ImageResolution | null) => void,
  subscribe: (invalidate: () => void) => () => void,
): () => void {
  let stopped = false;
  let request: ResolutionRequest | undefined;
  function refresh() {
    if (stopped) return;
    request?.cancel();
    publish(null);
    request = queue.request(path, publish);
  }
  refresh();
  const unsubscribe = subscribe(refresh);
  return () => { stopped = true; unsubscribe(); request?.cancel(); };
}

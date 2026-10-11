/**
 * Lazy video-duration resolver for the Details view's Length column (#995).
 */
import type { FileEntry } from "$lib/domain/file";
import type { MediaDuration } from "$lib/domain/media-duration";

export interface MediaDurationDeps {
  /** Probes durations for `paths`, returning one result per path in order. */
  probe: (paths: string[]) => Promise<MediaDuration[]>;
  /** Max paths per probe call. */
  batchSize?: number;
  /** Max in-flight probe calls. */
  maxConcurrent?: number;
  /** Max cached results retained. */
  maxEntries?: number;
}

export class MediaDurationResolver {
  constructor(_deps: MediaDurationDeps) {}

  /** Reactive read: `undefined` until resolved for the entry's current revision. */
  duration(_entry: FileEntry): MediaDuration | undefined {
    return undefined;
  }

  /** Request resolution for a rendered entry; a no-op for non-video files. */
  request(_entry: FileEntry): void {}
}

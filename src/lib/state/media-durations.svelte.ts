/**
 * Lazy video-duration resolver for the Details view's Length column (#995).
 *
 * Listings never carry durations: reading container metadata (or spawning
 * ffmpeg) per video would delay every directory load. Rendered Details rows
 * request their entry; the shared batched resolver groups same-tick requests
 * into one `get_media_durations` call and caches per path + revision.
 * Unreadable files and probe failures resolve to `null` (an empty cell).
 */
import type { FileEntry } from "$lib/domain/file";
import { isVideoMediaFile } from "$lib/domain/file-types";
import type { MediaDuration } from "$lib/domain/media-duration";
import { getMediaDurations } from "$lib/api/media";
import { BatchedEntryResolver } from "./batched-entry-resolver.svelte";

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

export class MediaDurationResolver extends BatchedEntryResolver<MediaDuration> {
  constructor({ probe, ...limits }: MediaDurationDeps) {
    super({ ...limits, load: (entries) => probe(entries.map((entry) => entry.path)), normalize, failure: null, eligible: isVideoMediaFile });
  }

  /** Reactive read: `undefined` until resolved for the entry's current revision. */
  duration(entry: FileEntry): MediaDuration | undefined {
    return this.value(entry);
  }
}

function normalize(value: unknown): MediaDuration {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Shared resolver wired to the real IPC command. */
export const mediaDurationResolver = new MediaDurationResolver({ probe: getMediaDurations });

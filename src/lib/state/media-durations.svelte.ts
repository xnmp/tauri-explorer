/**
 * Lazy video-duration resolver for the Details view's Length column (#995).
 *
 * Listings never carry durations: reading container metadata (or spawning
 * ffmpeg) per video would delay every directory load. Rendered Details rows
 * request their entry instead; requests made in the same tick are batched into
 * one `get_media_durations` call with a bounded number of calls in flight.
 * Results are cached per path and revision (size + mtime), so an unchanged
 * file is never re-probed while a rewritten one is. Unreadable files and probe
 * failures resolve to `null` and render an empty cell.
 */
import { SvelteMap } from "svelte/reactivity";
import type { FileEntry } from "$lib/domain/file";
import { isVideoMediaFile } from "$lib/domain/file-types";
import { mediaDurationRevision, type MediaDuration } from "$lib/domain/media-duration";
import { getMediaDurations } from "$lib/api/media";

const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_ENTRIES = 5000;

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

interface Work {
  path: string;
  revision: string;
}

export class MediaDurationResolver {
  #cache = new SvelteMap<string, { revision: string; duration: MediaDuration }>();
  #pending = new Map<string, Work>();
  #queue: Work[] = [];
  #active = 0;
  #scheduled = false;
  #probe: MediaDurationDeps["probe"];
  #batchSize: number;
  #maxConcurrent: number;
  #maxEntries: number;

  constructor(deps: MediaDurationDeps) {
    this.#probe = deps.probe;
    this.#batchSize = Math.max(1, deps.batchSize ?? DEFAULT_BATCH_SIZE);
    this.#maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    this.#maxEntries = Math.max(1, deps.maxEntries ?? DEFAULT_MAX_ENTRIES);
  }

  /** Reactive read: `undefined` until resolved for the entry's current revision. */
  duration(entry: FileEntry): MediaDuration | undefined {
    const cached = this.#cache.get(entry.path);
    return cached?.revision === mediaDurationRevision(entry) ? cached.duration : undefined;
  }

  /** Request resolution for a rendered entry; a no-op for non-video files. */
  request(entry: FileEntry): void {
    if (!isVideoMediaFile(entry)) return;
    const { path } = entry;
    const revision = mediaDurationRevision(entry);
    if (this.#cache.get(path)?.revision === revision) return;
    if (this.#pending.get(path)?.revision === revision) return;

    const work = { path, revision };
    // A newer revision supersedes queued or in-flight work for the same path.
    this.#queue = this.#queue.filter((queued) => queued.path !== path);
    this.#pending.set(path, work);
    this.#queue.push(work);
    // Defer one microtask so rows rendered together share a probe call.
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#batchSize);
      this.#active += 1;
      void this.#probe(batch.map((work) => work.path))
        .then(
          (durations) => batch.map((_, index) => normalize(durations[index])),
          () => batch.map(() => null),
        )
        .then((durations) => batch.forEach((work, index) => this.#settle(work, durations[index])))
        .finally(() => {
          this.#active -= 1;
          this.#pump();
        });
    }
  }

  #settle(work: Work, duration: MediaDuration): void {
    if (this.#pending.get(work.path) !== work) return;
    this.#pending.delete(work.path);
    this.#cache.delete(work.path);
    this.#cache.set(work.path, { revision: work.revision, duration });
    // Map iteration is insertion order: evict the least recently resolved.
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}

function normalize(value: unknown): MediaDuration {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Shared resolver wired to the real IPC command. */
export const mediaDurationResolver = new MediaDurationResolver({ probe: getMediaDurations });

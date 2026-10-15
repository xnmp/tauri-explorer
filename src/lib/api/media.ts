/**
 * API client for media metadata (#995). Kept separate from `files.ts`: durations
 * are lazy per-row metadata, never part of the directory-listing contract.
 */
import type { MediaDuration } from "$lib/domain/media-duration";
import { invoke } from "./common";

/** Playback length in seconds per path (`null` when unreadable), in order. */
export function getMediaDurations(paths: string[]): Promise<MediaDuration[]> {
  return invoke<MediaDuration[]>("get_media_durations", { paths });
}

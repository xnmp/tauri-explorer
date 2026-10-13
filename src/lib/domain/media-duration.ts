/**
 * Playback length for the Details view's Length column (#995). Pure: the
 * resolver in `state/media-durations.svelte.ts` owns probing and caching.
 */
import type { FileEntry } from "./file";
import { mediaTime } from "./video-preview";

/** Resolved playback length in seconds, or `null` when it cannot be read. */
export type MediaDuration = number | null;

/** Length-cell text: m:ss / h:mm:ss, or empty when unknown or unreadable. */
export function formatMediaDuration(seconds: MediaDuration | undefined): string {
  // mediaTime renders invalid input as "0:00", which would claim a real length.
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  return mediaTime(seconds);
}

/** Cache identity: a duration stays valid while the file's size and mtime do. */
export function mediaDurationRevision(entry: Pick<FileEntry, "size" | "modified">): string {
  return `${entry.size}:${entry.modified}`;
}

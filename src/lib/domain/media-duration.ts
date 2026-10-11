/**
 * Playback length for the Details view's Length column (#995). Pure: the
 * resolver in `state/media-durations.svelte.ts` owns probing and caching.
 */
import type { FileEntry } from "./file";

/** Resolved playback length in seconds, or `null` when it cannot be read. */
export type MediaDuration = number | null;

/** Length-cell text: m:ss / h:mm:ss, or empty when unknown or unreadable. */
export function formatMediaDuration(_seconds: MediaDuration | undefined): string {
  return "";
}

/** Cache identity: a duration stays valid while the file's size and mtime do. */
export function mediaDurationRevision(_entry: Pick<FileEntry, "size" | "modified">): string {
  return "";
}

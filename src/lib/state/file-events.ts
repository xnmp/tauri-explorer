/**
 * Cross-window file change notification.
 * Issue: tauri-5r30, tauri-ne9h
 *
 * When a file operation (move, copy, delete, create) completes in one window,
 * this broadcasts the affected directories so all windows can refresh.
 * Uses BroadcastChannel for same-origin inter-window communication.
 */
import { emptyFolderResolver } from "./empty-folders.svelte";

export interface FileChangeEvent {
  /** Directories that were modified (source/destination) */
  affectedDirs: string[];
}

const CHANNEL_NAME = "explorer-file-changes";

let channel: BroadcastChannel | null = null;
let listener: ((dirs: string[]) => void) | null = null;
const localMutationListeners = new Set<(dirs: string[]) => void>();

/**
 * Subscribe to mutations initiated in this window. Directory-listing panes
 * update their entries optimistically, while independent directory caches
 * (such as Miller columns) need to discard their own copy of those entries.
 */
export function subscribeToLocalFileChanges(listener: (dirs: string[]) => void): () => void {
  localMutationListeners.add(listener);
  return () => localMutationListeners.delete(listener);
}

function notifyLocalMutationListeners(affectedDirs: string[]): void {
  for (const notify of localMutationListeners) notify(affectedDirs);
}

/** Initialize the file change listener. Call once per window. */
export function initFileChangeListener(onChanged: (dirs: string[]) => void): void {
  if (typeof BroadcastChannel === "undefined") return;

  channel = new BroadcastChannel(CHANNEL_NAME);
  listener = onChanged;

  channel.onmessage = (event: MessageEvent<FileChangeEvent>) => {
    emptyFolderResolver.invalidate(event.data.affectedDirs);
    listener?.(event.data.affectedDirs);
    notifyLocalMutationListeners(event.data.affectedDirs);
  };
}

/** Broadcast that directories have changed and notify local cache consumers. */
export function broadcastFileChange(affectedDirs: string[]): void {
  if (affectedDirs.length === 0) return;
  emptyFolderResolver.invalidate(affectedDirs);
  notifyLocalMutationListeners(affectedDirs);
  channel?.postMessage({ affectedDirs } satisfies FileChangeEvent);
}

export { parentDir } from "$lib/domain/path";

/** Cleanup on window close. */
export function cleanupFileChangeListener(): void {
  channel?.close();
  channel = null;
  listener = null;
}

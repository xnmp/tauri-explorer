/**
 * Cross-window file change notification.
 * Issue: tauri-5r30, tauri-ne9h
 *
 * When a file operation (move, copy, delete, create) completes in one window,
 * this broadcasts the affected directories so all windows can refresh.
 * Uses BroadcastChannel for same-origin inter-window communication.
 */

export interface FileChangeEvent {
  /** Directories that were modified (source/destination) */
  affectedDirs: string[];
}

const CHANNEL_NAME = "explorer-file-changes";

let channel: BroadcastChannel | null = null;
let listener: ((dirs: string[]) => void) | null = null;

/** Initialize the file change listener. Call once per window. */
export function initFileChangeListener(onChanged: (dirs: string[]) => void): void {
  if (typeof BroadcastChannel === "undefined") return;

  channel = new BroadcastChannel(CHANNEL_NAME);
  listener = onChanged;

  channel.onmessage = (event: MessageEvent<FileChangeEvent>) => {
    listener?.(event.data.affectedDirs);
  };
}

/** Broadcast that directories have changed. Notifies OTHER windows. */
export function broadcastFileChange(affectedDirs: string[]): void {
  if (!channel || affectedDirs.length === 0) return;
  channel.postMessage({ affectedDirs } satisfies FileChangeEvent);
}

/** Get the parent directory of a path. */
export function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.substring(0, idx) : "/";
}

/** Cleanup on window close. */
export function cleanupFileChangeListener(): void {
  channel?.close();
  channel = null;
  listener = null;
}

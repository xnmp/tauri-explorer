/**
 * Type-ahead selection composable.
 * Issue: tauri-18op
 *
 * Handles keyboard type-ahead to jump to matching entries.
 * Typing letters builds a prefix buffer that matches against entry names.
 * Buffer clears after a configurable timeout.
 */

import type { FileEntry } from "$lib/domain/file";

const TYPE_AHEAD_TIMEOUT = 800;

export function useTypeAhead(
  getEntries: () => readonly FileEntry[],
  onMatch: (entry: FileEntry) => void,
) {
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  function handleKey(key: string): void {
    if (timer) clearTimeout(timer);
    buffer += key.toLowerCase();
    timer = setTimeout(() => { buffer = ""; }, TYPE_AHEAD_TIMEOUT);

    const match = getEntries().find((e) =>
      e.name.toLowerCase().startsWith(buffer)
    );
    if (match) {
      onMatch(match);
    }
  }

  /** Returns true if the key was handled as type-ahead */
  function handleKeydown(event: KeyboardEvent): boolean {
    if (
      event.key.length === 1 &&
      !event.ctrlKey && !event.metaKey && !event.altKey
    ) {
      handleKey(event.key);
      return true;
    }
    return false;
  }

  return { handleKeydown };
}

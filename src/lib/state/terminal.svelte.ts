/**
 * Embedded terminal panel state (issue #139).
 *
 * Visibility only — the shell session itself lives in TerminalPanel.svelte.
 * `everOpened` keeps the panel mounted after first open so hiding it (or
 * toggling with Ctrl+`) preserves the running shell; the component hides
 * with CSS instead of unmounting.
 */

class TerminalPanelStore {
  visible = $state(false);
  everOpened = $state(false);

  /** Registered by the mounted TerminalPanel: types text into the shell
   *  prompt and focuses the terminal (#265). */
  private pathsSink: ((paths: string[]) => void) | null = null;
  /** Insertions requested before the panel finished mounting. */
  private pendingPaths: string[][] = [];

  toggle(): void {
    this.visible = !this.visible;
    if (this.visible) this.everOpened = true;
  }

  open(): void {
    this.visible = true;
    this.everOpened = true;
  }

  close(): void {
    this.visible = false;
  }

  registerPathsSink(sink: (paths: string[]) => void): () => void {
    this.pathsSink = sink;
    for (const paths of this.pendingPaths.splice(0)) sink(paths);
    return () => {
      if (this.pathsSink === sink) this.pathsSink = null;
    };
  }

  /** Type the given paths into the shell prompt, opening the panel first.
   *  Queued until the panel mounts on a cold open (#265). */
  insertPaths(paths: string[]): void {
    if (paths.length === 0) return;
    this.open();
    if (this.pathsSink) this.pathsSink(paths);
    else this.pendingPaths.push(paths);
  }
}

export const terminalPanelStore = new TerminalPanelStore();

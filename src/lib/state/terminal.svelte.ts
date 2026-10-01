/**
 * Embedded terminal panel state (issue #139).
 *
 * Visibility and opening focus intent — the shell session lives in TerminalPanel.svelte.
 * `everOpened` keeps the panel mounted after first open so hiding it (or
 * toggling with Ctrl+`) preserves the running shell; the component hides
 * with CSS instead of unmounting.
 */

import { createDeferredFocusRequest, type DeferredFocusRequest } from "./deferred-focus";
import { dialogStore } from "./dialogs.svelte";

export class TerminalPanelStore {
  visible = $state(false);
  everOpened = $state(false);
  focusRevision = $state(0);
  private focusRequest: DeferredFocusRequest | null = null;

  constructor(private requestFocus: () => DeferredFocusRequest = () =>
    // Input owns the request, not activeElement identity: an older navigation
    // may still restore listing focus while this panel's chunk is loading.
    createDeferredFocusRequest(window, () => !dialogStore.hasModalOpen)) {}

  /** Registered by the mounted TerminalPanel: types text into the shell
   *  prompt. Focus follows the separately owned opening request (#265). */
  private pathsSink: ((paths: string[]) => void) | null = null;
  /** Insertions requested before the panel finished mounting. */
  private pendingPaths: string[][] = [];

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  open(): void {
    this.focusRequest?.cancel();
    this.focusRequest = this.requestFocus();
    this.focusRevision += 1;
    this.visible = true;
    this.everOpened = true;
  }

  close(): void {
    this.cancelFocus();
    this.visible = false;
  }

  consumeFocus(): boolean {
    const request = this.focusRequest;
    this.focusRequest = null;
    return this.visible && (request?.consume() ?? false);
  }

  cancelFocus(): void {
    this.focusRequest?.cancel();
    this.focusRequest = null;
  }

  registerPathsSink(sink: (paths: string[]) => void): () => void {
    this.pathsSink = sink;
    for (const paths of this.pendingPaths.splice(0)) sink(paths);
    return () => {
      if (this.pathsSink === sink) {
        this.pathsSink = null;
        this.cancelFocus();
      }
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

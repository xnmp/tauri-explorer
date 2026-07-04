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
}

export const terminalPanelStore = new TerminalPanelStore();

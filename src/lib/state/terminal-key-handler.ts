import { getTerminalCommand } from "$lib/domain/terminal-keys";
import { isModifierKey } from "$lib/domain/keyboard";
import type { keybindingsStore } from "./keybindings.svelte";

interface TerminalKeyDependencies {
  bindings: Pick<typeof keybindingsStore, "matchesAnyBinding" | "matchesChordPrefixForCommand" | "isChordActiveForCommand" | "isChordActive" | "cancelChord" | "trackModifierKey">;
  isAvailable(id: string): boolean;
  isMac: boolean;
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  copySelection(text: string): void;
  paste(): void;
  write(sequence: string): void;
  lineEditingSequence(event: KeyboardEvent): string | null;
}

/** xterm adapter. False bypasses xterm and leaves Explorer-owned events to the window owner. */
export function createTerminalKeyHandler(dependencies: TerminalKeyDependencies): (event: KeyboardEvent) => boolean {
  return (event) => {
    if (event.type === "keydown" || event.type === "keyup") dependencies.bindings.trackModifierKey(event, event.type === "keydown");
    if (event.type !== "keydown") return true;
    // Availability-aware: an unavailable core command does not claim the
    // key, so the terminal application still receives it.
    const shellReserved = getTerminalCommand(event, dependencies.bindings, dependencies.isAvailable) === undefined;
    if (!shellReserved) return false;
    // xterm keeps terminal-owned keys from reaching the page handler, so
    // consume a pending Explorer chord here when its suffix did not match.
    if (dependencies.bindings.isChordActive && !isModifierKey(event.key) && !event.repeat) dependencies.bindings.cancelChord();

    // The platform's primary clipboard modifier: Ctrl, but ⌘ on mac (#403)
    // — Cmd+C/V while the terminal is focused must copy/paste terminal
    // text, never fall through to the explorer's file clipboard.
    const primaryOnly = dependencies.isMac
      ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
      : event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    // Ctrl/Cmd+C with a selection copies it (VS Code parity, #374): the
    // user is copying terminal text, not interrupting the shell — and
    // definitely not copying files in the explorer.
    if (primaryOnly && event.key.toLowerCase() === "c" && dependencies.hasSelection()) {
      const text = dependencies.getSelection();
      dependencies.clearSelection();
      dependencies.copySelection(text);
      event.preventDefault();
      return false;
    }
    // Ctrl/Cmd+V pastes explicitly through xterm (bracketed-paste aware):
    // native paste into xterm's hidden textarea is unreliable in some
    // WebViews (#374), and the explorer's file-paste must never fire here.
    if (primaryOnly && event.key.toLowerCase() === "v") {
      // Holds its place in the input queue while the clipboard is read.
      dependencies.paste();
      event.preventDefault();
      return false;
    }
    // Line-editing shortcuts (#375, #404): inject the mapped readline
    // control byte. Platform defaults (mac Home/End/word-nav) overlaid
    // with the user's bindings from Settings → Terminal.
    const sequence = dependencies.lineEditingSequence(event);
    if (sequence !== null) {
      dependencies.write(sequence);
      event.preventDefault();
      return false;
    }
    return true;
  };
}

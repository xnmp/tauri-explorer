import { parseChord } from "./keybinding-parser";
import type { TerminalCommandId } from "./terminal-keys";

type WindowKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export interface WindowKeyContext {
  input: boolean;
  nativeButton: boolean;
  fileEntry: boolean;
  trackedMetaHeld: boolean;
  terminal: boolean;
  terminalCommand?: TerminalCommandId;
  modal: boolean;
  chord?: boolean;
  filterOpen: boolean;
  terminalEnabled: boolean;
}

export type WindowKeyAction = "native-activation" | "pass" | "terminal" | "toggle-terminal" | "close-dialogs"
  | "open-filter" | "close-filter" | "open-jobs" | "open-settings" | "toggle-dual-pane" | "command";

/** Ordered window shortcut policy, independent of DOM, stores and dispatch.
 * Surface controls precede ordinary command matching. Terminal applications,
 * modals and editable controls retain their established ownership boundaries. */
export function resolveWindowKey(event: WindowKey, context: WindowKeyContext): WindowKeyAction {
  const primary = event.ctrlKey || event.metaKey;
  // Native controls generate their click after key dispatch. Consuming Enter
  // or Space as an Explorer command would prevent that activation entirely.
  // File entries use those keys for Open and Preview through the command owner.
  if (context.nativeButton && !context.fileEntry && !context.trackedMetaHeld && !primary && !event.altKey && !event.shiftKey
    && (event.key === "Enter" || event.key === " ")) return "native-activation";
  const terminalToggle = (event.key === "`" || event.code === "Backquote") && primary && !context.modal;
  if (context.terminal) {
    if (terminalToggle && !context.chord) return context.terminalEnabled ? "toggle-terminal" : "pass";
    if (!context.terminalCommand) return "terminal";
    // An eligible chord may use a prefix that is a hardcoded Explorer key.
    // Preserve its command identity instead of opening a filter/settings/etc.
    return context.modal ? "pass" : "command";
  }
  if (event.key === "Escape" && context.modal) return "close-dialogs";
  // Configured prefixes and pending suffixes must reach the matcher before
  // Explorer's fallback surface keys. Editable/modal/terminal ownership wins.
  if (context.chord && !context.input && !context.modal) return "command";
  if (terminalToggle) return context.terminalEnabled ? "toggle-terminal" : "pass";
  // Repeated Ctrl+F must consume the WebView find shortcut even inside the
  // filter input; Shift+Ctrl+F remains the separate content-search command.
  if (event.key.toLowerCase() === "f" && primary && !event.shiftKey && !event.altKey && !context.modal) {
    return "open-filter";
  }
  if (event.key === "Escape" && !context.input && context.filterOpen) return "close-filter";
  if ((context.input && !context.terminal) || context.modal) return "pass";
  if (event.key === "j" && primary) return "open-jobs";
  if (event.key === "," && primary) return "open-settings";
  if ((event.key === "\\" || event.key === "|" || event.code === "Backslash") && primary) return "toggle-dual-pane";
  return "command";
}

/** A configured prefix can replace a fallback surface action. Reuse routing
 * policy to identify it so the editor can require an explicit acknowledgement.
 */
export function chordPrefixFallbackLabel(shortcut: string): string | undefined {
  const prefix = parseChord(shortcut)?.prefix;
  if (!prefix) return undefined;
  const action = resolveWindowKey({
    key: prefix.shift && prefix.key.length === 1 ? prefix.key.toUpperCase() : prefix.key,
    code: prefix.key === "`" || prefix.key === "~" ? "Backquote" : prefix.key === "\\" || prefix.key === "|" ? "Backslash" : "",
    ctrlKey: prefix.ctrl, metaKey: prefix.meta, altKey: prefix.alt, shiftKey: prefix.shift,
  }, { input: false, nativeButton: false, fileEntry: false, trackedMetaHeld: false,
    terminal: false, modal: false, filterOpen: false, terminalEnabled: true });
  const labels: Partial<Record<WindowKeyAction, string>> = {
    "open-jobs": "Jobs Panel", "open-settings": "Settings", "open-filter": "Filter Current Directory",
    "toggle-dual-pane": "Toggle Dual Pane", "toggle-terminal": "Toggle Terminal",
  };
  return labels[action];
}

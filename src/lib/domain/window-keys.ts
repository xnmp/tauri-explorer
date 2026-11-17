import { parseChord } from "./keybinding-parser";
import type { TerminalCommandId } from "./terminal-keys";

type WindowKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">
  & Partial<Pick<KeyboardEvent, "defaultPrevented" | "isComposing" | "keyCode">>;

/** Keys a focused text field keeps under any modifier: caret movement,
 * deletion, submission and spacing. */
const FIELD_EDITING_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End",
  "Backspace", "Delete", "Insert", "Enter", " ",
]);
/** Page keys scroll a field only unmodified or with Shift; with Ctrl/Cmd they
 * are tab navigation (Ctrl+PageUp/PageDown), like Ctrl+Tab. */
const FIELD_PAGE_KEYS = new Set(["PageUp", "PageDown"]);

/** An input-method composition owns its keys (WebKit reports keyCode 229). */
function isComposingKey(event: WindowKey): boolean {
  return event.isComposing === true || event.keyCode === 229;
}
/** Ctrl/Cmd clipboard, select-all and undo/redo letters. */
const FIELD_EDITING_LETTERS = new Set(["a", "c", "v", "x", "y", "z"]);

/** The letter a key names: its logical character on Latin layouts, or its
 * physical key on non-Latin ones (Ctrl+ф is select-all on a Russian layout). */
function letterOf(event: Pick<KeyboardEvent, "key" | "code">): string | undefined {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  if (/^[\x00-\x7f]$/.test(event.key)) return undefined;
  return /^Key([A-Z])$/.exec(event.code ?? "")?.[1].toLowerCase();
}

/** Whether a key pressed in a focused, non-modal text field is a window
 * shortcut rather than text input. Only chords whose own event carries Ctrl or
 * Cmd qualify: the tracked Linux Super overlay is deliberately ignored here,
 * because a lost Super keyup would otherwise turn ordinary typing into
 * commands. The field keeps plain, Shift- and Alt-only keys, Ctrl+Alt without
 * Cmd (Windows AltGr types characters), IME composition, its editing keys and
 * anything it already handled.
 *
 * Trade-off: on macOS, bound Ctrl keys such as Ctrl+T/N/P/W run their command
 * instead of the emacs-style text bindings (Ctrl+A/E/K remain as long as they
 * are unbound or editing letters). */
export function isWindowShortcutInField(event: WindowKey): boolean {
  if (event.defaultPrevented || isComposingKey(event)) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  if (event.ctrlKey && event.altKey && !event.metaKey) return false;
  if (FIELD_EDITING_KEYS.has(event.key)) return false;
  if (FIELD_PAGE_KEYS.has(event.key)) return true;
  const letter = letterOf(event);
  return letter === undefined || !FIELD_EDITING_LETTERS.has(letter);
}

export interface WindowKeyContext {
  input: boolean;
  nativeButton: boolean;
  fileEntry: boolean;
  trackedMetaHeld: boolean;
  terminal: boolean;
  terminalCommand?: TerminalCommandId;
  modal: boolean;
  chord?: boolean;
  /** A chord prefix was already accepted; its suffix is pending. */
  chordPending?: boolean;
  filterOpen: boolean;
}

export type WindowKeyAction = "native-activation" | "pass" | "terminal" | "close-dialogs"
  | "open-filter" | "close-filter" | "open-jobs" | "open-settings" | "toggle-dual-pane" | "command";

/** Native buttons generate activation after key dispatch, including inside dialogs. */
export function isNativeControlActivation(event: WindowKey, context: Pick<WindowKeyContext, "nativeButton" | "fileEntry" | "trackedMetaHeld">): boolean {
  return context.nativeButton && !context.fileEntry && !context.trackedMetaHeld && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
    && (event.key === "Enter" || event.key === " ");
}

/** Ordered window shortcut policy, independent of DOM, stores and dispatch.
 * Surface controls precede ordinary command matching. Terminal applications
 * and modals retain their established ownership boundaries; non-modal text
 * fields keep text input but yield Ctrl/Cmd window shortcuts
 * (`isWindowShortcutInField`). */
export function resolveWindowKey(event: WindowKey, context: WindowKeyContext): WindowKeyAction {
  const primary = event.ctrlKey || event.metaKey;
  // Native controls generate their click after key dispatch. Consuming Enter
  // or Space as an Explorer command would prevent that activation entirely.
  // File entries use those keys for Open and Preview through the command owner.
  if (isNativeControlActivation(event, context)) return "native-activation";
  if (context.terminal) {
    if (!context.terminalCommand) return "terminal";
    // An eligible chord may use a prefix that is a hardcoded Explorer key.
    // Preserve its command identity instead of opening a filter/settings/etc.
    return context.modal ? "pass" : "command";
  }
  if (event.key === "Escape" && context.modal) return "close-dialogs";
  const fieldShortcut = context.input && isWindowShortcutInField(event);
  // Configured prefixes and pending suffixes must reach the matcher before
  // Explorer's fallback surface keys. Modal/terminal ownership wins; a field
  // yields only a Ctrl/Cmd prefix, and a prefix it yielded owns the next key.
  if (context.chord && !context.modal && (!context.input || (context.chordPending && !event.defaultPrevented && !isComposingKey(event)) || fieldShortcut)) return "command";
  // Repeated Ctrl+F must consume the WebView find shortcut even inside the
  // filter input; Shift+Ctrl+F remains the separate content-search command.
  if (event.key.toLowerCase() === "f" && primary && !event.shiftKey && !event.altKey && !context.modal) {
    return "open-filter";
  }
  if (event.key === "Escape" && !context.input && context.filterOpen) return "close-filter";
  if ((context.input && !fieldShortcut) || context.modal) return "pass";
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
    terminal: false, modal: false, filterOpen: false });
  const labels: Partial<Record<WindowKeyAction, string>> = {
    "open-jobs": "Jobs Panel", "open-settings": "Settings", "open-filter": "Filter Current Directory",
    "toggle-dual-pane": "Toggle Dual Pane",
  };
  return labels[action];
}

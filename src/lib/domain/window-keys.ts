import type { TerminalCommandId } from "./terminal-keys";

type WindowKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">;

export interface WindowKeyContext {
  input: boolean;
  terminal: boolean;
  terminalCommand?: TerminalCommandId;
  modal: boolean;
  filterOpen: boolean;
  terminalEnabled: boolean;
}

export type WindowKeyAction = "pass" | "terminal" | "toggle-terminal" | "close-dialogs"
  | "open-filter" | "close-filter" | "open-jobs" | "open-settings" | "toggle-dual-pane" | "command";

/** Ordered window shortcut policy, independent of DOM, stores and dispatch.
 * Surface controls precede ordinary command matching. Terminal applications,
 * modals and editable controls retain their established ownership boundaries. */
export function resolveWindowKey(event: WindowKey, context: WindowKeyContext): WindowKeyAction {
  const primary = event.ctrlKey || event.metaKey;
  if ((event.key === "`" || event.code === "Backquote") && primary && !context.modal) {
    return context.terminalEnabled ? "toggle-terminal" : "pass";
  }
  if (context.terminal) {
    if (!context.terminalCommand) return "terminal";
    // An eligible chord may use a prefix that is a hardcoded Explorer key.
    // Preserve its command identity instead of opening a filter/settings/etc.
    return context.modal ? "pass" : "command";
  }
  if (event.key === "Escape" && context.modal) return "close-dialogs";
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

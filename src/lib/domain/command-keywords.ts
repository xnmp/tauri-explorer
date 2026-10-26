/**
 * Search synonyms for command-palette commands (#1247).
 *
 * VS Code-style: keywords participate in palette matching but are never
 * displayed, and a label match always outranks a keyword-only match
 * (see `scoreCommand`). This is the single place to add a synonym; keys are
 * command IDs and unknown IDs are simply ignored.
 */
export const COMMAND_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  "general.openKeybindings": ["hotkeys", "keybindings", "keymap", "bindings", "rebind"],
  "help.shortcuts": ["hotkeys", "keybindings", "keymap", "bindings", "cheatsheet"],
  "general.openSettings": ["preferences", "options", "config", "configuration"],
  "plugins.openSettings": ["preferences", "options", "config"],
  "view.switchTheme": ["colors", "appearance", "color scheme", "skin"],
  "view.toggleTheme": ["dark mode", "light mode", "appearance", "colors"],
  "general.openTerminal": ["console", "shell", "command line", "cli"],
  "view.toggleTerminal": ["console", "shell", "command line", "cli"],
  "file.delete": ["remove", "trash", "erase"],
  "file.permanentDelete": ["remove", "erase", "destroy"],
  "file.rename": ["move", "retitle"],
  "file.bulkRename": ["batch rename", "mass rename", "rename many"],
  "file.newFolder": ["mkdir", "create directory", "make folder", "new directory"],
  "file.newFile": ["touch", "create file", "make file"],
  "general.openQuickOpen": ["go to file", "find file", "open file", "fuzzy finder"],
  "general.openContentSearch": ["grep", "find in files", "search text", "ripgrep"],
  "general.filterCurrentDir": ["filter", "find in folder"],
  "bookmarks.addCurrent": ["favorites", "favourites", "pin", "star"],
  "bookmarks.removeCurrent": ["unfavorite", "unpin", "unstar"],
  "pane.splitRight": ["split", "pane", "side by side"],
  "pane.splitLeft": ["split", "pane", "side by side"],
  "pane.splitUp": ["split", "pane"],
  "pane.splitDown": ["split", "pane"],
  "view.toggleDualPane": ["split", "two panes", "side by side"],
  "view.zoomIn": ["font size", "scale", "bigger", "magnify"],
  "view.zoomOut": ["font size", "scale", "smaller"],
  "view.zoomReset": ["font size", "scale", "actual size"],
  "navigation.refresh": ["reload", "update"],
  "help.about": ["version", "info"],
  "navigation.openRecycleBin": ["trash", "deleted files", "bin"],
  "navigation.goUp": ["parent", "up one level"],
  "navigation.goHome": ["home directory", "user folder"],
  "navigation.focusAddressBar": ["path", "location bar", "url"],
  "view.details": ["table", "columns"],
  "view.tiles": ["thumbnails", "icons", "grid"],
  "view.list": ["compact"],
  "view.togglePreviewPane": ["preview", "inspector"],
  "tabs.newTab": ["open tab"],
  "window.newWindow": ["open window"],
  "edit.copy": ["duplicate"],
  "help.reportIssue": ["bug", "feedback", "problem"],
  "help.openLogs": ["debug", "diagnostics"],
};

/** Lowercased synonyms for a command (empty when it has none). */
export function keywordsFor(commandId: string): string[] {
  return (COMMAND_KEYWORDS[commandId] ?? []).map((k) => k.toLowerCase());
}

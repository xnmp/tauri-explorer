/**
 * Toggleable settings metadata, auto-registered as command-palette commands.
 * Split from `settings.svelte.ts` (#1523) to keep the store module within its
 * file-size ratchet.
 */
import { settingsStore, type Settings } from "./settings.svelte";
import type { Command, CommandCategory } from "./commands.svelte";


export interface ToggleSettingMeta {
  scope?: "pane" | "window";
  key: keyof Settings;
  id?: string;
  label: string;
  category?: CommandCategory;
  shortcut?: string;
  when?: () => boolean;
  handler?: () => void;
}

export const TOGGLE_SETTINGS: ToggleSettingMeta[] = [
  { key: "showSidebar", id: "view.toggleSidebar", label: "Toggle Sidebar", shortcut: "Alt+M B" },
  { key: "showHidden", id: "view.toggleHidden", label: "Toggle Hidden Files", shortcut: "Ctrl+H" },
  { key: "showWindowControls", id: "view.toggleWindowControls", label: "Toggle Window Controls" },
  { key: "showAddressBar", id: "view.toggleAddressBar", label: "Toggle Address Bar", shortcut: "Alt+M D" },
  {
    key: "showPreviewPane",
    scope: "pane",
    id: "view.togglePreviewPane",
    label: "Toggle Preview Pane",
    shortcut: "Space",
    // Typing ownership belongs to window keyboard routing. A focus guard here
    // also hides the command from the palette's own focused search input.
  },
  { key: "showPreviewInfo", id: "view.togglePreviewInfo", label: "Toggle Preview Info" },
  { key: "showStatusBar", id: "view.toggleStatusBar", label: "Toggle Status Bar", shortcut: "Alt+M U" },
  { key: "showGitStatus", id: "view.toggleGitStatus", label: "Toggle Git Status Indicators" },
  { key: "rowThumbnails", label: "Toggle Thumbnails in Details and List" },
  { key: "millerHideEmpty", id: "view.toggleMillerHideEmpty", label: "Miller Columns: Toggle Hide Empty Folders" },
  { key: "showManuallyHidden", id: "view.toggleManuallyHidden", label: "Toggle Manually Hidden Files" },
  // SCM panel visibility is per-pane (#434); its toggle command lives in
  // view-commands.ts (acts on the active pane). The `showScmPanel` setting
  // remains as the default new panes fall back to.
  { key: "scmTreeView", id: "view.toggleScmTreeView", label: "Toggle SCM Tree View" },
  { key: "f5SyncsLocalBranches", id: "view.toggleF5SyncsLocalBranches", label: "Toggle Git Graph F5 Syncs Local Branches" },
  { key: "confirmDelete", id: "view.toggleConfirmDelete", label: "Toggle Confirm on Delete" },
  { key: "showRecycleBin", label: "Toggle Recycle Bin in Sidebar" },
  { key: "quickOpenDebug", id: "view.toggleQuickOpenDebug", label: "Toggle Quick Open Debug Scores" },
  { key: "yaziNavigation", label: "Toggle Yazi Navigation" },
  { key: "folderPeek", id: "view.toggleFolderPeek", label: "Toggle Folder Peek" },
  { key: "folderPeekCarets", id: "view.toggleFolderPeekCarets", label: "Toggle Folder Peek Carets" },
  { key: "autoEnterSingleSubdir", label: "Toggle Auto-Enter Single Subfolder" },
  { key: "tabTitleGitRoot", label: "Toggle Git Repo Root in Tab Title" },
  { key: "integratedTitleBar", label: "Toggle Integrated Title Bar" },
  { key: "macOsVibrancy", label: "Toggle macOS Vibrancy" },
  { key: "vibrancyBlur", label: "Toggle Vibrancy Blur" },
  { key: "premiumTheme", label: "Toggle Premium Theme Effects" },
  { key: "terminalFollowsExplorer", label: "Toggle Terminal Follows Explorer" },
  { key: "explorerFollowsTerminal", label: "Toggle Explorer Follows Terminal" },
];

export function generateToggleCommands(): Command[] {
  return TOGGLE_SETTINGS.map((meta) => ({
    id: meta.id ?? `setting.toggle.${meta.key}`,
    scope: meta.scope ?? "window",
    label: meta.label,
    category: (meta.category ?? "view") as CommandCategory,
    shortcut: meta.shortcut,
    when: meta.when,
    toggleState: () => Boolean(settingsStore.state[meta.key]),
    handler:
      meta.handler ??
      (() => {
        settingsStore.update({ [meta.key]: !settingsStore.state[meta.key] });
      }),
  }));
}

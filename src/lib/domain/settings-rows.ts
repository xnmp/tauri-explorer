/**
 * Settings search terms (label + description, plus extra keywords) per
 * setting row, and the rows each Settings section shows on a platform.
 * These drive both row visibility (`matchesSettingsQuery`) and section
 * visibility. Extracted from SettingsDialog.svelte (#1372).
 */

export type SettingsSearchTerms = string[];

export const SETTINGS_ROWS = {
  theme: ["Theme", "Choose the color theme for the app"],
  iconTheme: ["Icon Theme", "Choose file icon style"],
  thumbnailSize: ["Thumbnail Size", "Size of image thumbnails in tiles view"],
  showSidebar: ["Show Sidebar", "Display bookmarks and quick access panel"],
  windowControls: ["Show Window Controls", "Display minimize, maximize and close buttons"],
  integratedTitleBar: ["Integrated Title Bar", "Show tabs in the title bar alongside window controls (requires restart)"],
  vibrancy: ["Window Vibrancy", "Native macOS translucent frosted-glass effect (requires restart)"],
  layoutTheme: ["Layout", "Panel spacing, borders, rounding and density. Add your own CSS layouts to the layouts folder", "floating islands", "hairline ledger", "island", "css", "custom"],
  premiumTheme: ["Premium Theme Effects", "Aurora-style surface treatment: accent-tinted hairlines, soft glow shadows, breadcrumb pills, translucent panels and a subtle depth backdrop. Off = flatter, higher-contrast look", "aurora", "glow", "gradient", "glass"],
  nativeBlur: ["Native Blur", "Use macOS frosted glass blur (off = theme background, requires restart)"],
  windowsBackdrop: ["Window Backdrop", "Windows translucent Mica/Acrylic frosted-glass effect (enabling from Off requires restart)"],
  windowsBackdropOpacity: ["Backdrop Opacity", "How see-through the app is over the Mica/Acrylic backdrop — islands included (lower = more transparent)"],
  addressBar: ["Show Address Bar", "Display the breadcrumb/path bar above the file list"],
  statusBar: ["Show Status Bar", "Display file info bar at the bottom (Alt+M U)"],
  navBack: ["Back", "Show the back navigation button"],
  navForward: ["Forward", "Show the forward navigation button"],
  navUp: ["Up", "Show the go-up-one-level button"],
  navRefresh: ["Refresh", "Show the refresh/reload button"],
  showHidden: ["Show Hidden Files", "Show files and folders starting with a dot (Ctrl+H)"],
  millerHideEmpty: ["Hide Empty Folders in Miller View", "Don't show folders that have no visible entries in miller columns"],
  yaziNavigation: ["Yazi-style Navigation", "Left/right arrows navigate up/into folders in Details view (and List view when Folder Peek is off)"],
  folderPeek: ["Folder Peek", "Expand folders in place with a caret; List view flows into columns that scroll sideways. Off restores the classic views"],
  folderPeekCarets: ["Show Folder Peek Carets", "Show expand carets beside folders in Details and List. Off: a single click on a folder expands or collapses it"],
  autoEnterSingleSubdir: ["Auto-Enter Single Subfolder", "When a folder contains only one subfolder (and nothing else), descend into it automatically"],
  tabTitleGitRoot: ["Git Repo Root in Tab Title", "When the folder is inside a git repository, show the repo's root folder name in the tab title"],
  defaultPaneLayout: ["New Pane Layout", "How the New Pane command places panes: dwindle splits along the longer axis (Hyprland-style), or always right/down", "split", "pane"],
  showManuallyHidden: ["Show Manually Hidden Items", "Reveal items hidden via the right-click Hide action (shown dimmed)"],
  gitStatus: ["Git Status Indicators", "Show modified/untracked indicators for files in git repositories"],
  recentItems: ["Recent Items in Sidebar", "Number of recent locations to show (0 to hide)"],
  recycleBin: ["Recycle Bin in Sidebar", "Show a shortcut to the system recycle bin below Bookmarks"],
  quickOpenDebug: ["QuickOpen Debug Scores", "Show score breakdown (name, frecency, dir bonus) in Ctrl+P results"],
  warmWindow: ["Pre-warm New Windows", "Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. The first new window after enabling still opens cold.", "performance", "speed"],
  confirmDelete: ["Confirm before deleting", "Show confirmation dialog when moving files to trash"],
  backgroundOpacity: ["Background Opacity", "Window background transparency"],
  backgroundImage: ["Background Image", "Custom wallpaper path (PNG, JPG, WEBP, SVG)"],
  wallpaperBlur: ["Wallpaper Blur", "Blur the background image"],
  terminalApp: ["Terminal Application", "Command to open terminal (empty = auto-detect)"],
  terminalFollowsExplorer: ["Terminal Follows Explorer", "Auto-cd the embedded terminal when the active pane navigates (queued if a command is running)", "terminal", "cwd", "sync"],
  enableTerminal: ["Integrated Terminal", "Feature flag: the embedded terminal panel and its Alt+M T shortcut", "experimental", "feature flag"],
  enableGitGraph: ["Git Commit Graph", "Feature flag: the git graph tab and its palette command", "experimental", "feature flag", "git graph"],
  f5SyncsLocalBranches: ["F5 Syncs Local Branches", "In the git graph, F5 also fetches and fast-forwards any local branch that is strictly behind its upstream. Diverged branches are never touched — they're reported in a toast.", "git graph", "fetch", "fast-forward", "sync"],
  explorerFollowsTerminal: ["Explorer Follows Terminal", "Navigate the active pane when the terminal's shell changes directory (OSC 7)", "terminal", "cwd", "sync"],
  previewFontSize: ["Preview Font Size", "Font size for text, code and markdown previews"],
  showPreviewInfo: ["Preview Info", "Show the file name, type badge, size and modified date in the preview pane (off = content only)", "preview", "metadata", "auxiliary", "minimal"],
  ffmpegPath: ["FFmpeg Path", "Path to the ffmpeg binary for video/audio thumbnails (leave empty to auto-detect)", "video", "thumbnail"],
  keyboardShortcuts: ["Keyboard Shortcuts", "keybindings", "hotkeys", "Click on a shortcut to change it"],
} satisfies Record<string, SettingsSearchTerms>;

export interface SettingsSectionRows {
  appearance: SettingsSearchTerms[];
  navBar: SettingsSearchTerms[];
  behavior: SettingsSearchTerms[];
  terminal: SettingsSearchTerms[];
}

/** Rows per section; platform-only rows appear only on their platform. */
export function settingsSectionRows(platform: { isMac: boolean; isWindows: boolean }): SettingsSectionRows {
  const r = SETTINGS_ROWS;
  const appearance = [
    r.theme, r.layoutTheme, r.iconTheme, r.thumbnailSize, r.showSidebar, r.windowControls,
    ...(platform.isMac ? [r.integratedTitleBar, r.vibrancy, r.nativeBlur] : []),
    ...(platform.isWindows ? [r.windowsBackdrop, r.windowsBackdropOpacity] : []),
    r.premiumTheme,
    r.addressBar, r.statusBar,
  ];
  const navBar = [r.navBack, r.navForward, r.navUp, r.navRefresh];
  const behavior = [
    r.showHidden, r.millerHideEmpty, r.yaziNavigation, r.folderPeek, r.folderPeekCarets, r.autoEnterSingleSubdir, r.tabTitleGitRoot, r.defaultPaneLayout, r.showManuallyHidden,
    r.gitStatus, r.f5SyncsLocalBranches, r.recentItems, r.recycleBin, r.quickOpenDebug, r.warmWindow, r.confirmDelete,
    r.backgroundOpacity, r.backgroundImage, r.wallpaperBlur, r.terminalApp,
    r.previewFontSize, r.showPreviewInfo, r.ffmpegPath,
  ];
  const terminal = [r.terminalFollowsExplorer, r.explorerFollowsTerminal];
  return { appearance, navBar, behavior, terminal };
}

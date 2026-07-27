<!--
  SettingsDialog component - Application settings
  Issue: tauri-explorer-npjh.1, tauri-explorer-oytv
-->
<script lang="ts">
  import { settingsStore, type IconTheme, type ThumbnailSize, type WindowsBackdrop, type PaneLayoutMode } from "$lib/state/settings.svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { isMac, isWindows } from "$lib/domain/platform";
  import { TERMINAL_LINE_ACTIONS, defaultTerminalShortcuts } from "$lib/domain/terminal-keys";
  import { eventToShortcutString, formatShortcut } from "$lib/domain/keybinding-parser";
  import { listInstalledTerminals } from "$lib/api/open";
  import { warmPoolShutdown } from "$lib/api/warm-pool";
  import { spawnWarmWindow } from "$lib/state/warm-window";
  import KeybindingsSettings from "./KeybindingsSettings.svelte";
  import Modal from "./Modal.svelte";
  import { tick } from "svelte";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";
  import type { SettingRowDescriptor } from "$lib/plugins/api";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  // Installed terminal emulators for the Terminal Application dropdown.
  // Probed once when the dialog first opens.
  let installedTerminals = $state<string[]>([]);
  $effect(() => {
    if (open && installedTerminals.length === 0) {
      listInstalledTerminals().then((r) => {
        if (r.ok) installedTerminals = r.data;
      });
    }
  });
  // Include any custom value the user already saved so it isn't lost from the list.
  const terminalOptions = $derived.by(() => {
    const opts = [...installedTerminals];
    const current = settingsStore.terminalApp;
    if (current && !opts.includes(current)) opts.unshift(current);
    return opts;
  });

  let searchQuery = $state("");
  let searchInputRef = $state<HTMLInputElement | null>(null);

  // ── Terminal shortcut recorder (#404): press keys instead of typing text ──
  let recordingActionId = $state<string | null>(null);
  const terminalDefaults = defaultTerminalShortcuts(isMac);

  /** The binding shown for an action: user override wins; "" = disabled. */
  function terminalBinding(actionId: string): { binding: string; isDefault: boolean } {
    const user = settingsStore.terminalShortcuts[actionId];
    if (user !== undefined) return { binding: user, isDefault: false };
    return { binding: terminalDefaults[actionId] ?? "", isDefault: true };
  }

  function handleShortcutRecordKeydown(event: KeyboardEvent): void {
    if (!recordingActionId) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      recordingActionId = null;
      return;
    }
    // Backspace/Delete alone clears the binding (disables the action).
    if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      settingsStore.setTerminalShortcut(recordingActionId, "");
      recordingActionId = null;
      return;
    }
    const shortcut = eventToShortcutString(event);
    if (!shortcut) return; // modifier-only press — keep recording
    settingsStore.setTerminalShortcut(recordingActionId, shortcut);
    recordingActionId = null;
  }

  // Capture-phase while recording so app shortcuts can't steal the press;
  // recording also ends when the dialog closes or the window blurs.
  $effect(() => {
    if (!recordingActionId) return;
    const cancel = () => (recordingActionId = null);
    window.addEventListener("keydown", handleShortcutRecordKeydown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleShortcutRecordKeydown, true);
      window.removeEventListener("blur", cancel);
    };
  });
  $effect(() => {
    if (!open) recordingActionId = null;
  });

  // Focus the search field whenever the dialog opens so the user can filter
  // settings by typing immediately. tick() waits for the Modal to mount the
  // input before focusing.
  $effect(() => {
    if (open && searchInputRef) {
      tick().then(() => searchInputRef?.focus());
    }
  });

  const queryLower = $derived(searchQuery.toLowerCase().trim());

  /** Fuzzy subsequence test: are all chars of `needle` found in order in `haystack`? */
  function isSubsequence(needle: string, haystack: string): boolean {
    let i = 0;
    for (let j = 0; j < haystack.length && i < needle.length; j++) {
      if (haystack[j] === needle[i]) i++;
    }
    return i === needle.length;
  }

  /** Check if a setting row matches the search query.
   *  Multi-token + fuzzy: the query is split on whitespace and every token must
   *  match (as a substring or an in-order subsequence) the row's combined
   *  label+description text. This makes "font size", "fontsize" and "fnt" all
   *  match the "Font Size" row. */
  function matchesSearch(...terms: string[]): boolean {
    if (!queryLower) return true;
    const haystack = terms.join(" ").toLowerCase();
    return queryLower
      .split(/\s+/)
      .filter(Boolean)
      .every((token) => haystack.includes(token) || isSubsequence(token, haystack));
  }

  /** Check if a section has any visible settings */
  function sectionVisible(...terms: string[][]): boolean {
    if (!queryLower) return true;
    return terms.some((t) => matchesSearch(...t));
  }

  // Searchable terms (label + description) per setting row. These drive both
  // row visibility (matchesSearch) and section visibility (sectionVisible).
  const rows = {
    theme: ["Theme", "Choose the color theme for the app"],
    iconTheme: ["Icon Theme", "Choose file icon style"],
    thumbnailSize: ["Thumbnail Size", "Size of image thumbnails in tiles view"],
    showSidebar: ["Show Sidebar", "Display bookmarks and quick access panel"],
    windowControls: ["Show Window Controls", "Display minimize, maximize and close buttons"],
    integratedTitleBar: ["Integrated Title Bar", "Show tabs in the title bar alongside window controls (requires restart)"],
    vibrancy: ["Window Vibrancy", "Native macOS translucent frosted-glass effect (requires restart)"],
    floatingIslands: ["Floating Islands", "Panels float as rounded islands over the backdrop. Works on every platform; pairs with native transparency on macOS/Windows when enabled", "vibrancy", "island", "layout"],
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
    yaziNavigation: ["Yazi-style Navigation", "Left/right arrows navigate up/into folders in details and list view"],
    autoEnterSingleSubdir: ["Auto-Enter Single Subfolder", "When a folder contains only one subfolder (and nothing else), descend into it automatically"],
    tabTitleGitRoot: ["Git Repo Root in Tab Title", "When the folder is inside a git repository, show the repo's root folder name in the tab title"],
    defaultPaneLayout: ["New Pane Layout", "How the New Pane command places panes: dwindle splits along the longer axis (Hyprland-style), or always right/down", "split", "pane"],
    showManuallyHidden: ["Show Manually Hidden Items", "Reveal items hidden via the right-click Hide action (shown dimmed)"],
    gitStatus: ["Git Status Indicators", "Show modified/untracked indicators for files in git repositories"],
    recentItems: ["Recent Items in Sidebar", "Number of recent locations to show (0 to hide)"],
    quickOpenDebug: ["QuickOpen Debug Scores", "Show score breakdown (name, frecency, dir bonus) in Ctrl+P results"],
    warmWindow: ["Pre-warm New Windows", "Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. The first new window after enabling still opens cold.", "performance", "speed"],
    confirmDelete: ["Confirm before deleting", "Show confirmation dialog when moving files to trash"],
    backgroundOpacity: ["Background Opacity", "Window background transparency"],
    backgroundImage: ["Background Image", "Custom wallpaper path (PNG, JPG, WEBP, SVG)"],
    wallpaperBlur: ["Wallpaper Blur", "Blur the background image"],
    terminalApp: ["Terminal Application", "Command to open terminal (empty = auto-detect)"],
    terminalFollowsExplorer: ["Terminal Follows Explorer", "Auto-cd the embedded terminal when the active pane navigates (queued if a command is running)", "terminal", "cwd", "sync"],
    enableTerminal: ["Integrated Terminal", "Feature flag: the embedded terminal panel and its Ctrl+` shortcut", "experimental", "feature flag"],
    enableGitGraph: ["Git Commit Graph", "Feature flag: the git graph tab and its palette command", "experimental", "feature flag", "git graph"],
    f5SyncsLocalBranches: ["F5 Syncs Local Branches", "In the git graph, F5 also fetches and fast-forwards any local branch that is strictly behind its upstream. Diverged branches are never touched — they're reported in a toast.", "git graph", "fetch", "fast-forward", "sync"],
    explorerFollowsTerminal: ["Explorer Follows Terminal", "Navigate the active pane when the terminal's shell changes directory (OSC 7)", "terminal", "cwd", "sync"],
    previewFontSize: ["Preview Font Size", "Font size for text, code and markdown previews"],
    showPreviewInfo: ["Preview Info", "Show the file name, type badge, size and modified date in the preview pane (off = content only)", "preview", "metadata", "auxiliary", "minimal"],
    ffmpegPath: ["FFmpeg Path", "Path to the ffmpeg binary for video/audio thumbnails (leave empty to auto-detect)", "video", "thumbnail"],
    keyboardShortcuts: ["Keyboard Shortcuts", "keybindings", "hotkeys", "Click on a shortcut to change it"],
  };

  const appearanceRows = [
    rows.theme, rows.iconTheme, rows.thumbnailSize, rows.showSidebar, rows.windowControls,
    ...(isMac ? [rows.integratedTitleBar, rows.vibrancy, rows.nativeBlur] : []),
    ...(isWindows ? [rows.windowsBackdrop, rows.windowsBackdropOpacity] : []),
    rows.floatingIslands, rows.premiumTheme,
    rows.addressBar, rows.statusBar,
  ];
  const navBarRows = [rows.navBack, rows.navForward, rows.navUp, rows.navRefresh];
  const behaviorRows = [
    rows.showHidden, rows.millerHideEmpty, rows.yaziNavigation, rows.autoEnterSingleSubdir, rows.tabTitleGitRoot, rows.defaultPaneLayout, rows.showManuallyHidden,
    rows.gitStatus, rows.f5SyncsLocalBranches, rows.recentItems, rows.quickOpenDebug, rows.warmWindow, rows.confirmDelete,
    rows.backgroundOpacity, rows.backgroundImage, rows.wallpaperBlur, rows.terminalApp,
    rows.previewFontSize, rows.showPreviewInfo, rows.ffmpegPath,
  ];
  const terminalRows = [rows.terminalFollowsExplorer, rows.explorerFollowsTerminal];

  // Escape clears the search filter before closing, so the Modal default
  // (close on Escape) is disabled and Escape is handled here instead.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "f" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      searchInputRef?.focus();
      searchInputRef?.select();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      // Stop the window-level Escape handler (dialogStore.closeAll) from
      // also firing — it would close the dialog while we only clear the
      // filter on the first press.
      event.stopPropagation();
      if (searchQuery) {
        searchQuery = "";
      } else {
        onClose();
      }
    }
  }
</script>

<Modal
  {open}
  {onClose}
  overlayClass="settings-overlay"
  labelledby="settings-title"
  closeOnEscape={false}
  onkeydown={handleKeydown}
>
    <div class="settings-dialog">
      <header class="dialog-header">
        <h2 id="settings-title">Settings</h2>
        <input
          type="text"
          class="settings-search"
          placeholder="Filter settings..."
          bind:value={searchQuery}
          bind:this={searchInputRef}
          autocomplete="off"
          spellcheck="false"
        />
        <button class="close-btn" onclick={onClose} aria-label="Close settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div class="dialog-content">
        <!-- Appearance Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...appearanceRows)}>
          <h3 class="section-title">Appearance</h3>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.theme)}>
            <div class="setting-info">
              <span class="setting-label">Theme</span>
              <span class="setting-description">Choose the color theme for the app</span>
            </div>
            <select
              class="theme-select color-theme-select"
              value={themeStore.currentThemeId}
              onchange={(e) => themeStore.setTheme(e.currentTarget.value)}
            >
              {#each themeStore.availableThemes as theme (theme.id)}
                <option value={theme.id}>{theme.name}</option>
              {/each}
            </select>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.iconTheme)}>
            <div class="setting-info">
              <span class="setting-label">Icon Theme</span>
              <span class="setting-description">Choose file icon style</span>
            </div>
            <select
              class="theme-select icon-theme-select"
              value={settingsStore.iconTheme}
              onchange={(e) => settingsStore.update({ iconTheme: e.currentTarget.value as IconTheme })}
            >
              <option value="default">Default</option>
              <option value="material">Material</option>
              <option value="minimal">Minimal</option>
            </select>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.thumbnailSize)}>
            <div class="setting-info">
              <span class="setting-label">Thumbnail Size</span>
              <span class="setting-description">Size of image thumbnails in tiles view</span>
            </div>
            <select
              class="theme-select"
              value={settingsStore.thumbnailSize}
              onchange={(e) => settingsStore.update({ thumbnailSize: e.currentTarget.value as ThumbnailSize })}
            >
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="xlarge">Extra Large</option>
            </select>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.showSidebar)}>
            <div class="setting-info">
              <span class="setting-label">Show Sidebar</span>
              <span class="setting-description">Display bookmarks and quick access panel</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showSidebar}
                onchange={() => settingsStore.toggleSidebar()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.windowControls)}>
            <div class="setting-info">
              <span class="setting-label">Show Window Controls</span>
              <span class="setting-description">Display minimize, maximize and close buttons</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showWindowControls}
                onchange={() => settingsStore.toggleWindowControls()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          {#if isMac}
          <div class="setting-row" class:hidden={!matchesSearch(...rows.integratedTitleBar)}>
            <div class="setting-info">
              <span class="setting-label">Integrated Title Bar</span>
              <span class="setting-description">Show tabs in the title bar alongside window controls (requires restart)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.integratedTitleBar}
                onchange={() => settingsStore.update({ integratedTitleBar: !settingsStore.integratedTitleBar })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.vibrancy)}>
            <div class="setting-info">
              <span class="setting-label">Window Vibrancy</span>
              <span class="setting-description">Native macOS translucent frosted-glass effect (requires restart)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.macOsVibrancy}
                onchange={() => settingsStore.update({ macOsVibrancy: !settingsStore.macOsVibrancy })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          {#if settingsStore.macOsVibrancy}
          <div class="setting-row" class:hidden={!matchesSearch(...rows.nativeBlur)}>
            <div class="setting-info">
              <span class="setting-label">Native Blur</span>
              <span class="setting-description">Use macOS frosted glass blur (off = theme background, requires restart)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.vibrancyBlur}
                onchange={() => settingsStore.update({ vibrancyBlur: !settingsStore.vibrancyBlur })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
          {/if}
          {/if}

          {#if isWindows}
          <div class="setting-row" class:hidden={!matchesSearch(...rows.windowsBackdrop)}>
            <div class="setting-info">
              <span class="setting-label">Window Backdrop</span>
              <span class="setting-description">Translucent frosted-glass effect (enabling from Off requires restart)</span>
            </div>
            <select
              class="theme-select"
              value={settingsStore.windowsBackdrop}
              onchange={(e) => settingsStore.setWindowsBackdrop(e.currentTarget.value as WindowsBackdrop)}
            >
              <option value="off">Off</option>
              <option value="mica">Mica (wallpaper tint)</option>
              <option value="acrylic">Acrylic (see-through)</option>
            </select>
          </div>

          {#if settingsStore.windowsBackdrop === "acrylic"}
          <div class="setting-row" class:hidden={!matchesSearch(...rows.windowsBackdropOpacity)}>
            <div class="setting-info">
              <span class="setting-label">Backdrop Opacity</span>
              <span class="setting-description">How see-through the Acrylic backdrop is ({settingsStore.windowsBackdropOpacity}%, lower = more transparent)</span>
            </div>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              step="5"
              value={settingsStore.windowsBackdropOpacity}
              oninput={(e) => settingsStore.update({ windowsBackdropOpacity: Number(e.currentTarget.value) })}
            />
          </div>
          {/if}
          {/if}

          <div class="setting-row" class:hidden={!matchesSearch(...rows.floatingIslands)}>
            <div class="setting-info">
              <span class="setting-label">Floating Islands</span>
              <span class="setting-description">Panels float as rounded islands over the backdrop — works on every platform, pairs with native transparency where available (#277)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.floatingIslands}
                onchange={() => settingsStore.update({ floatingIslands: !settingsStore.floatingIslands })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.premiumTheme)}>
            <div class="setting-info">
              <span class="setting-label">Premium Theme Effects</span>
              <span class="setting-description">Aurora-style surface treatment: accent-tinted hairlines, soft glow shadows, breadcrumb pills, translucent panels and a subtle depth backdrop. Off = flatter, higher-contrast look</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.premiumTheme}
                onchange={() => settingsStore.togglePremiumTheme()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.addressBar)}>
            <div class="setting-info">
              <span class="setting-label">Show Address Bar</span>
              <span class="setting-description">Display the breadcrumb/path bar above the file list</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showAddressBar}
                onchange={() => settingsStore.toggleAddressBar()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.statusBar)}>
            <div class="setting-info">
              <span class="setting-label">Show Status Bar</span>
              <span class="setting-description">Display file info bar at the bottom (Alt+M U)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showStatusBar}
                onchange={() => settingsStore.toggleStatusBar()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- Navigation Bar Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...navBarRows)}>
          <h3 class="section-title">Navigation Bar Buttons</h3>
          <div class="setting-row" class:hidden={!matchesSearch(...rows.navBack)}>
            <div class="setting-info">
              <span class="setting-label">Back</span>
              <span class="setting-description">Show the back navigation button</span>
            </div>
            <label class="toggle">
              <input type="checkbox" checked={settingsStore.navBarButtons.back} onchange={() => settingsStore.toggleNavButton("back")} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row" class:hidden={!matchesSearch(...rows.navForward)}>
            <div class="setting-info">
              <span class="setting-label">Forward</span>
              <span class="setting-description">Show the forward navigation button</span>
            </div>
            <label class="toggle">
              <input type="checkbox" checked={settingsStore.navBarButtons.forward} onchange={() => settingsStore.toggleNavButton("forward")} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row" class:hidden={!matchesSearch(...rows.navUp)}>
            <div class="setting-info">
              <span class="setting-label">Up</span>
              <span class="setting-description">Show the go-up-one-level button</span>
            </div>
            <label class="toggle">
              <input type="checkbox" checked={settingsStore.navBarButtons.up} onchange={() => settingsStore.toggleNavButton("up")} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="setting-row" class:hidden={!matchesSearch(...rows.navRefresh)}>
            <div class="setting-info">
              <span class="setting-label">Refresh</span>
              <span class="setting-description">Show the refresh/reload button</span>
            </div>
            <label class="toggle">
              <input type="checkbox" checked={settingsStore.navBarButtons.refresh} onchange={() => settingsStore.toggleNavButton("refresh")} />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- Behavior Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...behaviorRows)}>
          <h3 class="section-title">Behavior</h3>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.showHidden)}>
            <div class="setting-info">
              <span class="setting-label">Show Hidden Files</span>
              <span class="setting-description">Show files and folders starting with a dot (Ctrl+H)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showHidden}
                onchange={() => settingsStore.toggleHidden()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.millerHideEmpty)}>
            <div class="setting-info">
              <span class="setting-label">Hide Empty Folders in Miller View</span>
              <span class="setting-description">Don't show folders that have no visible entries in miller columns</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.millerHideEmpty}
                onchange={() => settingsStore.toggleMillerHideEmpty()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.yaziNavigation)}>
            <div class="setting-info">
              <span class="setting-label">Yazi-style Navigation</span>
              <span class="setting-description">Left/right arrows navigate up/into folders in details and list view</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.yaziNavigation}
                onchange={() => settingsStore.update({ yaziNavigation: !settingsStore.yaziNavigation })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.autoEnterSingleSubdir)}>
            <div class="setting-info">
              <span class="setting-label">Auto-Enter Single Subfolder</span>
              <span class="setting-description">When a folder contains only one subfolder (and nothing else), descend into it automatically</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.autoEnterSingleSubdir}
                onchange={() => settingsStore.update({ autoEnterSingleSubdir: !settingsStore.autoEnterSingleSubdir })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.tabTitleGitRoot)}>
            <div class="setting-info">
              <span class="setting-label">Git Repo Root in Tab Title</span>
              <span class="setting-description">When the folder is inside a git repository, show the repo's root folder name in the tab title</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.tabTitleGitRoot}
                onchange={() => settingsStore.update({ tabTitleGitRoot: !settingsStore.tabTitleGitRoot })}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.defaultPaneLayout)}>
            <div class="setting-info">
              <span class="setting-label">New Pane Layout</span>
              <span class="setting-description">How the New Pane command places panes: dwindle splits along the longer axis (Hyprland-style), or always right/down</span>
            </div>
            <select
              class="theme-select"
              value={settingsStore.defaultPaneLayout}
              onchange={(e) => settingsStore.setDefaultPaneLayout(e.currentTarget.value as PaneLayoutMode)}
            >
              <option value="dwindle">Dwindle</option>
              <option value="right">Split Right</option>
              <option value="down">Split Down</option>
            </select>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.warmWindow)}>
            <div class="setting-info">
              <span class="setting-label">Pre-warm New Windows</span>
              <span class="setting-description">Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. The first new window after enabling still opens cold.</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.warmWindow}
                onchange={() => {
                  const enabled = !settingsStore.warmWindow;
                  settingsStore.update({ warmWindow: enabled });
                  // Apply immediately: prime the pool on enable; close the
                  // parked hidden window on disable (otherwise it lingers,
                  // unclaimable, until the app exits).
                  if (enabled) void spawnWarmWindow();
                  else void warmPoolShutdown().catch(() => {});
                }}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.showManuallyHidden)}>
            <div class="setting-info">
              <span class="setting-label">Show Manually Hidden Items</span>
              <span class="setting-description">Reveal items hidden via the right-click Hide action (shown dimmed)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showManuallyHidden}
                onchange={() => settingsStore.toggleShowManuallyHidden()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.gitStatus)}>
            <div class="setting-info">
              <span class="setting-label">Git Status Indicators</span>
              <span class="setting-description">Show modified/untracked indicators for files in git repositories</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showGitStatus}
                onchange={() => settingsStore.toggleGitStatus()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.f5SyncsLocalBranches)}>
            <div class="setting-info">
              <span class="setting-label">F5 Syncs Local Branches</span>
              <span class="setting-description">In the git graph, F5 also fetches and fast-forwards any local branch strictly behind its upstream. Diverged branches are reported in a toast, never touched.</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                data-testid="setting-f5-syncs-local-branches"
                checked={settingsStore.f5SyncsLocalBranches}
                onchange={() => settingsStore.toggleF5SyncsLocalBranches()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.recentItems)}>
            <div class="setting-info">
              <span class="setting-label">Recent Items in Sidebar</span>
              <span class="setting-description">Number of recent locations to show (0 to hide)</span>
            </div>
            <input
              type="number"
              class="setting-number"
              min="0"
              max="20"
              value={settingsStore.recentItemsCount}
              onchange={(e) => settingsStore.setRecentItemsCount(parseInt((e.target as HTMLInputElement).value) || 0)}
            />
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.quickOpenDebug)}>
            <div class="setting-info">
              <span class="setting-label">QuickOpen Debug Scores</span>
              <span class="setting-description">Show score breakdown (name, frecency, dir bonus) in Ctrl+P results</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.quickOpenDebug}
                onchange={() => settingsStore.toggleQuickOpenDebug()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-item" class:hidden={!matchesSearch(...rows.confirmDelete)}>
            <div class="setting-label">
              <span>Confirm before deleting</span>
              <span class="setting-description">Show confirmation dialog when moving files to trash</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.confirmDelete}
                onchange={() => settingsStore.toggleConfirmDelete()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.backgroundOpacity)}>
            <div class="setting-info">
              <span class="setting-label">Background Opacity</span>
              <span class="setting-description">Window background transparency ({settingsStore.backgroundOpacity}%)</span>
            </div>
            <input
              class="range-input"
              type="range"
              min="20"
              max="100"
              step="5"
              value={settingsStore.backgroundOpacity}
              oninput={(e) => settingsStore.update({ backgroundOpacity: Number(e.currentTarget.value) })}
            />
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.backgroundImage)}>
            <div class="setting-info">
              <span class="setting-label">Background Image</span>
              <span class="setting-description">Custom wallpaper path (PNG, JPG, WEBP, SVG)</span>
            </div>
            <div class="wallpaper-controls">
              <input
                class="text-input wallpaper-input"
                type="text"
                value={settingsStore.backgroundImage}
                placeholder="/path/to/image.jpg"
                onchange={(e) => settingsStore.update({ backgroundImage: e.currentTarget.value })}
              />
              {#if settingsStore.backgroundImage}
                <button class="clear-btn" onclick={() => settingsStore.update({ backgroundImage: "", backgroundBlur: 0 })} title="Clear wallpaper">✕</button>
              {/if}
            </div>
          </div>

          {#if settingsStore.backgroundImage}
            <div class="setting-row" class:hidden={!matchesSearch(...rows.wallpaperBlur)}>
              <div class="setting-info">
                <span class="setting-label">Wallpaper Blur</span>
                <span class="setting-description">Blur the background image ({settingsStore.backgroundBlur}px)</span>
              </div>
              <input
                class="range-input"
                type="range"
                min="0"
                max="20"
                step="1"
                value={settingsStore.backgroundBlur}
                oninput={(e) => settingsStore.update({ backgroundBlur: Number(e.currentTarget.value) })}
              />
            </div>
          {/if}

          <div class="setting-row" class:hidden={!matchesSearch(...rows.terminalApp)}>
            <div class="setting-info">
              <span class="setting-label">Terminal Application</span>
              <span class="setting-description">Choose an installed terminal (Auto-detect picks the first available)</span>
            </div>
            <select
              class="theme-select"
              value={settingsStore.terminalApp}
              onchange={(e) => settingsStore.update({ terminalApp: e.currentTarget.value })}
            >
              <option value="">Auto-detect</option>
              {#each terminalOptions as term}
                <option value={term}>{term}</option>
              {/each}
            </select>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.previewFontSize)}>
            <div class="setting-info">
              <span class="setting-label">Preview Font Size</span>
              <span class="setting-description">Font size for text, code and markdown previews ({settingsStore.previewFontSize}px)</span>
            </div>
            <input
              class="range-input"
              type="range"
              min="8"
              max="24"
              step="1"
              value={settingsStore.previewFontSize}
              oninput={(e) => settingsStore.setPreviewFontSize(Number(e.currentTarget.value))}
            />
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.showPreviewInfo)}>
            <div class="setting-info">
              <span class="setting-label">Preview Info</span>
              <span class="setting-description">Show the file name, type badge, size and modified date in the preview pane (off = content only)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                data-testid="setting-show-preview-info"
                checked={settingsStore.showPreviewInfo}
                onchange={() => settingsStore.togglePreviewInfo()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.ffmpegPath)}>
            <div class="setting-info">
              <span class="setting-label">FFmpeg Path</span>
              <span class="setting-description">Path to ffmpeg for video/audio thumbnails (empty = auto-detect)</span>
            </div>
            <input
              class="text-input"
              type="text"
              value={settingsStore.ffmpegPath}
              placeholder="e.g. C:\\ffmpeg\\bin\\ffmpeg.exe"
              onchange={(e) => settingsStore.update({ ffmpegPath: e.currentTarget.value })}
            />
          </div>
        </section>

        <!-- Terminal Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...terminalRows)}>
          <h3 class="section-title">Terminal</h3>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.terminalFollowsExplorer)}>
            <div class="setting-info">
              <span class="setting-label">Terminal Follows Explorer</span>
              <span class="setting-description">Auto-cd the embedded terminal when the active pane navigates (queued if a command is running)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.terminalFollowsExplorer}
                onchange={() => settingsStore.toggleTerminalFollowsExplorer()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.explorerFollowsTerminal)}>
            <div class="setting-info">
              <span class="setting-label">Explorer Follows Terminal</span>
              <span class="setting-description">Navigate the active pane when the terminal's shell changes directory (OSC 7)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.explorerFollowsTerminal}
                onchange={() => settingsStore.toggleExplorerFollowsTerminal()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- Line-editing shortcuts (#375): bind key combos to readline
               actions. Empty = disabled (native terminal behavior). -->
          <div class="setting-row terminal-shortcuts" class:hidden={!matchesSearch("Terminal Shortcuts", "line editing", "readline", "home", "end", "delete word")}>
            <div class="setting-info">
              <span class="setting-label">Line-Editing Shortcuts</span>
              <span class="setting-description">
                Click a binding, then press the keys. Backspace clears
                (the key keeps its native behavior); Esc cancels.
              </span>
              <div class="terminal-shortcut-list">
                {#each TERMINAL_LINE_ACTIONS as action (action.id)}
                  {@const tb = terminalBinding(action.id)}
                  <div class="terminal-shortcut-row">
                    <span class="ts-label">{action.label}</span>
                    <button
                      class="ts-record"
                      class:recording={recordingActionId === action.id}
                      class:unbound={!tb.binding && recordingActionId !== action.id}
                      onclick={() => (recordingActionId = recordingActionId === action.id ? null : action.id)}
                      title="Click, then press the new key combo"
                    >
                      {#if recordingActionId === action.id}
                        Press keys…
                      {:else if tb.binding}
                        {formatShortcut(tb.binding)}{tb.isDefault ? " (default)" : ""}
                      {:else}
                        unbound
                      {/if}
                    </button>
                    {#if !tb.isDefault}
                      <button
                        class="ts-reset"
                        title={terminalDefaults[action.id] ? "Reset to default" : "Remove binding"}
                        aria-label="Reset binding"
                        onclick={() => settingsStore.setTerminalShortcut(action.id, null)}
                      >↺</button>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </section>

        <!-- Experimental Section (#175): feature flags for recently shipped surfaces -->
        <section class="settings-section" class:hidden={!sectionVisible(["Experimental", "feature flags"], rows.enableTerminal, rows.enableGitGraph)}>
          <h3 class="section-title">Experimental</h3>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.enableTerminal)}>
            <div class="setting-info">
              <span class="setting-label">Integrated Terminal</span>
              <span class="setting-description">Enable the embedded terminal panel (Ctrl+`)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.enableTerminal}
                onchange={() => settingsStore.toggleEnableTerminal()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.enableGitGraph)}>
            <div class="setting-info">
              <span class="setting-label">Git Commit Graph</span>
              <span class="setting-description">Show the repo's commit graph in the active pane (command palette: Git: Toggle Commit Graph, Ctrl+Alt+G)</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.enableGitGraph}
                onchange={() => settingsStore.toggleEnableGitGraph()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- Plugins Section -->
        <section class="settings-section" class:hidden={!sectionVisible(["Plugins", "enable disable extensions"], ...pluginRegistry.plugins.map((p) => [p.name, p.description]))}>
          <h3 class="section-title">Plugins</h3>
          {#each pluginRegistry.plugins as plugin (plugin.id)}
            <div class="setting-row" class:hidden={!matchesSearch("Plugins", plugin.name, plugin.description)}>
              <div class="setting-info">
                <span class="setting-label">{plugin.name}</span>
                <span class="setting-description">{plugin.description}</span>
              </div>
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={plugin.enabled}
                  onchange={(e) => pluginRegistry.setEnabled(plugin.id, e.currentTarget.checked)}
                />
                <span class="toggle-slider"></span>
              </label>
            </div>
          {/each}
        </section>

        <!-- Plugin-contributed settings sections (descriptor-driven) -->
        {#each pluginSettingsSections.sections as section (section.pluginId + ":" + section.id)}
          <section class="settings-section" class:hidden={!sectionVisible([section.title, ...section.rows.flatMap((r: SettingRowDescriptor) => [r.label, r.description ?? ""])])}>
            <h3 class="section-title">{section.title}</h3>
            {#each section.rows as row (row.id)}
              <div class="setting-row" class:hidden={!matchesSearch(section.title, row.label, row.description ?? "")}>
                <div class="setting-info">
                  <span class="setting-label">{row.label}</span>
                  {#if row.description}
                    <span class="setting-description">{row.description}</span>
                  {/if}
                </div>
                {#if row.type === "toggle"}
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={!!section.valueOf(row)}
                      onchange={(e) => section.setValue(row.id, e.currentTarget.checked)}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                {:else if row.type === "select"}
                  <select
                    class="theme-select"
                    value={String(section.valueOf(row) ?? "")}
                    onchange={(e) => section.setValue(row.id, e.currentTarget.value)}
                  >
                    {#each row.options ?? [] as opt (opt.value)}
                      <option value={opt.value}>{opt.label}</option>
                    {/each}
                  </select>
                {:else}
                  <input
                    class="text-input"
                    type={row.type === "password" ? "password" : "text"}
                    value={String(section.valueOf(row) ?? "")}
                    onchange={(e) => section.setValue(row.id, e.currentTarget.value)}
                  />
                {/if}
              </div>
            {/each}
          </section>
        {/each}

        <!-- Keyboard Shortcuts Section -->
        <section class="settings-section" class:hidden={!sectionVisible(rows.keyboardShortcuts)}>
          <h3 class="section-title">Keyboard Shortcuts</h3>
          <p class="section-hint">Click on a shortcut to change it. Press Escape to cancel.</p>
          <KeybindingsSettings />
        </section>
      </div>
    </div>
</Modal>

<style>
  .settings-dialog {
    width: 600px;
    max-width: 90vw;
    max-height: 85vh;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    animation: slideUp 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .dialog-header h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .settings-search {
    flex: 1;
    max-width: 200px;
    margin: 0 12px;
    padding: 5px 10px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
  }

  .settings-search:focus {
    border-color: var(--accent);
  }

  .settings-search::placeholder {
    color: var(--text-tertiary);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .dialog-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .settings-section {
    margin-bottom: 24px;
  }

  /* Rows/sections filtered out by the settings search.
     !important so it beats the later `.setting-row { display: flex }` rule —
     they have equal specificity, so without this the row's own rule (defined
     after `.hidden` in source order) would win and filtered rows would still
     show. */
  .hidden {
    display: none !important;
  }

  .settings-section:last-child {
    margin-bottom: 0;
  }

  /* Terminal line-editing shortcut bindings (#375). */
  .terminal-shortcut-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }

  .terminal-shortcut-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ts-label {
    flex: 1;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .ts-record {
    width: 160px;
    padding: 3px 8px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    text-align: center;
  }

  .ts-record:hover {
    background: var(--control-fill-secondary, var(--subtle-fill-secondary));
  }

  .ts-record.recording {
    border-color: var(--accent);
    color: var(--accent);
  }

  .ts-record.unbound {
    color: var(--text-tertiary);
  }

  .ts-reset {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
  }

  .ts-reset:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 8px 0;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--divider);
  }

  .section-hint {
    font-size: 12px;
    color: var(--text-tertiary);
    margin: 0 0 12px 0;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--divider);
  }

  .setting-row:last-child {
    border-bottom: none;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .setting-number {
    width: 60px;
    padding: 4px 8px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    text-align: center;
  }

  .text-input {
    padding: 6px 12px;
    width: 160px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    transition: all var(--transition-fast);
  }

  .text-input:hover {
    background: var(--control-fill-secondary);
  }

  .text-input:focus {
    border-color: var(--accent);
  }

  .text-input::placeholder {
    color: var(--text-tertiary);
  }

  .wallpaper-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .wallpaper-input {
    width: 200px;
    font-size: 12px;
  }

  .clear-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    transition: all var(--transition-fast);
  }

  .clear-btn:hover {
    background: var(--system-critical);
    color: white;
    border-color: var(--system-critical);
  }

  .range-input {
    width: 140px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .theme-select {
    appearance: none;
    -webkit-appearance: none;
    padding: 6px 28px 6px 12px;
    background: var(--control-fill);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%238a95b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 8px center;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    outline: none;
    transition: all var(--transition-fast);
  }

  .theme-select:hover {
    background-color: var(--control-fill-secondary);
  }

  .theme-select:focus {
    border-color: var(--accent);
  }

  .theme-select option {
    background: var(--background-solid);
    color: var(--text-primary);
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    display: inline-block;
    flex: 0 0 44px;
    height: 24px;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--control-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: 12px;
    transition: all var(--transition-fast);
  }

  .toggle-slider::before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: all var(--transition-fast);
  }

  .toggle input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle input:checked + .toggle-slider::before {
    transform: translateX(20px);
    background: var(--text-on-accent);
  }

  .toggle input:focus-visible + .toggle-slider {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }
</style>

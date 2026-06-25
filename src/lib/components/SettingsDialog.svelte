<!--
  SettingsDialog component - Application settings
  Issue: tauri-explorer-npjh.1, tauri-explorer-oytv
-->
<script lang="ts">
  import { settingsStore, type IconTheme, type ThumbnailSize, type WindowsBackdrop } from "$lib/state/settings.svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { isMac, isWindows } from "$lib/domain/platform";
  import { listInstalledTerminals } from "$lib/api/files";
  import KeybindingsSettings from "./KeybindingsSettings.svelte";
  import Modal from "./Modal.svelte";
  import { tick } from "svelte";

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
    nativeBlur: ["Native Blur", "Use macOS frosted glass blur (off = theme background, requires restart)"],
    windowsBackdrop: ["Window Backdrop", "Windows translucent Mica/Acrylic frosted-glass effect (enabling from Off requires restart)"],
    windowsBackdropOpacity: ["Backdrop Opacity", "How see-through the Acrylic backdrop is (lower = more transparent)"],
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
    showManuallyHidden: ["Show Manually Hidden Items", "Reveal items hidden via the right-click Hide action (shown dimmed)"],
    gitStatus: ["Git Status Indicators", "Show modified/untracked indicators for files in git repositories"],
    recentItems: ["Recent Items in Sidebar", "Number of recent locations to show (0 to hide)"],
    quickOpenDebug: ["QuickOpen Debug Scores", "Show score breakdown (name, frecency, dir bonus) in Ctrl+P results"],
    warmWindow: ["Pre-warm New Windows (experimental)", "Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. Takes effect on next launch.", "performance", "speed"],
    confirmDelete: ["Confirm before deleting", "Show confirmation dialog when moving files to trash"],
    backgroundOpacity: ["Background Opacity", "Window background transparency"],
    backgroundImage: ["Background Image", "Custom wallpaper path (PNG, JPG, WEBP, SVG)"],
    wallpaperBlur: ["Wallpaper Blur", "Blur the background image"],
    terminalApp: ["Terminal Application", "Command to open terminal (empty = auto-detect)"],
    previewFontSize: ["Preview Font Size", "Font size for text, code and markdown previews"],
    ffmpegPath: ["FFmpeg Path", "Path to the ffmpeg binary for video/audio thumbnails (leave empty to auto-detect)", "video", "thumbnail"],
    geminiApiKey: ["Gemini API Key", "Required for Nano Banana image editing (right-click images)", "AI", "Nano Banana"],
    keyboardShortcuts: ["Keyboard Shortcuts", "keybindings", "hotkeys", "Click on a shortcut to change it"],
  };

  const appearanceRows = [
    rows.theme, rows.iconTheme, rows.thumbnailSize, rows.showSidebar, rows.windowControls,
    ...(isMac ? [rows.integratedTitleBar, rows.vibrancy, rows.nativeBlur] : []),
    ...(isWindows ? [rows.windowsBackdrop, rows.windowsBackdropOpacity] : []),
    rows.addressBar, rows.statusBar,
  ];
  const navBarRows = [rows.navBack, rows.navForward, rows.navUp, rows.navRefresh];
  const behaviorRows = [
    rows.showHidden, rows.millerHideEmpty, rows.yaziNavigation, rows.autoEnterSingleSubdir, rows.tabTitleGitRoot, rows.showManuallyHidden,
    rows.gitStatus, rows.recentItems, rows.quickOpenDebug, rows.warmWindow, rows.confirmDelete,
    rows.backgroundOpacity, rows.backgroundImage, rows.wallpaperBlur, rows.terminalApp,
    rows.previewFontSize, rows.ffmpegPath,
  ];

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

          <div class="setting-row" class:hidden={!matchesSearch(...rows.warmWindow)}>
            <div class="setting-info">
              <span class="setting-label">Pre-warm New Windows (experimental)</span>
              <span class="setting-description">Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. Takes effect on next launch.</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.warmWindow}
                onchange={() => settingsStore.update({ warmWindow: !settingsStore.warmWindow })}
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

        <!-- AI / Nano Banana Section -->
        <section class="settings-section" class:hidden={!sectionVisible(rows.geminiApiKey)}>
          <h3 class="section-title">AI / Nano Banana</h3>

          <div class="setting-row" class:hidden={!matchesSearch(...rows.geminiApiKey)}>
            <div class="setting-info">
              <span class="setting-label">Gemini API Key</span>
              <span class="setting-description">Required for Nano Banana image editing (right-click images)</span>
            </div>
            <input
              class="text-input"
              type="password"
              value={settingsStore.geminiApiKey}
              placeholder="Enter API key"
              onchange={(e) => settingsStore.setGeminiApiKey(e.currentTarget.value)}
            />
          </div>
        </section>

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
    width: 44px;
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

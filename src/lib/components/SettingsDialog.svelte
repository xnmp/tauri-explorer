<!--
  SettingsDialog component - Application settings
  Issue: tauri-explorer-npjh.1, tauri-explorer-oytv
-->
<script lang="ts">
  import { settingsStore, type IconTheme, type WindowsBackdrop, type PaneLayoutMode } from "$lib/state/settings.svelte";
  import { ICON_THEMES } from './icons/icon-theme-options';
  import { themeStore } from "$lib/state/theme.svelte";
  import { isMac, isWindows } from "$lib/domain/platform";
  import { listInstalledTerminals } from "$lib/api/open";
  import { warmPoolShutdown } from "$lib/api/warm-pool";
  import { spawnWarmWindow } from "$lib/state/warm-window";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import Modal from "./Modal.svelte";
  import SettingRow from "./settings/SettingRow.svelte";
  import SettingToggle from "./settings/SettingToggle.svelte";
  import TerminalShortcutSettings from "./settings/TerminalShortcutSettings.svelte";
  import LayoutThemeSetting from "./settings/LayoutThemeSetting.svelte";
  import ThumbnailSettings from "./settings/ThumbnailSettings.svelte";
  import "./settings/settings-select.css";
  import { matchesSettingsQuery } from "$lib/domain/settings-search";
  import { SETTINGS_ROWS, settingsSectionRows } from "$lib/domain/settings-rows";
  import { tick } from "svelte";
  import { pluginRegistry } from "$lib/plugins/registry.svelte";
  import LanguageModelsSettings from "./ai/LanguageModelsSettings.svelte";
  import { TEXT_SETTINGS_SEARCH_TERMS } from "$lib/domain/text-connections";
  import { pluginSettingsSections } from "$lib/plugins/settings-registry.svelte";

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

  function matchesSearch(...terms: string[]): boolean {
    return matchesSettingsQuery(queryLower, ...terms);
  }

  /** Check if a section has any visible settings */
  function sectionVisible(...terms: string[][]): boolean {
    if (!queryLower) return true;
    return terms.some((t) => matchesSearch(...t));
  }

  // Searchable terms per setting row and per-section row lists live in
  // domain/settings-rows; they drive row and section visibility.
  const rows = SETTINGS_ROWS;
  const { appearance: appearanceRows, navBar: navBarRows, behavior: behaviorRows, terminal: terminalRows } =
    settingsSectionRows({ isMac, isWindows });

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
    <div class="settings-dialog" style:--settings-zoom={settingsStore.zoomLevel / 100}>
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
        {#if open}
          <section class="settings-section" class:hidden={!matchesSearch(...TEXT_SETTINGS_SEARCH_TERMS)}>
            <h3 class="section-title">AI</h3>
            <LanguageModelsSettings />
          </section>
        {/if}

        <!-- Appearance Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...appearanceRows)}>
          <h3 class="section-title">Appearance</h3>

          <SettingRow label="Theme"
            description="Choose the color theme for the app"
            hidden={!matchesSearch(...rows.theme)}>
            <select
              class="settings-select color-theme-select"
              value={themeStore.currentThemeId}
              onchange={(e) => themeStore.setTheme(e.currentTarget.value)}
            >
              {#each themeStore.availableThemes as theme (theme.id)}
                <option value={theme.id}>{theme.name}</option>
              {/each}
            </select>
          </SettingRow>

          <SettingRow label="Layout"
            description="Panel spacing, borders, rounding and density. Add your own CSS layouts to the layouts folder"
            hidden={!matchesSearch(...rows.layoutTheme)}>
            <LayoutThemeSetting {onClose} />
          </SettingRow>

          <SettingRow label="Icon Theme"
            description="Choose file icon style"
            hidden={!matchesSearch(...rows.iconTheme)}>
            <select
              class="settings-select icon-theme-select"
              value={settingsStore.iconTheme}
              onchange={(e) => settingsStore.update({ iconTheme: e.currentTarget.value as IconTheme })}
            >
              {#each ICON_THEMES as pack (pack.id)}
                <option value={pack.id}>{pack.name}</option>
              {/each}
            </select>
          </SettingRow>

          <ThumbnailSettings matches={matchesSearch} />

          <SettingRow label="Show Sidebar"
            description="Display bookmarks and quick access panel"
            hidden={!matchesSearch(...rows.showSidebar)}>
            <SettingToggle checked={settingsStore.showSidebar} onchange={() => settingsStore.toggleSidebar()} />
          </SettingRow>

          <SettingRow label="Show Window Controls"
            description="Display minimize, maximize and close buttons"
            hidden={!matchesSearch(...rows.windowControls)}>
            <SettingToggle checked={settingsStore.showWindowControls} onchange={() => settingsStore.toggleWindowControls()} />
          </SettingRow>

          {#if isMac}
          <SettingRow label="Integrated Title Bar"
            description="Show tabs in the title bar alongside window controls (requires restart)"
            hidden={!matchesSearch(...rows.integratedTitleBar)}>
            <SettingToggle checked={settingsStore.integratedTitleBar} onchange={() => settingsStore.update({ integratedTitleBar: !settingsStore.integratedTitleBar })} />
          </SettingRow>

          <SettingRow label="Window Vibrancy"
            description="Native macOS translucent frosted-glass effect (requires restart)"
            hidden={!matchesSearch(...rows.vibrancy)}>
            <SettingToggle checked={settingsStore.macOsVibrancy} onchange={() => settingsStore.update({ macOsVibrancy: !settingsStore.macOsVibrancy })} />
          </SettingRow>

          {#if settingsStore.macOsVibrancy}
          <SettingRow label="Native Blur"
            description="Use macOS frosted glass blur (off = theme background, requires restart)"
            hidden={!matchesSearch(...rows.nativeBlur)}>
            <SettingToggle checked={settingsStore.vibrancyBlur} onchange={() => settingsStore.update({ vibrancyBlur: !settingsStore.vibrancyBlur })} />
          </SettingRow>
          {/if}
          {/if}

          {#if isWindows}
          <SettingRow label="Window Backdrop"
            description="Translucent frosted-glass effect (enabling from Off requires restart)"
            hidden={!matchesSearch(...rows.windowsBackdrop)}>
            <select
              class="settings-select"
              value={settingsStore.windowsBackdrop}
              onchange={(e) => settingsStore.setWindowsBackdrop(e.currentTarget.value as WindowsBackdrop)}
            >
              <option value="off">Off</option>
              <option value="mica">Mica (wallpaper tint)</option>
              <option value="acrylic">Acrylic (see-through)</option>
            </select>
          </SettingRow>

          {#if settingsStore.windowsBackdrop === "acrylic"}
          <SettingRow label="Backdrop Opacity"
            description="How see-through the Acrylic backdrop is ({settingsStore.windowsBackdropOpacity}%, lower = more transparent)"
            hidden={!matchesSearch(...rows.windowsBackdropOpacity)}>
            <input
              class="range-input"
              type="range"
              min="0"
              max="100"
              step="5"
              value={settingsStore.windowsBackdropOpacity}
              oninput={(e) => settingsStore.update({ windowsBackdropOpacity: Number(e.currentTarget.value) })}
            />
          </SettingRow>
          {/if}
          {/if}

          <SettingRow label="Premium Theme Effects"
            description="Aurora-style surface treatment: accent-tinted hairlines, soft glow shadows, breadcrumb pills, translucent panels and a subtle depth backdrop. Off = flatter, higher-contrast look"
            hidden={!matchesSearch(...rows.premiumTheme)}>
            <SettingToggle checked={settingsStore.premiumTheme} onchange={() => settingsStore.update({ premiumTheme: !settingsStore.premiumTheme })} />
          </SettingRow>

          <SettingRow label="Show Address Bar"
            description="Display the breadcrumb/path bar above the file list"
            hidden={!matchesSearch(...rows.addressBar)}>
            <SettingToggle checked={settingsStore.showAddressBar} onchange={() => settingsStore.toggleAddressBar()} />
          </SettingRow>

          <SettingRow label="Show Status Bar"
            description="Display file info bar at the bottom (Alt+M U)"
            hidden={!matchesSearch(...rows.statusBar)}>
            <SettingToggle checked={settingsStore.showStatusBar} onchange={() => settingsStore.toggleStatusBar()} />
          </SettingRow>
        </section>

        <!-- Navigation Bar Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...navBarRows)}>
          <h3 class="section-title">Navigation Bar Buttons</h3>
          <SettingRow label="Back"
            description="Show the back navigation button"
            hidden={!matchesSearch(...rows.navBack)}>
            <SettingToggle checked={settingsStore.navBarButtons.back} onchange={() => settingsStore.toggleNavButton("back")} />
          </SettingRow>
          <SettingRow label="Forward"
            description="Show the forward navigation button"
            hidden={!matchesSearch(...rows.navForward)}>
            <SettingToggle checked={settingsStore.navBarButtons.forward} onchange={() => settingsStore.toggleNavButton("forward")} />
          </SettingRow>
          <SettingRow label="Up"
            description="Show the go-up-one-level button"
            hidden={!matchesSearch(...rows.navUp)}>
            <SettingToggle checked={settingsStore.navBarButtons.up} onchange={() => settingsStore.toggleNavButton("up")} />
          </SettingRow>
          <SettingRow label="Refresh"
            description="Show the refresh/reload button"
            hidden={!matchesSearch(...rows.navRefresh)}>
            <SettingToggle checked={settingsStore.navBarButtons.refresh} onchange={() => settingsStore.toggleNavButton("refresh")} />
          </SettingRow>
        </section>

        <!-- Behavior Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...behaviorRows)}>
          <h3 class="section-title">Behavior</h3>

          <SettingRow label="Show Hidden Files"
            description="Show files and folders starting with a dot (Ctrl+H)"
            hidden={!matchesSearch(...rows.showHidden)}>
            <SettingToggle checked={settingsStore.showHidden} onchange={() => settingsStore.toggleHidden()} />
          </SettingRow>

          <SettingRow label="Hide Empty Folders in Miller View"
            description="Don't show folders that have no visible entries in miller columns"
            hidden={!matchesSearch(...rows.millerHideEmpty)}>
            <SettingToggle checked={settingsStore.millerHideEmpty} onchange={() => settingsStore.toggleMillerHideEmpty()} />
          </SettingRow>

          <SettingRow label="Yazi-style Navigation"
            description="Left/right arrows navigate up/into folders in Details view (and List view when Folder Peek is off)"
            hidden={!matchesSearch(...rows.yaziNavigation)}>
            <SettingToggle checked={settingsStore.yaziNavigation} onchange={() => settingsStore.update({ yaziNavigation: !settingsStore.yaziNavigation })} />
          </SettingRow>
          <SettingRow label="Folder Peek"
            description="Expand folders in place with a caret; List view flows into columns that scroll sideways. Off restores the classic views"
            hidden={!matchesSearch(...rows.folderPeek)}>
            <SettingToggle
              class="folder-peek-toggle"
              checked={settingsStore.folderPeek}
              onchange={() => settingsStore.update({ folderPeek: !settingsStore.folderPeek })}
            />
          </SettingRow>

          <SettingRow label="Show Folder Peek Carets"
            description="Show expand carets beside folders in Details and List. Off: a single click on a folder expands or collapses it"
            hidden={!matchesSearch(...rows.folderPeekCarets)}>
            <SettingToggle
              class="folder-peek-carets-toggle"
              checked={settingsStore.folderPeekCarets}
              onchange={() => settingsStore.update({ folderPeekCarets: !settingsStore.folderPeekCarets })}
            />
          </SettingRow>

          <SettingRow label="Auto-Enter Single Subfolder"
            description="When a folder contains only one subfolder (and nothing else), descend into it automatically"
            hidden={!matchesSearch(...rows.autoEnterSingleSubdir)}>
            <SettingToggle checked={settingsStore.autoEnterSingleSubdir} onchange={() => settingsStore.update({ autoEnterSingleSubdir: !settingsStore.autoEnterSingleSubdir })} />
          </SettingRow>

          <SettingRow label="Git Repo Root in Tab Title"
            description="When the folder is inside a git repository, show the repo's root folder name in the tab title"
            hidden={!matchesSearch(...rows.tabTitleGitRoot)}>
            <SettingToggle checked={settingsStore.tabTitleGitRoot} onchange={() => settingsStore.update({ tabTitleGitRoot: !settingsStore.tabTitleGitRoot })} />
          </SettingRow>

          <SettingRow label="New Pane Layout"
            description="How the New Pane command places panes: dwindle splits along the longer axis (Hyprland-style), or always right/down"
            hidden={!matchesSearch(...rows.defaultPaneLayout)}>
            <select
              class="settings-select"
              value={settingsStore.defaultPaneLayout}
              onchange={(e) => settingsStore.setDefaultPaneLayout(e.currentTarget.value as PaneLayoutMode)}
            >
              <option value="dwindle">Dwindle</option>
              <option value="right">Split Right</option>
              <option value="down">Split Down</option>
            </select>
          </SettingRow>

          <SettingRow label="Pre-warm New Windows"
            description="Keep a hidden window ready so opening a new window (Ctrl+N) is near-instant. Uses extra memory for one background window. The first new window after enabling still opens cold."
            hidden={!matchesSearch(...rows.warmWindow)}>
            <SettingToggle
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
          </SettingRow>

          <SettingRow label="Show Manually Hidden Items"
            description="Reveal items hidden via the right-click Hide action (shown dimmed)"
            hidden={!matchesSearch(...rows.showManuallyHidden)}>
            <SettingToggle checked={settingsStore.showManuallyHidden} onchange={() => settingsStore.toggleShowManuallyHidden()} />
          </SettingRow>

          <SettingRow label="Git Status Indicators"
            description="Show modified/untracked indicators for files in git repositories"
            hidden={!matchesSearch(...rows.gitStatus)}>
            <SettingToggle checked={settingsStore.showGitStatus} onchange={() => settingsStore.toggleGitStatus()} />
          </SettingRow>

          <SettingRow label="F5 Syncs Local Branches"
            description="In the git graph, F5 also fetches and fast-forwards any local branch strictly behind its upstream. Diverged branches are reported in a toast, never touched."
            hidden={!matchesSearch(...rows.f5SyncsLocalBranches)}>
            <SettingToggle
              data-testid="setting-f5-syncs-local-branches"
              checked={settingsStore.f5SyncsLocalBranches}
              onchange={() => settingsStore.toggleF5SyncsLocalBranches()}
            />
          </SettingRow>

          <SettingRow label="Recent Items in Sidebar"
            description="Number of recent locations to show (0 to hide)"
            hidden={!matchesSearch(...rows.recentItems)}>
            <input
              type="number"
              class="setting-number"
              min="0"
              max="20"
              value={settingsStore.recentItemsCount}
              onchange={(e) => settingsStore.setRecentItemsCount(parseInt((e.target as HTMLInputElement).value) || 0)}
            />
          </SettingRow>

          <SettingRow label="Recycle Bin in Sidebar"
            description="Show a shortcut to the system recycle bin below Bookmarks"
            hidden={!matchesSearch(...rows.recycleBin)}>
            <SettingToggle
              data-testid="setting-show-recycle-bin"
              checked={settingsStore.showRecycleBin}
              onchange={() => settingsStore.toggleRecycleBin()}
            />
          </SettingRow>

          <SettingRow label="QuickOpen Debug Scores"
            description="Show score breakdown (name, frecency, dir bonus) in Ctrl+P results"
            hidden={!matchesSearch(...rows.quickOpenDebug)}>
            <SettingToggle checked={settingsStore.quickOpenDebug} onchange={() => settingsStore.toggleQuickOpenDebug()} />
          </SettingRow>

          <div class="setting-item" class:hidden={!matchesSearch(...rows.confirmDelete)}>
            <div class="setting-label">
              <span>Confirm before deleting</span>
              <span class="setting-description">Show confirmation dialog when moving files to trash</span>
            </div>
            <SettingToggle checked={settingsStore.confirmDelete} onchange={() => settingsStore.toggleConfirmDelete()} />
          </div>

          <SettingRow label="Background Opacity"
            description="Window background transparency ({settingsStore.backgroundOpacity}%)"
            hidden={!matchesSearch(...rows.backgroundOpacity)}>
            <input
              class="range-input"
              type="range"
              min="20"
              max="100"
              step="5"
              value={settingsStore.backgroundOpacity}
              oninput={(e) => settingsStore.update({ backgroundOpacity: Number(e.currentTarget.value) })}
            />
          </SettingRow>

          <SettingRow label="Background Image"
            description="Custom wallpaper path (PNG, JPG, WEBP, SVG)"
            hidden={!matchesSearch(...rows.backgroundImage)}>
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
          </SettingRow>

          {#if settingsStore.backgroundImage}
            <SettingRow label="Wallpaper Blur"
              description="Blur the background image ({settingsStore.backgroundBlur}px)"
              hidden={!matchesSearch(...rows.wallpaperBlur)}>
              <input
                class="range-input"
                type="range"
                min="0"
                max="20"
                step="1"
                value={settingsStore.backgroundBlur}
                oninput={(e) => settingsStore.update({ backgroundBlur: Number(e.currentTarget.value) })}
              />
            </SettingRow>
          {/if}

          <SettingRow label="Terminal Application"
            description="Choose an installed terminal (Auto-detect picks the first available)"
            hidden={!matchesSearch(...rows.terminalApp)}>
            <select
              class="settings-select"
              value={settingsStore.terminalApp}
              onchange={(e) => settingsStore.update({ terminalApp: e.currentTarget.value })}
            >
              <option value="">Auto-detect</option>
              {#each terminalOptions as term}
                <option value={term}>{term}</option>
              {/each}
            </select>
          </SettingRow>

          <SettingRow label="Preview Font Size"
            description="Font size for text, code and markdown previews ({settingsStore.previewFontSize}px)"
            hidden={!matchesSearch(...rows.previewFontSize)}>
            <input
              class="range-input"
              type="range"
              min="8"
              max="24"
              step="1"
              value={settingsStore.previewFontSize}
              oninput={(e) => settingsStore.setPreviewFontSize(Number(e.currentTarget.value))}
            />
          </SettingRow>

          <SettingRow label="Preview Info"
            description="Show the file name, type badge, size and modified date in the preview pane (off = content only)"
            hidden={!matchesSearch(...rows.showPreviewInfo)}>
            <SettingToggle
              data-testid="setting-show-preview-info"
              checked={settingsStore.showPreviewInfo}
              onchange={() => settingsStore.togglePreviewInfo()}
            />
          </SettingRow>

          <SettingRow label="FFmpeg Path"
            description="Path to ffmpeg for video/audio thumbnails (empty = auto-detect)"
            hidden={!matchesSearch(...rows.ffmpegPath)}>
            <input
              class="text-input"
              type="text"
              value={settingsStore.ffmpegPath}
              placeholder="e.g. C:\\ffmpeg\\bin\\ffmpeg.exe"
              onchange={(e) => settingsStore.update({ ffmpegPath: e.currentTarget.value })}
            />
          </SettingRow>
        </section>

        <!-- Terminal Section -->
        <section class="settings-section" class:hidden={!sectionVisible(...terminalRows)}>
          <h3 class="section-title">Terminal</h3>

          <SettingRow label="Terminal Follows Explorer"
            description="Auto-cd the embedded terminal when the active pane navigates (queued if a command is running)"
            hidden={!matchesSearch(...rows.terminalFollowsExplorer)}>
            <SettingToggle checked={settingsStore.terminalFollowsExplorer} onchange={() => settingsStore.toggleTerminalFollowsExplorer()} />
          </SettingRow>

          <SettingRow label="Explorer Follows Terminal"
            description="Navigate the active pane when the terminal's shell changes directory (OSC 7)"
            hidden={!matchesSearch(...rows.explorerFollowsTerminal)}>
            <SettingToggle checked={settingsStore.explorerFollowsTerminal} onchange={() => settingsStore.toggleExplorerFollowsTerminal()} />
          </SettingRow>

          <TerminalShortcutSettings {open} hidden={!matchesSearch("Terminal Shortcuts", "line editing", "readline", "home", "end", "delete word")} />
        </section>

        <!-- Experimental Section (#175): feature flags for recently shipped surfaces -->
        <section class="settings-section" class:hidden={!sectionVisible(["Experimental", "feature flags"], rows.enableTerminal, rows.enableGitGraph)}>
          <h3 class="section-title">Experimental</h3>

          <SettingRow label="Integrated Terminal"
            description="Enable the embedded terminal panel (Alt+M T)"
            hidden={!matchesSearch(...rows.enableTerminal)}>
            <SettingToggle checked={settingsStore.enableTerminal} onchange={() => settingsStore.toggleEnableTerminal()} />
          </SettingRow>

          <SettingRow label="Git Commit Graph"
            description="Show the repo's commit graph in the active pane (command palette: Git: Toggle Commit Graph, Ctrl+Alt+G)"
            hidden={!matchesSearch(...rows.enableGitGraph)}>
            <SettingToggle checked={settingsStore.enableGitGraph} onchange={() => settingsStore.toggleEnableGitGraph()} />
          </SettingRow>
        </section>

        <section class="settings-section" class:hidden={!sectionVisible(["Plugins", "install enable disable extensions packages"], ...pluginRegistry.plugins.map((p) => [p.name, p.description]), ...pluginSettingsSections.sections.map((section) => [section.title, ...section.rows.flatMap((row) => [row.label, row.description ?? ""]),...section.actions.flatMap(action=>[action.label,action.description??""])]))}>
          <h3 class="section-title">Plugins</h3>
          <button class="shortcuts-link" onclick={() => dialogStore.openPlugins()}>Open Plugins</button>
        </section>

        <!-- Navigation to the dedicated keyboard configuration surface. -->
        <section class="settings-section" class:hidden={!sectionVisible(rows.keyboardShortcuts)}>
          <h3 class="section-title">Keyboard Shortcuts</h3>
          <button class="shortcuts-link" onclick={() => dialogStore.openKeybindings()}>Open Keyboard Shortcuts</button>
        </section>
      </div>
    </div>
</Modal>

<style>
  .settings-dialog {
    width: 600px;
    max-width: calc(90vw / var(--settings-zoom, 1));
    max-height: calc(85vh / var(--settings-zoom, 1));
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    animation: modal-card-in 150ms cubic-bezier(0, 0, 0, 1);
  }

  @media (prefers-reduced-motion: reduce) { .settings-dialog { animation: none; } }

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
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .shortcuts-link {
    padding: 8px 12px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font: inherit;
    cursor: pointer;
  }

  .shortcuts-link:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
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
    transition: border-color var(--transition-fast);
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


  /* The confirm-delete row keeps its original `.setting-item` markup;
     SettingRow owns the equivalent rules for converted rows. */
  .setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 12px;
    color: var(--text-tertiary);
  }
</style>

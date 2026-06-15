<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import "@fontsource-variable/inter";
  import { onMount } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { applyWindowsBackdrop } from "$lib/state/window-backdrop";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { registerAllCommands } from "$lib/state/command-definitions";
  import { executeCommand, getCommand } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { saveFocusedWindowState } from "$lib/state/focused-window";
  import { useNativeDropHandler } from "$lib/composables/use-native-drop-handler";
  import { useFileWatchers } from "$lib/composables/use-file-watchers";
  import { useWindowLifecycle } from "$lib/composables/use-window-lifecycle";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import FilePicker, { type PickerInfo } from "$lib/components/FilePicker.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import ScmPanel from "$lib/components/ScmPanel.svelte";
  import PaneContainer from "$lib/components/PaneContainer.svelte";
  import QuickOpen from "$lib/components/QuickOpen.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import ThemePicker from "$lib/components/ThemePicker.svelte";
  import OptionPicker from "$lib/components/OptionPicker.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import ProgressDialog from "$lib/components/ProgressDialog.svelte";
  import ContentSearchDialog from "$lib/components/ContentSearchDialog.svelte";
  import WorkspaceDialog from "$lib/components/WorkspaceDialog.svelte";
  import BulkRenameDialog from "$lib/components/BulkRenameDialog.svelte";
  import ConflictDialog from "$lib/components/ConflictDialog.svelte";
  import NanoBananaDialog from "$lib/components/NanoBananaDialog.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import { initTabTransferListener } from "$lib/state/tab-transfer";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import AnimatedBackground from "$lib/components/AnimatedBackground.svelte";
  import MillerColumns from "$lib/components/MillerColumns.svelte";

  const millerAsLeftIsland = $derived(
    settingsStore.macOsVibrancy && !settingsStore.showSidebar && settingsStore.millerLayers > 0
  );
  const leftExplorer = $derived(windowTabsManager.getExplorer("left"));

  /** Convert a filesystem path to a URL usable in src/background-image. */
  function convertFileSrc(path: string): string {
    // Tauri asset protocol
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      return `asset://localhost/${encodeURIComponent(path)}`;
    }
    return `file://${path}`;
  }

  // Get active explorer from window tabs manager
  function getActiveExplorer(): ExplorerInstance | undefined {
    return windowTabsManager.getActiveExplorer();
  }

  const refreshAllPanes = () => windowTabsManager.refreshAllPanes();

  // Initialize composables
  const nativeDropHandler = useNativeDropHandler({ getActiveExplorer, refreshAllPanes });
  const fileWatchers = useFileWatchers({
    getAllExplorers: () => windowTabsManager.getAllExplorers(),
    refreshAllPanes,
  });
  const windowLifecycle = useWindowLifecycle({
    getActiveExplorer,
    saveTabs: () => windowTabsManager.save(),
  });

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isModifier = event.ctrlKey || event.metaKey;

    // Skip if focus is in an input field (except for special cases)
    const target = event.target as HTMLElement;
    const isInputField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

    // Escape closes any open modal dialog
    if (event.key === "Escape" && dialogStore.hasModalOpen) {
      event.preventDefault();
      dialogStore.closeAll();
      return;
    }

    // Skip shortcut handling (including hardcoded shortcuts below) if in an
    // input field or a modal dialog is open — e.g. Ctrl+J while typing in a
    // rename input must not open the jobs panel.
    if (isInputField || dialogStore.hasModalOpen) {
      return;
    }

    // Ctrl+J: Open jobs panel (hardcoded)
    if (event.key === "j" && isModifier) {
      event.preventDefault();
      dialogStore.openJobsPanel();
      return;
    }

    // Ctrl+,: Open settings (hardcoded, not customizable)
    if (event.key === "," && isModifier) {
      event.preventDefault();
      dialogStore.openSettings();
      return;
    }

    // Ctrl+\ or Ctrl+|: Toggle dual pane (hardcoded due to special key handling)
    const isBackslash = event.key === "\\" || event.key === "|" || event.code === "Backslash";
    if (isBackslash && isModifier) {
      event.preventDefault();
      windowTabsManager.toggleDualPane();
      return;
    }

    // Find matching command from keybindings store, skipping commands whose `when` guard fails.
    // This ensures that when multiple commands share a shortcut (e.g. F5 for refresh vs copy-to-other-pane),
    // the first available one is selected rather than the first registered one.
    // Chord shortcuts (e.g., "Alt+M T") return "chord:waiting" when the prefix is matched.
    const matchingCommandId = keybindingsStore.findMatchingCommand(event, (id) => {
      const cmd = getCommand(id);
      return !cmd?.when || cmd.when();
    });

    if (matchingCommandId === "chord:waiting") {
      event.preventDefault();
      return;
    }
    if (matchingCommandId) {
      event.preventDefault();
      await executeCommand(matchingCommandId);
      return;
    }
  }

  // Update localStorage whenever the active explorer's path or viewMode changes
  $effect(() => {
    const explorer = getActiveExplorer();
    if (explorer) {
      // Access reactive properties to subscribe
      const _path = explorer.currentPath;
      const _viewMode = explorer.viewMode;
      saveFocusedWindowState(_path, _viewMode);
    }
  });

  // Apply zoom level reactively
  $effect(() => {
    document.documentElement.style.zoom = `${settingsStore.zoomLevel}%`;
  });

  // Apply background opacity reactively (for window transparency)
  $effect(() => {
    const opacity = settingsStore.backgroundOpacity / 100;
    document.documentElement.style.setProperty("--bg-opacity", String(opacity));
  });

  // Apply vibrancy mode attribute. It drives the translucent "floating island"
  // CSS shared by macOS vibrancy and the Windows Mica/Acrylic backdrop — both
  // need the app background to go transparent so the native effect shows through.
  $effect(() => {
    const windowsBackdrop = settingsStore.windowsBackdrop !== "off";
    if (settingsStore.macOsVibrancy || windowsBackdrop) {
      document.documentElement.setAttribute("data-vibrancy", "");
      // No-blur is a macOS-only fallback (solid theme background); Windows
      // backdrops always blur, so never apply it there.
      if (settingsStore.macOsVibrancy && !settingsStore.vibrancyBlur) {
        document.documentElement.setAttribute("data-vibrancy-no-blur", "");
      } else {
        document.documentElement.removeAttribute("data-vibrancy-no-blur");
      }
    } else {
      document.documentElement.removeAttribute("data-vibrancy");
      document.documentElement.removeAttribute("data-vibrancy-no-blur");
    }
  });

  // Windows Mica/Acrylic: apply the native backdrop with a theme-matched tint
  // at runtime so changing material, opacity, or theme updates the live window
  // (the tint controls how see-through Acrylic is). Re-runs when any of those
  // reactive inputs change; theme is read so the tint follows the palette.
  $effect(() => {
    void settingsStore.windowsBackdrop;
    void settingsStore.windowsBackdropOpacity;
    void settingsStore.theme;
    applyWindowsBackdrop();
  });

  // Lightweight file-picker mode (portal windows): ?picker=open|save.
  // Rendered instead of the full app — see FilePicker.svelte / portal.rs.
  const pickerInfo: PickerInfo | null = (() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("picker");
    if (mode !== "open" && mode !== "save") return null;
    return {
      mode,
      token: params.get("token") ?? "",
      multiple: params.get("multiple") === "1",
      directory: params.get("directory") === "1",
      folder: params.get("folder"),
      name: params.get("name") ?? "",
      title: params.get("title") ?? "",
    };
  })();

  onMount(() => {
    // Initialize theme from saved preference
    themeStore.initTheme();

    // Picker windows skip the full app init (tabs, watchers, commands).
    if (pickerInfo) {
      settingsStore.init().then(() => themeStore.syncFromSettings());
      return;
    }

    // Read launch data injected by Rust initialization_script (synchronous, no IPC).
    // Falls back to IPC for child windows or if injection is missing.
    const launchData = (window as any).__LAUNCH_DATA__ as
      | { cwd: string; home: string }
      | undefined;

    const searchParams = new URLSearchParams(window.location.search);
    const urlPath = searchParams.get("path");
    const urlViewMode = searchParams.get("viewMode") as import("$lib/state/types").ViewMode | null;

    const homePath = launchData?.home ?? "/home";
    const launchCwd = launchData?.cwd ?? null;

    // Child windows (spawned via Ctrl+N) have a ?path= param — skip
    // saved-state restoration so they open at the parent's path.
    const isChildWindow = !!urlPath;
    const defaultPath = urlPath || launchCwd || homePath;

    // If launched from a terminal with a meaningful cwd, pass it as an
    // override so the active pane navigates here directly instead of
    // racing two concurrent navigateTo calls.
    const isGenericCwd = !launchCwd || launchCwd === homePath || launchCwd === "/";
    const overridePath = (!isChildWindow && !isGenericCwd) ? launchCwd! : undefined;
    const tab = windowTabsManager.init(defaultPath, isChildWindow, overridePath);
    // Apply inherited view mode from parent window
    if (urlViewMode && tab) {
      const explorer = windowTabsManager.getActiveExplorer();
      explorer?.setViewMode(urlViewMode);
    }

    // Load settings and bookmarks from config files (async, non-blocking)
    settingsStore.init().then(() => themeStore.syncFromSettings());
    bookmarksStore.init();
    folderViewsStore.init();
    manualHiddenStore.init();

    // Initialize git status watcher so file badges update on changes
    gitStatusStore.initWatcherListener();

    // Cross-window tab moves: remove our copy when another window claims a
    // tab dragged out of this one.
    const stopTabTransfer = initTabTransferListener();

    // Dev-only e2e hooks: the tauri-driver suite runs against the vite dev
    // server under Xvfb with no window manager, where autofocused inline
    // inputs (address bar, new-folder, rename) blur — and cancel — the
    // instant they open. These hooks drive the SAME real backend operations
    // (navigate / create_directory / rename_entry / trash) the UI flows do,
    // just without the headless-only focus race. Absent from production.
    if (import.meta.env.DEV) {
      window.addEventListener("e2e-navigate", ((e: CustomEvent<string>) => {
        windowTabsManager.getActiveExplorer()?.navigateTo(e.detail);
      }) as EventListener);

      window.addEventListener("e2e-file-op", ((
        e: CustomEvent<{ op: string; name?: string; path?: string }>,
      ) => {
        const explorer = windowTabsManager.getActiveExplorer();
        if (!explorer) return;
        const { op, name, path } = e.detail;
        const entry = path
          ? explorer.displayEntries.find((en) => en.path === path)
          : undefined;
        if (op === "new-folder" && name) {
          void explorer.createFolder(name);
        } else if (op === "rename" && entry && name) {
          explorer.startRename(entry);
          void explorer.rename(name);
        } else if (op === "delete" && entry) {
          void explorer.confirmDelete([entry]);
        }
      }) as EventListener);
    }

    // Register all commands for the command palette (deferred to next tick)
    queueMicrotask(() => registerAllCommands());

    // Setup composables
    nativeDropHandler.setup();
    fileWatchers.setup();
    windowLifecycle.setup();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    return () => {
      window.removeEventListener("keydown", handleKeydown);
      nativeDropHandler.cleanup();
      fileWatchers.cleanup();
      windowLifecycle.cleanup();
      stopTabTransfer();
    };
  });
</script>

<!-- Theme background layer - sits behind glassmorphism stack, targetable by themes via --theme-background-image -->
<div
  class="theme-background-layer"
  aria-hidden="true"
  style:background-image={settingsStore.backgroundImage ? `url('${convertFileSrc(settingsStore.backgroundImage)}')` : undefined}
  style:filter={settingsStore.backgroundImage && settingsStore.backgroundBlur > 0 ? `blur(${settingsStore.backgroundBlur}px)` : undefined}
></div>
<AnimatedBackground />

{#if pickerInfo}
  <FilePicker info={pickerInfo} />
{:else}
<main class="explorer">
  <TitleBar />
  <div class="main-content" class:no-sidebar={!settingsStore.showSidebar}>
    {#if settingsStore.showSidebar}
      <Sidebar />
    {/if}
    {#if settingsStore.showGitStatus && settingsStore.showScmPanel}
      <ScmPanel />
    {/if}
    {#if millerAsLeftIsland && leftExplorer}
      <div class="miller-island">
        <MillerColumns explorer={leftExplorer} />
      </div>
    {/if}
    <PaneContainer />
    {#if settingsStore.showPreviewPane}
      {#await import("$lib/components/PreviewPane.svelte") then { default: PreviewPane }}
        <div class="preview-island">
          <PreviewPane />
        </div>
      {/await}
    {/if}
  </div>
  {#if settingsStore.showStatusBar}
    <StatusBar />
  {/if}
</main>

<QuickOpen open={dialogStore.isQuickOpenOpen} onClose={() => dialogStore.closeQuickOpen()} />
<CommandPalette open={dialogStore.isCommandPaletteOpen} onClose={() => dialogStore.closeCommandPalette()} />
<ThemePicker open={dialogStore.isThemePickerOpen} onClose={() => dialogStore.closeThemePicker()} />
<OptionPicker />
<ContentSearchDialog open={dialogStore.isContentSearchOpen} onClose={() => dialogStore.closeContentSearch()} />
<SettingsDialog open={dialogStore.isSettingsOpen} onClose={() => dialogStore.closeSettings()} />
<WorkspaceDialog open={dialogStore.isWorkspaceOpen} onClose={() => dialogStore.closeWorkspace()} />
<BulkRenameDialog
  open={dialogStore.isBulkRenameOpen}
  entries={dialogStore.bulkRenameEntries}
  onClose={() => dialogStore.closeBulkRename()}
  onComplete={() => refreshAllPanes()}
/>
<NanoBananaDialog
  open={dialogStore.isNanoBananaOpen}
  sourcePath={dialogStore.nanoBananaSourcePath}
  onClose={() => dialogStore.closeNanoBanana()}
/>
<JobsPanel
  open={dialogStore.isJobsPanelOpen}
  onClose={() => dialogStore.closeJobsPanel()}
/>
<ProgressDialog />
<ConflictDialog />
{/if}

<style>
  /* Windows 11 Fluent Design System */
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  :global(button) {
    appearance: none;
    -webkit-appearance: none;
  }

  @font-face {
    font-family: "NerdFontsSymbols";
    src: url("/fonts/SymbolsNerdFont-Regular.ttf") format("truetype");
    font-weight: normal;
    font-style: normal;
    font-display: swap;
  }

  :global(.nf-icon) {
    font-family: "NerdFontsSymbols", monospace;
    font-style: normal;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(:root) {
    /* Typography */
    --font-family: "Inter Variable", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", "Cantarell", "Noto Sans", sans-serif;
    --font-size-caption: 11px;
    --font-size-body: 14px;
    --font-size-subtitle: 16px;
    --font-size-title: 20px;
    --font-weight-normal: 400;
    --font-weight-medium: 500;
    --font-weight-semibold: 600;
    --font-weight-bold: 700;
    --letter-spacing-tight: -0.01em;
    --letter-spacing-normal: 0em;
    --letter-spacing-wide: 0.04em;
    --line-height-tight: 1.2;
    --line-height-normal: 1.5;

    /* Radii */
    --radius-sm: 8px;
    --radius-md: 12px;
    --radius-lg: 16px;
    --radius-pill: 999px;
    --radius-window: 10px;

    /* Transitions */
    --transition-fast: 80ms cubic-bezier(0.25, 0.1, 0.25, 1);
    --transition-normal: 150ms cubic-bezier(0.25, 0.1, 0.25, 1);
    --transition-slow: 250ms cubic-bezier(0, 0, 0, 1);

    /* Spacing */
    --spacing-xxs: 2px;
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;

    /* Shadows */
    --shadow-subtle: 0 1px 2px rgba(0, 0, 0, 0.04);
    --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.06), 0 0 1px rgba(0, 0, 0, 0.04);

    /* Selection indicator */
    --selection-indicator-width: 3px;

    /* Z-index scale — every overlay layer uses these tokens so layers can't
       silently collide. Component-local stacking inside panes stays < 200. */
    --z-modal: 1000;          /* modal dialogs + their backdrops (Modal.svelte) */
    --z-modal-popover: 1100;  /* dropdowns that must beat an open modal (pickers) */
    --z-menu: 1200;           /* context menus */
    --z-progress: 1300;       /* corner progress panel — visible above modals */
    --z-toast: 1400;          /* notifications — topmost */
  }

  /* Window frame styling for transparent decorationless window */
  :global(html) {
    background: transparent;
    border-radius: var(--radius-window);
    overflow: hidden;
  }


  :global(body) {
    font-family: var(--font-family);
    font-weight: var(--font-weight-normal);
    font-size: var(--font-size-body);
    line-height: var(--line-height-normal);
    letter-spacing: var(--letter-spacing-tight);
    color: var(--text-primary);
    /* UI chrome is not selectable by default — prevents stray text selections
       bleeding across file rows, miller columns, breadcrumbs etc. from
       shift-click, double-click, or drag interactions. Components that host
       real selectable text (inputs, contenteditable, the preview pane) opt
       back in with `user-select: text` explicitly. (#38) */
    user-select: none;
    -webkit-user-select: none;
    background: color-mix(in srgb, var(--background-mica) calc(var(--bg-opacity, 1) * 100%), transparent);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* Window frame — use inset box-shadow instead of border to avoid
       a visible colored strip at the top from border + border-radius */
    border-radius: var(--radius-window);
    border: none;
    box-shadow: inset 0 0 0 1px var(--surface-stroke);
    overflow: hidden;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
  }

  /* Re-enable text selection for genuinely textual UI surfaces (#38) */
  :global(input),
  :global(textarea),
  :global([contenteditable="true"]),
  :global(.preview-pane),
  :global(.preview-pane *) {
    user-select: text;
    -webkit-user-select: text;
  }

  /* Selection styling */
  :global(::selection) {
    background: color-mix(in srgb, var(--accent) 30%, transparent);
    color: inherit;
  }

  /* Scrollbar styling - Windows 11 style */
  :global(::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--text-tertiary);
    border: 2px solid transparent;
    border-radius: var(--radius-pill);
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--text-secondary);
    border: 2px solid transparent;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }

  /* Theme background layer: behind glassmorphism, targetable by themes */
  .theme-background-layer {
    position: fixed;
    /* Extend beyond edges to prevent blur transparency at borders */
    inset: -20px;
    z-index: -1;
    background: var(--theme-background-image, var(--theme-background-color, transparent));
    background-size: cover;
    background-position: center;
    opacity: var(--bg-opacity, 1);
    pointer-events: none;
  }

  .explorer {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: color-mix(in srgb, var(--background-mica) calc(var(--bg-opacity, 1) * 100%), transparent);
    backdrop-filter: blur(60px) saturate(125%);
    -webkit-backdrop-filter: blur(60px) saturate(125%);
  }

  /* Mica effect gradient overlay — disabled due to gradient banding artifacts */


  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }

  /* macOS native vibrancy mode: floating islands on NSVisualEffectView */
  :global([data-vibrancy]) {
    --titlebar-opacity: 0;
    --sidebar-opacity: 0;
    --statusbar-opacity: 0;
    --vibrancy-island-bg:
      linear-gradient(
        180deg,
        rgba(255, 255, 255, 0.04) 0%,
        transparent 40%,
        rgba(0, 0, 0, 0.02) 100%
      ),
      color-mix(in srgb, var(--vibrancy-island-card, var(--background-card)) 98%, transparent);
    --vibrancy-island-stroke: var(--surface-stroke);
    --vibrancy-island-radius: 14px;
    --vibrancy-island-glow:
      inset 0 0.5px 0 rgba(255, 255, 255, 0.09),
      inset 0 -0.5px 0 rgba(0, 0, 0, 0.2),
      0 1px 3px rgba(0, 0, 0, 0.15),
      0 4px 12px rgba(0, 0, 0, 0.2),
      0 12px 32px rgba(0, 0, 0, 0.15);
  }

  :global([data-vibrancy]) :global(body) {
    background: transparent;
    box-shadow: none;
  }

  :global([data-vibrancy]) .explorer {
    background: var(--vibrancy-tint, transparent);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }

  /* No-blur mode: use theme background instead of transparency */
  :global([data-vibrancy-no-blur]) :global(body) {
    background: var(--background-solid);
    box-shadow: none;
  }

  :global([data-vibrancy-no-blur]) .explorer {
    background: var(--background-mica);
  }

  :global([data-vibrancy]) .main-content {
    padding: 0 6px 6px 6px;
    gap: 8px;
  }

  /* Miller columns as left island (when sidebar hidden + vibrancy) */
  .miller-island {
    flex-shrink: 0;
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    box-shadow: var(--vibrancy-island-glow);
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  /* Preview pane as right island (vibrancy mode) */
  .preview-island {
    flex-shrink: 0;
    display: flex;
    min-height: 0;
  }

  :global([data-vibrancy]) .preview-island {
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    box-shadow: var(--vibrancy-island-glow);
    border: 1px solid var(--vibrancy-island-stroke);
    overflow: hidden;
  }

  :global([data-vibrancy]) .theme-background-layer {
    display: none;
  }
</style>

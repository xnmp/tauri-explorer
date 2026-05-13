<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import "@fontsource-variable/inter";
  import { onMount } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { folderViewsStore } from "$lib/state/folder-views.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { setPaneNavigationContext } from "$lib/state/pane-context";
  import { registerAllCommands } from "$lib/state/command-definitions";
  import { executeCommand, getCommand } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";
  import { resolveDropTarget, highlightTarget, clearHighlights } from "$lib/composables/use-native-drop-target.svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { handleFileDrop } from "$lib/state/drop-operations";
  import { isMac, isCopyModifier as isCopyMod } from "$lib/domain/platform";
  import { bookmarksStore } from "$lib/state/bookmarks.svelte";
  import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";
  import { copyEntry, moveEntry } from "$lib/api/files";
  import { listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { initFileChangeListener, cleanupFileChangeListener, broadcastFileChange } from "$lib/state/file-events";
  import { requestRefresh, cancelPendingRefreshes } from "$lib/state/refresh-manager";
  import { parentDir, basename } from "$lib/domain/path";
  import { saveFocusedWindowState } from "$lib/state/focused-window";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import ScmPanel from "$lib/components/ScmPanel.svelte";
  import PaneContainer from "$lib/components/PaneContainer.svelte";
  import QuickOpen from "$lib/components/QuickOpen.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import ThemePicker from "$lib/components/ThemePicker.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import ProgressDialog from "$lib/components/ProgressDialog.svelte";
  import ContentSearchDialog from "$lib/components/ContentSearchDialog.svelte";
  import WorkspaceDialog from "$lib/components/WorkspaceDialog.svelte";
  import BulkRenameDialog from "$lib/components/BulkRenameDialog.svelte";
  import ConflictDialog from "$lib/components/ConflictDialog.svelte";
  import NanoBananaDialog from "$lib/components/NanoBananaDialog.svelte";
  import JobsPanel from "$lib/components/JobsPanel.svelte";
  import { jobsStore } from "$lib/state/jobs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { gitStatusStore } from "$lib/state/git-status.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import AnimatedBackground from "$lib/components/AnimatedBackground.svelte";

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

  function navigateTo(path: string) {
    getActiveExplorer()?.navigateTo(path);
  }

  function refreshAllPanes() {
    // Refresh both panes in active tab (silent — triggered by file operations, not user action)
    for (const paneId of ["left", "right"] as const) {
      windowTabsManager.getExplorer(paneId)?.refresh({ silent: true });
    }
  }

  setPaneNavigationContext({
    navigateTo,
    getActiveExplorer: getActiveExplorer as () => ExplorerInstance,
    refreshAllPanes,
  });

  // Track copy-modifier key state for external drop detection.
  // Tauri's onDragDropEvent doesn't include keyboard modifiers,
  // so we track them globally via keydown/keyup.
  // macOS uses Option (Alt) for copy-on-drag; other platforms use Ctrl.
  let copyModifierHeld = false;

  // Handle drops via Tauri's onDragDropEvent (external drops from Finder,
  // cross-window Cmd+drag). Position-based target detection via elementFromPoint.
  async function handleNativeDrop(paths: string[], position: { x: number; y: number }): Promise<void> {
    clearHighlights();

    const explorer = getActiveExplorer();
    if (!explorer) return;

    const target = resolveDropTarget(position);
    const isCopy = copyModifierHeld;

    // Validate internal drag: dragState must exist AND the native drop paths must
    // match the internal source (native drag carries the same paths we passed to startDrag).
    // If paths differ, it's an external drop with stale dragState — ignore the state.
    const internalPaths = dragState.current?.paths
      ? dragState.current.paths
      : dragState.current?.path
        ? [dragState.current.path]
        : null;
    const isInternalDrag = internalPaths !== null &&
      paths.length > 0 &&
      internalPaths.includes(paths[0]);

    // Sidebar bookmark drop
    if (target?.type === "sidebar") {
      const sourcePaths = isInternalDrag ? internalPaths! : paths;
      for (const p of sourcePaths) {
        bookmarksStore.addBookmark(p);
      }
      dragState.clear();
      return;
    }

    // Determine source paths (validated internal drag state or external paths)
    const sourcePaths = isInternalDrag ? internalPaths! : paths;

    // Drop onto a specific folder
    if (target?.type === "folder") {
      for (const sourcePath of sourcePaths) {
        if (sourcePath === target.path) continue;
        if (target.path.startsWith(sourcePath + "/")) continue;
        await handleFileDrop(sourcePath, target.path, isCopy, {
          onRefresh: refreshAllPanes,
        });
      }
      dragState.clear();
      return;
    }

    // Background drop — move/copy to the target pane's directory
    const destDir = target?.path || explorer.currentPath;
    const operation = isCopy ? copyEntry : moveEntry;
    const opName = isCopy ? "copy" : "move";
    const affectedDirs = new Set<string>();
    affectedDirs.add(destDir);

    for (const path of sourcePaths) {
      const sourceDir = parentDir(path);
      if (sourceDir === destDir) continue;
      affectedDirs.add(sourceDir);
      const result = await operation(path, destDir);
      if (!result.ok) {
        console.error(`Failed to ${opName} dropped file:`, result.error);
      }
    }

    dragState.clear();
    refreshAllPanes();
    broadcastFileChange([...affectedDirs]);
  }

  const externalDrop = useExternalDrop({
    onDrop: handleNativeDrop,
    onOver: highlightTarget,
    onLeave: clearHighlights,
  });

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isModifier = event.ctrlKey || event.metaKey;

    // Skip if focus is in an input field (except for special cases)
    const target = event.target as HTMLElement;
    const isInputField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

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

    // Escape closes any open modal dialog
    if (event.key === "Escape" && dialogStore.hasModalOpen) {
      event.preventDefault();
      dialogStore.closeAll();
      return;
    }

    // Skip dynamic shortcut handling if in input field or a modal dialog is open
    if (isInputField || dialogStore.hasModalOpen) {
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

  // Persist the focused window's state (path + viewMode) to localStorage
  // so new windows (Ctrl+N) inherit from the last focused window.
  function persistFocusedState() {
    const explorer = getActiveExplorer();
    if (explorer) {
      saveFocusedWindowState(explorer.currentPath, explorer.viewMode);
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

  onMount(() => {
    const t0 = performance.now();
    performance.mark("app-mount-start");

    // Initialize theme from saved preference
    themeStore.initTheme();

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
    // override so the active pane navigates there directly instead of
    // racing two concurrent navigateTo calls.
    const isGenericCwd = !launchCwd || launchCwd === homePath || launchCwd === "/";
    const overridePath = (!isChildWindow && !isGenericCwd) ? launchCwd! : undefined;
    const tab = windowTabsManager.init(defaultPath, isChildWindow, overridePath);
    // Apply inherited view mode from parent window
    if (urlViewMode && tab) {
      const explorer = windowTabsManager.getActiveExplorer();
      explorer?.setViewMode(urlViewMode);
    }
    performance.mark("app-first-dir");

    const tEnd = performance.now();
    console.log(`[Perf] Frontend mount→dir: ${(tEnd - t0).toFixed(1)}ms`);

    // Load settings and bookmarks from config files (async, non-blocking)
    settingsStore.init().then(() => themeStore.syncFromSettings());
    bookmarksStore.init();
    folderViewsStore.init();
    manualHiddenStore.init();

    // Initialize git status watcher so file badges update on changes
    gitStatusStore.initWatcherListener();

    // Register all commands for the command palette (deferred to next tick)
    queueMicrotask(() => registerAllCommands());

    // Setup external file drop handling
    externalDrop.setup();

    // Listen for file changes from other windows. Refresh every explorer
    // (including inactive tabs) whose current path is in affectedDirs so
    // the source tab sees the change without needing to be activated.
    initFileChangeListener((affectedDirs) => {
      for (const exp of windowTabsManager.getAllExplorers()) {
        if (affectedDirs.includes(exp.currentPath)) {
          requestRefresh((opts) => exp.refresh(opts), exp.currentPath);
        }
      }
    });

    // Listen for Nano Banana completion/error events
    let unlistenNbComplete: UnlistenFn | undefined;
    let unlistenNbError: UnlistenFn | undefined;
    listen<{ jobId: number; outputPath: string }>("nano-banana-complete", (event) => {
      const { jobId, outputPath } = event.payload;
      jobsStore.completeJob(jobId, outputPath);
      const fileName = basename(outputPath);
      toastStore.show(`Nano Banana complete: ${fileName}`, "success");
      refreshAllPanes();
    }).then((fn) => { unlistenNbComplete = fn; });
    listen<{ jobId: number; error: string }>("nano-banana-error", (event) => {
      const { jobId, error } = event.payload;
      jobsStore.failJob(jobId, error);
      toastStore.error(`Nano Banana failed: ${error.slice(0, 100)}`);
    }).then((fn) => { unlistenNbError = fn; });

    // Listen for filesystem watcher events from backend (auto-refresh)
    let unlistenWatcher: UnlistenFn | undefined;
    listen<{ path: string }>("directory-changed", (event) => {
      const changedPath = event.payload.path;
      for (const exp of windowTabsManager.getAllExplorers()) {
        if (exp.currentPath === changedPath) {
          requestRefresh((opts) => exp.refresh(opts), exp.currentPath);
        }
      }
      // Also refresh git status badges for the changed directory
      if (settingsStore.showGitStatus && gitStatusStore.currentPath === changedPath) {
        gitStatusStore.refresh();
      }
    }).then((fn) => { unlistenWatcher = fn; });

    // Persist focused window state when this window gains focus
    window.addEventListener("focus", persistFocusedState);

    // Track copy-modifier key for external drop detection (Option on Mac, Ctrl elsewhere)
    function trackCtrlDown(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
    function trackCtrlUp(e: KeyboardEvent) { copyModifierHeld = isCopyMod(e); }
    window.addEventListener("keydown", trackCtrlDown, true);
    window.addEventListener("keyup", trackCtrlUp, true);

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    // Prevent the browser's native context menu globally.
    // The app provides its own context menu via ContextMenu.svelte.
    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    window.addEventListener("contextmenu", handleContextMenu);

    // Guard against the webview navigating to dropped files. Even with
    // Tauri's native drag-drop handler enabled, a dragover/drop that bubbles
    // up to the document without preventDefault will let WebKitGTK (and
    // Chromium) navigate to the file:// URL, replacing the app with an image
    // or PDF viewer. `capture: true` ensures the guard runs before any
    // app-level handlers can opt out.
    function blockWebviewDefaultDnD(event: DragEvent) {
      event.preventDefault();
    }
    window.addEventListener("dragover", blockWebviewDefaultDnD, { capture: true });
    window.addEventListener("drop", blockWebviewDefaultDnD, { capture: true });

    // Save tabs before window closes
    function handleBeforeUnload() {
      windowTabsManager.save();
    }
    window.addEventListener("beforeunload", handleBeforeUnload);

    // Save tabs periodically (every 30 seconds) to catch navigation changes
    const saveInterval = setInterval(() => {
      windowTabsManager.save();
    }, 30000);

    return () => {
      window.removeEventListener("focus", persistFocusedState);
      window.removeEventListener("keydown", trackCtrlDown, true);
      window.removeEventListener("keyup", trackCtrlUp, true);
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("dragover", blockWebviewDefaultDnD, { capture: true });
      window.removeEventListener("drop", blockWebviewDefaultDnD, { capture: true });
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearInterval(saveInterval);
      externalDrop.cleanup();
      cancelPendingRefreshes();
      cleanupFileChangeListener();
      unlistenWatcher?.();
      unlistenNbComplete?.();
      unlistenNbError?.();
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

<main class="explorer">
  <TitleBar />
  <div class="main-content">
    {#if settingsStore.showSidebar}
      <Sidebar />
    {/if}
    {#if settingsStore.showGitStatus && settingsStore.showScmPanel}
      <ScmPanel />
    {/if}
    <PaneContainer />
  </div>
  {#if settingsStore.showStatusBar}
    <StatusBar />
  {/if}
</main>

<QuickOpen open={dialogStore.isQuickOpenOpen} onClose={() => dialogStore.closeQuickOpen()} />
<CommandPalette open={dialogStore.isCommandPaletteOpen} onClose={() => dialogStore.closeCommandPalette()} />
<ThemePicker open={dialogStore.isThemePickerOpen} onClose={() => dialogStore.closeThemePicker()} />
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
</style>

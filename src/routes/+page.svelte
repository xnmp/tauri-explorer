<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { setPaneNavigationContext } from "$lib/state/pane-context";
  import { registerAllCommands } from "$lib/state/command-definitions";
  import { executeCommand, getCommand } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { useExternalDrop } from "$lib/composables/use-external-drop.svelte";
  import { copyEntry, getHomeDirectory } from "$lib/api/files";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import SharedToolbar from "$lib/components/SharedToolbar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PaneContainer from "$lib/components/PaneContainer.svelte";
  import QuickOpen from "$lib/components/QuickOpen.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import ProgressDialog from "$lib/components/ProgressDialog.svelte";
  import ContentSearchDialog from "$lib/components/ContentSearchDialog.svelte";
  import WorkspaceDialog from "$lib/components/WorkspaceDialog.svelte";
  import BulkRenameDialog from "$lib/components/BulkRenameDialog.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";

  // Get active explorer from window tabs manager
  function getActiveExplorer(): ExplorerInstance | undefined {
    return windowTabsManager.getActiveExplorer();
  }

  function navigateTo(path: string) {
    getActiveExplorer()?.navigateTo(path);
  }

  function refreshAllPanes() {
    // Refresh both panes in active tab
    for (const paneId of ["left", "right"] as const) {
      windowTabsManager.getExplorer(paneId)?.refresh();
    }
  }

  setPaneNavigationContext({
    navigateTo,
    getActiveExplorer: getActiveExplorer as () => ExplorerInstance,
    refreshAllPanes,
  });

  // Handle external file drops into the app
  async function handleExternalDrop(paths: string[]): Promise<void> {
    const explorer = getActiveExplorer();
    if (!explorer) return;

    const destDir = explorer.currentPath;

    for (const path of paths) {
      const result = await copyEntry(path, destDir);
      if (!result.ok) {
        console.error("Failed to copy dropped file:", result.error);
      }
    }

    // Refresh to show newly copied files
    refreshAllPanes();
  }

  const externalDrop = useExternalDrop((paths) => {
    handleExternalDrop(paths);
  });

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isModifier = event.ctrlKey || event.metaKey;

    // Skip if focus is in an input field (except for special cases)
    const target = event.target as HTMLElement;
    const isInputField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

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

    // Skip dynamic shortcut handling if in input field
    if (isInputField) {
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
    performance.mark("app-mount-start");

    // Initialize theme from saved preference
    themeStore.initTheme();

    // Initialize window tabs with directory from query param or home
    (async () => {
      const urlPath = new URLSearchParams(window.location.search).get("path");
      const homeResult = await getHomeDirectory();
      const homePath = homeResult.ok ? homeResult.data : "/home";
      windowTabsManager.init(urlPath || homePath);
      performance.mark("app-first-dir");
      if (import.meta.env.DEV) {
        performance.measure("startup-to-first-dir", "app-mount-start", "app-first-dir");
        const m = performance.getEntriesByName("startup-to-first-dir")[0];
        console.log(`[Perf] Startup to first directory: ${m.duration.toFixed(0)}ms`);
      }
    })();

    // Register all commands for the command palette (deferred to next tick)
    queueMicrotask(() => registerAllCommands());

    // Setup external file drop handling
    externalDrop.setup();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    // Prevent the browser's native context menu globally.
    // The app provides its own context menu via ContextMenu.svelte.
    function handleContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    window.addEventListener("contextmenu", handleContextMenu);

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
      window.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearInterval(saveInterval);
      externalDrop.cleanup();
    };
  });
</script>

<main class="explorer" class:no-titlebar={windowTabsManager.tabs.length <= 1}>
  <TitleBar />
  {#if settingsStore.showToolbar}
    <SharedToolbar />
  {/if}
  <div class="main-content">
    {#if settingsStore.showSidebar}
      <Sidebar />
    {/if}
    <PaneContainer />
  </div>
  {#if settingsStore.showStatusBar}
    <StatusBar />
  {/if}
</main>

<QuickOpen open={dialogStore.isQuickOpenOpen} onClose={() => dialogStore.closeQuickOpen()} />
<CommandPalette open={dialogStore.isCommandPaletteOpen} onClose={() => dialogStore.closeCommandPalette()} />
<ContentSearchDialog open={dialogStore.isContentSearchOpen} onClose={() => dialogStore.closeContentSearch()} />
<SettingsDialog open={dialogStore.isSettingsOpen} onClose={() => dialogStore.closeSettings()} />
<WorkspaceDialog open={dialogStore.isWorkspaceOpen} onClose={() => dialogStore.closeWorkspace()} />
<BulkRenameDialog
  open={dialogStore.isBulkRenameOpen}
  entries={dialogStore.bulkRenameEntries}
  onClose={() => dialogStore.closeBulkRename()}
  onComplete={() => refreshAllPanes()}
/>
<ProgressDialog />

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

  :global(:root) {
    /* Typography */
    --font-family: "Segoe UI Variable", "Segoe UI", system-ui, -apple-system, sans-serif;
    --font-size-caption: 12px;
    --font-size-body: 14px;
    --font-size-subtitle: 16px;
    --font-size-title: 20px;

    /* Radii */
    --radius-sm: 4px;
    --radius-md: 8px;
    --radius-lg: 12px;
    --radius-window: 8px;

    /* Transitions */
    --transition-fast: 67ms cubic-bezier(0, 0, 0, 1);
    --transition-normal: 167ms cubic-bezier(0, 0, 0, 1);
    --transition-slow: 250ms cubic-bezier(0, 0, 0, 1);

    /* Spacing */
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 12px;
    --spacing-lg: 16px;
    --spacing-xl: 24px;
  }

  /* Window frame styling for transparent decorationless window */
  :global(html) {
    background: transparent;
    border-radius: var(--radius-window);
    overflow: hidden;
  }


  :global(body) {
    font-family: var(--font-family);
    font-size: var(--font-size-body);
    line-height: 1.43;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--background-solid) calc(var(--bg-opacity, 1) * 100%), transparent);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    /* Window frame with border for transparent window */
    border-radius: var(--radius-window);
    border: 1px solid var(--surface-stroke);
    overflow: hidden;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    margin: 0;
  }

  /* Selection styling */
  :global(::selection) {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  /* Scrollbar styling - Windows 11 style */
  :global(::-webkit-scrollbar) {
    width: 14px;
    height: 14px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--text-tertiary);
    border: 4px solid transparent;
    border-radius: 7px;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--text-secondary);
    border: 4px solid transparent;
    background-clip: padding-box;
  }

  :global(::-webkit-scrollbar-corner) {
    background: transparent;
  }

  .explorer {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: color-mix(in srgb, var(--background-mica) calc(var(--bg-opacity, 1) * 100%), transparent);
    backdrop-filter: blur(60px) saturate(125%);
    -webkit-backdrop-filter: blur(60px) saturate(125%);
  }

  .explorer.no-titlebar {
    padding-top: 6px;
  }

  /* Mica effect gradient overlay */
  .explorer::before {
    content: "";
    position: fixed;
    inset: 0;
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.05) 0%,
      transparent 50%
    );
    pointer-events: none;
    z-index: 0;
  }


  .main-content {
    display: flex;
    flex: 1;
    overflow: hidden;
    position: relative;
    z-index: 1;
  }
</style>

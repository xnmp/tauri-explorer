<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh, tauri-explorer-1ex, tauri-explorer-auj, tauri-explorer-npjh.4
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { setPaneNavigationContext } from "$lib/state/pane-context";
  import { registerAllCommands } from "$lib/state/command-definitions";
  import { executeCommand } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
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

  // Dialog states
  let quickOpenVisible = $state(false);
  let commandPaletteVisible = $state(false);
  let settingsVisible = $state(false);
  let contentSearchVisible = $state(false);

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

    const destDir = explorer.state.currentPath;

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
      settingsVisible = true;
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

    // Find matching command from keybindings store
    const matchingCommandId = keybindingsStore.findMatchingCommand(event);
    if (matchingCommandId) {
      event.preventDefault();
      await executeCommand(matchingCommandId);
      return;
    }
  }

  onMount(() => {
    // Initialize theme from saved preference
    themeStore.initTheme();

    // Initialize window tabs with home directory (async)
    (async () => {
      const homeResult = await getHomeDirectory();
      const homePath = homeResult.ok ? homeResult.data : "/home";
      windowTabsManager.init(homePath);
    })();

    // Register all commands for the command palette
    registerAllCommands();

    // Setup external file drop handling
    externalDrop.setup();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    // Event-based dialog opening (for commands)
    function handleOpenQuickOpen() {
      quickOpenVisible = true;
    }
    function handleOpenCommandPalette() {
      commandPaletteVisible = true;
    }
    function handleOpenContentSearch() {
      contentSearchVisible = true;
    }

    window.addEventListener("open-quick-open", handleOpenQuickOpen);
    window.addEventListener("open-command-palette", handleOpenCommandPalette);
    window.addEventListener("open-content-search", handleOpenContentSearch);

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
      window.removeEventListener("open-quick-open", handleOpenQuickOpen);
      window.removeEventListener("open-command-palette", handleOpenCommandPalette);
      window.removeEventListener("open-content-search", handleOpenContentSearch);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      clearInterval(saveInterval);
      externalDrop.cleanup();
    };
  });
</script>

<main class="explorer">
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
</main>

<QuickOpen open={quickOpenVisible} onClose={() => quickOpenVisible = false} />
<CommandPalette open={commandPaletteVisible} onClose={() => commandPaletteVisible = false} />
<ContentSearchDialog open={contentSearchVisible} onClose={() => contentSearchVisible = false} />
<SettingsDialog open={settingsVisible} onClose={() => settingsVisible = false} />
<ProgressDialog />

<style>
  /* Windows 11 Fluent Design System */
  :global(*) {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
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


  :global(body) {
    font-family: var(--font-family);
    font-size: var(--font-size-body);
    line-height: 1.43;
    color: var(--text-primary);
    background: var(--background-solid);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
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
    background: var(--background-mica);
    backdrop-filter: blur(60px) saturate(125%);
    -webkit-backdrop-filter: blur(60px) saturate(125%);
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

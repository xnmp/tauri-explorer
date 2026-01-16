<!--
  Main Explorer page - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-explorer-jql, tauri-explorer-bae, tauri-explorer-h3n, tauri-explorer-w3t, tauri-explorer-npjh
-->
<script lang="ts">
  import { onMount, setContext } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { paneManager } from "$lib/state/panes.svelte";
  import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { setPaneNavigationContext } from "$lib/state/pane-context";
  import "$lib/themes/index.css";
  import TitleBar from "$lib/components/TitleBar.svelte";
  import SharedToolbar from "$lib/components/SharedToolbar.svelte";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PaneContainer from "$lib/components/PaneContainer.svelte";
  import QuickOpen from "$lib/components/QuickOpen.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";

  // Dialog states
  let quickOpenVisible = $state(false);
  let settingsVisible = $state(false);

  // Create explorer instances at the page level
  const leftExplorer = createExplorerState();
  const rightExplorer = createExplorerState();

  // Provide navigation context for all child components
  function getActiveExplorer(): ExplorerInstance {
    return paneManager.activePaneId === "left" ? leftExplorer : rightExplorer;
  }

  function navigateTo(path: string) {
    getActiveExplorer().navigateTo(path);
  }

  function refreshAllPanes() {
    leftExplorer.refresh();
    rightExplorer.refresh();
  }

  setPaneNavigationContext({
    navigateTo,
    getActiveExplorer,
    refreshAllPanes,
  });

  function handleKeydown(event: KeyboardEvent): void {
    const isModifier = event.ctrlKey || event.metaKey;

    // Ctrl+,: Open settings
    if (event.key === "," && isModifier) {
      event.preventDefault();
      settingsVisible = true;
      return;
    }

    // Ctrl+P: Quick open file search
    if (event.key === "p" && isModifier) {
      event.preventDefault();
      quickOpenVisible = true;
      return;
    }

    // Ctrl+\ or Ctrl+|: Toggle dual pane
    if ((event.key === "\\" || event.key === "|") && isModifier) {
      event.preventDefault();
      paneManager.toggleDualPane();
    }
  }

  onMount(() => {
    // Initialize theme from saved preference
    themeStore.initTheme();

    // Global keyboard shortcuts
    window.addEventListener("keydown", handleKeydown);

    return () => {
      window.removeEventListener("keydown", handleKeydown);
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
    <PaneContainer {leftExplorer} {rightExplorer} />
  </div>
</main>

<QuickOpen bind:open={quickOpenVisible} onClose={() => quickOpenVisible = false} />
<SettingsDialog bind:open={settingsVisible} onClose={() => settingsVisible = false} />

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

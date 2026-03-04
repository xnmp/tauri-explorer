<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { setContext } from "svelte";
  import { createExplorerState } from "$lib/state/explorer.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import NewFolderDialog from "./NewFolderDialog.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";

  interface Props {
    paneId: PaneId;
  }

  let { paneId }: Props = $props();

  // Get explorer from window tabs manager
  const paneExplorer = $derived(windowTabsManager.getExplorer(paneId) ?? createExplorerState());

  // Provide explorer to child components via context (reactive via $derived)
  $effect(() => {
    setContext("pane-explorer", paneExplorer);
  });
  setContext("pane-id", paneId);

  const isActive = $derived(windowTabsManager.activePaneId === paneId);
  const dualPaneEnabled = $derived(windowTabsManager.dualPaneEnabled);
  const isInactive = $derived(dualPaneEnabled && !isActive);
  const showActiveBorder = $derived(dualPaneEnabled && isActive);

  function handleFocus() {
    windowTabsManager.setActivePane(paneId);
  }

  function handleKeydown(event: KeyboardEvent): void {
    // Don't process keyboard shortcuts when a dialog is open
    if (dialogStore.activeDialog) return;

    // Ignore events from interactive elements (e.g. path input, rename input)
    const tag = (event.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    // Arrow key navigation in file list (not in global command system
    // because it needs current selection context and shift-key handling)
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const entries = paneExplorer.displayEntries;
      if (entries.length === 0) return;

      const selected = paneExplorer.getSelectedEntries()[0];
      const currentIndex = selected
        ? entries.findIndex((e) => e.path === selected.path)
        : -1;

      const newIndex = event.key === "ArrowUp"
        ? (currentIndex <= 0 ? entries.length - 1 : currentIndex - 1)
        : (currentIndex >= entries.length - 1 ? 0 : currentIndex + 1);

      paneExplorer.selectEntry(entries[newIndex], { ctrlKey: false, shiftKey: event.shiftKey });
    }
    // All other shortcuts (Ctrl+C/X/V/Z/A, Delete, F2, F5, F6, Enter, etc.)
    // are handled by the global keybinding system in command-definitions.ts
  }

  // Note: Tab initialization is handled at page level by windowTabsManager
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="explorer-pane"
  class:active={showActiveBorder}
  class:inactive={isInactive}
  role="region"
  aria-label="{paneId} file browser pane"
  tabindex="0"
  onfocus={handleFocus}
  onclick={handleFocus}
  onkeydown={handleKeydown}
>
  {#if paneExplorer}
    <NavigationBar explorer={paneExplorer} />
    <FileList explorer={paneExplorer} />
    <ContextMenu explorer={paneExplorer} />
    <NewFolderDialog explorer={paneExplorer} />
    <DeleteDialog explorer={paneExplorer} />
  {/if}
</section>

<style>
  .explorer-pane {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    background: var(--background-card);
    border-radius: var(--radius-md);
    border: 1px solid transparent;
    transition:
      border-color var(--transition-fast),
      box-shadow var(--transition-fast),
      opacity var(--transition-fast);
  }

  .explorer-pane:focus {
    outline: none;
  }

  /* Active border only shows in dual pane mode */
  .explorer-pane.active {
    border-color: var(--accent);
    box-shadow: 0 0 6px -2px var(--accent);
  }

  /* Inactive pane in dual pane mode */
  .explorer-pane.inactive {
    opacity: 0.75;
    border-color: var(--divider);
  }

  .explorer-pane.inactive:hover {
    opacity: 0.9;
    border-color: var(--text-tertiary);
  }
</style>

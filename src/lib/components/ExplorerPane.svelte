<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs)
-->
<script lang="ts">
  import { setContext } from "svelte";
  import { createExplorerState } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import NewFolderDialog from "./NewFolderDialog.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";

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

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    const isModifier = event.ctrlKey || event.metaKey;
    const selected = paneExplorer.getSelectedEntries()[0];

    // Alt + Arrow: Navigation
    if (event.altKey) {
      const altActions: Record<string, () => void> = {
        ArrowLeft: () => paneExplorer.goBack(),
        ArrowRight: () => paneExplorer.goForward(),
        ArrowUp: () => paneExplorer.goUp(),
      };
      const action = altActions[event.key];
      if (action) {
        event.preventDefault();
        action();
      }
      return;
    }

    // Function keys
    if (event.key === "F5") {
      event.preventDefault();
      paneExplorer.refresh();
      return;
    }

    if (event.key === "F6" || (event.key === "Tab" && !event.shiftKey && isModifier)) {
      event.preventDefault();
      windowTabsManager.switchPane();
      return;
    }

    // Modifier shortcuts (Ctrl/Cmd + key)
    if (!isModifier) return;

    // Normalize key to lowercase for consistent comparison (handles Caps Lock)
    const normalizedKey = event.key.toLowerCase();

    const modifierActions: Record<string, () => void | Promise<unknown>> = {
      a: () => paneExplorer.selectAll(),
      z: () => paneExplorer.undo(),
      c: () => { if (selected) paneExplorer.copyToClipboard(selected); },
      x: () => { if (selected) paneExplorer.cutToClipboard(selected); },
      v: () => { if (clipboardStore.hasContent) return paneExplorer.paste(); },
    };

    const action = modifierActions[normalizedKey];
    if (action) {
      event.preventDefault();
      await action();
    }
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

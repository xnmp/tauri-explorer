<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
  Issue: tauri-explorer-auj (tabs integration)
-->
<script lang="ts">
  import { setContext, onMount, getContext } from "svelte";
  import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { paneManager } from "$lib/state/panes.svelte";
  import { tabsManager } from "$lib/state/tabs.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import NewFolderDialog from "./NewFolderDialog.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";
  import TabBar from "./TabBar.svelte";

  interface Props {
    paneId: PaneId;
  }

  let { paneId }: Props = $props();

  // Get active tab's explorer from tabs manager
  const activeExplorer = $derived(tabsManager.getActiveExplorer(paneId));
  const paneExplorer = $derived(activeExplorer ?? createExplorerState());

  // Provide explorer to child components via context (reactive via $derived)
  $effect(() => {
    setContext("pane-explorer", paneExplorer);
  });
  setContext("pane-id", paneId);

  const isActive = $derived(paneManager.state.activePaneId === paneId);
  const isInactive = $derived(paneManager.dualPaneEnabled && !isActive);
  const showActiveBorder = $derived(paneManager.dualPaneEnabled && isActive);

  function handleFocus() {
    paneManager.setActivePane(paneId);
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
      paneManager.switchPane();
      return;
    }

    // Modifier shortcuts (Ctrl/Cmd + key)
    if (!isModifier) return;

    const modifierActions: Record<string, () => void | Promise<unknown>> = {
      a: () => paneExplorer.selectAll(),
      z: () => paneExplorer.undo(),
      c: () => { if (selected) paneExplorer.copyToClipboard(selected); },
      x: () => { if (selected) paneExplorer.cutToClipboard(selected); },
      v: () => { if (clipboardStore.hasContent) return paneExplorer.paste(); },
    };

    const action = modifierActions[event.key];
    if (action) {
      event.preventDefault();
      await action();
    }
  }

  onMount(async () => {
    // Initialize tabs for this pane with home directory if not already initialized
    if (tabsManager.getTabs(paneId).length === 0) {
      const result = await getHomeDirectory();
      const homePath = result.ok ? result.data : "/home";
      tabsManager.initPane(paneId, homePath);
    }
  });
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
  <TabBar {paneId} />
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

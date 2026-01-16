<!--
  ExplorerPane component - A self-contained file explorer pane
  Each pane has its own explorer state and can be used in single or dual pane layouts.
-->
<script lang="ts">
  import { setContext, onMount } from "svelte";
  import { createExplorerState, type ExplorerInstance } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
  import { paneManager } from "$lib/state/panes.svelte";
  import { getHomeDirectory } from "$lib/api/files";
  import type { PaneId } from "$lib/state/types";
  import NavigationBar from "./NavigationBar.svelte";
  import FileList from "./FileList.svelte";
  import ContextMenu from "./ContextMenu.svelte";
  import NewFolderDialog from "./NewFolderDialog.svelte";
  import DeleteDialog from "./DeleteDialog.svelte";

  interface Props {
    paneId: PaneId;
    explorerInstance?: ExplorerInstance;
  }

  let { paneId, explorerInstance }: Props = $props();

  // Create or use provided explorer instance
  const paneExplorer = explorerInstance ?? createExplorerState();

  // Provide explorer to child components via context
  setContext("pane-explorer", paneExplorer);
  setContext("pane-id", paneId);

  const isActive = $derived(paneManager.state.activePaneId === paneId);
  const isInactive = $derived(paneManager.dualPaneEnabled && !isActive);

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

    const modifierActions: Record<string, () => void | Promise<void>> = {
      z: () => paneExplorer.undo(),
      c: () => selected && paneExplorer.copyToClipboard(selected),
      x: () => selected && paneExplorer.cutToClipboard(selected),
      v: () => clipboardStore.hasContent && paneExplorer.paste(),
    };

    const action = modifierActions[event.key];
    if (action) {
      event.preventDefault();
      await action();
    }
  }

  onMount(async () => {
    // Initialize this pane with home directory
    const result = await getHomeDirectory();
    paneExplorer.navigateTo(result.ok ? result.data : "/home");
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="explorer-pane"
  class:active={isActive}
  class:inactive={isInactive}
  role="region"
  aria-label="{paneId} file browser pane"
  tabindex="0"
  onfocus={handleFocus}
  onclick={handleFocus}
  onkeydown={handleKeydown}
>
  <NavigationBar explorer={paneExplorer} />
  <FileList explorer={paneExplorer} />
  <ContextMenu explorer={paneExplorer} />
  <NewFolderDialog explorer={paneExplorer} />
  <DeleteDialog explorer={paneExplorer} />
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
    outline: 2px solid transparent;
    transition: outline-color var(--transition-fast);
  }

  .explorer-pane:focus {
    outline: none;
  }

  .explorer-pane.active {
    outline-color: var(--accent);
  }

  .explorer-pane.inactive {
    opacity: 0.6;
    filter: saturate(0.7);
  }

  .explorer-pane.inactive:hover {
    opacity: 0.8;
    filter: saturate(0.85);
  }
</style>

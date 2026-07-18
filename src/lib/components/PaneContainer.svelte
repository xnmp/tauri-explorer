<!--
  PaneContainer component - hosts the active tab's content: an explorer
  tab renders its pane layout tree (#228); a git graph tab renders the
  graph view. The tab strip itself lives in the title bar (#229).
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs), #228
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  // The git graph is no longer a tab kind — panes render it themselves
  // when their gitGraph flag is set (#272).
  const activeTab = $derived(windowTabsManager.activeTab);
  const multiPane = $derived(windowTabsManager.dualPaneEnabled);
</script>

<div class="pane-container" class:multi-pane={multiPane}>
  {#if activeTab}
    <!-- Keyed by tab so switching tabs remounts the tree cleanly (pane ids
         are unique per tab; explorer state lives in the manager). -->
    {#key activeTab.id}
      <div class="pane-tree">
        <PaneLayoutView node={activeTab.layout} />
      </div>
    {/key}
  {/if}
</div>

<style>
  .pane-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;
    gap: 0;
  }

  .pane-tree {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* Vibrancy: main content island */
  :global([data-vibrancy]) .pane-container {
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    border: 1px solid var(--vibrancy-island-stroke);
    box-shadow: var(--vibrancy-island-glow);
    backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
    -webkit-backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
    position: relative;
  }

  /* Vibrancy + split panes: each pane is its own island (see ExplorerPane),
     so the container itself paints no island chrome. */
  :global([data-vibrancy]) .pane-container.multi-pane {
    border-radius: 0;
    background: transparent;
    border: none;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
</style>

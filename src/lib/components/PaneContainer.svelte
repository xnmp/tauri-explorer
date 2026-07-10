<!--
  PaneContainer component - hosts the window tab strip and the active tab's
  content: an explorer tab renders its pane layout tree (#228); a git graph
  tab renders the graph view.
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs), #228
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import WindowTabBar from "./WindowTabBar.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";
  import GitGraphView from "./GitGraphView.svelte";

  // Per-kind content dispatch (#56): the container renders the active tab,
  // which is an explorer (pane tree) or a git graph (#51).
  const activeTab = $derived(windowTabsManager.activeTab);
  const multiPane = $derived(windowTabsManager.dualPaneEnabled);
</script>

<div class="pane-container" class:multi-pane={multiPane}>
  <WindowTabBar />
  {#if activeTab?.kind === "git-graph"}
    <!-- Keyed so switching between graphs of different repos recreates the
         view — no selected-commit/state bleed or in-flight races (#167). -->
    {#key activeTab.repoPath}
      <GitGraphView repoPath={activeTab.repoPath} />
    {/key}
  {:else if activeTab?.kind === "explorer"}
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

  /* Vibrancy: main content island — top highlight drawn via ::before with tab gap */
  :global([data-vibrancy]) .pane-container {
    border-radius: var(--vibrancy-island-radius);
    background: var(--vibrancy-island-bg);
    border: 1px solid var(--vibrancy-island-stroke);
    border-top: none;
    box-shadow: var(--vibrancy-island-glow);
    backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
    -webkit-backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
    position: relative;
  }

  :global([data-vibrancy]) .pane-container::before {
    content: "";
    position: absolute;
    top: 0;
    left: var(--vibrancy-island-radius);
    right: var(--vibrancy-island-radius);
    height: 1px;
    background: var(--vibrancy-island-stroke);
    /* The tab strip sits inside the container, so the top highlight line is
       continuous (0% gap unless something re-introduces the vars). */
    mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 0%),
      transparent var(--tab-gap-left, 0%),
      transparent var(--tab-gap-right, 0%),
      white var(--tab-gap-right, 0%),
      white 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      white 0%,
      white var(--tab-gap-left, 0%),
      transparent var(--tab-gap-left, 0%),
      transparent var(--tab-gap-right, 0%),
      white var(--tab-gap-right, 0%),
      white 100%
    );
    pointer-events: none;
  }
</style>

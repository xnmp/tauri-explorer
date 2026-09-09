<!--
  PaneContainer component - hosts the active tab's content: an explorer
  tab renders its pane layout tree (#228); a git graph tab renders the
  graph view. The tab strip itself lives in the title bar (#229).
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs), #228
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { resizeActivity } from "$lib/state/resize-activity.svelte";
  import { revealPane } from "$lib/domain/pane-viewport";
  import { usePaneDividers } from "$lib/composables/use-pane-dividers.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  // The git graph is no longer a tab kind — panes render it themselves
  // when their gitGraph flag is set (#272).
  const activeTab = $derived(windowTabsManager.activeTab);
  const multiPane = $derived(windowTabsManager.dualPaneEnabled);
  let viewport = $state<HTMLElement>();
  let width = $state(0), height = $state(0);
  const instance = $derived(windowTabsManager.activeTabInstance);
  const geometry = $derived(windowTabsManager.paneViewport.geometry);
  const dividers = usePaneDividers({ geometry: () => geometry, begin: windowTabsManager.beginSplitResize });
  $effect(() => {
    const gap = settingsStore.islandMode ? 8 : 6;
    const measuredWidth = width, measuredHeight = height;
    untrack(() => {
      dividers.cancel();
      windowTabsManager.paneViewport.measure(measuredWidth, measuredHeight, gap);
    });
  });
  $effect(() => {
    instance;
    untrack(dividers.cancel);
  });
  $effect(() => { geometry; dividers.reconcile(); });
  $effect(() => {
    if (dividers.activeId || resizeActivity.active) return;
    const pane = geometry?.panes.get(windowTabsManager.activePaneId);
    if (!viewport || !pane || width <= 0 || height <= 0) return;
    const next = revealPane({ left: viewport.scrollLeft, top: viewport.scrollTop }, { width, height }, pane,
      windowTabsManager.paneViewport.inlineWidth(windowTabsManager.activePaneId));
    viewport.scrollLeft = next.left;
    viewport.scrollTop = next.top;
  });
</script>

<svelte:window onblur={dividers.cancel} />

<div class="pane-container" class:multi-pane={multiPane}
  bind:this={viewport} bind:clientWidth={width} bind:clientHeight={height}
  onscroll={dividers.cancel}
  style:--pane-divider-size={`${geometry?.divider ?? 6}px`}>
  {#if activeTab}
    <!-- A restored tab may reuse its saved ID; its old DOM/gestures still retire. -->
    {#key windowTabsManager.activeTabInstance}
      <div class="pane-tree" style:width={geometry ? `${geometry.width}px` : "100%"}
        style:height={geometry ? `${geometry.height}px` : "100%"}>
        <PaneLayoutView node={activeTab.layout} {geometry} {dividers} />
      </div>
    {/key}
  {/if}
</div>

<style>
  .pane-container {
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    gap: 0;
  }

  .pane-tree {
    display: flex;
    flex: none;
    min-width: 0;
    min-height: 0;
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

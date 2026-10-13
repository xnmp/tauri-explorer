<!--
  PaneContainer component - hosts the active tab's content: an explorer
  tab renders its pane layout tree (#228); a git graph tab renders the
  graph view. The tab strip itself lives in the title bar (#229).
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs), #228
-->
<script lang="ts">
  import { getAbortSignal, tick, untrack } from "svelte";
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
  // Preserve fractional CSS pixels under root zoom. Integer client dimensions
  // can round the canvas past its scrollport and keep needless gutters alive.
  let contentRect = $state<DOMRectReadOnly>();
  const width = $derived(contentRect?.width ?? 0);
  const height = $derived(contentRect?.height ?? 0);
  const instance = $derived(windowTabsManager.activeTabInstance);
  const geometry = $derived(windowTabsManager.paneViewport.geometry);
  const minima = $derived(windowTabsManager.paneViewport.minima);
  const gap = $derived(settingsStore.islandMode ? 8 : 6);
  const dividers = usePaneDividers({ geometry: () => geometry, begin: windowTabsManager.beginSplitResize });
  $effect(() => {
    const divider = gap;
    const measuredWidth = width, measuredHeight = height;
    untrack(dividers.cancel);
    // Geometry feeds reveal, directional focus and divider input; the canvas
    // itself is sized by CSS, so this deferral never shows a stale frame (#1061).
    // Commit outside ResizeObserver delivery so WebKit can finish the current layout.
    const frame = requestAnimationFrame(() => {
      windowTabsManager.paneViewport.measure(measuredWidth, measuredHeight, divider);
    });
    return () => cancelAnimationFrame(frame);
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
    const element = viewport;
    const size = { width, height };
    const inset = windowTabsManager.paneViewport.inlineWidth(windowTabsManager.activePaneId);
    const signal = getAbortSignal();
    // Inline-width leases can update the geometry before the descendant DOM
    // grows. Wait for that commit or the browser clamps to the old scroll range.
    void tick().then(() => {
      if (signal.aborted) return;
      const next = revealPane({ left: element.scrollLeft, top: element.scrollTop }, size, pane, inset);
      element.scrollLeft = next.left;
      element.scrollTop = next.top;
    });
  });
</script>

<svelte:window onblur={dividers.cancel} />

<div class="pane-container" class:multi-pane={multiPane}
  bind:this={viewport} bind:contentRect
  onscroll={dividers.cancel}
  style:--pane-divider-size={`${gap}px`}>
  {#if activeTab}
    <!-- A restored tab may reuse its saved ID; its old DOM/gestures still retire. -->
    {#key windowTabsManager.activeTabInstance}
      {@const minimum = minima?.get(activeTab.layout.id)}
      <!-- CSS fills the viewport in the same layout pass that changes it; only
           minima come from script, so panes never paint at a stale size (#1061). -->
      <div class="pane-tree" style:min-width="{minimum?.width ?? 0}px"
        style:min-height="{minimum?.height ?? 0}px">
        <PaneLayoutView node={activeTab.layout} {geometry} {minima} {dividers} />
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

  /* Fill the scrollport (stretched across, grown along); the inline minimum
     makes it overflow and scroll only when the layout cannot fit. A zero basis
     keeps tall listings from sizing the canvas by their content. */
  .pane-tree {
    display: flex;
    flex: 1 0 0;
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

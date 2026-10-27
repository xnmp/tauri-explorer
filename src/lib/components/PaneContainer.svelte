<!--
  PaneContainer component - hosts the active tab's content: an explorer
  tab renders its pane layout tree (#228); a git graph tab renders the
  graph view. The tab strip itself lives in the title bar (#229).
  Issue: tauri-explorer-auj, tauri-explorer-ldfx (window-level tabs), #228
-->
<script lang="ts">
  import { getAbortSignal, tick, untrack } from "svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { layoutStore } from "$lib/state/layout.svelte";
  import { resizeActivity } from "$lib/state/resize-activity.svelte";
  import { revealPane } from "$lib/domain/pane-viewport";
  import { usePaneDividers } from "$lib/composables/use-pane-dividers.svelte";
  import PaneLayoutView from "./PaneLayoutView.svelte";

  // The git graph is no longer a tab kind — panes render it themselves
  // when their gitGraph flag is set (#272).
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
  const gap = $derived(layoutStore.paneDividerSize);
  const dividers = usePaneDividers({ geometry: () => geometry, begin: windowTabsManager.beginSplitResize });
  $effect(() => {
    const measuredWidth = width, measuredHeight = height;
    untrack(dividers.cancel);
    // Geometry feeds reveal, directional focus and divider input; the canvas
    // itself is sized by CSS, so this deferral never shows a stale frame (#1061).
    // Commit outside ResizeObserver delivery so WebKit can finish the current layout.
    const frame = requestAnimationFrame(() => {
      windowTabsManager.paneViewport.measure(measuredWidth, measuredHeight);
    });
    return () => cancelAnimationFrame(frame);
  });
  $effect(() => {
    instance;
    untrack(dividers.cancel);
    // Unmounting used to drop focus with the old tree. A retained tree is
    // inert; do not depend on each engine's inert focus fixup (#1173).
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && focused.closest(".pane-tree.retained")) focused.blur();
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

<div class="pane-container" data-region="panes" data-split={multiPane || undefined} class:multi-pane={multiPane}
  bind:this={viewport} bind:contentRect
  onscroll={dividers.cancel}
  style:--pane-divider-size={`${gap}px`}>
  <!-- Recently active tabs stay mounted but hidden, so switching back only
       toggles visibility instead of rebuilding the tree (#1173). Keyed by mount
       identity: a restored tab may reuse its saved ID, and its old DOM/gestures
       still retire. -->
  {#each windowTabsManager.retainedTabs as tab (windowTabsManager.tabInstance(tab))}
    {@const shown = windowTabsManager.tabInstance(tab) === instance}
    {@const minimum = shown ? minima?.get(tab.layout.id) : undefined}
    <!-- CSS fills the viewport in the same layout pass that changes it; only
         minima come from script, so panes never paint at a stale size (#1061). -->
    <div class="pane-tree" class:retained={!shown} inert={!shown}
      style:min-width="{minimum?.width ?? 0}px"
      style:min-height="{minimum?.height ?? 0}px">
      <PaneLayoutView node={tab.layout} geometry={shown ? geometry : undefined}
        minima={shown ? minima : undefined} {dividers} />
    </div>
  {/each}
</div>

<style>
  .pane-container {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: auto;
    min-width: 0;
    min-height: 0;
    gap: 0;
    /* Layout-theme variables (#1306); unset, they keep the Default chrome. */
    border-radius: var(--layout-radius, 0px);
    border: var(--layout-border, none);
    box-shadow: var(--layout-shadow, none);
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

  /* A retained tab keeps its layout, scroll offsets and row DOM under the
     visible one; content-visibility lets the engine skip its rendering. */
  .pane-tree.retained {
    position: absolute;
    inset: 0;
    visibility: hidden;
    content-visibility: hidden;
    pointer-events: none;
  }

</style>

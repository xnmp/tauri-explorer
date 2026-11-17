<!--
  Custom title bar — the window's top row (#229): the tab strip on the
  left, a drag region, and the window controls on the right. Sidebar,
  panes, and preview all render UNDER this bar. Users on compositors with
  their own window chrome (e.g. Hyprland) can hide the controls by
  disabling showWindowControls; the bar still shows while the tab strip
  has tabs to render.
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { isMac } from "$lib/domain/platform";
  import * as titlebar from "$lib/domain/titlebar";
  import { observeWindowChrome } from "$lib/state/window-chrome";
  import { layoutStore } from "$lib/state/layout.svelte";
  import { useTabSeam } from "$lib/composables/use-tab-seam.svelte";
  import { attachTabStripStart } from "$lib/composables/tab-strip-start";
  import WindowTabBar from "./WindowTabBar.svelte";

  const windowControls = $derived(
    titlebar.effectiveWindowControls(settingsStore.showWindowControls, isMac),
  );
  const tabStripVisible = $derived(
    titlebar.showTabStrip(
      windowTabsManager.tabs.length,
      windowTabsManager.activeTab?.kind === "explorer" &&
        windowTabsManager.canRenameTab(windowTabsManager.activeTab.id),
      windowControls,
    ),
  );
  const showTitleBar = $derived(
    titlebar.showTitleBar(
      settingsStore.integratedTitleBar,
      windowControls,
      tabStripVisible,
    ),
  );

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  let appWindow: Window | null = null;
  try {
    if (isTauri) {
      appWindow = getCurrentWindow();
    }
  } catch {
    // Running in browser without Tauri runtime
  }

  let isMaximized = $state(false);
  let titlebarEl: HTMLDivElement | undefined = $state();

  // Floating Islands: the active tab owns the window (#1734). Its hole in the
  // strip shade, key shadow and edge highlight are the inline SVG layers
  // below, kept in step with the strip by the lazily loaded seam marks.
  useTabSeam(() => titlebarEl, () => [windowTabsManager.tabs, windowTabsManager.activeTabId, tabStripVisible]);

  // Floating Islands: the strip starts over the content islands where its
  // tabs can afford it (WindowTabBar, `tabStripStart`), so a fused tab stands
  // over the content it opens (#1734). Keyed on a boolean so re-applying the
  // same layout does not detach and re-measure the strip.
  let alignedStart = $state<number | null>(null);
  const alignStrip = $derived(Boolean(titlebarEl) && layoutStore.islands && tabStripVisible);
  $effect(() => {
    const bar = titlebarEl;
    if (!alignStrip || !bar) return;
    const start = attachTabStripStart(bar, (value) => { alignedStart = value; });
    return () => {
      start.destroy();
      alignedStart = null;
    };
  });

  onMount(() => {
    if (!appWindow) return;
    return observeWindowChrome(appWindow, (value) => { isMaximized = value; });
  });

  async function handleDragStart(event: MouseEvent) {
    if (event.button !== 0) return;
    if (!titlebar.startsWindowDrag(event.target as Element)) return;

    if (event.detail === 2) {
      await appWindow?.toggleMaximize();
      return;
    }
    await appWindow?.startDragging();
  }

  async function handleMinimize() {
    await appWindow?.minimize();
  }

  async function handleMaximize() {
    await appWindow?.toggleMaximize();
  }

  async function handleClose() {
    await windowTabsManager.requestWindowClose();
  }
</script>

{#if showTitleBar}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar" data-region="titlebar" bind:this={titlebarEl} class:integrated={isMac && settingsStore.integratedTitleBar} onmousedown={handleDragStart}>
    {#if layoutStore.islands}
      <!-- Strip shade with the active tab's hole, then the tab's lift and key
           shadow (light from the top left), cut out under the tab itself. -->
      <svg class="tab-seam-layer" data-region="tab-key-shadow" aria-hidden="true">
        <defs>
          <filter id="tab-lift-blur" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur class="tab-lift-blur" stdDeviation="3" />
          </filter>
          <filter id="tab-key-blur" x="-20%" y="-60%" width="140%" height="220%">
            <feGaussianBlur class="tab-key-blur" stdDeviation="2.5" />
          </filter>
          <clipPath id="tab-shadow-view"><rect class="tab-view-clip" x="0" y="0" width="0" height="0" /></clipPath>
          <clipPath id="tab-shadow-cut"><path class="tab-cutout" clip-rule="evenodd" /></clipPath>
          <clipPath id="tab-fill-view">
            <rect class="tab-view-clip" x="0" y="0" width="0" height="0" />
            <rect class="tab-below-clip" x="-4096" y="0" width="8192" height="4096" />
          </clipPath>
          <!-- The shade stays inside the bar: the tab's hole reaches below
               it, and outside the bar's rectangle that hole would be painted. -->
          <clipPath id="tab-strip-clip"><rect class="tab-bar-clip" x="0" y="0" width="0" height="0" /></clipPath>
        </defs>
        <path class="strip-shade" clip-path="url(#tab-strip-clip)" />
        <!-- The tab wears its island's surface: base layer, then panel layer;
             also over the island pixels its edge stroke takes over. -->
        <g class="tab-fill tab-body" clip-path="url(#tab-fill-view)">
          <path class="tab-fill-base" />
          <path class="tab-fill-panel" />
        </g>
        <g class="tab-fill tab-corners">
          <path class="tab-fill-base" />
          <path class="tab-fill-panel" />
        </g>
        <g class="tab-shadows" clip-path="url(#tab-shadow-view)">
          <g clip-path="url(#tab-shadow-cut)">
            <path class="tab-lift" filter="url(#tab-lift-blur)" />
            <path class="tab-key" filter="url(#tab-key-blur)" />
          </g>
        </g>
      </svg>
    {/if}
    <!-- The tab strip grows into the spacer. Their box is the strip's room:
         nothing the strip lays out inside it (its start, its tabs) changes
         its size, so WindowTabBar can observe it without feeding back into
         its own observation (#1734). -->
    <div class="tab-room" data-tab-room-box>
      {#if windowTabsManager.activeTab}
        <WindowTabBar {alignedStart} />
      {/if}
      <div class="spacer" data-tab-room></div>
    </div>
    {#if layoutStore.islands}
      <!-- One stroke over the tab, its fillets and the top edges and corners
           of the islands it opens into, in their border colour; split in
           three runs only when those islands' borders differ. -->
      <svg class="tab-seam-layer tab-edge-layer" data-region="tab-edge" aria-hidden="true">
        <defs>
          <!-- Above the base, the strip's view; below it, only the island
               pixels the stroke owns (the islands paint the rest). One path:
               WebKit bounds a clip of several shapes by its target's
               geometry, which would cut the stroke's lower half. -->
          <clipPath id="tab-edge-view"><path class="tab-edge-clip" /></clipPath>
        </defs>
        <g clip-path="url(#tab-edge-view)">
          <path class="tab-edge-stroke" fill="none" />
          <path class="tab-edge-stroke" fill="none" />
          <path class="tab-edge-stroke" fill="none" />
        </g>
      </svg>
    {/if}

    {#if windowControls}
      <div class="window-controls">
        <button
          class="control-btn"
          onclick={handleMinimize}
          title="Minimize"
          aria-label="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M0 5H10" stroke="currentColor" stroke-width="1" />
          </svg>
        </button>
        <button
          class="control-btn"
          onclick={handleMaximize}
          title={isMaximized ? "Restore" : "Maximize"}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {#if isMaximized}
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="2" y="2" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none" />
              <path d="M2 2V1H9V8H8" stroke="currentColor" stroke-width="1" fill="none" />
            </svg>
          {:else}
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect x="1" y="1" width="8" height="8" stroke="currentColor" stroke-width="1" fill="none" />
            </svg>
          {/if}
        </button>
        <button
          class="control-btn close"
          onclick={handleClose}
          title="Close"
          aria-label="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .titlebar {
    display: flex;
    /* Tabs fuse with the content below the bar (fillets); controls re-center
       themselves via align-self. */
    align-items: flex-end;
    height: 38px;
    background: var(--layout-chrome-surface, color-mix(in srgb, var(--background-card) calc(var(--titlebar-opacity, 1) * 100%), transparent));
    user-select: none;
    flex-shrink: 0;
    position: relative;
    border-bottom: none;
    box-shadow: 0 1px 0 var(--layout-hairline, var(--surface-stroke));
  }

  /* Subtle gradient overlay for depth */
  .titlebar::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(
      180deg,
      var(--control-fill-tertiary) 0%,
      transparent 100%
    );
    opacity: 0.4;
    pointer-events: none;
  }

  /* Tab seam layers (#1734): drawn in title bar CSS pixels, colours from the
     layout stylesheet. The edge rides above the tabs and runs along the
     islands' top edges below the bar. */
  .tab-seam-layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    z-index: 0;
    /* Own layer: the paths change every frame of a tab slide, and WebKit
       otherwise repaints everything under the strip each time. */
    will-change: opacity;
  }

  .tab-edge-layer {
    z-index: 3;
  }

  /* The shade layer is positioned, so it paints over every unpositioned
     sibling: position the bar's own content (tab strip, window controls) so
     it paints above the shade, in document order (#1734). */
  .titlebar > :not(.tab-seam-layer) {
    position: relative;
  }

  .titlebar.integrated {
    padding-left: 70px;
  }

  .tab-room {
    display: flex;
    align-items: flex-end;
    flex: 1 1 0;
    min-width: 0;
    height: 100%;
  }

  .spacer {
    flex: 1;
    min-width: 32px;
    height: 100%;
  }

  .window-controls {
    display: flex;
    flex-shrink: 0;
    align-self: center;
    height: 100%;
    margin-left: 4px;
  }

  .control-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 30px;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    transition: transform var(--transition-normal);
    border-radius: var(--radius-sm);
  }

  .control-btn:hover {
    background: var(--control-fill-secondary);
    color: var(--text-primary);
  }

  .control-btn:active {
    transform: scale(0.95);
  }

  .control-btn.close:hover {
    background: var(--system-critical);
    color: white;
  }

  .control-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  @media (max-width: 500px) {
    .control-btn { width: 28px; }
    .spacer { min-width: 16px; }
  }

</style>

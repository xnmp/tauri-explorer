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

  const tabStripVisible = $derived(
    titlebar.showTabStrip(
      windowTabsManager.tabs.length,
      windowTabsManager.activeTab?.kind === "explorer" &&
        windowTabsManager.canRenameTab(windowTabsManager.activeTab.id),
      settingsStore.showWindowControls,
    ),
  );
  const showTitleBar = $derived(
    titlebar.showTitleBar(
      settingsStore.integratedTitleBar,
      settingsStore.showWindowControls,
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

  // Floating Islands: the strip starts over the content islands, so a fused
  // tab always stands on one island's straight top edge (#1734).
  $effect(() => {
    const bar = titlebarEl;
    if (!bar || !layoutStore.islands || !tabStripVisible) return;
    const start = attachTabStripStart(bar);
    return () => start.destroy();
  });

  onMount(() => {
    if (!appWindow) return;
    return observeWindowChrome(appWindow, (value) => { isMaximized = value; });
  });

  async function handleDragStart(event: MouseEvent) {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button") || target.closest(".tab-area")) return;

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
        </defs>
        <path class="strip-shade" />
        <!-- The tab wears its island's surface: base layer, then panel layer. -->
        <g class="tab-fill" clip-path="url(#tab-fill-view)">
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
    {#if windowTabsManager.activeTab}
      <WindowTabBar />
    {/if}
    {#if layoutStore.islands}
      <!-- One stroke over the tab, its fillets and the island top edges,
           fading out through the islands' rounded corners. -->
      <svg class="tab-seam-layer tab-edge-layer" data-region="tab-edge" aria-hidden="true">
        <defs>
          <linearGradient id="tab-edge-fade" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="0">
            <stop class="tab-edge-stop" offset="0" stop-opacity="0" />
            <stop class="tab-edge-stop" offset="0.1" />
            <stop class="tab-edge-stop" offset="0.9" />
            <stop class="tab-edge-stop" offset="1" stop-opacity="0" />
          </linearGradient>
          <clipPath id="tab-edge-view">
            <rect class="tab-view-clip" x="0" y="0" width="0" height="0" />
            <rect class="tab-below-clip" x="-4096" y="0" width="8192" height="4096" />
          </clipPath>
        </defs>
        <path class="tab-edge-stroke" fill="none" stroke="url(#tab-edge-fade)" clip-path="url(#tab-edge-view)" />
      </svg>
    {/if}
    <!-- The tab strip grows into this spacer (WindowTabBar measures it). -->
    <div class="spacer" data-tab-room></div>

    {#if settingsStore.showWindowControls}
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

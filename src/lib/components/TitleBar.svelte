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
  import { requestBrowserWindowControl, SITE_DEMO_BUILD, windowControlRoute, type WindowControlAction } from "$lib/api/window-controls";

  const windowControls = $derived(
    titlebar.effectiveWindowControls(settingsStore.showWindowControls, isMac),
  );
  const tabStripVisible = $derived(
    titlebar.showTabStrip(
      windowTabsManager.tabs.length,
      windowTabsManager.activeTab?.kind === "explorer" &&
        windowTabsManager.canRenameTab(windowTabsManager.activeTab.id),
      titlebar.titleRowHeldOpen(settingsStore.integratedTitleBar, settingsStore.showWindowControls, isMac),
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

  // Floating Islands: the active tab owns the window (#1734, #1785). Its hole
  // in the strip shade, key shadow and the outline it shares with its surface
  // are the inline SVG layers below, kept in step by the lazily loaded marks.
  useTabSeam(() => titlebarEl, () => [windowTabsManager.tabs, windowTabsManager.activeTabId, tabStripVisible]);

  // Floating Islands: the strip starts past the surface's rounded top-left
  // corner where its tabs can afford it (WindowTabBar, `tabStripStart`), so
  // the first tab keeps its whole curve (#1785). Keyed on a boolean so
  // re-applying the same layout does not detach and re-measure the strip.
  let alignedStart = $state<number | null>(null);
  // The strip itself mounts only with an active tab: measure once it is there.
  const alignStrip = $derived(Boolean(titlebarEl) && layoutStore.islands && tabStripVisible && Boolean(windowTabsManager.activeTab));
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

  // Routing (api/window-controls.ts): the site demo hands the buttons to its
  // host page; everywhere else close runs the app's close sequence.
  async function windowControl(action: WindowControlAction) {
    const route = windowControlRoute(action, { nativeWindow: appWindow != null, hostOwnsWindow: SITE_DEMO_BUILD });
    if (route === "host") await requestBrowserWindowControl(action);
    else if (route === "close-flow") await windowTabsManager.requestWindowClose();
    else if (route === "native" && action === "minimize") await appWindow?.minimize();
    else if (route === "native") await appWindow?.toggleMaximize();
  }

  const handleMinimize = () => windowControl("minimize");
  const handleMaximize = () => windowControl("maximize");
  const handleClose = () => windowControl("close");
</script>

{#if showTitleBar}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar" data-region="titlebar" bind:this={titlebarEl} class:integrated={isMac && settingsStore.integratedTitleBar} onmousedown={handleDragStart}>
    {#if layoutStore.islands}
      <!-- Strip shade with the active tab's hole (the tab's surface, the
           window body, shows through it), then the tab's lift and key shadow
           (light from the top left), cut out under the tab itself. -->
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
          <!-- The shade stays inside the bar: the tab's hole reaches below
               it, and outside the bar's rectangle that hole would be painted. -->
          <clipPath id="tab-strip-clip"><rect class="tab-bar-clip" x="0" y="0" width="0" height="0" /></clipPath>
        </defs>
        <path class="strip-shade" clip-path="url(#tab-strip-clip)" />
        <!-- The strip shade outside the surface's rounded top corners. -->
        <path class="surface-pockets" />
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
      <!-- The one outline (#1785): the tab, its fillets and the surface's top
           edge and rounded top corners, a single seamless stroke. -->
      <svg class="tab-seam-layer tab-edge-layer" data-region="tab-edge" aria-hidden="true">
        <defs>
          <!-- Complementary columns of the strip's viewport. One path per
               clip: WebKit bounds a clip of several shapes by its target's
               geometry, which would cut the stroke's lower half. -->
          <clipPath id="tab-edge-view"><path class="tab-edge-clip" /></clipPath>
          <clipPath id="surface-edge-view"><path class="surface-edge-clip" /></clipPath>
        </defs>
        <!-- Inside the strip's viewport: the surface's edge with the tab, one
             stroke. Outside it: the surface's edge alone. -->
        <g clip-path="url(#tab-edge-view)">
          <path class="tab-edge-stroke" fill="none" />
        </g>
        <g clip-path="url(#surface-edge-view)">
          <path class="surface-edge-stroke" fill="none" />
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
    background: var(--layout-chrome-surface, var(--titlebar-surface));
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
    opacity: var(--titlebar-sheen-opacity, 0.4);
    pointer-events: none;
  }

  /* Tab seam layers (#1734): drawn in title bar CSS pixels, colours from the
     layout stylesheet. The outline rides above the tabs and runs along the
     surface's top edge below the bar (#1785). */
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

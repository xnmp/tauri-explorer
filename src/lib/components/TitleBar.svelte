<!--
  Custom title bar — a drag region and window controls. Tabs live in the
  window's strip (WindowTabBar), so the bar renders only when window
  controls or the integrated title bar are enabled; users on compositors
  with their own window chrome (e.g. Hyprland) can hide it entirely by
  disabling showWindowControls.
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { isMac } from "$lib/domain/platform";
  import * as titlebar from "$lib/domain/titlebar";
  const showTitleBar = $derived(
    titlebar.showTitleBar(
      settingsStore.integratedTitleBar,
      settingsStore.showWindowControls,
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

  onMount(() => {
    if (!appWindow) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      isMaximized = await appWindow.isMaximized();
      unlisten = await appWindow.onResized(async () => {
        isMaximized = await appWindow!.isMaximized();
      });
    })();
    return () => unlisten?.();
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
    await appWindow?.close();
  }
</script>

{#if showTitleBar}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar" class:integrated={isMac && settingsStore.integratedTitleBar} onmousedown={handleDragStart}>
    <div class="spacer"></div>

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
    align-items: center;
    height: 38px;
    background: color-mix(in srgb, var(--background-card) calc(var(--titlebar-opacity, 1) * 100%), transparent);
    user-select: none;
    flex-shrink: 0;
    position: relative;
    border-bottom: none;
    box-shadow: 0 1px 0 var(--surface-stroke);
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

  .titlebar.integrated {
    padding-left: 70px;
  }

  .spacer {
    flex: 1;
    height: 100%;
  }

  .window-controls {
    display: flex;
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
    transition: all var(--transition-normal);
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
    background: #c42b1c;
    color: white;
  }

  .control-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: -2px;
  }

  /* Vibrancy: titlebar floats above island, no bottom divider */
  :global([data-vibrancy]) .titlebar {
    position: relative;
    z-index: 2;
    box-shadow: none;
  }
  :global([data-vibrancy]) .titlebar::before {
    display: none;
  }
</style>

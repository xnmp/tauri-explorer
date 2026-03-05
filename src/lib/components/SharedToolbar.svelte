<!--
  SharedToolbar component - Search, theme, and window controls
  Navigation buttons have moved to per-pane NavigationBar.
  Window controls moved here from TitleBar.
  Issue: tauri-2e92, tauri-u00y
-->
<script lang="ts">
  import { getCurrentWindow, type Window } from "@tauri-apps/api/window";
  import { onMount } from "svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import ThemeSwitcher from "./ThemeSwitcher.svelte";

  // Search state
  let searchQuery = $state("");

  function handleSearch(event: Event) {
    event.preventDefault();
    // TODO: Implement search functionality
    console.log("Search:", searchQuery);
  }

  // Window controls
  const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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

<div class="shared-toolbar">
  <div class="spacer"></div>

  <div class="search-container">
    <form onsubmit={handleSearch}>
      <div class="search-box">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="search-icon">
          <circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.25"/>
          <path d="M9 9L12 12" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        </svg>
        <input
          type="text"
          bind:value={searchQuery}
          placeholder="Search..."
          class="search-input"
        />
      </div>
    </form>
  </div>

  <ThemeSwitcher />

  {#if settingsStore.showWindowControls}
    <div class="window-controls">
      <button
        class="control-btn"
        onclick={handleMinimize}
        title="Minimize"
        aria-label="Minimize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M0 5H10" stroke="currentColor" stroke-width="1"/>
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
            <rect x="2" y="2" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/>
            <path d="M2 2V1H9V8H8" stroke="currentColor" stroke-width="1" fill="none"/>
          </svg>
        {:else}
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="1" width="8" height="8" stroke="currentColor" stroke-width="1" fill="none"/>
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
          <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" stroke-width="1" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .shared-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    background: color-mix(in srgb, var(--background-card) calc(var(--toolbar-opacity, 1) * 100%), transparent);
    border-bottom: var(--toolbar-border-bottom, none);
    box-shadow: 0 1px 0 var(--divider);
    height: 48px;
    position: relative;
    z-index: 10;
  }

  .spacer {
    flex: 1;
  }

  .search-container {
    flex-shrink: 0;
    width: 240px;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 34px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-pill);
    transition: all var(--transition-fast);
  }

  .search-box:focus-within {
    background: var(--control-fill-secondary);
    border-color: var(--accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .search-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    padding: 0;
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  /* Window controls in toolbar */
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
</style>

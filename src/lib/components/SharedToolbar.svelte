<!--
  SharedToolbar component - Shared controls for all panes
  Contains navigation buttons, search, and theme switcher.
  Actions are applied to the currently focused pane.
-->
<script lang="ts">
  import { getPaneNavigationContext } from "$lib/state/pane-context";
  import { explorer as defaultExplorer } from "$lib/state/explorer.svelte";
  import { paneManager } from "$lib/state/panes.svelte";
  import ThemeSwitcher from "./ThemeSwitcher.svelte";

  // Get active explorer from pane context, or fall back to default
  const paneNav = getPaneNavigationContext();

  function getExplorer() {
    return paneNav?.getActiveExplorer() ?? defaultExplorer;
  }

  function goBack() {
    getExplorer().goBack();
  }

  function goForward() {
    getExplorer().goForward();
  }

  function goUp() {
    getExplorer().goUp();
  }

  function refresh() {
    getExplorer().refresh();
  }

  // Reactive getters for button states - re-evaluate when active pane changes
  const canGoBack = $derived.by(() => {
    // Access activePaneId to trigger re-evaluation when pane changes
    paneManager.activePaneId;
    return getExplorer().canGoBack;
  });

  const canGoForward = $derived.by(() => {
    paneManager.activePaneId;
    return getExplorer().canGoForward;
  });

  // Search state
  let searchQuery = $state("");

  function handleSearch(event: Event) {
    event.preventDefault();
    // TODO: Implement search functionality
    console.log("Search:", searchQuery);
  }
</script>

<div class="shared-toolbar">
  <div class="nav-controls">
    <button
      class="nav-btn"
      title="Back (Alt+Left)"
      disabled={!canGoBack}
      onclick={goBack}
      aria-label="Go back"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 13L5 8L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      title="Forward (Alt+Right)"
      disabled={!canGoForward}
      onclick={goForward}
      aria-label="Go forward"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      onclick={goUp}
      title="Up (Alt+Up)"
      aria-label="Go up one level"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 13V4M8 4L4 8M8 4L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      onclick={refresh}
      title="Refresh (F5)"
      aria-label="Refresh"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M13.5 8C13.5 10.7614 11.2614 13 8.5 13C5.73858 13 3.5 10.7614 3.5 8C3.5 5.23858 5.73858 3 8.5 3C10.5 3 12.2 4.2 13 5.8M13 3V5.8M13 5.8H10.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

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
</div>

<style>
  .shared-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--background-card);
    border-bottom: 1px solid var(--divider);
    height: 44px;
    position: relative;
    z-index: 10;
  }

  .nav-controls {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .nav-btn:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .nav-btn:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
    transform: scale(0.96);
  }

  .nav-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .nav-btn:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .spacer {
    flex: 1;
  }

  .search-container {
    flex-shrink: 0;
    width: 220px;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    height: 32px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    transition: all var(--transition-fast);
  }

  .search-box:focus-within {
    background: var(--control-fill-secondary);
    border-color: var(--accent);
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
</style>

<!--
  NavigationBar component - Windows 11 File Explorer style
  Contains back/forward/up/refresh buttons, breadcrumbs, and search
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";

  let searchQuery = $state("");
  let historyIndex = $state(0);

  function handleSearch(event: Event) {
    event.preventDefault();
    // TODO: Implement search functionality
    console.log("Search:", searchQuery);
  }
</script>

<div class="navigation-bar">
  <div class="nav-controls">
    <button
      class="nav-btn"
      title="Back (Alt+Left)"
      disabled
      aria-label="Go back"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 13L5 8L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      title="Forward (Alt+Right)"
      disabled
      aria-label="Go forward"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      onclick={() => explorer.goUp()}
      title="Up (Alt+Up)"
      aria-label="Go up one level"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M8 13V4M8 4L4 8M8 4L12 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="nav-btn"
      onclick={() => explorer.refresh()}
      title="Refresh (F5)"
      aria-label="Refresh"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M13.5 8C13.5 10.7614 11.2614 13 8.5 13C5.73858 13 3.5 10.7614 3.5 8C3.5 5.23858 5.73858 3 8.5 3C10.5 3 12.2 4.2 13 5.8M13 3V5.8M13 5.8H10.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

  <div class="breadcrumbs-container">
    <div class="computer-icon">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.25"/>
        <path d="M5 13H11M8 11V13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
    </div>

    <button class="crumb root" onclick={() => explorer.navigateTo("/")} aria-label="Home">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1.5L13 6.5V12.5C13 12.7761 12.7761 13 12.5 13H9V9C9 8.72386 8.77614 8.5 8.5 8.5H5.5C5.22386 8.5 5 8.72386 5 9V13H1.5C1.22386 13 1 12.7761 1 12.5V6.5L7 1.5Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>
    </button>

    {#each explorer.breadcrumbs as segment, i (segment.path)}
      <span class="chevron">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M3 2L6 5L3 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>
      <button
        class="crumb"
        class:current={i === explorer.breadcrumbs.length - 1}
        onclick={() => explorer.navigateTo(segment.path)}
      >
        {segment.name}
      </button>
    {/each}

    <button class="dropdown-toggle" aria-label="Show path options">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

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
          placeholder="Search {explorer.breadcrumbs[explorer.breadcrumbs.length - 1]?.name || 'folder'}"
          class="search-input"
        />
      </div>
    </form>
  </div>
</div>

<style>
  .navigation-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--background-card);
    border-bottom: 1px solid var(--divider);
    height: 48px;
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

  .breadcrumbs-container {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    overflow: hidden;
  }

  .breadcrumbs-container:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
  }

  .computer-icon {
    display: flex;
    align-items: center;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: none;
    border-radius: 3px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .crumb.root {
    padding: 4px 6px;
    color: var(--text-secondary);
  }

  .crumb:hover {
    background: var(--subtle-fill-secondary);
  }

  .crumb:active {
    background: var(--subtle-fill-tertiary);
  }

  .crumb.current {
    font-weight: 500;
  }

  .chevron {
    display: flex;
    align-items: center;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .dropdown-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background var(--transition-fast);
    flex-shrink: 0;
    margin-left: auto;
  }

  .dropdown-toggle:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
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

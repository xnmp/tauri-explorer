<!--
  Breadcrumbs component - Windows 11 Fluent Design
  Issue: tauri-explorer-iw0, tauri-x4bs
-->
<script lang="ts">
  import { onMount } from "svelte";
  import { explorer } from "$lib/state/explorer.svelte";
  import { getHomeDirectory } from "$lib/api/files";

  let homeDir = $state<string | null>(null);

  onMount(async () => {
    const result = await getHomeDirectory();
    if (result.ok) homeDir = result.data;
  });

  // Filter breadcrumbs: if path starts with homeDir, skip segments that are part of it
  const visibleBreadcrumbs = $derived.by(() => {
    const crumbs = explorer.breadcrumbs;
    if (!homeDir || crumbs.length === 0) return crumbs;
    // Count how many segments the home dir covers
    const homeParts = homeDir.split("/").filter(Boolean);
    const isUnderHome = crumbs.length >= homeParts.length &&
      crumbs[homeParts.length - 1]?.path === homeDir;
    if (!isUnderHome) return crumbs;
    return crumbs.slice(homeParts.length);
  });

  const isUnderHome = $derived(homeDir !== null && visibleBreadcrumbs !== explorer.breadcrumbs);
</script>

<nav class="breadcrumbs" aria-label="Folder path">
  {#if isUnderHome}
    <!-- Home icon: navigates to user's home directory -->
    <button class="crumb root" onclick={() => explorer.navigateTo(homeDir!)} aria-label="Home folder">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.5L14.5 7V14C14.5 14.2761 14.2761 14.5 14 14.5H10V10C10 9.72386 9.77614 9.5 9.5 9.5H6.5C6.22386 9.5 6 9.72386 6 10V14.5H2C1.72386 14.5 1.5 14.2761 1.5 14V7L8 1.5Z"
          stroke="currentColor"
          stroke-width="1.25"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  {:else}
    <!-- Root icon: navigates to filesystem root -->
    <button class="crumb root" onclick={() => explorer.navigateTo("/")} aria-label="Root">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 4C3 3.44772 3.44772 3 4 3H12C12.5523 3 13 3.44772 13 4V12C13 12.5523 12.5523 13 12 13H4C3.44772 13 3 12.5523 3 12V4Z" stroke="currentColor" stroke-width="1.25"/>
        <path d="M5.5 7H10.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
        <path d="M5.5 9.5H8.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
    </button>
  {/if}

  {#each visibleBreadcrumbs as segment, i (segment.path)}
    <span class="separator" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M4.5 2.5L7.5 6L4.5 9.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
    <button
      class="crumb"
      class:current={i === visibleBreadcrumbs.length - 1}
      onclick={() => explorer.navigateTo(segment.path)}
      aria-current={i === visibleBreadcrumbs.length - 1 ? "page" : undefined}
    >
      {segment.name}
    </button>
  {/each}
</nav>

<style>
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--background-card-secondary);
    border-bottom: 1px solid var(--divider);
    overflow-x: auto;
    white-space: nowrap;
    position: relative;
    z-index: 5;

    /* Hide scrollbar but keep scrollable */
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .breadcrumbs::-webkit-scrollbar {
    display: none;
  }

  /* Fade effect at edges */
  .breadcrumbs::after {
    content: "";
    position: sticky;
    right: 0;
    width: 32px;
    min-width: 32px;
    height: 100%;
    background: linear-gradient(90deg, transparent, var(--background-card-secondary));
    pointer-events: none;
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    padding: 4px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: var(--font-size-body);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .crumb:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .crumb:active {
    background: var(--subtle-fill-tertiary);
    transform: scale(0.98);
  }

  .crumb:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .crumb.root {
    padding: 6px;
    color: var(--text-tertiary);
  }

  .crumb.root:hover {
    color: var(--text-primary);
  }

  .crumb.current {
    color: var(--text-primary);
    font-weight: 500;
    background: var(--subtle-fill-secondary);
  }

  .separator {
    display: flex;
    align-items: center;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
</style>

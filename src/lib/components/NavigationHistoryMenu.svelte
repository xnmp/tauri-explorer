<!--
  NavigationHistoryMenu - Full navigation history dropdown.
  Shown when right-clicking the Back or Forward button. Lists every entry in
  the pane's history (newest first), highlights the current one, and lets the
  user jump straight to any slot.
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { basename, parentDir } from "$lib/domain/path";

  interface Props {
    explorer: ExplorerInstance;
    anchorEl: HTMLElement;
    onClose: () => void;
  }

  let { explorer, anchorEl, onClose }: Props = $props();

  // Newest-first list with original indices preserved for goToHistoryIndex.
  const items = $derived(
    explorer.history
      .map((path, index) => ({ path, index }))
      .reverse()
  );

  function select(index: number): void {
    explorer.goToHistoryIndex(index);
    onClose();
  }

  const left = $derived(anchorEl.getBoundingClientRect().left);
  const top = $derived(anchorEl.getBoundingClientRect().bottom + 4);
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="history-backdrop" onclick={(e) => { e.stopPropagation(); onClose(); }} oncontextmenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose(); }}></div>
{#if items.length > 0}
  <div class="history-menu" style="left: {left}px; top: {top}px;" role="menu">
    <div class="history-label">History</div>
    {#each items as item (item.index)}
      <button
        class="history-item"
        class:current={item.index === explorer.historyIndex}
        onclick={() => select(item.index)}
        role="menuitemradio"
        aria-checked={item.index === explorer.historyIndex}
        title={item.path}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" fill="var(--icon-folder, #ffb900)" opacity="0.8"/>
        </svg>
        <span class="history-name">{basename(item.path) || item.path}</span>
        <span class="history-parent">{parentDir(item.path)}</span>
        {#if item.index === explorer.historyIndex}
          <svg class="history-check" width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        {/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .history-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
  }

  .history-menu {
    position: fixed;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout, 0 4px 16px rgba(0, 0, 0, 0.15));
    max-height: 360px;
    min-width: 240px;
    max-width: 420px;
    overflow-y: auto;
    z-index: 100;
    padding: 4px;
  }

  .history-label {
    padding: 6px 10px 4px;
    font-size: 10px;
    font-weight: var(--font-weight-semibold, 600);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .history-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .history-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .history-item.current {
    background: var(--subtle-fill-tertiary);
  }

  .history-item svg:first-of-type {
    flex-shrink: 0;
  }

  .history-name {
    flex-shrink: 0;
    font-weight: var(--font-weight-medium, 500);
    white-space: nowrap;
  }

  .history-parent {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-tertiary);
    direction: rtl;
    text-align: left;
  }

  .history-check {
    flex-shrink: 0;
    color: var(--accent);
  }
</style>

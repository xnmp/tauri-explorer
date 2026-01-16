<!--
  TabBar component - VSCode-style tabs for each pane
  Issue: tauri-explorer-so0
-->
<script lang="ts">
  import { tabsManager, type Tab } from "$lib/state/tabs.svelte";
  import type { PaneId } from "$lib/state/types";

  interface Props {
    paneId: PaneId;
  }

  let { paneId }: Props = $props();

  const tabs = $derived(tabsManager.getTabs(paneId));
  const activeTabId = $derived(tabsManager.panes[paneId].activeTabId);

  function handleTabClick(tabId: string): void {
    tabsManager.setActiveTab(paneId, tabId);
  }

  function handleTabClose(event: MouseEvent, tabId: string): void {
    event.stopPropagation();
    tabsManager.closeTab(paneId, tabId);
  }

  function handleTabMiddleClick(event: MouseEvent, tabId: string): void {
    if (event.button === 1) {
      event.preventDefault();
      tabsManager.closeTab(paneId, tabId);
    }
  }

  function handleNewTab(): void {
    tabsManager.createTab(paneId);
  }
</script>

<div class="tab-bar" role="tablist">
  {#each tabs as tab (tab.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="tab"
      class:active={tab.id === activeTabId}
      role="tab"
      aria-selected={tab.id === activeTabId}
      onclick={() => handleTabClick(tab.id)}
      onauxclick={(e) => handleTabMiddleClick(e, tab.id)}
      title={tab.path}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="tab-icon">
        <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#FFB900"/>
      </svg>
      <span class="tab-title">{tab.title}</span>
      {#if tabs.length > 1}
        <button
          class="tab-close"
          onclick={(e) => handleTabClose(e, tab.id)}
          aria-label="Close tab"
          title="Close"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      {/if}
    </div>
  {/each}

  <button
    class="new-tab-btn"
    onclick={handleNewTab}
    aria-label="New tab"
    title="New Tab (Ctrl+T)"
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
</div>

<style>
  .tab-bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: var(--background-card-secondary, rgba(0, 0, 0, 0.02));
    border-bottom: 1px solid var(--divider);
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .tab-bar::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    flex-shrink: 0;
    max-width: 200px;
    position: relative;
  }

  .tab:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .tab.active {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  .tab.active::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 8px;
    right: 8px;
    height: 2px;
    background: var(--accent);
    border-radius: 1px 1px 0 0;
  }

  .tab-icon {
    flex-shrink: 0;
  }

  .tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 2px;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: all var(--transition-fast);
    flex-shrink: 0;
    margin-left: 2px;
  }

  .tab:hover .tab-close,
  .tab.active .tab-close {
    opacity: 1;
  }

  .tab-close:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
    flex-shrink: 0;
    margin-left: 4px;
  }

  .new-tab-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }
</style>

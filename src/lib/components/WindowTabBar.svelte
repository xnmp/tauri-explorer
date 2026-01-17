<!--
  WindowTabBar component - VSCode-style tabs at window level
  Issue: tauri-explorer-ldfx

  Each tab contains the full dual-pane layout state.
  Tab title shows active pane's folder name.
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  const tabs = $derived(windowTabsManager.tabs);
  const activeTabId = $derived(windowTabsManager.activeTabId);

  function handleTabClick(tabId: string): void {
    windowTabsManager.setActiveTab(tabId);
  }

  function handleTabClose(event: MouseEvent, tabId: string): void {
    event.stopPropagation();
    windowTabsManager.closeTab(tabId);
  }

  function handleTabMiddleClick(event: MouseEvent, tabId: string): void {
    if (event.button === 1) {
      event.preventDefault();
      windowTabsManager.closeTab(tabId);
    }
  }

  function handleNewTab(): void {
    windowTabsManager.createTab();
  }

  function handleTabKeydown(event: KeyboardEvent, tabId: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      windowTabsManager.setActiveTab(tabId);
    }
  }
</script>

<div class="tab-area" role="tablist">
  {#each tabs as tab (tab.id)}
    {@const title = windowTabsManager.getTabTitle(tab)}
    {@const tooltip = windowTabsManager.getTabTooltip(tab)}
    <div
      class="tab"
      class:active={tab.id === activeTabId}
      role="tab"
      tabindex="0"
      aria-selected={tab.id === activeTabId}
      onclick={() => handleTabClick(tab.id)}
      onkeydown={(e) => handleTabKeydown(e, tab.id)}
      onauxclick={(e) => handleTabMiddleClick(e, tab.id)}
      title={tooltip}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon">
        <path d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z" fill="#FFB900"/>
      </svg>
      <span class="tab-title">{title}</span>
      {#if tabs.length > 1}
        <button
          class="tab-close"
          onclick={(e) => handleTabClose(e, tab.id)}
          aria-label="Close tab"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M2 2L8 8M8 2L2 8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
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
    <svg width="12" height="12" viewBox="0 0 12 12">
      <path d="M6 2V10M2 6H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
</div>

<style>
  .tab-area {
    display: flex;
    align-items: flex-end;
    height: 100%;
    padding-left: 8px;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .tab-area::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 6px 0 8px;
    background: transparent;
    border-radius: 5px 5px 0 0;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    flex-shrink: 0;
    max-width: 200px;
  }

  .tab:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .tab.active {
    background: var(--background-card-secondary);
    color: var(--text-primary);
  }

  .tab-icon {
    flex-shrink: 0;
  }

  .tab-title {
    max-width: 140px;
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
    background: transparent;
    border: none;
    border-radius: 3px;
    color: var(--text-tertiary);
    cursor: pointer;
    opacity: 0;
    transition: all var(--transition-fast);
    flex-shrink: 0;
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
    margin-bottom: 4px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    flex-shrink: 0;
  }

  .new-tab-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }
</style>

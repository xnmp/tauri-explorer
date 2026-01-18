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
    <div
      class="tab"
      class:active={tab.id === activeTabId}
      role="tab"
      tabindex="0"
      aria-selected={tab.id === activeTabId}
      onclick={() => handleTabClick(tab.id)}
      onkeydown={(e) => handleTabKeydown(e, tab.id)}
      onauxclick={(e) => handleTabMiddleClick(e, tab.id)}
      title={windowTabsManager.getTabTooltip(tab)}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon">
        <path d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z"/>
      </svg>
      <span class="tab-title">{windowTabsManager.getTabTitle(tab)}</span>
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
    padding-left: 12px;
    gap: 1px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    position: relative;
  }

  .tab-area::-webkit-scrollbar {
    display: none;
  }

  /* Elegant bottom border accent line */
  .tab-area::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 1px;
    background: linear-gradient(
      90deg,
      transparent,
      var(--surface-stroke) 10%,
      var(--surface-stroke) 90%,
      transparent
    );
    pointer-events: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 10px 0 12px;
    background: transparent;
    border-radius: 6px 6px 0 0;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-normal);
    flex-shrink: 0;
    max-width: 220px;
    position: relative;
    border: 1px solid transparent;
    border-bottom: none;
    transform-origin: bottom center;
  }

  /* Subtle gradient overlay for depth */
  .tab::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 6px 6px 0 0;
    background: linear-gradient(
      180deg,
      var(--control-fill-tertiary) 0%,
      transparent 100%
    );
    opacity: 0;
    transition: opacity var(--transition-normal);
    pointer-events: none;
  }

  /* Tab separator */
  .tab::after {
    content: "";
    position: absolute;
    right: 0;
    top: 8px;
    bottom: 8px;
    width: 1px;
    background: var(--divider);
    opacity: 0.5;
    transition: opacity var(--transition-fast);
  }

  .tab:hover::before {
    opacity: 1;
  }

  .tab:hover {
    background: var(--control-fill-secondary);
    color: var(--text-secondary);
    border-color: var(--surface-stroke);
    transform: translateY(-1px);
  }

  .tab:hover::after,
  .tab.active::after,
  .tab:last-of-type::after {
    opacity: 0;
  }

  .tab.active {
    background: var(--background-card);
    color: var(--text-primary);
    font-weight: 700;
    border-color: var(--surface-stroke);
    box-shadow:
      0 -1px 3px rgba(0, 0, 0, 0.05),
      0 -2px 8px rgba(0, 0, 0, 0.03);
    transform: translateY(-1px);
    z-index: 2;
  }

  .tab.active::before {
    opacity: 0.3;
  }

  .tab-icon {
    flex-shrink: 0;
    transition: transform var(--transition-normal);
  }

  /* Dynamic folder icon color using CSS filter - adapts to theme accent */
  .tab-icon path {
    fill: var(--accent);
    opacity: 0.85;
    transition: opacity var(--transition-normal);
  }

  .tab:hover .tab-icon {
    transform: scale(1.05);
  }

  .tab:hover .tab-icon path {
    opacity: 1;
  }

  .tab.active .tab-icon path {
    opacity: 1;
  }

  .tab-title {
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color var(--transition-fast);
  }

  .tab-close {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-tertiary);
    cursor: pointer;
    transform: scale(0.85);
    opacity: 0;
    transition: all var(--transition-normal);
    flex-shrink: 0;
  }

  .tab:hover .tab-close,
  .tab.active .tab-close {
    opacity: 1;
    transform: scale(1);
  }

  .tab-close:hover {
    background: var(--control-fill-secondary);
    color: var(--text-primary);
    transform: scale(1.1);
  }

  .tab-close:active {
    transform: scale(0.95);
  }

  .new-tab-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-bottom: 2px;
    margin-left: 4px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 6px;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-normal);
    flex-shrink: 0;
  }

  .new-tab-btn:hover {
    background: var(--control-fill-secondary);
    border-color: var(--surface-stroke);
    color: var(--text-primary);
    transform: rotate(90deg);
  }

  .new-tab-btn:active {
    transform: rotate(90deg) scale(0.9);
  }
</style>

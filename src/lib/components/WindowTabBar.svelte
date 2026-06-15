<!--
  WindowTabBar component - VSCode-style tabs at window level
  Issue: tauri-explorer-ldfx

  Each tab contains the full dual-pane layout state.
  Tab title shows active pane's folder name.
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getDropSourcePaths } from "$lib/state/drop-operations";
  import { handleFileDrop } from "$lib/state/drop-operations";
  import { dragState } from "$lib/state/drag.svelte";
  import {
    tabDragState,
    isForeignTabDrag,
    claimDraggedTab,
    windowAtScreenPos,
    sendTabToWindow,
  } from "$lib/state/tab-transfer";
  import { openNewWindow } from "$lib/state/commands/shared";
  import { parentDir } from "$lib/domain/path";
  import { isCopyModifier } from "$lib/domain/platform";
  import { showTabArea as showTabAreaRule } from "$lib/domain/titlebar";
  import { tick } from "svelte";

  const tabs = $derived(windowTabsManager.tabs);
  const activeTabId = $derived(windowTabsManager.activeTabId);

  let tabAreaRef = $state<HTMLElement | null>(null);

  function updateTabGap() {
    if (!tabAreaRef || !settingsStore.macOsVibrancy) return;
    const activeEl = tabAreaRef.querySelector(
      ".tab.active",
    ) as HTMLElement | null;
    const container = document.querySelector(
      ".pane-container",
    ) as HTMLElement | null;
    if (!activeEl || !container) return;
    const containerRect = container.getBoundingClientRect();
    const tabRect = activeEl.getBoundingClientRect();
    const radius =
      parseFloat(getComputedStyle(container).borderTopLeftRadius) || 14;
    const lineWidth = containerRect.width - radius * 2;
    const left = Math.max(0, tabRect.left - containerRect.left - radius - 3);
    const right = Math.min(
      lineWidth,
      tabRect.right - containerRect.left - radius,
    );
    container.style.setProperty(
      "--tab-gap-left",
      `${(left / lineWidth) * 100}%`,
    );
    container.style.setProperty(
      "--tab-gap-right",
      `${(right / lineWidth) * 100}%`,
    );
  }

  $effect(() => {
    activeTabId;
    tabs.length;
    settingsStore.showSidebar;
    settingsStore.millerLayers;
    settingsStore.showPreviewPane;
    tick().then(updateTabGap);
  });

  $effect(() => {
    if (!tabAreaRef) return;
    const container = document.querySelector(".pane-container");
    const observer = new ResizeObserver(updateTabGap);
    observer.observe(tabAreaRef);
    if (container) observer.observe(container);
    return () => observer.disconnect();
  });

  const showTabArea = $derived(
    showTabAreaRule(
      settingsStore.integratedTitleBar,
      tabs.length,
      settingsStore.showWindowControls,
    ),
  );

  // Track tab IDs that existed on first render to skip entrance animation
  let knownTabIds = new Set(windowTabsManager.tabs.map((t) => t.id));

  // Track tabs being closed (for exit animation)
  let closingTabId = $state<string | null>(null);

  function isNewTab(tabId: string): boolean {
    if (knownTabIds.has(tabId)) return false;
    knownTabIds.add(tabId);
    return true;
  }

  function handleTabClick(tabId: string): void {
    windowTabsManager.setActiveTab(tabId);
  }

  function handleTabClose(event: MouseEvent, tabId: string): void {
    event.stopPropagation();
    closingTabId = tabId;
    // Wait for close animation to finish, then actually remove
    setTimeout(() => {
      windowTabsManager.closeTab(tabId);
      closingTabId = null;
    }, 200);
  }

  function handleTabMiddleClick(event: MouseEvent, tabId: string): void {
    if (event.button === 1) {
      event.preventDefault();
      closingTabId = tabId;
      setTimeout(() => {
        windowTabsManager.closeTab(tabId);
        closingTabId = null;
      }, 200);
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

  // Tab drag-and-drop: in-window reordering, cross-window moves (shared
  // localStorage drag marker — see tab-transfer.ts) and tear-off.
  let dragTabId = $state<string | null>(null);
  let dropTargetTabId = $state<string | null>(null);
  let fileDropTargetTabId = $state<string | null>(null);
  // Set when an HTML5 drop landed inside THIS window (reorder / same-window
  // adopt), so dragend knows it wasn't a cross-window move or a tear-off.
  let droppedInThisWindow = false;

  function handleTabDragStart(event: DragEvent, tabId: string): void {
    dragTabId = tabId;
    droppedInThisWindow = false;
    const snapshot = windowTabsManager.exportTab(tabId);
    if (snapshot) {
      tabDragState.start({
        sourceWindow: windowTabsManager.windowLabel,
        tabId,
        snapshot,
      });
    }
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", tabId);
    }
  }

  function isFileDrag(dataTransfer: DataTransfer | null): boolean {
    if (!dataTransfer) return false;
    const types = dataTransfer.types;
    return (
      types.includes("application/x-explorer-path") ||
      types.includes("application/x-explorer-paths") ||
      types.includes("Files")
    );
  }

  function handleTabDragOver(event: DragEvent, tabId: string): void {
    // Tab reorder drag
    if (dragTabId) {
      if (dragTabId === tabId) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      dropTargetTabId = tabId;
      return;
    }

    // Tab dragged in from another window
    if (isForeignTabDrag(tabDragState.read())) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      dropTargetTabId = tabId;
      return;
    }

    // File drag onto tab (cross-window drags carry no dataTransfer types)
    if (isFileDrag(event.dataTransfer) || dragState.readCrossWindow()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      fileDropTargetTabId = tabId;
    }
  }

  function handleTabDragLeave(event: DragEvent): void {
    // Ignore leave events fired when crossing into a child node of the tab
    const related = event.relatedTarget as Node | null;
    if (related && (event.currentTarget as HTMLElement).contains(related)) return;
    dropTargetTabId = null;
    fileDropTargetTabId = null;
  }

  async function handleTabDrop(event: DragEvent, tabId: string): Promise<void> {
    event.preventDefault();

    // Tab reorder (same window)
    if (dragTabId && dragTabId !== tabId) {
      droppedInThisWindow = true;
      const fromIndex = tabs.findIndex((t) => t.id === dragTabId);
      const toIndex = tabs.findIndex((t) => t.id === tabId);
      if (fromIndex >= 0 && toIndex >= 0) {
        windowTabsManager.reorderTabs(fromIndex, toIndex);
      }
      dragTabId = null;
      dropTargetTabId = null;
      return;
    }

    // Dropping a tab back onto its own bar (same position) is a no-op, not a
    // tear-off — mark it as handled in-window.
    if (dragTabId && dragTabId === tabId) {
      droppedInThisWindow = true;
    }

    // Tab dropped here from another window: adopt it at this position.
    if (!dragTabId) {
      const foreign = tabDragState.read();
      if (isForeignTabDrag(foreign)) {
        dropTargetTabId = null;
        const index = tabs.findIndex((t) => t.id === tabId);
        claimDraggedTab(foreign, index >= 0 ? index : undefined);
        return;
      }
    }

    // File drop onto tab (mirror FileList: dataTransfer first, then cross-window drag state)
    if (!dragTabId && event.dataTransfer && (isFileDrag(event.dataTransfer) || dragState.readCrossWindow())) {
      fileDropTargetTabId = null;
      const targetPath = windowTabsManager.getTabPath(tabId);
      if (!targetPath) return;

      const sourcePaths = getDropSourcePaths(event.dataTransfer);
      if (sourcePaths.length === 0) return;

      const isCopy = isCopyModifier(event);
      dragState.clear();
      const onRefresh = () => {
        for (const explorer of windowTabsManager.getAllExplorers()) {
          explorer.refresh({ silent: true });
        }
      };
      for (const sourcePath of sourcePaths) {
        if (parentDir(sourcePath) === targetPath) continue;
        if (sourcePath === targetPath) continue;
        if (targetPath.startsWith(sourcePath + "/")) continue;
        // Await sequentially so multi-file drops can't stack conflict dialogs
        await handleFileDrop(sourcePath, targetPath, isCopy, { onRefresh });
      }
      return;
    }

    dragTabId = null;
    dropTargetTabId = null;
  }

  async function handleTabDragEnd(event: DragEvent): Promise<void> {
    const wasReorder = droppedInThisWindow;
    dragTabId = null;
    dropTargetTabId = null;
    fileDropTargetTabId = null;
    droppedInThisWindow = false;

    // If the marker is gone, another window already claimed the tab.
    const pending = tabDragState.read();
    if (!pending || pending.sourceWindow !== windowTabsManager.windowLabel) return;
    tabDragState.clear();

    // An in-window drop (reorder / drop on own bar) is fully handled already.
    if (wasReorder) return;

    // Cross-window moves and tear-off can't rely on HTML5 drop events reaching
    // another webview, so resolve the RELEASE position (screen pixels) against
    // every open window. dragend gives screenX/screenY in CSS px; convert to
    // physical to compare with Tauri window bounds.
    const dpr = window.devicePixelRatio || 1;
    const physX = event.screenX * dpr;
    const physY = event.screenY * dpr;
    const targetLabel = await windowAtScreenPos(physX, physY);

    if (targetLabel && targetLabel !== windowTabsManager.windowLabel) {
      // Dropped over another explorer window → hand the tab off to it.
      await sendTabToWindow(targetLabel, pending.snapshot);
      windowTabsManager.removeTransferredTab(pending.tabId);
    } else if (targetLabel === null && tabs.length > 1) {
      // Dropped outside every window → tear off into a new window. A single-tab
      // window would only recreate itself, so skip that case.
      const { snapshot } = pending;
      const activePath =
        snapshot.activePaneId === "right" ? snapshot.rightPath : snapshot.leftPath;
      void openNewWindow(activePath, undefined, snapshot);
      windowTabsManager.removeTransferredTab(pending.tabId);
    }
    // targetLabel === own window (and not a reorder) → no-op.
  }

  /** Drops on the empty strip area (right of the tabs) append the foreign
   *  tab at the end. Per-tab handlers cover drops on tabs themselves. */
  function handleAreaDragOver(event: DragEvent): void {
    if ((event.target as HTMLElement).closest(".tab")) return;
    if (!dragTabId && isForeignTabDrag(tabDragState.read())) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    }
  }

  function handleAreaDrop(event: DragEvent): void {
    if ((event.target as HTMLElement).closest(".tab")) return;
    if (dragTabId) return;
    const foreign = tabDragState.read();
    if (isForeignTabDrag(foreign)) {
      event.preventDefault();
      claimDraggedTab(foreign);
    }
  }
</script>

{#if showTabArea}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- Drag handlers only — keyboard interaction lives on the tabs. -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="tab-area"
    role="tablist"
    bind:this={tabAreaRef}
    ondragover={handleAreaDragOver}
    ondrop={handleAreaDrop}
  >
    {#each tabs as tab (tab.id)}
      <div
        class="tab"
        class:active={tab.id === activeTabId}
        class:drag-over={dropTargetTabId === tab.id}
        class:file-drop-target={fileDropTargetTabId === tab.id}
        class:dragging={dragTabId === tab.id}
        class:tab-entering={isNewTab(tab.id)}
        class:tab-closing={closingTabId === tab.id}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === activeTabId}
        data-tab-id={tab.id}
        onclick={() => handleTabClick(tab.id)}
        onkeydown={(e) => handleTabKeydown(e, tab.id)}
        onauxclick={(e) => handleTabMiddleClick(e, tab.id)}
        title={windowTabsManager.getTabTooltip(tab)}
        draggable="true"
        ondragstart={(e) => handleTabDragStart(e, tab.id)}
        ondragover={(e) => handleTabDragOver(e, tab.id)}
        ondragleave={handleTabDragLeave}
        ondrop={(e) => handleTabDrop(e, tab.id)}
        ondragend={handleTabDragEnd}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          class="tab-icon"
        >
          <path
            d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z"
          />
        </svg>
        <span class="tab-title">{windowTabsManager.getTabTitle(tab)}</span>
        <button
          class="tab-close"
          onclick={(e) => handleTabClose(e, tab.id)}
          aria-label="Close tab"
          title="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path
              d="M2 2L8 8M8 2L2 8"
              stroke="currentColor"
              stroke-width="1.25"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    {/each}

    <button
      class="new-tab-btn"
      onclick={handleNewTab}
      aria-label="New tab"
      title="New Tab (Ctrl+T)"
    >
      <svg width="12" height="12" viewBox="0 0 12 12">
        <path
          d="M6 2V10M2 6H10"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </div>
{/if}

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

  @keyframes tabSlideIn {
    from {
      max-width: 0;
      opacity: 0;
      padding-left: 0;
      padding-right: 0;
    }
    to {
      max-width: 220px;
      opacity: 1;
      padding-left: 12px;
      padding-right: 10px;
    }
  }

  @keyframes tabSlideOut {
    to {
      max-width: 0;
      opacity: 0;
      padding-left: 0;
      padding-right: 0;
    }
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px 0 12px;
    background: var(--background);
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    font-size: 12px;
    font-weight: var(--font-weight-medium);
    letter-spacing: -0.01em;
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-normal);
    flex-shrink: 0;
    max-width: 220px;
    position: relative;
    border: none;
    border-top: 2px solid var(--surface-stroke, rgba(0, 0, 0, 0.1));
    opacity: 0.8;
    transform-origin: bottom center;
    overflow: hidden;
  }

  .tab.tab-entering {
    animation: tabSlideIn 250ms cubic-bezier(0.1, 0.9, 0.2, 1) both;
  }

  .tab.tab-closing {
    animation: tabSlideOut 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
    pointer-events: none;
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
    opacity: 1;
  }

  .tab:hover::after,
  .tab.active::after,
  .tab:last-of-type::after {
    opacity: 0;
  }

  .tab.dragging {
    opacity: 0.5;
  }

  .tab.drag-over {
    border-color: var(--accent);
    background: var(--subtle-fill-secondary);
  }

  .tab.file-drop-target,
  .tab:global(.drop-target) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, var(--background));
    box-shadow:
      0 0 0 1px var(--accent),
      0 0 8px color-mix(in srgb, var(--accent) 40%, transparent);
    opacity: 1;
    transform: translateY(-1px);
  }

  .tab.active {
    background: var(--background-card);
    color: var(--text-primary);
    font-weight: var(--font-weight-semibold);
    border-top: 2px solid var(--accent);
    box-shadow:
      0 -1px 4px rgba(0, 0, 0, 0.08),
      0 -3px 10px rgba(0, 0, 0, 0.05),
      inset 0 1px 0 rgba(255, 255, 255, 0.5);
    transform: translateY(-1px);
    z-index: 2;
    opacity: 1;
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
    width: 30px;
    height: 30px;
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

  /* Vibrancy: tab styling */
  :global([data-vibrancy]) .tab {
    border-radius: var(--vibrancy-island-radius) var(--vibrancy-island-radius) 0
      0;
    transition:
      background var(--transition-normal),
      color var(--transition-normal),
      opacity var(--transition-normal);
  }

  :global([data-vibrancy]) .tab-area::after {
    display: none;
  }

  :global([data-vibrancy]) .tab.active {
    background: var(--vibrancy-island-bg);
    border: none;
    border-top: 2px solid var(--accent);
    box-shadow:
      inset 0 0.5px 0 var(--vibrancy-island-stroke),
      0 0 0 0.5px var(--vibrancy-island-stroke);
    transform: none;
  }
</style>

<!--
  PaneTabBar component - VSCode-style tab strip owned by a single pane.
  Issues: tauri-explorer-ldfx (window tabs), #140 (per-pane tabs)

  Each pane renders its own strip; a tab is a single explorer view.
  Dragging a tab onto the other pane's strip moves it across panes.
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getDropSourcePaths } from "$lib/state/drop-operations";
  import { handleFileDropMany } from "$lib/state/drop-operations";
  import { dragState } from "$lib/state/drag.svelte";
  import {
    tabDragState,
    windowAtScreenPos,
    sendTabToWindow,
  } from "$lib/state/tab-transfer";
  import { getZoomFactor } from "$lib/domain/zoom";
  import { openNewWindow } from "$lib/state/commands/shared";
  import { parentDir } from "$lib/domain/path";
  import { isCopyModifier } from "$lib/domain/platform";
  import { showPaneTabBar } from "$lib/domain/titlebar";
  import type { PaneId } from "$lib/state/types";

  const { paneId }: { paneId: PaneId } = $props();

  const tabs = $derived(windowTabsManager.panes[paneId].tabs);
  const activeTabId = $derived(windowTabsManager.panes[paneId].activeTabId);

  // When "git root in tab title" is on, resolve each tab's repo root (cached in
  // the manager). Runs here because the async work needs a component owner; the
  // manager's title derivation reacts to the cache it fills.
  $effect(() => {
    if (!settingsStore.tabTitleGitRoot) return;
    for (const tab of tabs) {
      const path = windowTabsManager.getTabPath(tab.id);
      if (path) windowTabsManager.ensureGitRoot(path);
    }
  });

  const showTabArea = $derived(
    showPaneTabBar(tabs.length, windowTabsManager.dualPaneEnabled),
  );

  // Track tab IDs that existed on first render to skip entrance animation.
  // Initialized lazily on the first render pass so it sees the pane's
  // then-current tabs without touching reactive state at setup time.
  let knownTabIds: Set<string> | null = null;

  // Track tabs being closed (for exit animation)
  let closingTabId = $state<string | null>(null);

  function isNewTab(tabId: string): boolean {
    if (!knownTabIds) {
      knownTabIds = new Set(windowTabsManager.panes[paneId].tabs.map((t) => t.id));
    }
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
    windowTabsManager.createTabIn(paneId);
  }

  function handleTabKeydown(event: KeyboardEvent, tabId: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      windowTabsManager.setActiveTab(tabId);
    }
  }

  // Tab drag is POINTER-based (not HTML5): HTML5 drag events never reach another
  // Tauri webview, force a "no-drop" cursor, and hide the drag image outside the
  // window. Pointer events with implicit mouse capture keep firing (with screen
  // coordinates) even over other windows / the desktop, so we render our own
  // ghost, reorder within the strip, move across panes, hand the tab off to
  // whichever window the cursor is over, or tear off a new window AT the
  // cursor. File drops ONTO a tab still use the HTML5/native path further below.
  let dropTargetTabId = $state<string | null>(null);
  let fileDropTargetTabId = $state<string | null>(null);
  let draggingTabId = $state<string | null>(null);

  let tabPtr: {
    tabId: string;
    startX: number;
    startY: number;
    active: boolean;
    ghost: HTMLElement | null;
  } | null = null;
  let suppressNextClick = false;

  function handleTabMouseDown(event: MouseEvent, tabId: string): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tab-close")) return; // close btn owns its clicks
    tabPtr = { tabId, startX: event.clientX, startY: event.clientY, active: false, ghost: null };
    window.addEventListener("mousemove", onTabMouseMove, true);
    window.addEventListener("mouseup", onTabMouseUp, true);
    window.addEventListener("keydown", onTabDragKey, true);
  }

  function makeTabGhost(tabId: string): HTMLElement {
    const tab = tabs.find((t) => t.id === tabId);
    const el = document.createElement("div");
    el.className = "tab-drag-ghost";
    el.textContent = tab ? windowTabsManager.getTabTitle(tab) : "";
    el.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;opacity:0.9;padding:4px 12px;" +
      "border-radius:6px;background:var(--background-card-secondary,#2a2a2a);" +
      "color:var(--text-primary,#eee);font-size:13px;white-space:nowrap;" +
      "box-shadow:0 4px 14px rgba(0,0,0,0.35);border:1px solid var(--divider,rgba(255,255,255,0.1));";
    document.body.appendChild(el);
    return el;
  }

  function tabAtPoint(x: number, y: number): string | null {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.(".tab");
    return el?.getAttribute("data-tab-id") ?? null;
  }

  /** Which pane's tab strip (if any) is under the point. */
  function paneAreaAtPoint(x: number, y: number): PaneId | null {
    const area = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.(".tab-area");
    return (area?.getAttribute("data-pane-id") as PaneId | null) ?? null;
  }

  function onTabMouseMove(event: MouseEvent): void {
    if (!tabPtr) return;
    if (!tabPtr.active) {
      if (Math.hypot(event.clientX - tabPtr.startX, event.clientY - tabPtr.startY) < 5) return;
      tabPtr.active = true;
      draggingTabId = tabPtr.tabId;
      const snapshot = windowTabsManager.exportTab(tabPtr.tabId);
      if (snapshot) {
        tabDragState.start({
          sourceWindow: windowTabsManager.windowLabel,
          tabId: tabPtr.tabId,
          snapshot,
        });
      }
      tabPtr.ghost = makeTabGhost(tabPtr.tabId);
    }
    const zoom = getZoomFactor();
    tabPtr.ghost!.style.left = `${event.clientX / zoom + 12}px`;
    tabPtr.ghost!.style.top = `${event.clientY / zoom + 12}px`;
    const over = tabAtPoint(event.clientX, event.clientY);
    dropTargetTabId = over && over !== tabPtr.tabId ? over : null;
  }

  async function onTabMouseUp(event: MouseEvent): Promise<void> {
    if (!tabPtr) return;
    const ptr = tabPtr;
    tabPtr = null;
    removeTabDragListeners();
    ptr.ghost?.remove();
    dropTargetTabId = null;
    draggingTabId = null;

    if (!ptr.active) return; // a plain click — the tab's onclick switches tabs

    suppressNextClick = true;
    const pending = tabDragState.read();
    tabDragState.clear();
    if (!pending || pending.sourceWindow !== windowTabsManager.windowLabel) return;

    // 1) Released over a tab strip in THIS window → reorder (same pane) or
    //    move across panes (the other pane's strip).
    const targetPaneId = paneAreaAtPoint(event.clientX, event.clientY);
    if (targetPaneId) {
      const overId = tabAtPoint(event.clientX, event.clientY);
      if (targetPaneId === paneId) {
        if (overId && overId !== ptr.tabId) {
          const from = tabs.findIndex((t) => t.id === ptr.tabId);
          const to = tabs.findIndex((t) => t.id === overId);
          if (from >= 0 && to >= 0) windowTabsManager.reorderTabs(paneId, from, to);
        }
      } else {
        const targetTabs = windowTabsManager.panes[targetPaneId].tabs;
        const at = overId ? targetTabs.findIndex((t) => t.id === overId) : undefined;
        windowTabsManager.moveTabToPane(ptr.tabId, targetPaneId, at === -1 ? undefined : at);
      }
      return;
    }

    // 2) Resolve the release position (physical px) against every open window.
    const dpr = window.devicePixelRatio || 1;
    const targetLabel = await windowAtScreenPos(event.screenX * dpr, event.screenY * dpr);
    if (targetLabel && targetLabel !== windowTabsManager.windowLabel) {
      // Into another window → adopt there, then close our tab (and our window if
      // this was its last tab — removeTransferredTab handles that).
      await sendTabToWindow(targetLabel, pending.snapshot);
      windowTabsManager.removeTransferredTab(pending.tabId);
    } else if (targetLabel === null) {
      // Onto the desktop → tear off a new window AT the cursor.
      const { snapshot } = pending;
      await openNewWindow(snapshot.path, undefined, snapshot, {
        x: event.screenX * dpr,
        y: event.screenY * dpr,
      });
      windowTabsManager.removeTransferredTab(pending.tabId);
    }
    // Released over our own window (but not a tab strip) → no-op.
  }

  function onTabDragKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && tabPtr) {
      tabPtr.ghost?.remove();
      tabPtr = null;
      draggingTabId = null;
      dropTargetTabId = null;
      tabDragState.clear();
      removeTabDragListeners();
    }
  }

  function removeTabDragListeners(): void {
    window.removeEventListener("mousemove", onTabMouseMove, true);
    window.removeEventListener("mouseup", onTabMouseUp, true);
    window.removeEventListener("keydown", onTabDragKey, true);
  }

  // ── File drops ONTO a tab (move the dragged files into that tab's directory) ──
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
    if (isFileDrag(event.dataTransfer) || dragState.readCrossWindow()) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      fileDropTargetTabId = tabId;
    }
  }

  function handleTabDragLeave(event: DragEvent): void {
    const related = event.relatedTarget as Node | null;
    if (related && (event.currentTarget as HTMLElement).contains(related)) return;
    fileDropTargetTabId = null;
  }

  async function handleTabDrop(event: DragEvent, tabId: string): Promise<void> {
    if (!(isFileDrag(event.dataTransfer) || dragState.readCrossWindow())) return;
    event.preventDefault();
    fileDropTargetTabId = null;
    const targetPath = windowTabsManager.getTabPath(tabId);
    if (!targetPath || !event.dataTransfer) return;

    const sourcePaths = getDropSourcePaths(event.dataTransfer);
    if (sourcePaths.length === 0) return;

    const isCopy = isCopyModifier(event);
    dragState.clear();
    const onRefresh = () => {
      for (const explorer of windowTabsManager.getAllExplorers()) {
        explorer.refresh({ silent: true });
      }
    };
    const valid = sourcePaths.filter(
      (sourcePath) =>
        parentDir(sourcePath) !== targetPath &&
        sourcePath !== targetPath &&
        !targetPath.startsWith(sourcePath + "/"),
    );
    // The helper transfers sequentially (no stacked conflict dialogs) and
    // records one undoable batch (#163).
    await handleFileDropMany(valid, targetPath, isCopy, { onRefresh });
  }
</script>

{#if showTabArea}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- Drag handlers only — keyboard interaction lives on the tabs. -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div
    class="tab-area"
    role="tablist"
    data-pane-id={paneId}
  >
    {#each tabs as tab (tab.id)}
      {@const display = windowTabsManager.getTabDisplay(tab)}
      <div
        class="tab"
        class:active={tab.id === activeTabId}
        class:drag-over={dropTargetTabId === tab.id}
        class:file-drop-target={fileDropTargetTabId === tab.id}
        class:dragging={draggingTabId === tab.id}
        class:tab-entering={isNewTab(tab.id)}
        class:tab-closing={closingTabId === tab.id}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === activeTabId}
        data-tab-id={tab.id}
        onmousedown={(e) => handleTabMouseDown(e, tab.id)}
        onclick={() => { if (suppressNextClick) { suppressNextClick = false; return; } handleTabClick(tab.id); }}
        onkeydown={(e) => handleTabKeydown(e, tab.id)}
        onauxclick={(e) => handleTabMiddleClick(e, tab.id)}
        title={windowTabsManager.getTabTooltip(tab)}
        ondragover={(e) => handleTabDragOver(e, tab.id)}
        ondragleave={handleTabDragLeave}
        ondrop={(e) => handleTabDrop(e, tab.id)}
      >
        {#if tab.id === activeTabId}
          <!-- Chrome-style fillets: concave corners where the active tab
               meets the pane below it (#157). -->
          <span class="tab-fillet left" aria-hidden="true"></span>
          <span class="tab-fillet right" aria-hidden="true"></span>
        {/if}
        {#if display.isGitRoot}
          <!-- Git branch icon: this tab's folder lives inside a git repo. -->
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            class="tab-icon tab-icon-git"
            aria-label="Git repository"
          >
            <circle cx="4" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
            <circle cx="4" cy="12.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
            <circle cx="11.5" cy="3.5" r="1.6" stroke="currentColor" stroke-width="1.3" />
            <path
              d="M4 5.1V10.9M11.5 5.1V6.5C11.5 8.2 10 9 8 9H6"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
            />
          </svg>
        {:else}
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
        {/if}
        <span class="tab-title">
          {#if display.repo}
            <!-- Repo name shrinks/ellipsizes first; the current folder stays
                 visible as long as possible (full path is in the tooltip). -->
            <span class="tab-repo">{display.repo}</span>
            <span class="tab-sep" aria-hidden="true">›</span>
          {/if}
          <span class="tab-cwd">{display.name}</span>
        </span>
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
    height: 34px;
    flex-shrink: 0;
    padding-left: 12px;
    gap: 1px;
    overflow-x: auto;
    scrollbar-width: none;
    -ms-overflow-style: none;
    position: relative;
    background: color-mix(in srgb, var(--background-card) calc(var(--titlebar-opacity, 1) * 100%), transparent);
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

  /* The active tab is fused to the pane — hover must not lift or restyle it. */
  .tab.active:hover {
    background: var(--background-card);
    color: var(--text-primary);
    transform: none;
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
    /* No lift and no drop shadow: the tab's base must FUSE with the pane
       surface below it (Chrome-style) — any translateY or shadow reads as
       a seam at the junction. */
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.5);
    transform: none;
    z-index: 2;
    opacity: 1;
    /* Fillets render outside the tab box; text clipping is handled by
       .tab-title's own overflow. */
    overflow: visible;
  }

  /* Chrome-style fillets (#157): concave quarter-circles that flare the
     active tab's base into the pane surface below it. Each is a square
     hanging off the tab's bottom corner, filled with the tab's surface
     colour except for a transparent circle anchored at the square's top
     outer corner — so the tab's vertical edge bends smoothly outward and
     meets the pane tangentially instead of at 90°. z-index above the
     strip's baseline ::after so the line terminates AT the curve. */
  .tab-fillet {
    --fillet: 10px;
    position: absolute;
    bottom: 0;
    width: var(--fillet);
    height: var(--fillet);
    pointer-events: none;
    z-index: 3;
  }

  .tab-fillet.left {
    left: calc(-1 * var(--fillet));
    background: radial-gradient(
      circle var(--fillet) at 0 0,
      transparent calc(var(--fillet) - 0.5px),
      var(--background-card) var(--fillet)
    );
  }

  .tab-fillet.right {
    right: calc(-1 * var(--fillet));
    background: radial-gradient(
      circle var(--fillet) at 100% 0,
      transparent calc(var(--fillet) - 0.5px),
      var(--background-card) var(--fillet)
    );
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
    display: flex;
    align-items: baseline;
    gap: 3px;
    max-width: 150px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    transition: color var(--transition-fast);
  }

  /* Repo name is context: dimmed, and it's the first thing to shrink/ellipsize
     (high flex-shrink) so the current folder stays readable. */
  .tab-repo {
    flex: 0 1 auto;
    flex-shrink: 999;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0.6;
  }

  .tab-sep {
    flex: 0 0 auto;
    opacity: 0.5;
  }

  /* Current folder: shrinks only after the repo has fully collapsed. */
  .tab-cwd {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Git icon uses stroked shapes in the accent colour (override the folder
     icon's fill rule, which would otherwise fill the branch glyph). */
  .tab-icon-git {
    color: var(--accent);
    opacity: 0.85;
  }

  .tab-icon-git path,
  .tab-icon-git circle {
    fill: none;
    stroke: currentColor;
  }

  .tab:hover .tab-icon-git,
  .tab.active .tab-icon-git {
    opacity: 1;
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

  :global([data-vibrancy]) .tab-area {
    background: transparent;
  }

  :global([data-vibrancy]) .tab-area::after {
    display: none;
  }

  :global([data-vibrancy]) .tab-fillet.left {
    background: radial-gradient(
      circle var(--fillet) at 0 0,
      transparent calc(var(--fillet) - 0.5px),
      var(--vibrancy-island-bg) var(--fillet)
    );
  }

  :global([data-vibrancy]) .tab-fillet.right {
    background: radial-gradient(
      circle var(--fillet) at 100% 0,
      transparent calc(var(--fillet) - 0.5px),
      var(--vibrancy-island-bg) var(--fillet)
    );
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

<!--
  WindowTabBar component - VSCode-style tab strip owned by the window (#228).
  Issues: tauri-explorer-ldfx (window tabs), #228 (pane layout trees)

  The window renders one strip; a tab is an explorer view (with a pane
  layout tree) or a git graph. Tabs drag to reorder, tear off into new
  windows, or transfer to other windows. Multi-pane tabs can be renamed
  (double-click) — renaming also saves the layout as a workspace.
-->
<script lang="ts">
  import { tick, onDestroy } from "svelte";
  import { dragState } from "$lib/state/drag.svelte";
  import { cubicOut } from "svelte/easing";
  import { MediaQuery } from "svelte/reactivity";
  import { windowTabsManager, type TabTransfer } from "$lib/state/window-tabs.svelte";
  import { dropIntoDirectory } from "$lib/composables/use-dom-directory-drop";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getCommandShortcut } from "$lib/state/commands.svelte";
  import { tabDragState, windowAtScreenPos, sendTabToWindow } from "$lib/state/tab-transfer";
  import { clientToCSSRelative, cssToRect, getZoomFactor, rectDimToCSS } from "$lib/domain/zoom";
  import { openNewWindow } from "$lib/state/commands/shared";
  import { showTabStrip } from "$lib/domain/titlebar";
  import { stepTabDrag, TAB_DRAG_IDLE, type TabDrag, type TabDragEffect, type TabDragEvent } from "$lib/domain/tab-drag";
  import { tabStripLayout, tabEdgeScrollSpeed, tabRevealDelta, TAB_MAX_WIDTH, TAB_GAP, TAB_BLEED } from "$lib/domain/tab-strip";
  import { tabSlideCss, TAB_SLIDE_IN_MS, TAB_SLIDE_OUT_MS } from "$lib/domain/tab-slide";
  import WindowTabPicker from "./WindowTabPicker.svelte";
  import "./window-tab-bar.css";
  import NamedFolderIcon from "./NamedFolderIcon.svelte";
  import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";

  const tabs = $derived(windowTabsManager.tabs);
  const activeTabId = $derived(windowTabsManager.activeTabId);
  let renamingTabId = $state<string | null>(null);

  let tabViewport: HTMLDivElement | undefined = $state();
  let tabSpaceWidth = $state(0);
  let tabViewportWidth = $state(0);
  let tabScrollLeft = $state(0);
  const stripLayout = $derived(tabStripLayout(tabs.length, tabSpaceWidth, Math.min(renamingTabId ? 180 : 120, tabSpaceWidth || 120)));
  const showScrollButtons = $derived(stripLayout.overflowing && tabSpaceWidth >= 240);
  let pickerButton: HTMLButtonElement | undefined = $state();
  let pickerOpen = $state(false);
  const pickerItems = $derived(tabs.map(tab => ({
    id: tab.id, title: windowTabsManager.getTabTitle(tab), path: windowTabsManager.getTabTooltip(tab),
  })));

  function closePicker(restoreFocus = false): void {
    pickerOpen = false;
    if (restoreFocus) pickerButton?.focus();
  }

  // Activation/layout changes reveal the selected tab. Manual browsing does
  // not retrigger this effect, so wheel/arrow/drag scrolling stays user-owned.
  $effect(() => {
    const id = activeTabId;
    const geometry = [stripLayout.activeWidth, stripLayout.inactiveWidth, tabViewportWidth];
    void geometry;
    let cancelled = false;
    void tick().then(() => {
      if (!cancelled && activeTabId === id) revealActiveTab();
    });
    return () => { cancelled = true; };
  });

  function revealActiveTab(): void {
    if (!tabViewport) return;
    const selected = Array.from(tabViewport.querySelectorAll<HTMLElement>(".tab"))
      .find(tab => tab.dataset.tabId === activeTabId);
    if (!selected) return;
    // Leave room for the active tab's fillets, which hang outside its box.
    const delta = tabRevealDelta(selected.getBoundingClientRect(), tabViewport.getBoundingClientRect(), cssToRect(TAB_BLEED));
    if (delta) tabViewport.scrollLeft += rectDimToCSS(delta);
  }

  /** Tab enter/exit: grow the flex basis from the live --tab-width, never
   *  clipping the fillets (domain/tab-slide.ts, #1734). */
  function tabSlide(_node: HTMLElement, { duration }: { duration: number }) {
    return { duration, easing: cubicOut, css: (t: number) => tabSlideCss(t, "var(--tab-width)", TAB_BLEED) };
  }

  function scrollTabs(direction: number): void {
    if (tabViewport) tabViewport.scrollLeft += direction * Math.max(120, tabViewport.clientWidth * 0.8);
  }

  function handleTabWheel(event: WheelEvent): void {
    if (!tabViewport || event.ctrlKey || event.metaKey || !stripLayout.overflowing) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? tabViewport.clientWidth : 1;
    tabViewport.scrollLeft += (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
    event.preventDefault();
  }

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
    showTabStrip(
      tabs.length,
      windowTabsManager.activeTab?.kind === "explorer" &&
        windowTabsManager.canRenameTab(windowTabsManager.activeTab.id),
      settingsStore.showWindowControls,
    ),
  );

  const reducedMotion = new MediaQuery("(prefers-reduced-motion: reduce)");

  function handleTabClick(tabId: string): void {
    windowTabsManager.setActiveTab(tabId);
    // Selecting the current tab is still an explicit reveal request, even
    // when its ID did not change after the user browsed elsewhere in the strip.
    void tick().then(() => { if (activeTabId === tabId) revealActiveTab(); });
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

  const newTabShortcut = $derived(getCommandShortcut("tabs.newTab"));
  const newTabTitle = $derived(`New Tab${newTabShortcut ? ` (${newTabShortcut})` : ""}`);

  function handleNewTab(): void {
    windowTabsManager.createTab();
  }

  function handleTabKeydown(event: KeyboardEvent, tabId: string): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      windowTabsManager.setActiveTab(tabId);
    }
    if (event.key === "F2") {
      event.preventDefault();
      startRename(tabId);
    }
  }

  // ── Inline rename (#228): multi-pane tabs only ──
  let renameValue = $state("");

  function startRename(tabId: string): void {
    if (!windowTabsManager.canRenameTab(tabId)) return;
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    windowTabsManager.setActiveTab(tabId);
    renamingTabId = tabId;
    renameValue = windowTabsManager.getTabTitle(tab);
    void tick().then(() => {
      const input = document.querySelector<HTMLInputElement>(".tab-rename-input");
      input?.focus();
      input?.select();
    });
  }

  function commitRename(): void {
    if (renamingTabId) {
      windowTabsManager.renameTab(renamingTabId, renameValue);
    }
    renamingTabId = null;
  }

  function handleRenameKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      commitRename();
    } else if (event.key === "Escape") {
      event.preventDefault();
      renamingTabId = null;
    }
    event.stopPropagation();
  }

  // Tab drag is POINTER-based (not HTML5): HTML5 drag events never reach another
  // Tauri webview, force a "no-drop" cursor, and hide the drag image outside the
  // window. Pointer events with implicit mouse capture keep firing (with screen
  // coordinates) even over other windows / the desktop, so we render our own
  // ghost, reorder within the strip, hand the tab off to whichever window the
  // cursor is over, or tear off a new window AT the cursor. File drops ONTO a
  // tab still use the HTML5/native path further below.
  let dropTargetTabId = $state<string | null>(null);
  let fileDropTargetTabId = $state<string | null>(null);
  let draggingTabId = $state<string | null>(null);

  /** Resources one press-to-release session acquires; its identity is the session. */
  interface DragSession {
    dragId: string | null;
    transfer: TabTransfer | null;
    ghost: HTMLElement | null;
    followRaf: number;
    scrollRaf: number;
    pointer: { x: number; y: number } | null;
  }
  // The lifecycle (pressed → dragging → detaching → detached, #176) is the
  // domain reducer's; this component runs the effect each transition names.
  let drag: TabDrag<DragSession, WebviewWindow> = TAB_DRAG_IDLE;
  function send(event: TabDragEvent<DragSession, WebviewWindow>): TabDragEffect {
    const step = stepTabDrag(drag, event);
    drag = step.drag;
    return step.effect;
  }

  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  let suppressNextClick = false;

  function handleTabMouseDown(event: MouseEvent, tabId: string): void {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".tab-close")) return; // close btn owns its clicks
    if (renamingTabId === tabId) return; // rename input owns the pointer
    cancelTabDrag();
    const session: DragSession = { dragId: null, transfer: null, ghost: null, followRaf: 0, scrollRaf: 0, pointer: null };
    send({ type: "press", session, tabId, at: { x: event.clientX, y: event.clientY } });
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

  /** Whether the window's tab strip is under the point. */
  function tabAreaAtPoint(x: number, y: number): boolean {
    return !!(document.elementFromPoint(x, y) as HTMLElement | null)?.closest?.(".tab-area");
  }

  /** The press became a drag: acquire the transfer and show the ghost. */
  function activateTabDrag(): boolean {
    if (drag.kind !== "dragging") return false;
    const { session, tabId } = drag;
    session.transfer = windowTabsManager.beginTabTransfer(tabId);
    if (!session.transfer) return false;
    session.dragId = tabDragState.start({
      sourceWindow: windowTabsManager.windowLabel,
      tabId,
      snapshot: session.transfer.snapshot,
    });
    if (!session.dragId) return false;
    draggingTabId = tabId;
    session.ghost = makeTabGhost(tabId);
    return true;
  }

  function onTabMouseMove(event: MouseEvent): void {
    const at = { x: event.clientX, y: event.clientY };
    // Chrome-style detach leaves the strip as a real window (Tauri only — the
    // browser E2E environment keeps the ghost-until-release behavior).
    const move = () => send({ type: "move", at, outsideStrip: drag.kind === "dragging" && isTauri && !tabAreaAtPoint(at.x, at.y) });
    let effect = move();
    if (effect === "activate") {
      if (!activateTabDrag()) { cancelTabDrag(); return; }
      effect = move();
    }
    if (effect === "follow") followDetachedWindow(event);
    else if (effect === "detach") void detachIntoWindow(event).catch(() => {});
    else if (effect === "hover" && drag.kind === "dragging") {
      const zoom = getZoomFactor();
      drag.session.ghost!.style.left = `${at.x / zoom + 12}px`;
      drag.session.ghost!.style.top = `${at.y / zoom + 12}px`;
      drag.session.pointer = at;
      startEdgeScroll(drag.session);
      const over = tabAtPoint(at.x, at.y);
      dropTargetTabId = over && over !== drag.tabId ? over : null;
    }
  }

  function startEdgeScroll(session: DragSession): void {
    if (session.scrollRaf || !tabViewport) return;
    let previous: number | null = null;
    let desiredScroll = tabViewport.scrollLeft;
    let appliedScroll = desiredScroll;
    const step = (now: number) => {
      session.scrollRaf = 0;
      if (drag.kind !== "dragging" || drag.session !== session || !session.pointer || !tabViewport) return;
      const { x, y } = session.pointer;
      const rect = tabViewport.getBoundingClientRect();
      if (y < rect.top || y > rect.bottom) return;
      const speed = tabEdgeScrollSpeed(clientToCSSRelative(x, rect.left), tabViewport.clientWidth);
      if (!speed) return;
      const elapsed = previous === null ? 0 : Math.max(0, Math.min(32, now - previous));
      if (tabViewport.scrollLeft !== appliedScroll) desiredScroll = tabViewport.scrollLeft;
      const maximum = tabViewport.scrollWidth - tabViewport.clientWidth;
      desiredScroll = Math.max(0, Math.min(maximum, desiredScroll + speed * elapsed / 1000));
      tabViewport.scrollLeft = desiredScroll;
      appliedScroll = tabViewport.scrollLeft;
      previous = now;
      const over = tabAtPoint(x, y);
      dropTargetTabId = over && over !== drag.tabId ? over : null;
      // The first frame can have zero elapsed time and engines may round a
      // fractional scroll delta away. Continue until the actual edge, rather
      // than treating one unchanged scrollLeft as the end of the gesture.
      const canScroll = speed < 0 ? desiredScroll > 0 : desiredScroll < maximum;
      if (canScroll) session.scrollRaf = requestAnimationFrame(step);
    };
    session.scrollRaf = requestAnimationFrame(step);
  }

  /** Detach the dragged tab into a real window at the cursor (#176).
   *  A single-tab window moves itself natively instead (exactly Chrome). */
  async function detachIntoWindow(event: MouseEvent): Promise<void> {
    if (drag.kind !== "detaching") return;
    const session = drag.session;
    if (session.scrollRaf) cancelAnimationFrame(session.scrollRaf);
    session.scrollRaf = 0;
    session.ghost?.remove();
    session.ghost = null;
    let child: WebviewWindow | null = null;

    const pending = tabDragState.read();
    if (!pending || pending.id !== session.dragId || pending.sourceWindow !== windowTabsManager.windowLabel) {
      session.transfer?.cancel();
      settleDetach(session, null);
      return;
    }

    // Dragging the only tab = move the whole window, natively.
    if (windowTabsManager.totalTabCount === 1) {
      session.transfer?.cancel();
      cancelTabDrag();
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().startDragging();
      } catch {
        // Not in Tauri / compositor refused — nothing to do.
      }
      return;
    }

    try {
      const dpr = window.devicePixelRatio || 1;
      const win = await openNewWindow(pending.snapshot.path, undefined, pending.snapshot, {
        x: event.screenX * dpr,
        y: event.screenY * dpr,
      });
      if (!win || win.kind !== "fresh") return;
      session.transfer?.complete();
      tabDragState.clear(session.dragId);
      child = win.window;
    } finally {
      session.transfer?.cancel();
      // A released or replaced session cannot acquire this child for following.
      settleDetach(session, child);
    }
  }

  function settleDetach(session: DragSession, child: WebviewWindow | null): void {
    const from = drag;
    if (send({ type: "detached", session, window: child }) === "end") endTabDrag(from, false);
  }

  /** rAF-throttled reposition of the detached window under the cursor. */
  function followDetachedWindow(event: MouseEvent): void {
    if (drag.kind !== "detached" || drag.session.followRaf) return;
    const { session, window: child } = drag;
    const following = () => drag.kind === "detached" && drag.session === session;
    const { screenX, screenY } = event;
    session.followRaf = requestAnimationFrame(() => {
      session.followRaf = 0;
      if (!following()) return;
      const dpr = window.devicePixelRatio || 1;
      void import("@tauri-apps/api/dpi").then(({ PhysicalPosition }) => {
        if (!following()) return;
        return child.setPosition(new PhysicalPosition(Math.round(screenX * dpr - 120), Math.round(screenY * dpr - 16)));
      }).catch(() => {});
    });
  }

  /** Tear down an in-flight drag without any drop action. */
  function cancelTabDrag(): void {
    const from = drag;
    send({ type: "cancel" });
    // An accepted native operation retains its lease until its own settlement.
    endTabDrag(from, from.kind !== "detaching");
  }

  function endTabDrag(from: TabDrag<DragSession, WebviewWindow>, cancelTransfer: boolean): void {
    const session = from.kind === "idle" ? null : from.session;
    if (cancelTransfer) session?.transfer?.cancel();
    tabDragState.clear(session?.dragId);
    if (session?.followRaf) cancelAnimationFrame(session.followRaf);
    if (session?.scrollRaf) cancelAnimationFrame(session.scrollRaf);
    session?.ghost?.remove();
    draggingTabId = null;
    dropTargetTabId = null;
    removeTabDragListeners();
  }

  async function onTabMouseUp(event: MouseEvent): Promise<void> {
    const from = drag;
    const effect = send({ type: "release" });
    if (from.kind === "idle") return;
    const ptr = from.session;
    removeTabDragListeners();
    if (ptr.followRaf) cancelAnimationFrame(ptr.followRaf);
    if (ptr.scrollRaf) cancelAnimationFrame(ptr.scrollRaf);
    ptr.ghost?.remove();
    dropTargetTabId = null;
    draggingTabId = null;

    const pending = tabDragState.read();
    tabDragState.clear(ptr.dragId);

    if (effect === "click") return; // a plain click — the tab's onclick switches tabs

    // Already detached into a live window (#176): the tab moved when the
    // window was created; release just ends the follow and focuses it.
    if (effect === "focus") {
      if (from.kind === "detached") void from.window.setFocus().catch(() => {});
      return;
    }

    try {
      suppressNextClick = true;
      if (!pending || pending.id !== ptr.dragId || pending.sourceWindow !== windowTabsManager.windowLabel) return;

      // 1) Released over the tab strip in THIS window → reorder.
      if (tabAreaAtPoint(event.clientX, event.clientY)) {
        const overId = tabAtPoint(event.clientX, event.clientY);
        if (overId && overId !== from.tabId) {
          const fromIndex = tabs.findIndex((t) => t.id === from.tabId);
          const to = tabs.findIndex((t) => t.id === overId);
          if (fromIndex >= 0 && to >= 0) windowTabsManager.reorderTabs(fromIndex, to);
        }
        return;
      }

      // 2) Resolve the release position (physical px) against every open window.
      const dpr = window.devicePixelRatio || 1;
      const targetLabel = await windowAtScreenPos(event.screenX * dpr, event.screenY * dpr);
      if (targetLabel && targetLabel !== windowTabsManager.windowLabel) {
        // Into another window → adopt there, then close our tab (and our window if
        // this was its last tab).
        if (await sendTabToWindow(targetLabel, pending.snapshot)) {
          ptr.transfer?.complete();
        }
      } else if (targetLabel === null) {
        // Onto the desktop → tear off a new window AT the cursor.
        const { snapshot } = pending;
        const moved = await openNewWindow(snapshot.path, undefined, snapshot, {
          x: event.screenX * dpr,
          y: event.screenY * dpr,
        });
        if (moved) ptr.transfer?.complete();
      }
      // Released over our own window (but not the tab strip) → no-op.
    } catch {
      // A disappearing native window leaves the source intact.
    } finally {
      ptr.transfer?.cancel();
    }
  }

  function onTabDragKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && drag.kind !== "idle") {
      // If already detached the window simply stops following (it exists now).
      cancelTabDrag();
    }
  }

  function removeTabDragListeners(): void {
    window.removeEventListener("mousemove", onTabMouseMove, true);
    window.removeEventListener("mouseup", onTabMouseUp, true);
    window.removeEventListener("keydown", onTabDragKey, true);
  }

  onDestroy(cancelTabDrag);

  // ── File drops ONTO a tab (move the dragged files into that tab's directory) ──
  function isFileDrag(dataTransfer: DataTransfer | null): boolean {
    return dragState.acceptsFileDrag(dataTransfer);
  }

  function handleTabDragOver(event: DragEvent, tabId: string): void {
    if (isFileDrag(event.dataTransfer)) {
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
    if (!dragState.acceptsFileDrop(event.dataTransfer)) return;
    event.preventDefault();
    fileDropTargetTabId = null;
    const targetPath = windowTabsManager.getTabPath(tabId);
    if (!targetPath || !event.dataTransfer) return;

    const onRefresh = () => {
      for (const explorer of windowTabsManager.getAllExplorers()) explorer.refresh({ silent: true });
    };
    await dropIntoDirectory(event, targetPath, "tab", { onRefresh: onRefresh });
  }
</script>

{#if showTabArea}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- Drag handlers only — keyboard interaction lives on the tabs. -->
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <div class="tab-area" data-region="tab-strip">
    <div class="tab-scroll-group" bind:clientWidth={tabSpaceWidth} style:width={`${tabs.length * (TAB_MAX_WIDTH + TAB_GAP) - TAB_GAP}px`}>
      {#if showScrollButtons}
        <button class="tab-scroll-btn" aria-label="Scroll tabs left" disabled={tabScrollLeft < 1} onclick={() => scrollTabs(-1)}>‹</button>
      {/if}
      <div class="tab-viewport" class:bleed={!stripLayout.overflowing} style:--tab-bleed={`${TAB_BLEED}px`} bind:this={tabViewport} bind:clientWidth={tabViewportWidth} onscroll={() => { tabScrollLeft = tabViewport?.scrollLeft ?? 0; }} onwheel={handleTabWheel}>
    <!-- A tablist owns only tabs; the new-tab button sits beside it (#785). -->
    <div class="tab-list" role="tablist" aria-label="Tabs">
    {#each tabs as tab (tab.id)}
      {@const display = windowTabsManager.getTabDisplay(tab)}
      <div
        class="tab"
        data-region="tab"
        class:active={tab.id === activeTabId}
        class:compact={tab.id !== activeTabId && stripLayout.iconOnly}
        class:narrow={tab.id === activeTabId && stripLayout.activeWidth < 90}
        style:--tab-width={`${tab.id === activeTabId ? stripLayout.activeWidth : stripLayout.inactiveWidth}px`}
        class:drag-over={dropTargetTabId === tab.id}
        class:file-drop-target={fileDropTargetTabId === tab.id}
        class:dragging={draggingTabId === tab.id}
        in:tabSlide={{ duration: reducedMotion.current ? 0 : TAB_SLIDE_IN_MS }}
        out:tabSlide={{ duration: reducedMotion.current ? 0 : TAB_SLIDE_OUT_MS }}
        onintroend={() => { if (tab.id === activeTabId) revealActiveTab(); }}
        onoutroend={revealActiveTab}
        role="tab"
        tabindex="0"
        aria-selected={tab.id === activeTabId}
        aria-label={`${windowTabsManager.getTabTitle(tab)} — ${windowTabsManager.getTabTooltip(tab)}`}
        data-tab-id={tab.id}
        onmousedown={(e) => handleTabMouseDown(e, tab.id)}
        onclick={() => { if (suppressNextClick) { suppressNextClick = false; return; } handleTabClick(tab.id); }}
        ondblclick={() => startRename(tab.id)}
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
          <span class="tab-fillet left" data-region="tab-fillet" data-side="left" aria-hidden="true"></span>
          <span class="tab-fillet right" data-region="tab-fillet" data-side="right" aria-hidden="true"></span>
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
          <!-- A special folder name takes its pack-native icon (#1499). -->
          <NamedFolderIcon name={display.folder ?? ""} class="tab-icon tab-icon-special">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" class="tab-icon">
              <path d="M2 3.5C2 2.67 2.67 2 3.5 2H6.17L8 3.83H12.5C13.33 3.83 14 4.5 14 5.33V12.5C14 13.33 13.33 14 12.5 14H3.5C2.67 14 2 13.33 2 12.5V3.5Z" />
            </svg>
          </NamedFolderIcon>
        {/if}
        {#if renamingTabId === tab.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="tab-rename-input"
            type="text"
            bind:value={renameValue}
            onkeydown={handleRenameKeydown}
            onblur={commitRename}
            onmousedown={(e) => e.stopPropagation()}
            onclick={(e) => e.stopPropagation()}
            aria-label="Rename tab"
          />
        {:else}
          <span class="tab-title">
            {#if display.repo}
              <!-- Repo name shrinks/ellipsizes first; the current folder stays
                   visible as long as possible (full path is in the tooltip). -->
              <span class="tab-repo">{display.repo}</span>
              <span class="tab-sep" aria-hidden="true">›</span>
            {/if}
            <span class="tab-cwd">{display.name}</span>
          </span>
        {/if}
        <!-- Pointer-only, and deliberately not a <button>: role="tab" has
             presentational children, so a focusable descendant (even at
             tabindex -1) is a nested control that assistive technology
             cannot reach. The keyboard closes the active tab with Ctrl+W
             (#785). -->
        <span
          class="tab-close"
          onclick={(e) => handleTabClose(e, tab.id)}
          aria-hidden="true"
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
        </span>
      </div>
    {/each}
    </div>
      </div>
      {#if showScrollButtons}
        <button class="tab-scroll-btn" aria-label="Scroll tabs right" disabled={tabScrollLeft + tabViewportWidth >= stripLayout.totalWidth + 2 * TAB_BLEED - 1} onclick={() => scrollTabs(1)}>›</button>
      {/if}
    </div>

    <button
      class="new-tab-btn"
      onclick={handleNewTab}
      aria-label="New tab"
      title={newTabTitle}
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
    <button class="tab-picker-btn" bind:this={pickerButton} aria-label="Search open tabs" title="Search open tabs" aria-expanded={pickerOpen} aria-haspopup="listbox" onclick={() => { pickerOpen = !pickerOpen; }}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" /></svg>
    </button>
    {#if pickerOpen && pickerButton}
      <WindowTabPicker items={pickerItems} {activeTabId} anchorEl={pickerButton} onSelect={handleTabClick} onClose={closePicker} />
    {/if}
  </div>
{/if}

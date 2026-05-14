<!--
  Sidebar - host shell for sidebar views + resize handle.
-->
<script lang="ts">
  import { sidebarViewsStore } from "$lib/state/sidebar-views.svelte";

  const SIDEBAR_WIDTH_KEY = "explorer-sidebar-width";
  const MIN_WIDTH = 180;
  const MAX_WIDTH = 400;
  const DEFAULT_WIDTH = 240;

  let savedWidth = typeof localStorage !== "undefined"
    ? parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || String(DEFAULT_WIDTH), 10)
    : DEFAULT_WIDTH;

  let sidebarWidth = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)));
  let isResizing = $state(false);

  const views = $derived(sidebarViewsStore.views);
  const activeId = $derived(sidebarViewsStore.activeId);

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;

    const startX = event.clientX;
    const startWidth = sidebarWidth;

    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      sidebarWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
    }

    function onMouseUp() {
      isResizing = false;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
  }
</script>

<div class="sidebar-container" class:resizing={isResizing} style="width: {sidebarWidth}px">
  <div class="sidebar">
    {#each views as view (view.id)}
      {@const ViewComponent = view.component}
      <div
        class="sidebar-view-host"
        role="tabpanel"
        aria-label={view.label}
        data-view-id={view.id}
        hidden={view.id !== activeId}
      >
        <ViewComponent />
      </div>
    {/each}
  </div>
  <div
    class="resize-handle"
    onmousedown={startResize}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize sidebar"
  ></div>
</div>

<style>
  .sidebar-container {
    display: flex;
    flex-shrink: 0;
    position: relative;
  }

  .sidebar-container.resizing {
    user-select: none;
  }

  .sidebar {
    flex: 1;
    background: color-mix(in srgb, var(--background-card-secondary) calc(var(--sidebar-opacity, 1) * 100%), transparent);
    border-right: var(--sidebar-border-right, none);
    box-shadow: 1px 0 0 var(--divider);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .sidebar-view-host {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .sidebar-view-host[hidden] {
    display: none !important;
  }

  .resize-handle {
    position: absolute;
    right: -3px;
    top: 0;
    bottom: 0;
    width: 6px;
    cursor: ew-resize;
    z-index: 10;
    transition: background var(--transition-fast);
  }

  .resize-handle:hover,
  .sidebar-container.resizing .resize-handle {
    background: var(--accent);
  }

  /* Vibrancy: sidebar as floating island */
  :global([data-vibrancy]) .sidebar-container {
    border-radius: var(--vibrancy-island-radius);
    box-shadow: var(--vibrancy-island-glow);
    background: var(--vibrancy-island-bg);
  }

  :global([data-vibrancy]) .sidebar {
    background: transparent;
    border: none;
    border-radius: var(--vibrancy-island-radius);
    box-shadow: none;
  }
</style>

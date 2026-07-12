<!--
  Sidebar - host shell for sidebar views + resize handle.
-->
<script lang="ts">
  import { sidebarViewsStore } from "$lib/state/sidebar-views.svelte";
  import { SIDEBAR_VIEW_PRESENTATION } from "$lib/components/sidebar-view-registry";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";

  const resize = usePersistedPanelWidth("explorer-sidebar-width", {
    min: 180,
    max: 400,
    default: 240,
  });

  const views = $derived(sidebarViewsStore.views);
  const activeId = $derived(sidebarViewsStore.activeId);
</script>

<div class="sidebar-container" class:resizing={resize.isResizing} style="width: {resize.width}px">
  <div class="sidebar">
    {#each views as view (view.id)}
      {@const ViewComponent = SIDEBAR_VIEW_PRESENTATION[view.id].component}
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
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- mouse-drag resize handle; role=separator conveys the correct semantics to AT, keyboard resize is a separate unimplemented feature -->
  <div
    class="resize-handle"
    onmousedown={resize.startResize}
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
    background: linear-gradient(
      to bottom,
      transparent,
      var(--accent) 40%,
      var(--accent) 60%,
      transparent
    );
  }

  /* Vibrancy: sidebar as floating island. Structural material — heavier
     than the content islands so hierarchy reads at a glance (#277). */
  :global([data-vibrancy]) .sidebar-container {
    border-radius: var(--vibrancy-island-radius);
    border: 1px solid var(--vibrancy-island-stroke);
    box-shadow: var(--vibrancy-island-glow);
    background: var(--vibrancy-island-bg-structural, var(--vibrancy-island-bg));
    backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
    -webkit-backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
  }

  :global([data-vibrancy]) .sidebar {
    background: transparent;
    border: none;
    border-radius: var(--vibrancy-island-radius);
    box-shadow: none;
  }
</style>

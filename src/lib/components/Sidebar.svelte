<!--
  Sidebar - host shell for sidebar views + resize handle.
-->
<script lang="ts">
  import PanelResizeHandle from "./PanelResizeHandle.svelte";
  import { sidebarViewsStore } from "$lib/state/sidebar-views.svelte";
  import { SIDEBAR_VIEW_PRESENTATION } from "$lib/components/sidebar-view-registry";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";

  const panelId = $props.id();

  const resize = usePersistedPanelWidth("explorer-sidebar-width", {
    min: 180,
    max: 400,
    default: 240,
  });

  const views = $derived(sidebarViewsStore.views);
  const activeId = $derived(sidebarViewsStore.activeId);
</script>

<div id={panelId} class="sidebar-container" data-region="sidebar" class:resizing={resize.isResizing} style="width: {resize.value}px">
  <div class="sidebar" data-region="sidebar-body">
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
  <PanelResizeHandle {resize} label="Resize sidebar" controls={panelId} outset />
</div>

<style>
  /* Layout-theme variables (#1306); unset, they keep the Default chrome. */
  .sidebar-container {
    display: flex;
    flex-shrink: 0;
    position: relative;
    border-radius: var(--layout-radius, 0px);
    border: var(--layout-border, none);
    box-shadow: var(--layout-shadow, none);
  }

  .sidebar-container.resizing {
    user-select: none;
  }

  .sidebar {
    flex: 1;
    border-radius: inherit;
    background: var(--layout-chrome-surface, color-mix(in srgb, var(--background-card-secondary) calc(var(--sidebar-opacity, 1) * 100%), transparent));
    border-right: var(--sidebar-border-right, none);
    box-shadow: 1px 0 0 var(--layout-hairline, var(--divider));
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

</style>

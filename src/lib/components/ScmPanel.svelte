<!--
  ScmPanel - Independent source control panel.
  Issue: feat/git-scm-own-panel (#96)

  Renders the SCM sidebar view as a standalone panel between
  the sidebar and the pane container. Toggled via Alt+M G.
-->
<script lang="ts">
  import ScmSidebarView from "./ScmSidebarView.svelte";
  import { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";

  const resize = usePersistedPanelWidth("explorer-scm-panel-width", {
    min: 200,
    max: 500,
    default: 280,
  });
</script>

<div class="scm-panel" class:resizing={resize.isResizing} style="width: {resize.width}px">
  <ScmSidebarView />
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -- mouse-drag resize handle; role=separator conveys the correct semantics to AT, keyboard resize is a separate unimplemented feature -->
  <div
    class="resize-handle"
    onmousedown={resize.startResize}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize source control panel"
  ></div>
</div>

<style>
  .scm-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
    border-right: 1px solid var(--divider);
    background: var(--background-card);
  }

  .scm-panel.resizing {
    user-select: none;
  }

  .scm-panel :global(.sidebar-view) {
    flex: 1;
    min-height: 0;
  }

  .resize-handle {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: ew-resize;
    background: transparent;
    z-index: 1;
    transition: background 150ms;
  }

  .resize-handle:hover,
  .scm-panel.resizing .resize-handle {
    background: var(--accent);
  }

  /* Vibrancy: SCM panel as floating island */
  :global([data-vibrancy]) .scm-panel {
    border-radius: var(--vibrancy-island-radius);
    border: 1px solid var(--vibrancy-island-stroke);
    background: var(--vibrancy-island-bg);
    box-shadow: var(--vibrancy-island-glow);
    backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
    -webkit-backdrop-filter: var(--vibrancy-island-filter, blur(12px) brightness(1.08) saturate(1.2));
  }
</style>

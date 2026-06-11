<!--
  ScmPanel - Independent source control panel.
  Issue: feat/git-scm-own-panel (#96)

  Renders the SCM sidebar view as a standalone panel between
  the sidebar and the pane container. Toggled via Alt+M G.
-->
<script lang="ts">
  import ScmSidebarView from "./ScmSidebarView.svelte";

  const PANEL_WIDTH_KEY = "explorer-scm-panel-width";
  const MIN_WIDTH = 200;
  const MAX_WIDTH = 500;
  const DEFAULT_WIDTH = 280;

  const parsedWidth = typeof localStorage !== "undefined"
    ? parseInt(localStorage.getItem(PANEL_WIDTH_KEY) ?? "", 10)
    : NaN;
  const savedWidth = Number.isNaN(parsedWidth) ? DEFAULT_WIDTH : parsedWidth;

  let panelWidth = $state(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, savedWidth)));
  let isResizing = $state(false);

  function startResize(event: MouseEvent) {
    event.preventDefault();
    isResizing = true;
    const startX = event.clientX;
    const startWidth = panelWidth;

    function onMouseMove(e: MouseEvent) {
      const delta = e.clientX - startX;
      panelWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
    }

    function onMouseUp() {
      isResizing = false;
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
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

<div class="scm-panel" class:resizing={isResizing} style="width: {panelWidth}px">
  <ScmSidebarView />
  <div
    class="resize-handle"
    onmousedown={startResize}
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
    backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
    -webkit-backdrop-filter: blur(12px) brightness(1.08) saturate(1.2);
  }
</style>

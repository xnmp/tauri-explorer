<!--
  GitGraphHeader — the git graph's column header (#341): mirrors the row
  layout so labels align with their columns, hosts the graph/author/date
  resize separators and, via `children`, the branch-filter control. The
  parent tracks the body's horizontal scroll so the header follows it.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { usePersistedPanelWidth } from "$lib/composables/use-panel-resize.svelte";
  import type { GraphColumns } from "$lib/state/git-graph-view-prefs.svelte";

  type PanelWidth = ReturnType<typeof usePersistedPanelWidth>;

  interface Props {
    tableWidth: number;
    scrollLeft: number;
    graphWidth: number;
    regionId: string;
    graphCol: PanelWidth;
    authorCol: PanelWidth;
    dateCol: PanelWidth;
    columns: GraphColumns;
    /** Trimmed file-path filter, or "" for none. */
    filePath: string;
    mergeBase: { first: string; second: string } | null;
    onContextMenu: (event: MouseEvent) => void;
    children: Snippet;
  }

  const {
    tableWidth, scrollLeft, graphWidth, regionId, graphCol, authorCol, dateCol, columns,
    filePath, mergeBase, onContextMenu, children,
  }: Props = $props();
</script>

<!-- Match the row viewport after native scrollbar space, while keeping
     overflow visible for the branch-filter popover below this header. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- right-click opens the column-visibility menu; not reachable by keyboard by design (parity with the row context menu) -->
<div
  class="graph-header" role="row" tabindex="-1"
  style:width="{tableWidth}px"
  style:margin-left="{-scrollLeft}px"
  style:padding-left="{graphWidth + 20}px"
  oncontextmenu={onContextMenu}
>
  {@render children()}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator -->
  <span
    class="col-handle handle-graph"
    class:active={graphCol.isResizing}
    style:left="{graphWidth + 6}px"
    onpointerdown={graphCol.startResize} onpointermove={graphCol.move} onpointerup={graphCol.finish}
    onpointercancel={graphCol.cancelPointer} onlostpointercapture={graphCol.cancelPointer}
    onkeydown={graphCol.keydown} tabindex="0"
    aria-controls={`${regionId}-graph`}
    aria-valuemin={graphCol.min} aria-valuemax={graphCol.max} aria-valuenow={graphCol.value}
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize graph column"
    data-testid="handle-graph"
  ></span>
  <span class="gh-message" title={filePath || "Message"}>
    {#if mergeBase}
      Fork point: {mergeBase.first} / {mergeBase.second}
    {:else}
      {filePath ? `Path: ${filePath}` : "Message"}
    {/if}
  </span>
  {#if columns.author}
    <span id={`${regionId}-author`} class="gh-author" style:width="{authorCol.value}px">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator -->
      <span
        class="col-handle handle-in-cell"
        class:active={authorCol.isResizing}
        onpointerdown={authorCol.startResize}
        onpointermove={authorCol.move} onpointerup={authorCol.finish}
        onpointercancel={authorCol.cancelPointer} onlostpointercapture={authorCol.cancelPointer}
        onkeydown={authorCol.keydown} tabindex="0"
        aria-controls={`${regionId}-author`}
        aria-valuemin={authorCol.min} aria-valuemax={authorCol.max} aria-valuenow={authorCol.value}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize author column"
        data-testid="handle-author"
      ></span>
      Author
    </span>
  {/if}
  {#if columns.date}
    <span id={`${regionId}-date`} class="gh-date" style:width="{dateCol.value}px">
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -- WAI movable separator -->
      <span
        class="col-handle handle-in-cell"
        class:active={dateCol.isResizing}
        onpointerdown={dateCol.startResize}
        onpointermove={dateCol.move} onpointerup={dateCol.finish}
        onpointercancel={dateCol.cancelPointer} onlostpointercapture={dateCol.cancelPointer}
        onkeydown={dateCol.keydown} tabindex="0"
        aria-controls={`${regionId}-date`}
        aria-valuemin={dateCol.min} aria-valuemax={dateCol.max} aria-valuenow={dateCol.value}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize date column"
        data-testid="handle-date"
      ></span>
      Date
    </span>
  {/if}
  {#if columns.commit}<span class="gh-oid">Commit</span>{/if}
  {#if columns.parent}<span class="gh-oid gh-parent">Parent</span>{/if}
</div>

<style>
  /* Column header (#341): mirrors the row layout (same left padding and gap)
     so labels align with their columns; hosts the drag handles. */
  .graph-header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    flex-shrink: 0;
    padding: 0 14px 0 10px; /* left is overridden inline to clear the lanes */
    border-bottom: 1px solid var(--divider);
    font-size: var(--font-size-caption);
    font-weight: 600;
    color: var(--text-tertiary);
    user-select: none;
  }

  .gh-message {
    flex: 1;
    min-width: 0;
  }

  .gh-author,
  .gh-date {
    position: relative;
    flex-shrink: 0;
    text-align: right;
  }

  .gh-oid {
    flex-shrink: 0;
    width: 60px;
    margin-left: 8px;
    text-align: right;
  }

  /* Parent column (#402): wider — merges list two short OIDs. */
  .gh-parent {
    width: 120px;
  }

  .col-handle {
    touch-action: none;
    position: absolute;
    top: 0;
    bottom: 0;
    width: 9px;
    cursor: ew-resize;
    z-index: 2;
  }

  .col-handle::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 5px;
    bottom: 5px;
    width: 1px;
    background: var(--divider);
  }

  .col-handle:hover::after,
  .col-handle.active::after {
    background: var(--accent);
    width: 2px;
  }

  .col-handle:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }

  /* Author/date handles sit on the cell's left edge, in the flex gap. */
  .handle-in-cell {
    touch-action: none;
    left: -9px;
  }
</style>

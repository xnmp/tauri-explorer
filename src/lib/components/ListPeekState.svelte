<script lang="ts">
  import type { PeekRow } from "$lib/domain/folder-peek";
  let { row, carets }: { row: Extract<PeekRow, { kind: "peek-state" }>; carets: boolean } = $props();
</script>

<!-- Both compact cards and full-flow columns preserve the folder's status
     identity for accessibility and every shared drop transport. -->
<div class="list-peek-state peek-drop-target" class:carets data-path={row.parentPath}
  data-peek-state={row.parentPath} style:--depth={row.depth}
  role="treeitem" aria-level={row.depth + 1} aria-selected="false">
  <span role="status">{row.message}</span>
</div>

<style>
  .list-peek-state {
    height: calc(var(--list-slot-height, 30px) - 4px);
    margin: 2px 0;
    display: flex;
    align-items: center;
    padding-left: calc(11px + var(--depth) * 16px);
    color: var(--text-tertiary);
    font-size: 13px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .list-peek-state.carets { padding-left: calc(27px + var(--depth) * 16px); }
</style>

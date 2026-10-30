<!--
  A lineage group row in List (lineage peek §4.3): "with B" over the edits a
  file shares with other parents. Not a file (never selected or dragged); a
  drop on it falls through to the pane's folder. A click toggles it and
  previews the parents it combines.
-->
<script lang="ts">
  import type { PeekRow } from "$lib/domain/folder-peek";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { lineageCoParentEntry } from "$lib/domain/lineage-co-parent";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import FileIcon from "./FileIcon.svelte";
  let { row, carets, explorer }: { row: Extract<PeekRow, { kind: "lineage-group" }>; carets: boolean; explorer: ExplorerInstance } = $props();
  const paneId = getPaneIdContext();
  const first = $derived(row.group.coParents[0]);
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -- keyboard users toggle the group through Peek into Folder from a member. -->
<div class="list-lineage-group" class:carets class:expanded={row.expanded} data-lineage-group={row.group.id}
  style:--depth={row.depth} role="treeitem" aria-level={row.depth + 1} aria-selected="false" aria-expanded={row.expanded} tabindex="-1"
  onclick={() => {
    if (paneId) windowTabsManager.setActivePane(paneId);
    void explorer.togglePeek(row.group.id);
    explorer.showLineageGroupPreview(row.group);
  }}>
  <span class="caret" aria-hidden="true">
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d={row.expanded ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </span>
  {#if first}<span class="icon" aria-hidden="true"><FileIcon entry={lineageCoParentEntry(first)} size="small" /></span>{/if}
  <span class="label">{row.group.label}</span>
  <span class="count">{row.group.members.length}</span>
</div>

<style>
  .list-lineage-group {
    height: calc(var(--list-slot-height, 30px) - 4px); margin: 2px 0; display: flex; align-items: center; gap: 5px;
    padding-left: calc(1px + var(--depth) * 16px); color: var(--text-secondary); font-size: 13px;
    white-space: nowrap; overflow: hidden; cursor: pointer; border-radius: var(--radius-sm);
  }
  .list-lineage-group:hover { background: var(--subtle-fill-secondary); }
  .list-lineage-group.carets { padding-left: calc(9px + var(--depth) * 16px); }
  .caret { display: flex; width: 12px; justify-content: center; }
  .icon { display: flex; width: 16px; height: 16px; opacity: .85; }
  .label { font-style: italic; overflow: hidden; text-overflow: ellipsis; }
  .expanded .label { color: var(--text-primary); }
  .count { color: var(--text-tertiary); font-size: 12px; }
</style>

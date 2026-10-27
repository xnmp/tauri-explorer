<!--
  A lineage group row (lineage peek §3): "with B" over the children a file
  shares with other parents. It is not a file: never selected or dragged, and
  a drop on it falls through to the pane, which targets the current folder.
  A click toggles it; Preview shows the parents it combines.
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import type { PeekGroup } from "$lib/domain/folder-peek";
  import type { LineageGroup } from "$lib/domain/entry-lineage";
  import { lineageCoParentEntry } from "$lib/domain/entry-lineage";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import FileIcon from "./FileIcon.svelte";
  import PeekGuides from "./PeekGuides.svelte";

  interface Props {
    explorer: ExplorerInstance;
    group: LineageGroup;
    depth: number;
    expanded: boolean;
    carets: boolean;
    groups: readonly PeekGroup[];
    rowIndex: number;
  }
  let { explorer, group, depth, expanded, carets, groups, rowIndex }: Props = $props();
  const paneId = getPaneIdContext();
  const first = $derived(group.coParents[0]);
  const icon = $derived(first ? lineageCoParentEntry(first) : null);
  const label = $derived(`${expanded ? "Collapse" : "Expand"} ${group.label}`);
  function toggle() {
    if (paneId) windowTabsManager.setActivePane(paneId);
    void explorer.togglePeek(group.id);
    explorer.showLineageGroupPreview(group);
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -- keyboard users toggle the group through Peek into Folder from a member (pane-owned keys). -->
<div role="gridcell" tabindex="-1" class="lineage-group" class:expanded data-lineage-group={group.id}
  aria-label={label} style:--peek-indent={`${depth * 22}px`} onclick={toggle}>
  <PeekGuides {groups} row={rowIndex} {carets} />
  <div class="name" style:padding-left={`${depth * 22}px`}>
    <span class="caret-slot" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        <path d={expanded ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </span>
    {#if icon}<span class="icon" aria-hidden="true"><FileIcon entry={icon} size="small" /></span>{/if}
    <span class="label">{group.label}</span>
    <span class="count">{group.members.length}</span>
  </div>
</div>

<style>
  .lineage-group { position: relative; height: var(--details-row-height, 32px); display: flex; align-items: center; padding: 0 16px; box-sizing: border-box; cursor: pointer; color: var(--text-secondary); font-size: 13px; border-radius: var(--radius-sm); }
  .lineage-group:hover { background: var(--subtle-fill-secondary); }
  .name { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .caret-slot { width: 22px; flex: 0 0 22px; margin-right: -4px; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); }
  .icon { display: flex; width: 16px; height: 16px; opacity: .85; }
  .label { font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .expanded .label { color: var(--text-primary); }
  .count { color: var(--text-tertiary); font-size: 12px; }
</style>

<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  let { entry, expanded, explorer }: { entry: FileEntry; expanded: boolean; explorer: ExplorerInstance } = $props();
  const paneId = getPaneIdContext();
</script>

<!-- Caret-less peek's toggle for a lineage parent (#1448). Unlike Open it stays
     visible: nothing else on the row says the file has edits grouped under it.
     Like the caret it is a pointer affordance within the row's roving focus
     model; keyboard users toggle with the palette's Peek commands. -->
<button class="peek-toggle" type="button" draggable={false} tabindex="-1"
  aria-expanded={expanded} aria-label={`${expanded ? "Collapse" : "Expand"} ${entry.name}`}
  title={expanded ? "Hide edits" : "Show edits"}
  onmousedown={(event) => event.preventDefault()}
  onclick={() => {
    if (paneId) windowTabsManager.setActivePane(paneId);
    void explorer.togglePeek(entry.path);
  }}>
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d={expanded ? "M2 3.5 5 6.5 8 3.5" : "M3.5 2 6.5 5 3.5 8"} stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</button>

<style>
  .peek-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 22px;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }
  .peek-toggle:hover { background: var(--subtle-fill-tertiary); color: var(--text-primary); }
  .peek-toggle:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
</style>

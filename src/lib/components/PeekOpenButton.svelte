<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  let { entry, explorer }: { entry: FileEntry; explorer: ExplorerInstance } = $props();
  const paneId = getPaneIdContext();
</script>

<!-- Like the peek caret, this is a pointer affordance within the row's roving
     focus model. Keyboard users enter the focused folder with Open (Enter). -->
<button class="peek-open" type="button" draggable={false} tabindex="-1"
  aria-label={`Open ${entry.name}`} title={`Open ${entry.name}`}
  onmousedown={(event) => event.preventDefault()}
  onclick={() => {
    if (paneId) windowTabsManager.setActivePane(paneId);
    void explorer.navigateTo(entry.path);
  }}>
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M9 2.5h4v11H9M2.5 8h7M6.5 5l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</button>

<style>
  .peek-open {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 22px;
    margin-left: auto;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
  }
  :global(.entry-item:is(:hover, :focus-within)) > .peek-open,
  :global(.entry-item:is(:hover, :focus-within) .name-cell) > .peek-open {
    opacity: 1;
    pointer-events: auto;
  }
  .peek-open:hover { background: var(--subtle-fill-tertiary); color: var(--text-primary); }
  .peek-open:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: -2px; }
</style>

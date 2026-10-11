<!--
  Demo file view (SDK 2): a card listing of the pane's entries plus one
  plugin-owned "virtual card" shown through a Preview target. It exercises
  the pane-scoped handle: selection, open, context menu, Preview targets and
  the pane's tile size. Its "Demo tiles" section uses `ui/file-tiles`
  without `size`, as plugins built before "tileSize" do.
-->
<script lang="ts">
  import type { FileViewPane } from "$lib/plugins/file-view-registry.svelte";
  import FileTiles from "$lib/components/FileTiles.svelte";

  let { pane, onGreet }: { pane: FileViewPane; onGreet: () => void } = $props();
  const selected = $derived(new Set(pane.selection.map((entry) => entry.path)));
  const target = $derived(pane.previewTarget);

  function showVirtual(): void {
    pane.setPreviewTarget({
      id: "demo:virtual",
      title: "Virtual card",
      typeLabel: "DEMO",
      // An image in the e2e mock filesystem; where it is missing, Preview
      // shows its "No preview available" fallback instead.
      imagePath: "/home/user/Pictures/screenshot.png",
      badge: "Unsaved",
      details: [{ label: "Source", value: "Demo plugin" }],
      actions: [{ id: "greet", label: "Greet", title: "Show a greeting", run: onGreet }],
      data: { demo: true },
    });
  }
</script>

<div class="demo-cards" data-testid="demo-file-view">
  {#if pane.tileSize}
    <span class="tile-size" data-testid="demo-tile-size" data-preset={pane.tileSize.preset} data-image-px={pane.tileSize.imagePx}>Tiles: {pane.tileSize.preset} ({pane.tileSize.imagePx}px)</span>
  {/if}
  <button type="button" class="card virtual" class:selected={target?.id === "demo:virtual"} onclick={showVirtual}>Virtual card</button>
  {#each pane.entries as entry (entry.path)}
    <button type="button" class="card" class:selected={selected.has(entry.path)} data-path={entry.path}
      onclick={(event) => pane.select(entry, { ctrlKey: event.ctrlKey || event.metaKey, shiftKey: event.shiftKey })}
      ondblclick={() => void pane.open(entry)}
      oncontextmenu={(event) => pane.contextMenu(event, entry)}>{entry.name}</button>
  {/each}
  <section class="demo-tiles">
    <FileTiles entries={pane.entries.slice(0, 3)} {selected} label="Demo tiles"
      onselect={(entry) => pane.select(entry)} onopen={(entry) => void pane.open(entry)}
      onmenu={(entry, event) => pane.contextMenu(event, entry)} />
  </section>
</div>

<style>
  .demo-cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px; overflow: auto; }
  .card { min-width: 120px; padding: 12px; font: inherit; color: var(--text-primary); background: var(--control-fill); border: 1px solid var(--control-stroke); border-radius: var(--radius-sm); cursor: pointer; }
  .card.selected { border-color: var(--accent-text); }
  .virtual { border-style: dashed; }
  .tile-size { flex-basis: 100%; color: var(--text-secondary); }
  .demo-tiles { flex-basis: 100%; }
</style>

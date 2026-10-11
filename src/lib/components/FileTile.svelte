<!-- `ui/file-tile`: a single cell. No grid, row, navigation or drag ownership.
     TileSurface and TileVisual are also the built-in Tiles view's chrome and
     content, so plugins get the same rendering without owning its markup. -->
<script lang="ts">
  import type { FileTileProps } from "$lib/plugins/api";
  import { isThumbnailSize, tileLayout } from "$lib/domain/tile-layout";
  import { isVideoMediaFile } from "$lib/domain/file-types";
  import { parentDir } from "$lib/domain/path";
  import { useEntryAppearance } from "$lib/composables/use-entry-appearance.svelte";
  import { getTileSizeContext } from "$lib/state/tile-size-context";
  import { getPaneIdContext } from "$lib/state/pane-context";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import TileSurface from "./TileSurface.svelte";
  import TileVisual from "./TileVisual.svelte";
  import EntryName from "./EntryName.svelte";
  import EntryNameLabel from "./EntryNameLabel.svelte";
  import EntrySymlinkBadge from "./EntrySymlinkBadge.svelte";
  import GitStatusBadge from "./GitStatusBadge.svelte";

  let { entry, selected, focused = false, size, onselect, onopen, onmenu,
    onfocus, onkeydown, column, videoUnavailable = false, onvideounavailable }: FileTileProps = $props();
  const paneSize = getTileSizeContext();
  const paneId = getPaneIdContext();
  const explorer = $derived(paneId ? windowTabsManager.getExplorer(paneId) : undefined);
  const layout = $derived(tileLayout(isThumbnailSize(size) ? size : (paneSize?.() ?? settingsStore.thumbnailSize)));
  const appearance = useEntryAppearance(() => entry, () => parentDir(entry.path));
  const renaming = $derived(!!explorer && dialogStore.renamingEntry?.path === entry.path);
  // Path identity keeps a failed video's fallback from leaking to another
  // entry when a plugin reuses this component for a different path.
  let unavailablePath = $state<string | null>(null);
</script>

<TileSurface cell {layout} role="gridcell"
  class="entry-item{entry.kind === 'directory' ? ' directory' : ''}{selected ? ' selected' : ''}{appearance.cut ? ' cut' : ''}{appearance.inClipboard ? ' in-clipboard' : ''}{appearance.hidden ? ' hidden-entry' : ''}{appearance.emptyFolder ? ' empty-folder' : ''}"
  data-path={entry.path} data-entry-path={entry.path}
  aria-label={isVideoMediaFile(entry) ? `${entry.name}, video` : undefined}
  aria-selected={selected} aria-colindex={column}
  tabindex={focused && !renaming ? 0 : -1}
  {onfocus} {onkeydown}
  onclick={(event) => onselect(entry, event)}
  ondblclick={() => { if (!renaming) onopen(entry); }}
  oncontextmenu={(event) => { event.preventDefault(); onmenu(entry, event); }}>
  <TileVisual {entry} {layout} videoUnavailable={videoUnavailable || unavailablePath === entry.path}
    onvideounavailable={() => { unavailablePath = entry.path; onvideounavailable?.(entry); }}>
    {#snippet name()}
      {#if explorer && renaming}
        <EntryName {entry} {explorer} variant="tiles" />
      {:else}
        <EntryNameLabel name={entry.name} variant="tiles" />
      {/if}
    {/snippet}
  </TileVisual>
  <GitStatusBadge entryName={entry.name} />
  <EntrySymlinkBadge {entry} {renaming} />
</TileSurface>

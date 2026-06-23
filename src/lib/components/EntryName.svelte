<!--
  EntryName - Shared inline rename input/display for all view modes.
  Consolidates useInlineRename composable wiring, dialogStore.renamingEntry
  derivation, focus $effect, and rename-or-display template.
  Issue: #108
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { useInlineRename } from "$lib/composables/use-inline-rename.svelte";

  interface Props {
    entry: FileEntry;
    explorer: ExplorerInstance;
    variant: "details" | "list" | "tiles";
  }

  let { entry, explorer, variant }: Props = $props();

  const rename = useInlineRename(() => explorer);

  const isRenaming = $derived(dialogStore.renamingEntry?.path === entry.path);

  // Focus and select the rename input when rename mode starts.
  // Keyed on the rename session (the renaming entry's path), NOT on `entry`
  // identity: silent refreshes mid-rename replace the entry object, and
  // re-running focusAndSelect would wipe the user's typed name.
  let focusedRenamePath: string | null = null;

  $effect(() => {
    const renamingPath = dialogStore.renamingEntry?.path ?? null;
    const input = rename.renameInputRef;
    untrack(() => {
      if (!renamingPath) {
        focusedRenamePath = null;
        return;
      }
      if (renamingPath !== entry.path || !input) return;
      if (focusedRenamePath === renamingPath) return;
      focusedRenamePath = renamingPath;
      rename.focusAndSelect(entry);
      if (variant === "tiles") tick().then(autoGrowTileRename);
    });
  });

  /** Grow the tile rename box vertically to fit its (wrapped) content so the
   *  whole name is visible however long it is, without ever scrolling. The box
   *  is full tile width and stays in-flow, so it can't overflow the pane edge
   *  or oversize for short names. */
  function autoGrowTileRename(): void {
    const el = rename.renameInputRef;
    if (!(el instanceof HTMLTextAreaElement)) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + 2}px`;
  }
</script>

{#if isRenaming}
  {#if variant === "tiles"}
    <div class="tile-rename-anchor">
      <!-- svelte-ignore a11y_autofocus -->
      <textarea
        class="rename-input tile-rename"
        class:error={!!rename.renameError}
        bind:value={rename.editedName}
        bind:this={rename.renameInputRef}
        oninput={autoGrowTileRename}
        onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
        onblur={() => rename.handleRenameBlur(entry.name)}
        onclick={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
        disabled={rename.submittingRename}
        rows="1"
        autofocus
      ></textarea>
    </div>
  {:else}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      type="text"
      class="rename-input"
      class:error={!!rename.renameError}
      bind:value={rename.editedName}
      bind:this={rename.renameInputRef}
      onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
      onblur={() => rename.handleRenameBlur(entry.name)}
      onclick={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
      disabled={rename.submittingRename}
      autofocus
    />
  {/if}
{:else}
  <span
    class="entry-name"
    class:name-details={variant === "details"}
    class:name-list={variant === "list"}
    class:name-tiles={variant === "tiles"}
    title={variant === "tiles" ? entry.name : undefined}
  >{entry.name}</span>
{/if}

<style>
  /* Rename input — shared across all variants */
  .rename-input {
    flex: 1;
    min-width: 0;
    padding: 2px 6px;
    margin: -3px 0;
    background: var(--control-fill);
    border: 1px solid var(--accent);
    border-radius: var(--radius-sm);
    font: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    box-shadow: 0 0 0 1px var(--accent);
  }

  .rename-input:focus {
    background: var(--control-fill-secondary);
  }

  .rename-input:disabled {
    opacity: 0.6;
  }

  .rename-input.error {
    border-color: var(--system-critical);
    box-shadow: 0 0 0 1px var(--system-critical);
  }

  .tile-rename-anchor {
    width: 100%;
  }

  .rename-input.tile-rename {
    /* In-flow, full tile width: never overflows the pane edge (so it can't be
       clipped near the left/right of the view) and never oversizes for short
       names. Long names wrap and the box grows in height (autoGrowTileRename)
       so the whole name stays visible. */
    display: block;
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    text-align: center;
    resize: none;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    font-size: 13px;
    /* Height is grown to fit content by autoGrowTileRename — never scroll. */
    overflow: hidden;
    background: var(--background-solid);
    box-shadow: 0 0 0 1px var(--accent), 0 8px 24px rgba(0, 0, 0, 0.25);
  }

  .rename-input.tile-rename:focus {
    background: var(--background-solid);
  }

  /* Name display — variant-specific styles */
  .name-details {
    font-size: 13px;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .name-list {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name-tiles {
    width: 100%;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    text-overflow: ellipsis;
    white-space: normal;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    padding-top: 1px;
  }
</style>

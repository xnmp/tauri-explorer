<!--
  EntryName - Shared inline rename input/display for all view modes.
  Consolidates useInlineRename composable wiring, dialogStore.renamingEntry
  derivation, focus $effect, and rename-or-display template.
  Issue: #108
-->
<script lang="ts">
  import { untrack } from "svelte";
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
    });
  });
</script>

{#if isRenaming}
  {#if variant === "tiles"}
    <!-- svelte-ignore a11y_autofocus -->
    <textarea
      class="rename-input tile-rename"
      class:error={!!rename.renameError}
      bind:value={rename.editedName}
      bind:this={rename.renameInputRef}
      onkeydown={(e) => rename.handleRenameKeydown(e, entry.name)}
      onblur={() => rename.handleRenameBlur(entry.name)}
      onclick={(e) => e.stopPropagation()}
      ondblclick={(e) => e.stopPropagation()}
      disabled={rename.submittingRename}
      rows="2"
      autofocus
    ></textarea>
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

  .rename-input.tile-rename {
    width: 100%;
    text-align: center;
    resize: none;
    line-height: 1.4;
    word-break: break-word;
    overflow-wrap: break-word;
    font-size: 13px;
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

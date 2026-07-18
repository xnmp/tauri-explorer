<!--
  Inline new folder creation input.
  Extracted from FileList.svelte — was duplicated across details/list/tiles views.
-->
<script lang="ts" module>
  import type { FileEntry } from "$lib/domain/file";

  /**
   * Sentinel entry the views prepend to their items while a folder is being
   * created, so the editor renders as the FIRST ROW INSIDE the virtualized
   * list instead of a band above the whole pane (#257). The NUL byte makes
   * the path impossible for a real entry.
   */
  export const NEW_FOLDER_SENTINEL: FileEntry = {
    name: "\u0000new-folder",
    kind: "directory",
    path: "\u0000new-folder",
    size: 0,
    modified: "",
  };

  export function isNewFolderSentinel(entry: FileEntry): boolean {
    return entry === NEW_FOLDER_SENTINEL;
  }
</script>

<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import FileIcon from "./FileIcon.svelte";
  import { tick } from "svelte";

  interface Props {
    explorer: ExplorerInstance;
    variant: "details" | "list" | "tiles";
  }

  let { explorer, variant }: Props = $props();

  const isFile = $derived(explorer.newEntryKind === "file");
  // Preview entry used solely to pick the correct icon for the inline row.
  const iconEntry = $derived<FileEntry>(
    isFile
      ? { name: "New File", kind: "file", path: "", size: 0, modified: "" }
      : { name: "New folder", kind: "directory", path: "", size: 0, modified: "" }
  );

  let newFolderName = $state("New folder");
  let newFolderInput = $state<HTMLInputElement | null>(null);
  let newFolderError = $state<string | null>(null);
  let submitting = $state(false);

  function getNextName(): string {
    const base = isFile ? "New File" : "New folder";
    const kind = isFile ? "file" : "directory";
    const existingNames = new Set(
      explorer.displayEntries
        .filter((e) => e.kind === kind)
        .map((e) => e.name.toLowerCase())
    );
    if (!existingNames.has(base.toLowerCase())) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base} ${i}`;
      if (!existingNames.has(candidate.toLowerCase())) return candidate;
    }
  }

  $effect(() => {
    if (explorer.isCreatingFolder && newFolderInput) {
      newFolderName = getNextName();
      newFolderError = null;
      tick().then(() => {
        newFolderInput?.focus();
        newFolderInput?.select();
      });
    }
  });

  async function confirmNewFolder(): Promise<void> {
    // Guard against double submission — Enter triggers confirm and the
    // resulting blur would otherwise call createFolder a second time.
    if (submitting) return;
    const name = newFolderName.trim();
    if (!name) {
      explorer.cancelInlineNewFolder();
      return;
    }
    submitting = true;
    try {
      const error = isFile
        ? await explorer.createFile(name)
        : await explorer.createFolder(name);
      if (error) {
        newFolderError = error;
      }
    } finally {
      submitting = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmNewFolder();
    } else if (event.key === "Escape") {
      event.preventDefault();
      explorer.cancelInlineNewFolder();
    }
  }
</script>

{#if variant === "details"}
  <div class="inline-new-folder">
    <span class="new-folder-icon">
      <FileIcon entry={iconEntry} size="small" />
    </span>
    <input
      type="text"
      class="new-folder-input"
      bind:value={newFolderName}
      bind:this={newFolderInput}
      onkeydown={handleKeydown}
      onblur={() => confirmNewFolder()}
      class:error={newFolderError !== null}
    />
    {#if newFolderError}
      <span class="new-folder-error">{newFolderError}</span>
    {/if}
  </div>
{:else if variant === "list"}
  <div class="inline-new-folder list-inline-new-folder">
    <span class="list-icon">
      <FileIcon entry={iconEntry} size="small" />
    </span>
    <input
      type="text"
      class="new-folder-input"
      bind:value={newFolderName}
      bind:this={newFolderInput}
      onkeydown={handleKeydown}
      onblur={() => confirmNewFolder()}
      class:error={newFolderError !== null}
    />
    {#if newFolderError}
      <span class="new-folder-error">{newFolderError}</span>
    {/if}
  </div>
{:else}
  <div class="tile-item tile-inline-new-folder">
    <div class="tile-icon">
      <FileIcon entry={iconEntry} size="large" />
    </div>
    <input
      type="text"
      class="new-folder-input tile-new-folder-input"
      bind:value={newFolderName}
      bind:this={newFolderInput}
      onkeydown={handleKeydown}
      onblur={() => confirmNewFolder()}
      class:error={newFolderError !== null}
    />
    {#if newFolderError}
      <span class="new-folder-error">{newFolderError}</span>
    {/if}
  </div>
{/if}

<style>
  .inline-new-folder {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 12px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .new-folder-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  .new-folder-input {
    flex: 1;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--accent);
    border-radius: 3px;
    background: var(--control-fill);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    outline: none;
  }

  .new-folder-input.error {
    border-color: #c42b1c;
  }

  .new-folder-error {
    font-size: 11px;
    color: #c42b1c;
    white-space: nowrap;
  }

  /* List view variant */
  .list-inline-new-folder {
    padding: 4px 8px;
    height: auto;
  }

  .list-inline-new-folder .list-icon {
    display: flex;
    align-items: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  /* Tiles view variant */
  .tile-inline-new-folder {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: var(--tile-padding, 12px 8px 10px);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-radius: var(--radius-md, 6px);
    height: fit-content;
  }

  .tile-new-folder-input {
    width: 100%;
    text-align: center;
    font-size: 13px;
  }

  .tile-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tile-icon-size, 64px);
    height: var(--tile-icon-size, 64px);
    flex-shrink: 0;
  }

  /* Scale the SVG to match the current tile size */
  .tile-icon > :global(svg) {
    transform: scale(var(--tile-icon-scale, 1));
  }

  .tile-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
</style>

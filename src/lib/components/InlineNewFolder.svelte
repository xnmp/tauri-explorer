<!--
  Inline new folder creation input.
  Extracted from FileList.svelte — was duplicated across details/list/tiles views.
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { tick } from "svelte";

  interface Props {
    explorer: ExplorerInstance;
    variant: "details" | "list" | "tiles";
  }

  let { explorer, variant }: Props = $props();

  let newFolderName = $state("New folder");
  let newFolderInput: HTMLInputElement | null = null;
  let newFolderError = $state<string | null>(null);

  function getNextFolderName(): string {
    const base = "New folder";
    const existingNames = new Set(
      explorer.displayEntries
        .filter((e) => e.kind === "directory")
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
      newFolderName = getNextFolderName();
      newFolderError = null;
      tick().then(() => {
        newFolderInput?.focus();
        newFolderInput?.select();
      });
    }
  });

  async function confirmNewFolder(): Promise<void> {
    const name = newFolderName.trim();
    if (!name) {
      explorer.cancelInlineNewFolder();
      return;
    }
    const error = await explorer.createFolder(name);
    if (error) {
      newFolderError = error;
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#ffb900"/>
      </svg>
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
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 5C2 4.44772 2.44772 4 3 4H5.58579C5.851 4 6.10536 4.10536 6.29289 4.29289L7 5H13C13.5523 5 14 5.44772 14 6V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V5Z" fill="#ffb900"/>
      </svg>
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
      <svg width="64" height="64" viewBox="0 0 48 48" fill="none">
        <path d="M4 14C4 11.79 5.79 10 8 10H16.34C17.4 10 18.42 10.42 19.17 11.17L22 14H40C42.21 14 44 15.79 44 18V37C44 39.21 42.21 41 40 41H8C5.79 41 4 39.21 4 37V14Z" fill="#e8a800"/>
        <path d="M2 22C2 20.34 3.34 19 5 19H43C44.66 19 46 20.34 46 22V39C46 40.66 44.66 42 43 42H5C3.34 42 2 40.66 2 39V22Z" fill="#f0b400"/>
      </svg>
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
    gap: 6px;
    padding: 10px 6px 8px;
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    border-radius: 6px;
    height: fit-content;
  }

  .tile-new-folder-input {
    width: 100%;
    text-align: center;
    font-size: 11px;
  }

  .tile-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 64px;
    height: 64px;
    flex-shrink: 0;
  }

  .tile-item {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
</style>

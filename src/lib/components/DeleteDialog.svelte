<!--
  DeleteDialog component - Windows 11 Fluent Design
  Issue: tauri-explorer-h3n, tauri-explorer-w0eo, tauri-explorer-1k9k
-->
<script lang="ts">
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { isUncPath } from "$lib/domain/path";
  import Modal from "./Modal.svelte";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  function handleConfirm() {
    const entries = [...dialogStore.deletingEntries];
    // UNC/WSL paths can't go to the Recycle Bin — the delete is permanent
    // regardless of the user's choice, so report it as such.
    const isPermanent = dialogStore.isPermanentDelete || entries.some((e) => isUncPath(e.path));
    const isMultiple = entries.length > 1;
    // Close the dialog immediately — progress and completion are reported
    // through toast notifications so the UI doesn't appear stuck.
    dialogStore.cancelDelete();
    if (entries.length === 0) return;

    let pendingToastId: number | undefined;
    if (isMultiple || entries[0].kind === "directory") {
      pendingToastId = toastStore.show(
        isMultiple ? `Deleting ${entries.length} items…` : `Deleting ${entries[0].name}…`,
        "info",
        { duration: 30_000 },
      );
    }

    void explorer.confirmDelete(entries, isPermanent).then((errMsg) => {
      if (pendingToastId !== undefined) toastStore.dismiss(pendingToastId);
      if (errMsg) {
        toastStore.error(`Delete failed: ${errMsg}`);
      } else {
        const summary = isMultiple
          ? `${isPermanent ? "Deleted" : "Moved to trash"}: ${entries.length} items`
          : `${isPermanent ? "Deleted" : "Moved to trash"}: ${entries[0].name}`;
        toastStore.success(summary);
      }
    });
  }

  function handleCancel() {
    dialogStore.cancelDelete();
  }

  function handleKeydown(event: KeyboardEvent) {
    // Enter confirms — unless a button has focus (e.g. the user tabbed to
    // Cancel), in which case the button's own activation must win.
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      event.stopPropagation();
      handleConfirm();
    }
  }
</script>

<Modal
  open={dialogStore.deletingEntries.length > 0}
  onClose={handleCancel}
  overlayClass="overlay"
  role="alertdialog"
  labelledby="dialog-title"
  describedby="dialog-description"
  onkeydown={handleKeydown}
>
  {@const entries = dialogStore.deletingEntries}
  {@const isMultiple = entries.length > 1}
  {@const singleEntry = entries[0]}
  {@const hasFolders = entries.some((e) => e.kind === "directory")}
  {@const forcedByLocation = !dialogStore.isPermanentDelete && entries.some((e) => isUncPath(e.path))}
  {@const isPermanent = dialogStore.isPermanentDelete || forcedByLocation}
  <div class="dialog modal-card">
    <div class="dialog-icon">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="14" stroke="currentColor" stroke-width="2"/>
        <path d="M16 9V18M16 23V21" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    </div>

    <div class="dialog-content">
      {#if isMultiple}
        <h2 id="dialog-title">{isPermanent ? "Permanently delete" : "Delete"} {entries.length} items?</h2>
        <p id="dialog-description" class="message">
          {#if isPermanent}
            These {entries.length} items will be <strong>permanently deleted</strong>. This cannot be undone.
          {:else}
            These {entries.length} items will be moved to the Recycle Bin.
          {/if}
          {#if hasFolders}
            <span class="info">Folders and all their contents will also be {isPermanent ? "deleted" : "moved"}.</span>
          {/if}
          {#if forcedByLocation}
            <span class="info">Items on WSL or network locations can't be sent to the Recycle Bin.</span>
          {/if}
        </p>
        <div class="entry-list">
          {#each entries.slice(0, 5) as entry}
            <span class="entry-name">{entry.name}</span>
          {/each}
          {#if entries.length > 5}
            <span class="entry-more">and {entries.length - 5} more...</span>
          {/if}
        </div>
      {:else if singleEntry}
        <h2 id="dialog-title">{isPermanent ? "Permanently delete" : "Delete"} {singleEntry.kind === "directory" ? "folder" : "file"}?</h2>
        <p id="dialog-description" class="message">
          {#if isPermanent}
            <strong>{singleEntry.name}</strong> will be <strong>permanently deleted</strong>. This cannot be undone.
          {:else}
            <strong>{singleEntry.name}</strong> will be moved to the Recycle Bin.
          {/if}
          {#if singleEntry.kind === "directory"}
            <span class="info">All files and folders inside will also be {isPermanent ? "deleted" : "moved"}.</span>
          {/if}
          {#if forcedByLocation}
            <span class="info">Items on WSL or network locations can't be sent to the Recycle Bin.</span>
          {/if}
        </p>
      {/if}
    </div>

    <div class="dialog-actions">
      <button type="button" class="btn secondary" onclick={handleCancel}>
        Cancel
      </button>
      <button type="button" class="btn danger" onclick={handleConfirm}>
        Delete{#if isMultiple} ({entries.length}){/if}
      </button>
    </div>
  </div>
</Modal>

<style>
  .dialog {
    max-width: 420px;
  }

  .dialog-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    margin: 0 auto var(--spacing-lg);
    color: var(--system-critical);
    animation: iconPulse 600ms ease-out;
  }

  @keyframes iconPulse {
    0% { transform: scale(0.8); opacity: 0; }
    50% { transform: scale(1.05); }
    100% { transform: scale(1); opacity: 1; }
  }

  .dialog-content {
    text-align: center;
    margin-bottom: var(--spacing-xl);
  }

  .dialog-content h2 {
    margin: 0 0 var(--spacing-sm);
    font-size: var(--font-size-subtitle);
    font-weight: 600;
    color: var(--text-primary);
  }

  .message {
    margin: 0;
    font-size: var(--font-size-body);
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .message strong {
    color: var(--text-primary);
    word-break: break-all;
  }

  .info {
    display: block;
    margin-top: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    background: linear-gradient(135deg, rgba(0, 120, 212, 0.08), rgba(0, 120, 212, 0.04));
    border: 1px solid rgba(0, 120, 212, 0.15);
    border-radius: var(--radius-sm);
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
  }

  .entry-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: var(--spacing-sm);
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--subtle-fill-secondary);
    border-radius: var(--radius-sm);
    max-height: 120px;
    overflow-y: auto;
    text-align: left;
  }

  .entry-name {
    font-size: var(--font-size-caption);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-more {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
    font-style: italic;
  }

  /* Confirm dialogs center their actions (extra .dialog level beats the
     shared .modal-card .dialog-actions rule from modal.css). */
  .dialog .dialog-actions {
    justify-content: center;
    margin-top: 0;
  }
</style>

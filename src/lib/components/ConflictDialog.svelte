<!--
  ConflictDialog component - File conflict resolution during paste
  Issue: tauri-zqdp
-->
<script lang="ts">
  import { conflictResolver, type ConflictChoice } from "$lib/state/conflict-resolver.svelte";
  import { formatSize } from "$lib/domain/file";
  import { formatDate } from "$lib/domain/file-types";
  import Modal from "./Modal.svelte";

  const conflict = $derived(conflictResolver.activeConflict);

  let cancelButtonEl: HTMLButtonElement | undefined = $state();

  // Focus the safe default (Cancel) when the dialog opens so keyboard users
  // aren't stranded (Modal only claims focus if nothing inside has it).
  $effect(() => {
    if (conflict) {
      cancelButtonEl?.focus();
    }
  });

  function handleChoice(choice: ConflictChoice, applyToAll = false): void {
    conflictResolver.resolve(choice, applyToAll);
  }
</script>

<Modal
  open={!!conflict}
  onClose={() => handleChoice("cancel")}
  overlayClass="conflict-overlay"
  role="alertdialog"
  label="File conflict"
  closeOnBackdrop={false}
>
  {#if conflict}
    <div class="conflict-dialog">
      <div class="conflict-header">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L22 20H2L12 2Z" stroke="var(--system-caution)" stroke-width="1.5" fill="var(--system-caution)" fill-opacity="0.15"/>
          <path d="M12 10V14M12 17V16" stroke="var(--system-caution)" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <h3>File already exists</h3>
      </div>

      <p class="conflict-message">
        <strong>{conflict.fileName}</strong> already exists in this folder.
      </p>

      {#if (conflict.sourceSize && conflict.sourceSize > 0) || (conflict.destSize && conflict.destSize > 0) || conflict.sourceModified || conflict.destModified}
        <div class="conflict-details">
          {#if conflict.sourceSize || conflict.sourceModified}
            <div class="conflict-file">
              <span class="conflict-label">Source</span>
              {#if conflict.sourceSize && conflict.sourceSize > 0}
                <span class="conflict-meta">{formatSize(conflict.sourceSize)}</span>
              {/if}
              {#if conflict.sourceModified}
                <span class="conflict-meta">{formatDate(conflict.sourceModified)}</span>
              {/if}
            </div>
          {/if}
          {#if conflict.destSize || conflict.destModified}
            <div class="conflict-file">
              <span class="conflict-label">Existing</span>
              {#if conflict.destSize && conflict.destSize > 0}
                <span class="conflict-meta">{formatSize(conflict.destSize)}</span>
              {/if}
              {#if conflict.destModified}
                <span class="conflict-meta">{formatDate(conflict.destModified)}</span>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <div class="conflict-actions">
        <button class="btn btn-primary" onclick={() => handleChoice("overwrite")}>
          Replace
        </button>
        <button class="btn" onclick={() => handleChoice("skip")}>
          Skip
        </button>
        {#if conflict.remaining > 0}
          <div class="separator"></div>
          <button class="btn btn-primary" onclick={() => handleChoice("overwrite", true)}>
            Replace All ({conflict.remaining + 1})
          </button>
          <button class="btn" onclick={() => handleChoice("skip", true)}>
            Skip All ({conflict.remaining + 1})
          </button>
        {/if}
        <div class="separator"></div>
        <button class="btn btn-cancel" bind:this={cancelButtonEl} onclick={() => handleChoice("cancel")}>
          Cancel
        </button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .conflict-dialog {
    background: var(--background-solid);
    border: 1px solid var(--divider);
    border-radius: 8px;
    padding: 24px;
    min-width: 380px;
    max-width: 480px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  .conflict-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 16px;
  }

  .conflict-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .conflict-message {
    margin: 0 0 20px;
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    word-break: break-word;
  }

  .conflict-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: flex-end;
  }

  .separator {
    width: 100%;
    height: 0;
  }

  .btn {
    padding: 6px 16px;
    border: 1px solid var(--divider);
    border-radius: 4px;
    background: var(--control-fill);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 120ms ease;
  }

  .btn:hover {
    background: var(--subtle-fill-secondary);
  }

  .btn-primary {
    background: var(--accent);
    color: white;
    border-color: var(--accent);
  }

  .btn-primary:hover {
    opacity: 0.9;
  }

  .btn-cancel {
    color: var(--text-secondary);
  }

  .conflict-details {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px;
    background: var(--subtle-fill-secondary);
    border-radius: 6px;
    font-size: 12px;
  }

  .conflict-file {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .conflict-label {
    font-weight: 600;
    color: var(--text-primary);
    min-width: 80px;
  }

  .conflict-meta {
    color: var(--text-secondary);
  }
</style>

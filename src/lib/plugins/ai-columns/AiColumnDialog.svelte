<!--
  Add AI column (#1884, #1886): the user describes the property in words; the plugin
  turns the description into a Details column (`onSubmit`).
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import { AI_COLUMN_DESCRIPTION_MAX, normalizeDescription } from "$lib/domain/ai-column";

  interface Props {
    open: boolean;
    onSubmit: (description: string) => void;
    onClose: () => void;
  }

  let { open, onSubmit, onClose }: Props = $props();

  let description = $state("");
  const ready = $derived(normalizeDescription(description).length > 0);

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!ready) return;
    onSubmit(description);
    onClose();
  }
</script>

<Modal {open} {onClose} overlayClass="dialog-overlay" labelledby="ai-column-title">
  <form class="dialog plugin-dialog ai-column-dialog" onsubmit={submit}>
    <header class="dialog-header">
      <div class="header-content">
        <svg class="header-icon" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <rect x="2.5" y="3.5" width="15" height="13" rx="2" stroke="currentColor" stroke-width="1.4" />
          <path d="M12 3.5V16.5" stroke="currentColor" stroke-width="1.4" />
          <path d="M14.75 7.5L15.3 8.7L16.5 9.25L15.3 9.8L14.75 11L14.2 9.8L13 9.25L14.2 8.7Z" fill="currentColor" />
        </svg>
        <h2 id="ai-column-title">Add AI column</h2>
      </div>
      <button type="button" class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="dialog-body">
      <label class="prompt-field">
        <span class="prompt-label">What should the column show for each file?</span>
        <input class="prompt-input ai-column-description" type="text" autocorrect="off" autocapitalize="none" spellcheck="false" maxlength={AI_COLUMN_DESCRIPTION_MAX}
          placeholder={'e.g. "invoice date" or "is this an invoice?"'}
          bind:value={description} data-autofocus />
      </label>
      <p class="ai-column-note">A folder agent answers for every file of the folder in one job, reading only the files it needs (read-only). Answers are kept until a file changes; refresh the folder from this menu to ask again.</p>
      <div class="dialog-actions">
        <button type="button" class="btn btn-secondary" onclick={onClose}>Cancel</button>
        <button type="submit" class="btn btn-primary" disabled={!ready}>Add</button>
      </div>
    </div>
  </form>
</Modal>

<style>
  .ai-column-dialog { width: 440px; }
  .ai-column-note {
    margin: 0;
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-tertiary);
  }
</style>

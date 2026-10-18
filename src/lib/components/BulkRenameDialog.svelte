<!--
  BulkRenameDialog - Bulk rename files with patterns
  Issue: tauri-explorer-hyxy
-->
<script lang="ts">
  import { renameEntry } from "$lib/api/files";
  import Modal from "./Modal.svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { bulkRenamePlan } from "$lib/domain/bulk-rename";
  import { isWindows } from "$lib/domain/platform";

  interface Props {
    open: boolean;
    entries: FileEntry[];
    onClose: () => void;
    onComplete: () => void;
  }

  let { open, entries, onClose, onComplete }: Props = $props();

  let findPattern = $state("");
  let replaceWith = $state("");
  let useRegex = $state(false);
  let caseSensitive = $state(false);
  let isRenaming = $state(false);
  let error = $state<string | null>(null);

  // Reset inputs when the dialog is (re)opened so stale patterns from a
  // previous session don't apply silently.
  $effect(() => {
    if (open) {
      findPattern = "";
      replaceWith = "";
      useRegex = false;
      caseSensitive = false;
      error = null;
    }
  });

  const plan = $derived(bulkRenamePlan(entries, { find: findPattern, replace: replaceWith, regex: useRegex, caseSensitive }, isWindows));
  const previews = $derived(plan.previews);
  const changedCount = $derived(plan.changedCount);
  /** Target names that two files of one folder would end up with — renaming would clobber. */
  const duplicateTargets = $derived(plan.duplicates);

  const canRename = $derived(changedCount > 0 && duplicateTargets.length === 0 && !isRenaming);

  async function handleRename(): Promise<void> {
    if (!canRename) return;
    isRenaming = true;
    error = null;

    const failures: string[] = [];
    let renamedAny = false;
    // Deepest first: a renamed folder would invalidate its selected children.
    for (const { entry, name } of plan.operations) {
      const result = await renameEntry(entry.path, name);
      if (result.ok) {
        renamedAny = true;
      } else {
        failures.push(`"${entry.name}": ${result.error}`);
      }
    }

    isRenaming = false;
    // Refresh the list even on partial failure — some files were renamed.
    if (renamedAny) onComplete();
    if (failures.length > 0) {
      error = `Failed to rename ${failures.length} file${failures.length !== 1 ? "s" : ""} — ${failures.join("; ")}`;
    } else {
      onClose();
    }
  }

  // Escape is handled by Modal.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && canRename) handleRename();
  }
</script>

<Modal
  {open}
  {onClose}
  overlayClass="dialog-backdrop"
  label="Bulk rename"
  onkeydown={handleKeydown}
>
    <div class="dialog">
      <div class="dialog-header">
        <h2>Bulk Rename ({entries.length} files)</h2>
        <button class="close-btn" onclick={onClose}>×</button>
      </div>

      <div class="dialog-content">
        <div class="input-row">
          <label>
            <span>Find</span>
            <!-- svelte-ignore a11y_autofocus -- Modal traps focus and documents [autofocus] as its initial-focus mechanism (see Modal.svelte); the pattern field is the primary input for this dialog -->
            <input type="text" bind:value={findPattern} placeholder="Text to find..." autofocus />
          </label>
          <label>
            <span>Replace with</span>
            <input type="text" bind:value={replaceWith} placeholder="Replacement..." />
          </label>
        </div>

        <div class="options-row">
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={useRegex} />
            <span>Regex</span>
          </label>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={caseSensitive} />
            <span>Case sensitive</span>
          </label>
        </div>

        {#if error}
          <div class="error-msg">{error}</div>
        {/if}

        {#if duplicateTargets.length > 0}
          <div class="error-msg">
            Multiple files would be renamed to the same name: {duplicateTargets.join(", ")}. Adjust the pattern to keep names unique.
          </div>
        {/if}

        <div class="preview-list">
          <div class="preview-header">
            <span>Original</span>
            <span>Renamed</span>
          </div>
          {#each previews as preview}
            <div class="preview-row" class:changed={preview.changed}>
              <span class="original-name">{preview.original}</span>
              <span class="arrow">{preview.changed ? "→" : ""}</span>
              <span class="renamed-name" class:highlight={preview.changed}>{preview.renamed}</span>
            </div>
          {/each}
        </div>
      </div>

      <div class="dialog-footer">
        <span class="change-count">{changedCount} file{changedCount !== 1 ? "s" : ""} will be renamed</span>
        <div class="footer-actions">
          <button class="btn btn-secondary" onclick={onClose}>Cancel</button>
          <button class="btn btn-primary" onclick={handleRename} disabled={!canRename}>
            {isRenaming ? "Renaming..." : "Rename"}
          </button>
        </div>
      </div>
    </div>
</Modal>

<style>
  .dialog {
    background: var(--layer-default);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    width: 520px;
    max-height: 600px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24);
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .dialog-header h2 {
    margin: 0;
    font-size: var(--font-size-subtitle);
    font-weight: 600;
    color: var(--text-primary);
  }

  .close-btn {
    background: none;
    border: none;
    font-size: 20px;
    color: var(--text-tertiary);
    cursor: pointer;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .dialog-content {
    padding: 16px 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1;
  }

  .input-row {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .input-row label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .input-row label span {
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    font-weight: 500;
  }

  .input-row input[type="text"] {
    padding: 8px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: var(--font-size-body);
    color: var(--text-primary);
    outline: none;
  }

  .input-row input[type="text"]:focus {
    border-color: var(--accent);
  }

  .options-row {
    display: flex;
    gap: 16px;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--font-size-caption);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .error-msg {
    font-size: var(--font-size-caption);
    color: var(--system-critical-text, var(--system-critical));
    background: rgba(255, 0, 0, 0.1);
    padding: 8px 12px;
    border-radius: var(--radius-sm);
  }

  .preview-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 250px;
    overflow-y: auto;
    border: 1px solid var(--divider);
    border-radius: var(--radius-sm);
    padding: 4px;
  }

  .preview-header {
    display: grid;
    grid-template-columns: 1fr 24px 1fr;
    gap: 4px;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--divider);
  }

  .preview-row {
    display: grid;
    grid-template-columns: 1fr 24px 1fr;
    gap: 4px;
    padding: 4px 8px;
    font-size: var(--font-size-caption);
    border-radius: var(--radius-sm);
  }

  .preview-row.changed {
    background: rgba(0, 120, 212, 0.06);
  }

  .original-name {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .arrow {
    color: var(--text-tertiary);
    text-align: center;
  }

  .renamed-name {
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .renamed-name.highlight {
    color: var(--accent-text, var(--accent));
    font-weight: 500;
  }

  .dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-top: 1px solid var(--divider);
  }

  .change-count {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
  }

  .footer-actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    padding: 8px 16px;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: var(--font-size-caption);
    cursor: pointer;
    border: 1px solid var(--control-stroke);
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
    border-color: var(--accent);
  }

  .btn-primary:hover:not(:disabled) {
    opacity: 0.9;
  }

  .btn-primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--control-fill);
    color: var(--text-secondary);
  }

  .btn-secondary:hover {
    background: var(--control-fill-secondary);
  }
</style>

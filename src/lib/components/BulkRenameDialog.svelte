<!--
  BulkRenameDialog - Bulk rename files with patterns
  Issue: tauri-explorer-hyxy
-->
<script lang="ts">
  import { renameEntry } from "$lib/api/files";
  import type { FileEntry } from "$lib/domain/file";

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

  /** Preview the renamed filenames */
  const previews = $derived.by(() => {
    return entries.map((entry) => {
      const ext = entry.name.includes(".") ? entry.name.substring(entry.name.lastIndexOf(".")) : "";
      const nameWithoutExt = entry.name.includes(".") ? entry.name.substring(0, entry.name.lastIndexOf(".")) : entry.name;

      if (!findPattern) return { original: entry.name, renamed: entry.name, changed: false };

      try {
        let newName: string;
        if (useRegex) {
          const flags = caseSensitive ? "g" : "gi";
          const regex = new RegExp(findPattern, flags);
          newName = nameWithoutExt.replace(regex, replaceWith) + ext;
        } else {
          if (caseSensitive) {
            newName = nameWithoutExt.split(findPattern).join(replaceWith) + ext;
          } else {
            const regex = new RegExp(findPattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
            newName = nameWithoutExt.replace(regex, replaceWith) + ext;
          }
        }
        return { original: entry.name, renamed: newName, changed: newName !== entry.name };
      } catch {
        return { original: entry.name, renamed: entry.name, changed: false };
      }
    });
  });

  const changedCount = $derived(previews.filter((p) => p.changed).length);

  async function handleRename(): Promise<void> {
    if (changedCount === 0) return;
    isRenaming = true;
    error = null;

    for (let i = 0; i < entries.length; i++) {
      const preview = previews[i];
      if (!preview.changed) continue;

      const result = await renameEntry(entries[i].path, preview.renamed);
      if (!result.ok) {
        error = `Failed to rename "${entries[i].name}": ${result.error}`;
        break;
      }
    }

    isRenaming = false;
    if (!error) {
      onComplete();
      onClose();
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") onClose();
    if (event.key === "Enter" && changedCount > 0 && !isRenaming) handleRename();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onclick={onClose} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <div class="dialog-header">
        <h2>Bulk Rename ({entries.length} files)</h2>
        <button class="close-btn" onclick={onClose}>×</button>
      </div>

      <div class="dialog-content">
        <div class="input-row">
          <label>
            <span>Find</span>
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
          <button class="btn btn-primary" onclick={handleRename} disabled={changedCount === 0 || isRenaming}>
            {isRenaming ? "Renaming..." : "Rename"}
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .dialog-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

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
    color: var(--system-critical);
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
    color: var(--accent);
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
    transition: all var(--transition-fast);
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

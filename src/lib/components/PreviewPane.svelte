<!--
  PreviewPane component - File preview panel
  Issue: tauri-explorer-2c6b, tauri-explorer-xago, tauri-explorer-osjq
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { getThumbnailData, readTextFile } from "$lib/api/files";
  import { isImageFile, isTextFile, getFileType, formatDate } from "$lib/domain/file-types";
  import { formatSize, type FileEntry } from "$lib/domain/file";

  /** Currently selected file from the active explorer */
  const selectedFile = $derived.by((): FileEntry | null => {
    const explorer = windowTabsManager.getActiveExplorer();
    if (!explorer) return null;
    const selected = explorer.getSelectedEntries();
    return selected.length === 1 ? selected[0] : null;
  });

  // Preview content state
  let previewImageUrl = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);
  let lastPreviewPath = $state<string | null>(null);

  // Load preview when selection changes
  $effect(() => {
    const file = selectedFile;
    if (!file) {
      lastPreviewPath = null;
      previewImageUrl = null;
      previewText = null;
      previewError = null;
      previewLoading = false;
      return;
    }
    if (file.path === lastPreviewPath) return;
    loadPreview(file);
  });

  async function loadPreview(file: FileEntry): Promise<void> {
    lastPreviewPath = file.path;
    previewImageUrl = null;
    previewText = null;
    previewError = null;
    previewLoading = true;

    if (isImageFile(file)) {
      const result = await getThumbnailData(file.path, 512);
      if (file.path !== lastPreviewPath) return; // Stale
      if (result.ok) {
        previewImageUrl = result.data;
      } else {
        previewError = result.error;
      }
    } else if (isTextFile(file)) {
      const result = await readTextFile(file.path, 524288); // 512KB limit for preview
      if (file.path !== lastPreviewPath) return; // Stale
      if (result.ok) {
        previewText = result.data;
      } else {
        previewError = result.error;
      }
    }

    previewLoading = false;
  }
</script>

<div class="preview-pane">
  {#if !selectedFile}
    <div class="preview-empty">
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        <rect x="6" y="6" width="36" height="36" rx="4" stroke="currentColor" stroke-width="1.5" stroke-opacity="0.3"/>
        <path d="M18 20L24 26L30 20" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-opacity="0.3"/>
      </svg>
      <span>Select a file to preview</span>
    </div>
  {:else}
    <div class="preview-header">
      <span class="preview-filename" title={selectedFile.path}>{selectedFile.name}</span>
      <span class="preview-type">{getFileType(selectedFile)}</span>
    </div>

    <div class="preview-content">
      {#if previewLoading}
        <div class="preview-loading">
          <div class="spinner"></div>
        </div>
      {:else if previewImageUrl}
        <div class="preview-image-container">
          <img src={previewImageUrl} alt={selectedFile.name} class="preview-image" />
        </div>
      {:else if previewText !== null}
        <pre class="preview-text">{previewText}</pre>
      {:else if previewError}
        <div class="preview-empty">
          <span class="preview-error-text">{previewError}</span>
        </div>
      {:else}
        <div class="preview-empty">
          <span>No preview available</span>
        </div>
      {/if}
    </div>

    <div class="preview-info">
      {#if selectedFile.kind === "file"}
        <div class="info-row">
          <span class="info-label">Size</span>
          <span class="info-value">{formatSize(selectedFile.size)}</span>
        </div>
      {/if}
      <div class="info-row">
        <span class="info-label">Modified</span>
        <span class="info-value">{formatDate(selectedFile.modified)}</span>
      </div>
      <div class="info-row">
        <span class="info-label">Path</span>
        <span class="info-value path-value" title={selectedFile.path}>{selectedFile.path}</span>
      </div>
    </div>
  {/if}
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    width: 280px;
    min-width: 200px;
    max-width: 400px;
    border-left: 1px solid var(--divider);
    background: var(--layer-default);
    overflow: hidden;
  }

  .preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 12px;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    padding: 24px;
    text-align: center;
  }

  .preview-header {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .preview-filename {
    font-size: var(--font-size-body);
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-type {
    font-size: var(--font-size-caption);
    color: var(--text-tertiary);
  }

  .preview-content {
    flex: 1;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }

  .preview-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 24px;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .preview-image-container {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 12px;
    background: var(--subtle-fill-secondary);
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius-sm);
  }

  .preview-text {
    padding: 12px 16px;
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    flex: 1;
  }

  .preview-error-text {
    color: var(--system-critical);
    font-size: var(--font-size-caption);
  }

  .preview-info {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 16px;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: var(--font-size-caption);
  }

  .info-label {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .info-value {
    color: var(--text-secondary);
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path-value {
    direction: rtl;
    text-align: left;
  }
</style>

<!--
  PreviewPane component - File preview panel
  Issue: tauri-explorer-2c6b, tauri-explorer-xago, tauri-explorer-osjq
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { readTextFile, fetchDirectory } from "$lib/api/files";
  import { isImageFile, isTextFile, isPdfFile, getFileType, formatDate } from "$lib/domain/file-types";
  import { formatSize, type FileEntry } from "$lib/domain/file";
  import { isTauri } from "$lib/api/mock-invoke";
  import { highlightCode } from "$lib/domain/syntax-highlight";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";
  import FileIcon from "./FileIcon.svelte";
  import "highlight.js/styles/github-dark.css";

  // Resize handle state
  const DEFAULT_WIDTH = 280;
  const MIN_WIDTH = 160;
  const MAX_WIDTH = 600;
  let resizing = $state(false);
  let startX = 0;
  let startWidth = 0;

  const paneWidth = $derived(settingsStore.previewPaneWidth || DEFAULT_WIDTH);

  function handleResizeStart(event: MouseEvent): void {
    event.preventDefault();
    resizing = true;
    startX = event.clientX;
    startWidth = paneWidth;
    document.addEventListener("mousemove", handleResizeMove);
    document.addEventListener("mouseup", handleResizeEnd);
  }

  function handleResizeMove(event: MouseEvent): void {
    // Dragging left increases width (handle is on the left edge)
    const delta = startX - event.clientX;
    const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth + delta));
    settingsStore.setPreviewPaneWidth(newWidth);
  }

  function handleResizeEnd(): void {
    resizing = false;
    document.removeEventListener("mousemove", handleResizeMove);
    document.removeEventListener("mouseup", handleResizeEnd);
  }

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
  let previewHighlightedHtml = $state<string | null>(null);
  let previewPdfUrl = $state<string | null>(null);
  let previewFolderChildren = $state<readonly FileEntry[]>([]);
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
      previewHighlightedHtml = null;
      previewPdfUrl = null;
      previewFolderChildren = [];
      previewError = null;
      previewLoading = false;
      return;
    }
    if (file.path === lastPreviewPath) return;
    loadPreview(file);
  });

  /** Decode an image off the main thread so selection/animation aren't blocked */
  async function decodeImage(url: string): Promise<string> {
    const img = new Image();
    img.src = url;
    await img.decode();
    return url;
  }

  async function loadPreview(file: FileEntry): Promise<void> {
    lastPreviewPath = file.path;
    previewImageUrl = null;
    previewText = null;
    previewHighlightedHtml = null;
    previewPdfUrl = null;
    previewFolderChildren = [];
    previewError = null;
    previewLoading = true;

    if (file.kind === "directory") {
      const result = await fetchDirectory(file.path);
      if (file.path !== lastPreviewPath) return;
      if (result.ok) {
        previewFolderChildren = result.data.entries;
      }
      previewLoading = false;
      return;
    }

    if (isPdfFile(file)) {
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          previewPdfUrl = convertFileSrc(file.path);
        } catch {
          previewError = "Cannot preview PDF";
        }
      } else {
        previewError = "PDF preview requires Tauri runtime";
      }
      previewLoading = false;
      return;
    }

    if (isImageFile(file)) {
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          if (file.path !== lastPreviewPath) return; // Stale
          const url = convertFileSrc(file.path);
          // Decode off-screen — spinner stays visible until ready
          await decodeImage(url);
          if (file.path !== lastPreviewPath) return; // Stale after decode
          previewImageUrl = url;
        } catch {
          previewError = "Cannot preview image";
        }
      } else {
        previewError = "Image preview requires Tauri runtime";
      }
    } else if (isTextFile(file)) {
      const result = await readTextFile(file.path, 524288); // 512KB limit for preview
      if (file.path !== lastPreviewPath) return; // Stale
      if (result.ok) {
        previewText = result.data;
        // Syntax highlight for code files (defer to avoid blocking)
        try {
          previewHighlightedHtml = highlightCode(result.data, file.name);
        } catch {
          previewHighlightedHtml = null;
        }
      } else {
        previewError = result.error;
      }
    }

    previewLoading = false;
  }
</script>

<div class="preview-pane" class:resizing style="width: {paneWidth}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" onmousedown={handleResizeStart}></div>
  {#if !selectedFile}
    <div class="preview-empty">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
        <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.25"/>
        <polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.25"/>
      </svg>
      <span>Select a file to preview</span>
    </div>
  {:else}
    <div class="preview-header">
      <span class="preview-filename" title={selectedFile.path}>{selectedFile.name}</span>
      <span class="preview-type-badge">{getFileType(selectedFile)}</span>
    </div>

    <div class="preview-content">
      {#if previewLoading}
        <div class="preview-loading">
          <div class="spinner"></div>
        </div>
      {:else if previewPdfUrl}
        <div class="preview-pdf-container">
          <iframe src={previewPdfUrl} title={selectedFile.name} class="preview-pdf"></iframe>
        </div>
      {:else if previewImageUrl}
        <div class="preview-image-container">
          <img src={previewImageUrl} alt={selectedFile.name} class="preview-image" />
        </div>
      {:else if previewFolderChildren.length > 0}
        <div class="preview-folder-list">
          {#each previewFolderChildren as child}
            <div class="folder-item" class:is-directory={child.kind === "directory"}>
              <span class="folder-item-icon" style:color={child.kind !== "directory" ? getFileIconColor(child) : undefined}>
                <FileIcon entry={child} size="small" />
              </span>
              <span class="folder-item-name">{child.name}</span>
            </div>
          {/each}
        </div>
      {:else if previewHighlightedHtml !== null}
        <pre class="preview-text preview-code"><code class="hljs">{@html previewHighlightedHtml}</code></pre>
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
    </div>
  {/if}
</div>

<style>
  .preview-pane {
    display: flex;
    flex-direction: column;
    position: relative;
    flex-shrink: 0;
    border-left: 1px solid var(--divider);
    background: var(--background-card-secondary);
    overflow: hidden;
  }

  .preview-pane.resizing {
    user-select: none;
  }

  .resize-handle {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 10;
    transition: background var(--transition-normal);
  }

  .resize-handle:hover,
  .preview-pane.resizing .resize-handle {
    background: var(--accent);
    opacity: 0.6;
  }

  .preview-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    gap: 10px;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    padding: 32px;
    text-align: center;
  }

  .preview-header {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 16px 14px;
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

  .preview-type-badge {
    display: inline-flex;
    align-self: flex-start;
    font-size: 10px;
    line-height: 1;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    padding: 3px 8px;
    border-radius: var(--radius-pill);
    letter-spacing: 0.03em;
    text-transform: uppercase;
    font-weight: 500;
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
    width: 20px;
    height: 20px;
    border: 1.5px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .preview-pdf-container {
    flex: 1;
    display: flex;
  }

  .preview-pdf {
    width: 100%;
    height: 100%;
    border: none;
  }

  .preview-image-container {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    padding: 20px;
    background:
      repeating-conic-gradient(
        rgba(255, 255, 255, 0.03) 0% 25%,
        transparent 0% 50%
      ) 50% / 12px 12px;
  }

  .preview-image {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-card);
  }

  .preview-text {
    padding: 16px;
    font-family: "Cascadia Code", "Fira Code", "Consolas", monospace;
    font-size: 11px;
    line-height: 1.6;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    flex: 1;
  }

  .preview-code :global(.hljs) {
    background: transparent;
    padding: 0;
  }

  .preview-error-text {
    color: var(--system-critical);
    font-size: var(--font-size-caption);
  }

  .preview-info {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: 0;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    font-size: var(--font-size-caption);
    padding: 8px 16px;
    border-bottom: 1px solid var(--divider);
  }

  .info-row:last-child {
    border-bottom: none;
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

  .preview-folder-list {
    flex: 1;
    overflow: auto;
    padding: 4px 0;
  }

  .folder-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 16px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .folder-item.is-directory .folder-item-name {
    font-weight: 500;
    color: var(--text-primary);
  }

  .folder-item-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .folder-item-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

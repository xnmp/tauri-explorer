<!--
  PreviewPane component - File preview panel
  Issue: tauri-explorer-2c6b, tauri-explorer-xago, tauri-explorer-osjq
-->
<script lang="ts">
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { readTextFile, fetchDirectory, gitDiff } from "$lib/api/files";
  import { isImageFile, isTextFile, isPdfFile, getFileType, formatDate } from "$lib/domain/file-types";
  import { formatSize, type FileEntry } from "$lib/domain/file";
  import { isTauri } from "$lib/api/mock-invoke";
  import { highlightCode } from "$lib/domain/syntax-highlight";
  import { settingsStore } from "$lib/state/settings.svelte";
  import { getFileIconColor } from "$lib/domain/file-types";
  import { scmStore } from "$lib/state/scm.svelte";
  import { parseUnifiedDiff, type ParsedDiff, type DiffLine } from "$lib/domain/diff";
  import FileIcon from "./FileIcon.svelte";
  /** Detect if the current theme uses a light color scheme */
  const isLightTheme = $derived.by(() => {
    // Force re-evaluation when theme changes by reading the theme ID
    const _theme = settingsStore.theme;
    if (typeof document === "undefined") return false;
    return getComputedStyle(document.documentElement).colorScheme === "light";
  });

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

  /** Stable primitive that changes when the selected path OR its mtime changes,
   * so external edits to the same file invalidate the cached preview. */
  const selectedPath = $derived(selectedFile?.path ?? null);
  const previewKey = $derived(
    selectedFile ? `${selectedFile.path}|${selectedFile.modified}|${selectedFile.size}` : null,
  );

  // Preview content state
  let previewImageUrl = $state<string | null>(null);
  let previewText = $state<string | null>(null);
  let previewHighlightedHtml = $state<string | null>(null);
  let previewPdfUrl = $state<string | null>(null);
  let previewFolderChildrenRaw = $state<readonly FileEntry[]>([]);
  const previewFolderChildren = $derived(
    settingsStore.showHidden
      ? previewFolderChildrenRaw
      : previewFolderChildrenRaw.filter((e) => !e.name.startsWith("."))
  );
  let previewLoading = $state(false);
  let previewError = $state<string | null>(null);
  let previewTruncatedLines = $state(0);
  let lastPreviewPath: string | null = null;
  let lastPreviewKey: string | null = null;

  // --- Git diff preview state ---
  const activeDiff = $derived(scmStore.activeDiff);
  let diffParsed = $state<ParsedDiff | null>(null);
  let diffLoading = $state(false);
  let diffError = $state<string | null>(null);
  let lastDiffKey: string | null = null;

  const diffVisibleLines = $derived.by<DiffLine[]>(() => {
    if (!diffParsed) return [];
    return diffParsed.lines.filter((l) => l.kind !== "header" && l.kind !== "meta");
  });

  const diffSubtitle = $derived.by(() => {
    if (!diffParsed) return "";
    if (diffParsed.added) return "added";
    if (diffParsed.deleted) return "deleted";
    if (diffParsed.oldPath && diffParsed.newPath && diffParsed.oldPath !== diffParsed.newPath) {
      return `renamed from ${diffParsed.oldPath}`;
    }
    return activeDiff?.staged ? "staged" : "unstaged";
  });

  $effect(() => {
    if (!activeDiff || !scmStore.repoRoot) {
      diffParsed = null;
      diffError = null;
      diffLoading = false;
      lastDiffKey = null;
      return;
    }
    const key = `${scmStore.repoRoot}|${activeDiff.path}|${activeDiff.staged}|${scmStore.summary.staged.length}|${scmStore.summary.changes.length}`;
    if (key === lastDiffKey) return;
    lastDiffKey = key;
    loadDiff(scmStore.repoRoot, activeDiff.path, activeDiff.staged);
  });

  async function loadDiff(repoRoot: string, path: string, staged: boolean): Promise<void> {
    diffLoading = true;
    diffError = null;
    const r = await gitDiff(repoRoot, path, { staged });
    if (scmStore.activeDiff?.path !== path) return;
    if (!r.ok) {
      diffError = r.error;
      diffParsed = null;
    } else {
      diffParsed = parseUnifiedDiff(r.data);
    }
    diffLoading = false;
  }

  // Clear activeDiff when explorer file selection changes (not on initial render)
  let prevSelectedPath: string | null = null;
  $effect(() => {
    const current = selectedPath;
    if (prevSelectedPath !== null && current !== prevSelectedPath && activeDiff) {
      scmStore.closeDiff();
    }
    prevSelectedPath = current;
  });

  // Load preview when selection (or selected file's mtime/size) changes.
  $effect(() => {
    const path = selectedPath;
    const key = previewKey;
    const file = selectedFile;
    if (!file || !path) {
      lastPreviewPath = null;
      lastPreviewKey = null;
      previewImageUrl = null;
      previewText = null;
      previewHighlightedHtml = null;
      previewPdfUrl = null;
      previewFolderChildrenRaw = [];
      previewError = null;
      previewLoading = false;
      return;
    }
    if (key === lastPreviewKey) return;
    lastPreviewPath = path;
    lastPreviewKey = key;
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
    previewImageUrl = null;
    previewText = null;
    previewHighlightedHtml = null;
    previewPdfUrl = null;
    previewFolderChildrenRaw = [];
    previewError = null;
    previewTruncatedLines = 0;
    previewLoading = true;

    if (file.kind === "directory") {
      const result = await fetchDirectory(file.path);
      if (file.path !== lastPreviewPath) return;
      if (result.ok) {
        previewFolderChildrenRaw = result.data.entries;
      }
      previewLoading = false;
      return;
    }

    // Cache-busting suffix derived from mtime+size — same value as previewKey,
    // ensures the webview re-fetches when the on-disk file changes.
    const bust = encodeURIComponent(`${file.modified}-${file.size}`);

    if (isPdfFile(file)) {
      if (isTauri()) {
        try {
          const { convertFileSrc } = await import("@tauri-apps/api/core");
          previewPdfUrl = `${convertFileSrc(file.path)}?v=${bust}`;
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
          const url = `${convertFileSrc(file.path)}?v=${bust}`;
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
        // Limit to first 200 lines to avoid lag on large files
        const MAX_PREVIEW_LINES = 200;
        const lines = result.data.split("\n");
        const truncated = lines.length > MAX_PREVIEW_LINES;
        const displayText = truncated
          ? lines.slice(0, MAX_PREVIEW_LINES).join("\n")
          : result.data;
        previewText = displayText;
        previewTruncatedLines = truncated ? lines.length : 0;
        // Only syntax-highlight if content is reasonably small (< 50KB)
        if (displayText.length < 50_000) {
          try {
            previewHighlightedHtml = highlightCode(displayText, file.name);
          } catch {
            previewHighlightedHtml = null;
          }
        } else {
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
  {#if activeDiff}
    <div class="preview-header">
      <span class="preview-filename" title={activeDiff.path}>{activeDiff.path.split("/").pop()}</span>
      <span class="preview-type-badge" class:diff-staged={activeDiff.staged} class:diff-unstaged={!activeDiff.staged}>
        {diffSubtitle || "git diff"}
      </span>
    </div>
    <div class="preview-content">
      {#if diffLoading}
        <div class="preview-loading"><div class="spinner"></div></div>
      {:else if diffError}
        <div class="preview-empty"><span class="preview-error-text">{diffError}</span></div>
      {:else if diffParsed?.binary}
        <div class="preview-empty"><span>Binary file changed</span></div>
      {:else if diffVisibleLines.length === 0}
        <div class="preview-empty"><span>No changes to display</span></div>
      {:else}
        <div class="diff-lines">
          {#each diffVisibleLines as line (line.index)}
            <div class="diff-line {line.kind}" data-line-kind={line.kind}>
              <span class="diff-gutter old">{line.oldLine ?? ""}</span>
              <span class="diff-gutter new">{line.newLine ?? ""}</span>
              <span class="diff-sigil">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : line.kind === "hunk" ? "@" : " "}</span>
              <span class="diff-content">{line.text}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
    <div class="preview-info">
      <div class="info-row">
        <span class="info-label">Path</span>
        <span class="info-value" title={activeDiff.path}>{activeDiff.path}</span>
      </div>
    </div>
  {:else if !selectedFile}
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
        <pre class="preview-text preview-code" class:hljs-light={isLightTheme} class:hljs-dark={!isLightTheme}><code class="hljs">{@html previewHighlightedHtml}</code></pre>
        {#if previewTruncatedLines > 0}
          <div class="preview-truncated">Showing first 200 of {previewTruncatedLines.toLocaleString()} lines</div>
        {/if}
      {:else if previewText !== null}
        <pre class="preview-text">{previewText}</pre>
        {#if previewTruncatedLines > 0}
          <div class="preview-truncated">Showing first 200 of {previewTruncatedLines.toLocaleString()} lines</div>
        {/if}
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

  .preview-truncated {
    padding: 8px 16px;
    font-size: 10px;
    color: var(--text-tertiary);
    text-align: center;
    border-top: 1px solid var(--divider);
    flex-shrink: 0;
  }

  /* GitHub Dark hljs theme (default) */
  .hljs-dark :global(.hljs) { color: #c9d1d9; }
  .hljs-dark :global(.hljs-keyword),
  .hljs-dark :global(.hljs-doctag),
  .hljs-dark :global(.hljs-template-tag),
  .hljs-dark :global(.hljs-template-variable),
  .hljs-dark :global(.hljs-type),
  .hljs-dark :global(.hljs-variable.language_) { color: #ff7b72; }
  .hljs-dark :global(.hljs-title),
  .hljs-dark :global(.hljs-title.class_),
  .hljs-dark :global(.hljs-title.function_) { color: #d2a8ff; }
  .hljs-dark :global(.hljs-attr),
  .hljs-dark :global(.hljs-attribute),
  .hljs-dark :global(.hljs-literal),
  .hljs-dark :global(.hljs-meta),
  .hljs-dark :global(.hljs-number),
  .hljs-dark :global(.hljs-operator),
  .hljs-dark :global(.hljs-variable),
  .hljs-dark :global(.hljs-selector-attr),
  .hljs-dark :global(.hljs-selector-class),
  .hljs-dark :global(.hljs-selector-id) { color: #79c0ff; }
  .hljs-dark :global(.hljs-regexp),
  .hljs-dark :global(.hljs-string),
  .hljs-dark :global(.hljs-meta .hljs-string) { color: #a5d6ff; }
  .hljs-dark :global(.hljs-built_in),
  .hljs-dark :global(.hljs-symbol) { color: #ffa657; }
  .hljs-dark :global(.hljs-comment),
  .hljs-dark :global(.hljs-code),
  .hljs-dark :global(.hljs-formula) { color: #8b949e; }
  .hljs-dark :global(.hljs-name),
  .hljs-dark :global(.hljs-quote),
  .hljs-dark :global(.hljs-selector-tag),
  .hljs-dark :global(.hljs-selector-pseudo) { color: #7ee787; }
  .hljs-dark :global(.hljs-subst) { color: #c9d1d9; }
  .hljs-dark :global(.hljs-section) { color: #1f6feb; font-weight: bold; }
  .hljs-dark :global(.hljs-bullet) { color: #f2cc60; }
  .hljs-dark :global(.hljs-addition) { color: #aff5b4; background-color: #033a16; }
  .hljs-dark :global(.hljs-deletion) { color: #ffdcd7; background-color: #67060c; }

  /* GitHub Light hljs theme */
  .hljs-light :global(.hljs) { color: #24292e; }
  .hljs-light :global(.hljs-keyword),
  .hljs-light :global(.hljs-doctag),
  .hljs-light :global(.hljs-template-tag),
  .hljs-light :global(.hljs-template-variable),
  .hljs-light :global(.hljs-type),
  .hljs-light :global(.hljs-variable.language_) { color: #d73a49; }
  .hljs-light :global(.hljs-title),
  .hljs-light :global(.hljs-title.class_),
  .hljs-light :global(.hljs-title.function_) { color: #6f42c1; }
  .hljs-light :global(.hljs-attr),
  .hljs-light :global(.hljs-attribute),
  .hljs-light :global(.hljs-literal),
  .hljs-light :global(.hljs-meta),
  .hljs-light :global(.hljs-number),
  .hljs-light :global(.hljs-operator),
  .hljs-light :global(.hljs-variable),
  .hljs-light :global(.hljs-selector-attr),
  .hljs-light :global(.hljs-selector-class),
  .hljs-light :global(.hljs-selector-id) { color: #005cc5; }
  .hljs-light :global(.hljs-regexp),
  .hljs-light :global(.hljs-string),
  .hljs-light :global(.hljs-meta .hljs-string) { color: #032f62; }
  .hljs-light :global(.hljs-built_in),
  .hljs-light :global(.hljs-symbol) { color: #e36209; }
  .hljs-light :global(.hljs-comment),
  .hljs-light :global(.hljs-code),
  .hljs-light :global(.hljs-formula) { color: #6a737d; }
  .hljs-light :global(.hljs-name),
  .hljs-light :global(.hljs-quote),
  .hljs-light :global(.hljs-selector-tag),
  .hljs-light :global(.hljs-selector-pseudo) { color: #22863a; }
  .hljs-light :global(.hljs-subst) { color: #24292e; }
  .hljs-light :global(.hljs-section) { color: #005cc5; font-weight: bold; }
  .hljs-light :global(.hljs-bullet) { color: #735c0f; }
  .hljs-light :global(.hljs-addition) { color: #22863a; background-color: #f0fff4; }
  .hljs-light :global(.hljs-deletion) { color: #b31d28; background-color: #ffeef0; }

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

  /* --- Git diff styles --- */
  .preview-type-badge.diff-staged {
    background: color-mix(in srgb, #22c55e 20%, transparent);
    color: #16a34a;
  }

  .preview-type-badge.diff-unstaged {
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
  }

  .diff-lines {
    flex: 1;
    overflow: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    line-height: 18px;
  }

  .diff-line {
    display: grid;
    grid-template-columns: 36px 36px 14px 1fr;
    min-height: 18px;
    white-space: pre;
    padding-right: 8px;
  }

  .diff-line.context { background: transparent; }
  .diff-line.add { background: color-mix(in srgb, #22c55e 12%, transparent); }
  .diff-line.remove { background: color-mix(in srgb, #ef4444 14%, transparent); }
  .diff-line.hunk { background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--text-tertiary); }
  .diff-line.binary { color: var(--text-tertiary); font-style: italic; }

  .diff-gutter {
    padding-right: 4px;
    text-align: right;
    color: var(--text-tertiary);
    user-select: none;
    border-right: 1px solid color-mix(in srgb, var(--divider) 50%, transparent);
  }

  .diff-sigil {
    text-align: center;
    color: var(--text-tertiary);
    user-select: none;
  }

  .diff-line.add .diff-sigil { color: #16a34a; }
  .diff-line.remove .diff-sigil { color: #dc2626; }

  .diff-content {
    padding-left: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: text;
  }

  /* Vibrancy: own island, no left border needed */
  :global([data-vibrancy]) .preview-pane {
    background: transparent;
    border-left: none;
  }
</style>

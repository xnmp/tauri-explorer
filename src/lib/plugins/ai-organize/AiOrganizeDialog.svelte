<!--
  AI destination picker (#158).
  Plugin-owned modal, rendered via the plugin dialog registry. On open it asks
  the model to rank the caller-gathered candidate folders, shows a loading
  state, then renders the best fits. Clicking one moves the file through the
  normal transfer flow (conflict dialog, undo recording, toast) and closes.
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import type { PluginToast } from "$lib/plugins/api";
  import { suggestDestination } from "$lib/api/ai-organize";
  import { performFileTransfer } from "$lib/state/file-transfer";

  interface Props {
    open: boolean;
    filePath: string;
    fileName: string;
    contentHint?: string;
    candidates: string[];
    count: number;
    apiKey: string;
    toast: PluginToast;
    onOpenSettings: () => void;
    refresh: () => void;
    onClose: () => void;
  }

  let {
    open,
    filePath,
    fileName,
    contentHint,
    candidates,
    count,
    apiKey,
    toast,
    onOpenSettings,
    refresh,
    onClose,
  }: Props = $props();

  const hasApiKey = $derived(!!apiKey);
  const hasCandidates = $derived(candidates.length > 0);

  let loading = $state(false);
  let error = $state<string | null>(null);
  let suggestions = $state<string[]>([]);
  let applying = $state(false);

  async function loadSuggestions(): Promise<void> {
    if (!hasApiKey || !hasCandidates) return;
    loading = true;
    error = null;
    suggestions = [];
    const result = await suggestDestination(fileName, contentHint, candidates, count, apiKey);
    loading = false;
    if (result.ok) {
      suggestions = result.data;
      if (suggestions.length === 0) error = "No destinations were suggested. Try again.";
    } else {
      error = result.error;
    }
  }

  // Genuine side effect (an IPC call) triggered by the open transition.
  $effect(() => {
    if (open && hasApiKey && hasCandidates) {
      void loadSuggestions();
    }
  });

  async function moveTo(destDir: string): Promise<void> {
    if (applying) return;
    applying = true;
    // The shared transfer flow handles conflicts, undo, toast, and broadcast.
    const result = await performFileTransfer(filePath, destDir, false, {
      onRefresh: refresh,
    });
    if (result.ok) {
      onClose();
    } else {
      applying = false;
      if (result.error && result.error !== "skipped") {
        toast.error(`Move failed: ${result.error}`);
      }
    }
  }
</script>

<Modal {open} {onClose} overlayClass="dialog-overlay" labelledby="ai-organize-title">
  <div class="dialog">
    <header class="dialog-header">
      <div class="header-content">
        <svg class="header-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z"
            stroke="currentColor"
            stroke-width="1.5"
            fill="none"
          />
          <path d="M10 9v4M8 11h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <h2 id="ai-organize-title">Suggest destination</h2>
      </div>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </header>

    <div class="dialog-body">
      <div class="file-info">
        <span class="file-label">File:</span>
        <span class="file-name">{fileName}</span>
      </div>

      {#if !hasApiKey}
        <div class="warning-row">
          <span>Gemini API key not configured.</span>
          <button class="link-btn" onclick={() => { onClose(); onOpenSettings(); }}>Open Settings</button>
        </div>
      {:else if !hasCandidates}
        <div class="warning-row">
          <span>No candidate folders here — open a directory with subfolders or add bookmarks.</span>
        </div>
      {:else if loading}
        <div class="status-row" data-testid="ai-organize-loading">
          <span class="spinner" aria-hidden="true"></span>
          <span>Ranking destinations…</span>
        </div>
      {:else if error}
        <div class="warning-row">
          <span>{error}</span>
          <button class="link-btn" onclick={() => void loadSuggestions()}>Retry</button>
        </div>
      {:else}
        <div class="suggestions" data-testid="ai-organize-suggestions">
          {#each suggestions as dest (dest)}
            <button class="suggestion" onclick={() => void moveTo(dest)} disabled={applying}>
              <span class="suggestion-name">{dest}</span>
              <svg class="suggestion-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          {/each}
        </div>
      {/if}

      <div class="dialog-actions">
        <button class="btn btn-secondary" onclick={onClose} disabled={applying}>Cancel</button>
      </div>
    </div>
  </div>
</Modal>

<style>
  .dialog {
    width: 520px;
    max-width: 90vw;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    animation: slideUp 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .header-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-icon {
    color: var(--accent);
  }

  .dialog-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .dialog-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .file-info {
    display: flex;
    gap: 8px;
    font-size: 13px;
  }

  .file-label {
    color: var(--text-secondary);
  }

  .file-name {
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .warning-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: var(--subtle-fill-secondary);
    color: var(--text-secondary);
    font-size: 13px;
    flex-wrap: wrap;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-secondary);
    font-size: 13px;
    padding: 8px 0;
  }

  .spinner {
    width: 14px;
    height: 14px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font-size: 13px;
    text-decoration: underline;
  }

  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .suggestion {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    background: var(--control-fill-tertiary);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .suggestion:hover:not(:disabled) {
    background: var(--control-fill-secondary);
    border-color: var(--accent);
  }

  .suggestion:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl; /* ellipsize the front of long paths, keep the tail visible */
    text-align: left;
  }

  .suggestion-arrow {
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
  }

  .btn {
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: 13px;
    cursor: pointer;
    border: 1px solid var(--surface-stroke);
  }

  .btn-secondary {
    background: var(--control-fill-tertiary);
    color: var(--text-primary);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--control-fill-secondary);
  }
</style>

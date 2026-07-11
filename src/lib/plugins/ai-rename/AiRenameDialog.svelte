<!--
  AI Rename suggestion picker (#145).
  Plugin-owned modal, rendered via the plugin dialog registry. Receives the
  target file, the (already-gathered) content hint, API key and helper handles
  as props from the plugin's `activate`, plus a close callback from the renderer.

  On open it requests suggestions, shows a loading state, then renders the
  original name alongside 2-3 clickable proposals. Clicking one sanitizes it,
  renames via the normal flow, refreshes the panes, toasts, and closes.
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import type { PluginToast } from "$lib/plugins/api";
  import { suggestFilenames } from "$lib/api/ai-rename";
  import { renameEntry } from "$lib/api/files";
  import { sanitizeChosenName } from "$lib/domain/ai-rename";

  interface Props {
    open: boolean;
    originalPath: string;
    originalName: string;
    contentHint?: string;
    count: number;
    apiKey: string;
    toast: PluginToast;
    onOpenSettings: () => void;
    refresh: () => void;
    onClose: () => void;
  }

  let {
    open,
    originalPath,
    originalName,
    contentHint,
    count,
    apiKey,
    toast,
    onOpenSettings,
    refresh,
    onClose,
  }: Props = $props();

  const hasApiKey = $derived(!!apiKey);

  let loading = $state(false);
  let error = $state<string | null>(null);
  let suggestions = $state<string[]>([]);
  let applying = $state(false);

  async function loadSuggestions(): Promise<void> {
    if (!hasApiKey) return;
    loading = true;
    error = null;
    suggestions = [];
    const result = await suggestFilenames(originalName, contentHint, count, apiKey);
    loading = false;
    if (result.ok) {
      suggestions = result.data;
      if (suggestions.length === 0) error = "No suggestions were returned. Try again.";
    } else {
      error = result.error;
    }
  }

  // Kick off the request when the dialog opens. `$effect` is warranted: this is
  // a genuine side effect (an IPC call) triggered by the open transition.
  $effect(() => {
    if (open && hasApiKey) {
      void loadSuggestions();
    }
  });

  async function applyName(chosen: string): Promise<void> {
    if (applying) return;
    const newName = sanitizeChosenName(chosen, originalName);
    if (newName === originalName) {
      toast.show("That is already the current name", "info");
      return;
    }
    applying = true;
    const result = await renameEntry(originalPath, newName);
    if (result.ok) {
      toast.show(`Renamed to ${newName}`, "success");
      refresh();
      onClose();
    } else {
      applying = false;
      toast.error(`Rename failed: ${result.error}`);
    }
  }
</script>

<Modal {open} {onClose} overlayClass="dialog-overlay" labelledby="ai-rename-title">
  <div class="dialog plugin-dialog">
    <header class="dialog-header">
      <div class="header-content">
        <svg class="header-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M10 2C5.58 2 2 5.58 2 10s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm-1 11l-3-3 1.41-1.41L9 10.17l3.59-3.58L14 8l-5 5z"
            fill="currentColor"
            fill-opacity="0.7"
          />
        </svg>
        <h2 id="ai-rename-title">Suggest rename</h2>
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
        <span class="file-name">{originalName}</span>
      </div>

      {#if !hasApiKey}
        <div class="api-key-warning">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 2L1 14h14L8 2zM8 6v4M8 12h.01"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>Gemini API key not configured.</span>
          <button class="link-btn" onclick={() => { onClose(); onOpenSettings(); }}>Open Settings</button>
        </div>
      {:else if loading}
        <div class="status-row" data-testid="ai-rename-loading">
          <span class="spinner" aria-hidden="true"></span>
          <span>Generating suggestions…</span>
        </div>
      {:else if error}
        <div class="api-key-warning">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 2L1 14h14L8 2zM8 6v4M8 12h.01"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span>{error}</span>
          <button class="link-btn" onclick={() => void loadSuggestions()}>Retry</button>
        </div>
      {:else}
        <div class="suggestions" data-testid="ai-rename-suggestions">
          {#each suggestions as name (name)}
            <button class="suggestion" onclick={() => void applyName(name)} disabled={applying}>
              <span class="suggestion-name">{name}</span>
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
  /* Shared chrome comes from ../plugin-dialog.css; below are this dialog's
     width, its link-btn placement tweak, and its bespoke suggestion UI. */
  .dialog {
    width: 480px;
  }

  .dialog .link-btn {
    margin-left: auto;
  }

  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--control-stroke);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .suggestions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .suggestion {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: all var(--transition-fast);
  }

  .suggestion:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
  }

  .suggestion:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .suggestion-arrow {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }
</style>

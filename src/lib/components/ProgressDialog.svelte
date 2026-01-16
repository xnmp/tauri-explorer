<!--
  ProgressDialog component - Shows progress for file operations
  Issue: tauri-explorer-41o, tauri-explorer-jqi
-->
<script lang="ts">
  import {
    operationsManager,
    formatBytes,
    getOperationLabel,
    type Operation,
  } from "$lib/state/operations.svelte";

  const operations = $derived(operationsManager.operations);
  const showDialog = $derived(operationsManager.showProgressDialog);
  const hasActive = $derived(operationsManager.hasActiveOperations);

  function handleCancel(op: Operation): void {
    operationsManager.cancelOperation(op.id);
  }

  function handleCancelAll(): void {
    operationsManager.cancelAllOperations();
  }

  function handleClear(op: Operation): void {
    operationsManager.clearOperation(op.id);
  }

  function handleClearAll(): void {
    operationsManager.cleanupCompletedOperations();
  }

  function handleClose(): void {
    if (!hasActive) {
      operationsManager.hideDialog();
    }
  }

  function getStatusIcon(status: Operation["status"]): string {
    switch (status) {
      case "running":
        return "spinner";
      case "completed":
        return "check";
      case "cancelled":
        return "cancel";
      case "error":
        return "error";
      default:
        return "pending";
    }
  }

  function getStatusClass(status: Operation["status"]): string {
    switch (status) {
      case "completed":
        return "success";
      case "error":
        return "error";
      case "cancelled":
        return "cancelled";
      default:
        return "";
    }
  }
</script>

{#if showDialog && operations.length > 0}
  <div class="progress-dialog-container">
    <div class="progress-dialog">
      <div class="dialog-header">
        <h3 class="dialog-title">File Operations</h3>
        <div class="header-actions">
          {#if hasActive}
            <button
              class="header-btn cancel-all"
              onclick={handleCancelAll}
              title="Cancel All"
            >
              Cancel All
            </button>
          {:else}
            <button
              class="header-btn clear-all"
              onclick={handleClearAll}
              title="Clear All"
            >
              Clear
            </button>
          {/if}
          {#if !hasActive}
            <button
              class="header-btn close"
              onclick={handleClose}
              aria-label="Close"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>

      <div class="operations-list">
        {#each operations as op (op.id)}
          <div class="operation-item" class:error={op.status === "error"}>
            <div class="operation-info">
              <div class="operation-icon {getStatusClass(op.status)}">
                {#if op.status === "running"}
                  <div class="spinner-small"></div>
                {:else if op.status === "completed"}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                {:else if op.status === "error"}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M8 5V8.5M8 11V11.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                {:else if op.status === "cancelled"}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                    <path d="M5.5 5.5L10.5 10.5M10.5 5.5L5.5 10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                {:else}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
                  </svg>
                {/if}
              </div>

              <div class="operation-details">
                <div class="operation-name">
                  <span class="operation-type">{getOperationLabel(op.type)}</span>
                  <span class="file-name">{op.fileName}</span>
                </div>

                {#if op.status === "running"}
                  <div class="progress-bar-container">
                    <div class="progress-bar" style="width: {op.progress}%"></div>
                  </div>
                  <div class="progress-text">
                    {op.progress.toFixed(0)}%
                    {#if op.bytesProcessed !== undefined && op.totalBytes !== undefined}
                      <span class="bytes-text">
                        {formatBytes(op.bytesProcessed)} / {formatBytes(op.totalBytes)}
                      </span>
                    {/if}
                  </div>
                {:else if op.status === "error" && op.error}
                  <div class="error-text">{op.error}</div>
                {:else if op.status === "completed"}
                  <div class="status-text success">Complete</div>
                {:else if op.status === "cancelled"}
                  <div class="status-text cancelled">Cancelled</div>
                {/if}
              </div>
            </div>

            <div class="operation-actions">
              {#if op.status === "running"}
                <button
                  class="action-btn cancel"
                  onclick={() => handleCancel(op)}
                  title="Cancel"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </button>
              {:else}
                <button
                  class="action-btn clear"
                  onclick={() => handleClear(op)}
                  title="Dismiss"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                  </svg>
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .progress-dialog-container {
    position: fixed;
    bottom: 16px;
    right: 16px;
    z-index: 900;
    animation: slideUp 200ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .progress-dialog {
    width: 360px;
    max-height: 400px;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--divider);
    background: var(--background-card-secondary);
  }

  .dialog-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 4px 10px;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .header-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .header-btn.cancel-all {
    color: var(--error, #dc3545);
  }

  .header-btn.close {
    padding: 4px;
  }

  .operations-list {
    overflow-y: auto;
    max-height: 340px;
  }

  .operation-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--divider);
  }

  .operation-item:last-child {
    border-bottom: none;
  }

  .operation-item.error {
    background: rgba(220, 53, 69, 0.05);
  }

  .operation-info {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }

  .operation-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .operation-icon.success {
    color: var(--success, #28a745);
  }

  .operation-icon.error {
    color: var(--error, #dc3545);
  }

  .operation-icon.cancelled {
    color: var(--text-tertiary);
  }

  .spinner-small {
    width: 14px;
    height: 14px;
    border: 2px solid var(--divider);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 600ms linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .operation-details {
    flex: 1;
    min-width: 0;
  }

  .operation-name {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 13px;
    margin-bottom: 4px;
  }

  .operation-type {
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .file-name {
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .progress-bar-container {
    height: 4px;
    background: var(--subtle-fill-tertiary);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 4px;
  }

  .progress-bar {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 100ms linear;
  }

  .progress-text {
    font-size: 11px;
    color: var(--text-tertiary);
    display: flex;
    justify-content: space-between;
  }

  .bytes-text {
    color: var(--text-tertiary);
  }

  .status-text {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .status-text.success {
    color: var(--success, #28a745);
  }

  .status-text.cancelled {
    color: var(--text-tertiary);
  }

  .error-text {
    font-size: 11px;
    color: var(--error, #dc3545);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .operation-actions {
    flex-shrink: 0;
  }

  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .action-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .action-btn.cancel:hover {
    background: rgba(220, 53, 69, 0.1);
    color: var(--error, #dc3545);
  }
</style>

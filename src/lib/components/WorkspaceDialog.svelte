<!--
  WorkspaceDialog - Save/manage/restore workspaces
  Issue: tauri-explorer-6qrn, tauri-explorer-howc
-->
<script lang="ts">
  import { workspacesStore } from "$lib/state/workspaces.svelte";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let mode = $state<"list" | "save">("list");
  let saveName = $state("");
  let editingId = $state<string | null>(null);
  let editName = $state("");

  function handleSave(): void {
    const name = saveName.trim();
    if (!name) return;
    const tabState = windowTabsManager.captureState();
    workspacesStore.save(name, tabState);
    saveName = "";
    mode = "list";
  }

  function handleRestore(id: string): void {
    const workspace = workspacesStore.get(id);
    if (!workspace) return;
    windowTabsManager.restoreFromState(workspace.state);
    onClose();
  }

  function handleDelete(id: string): void {
    workspacesStore.remove(id);
  }

  function startRename(id: string, currentName: string): void {
    editingId = id;
    editName = currentName;
  }

  function confirmRename(): void {
    if (editingId && editName.trim()) {
      workspacesStore.rename(editingId, editName.trim());
    }
    editingId = null;
    editName = "";
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      if (editingId) {
        editingId = null;
      } else if (mode === "save") {
        mode = "list";
      } else {
        onClose();
      }
      event.stopPropagation();
    }
  }

  function formatDate(timestamp: number): string {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  }

  // Reset state when opening
  $effect(() => {
    if (open) {
      mode = "list";
      saveName = "";
      editingId = null;
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dialog-backdrop" onclick={onClose} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="dialog" onclick={(e) => e.stopPropagation()}>
      <div class="dialog-header">
        <h2>{mode === "save" ? "Save Workspace" : "Workspaces"}</h2>
        <button class="close-btn" onclick={onClose}>×</button>
      </div>

      <div class="dialog-content">
        {#if mode === "save"}
          <div class="save-form">
            <input
              type="text"
              class="save-input"
              placeholder="Workspace name..."
              bind:value={saveName}
              onkeydown={(e) => { if (e.key === "Enter") handleSave(); }}
              autofocus
            />
            <div class="save-actions">
              <button class="btn btn-secondary" onclick={() => mode = "list"}>Cancel</button>
              <button class="btn btn-primary" onclick={handleSave} disabled={!saveName.trim()}>Save</button>
            </div>
          </div>
        {:else}
          <button class="btn btn-primary save-new-btn" onclick={() => mode = "save"}>
            Save Current Layout
          </button>

          {#if workspacesStore.count === 0}
            <div class="empty-state">No saved workspaces yet</div>
          {:else}
            <div class="workspace-list">
              {#each workspacesStore.list as workspace (workspace.id)}
                <div class="workspace-item">
                  <div class="workspace-info" onclick={() => handleRestore(workspace.id)} role="button" tabindex="0" onkeydown={(e) => { if (e.key === "Enter") handleRestore(workspace.id); }}>
                    {#if editingId === workspace.id}
                      <input
                        type="text"
                        class="rename-input"
                        bind:value={editName}
                        onkeydown={(e) => { if (e.key === "Enter") confirmRename(); if (e.key === "Escape") { editingId = null; e.stopPropagation(); } }}
                        onclick={(e) => e.stopPropagation()}
                        autofocus
                      />
                    {:else}
                      <span class="workspace-name">{workspace.name}</span>
                      <span class="workspace-meta">
                        {workspace.state.tabs.length} tab{workspace.state.tabs.length !== 1 ? "s" : ""}
                        · {formatDate(workspace.updatedAt)}
                      </span>
                    {/if}
                  </div>
                  <div class="workspace-actions">
                    {#if editingId === workspace.id}
                      <button class="icon-btn" onclick={confirmRename} title="Confirm">✓</button>
                    {:else}
                      <button class="icon-btn" onclick={() => startRename(workspace.id, workspace.name)} title="Rename">✎</button>
                    {/if}
                    <button class="icon-btn delete-btn" onclick={() => handleDelete(workspace.id)} title="Delete">×</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
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
    width: 400px;
    max-height: 500px;
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
  }

  .save-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .save-input, .rename-input {
    padding: 8px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: var(--font-size-body);
    color: var(--text-primary);
    outline: none;
  }

  .save-input:focus, .rename-input:focus {
    border-color: var(--accent);
  }

  .rename-input {
    width: 100%;
    font-size: 13px;
    padding: 4px 8px;
  }

  .save-actions {
    display: flex;
    justify-content: flex-end;
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

  .save-new-btn {
    width: 100%;
  }

  .empty-state {
    text-align: center;
    color: var(--text-tertiary);
    font-size: var(--font-size-caption);
    padding: 24px;
  }

  .workspace-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .workspace-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    transition: background var(--transition-fast);
  }

  .workspace-item:hover {
    background: var(--subtle-fill-secondary);
  }

  .workspace-info {
    flex: 1;
    min-width: 0;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .workspace-name {
    font-size: var(--font-size-body);
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-meta {
    font-size: 11px;
    color: var(--text-tertiary);
  }

  .workspace-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 14px;
    transition: all var(--transition-fast);
  }

  .icon-btn:hover {
    background: var(--subtle-fill-tertiary);
    color: var(--text-primary);
  }

  .delete-btn:hover {
    color: var(--system-critical);
  }
</style>

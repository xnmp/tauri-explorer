<!--
  KeybindingsSettings component - Customizable keyboard shortcuts UI
  Issue: tauri-explorer-oytv
-->
<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getAllCommands, getCategoryLabel, type Command, type CommandCategory } from "$lib/state/commands.svelte";
  import { keybindingsStore } from "$lib/state/keybindings.svelte";
  import { eventToShortcutString } from "$lib/domain/keybinding-parser";

  /** Currently recording shortcut for this command ID */
  let recordingCommandId = $state<string | null>(null);

  /** Conflict info when recording */
  let conflictInfo = $state<{ commandId: string; label: string } | null>(null);

  /** Search filter */
  let searchQuery = $state("");

  /** Commands with shortcuts, filtered by search and grouped by category */
  const groupedCommands = $derived.by(() => {
    let commands = getAllCommands().filter(cmd => cmd.shortcut);

    // Apply search filter
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      commands = commands.filter(cmd =>
        cmd.label.toLowerCase().includes(query) ||
        getCategoryLabel(cmd.category).toLowerCase().includes(query) ||
        (keybindingsStore.getDisplayShortcut(cmd.id) || "").toLowerCase().includes(query)
      );
    }

    // Group by category
    const groups = new Map<CommandCategory, Command[]>();
    for (const cmd of commands) {
      const existing = groups.get(cmd.category) || [];
      groups.set(cmd.category, [...existing, cmd]);
    }

    return groups;
  });

  /** Total filtered command count for empty state */
  const filteredCount = $derived([...groupedCommands.values()].reduce((sum, cmds) => sum + cmds.length, 0));

  /** Start recording a new shortcut */
  function startRecording(commandId: string): void {
    recordingCommandId = commandId;
    conflictInfo = null;
  }

  /** Cancel recording */
  function cancelRecording(): void {
    recordingCommandId = null;
    conflictInfo = null;
  }

  /**
   * Handle keyboard event during recording.
   * Uses capture phase to intercept events before they reach other handlers.
   */
  function handleRecordKeydown(event: KeyboardEvent): void {
    if (!recordingCommandId) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    // Escape cancels recording
    if (event.key === "Escape") {
      cancelRecording();
      return;
    }

    // Convert event to shortcut string
    const shortcutString = eventToShortcutString(event);
    if (!shortcutString) return; // Modifier-only press

    // Check for conflicts
    const conflicts = keybindingsStore.findConflicts(shortcutString, recordingCommandId);
    if (conflicts.length > 0) {
      const conflictCmd = getAllCommands().find(c => c.id === conflicts[0]);
      conflictInfo = conflictCmd ? { commandId: conflicts[0], label: conflictCmd.label } : null;
      return;
    }

    // Apply the new shortcut
    keybindingsStore.setShortcut(recordingCommandId, shortcutString);
    recordingCommandId = null;
    conflictInfo = null;
  }

  /** Get shortcut display parts (e.g., ["Ctrl", "P"]) */
  function getShortcutParts(commandId: string): string[] {
    const shortcut = keybindingsStore.getDisplayShortcut(commandId);
    return shortcut ? shortcut.split("+") : [];
  }

  // Use window-level event listener in capture phase when recording
  // This ensures we intercept keyboard events before any other handler
  onMount(() => {
    window.addEventListener("keydown", handleRecordKeydown, true);
  });

  onDestroy(() => {
    window.removeEventListener("keydown", handleRecordKeydown, true);
  });
</script>

<div class="keybindings-settings">
  <div class="keybindings-header">
    <input
      type="text"
      class="search-input"
      placeholder="Search shortcuts..."
      bind:value={searchQuery}
    />
    <button class="reset-all-btn" onclick={() => keybindingsStore.resetAllToDefaults()}>
      Reset All
    </button>
  </div>

  <div class="keybindings-list">
    {#each [...groupedCommands] as [category, commands] (category)}
      <div class="category-group">
        <h4 class="category-title">{getCategoryLabel(category)}</h4>

        {#each commands as cmd (cmd.id)}
          {@const parts = getShortcutParts(cmd.id)}
          {@const isRecording = recordingCommandId === cmd.id}
          {@const hasCustom = keybindingsStore.hasCustomShortcut(cmd.id)}

          <div class="shortcut-row" class:recording={isRecording} class:customized={hasCustom}>
            <span class="shortcut-action">{cmd.label}</span>

            <div class="shortcut-controls">
              {#if isRecording}
                <div class="recording-indicator">
                  <span class="recording-text">Press keys...</span>
                  <button class="cancel-btn" onclick={cancelRecording}>Cancel</button>
                </div>
                {#if conflictInfo}
                  <div class="conflict-warning">
                    Conflicts with "{conflictInfo.label}"
                  </div>
                {/if}
              {:else}
                <button class="shortcut-btn" onclick={() => startRecording(cmd.id)}>
                  {#if parts.length > 0}
                    {#each parts as part, i}
                      {#if i > 0}<span class="plus">+</span>{/if}
                      <kbd>{part}</kbd>
                    {/each}
                  {:else}
                    <span class="unbound">Not set</span>
                  {/if}
                </button>

                {#if hasCustom}
                  <button
                    class="reset-btn"
                    onclick={() => keybindingsStore.resetToDefault(cmd.id)}
                    title="Reset to default"
                  >
                    ↺
                  </button>
                {/if}
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/each}

    {#if filteredCount === 0}
      <div class="no-results">No shortcuts found</div>
    {/if}
  </div>
</div>

<style>
  .keybindings-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .keybindings-header {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .search-input {
    flex: 1;
    padding: 8px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    outline: none;
    transition: all var(--transition-fast);
  }

  .search-input:focus {
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .reset-all-btn {
    padding: 8px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
    white-space: nowrap;
  }

  .reset-all-btn:hover {
    background: var(--control-fill-secondary);
    color: var(--text-primary);
  }

  .keybindings-list {
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-height: 400px;
    overflow-y: auto;
  }

  .category-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .category-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    margin: 0 0 4px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--divider);
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    transition: background var(--transition-fast);
  }

  .shortcut-row:hover {
    background: var(--subtle-fill-secondary);
  }

  .shortcut-row.recording {
    background: var(--subtle-fill-tertiary);
  }

  .shortcut-row.customized .shortcut-action {
    color: var(--accent);
  }

  .shortcut-action {
    font-size: 13px;
    color: var(--text-secondary);
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shortcut-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  .shortcut-btn {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 8px;
    background: var(--subtle-fill-tertiary);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .shortcut-btn:hover {
    background: var(--subtle-fill-secondary);
    border-color: var(--accent);
  }

  .shortcut-btn kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--background-solid);
    border: 1px solid var(--control-stroke);
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .shortcut-btn .plus {
    color: var(--text-tertiary);
    font-size: 10px;
  }

  .shortcut-btn .unbound {
    font-size: 11px;
    color: var(--text-tertiary);
    font-style: italic;
  }

  .reset-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
    font-size: 14px;
    transition: all var(--transition-fast);
  }

  .reset-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--accent);
  }

  .recording-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .recording-text {
    font-size: 12px;
    color: var(--accent);
    animation: pulse 1s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .cancel-btn {
    padding: 4px 8px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .cancel-btn:hover {
    background: var(--control-fill-secondary);
  }

  .conflict-warning {
    font-size: 11px;
    color: var(--system-critical);
    background: rgba(255, 0, 0, 0.1);
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    margin-top: 4px;
  }

  .no-results {
    text-align: center;
    color: var(--text-tertiary);
    font-size: 13px;
    padding: 24px;
  }
</style>

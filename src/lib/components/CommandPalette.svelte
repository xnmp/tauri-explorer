<!--
  CommandPalette component - VSCode-style Ctrl+Shift+P command palette
  Issue: tauri-explorer-0dk, tauri-explorer-dfx, tauri-explorer-npjh.4
-->
<script lang="ts">
  import {
    getAllCommands,
    getAvailableCommands,
    getRecentCommands,
    executeCommand,
    getCategoryLabel,
    getCommandShortcut,
    type Command,
    type CommandCategory,
  } from "$lib/state/commands.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);

  // Get filtered and sorted commands
  const filteredCommands = $derived.by(() => {
    const available = getAvailableCommands();
    const recent = getRecentCommands();

    if (!query.trim()) {
      // Show recent commands first, then all others
      const recentIds = new Set(recent.map((c) => c.id));
      const nonRecent = available.filter((c) => !recentIds.has(c.id));
      return [...recent, ...nonRecent];
    }

    // Fuzzy search
    const lowerQuery = query.toLowerCase();
    const scored = available
      .map((cmd) => ({
        cmd,
        score: fuzzyScore(cmd, lowerQuery),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((item) => item.cmd);
  });

  // Fuzzy scoring for command search
  function fuzzyScore(cmd: Command, query: string): number {
    const label = cmd.label.toLowerCase();
    const category = getCategoryLabel(cmd.category).toLowerCase();
    const shortcut = (getCommandShortcut(cmd.id) || "").toLowerCase();

    let score = 0;

    // Exact match in label
    if (label.includes(query)) {
      score += 100;
      // Bonus for starting with query
      if (label.startsWith(query)) score += 50;
    }

    // Match in category
    if (category.includes(query)) {
      score += 30;
    }

    // Match in shortcut
    if (shortcut.includes(query)) {
      score += 40;
    }

    // Character-by-character fuzzy match in label
    let queryIdx = 0;
    for (let i = 0; i < label.length && queryIdx < query.length; i++) {
      if (label[i] === query[queryIdx]) {
        queryIdx++;
        score += 5;
      }
    }

    // Only return score if all query chars were found
    if (queryIdx < query.length) {
      return 0;
    }

    return score;
  }

  // Group commands by category for display
  const groupedCommands = $derived.by(() => {
    const groups = new Map<CommandCategory, Command[]>();

    for (const cmd of filteredCommands) {
      const existing = groups.get(cmd.category) || [];
      groups.set(cmd.category, [...existing, cmd]);
    }

    return groups;
  });

  // Flat list for keyboard navigation
  const flatCommands = $derived(filteredCommands);

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (flatCommands.length > 0) {
          selectedIndex = (selectedIndex + 1) % flatCommands.length;
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (flatCommands.length > 0) {
          selectedIndex = (selectedIndex - 1 + flatCommands.length) % flatCommands.length;
          scrollToSelected();
        }
        break;
      case "Enter":
        event.preventDefault();
        if (flatCommands[selectedIndex]) {
          executeSelected(flatCommands[selectedIndex]);
        }
        break;
    }
  }

  function scrollToSelected(): void {
    setTimeout(() => {
      const selected = document.querySelector(".command-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    }, 0);
  }

  async function executeSelected(cmd: Command): Promise<void> {
    onClose();
    await executeCommand(cmd.id);
  }

  function handleInput(): void {
    selectedIndex = 0;
  }

  // Focus input when dialog opens
  $effect(() => {
    if (open && inputRef) {
      query = "";
      selectedIndex = 0;
      setTimeout(() => inputRef?.focus(), 0);
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="command-palette-overlay" onclick={onClose} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="command-palette-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="search-container">
        <span class="search-prefix">&gt;</span>
        <input
          type="text"
          class="search-input"
          placeholder="Type a command..."
          bind:value={query}
          bind:this={inputRef}
          oninput={handleInput}
        />
      </div>

      <div class="commands-container">
        {#if flatCommands.length > 0}
          <ul class="commands-list" role="listbox">
            {#each flatCommands as cmd, index (cmd.id)}
              {@const isSelected = index === selectedIndex}
              {@const displayShortcut = getCommandShortcut(cmd.id)}
              <li
                class="command-item"
                class:selected={isSelected}
                role="option"
                aria-selected={isSelected}
                onclick={() => executeSelected(cmd)}
                onmouseenter={() => selectedIndex = index}
              >
                <span class="command-category">{getCategoryLabel(cmd.category)}</span>
                <span class="command-label">{cmd.label}</span>
                {#if displayShortcut}
                  <span class="command-shortcut">
                    {#each displayShortcut.split("+") as key, keyIndex}
                      {#if keyIndex > 0}+{/if}
                      <kbd>{key}</kbd>
                    {/each}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else if query}
          <div class="no-results">No matching commands</div>
        {:else}
          <div class="no-results hint">Type to search commands...</div>
        {/if}
      </div>

      <div class="footer">
        <span class="shortcut"><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span class="shortcut"><kbd>Enter</kbd> Execute</span>
        <span class="shortcut"><kbd>Esc</kbd> Close</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .command-palette-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: 1000;
    animation: fadeIn 100ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .command-palette-dialog {
    width: 600px;
    max-width: 90vw;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    overflow: hidden;
    animation: slideDown 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-20px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .search-container {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px;
    border-bottom: 1px solid var(--divider);
  }

  .search-prefix {
    color: var(--accent);
    font-size: 18px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 16px;
    color: var(--text-primary);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .commands-container {
    max-height: 400px;
    overflow-y: auto;
  }

  .commands-list {
    list-style: none;
    margin: 0;
    padding: 8px;
  }

  .command-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .command-item:hover,
  .command-item.selected {
    background: var(--subtle-fill-secondary);
  }

  .command-item.selected {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .command-category {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-tertiary);
    min-width: 80px;
    flex-shrink: 0;
  }

  .command-item.selected .command-category {
    color: var(--text-on-accent);
    opacity: 0.7;
  }

  .command-label {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-shortcut {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .command-item.selected .command-shortcut {
    color: var(--text-on-accent);
    opacity: 0.8;
  }

  .command-shortcut kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--subtle-fill-tertiary);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .command-item.selected .command-shortcut kbd {
    background: rgba(255, 255, 255, 0.2);
    border-color: transparent;
    color: var(--text-on-accent);
  }

  .no-results {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .no-results.hint {
    color: var(--text-tertiary);
  }

  .footer {
    display: flex;
    gap: 16px;
    padding: 10px 16px;
    background: var(--background-card-secondary);
    border-top: 1px solid var(--divider);
  }

  .footer .shortcut {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .footer kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    background: var(--subtle-fill-tertiary);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    color: var(--text-secondary);
  }
</style>

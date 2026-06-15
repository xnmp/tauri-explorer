<!--
  CommandPalette component - VSCode-style Ctrl+Shift+P command palette
  Issue: tauri-explorer-0dk, tauri-explorer-dfx, tauri-explorer-npjh.4
-->
<script lang="ts">
  import { tick } from "svelte";
  import {
    getAvailableCommands,
    getCommandsByFrecency,
    getCommandFrecencyScore,
    executeCommand,
    getCategoryLabel,
    getCommandShortcut,
    type Command,
  } from "$lib/state/commands.svelte";
  import { settingsStore } from "$lib/state/settings.svelte";
  import Modal from "./Modal.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);
  let commandsContainerRef = $state<HTMLElement | null>(null);
  // Suppress mouseenter on rows until the user actually moves the mouse —
  // prevents selection from jumping to the row the cursor happened to be over
  // when the palette opened (or after arrow navigation scrolled a new row under it).
  // Track coordinates because macOS WebKit fires a synthetic mousemove (zero delta)
  // when an element renders under a stationary cursor.
  let mouseMoved = $state(false);
  let lastMousePos = $state<{ x: number; y: number } | null>(null);
  let mouseTrackingReady = $state(false);
  let mouseTrackingTimer: ReturnType<typeof setTimeout> | null = null;

  interface ScoredCommand {
    cmd: Command;
    total: number;
    fuzzy: number;
    frecency: number;
  }

  // Get filtered and sorted commands with score breakdown
  const filteredScored = $derived.by((): ScoredCommand[] => {
    const available = getAvailableCommands();

    if (!query.trim()) {
      const ranked = getCommandsByFrecency();
      const rankedIds = new Set(ranked.map((c: Command) => c.id));
      const nonRanked = available.filter((c) => !rankedIds.has(c.id));
      return [...ranked, ...nonRanked].map((cmd) => {
        const frecency = getCommandFrecencyScore(cmd.id);
        return { cmd, total: Math.round(frecency * 100), fuzzy: 0, frecency: Math.round(frecency * 100) };
      });
    }

    const lowerQuery = query.toLowerCase();
    return available
      .map((cmd) => {
        const frecency = getCommandFrecencyScore(cmd.id);
        const frecencyPts = Math.min(30, Math.round(frecency * 10));
        const total = fuzzyScore(cmd, lowerQuery);
        const fuzzyPts = total - frecencyPts;
        return { cmd, total, fuzzy: fuzzyPts, frecency: frecencyPts };
      })
      .filter((item) => item.total > 0)
      .sort((a, b) => b.total - a.total);
  });

  const filteredCommands = $derived(filteredScored.map((s) => s.cmd));

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

    // Frecency boost (capped so it doesn't dominate text relevance)
    const frecency = getCommandFrecencyScore(cmd.id);
    score += Math.min(30, Math.round(frecency * 10));

    return score;
  }

  // Flat list for keyboard navigation
  const flatCommands = $derived(filteredCommands);

  // Escape is handled by Modal; everything else lands here.
  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (flatCommands.length > 0) {
          selectedIndex = (selectedIndex + 1) % flatCommands.length;
          mouseMoved = false;
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (flatCommands.length > 0) {
          selectedIndex = (selectedIndex - 1 + flatCommands.length) % flatCommands.length;
          mouseMoved = false;
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
    tick().then(() => {
      const selected = commandsContainerRef?.querySelector(".command-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    });
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
      mouseMoved = false;
      lastMousePos = null;
      mouseTrackingReady = false;
      if (mouseTrackingTimer) clearTimeout(mouseTrackingTimer);
      mouseTrackingTimer = setTimeout(() => { mouseTrackingReady = true; }, 150);
      tick().then(() => inputRef?.focus());
    }
  });
</script>

<Modal
  {open}
  {onClose}
  overlayClass="command-palette-overlay"
  align="top"
  topOffset="15vh"
  label="Command palette"
  onkeydown={handleKeydown}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="command-palette-dialog"
    onmousemove={(e) => {
      if (!mouseTrackingReady) return;
      if (lastMousePos && (e.clientX !== lastMousePos.x || e.clientY !== lastMousePos.y)) {
        mouseMoved = true;
      }
      lastMousePos = { x: e.clientX, y: e.clientY };
    }}>
      <div class="search-container">
        <span class="search-prefix">&gt;</span>
        <input
          type="text"
          class="search-input"
          placeholder="Type a command..."
          autocomplete="off"
          autocorrect="off"
          autocapitalize="none"
          spellcheck="false"
          name="cmdpalette-nofill"
          bind:value={query}
          bind:this={inputRef}
          oninput={handleInput}
        />
      </div>

      <div class="commands-container" bind:this={commandsContainerRef}>
        {#if flatCommands.length > 0}
          <ul class="commands-list" role="listbox">
            {#each flatCommands as cmd, index (cmd.id)}
              {@const isSelected = index === selectedIndex}
              {@const displayShortcut = getCommandShortcut(cmd.id)}
              {@const scores = filteredScored[index]}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <li
                class="command-item"
                class:selected={isSelected}
                role="option"
                aria-selected={isSelected}
                onclick={() => executeSelected(cmd)}
                onmouseenter={() => { if (mouseMoved) selectedIndex = index; }}
              >
                <span class="command-category">{getCategoryLabel(cmd.category)}</span>
                <span class="command-label">{cmd.label}</span>
                {#if cmd.toggleState}
                  {@const on = cmd.toggleState()}
                  <span class="toggle-badge" class:on aria-label={on ? "On" : "Off"}>{on ? "ON" : "OFF"}</span>
                {/if}
                {#if settingsStore.quickOpenDebug && scores}
                  <span class="debug-breakdown">
                    <span class="debug-row"><b>{scores.total}</b></span>
                    {#if scores.fuzzy > 0}
                      <span class="debug-row">fuzzy:{scores.fuzzy}</span>
                    {/if}
                    {#if scores.frecency > 0}
                      <span class="debug-row">frec:{scores.frecency}</span>
                    {/if}
                  </span>
                {/if}
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
</Modal>

<style>
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

  .toggle-badge {
    flex-shrink: 0;
    padding: 1px 7px;
    border-radius: var(--radius-pill, 999px);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: var(--subtle-fill-tertiary);
    color: var(--text-tertiary);
    border: 1px solid var(--control-stroke);
  }

  .toggle-badge.on {
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }

  .command-item.selected .toggle-badge {
    background: rgba(255, 255, 255, 0.2);
    border-color: transparent;
    color: var(--text-on-accent);
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

  .debug-breakdown {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: monospace;
    font-size: 10px;
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .debug-breakdown b {
    color: var(--text-primary);
  }

  .command-item.selected .debug-breakdown {
    color: var(--text-on-accent);
    opacity: 0.7;
  }

  .command-item.selected .debug-breakdown b {
    color: var(--text-on-accent);
  }

  .debug-row {
    white-space: nowrap;
  }
</style>

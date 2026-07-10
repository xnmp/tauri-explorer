<!--
  Keyboard shortcut cheatsheet (#186). Renders the LIVE effective bindings
  (user overrides included) grouped by category. Opened with Ctrl+/ or the
  "Keyboard Shortcuts" palette command; rebinding lives in Settings.
-->
<script lang="ts">
  import Modal from "./Modal.svelte";
  import {
    getAllCommands,
    getCommandShortcut,
    getCategoryLabel,
    type Command,
    type CommandCategory,
  } from "$lib/state/commands.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  interface CheatsheetEntry {
    label: string;
    shortcut: string;
  }

  /** Hardcoded bindings handled directly in +page.svelte, not the registry. */
  const BUILTIN_ENTRIES: Array<{ category: CommandCategory; entry: CheatsheetEntry }> = [
    { category: "general", entry: { label: "Settings", shortcut: "Ctrl+," } },
    { category: "general", entry: { label: "Jobs Panel", shortcut: "Ctrl+J" } },
    { category: "view", entry: { label: "Toggle Dual Pane", shortcut: "Ctrl+\\" } },
  ];

  const groups = $derived.by(() => {
    if (!open) return [];
    const byCategory = new Map<CommandCategory, CheatsheetEntry[]>();
    const add = (category: CommandCategory, entry: CheatsheetEntry) => {
      const list = byCategory.get(category) ?? [];
      list.push(entry);
      byCategory.set(category, list);
    };
    for (const cmd of getAllCommands() as Command[]) {
      const shortcut = getCommandShortcut(cmd.id);
      if (!shortcut) continue;
      if (cmd.when && !cmd.when()) continue;
      add(cmd.category, { label: cmd.label, shortcut });
    }
    for (const { category, entry } of BUILTIN_ENTRIES) add(category, entry);
    return [...byCategory.entries()]
      .map(([category, entries]) => ({
        label: getCategoryLabel(category),
        entries: entries.sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  });
</script>

<Modal {open} {onClose} label="Keyboard Shortcuts" overlayClass="shortcut-cheatsheet-overlay">
  <div class="modal-card cheatsheet" data-testid="shortcut-cheatsheet">
    <header>
      <h2>Keyboard Shortcuts</h2>
      <span class="cheatsheet-hint">Rebind any of these in Settings → Keybindings</span>
    </header>
    <div class="cheatsheet-columns">
      {#each groups as group (group.label)}
        <section class="cheatsheet-group">
          <h3>{group.label}</h3>
          <ul>
            {#each group.entries as entry (entry.label + entry.shortcut)}
              <li>
                <span class="cheatsheet-label">{entry.label}</span>
                <kbd>{entry.shortcut}</kbd>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>
  </div>
</Modal>

<style>
  .cheatsheet {
    width: min(860px, calc(100vw - 48px));
    max-height: 80vh;
    overflow-y: auto;
    padding: 20px 24px;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-bottom: 14px;
  }

  h2 {
    margin: 0;
    font-size: 16px;
  }

  .cheatsheet-hint {
    font-size: 12px;
    color: var(--text-secondary, #777);
  }

  .cheatsheet-columns {
    column-width: 250px;
    column-gap: 28px;
  }

  .cheatsheet-group {
    break-inside: avoid;
    margin-bottom: 16px;
  }

  h3 {
    margin: 0 0 6px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary, #777);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 3px 0;
    font-size: 13px;
  }

  .cheatsheet-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  kbd {
    flex-shrink: 0;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--control-stroke);
    background: var(--subtle-fill-tertiary);
    color: var(--text-secondary);
    font-family: inherit;
    font-size: 11px;
  }
</style>

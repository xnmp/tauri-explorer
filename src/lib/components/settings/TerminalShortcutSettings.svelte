<!--
  TerminalShortcutSettings — line-editing shortcuts (#375): bind key combos
  to readline actions. Empty = disabled (native terminal behavior). The
  recorder (#404) captures the next key press instead of typed text.
-->
<script lang="ts">
  import { isMac } from "$lib/domain/platform";
  import { TERMINAL_LINE_ACTIONS, defaultTerminalShortcuts } from "$lib/domain/terminal-keys";
  import { terminalBindingFor } from "$lib/domain/terminal-shortcut-binding";
  import { eventToShortcutString, formatShortcut } from "$lib/domain/keybinding-parser";
  import { settingsStore } from "$lib/state/settings.svelte";
  import SettingRow from "./SettingRow.svelte";

  interface Props {
    /** Whether the Settings dialog is open; closing it ends recording. */
    open: boolean;
    hidden: boolean;
  }

  const { open, hidden }: Props = $props();

  // ── Terminal shortcut recorder (#404): press keys instead of typing text ──
  let recordingActionId = $state<string | null>(null);
  const terminalDefaults = defaultTerminalShortcuts(isMac);

  /** The binding shown for an action: user override wins; "" = disabled. */
  function terminalBinding(actionId: string): { binding: string; isDefault: boolean } {
    return terminalBindingFor(actionId, settingsStore.terminalShortcuts, terminalDefaults);
  }

  function handleShortcutRecordKeydown(event: KeyboardEvent): void {
    if (!recordingActionId) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.key === "Escape") {
      recordingActionId = null;
      return;
    }
    // Backspace/Delete alone clears the binding (disables the action).
    if ((event.key === "Backspace" || event.key === "Delete") && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
      settingsStore.setTerminalShortcut(recordingActionId, "");
      recordingActionId = null;
      return;
    }
    const shortcut = eventToShortcutString(event);
    if (!shortcut) return; // modifier-only press — keep recording
    settingsStore.setTerminalShortcut(recordingActionId, shortcut);
    recordingActionId = null;
  }

  // Capture-phase while recording so app shortcuts can't steal the press;
  // recording also ends when the dialog closes or the window blurs.
  $effect(() => {
    if (!recordingActionId) return;
    const cancel = () => (recordingActionId = null);
    window.addEventListener("keydown", handleShortcutRecordKeydown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", handleShortcutRecordKeydown, true);
      window.removeEventListener("blur", cancel);
    };
  });
  $effect(() => {
    if (!open) recordingActionId = null;
  });
</script>

<SettingRow class="terminal-shortcuts" label="Line-Editing Shortcuts"
  description="Click a binding, then press the keys. Backspace clears (the key keeps its native behavior); Esc cancels."
  {hidden}>
  {#snippet info()}
        <div class="terminal-shortcut-list">
          {#each TERMINAL_LINE_ACTIONS as action (action.id)}
            {@const tb = terminalBinding(action.id)}
            <div class="terminal-shortcut-row">
              <span class="ts-label">{action.label}</span>
              <button
                class="ts-record"
                class:recording={recordingActionId === action.id}
                class:unbound={!tb.binding && recordingActionId !== action.id}
                onclick={() => (recordingActionId = recordingActionId === action.id ? null : action.id)}
                title="Click, then press the new key combo"
              >
                {#if recordingActionId === action.id}
                  Press keys…
                {:else if tb.binding}
                  {formatShortcut(tb.binding)}{tb.isDefault ? " (default)" : ""}
                {:else}
                  unbound
                {/if}
              </button>
              {#if !tb.isDefault}
                <button
                  class="ts-reset"
                  title={terminalDefaults[action.id] ? "Reset to default" : "Remove binding"}
                  aria-label="Reset binding"
                  onclick={() => settingsStore.setTerminalShortcut(action.id, null)}
                >↺</button>
              {/if}
            </div>
          {/each}
        </div>
  {/snippet}
</SettingRow>

<style>
  .terminal-shortcut-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }

  .terminal-shortcut-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .ts-label {
    flex: 1;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .ts-record {
    width: 160px;
    padding: 3px 8px;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    background: var(--control-fill);
    color: var(--text-primary);
    font-size: 12px;
    font-family: var(--font-mono, monospace);
    cursor: pointer;
    text-align: center;
  }

  .ts-record:hover {
    background: var(--control-fill-secondary, var(--subtle-fill-secondary));
  }

  .ts-record.recording {
    border-color: var(--accent);
    color: var(--accent-text, var(--accent));
  }

  .ts-record.unbound {
    color: var(--text-tertiary);
  }

  .ts-reset {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 13px;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
  }

  .ts-reset:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }
</style>

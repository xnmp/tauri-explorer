<!--
  Toolbar component - Windows 11 File Explorer Command Bar
  Issue: tauri-explorer-iw0, tauri-explorer-jql
-->
<script lang="ts">
  import { explorer } from "$lib/state/explorer.svelte";
  import { clipboardStore } from "$lib/state/clipboard.svelte";
</script>

<div class="toolbar">
  <!-- New dropdown -->
  <div class="command-group">
    <button class="cmd-button" onclick={() => explorer.openNewFolderDialog()} title="New">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 5V11M5 8H11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span class="cmd-label">New</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="dropdown-arrow">
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

  <div class="separator"></div>

  <!-- Clipboard operations -->
  <div class="command-group">
    <button
      class="cmd-icon-button"
      disabled
      title="Cut (Ctrl+X)"
      aria-label="Cut"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M5 3L2 6L5 9M11 3L14 6L11 9M3 6H13" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="cmd-icon-button"
      disabled
      title="Copy (Ctrl+C)"
      aria-label="Copy"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="5" y="5" width="8" height="9" rx="1" stroke="currentColor" stroke-width="1.25"/>
        <path d="M3 10V3C3 2.44772 3.44772 2 4 2H9" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
    </button>

    <button
      class="cmd-icon-button"
      disabled={!clipboardStore.hasContent}
      onclick={() => explorer.paste()}
      title="Paste (Ctrl+V)"
      aria-label="Paste"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M5.5 3H4C3.44772 3 3 3.44772 3 4V13C3 13.5523 3.44772 14 4 14H12C12.5523 14 13 13.5523 13 13V4C13 3.44772 12.5523 3 12 3H10.5" stroke="currentColor" stroke-width="1.25"/>
        <rect x="6" y="1.5" width="4" height="3" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
      </svg>
    </button>
  </div>

  <div class="separator"></div>

  <!-- File operations -->
  <div class="command-group">
    <button
      class="cmd-icon-button"
      disabled
      title="Rename (F2)"
      aria-label="Rename"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M11 2L14 5L7 12H4V9L11 2Z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/>
      </svg>
    </button>

    <button
      class="cmd-icon-button"
      disabled
      title="Share"
      aria-label="Share"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="4" cy="8" r="2" stroke="currentColor" stroke-width="1.25"/>
        <circle cx="12" cy="4" r="2" stroke="currentColor" stroke-width="1.25"/>
        <circle cx="12" cy="12" r="2" stroke="currentColor" stroke-width="1.25"/>
        <path d="M6 7L10 5M6 9L10 11" stroke="currentColor" stroke-width="1.25"/>
      </svg>
    </button>

    <button
      class="cmd-icon-button"
      disabled
      title="Delete (Del)"
      aria-label="Delete"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 5H13M5.5 5V3.5C5.5 2.94772 5.94772 2.5 6.5 2.5H9.5C10.0523 2.5 10.5 2.94772 10.5 3.5V5M7 7.5V11.5M9 7.5V11.5M4.5 5L5 13C5 13.5523 5.44772 14 6 14H10C10.5523 14 11 13.5523 11 13L11.5 5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      </svg>
    </button>
  </div>

  <div class="separator"></div>

  <!-- Sort control -->
  <div class="command-group">
    <button class="cmd-button" title="Sort">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M3 8L5 10L5 3M3 8L5 6M3 8H10M13 8L11 6L11 13M13 8L11 10M13 8H6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="cmd-label">Sort</span>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" class="dropdown-arrow">
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
  </div>

  <div class="separator"></div>

  <!-- More options -->
  <div class="command-group">
    <button class="cmd-icon-button" title="More options">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="3" r="1.25" fill="currentColor"/>
        <circle cx="8" cy="8" r="1.25" fill="currentColor"/>
        <circle cx="8" cy="13" r="1.25" fill="currentColor"/>
      </svg>
    </button>
  </div>

  <div class="spacer"></div>

  <!-- Preview toggle -->
  <div class="command-group">
    <button class="cmd-button preview-toggle" title="Preview pane">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <rect x="2" y="3" width="12" height="10" rx="0.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M9 3V13" stroke="currentColor" stroke-width="1.25"/>
      </svg>
      <span class="cmd-label">Preview</span>
    </button>
  </div>
</div>

<style>
  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 12px;
    background: var(--background-card);
    border-bottom: 1px solid var(--divider);
    height: 44px;
    position: relative;
    z-index: 10;
  }

  .command-group {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .separator {
    width: 1px;
    height: 20px;
    background: var(--divider);
    margin: 0 4px;
  }

  .spacer {
    flex: 1;
  }

  /* Icon-only button */
  .cmd-icon-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .cmd-icon-button:hover:not(:disabled) {
    background: var(--subtle-fill-secondary);
  }

  .cmd-icon-button:active:not(:disabled) {
    background: var(--subtle-fill-tertiary);
  }

  .cmd-icon-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .cmd-icon-button:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  /* Button with label and dropdown */
  .cmd-button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .cmd-button:hover {
    background: var(--subtle-fill-secondary);
  }

  .cmd-button:active {
    background: var(--subtle-fill-tertiary);
  }

  .cmd-button:focus-visible {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 1px;
  }

  .cmd-label {
    font-weight: 400;
  }

  .dropdown-arrow {
    opacity: 0.7;
  }

  .preview-toggle {
    padding-left: 8px;
    padding-right: 8px;
  }
</style>

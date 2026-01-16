<!--
  SettingsDialog component - Application settings
  Issue: tauri-explorer-npjh.1
-->
<script lang="ts">
  import { settingsStore } from "$lib/state/settings.svelte";
  import { themeStore } from "$lib/state/theme.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="settings-overlay"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
  >
    <div class="settings-dialog">
      <header class="dialog-header">
        <h2 id="settings-title">Settings</h2>
        <button class="close-btn" onclick={onClose} aria-label="Close settings">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </header>

      <div class="dialog-content">
        <!-- Appearance Section -->
        <section class="settings-section">
          <h3 class="section-title">Appearance</h3>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Theme</span>
              <span class="setting-description">Choose the color theme for the app</span>
            </div>
            <select
              class="theme-select"
              value={themeStore.currentThemeId}
              onchange={(e) => themeStore.setTheme(e.currentTarget.value as any)}
            >
              {#each themeStore.availableThemes as theme (theme.id)}
                <option value={theme.id}>{theme.name}</option>
              {/each}
            </select>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Show Toolbar</span>
              <span class="setting-description">Display navigation buttons at the top</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showToolbar}
                onchange={() => settingsStore.toggleToolbar()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="setting-row">
            <div class="setting-info">
              <span class="setting-label">Show Sidebar</span>
              <span class="setting-description">Display bookmarks and quick access panel</span>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={settingsStore.showSidebar}
                onchange={() => settingsStore.toggleSidebar()}
              />
              <span class="toggle-slider"></span>
            </label>
          </div>
        </section>

        <!-- Keyboard Shortcuts Section -->
        <section class="settings-section">
          <h3 class="section-title">Keyboard Shortcuts</h3>
          <div class="shortcuts-list">
            <div class="shortcut-row">
              <span class="shortcut-action">Open Settings</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>,</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Quick Open (Search Files)</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>P</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Toggle Dual Pane</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>\</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Switch Pane</span>
              <kbd>F6</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Go Back</span>
              <kbd>Alt</kbd><span class="plus">+</span><kbd>←</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Go Forward</span>
              <kbd>Alt</kbd><span class="plus">+</span><kbd>→</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Go Up</span>
              <kbd>Alt</kbd><span class="plus">+</span><kbd>↑</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Refresh</span>
              <kbd>F5</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Copy</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>C</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Cut</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>X</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Paste</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>V</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Undo</span>
              <kbd>Ctrl</kbd><span class="plus">+</span><kbd>Z</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Delete</span>
              <kbd>Delete</kbd>
            </div>
            <div class="shortcut-row">
              <span class="shortcut-action">Rename</span>
              <kbd>F2</kbd>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
{/if}

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 100ms ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .settings-dialog {
    width: 500px;
    max-width: 90vw;
    max-height: 80vh;
    background: var(--background-card);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    animation: slideUp 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from {
      opacity: 0;
      transform: translateY(20px) scale(0.98);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .dialog-header h2 {
    font-size: 18px;
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

  .dialog-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .settings-section {
    margin-bottom: 24px;
  }

  .settings-section:last-child {
    margin-bottom: 0;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 12px 0;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--divider);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--divider);
  }

  .setting-row:last-child {
    border-bottom: none;
  }

  .setting-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .setting-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .setting-description {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .theme-select {
    padding: 6px 12px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    outline: none;
    transition: all var(--transition-fast);
  }

  .theme-select:hover {
    background: var(--control-fill-secondary);
  }

  .theme-select:focus {
    border-color: var(--accent);
  }

  /* Toggle switch */
  .toggle {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
    cursor: pointer;
  }

  .toggle input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .toggle-slider {
    position: absolute;
    inset: 0;
    background: var(--control-fill-secondary);
    border: 1px solid var(--control-stroke);
    border-radius: 12px;
    transition: all var(--transition-fast);
  }

  .toggle-slider::before {
    content: "";
    position: absolute;
    height: 18px;
    width: 18px;
    left: 2px;
    bottom: 2px;
    background: var(--text-secondary);
    border-radius: 50%;
    transition: all var(--transition-fast);
  }

  .toggle input:checked + .toggle-slider {
    background: var(--accent);
    border-color: var(--accent);
  }

  .toggle input:checked + .toggle-slider::before {
    transform: translateX(20px);
    background: var(--text-on-accent);
  }

  .toggle input:focus-visible + .toggle-slider {
    outline: 2px solid var(--focus-stroke-outer);
    outline-offset: 2px;
  }

  /* Keyboard shortcuts */
  .shortcuts-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .shortcut-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
  }

  .shortcut-action {
    font-size: 13px;
    color: var(--text-secondary);
  }

  .shortcut-row kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 24px;
    padding: 0 8px;
    background: var(--subtle-fill-tertiary);
    border: 1px solid var(--control-stroke);
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .plus {
    margin: 0 4px;
    color: var(--text-tertiary);
    font-size: 12px;
  }
</style>

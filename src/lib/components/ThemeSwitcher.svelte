<!--
  ThemeSwitcher component - Theme selection dropdown
  Issue: tauri-explorer-l7lv
-->
<script lang="ts">
  import { themeStore } from "$lib/state/theme.svelte";

  let isOpen = $state(false);

  function handleSelect(themeId: string) {
    themeStore.setTheme(themeId);
    isOpen = false;
  }

  function handleBlur(event: FocusEvent) {
    // Close dropdown when focus leaves the component
    const relatedTarget = event.relatedTarget as HTMLElement | null;
    if (!relatedTarget?.closest(".theme-switcher")) {
      isOpen = false;
    }
  }
</script>

<div class="theme-switcher" onblur={handleBlur}>
  <button
    class="theme-button"
    onclick={() => isOpen = !isOpen}
    title="Change theme"
    aria-expanded={isOpen}
    aria-haspopup="listbox"
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      {#if themeStore.currentThemeId === "dark"}
        <!-- Moon icon for dark theme -->
        <path d="M8 3C5.24 3 3 5.24 3 8C3 10.76 5.24 13 8 13C10.03 13 11.77 11.74 12.5 10C11.81 10.32 11.04 10.5 10.23 10.5C7.46 10.5 5.21 8.25 5.21 5.48C5.21 4.67 5.39 3.9 5.71 3.21C4.49 3.73 3.5 4.74 3 6" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      {:else if themeStore.currentThemeId === "solarized-light"}
        <!-- Warm sun icon for solarized -->
        <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 2V4M8 12V14M14 8H12M4 8H2M12.24 3.76L10.83 5.17M5.17 10.83L3.76 12.24M12.24 12.24L10.83 10.83M5.17 5.17L3.76 3.76" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      {:else}
        <!-- Sun icon for light theme -->
        <circle cx="8" cy="8" r="2.5" stroke="currentColor" stroke-width="1.25"/>
        <path d="M8 3V4M8 12V13M13 8H12M4 8H3M11.54 4.46L10.83 5.17M5.17 10.83L4.46 11.54M11.54 11.54L10.83 10.83M5.17 5.17L4.46 4.46" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
      {/if}
    </svg>
  </button>

  {#if isOpen}
    <div class="theme-dropdown" role="listbox">
      {#each themeStore.availableThemes as theme}
        <button
          class="theme-option"
          class:active={themeStore.currentThemeId === theme.id}
          onclick={() => handleSelect(theme.id)}
          role="option"
          aria-selected={themeStore.currentThemeId === theme.id}
        >
          <span class="theme-preview" style="background: {theme.colors.backgroundSolid}; border-color: {theme.colors.divider};">
            <span class="preview-accent" style="background: {theme.colors.accent};"></span>
          </span>
          <span class="theme-name">{theme.name}</span>
          {#if themeStore.currentThemeId === theme.id}
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" class="check-icon">
              <path d="M2 6L5 9L10 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .theme-switcher {
    position: relative;
  }

  .theme-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .theme-button:hover {
    background: var(--subtle-fill-secondary);
  }

  .theme-button:active {
    background: var(--subtle-fill-tertiary);
  }

  .theme-dropdown {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    min-width: 160px;
    padding: 4px;
    background: var(--background-acrylic);
    backdrop-filter: blur(60px) saturate(125%);
    border: 1px solid var(--surface-stroke-flyout);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout);
    z-index: 100;
  }

  .theme-option {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    cursor: pointer;
    transition: background var(--transition-fast);
    text-align: left;
  }

  .theme-option:hover {
    background: var(--subtle-fill-secondary);
  }

  .theme-option.active {
    background: var(--subtle-fill-tertiary);
  }

  .theme-preview {
    width: 20px;
    height: 20px;
    border-radius: 4px;
    border: 1px solid;
    display: flex;
    align-items: flex-end;
    overflow: hidden;
  }

  .preview-accent {
    width: 100%;
    height: 4px;
  }

  .theme-name {
    flex: 1;
  }

  .check-icon {
    color: var(--accent);
  }
</style>

<!--
  ThemePicker - VSCode-style secondary picker for switching themes.
  Opened by the "Switch Theme..." command. Arrowing previews the theme live;
  Enter commits and persists it; Escape reverts to the previously-active theme.
-->
<script lang="ts">
  import { tick, untrack } from "svelte";
  import { themeStore } from "$lib/state/theme.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);
  let themesContainerRef = $state<HTMLElement | null>(null);
  let mouseMoved = $state(false);
  // Theme active before the picker opened — marks the "current" row in the list.
  let originalThemeId = $state("");

  const filteredThemes = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return themeStore.availableThemes;
    return themeStore.availableThemes.filter((t) =>
      t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)
    );
  });

  // Tracks an open picker session so the close branch below only fires for a
  // session that actually started. Plain let — only read/written in the effect.
  let pickerSession = false;

  $effect(() => {
    if (open && inputRef) {
      pickerSession = true;
      // untrack: session init must not re-run when the theme store changes
      // mid-session (committing a theme mutates currentThemeId while the
      // picker is still open).
      originalThemeId = untrack(() => themeStore.currentThemeId);
      query = "";
      // Start selection at the currently-active theme so arrowing moves
      // relative to the user's current choice.
      const idx = untrack(() => themeStore.availableThemes).findIndex((t) => t.id === originalThemeId);
      selectedIndex = idx >= 0 ? idx : 0;
      mouseMoved = false;
      tick().then(() => { inputRef?.focus(); scrollToSelected(); });
    } else if (!open && pickerSession) {
      pickerSession = false;
      // Revert any un-committed preview on every close path (Escape, click
      // outside, or the parent flipping `open` externally). After a commit,
      // currentThemeId is the newly-set theme, so re-applying it is a no-op.
      // Must run in the effect BODY, not a teardown: the teardown variant
      // observed a stale currentThemeId and reverted the committed theme,
      // making theme switches need two attempts (#251, #164).
      themeStore.previewTheme(untrack(() => themeStore.currentThemeId));
    }
  });

  // Live preview as the selection moves.
  $effect(() => {
    if (!open) return;
    const theme = filteredThemes[selectedIndex];
    if (theme) themeStore.previewTheme(theme.id);
  });

  function commit(themeId: string): void {
    themeStore.setTheme(themeId);
    onClose();
  }

  function cancel(): void {
    // Preview revert happens in the open-$effect cleanup, which covers
    // every close path (including the parent flipping `open` externally).
    onClose();
  }

  function scrollToSelected(): void {
    tick().then(() => {
      const selected = themesContainerRef?.querySelector(".theme-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    });
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        cancel();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (filteredThemes.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredThemes.length;
          mouseMoved = false;
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (filteredThemes.length > 0) {
          selectedIndex = (selectedIndex - 1 + filteredThemes.length) % filteredThemes.length;
          mouseMoved = false;
          scrollToSelected();
        }
        break;
      case "Enter":
        event.preventDefault();
        if (filteredThemes[selectedIndex]) commit(filteredThemes[selectedIndex].id);
        break;
    }
  }

  function handleInput(): void {
    selectedIndex = 0;
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="theme-picker-overlay" onclick={cancel} onkeydown={handleKeydown} onmousemove={() => { mouseMoved = true; }}>
    <div class="theme-picker-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="search-container">
        <span class="search-prefix">🎨</span>
        <input
          type="text"
          class="search-input"
          placeholder="Select Color Theme (type to filter, ↑↓ preview, Enter to commit, Esc to revert)"
          bind:value={query}
          bind:this={inputRef}
          oninput={handleInput}
        />
      </div>

      <div class="themes-container" bind:this={themesContainerRef}>
        {#if filteredThemes.length > 0}
          <ul class="themes-list" role="listbox">
            {#each filteredThemes as theme, index (theme.id)}
              {@const isSelected = index === selectedIndex}
              {@const isCurrent = theme.id === originalThemeId}
              <li
                class="theme-item"
                class:selected={isSelected}
                role="option"
                aria-selected={isSelected}
                onclick={() => commit(theme.id)}
                onmouseenter={() => { if (mouseMoved) selectedIndex = index; }}
              >
                <span class="swatch" style="background: {theme.colors.accent}; border-color: {theme.colors.divider};"></span>
                <div class="theme-info">
                  <span class="theme-name">{theme.name}{#if isCurrent} <span class="current-tag">current</span>{/if}</span>
                  <span class="theme-description">{theme.description}</span>
                </div>
              </li>
            {/each}
          </ul>
        {:else}
          <div class="no-results">No themes match your filter</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .theme-picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: var(--z-modal-popover);
  }

  .theme-picker-dialog {
    width: 600px;
    max-width: 90vw;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    overflow: hidden;
  }

  .search-container {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 16px;
    border-bottom: 1px solid var(--divider);
  }

  .search-prefix {
    font-size: 18px;
    flex-shrink: 0;
  }

  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary);
  }

  .themes-container {
    max-height: 400px;
    overflow-y: auto;
  }

  .themes-list {
    list-style: none;
    margin: 0;
    padding: 8px;
  }

  .theme-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .theme-item.selected {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .swatch {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid;
    flex-shrink: 0;
  }

  .theme-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .theme-name {
    font-size: 14px;
    font-weight: 500;
  }

  .theme-description {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .theme-item.selected .theme-description {
    color: var(--text-on-accent);
    opacity: 0.8;
  }

  .current-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--subtle-fill-secondary);
    color: var(--text-tertiary);
    margin-left: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .theme-item.selected .current-tag {
    background: rgba(255, 255, 255, 0.2);
    color: var(--text-on-accent);
  }

  .no-results {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
  }
</style>

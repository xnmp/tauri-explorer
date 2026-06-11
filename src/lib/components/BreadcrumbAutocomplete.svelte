<!--
  BreadcrumbAutocomplete - Path editing with directory autocomplete.
  Shown when the user clicks the breadcrumbs container to type a path.
-->
<script lang="ts">
  import { tick } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { expandTilde as expandTildePath, normalizePathInput } from "$lib/domain/path";
  import { parsePathInput, filterDirectorySuggestions } from "$lib/domain/autocomplete";
  import { fetchDirectory } from "$lib/api/files";

  interface Props {
    currentPath: string;
    homeDir: string | null;
    onNavigate: (path: string) => void;
    onCancel: () => void;
  }

  let { currentPath, homeDir, onNavigate, onCancel }: Props = $props();

  // Intentionally captures the initial value -- this component is mounted
  // fresh each time editing starts and destroyed on cancel.
  let editedPath = $state((() => currentPath)());
  let pathInputRef: HTMLInputElement | null = null;
  let suggestions = $state<FileEntry[]>([]);
  let selectedIndex = $state(-1);
  let showSuggestions = $state(false);
  let fetchGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // Auto-select the input on mount
  $effect(() => {
    tick().then(() => pathInputRef?.select());
  });

  function expandTilde(path: string): string {
    return expandTildePath(path, homeDir);
  }

  async function fetchSuggestionsImpl(): Promise<void> {
    const gen = ++fetchGeneration;
    const { parentDir, prefix } = parsePathInput(editedPath, homeDir);

    const result = await fetchDirectory(parentDir);
    if (gen !== fetchGeneration) return;

    if (!result.ok) {
      suggestions = [];
      showSuggestions = false;
      return;
    }

    const filtered = filterDirectorySuggestions(result.data.entries, prefix);

    suggestions = filtered;
    selectedIndex = filtered.length > 0 ? 0 : -1;
    showSuggestions = filtered.length > 0;
  }

  function applySuggestion(entry: FileEntry): void {
    editedPath = entry.path + (entry.kind === "directory" ? "/" : "");
    suggestions = [];
    showSuggestions = false;
    selectedIndex = -1;
    if (entry.kind === "directory") {
      fetchSuggestionsImpl();
    }
  }

  function confirm(): void {
    const trimmed = editedPath.trim();
    if (trimmed) {
      onNavigate(expandTilde(normalizePathInput(trimmed)));
    }
    onCancel();
  }

  function handleInput(): void {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fetchSuggestionsImpl, 150);
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (showSuggestions && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        selectedIndex = (selectedIndex + 1) % suggestions.length;
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        selectedIndex = selectedIndex <= 0 ? suggestions.length - 1 : selectedIndex - 1;
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const target = selectedIndex >= 0 ? suggestions[selectedIndex] : suggestions[0];
        if (target) applySuggestion(target);
        return;
      }
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (showSuggestions && selectedIndex >= 0) {
        applySuggestion(suggestions[selectedIndex]);
      } else {
        confirm();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (showSuggestions) {
        suggestions = [];
        showSuggestions = false;
      } else {
        onCancel();
      }
    }
  }

  function handleBlur(event: FocusEvent): void {
    const related = event.relatedTarget as HTMLElement | null;
    if (related?.closest(".suggestions-dropdown")) return;
    onCancel();
  }
</script>

<input
  type="text"
  class="path-input"
  bind:value={editedPath}
  bind:this={pathInputRef}
  onkeydown={handleKeydown}
  oninput={handleInput}
  onblur={handleBlur}
  placeholder="Enter path..."
  autocomplete="off"
  autocorrect="off"
  autocapitalize="none"
  spellcheck="false"
  name="pathbar-nofill"
/>
{#if showSuggestions && suggestions.length > 0}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="suggestions-dropdown" onmousedown={(e) => e.preventDefault()}>
    {#each suggestions as entry, i (entry.path)}
      <button
        class="suggestion-item"
        class:selected={i === selectedIndex}
        class:directory={entry.kind === "directory"}
        onmousedown={() => applySuggestion(entry)}
        onmouseenter={() => { selectedIndex = i; }}
      >
        <span class="suggestion-icon">
          {#if entry.kind === "directory"}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M3 3.5C3 2.67 3.67 2 4.5 2H7L8.5 3.5H12.5C13.33 3.5 14 4.17 14 5V12C14 12.83 13.33 13.5 12.5 13.5H4.5C3.67 13.5 3 12.83 3 12V3.5Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
            </svg>
          {:else}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 2H10L13 5V13C13 13.55 12.55 14 12 14H4C3.45 14 3 13.55 3 13V3C3 2.45 3.45 2 4 2Z" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M10 2V5H13" stroke="currentColor" stroke-width="1.2"/>
            </svg>
          {/if}
        </span>
        <span class="suggestion-name">{entry.name}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .path-input {
    flex: 1;
    height: 100%;
    border: none;
    background: transparent;
    font-family: inherit;
    font-size: 13px;
    color: var(--text-primary);
    caret-color: var(--accent);
    outline: none;
    padding: 0;
  }

  .path-input::placeholder {
    color: var(--text-tertiary);
  }

  .suggestions-dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 2px;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout, 0 4px 16px rgba(0, 0, 0, 0.15));
    max-height: 240px;
    overflow-y: auto;
    z-index: 100;
    padding: 4px;
  }

  .suggestion-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 12px;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
    transition: background var(--transition-fast);
  }

  .suggestion-item:hover,
  .suggestion-item.selected {
    background: var(--subtle-fill-secondary);
  }

  .suggestion-icon {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    color: var(--text-tertiary);
  }

  .suggestion-item.directory .suggestion-icon {
    color: var(--accent);
  }

  .suggestion-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

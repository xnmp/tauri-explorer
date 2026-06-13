<!--
  OptionPicker - Generic secondary picker for selecting from a list of options.
  Opened programmatically via dialogStore.openPicker().
-->
<script lang="ts">
  import { tick } from "svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";

  let query = $state("");
  let selectedIndex = $state(0);
  let inputRef = $state<HTMLInputElement | null>(null);
  let optionsContainerRef = $state<HTMLElement | null>(null);
  let mouseMoved = $state(false);

  const config = $derived(dialogStore.pickerConfig);
  const open = $derived(config !== null);

  const filteredOptions = $derived.by(() => {
    if (!config) return [];
    const q = query.trim().toLowerCase();
    if (!q) return config.options;
    return config.options.filter((o) => o.label.toLowerCase().includes(q));
  });

  $effect(() => {
    if (open && inputRef) {
      query = "";
      const currentIdx = config!.options.findIndex((o) => o.current);
      selectedIndex = currentIdx >= 0 ? currentIdx : 0;
      mouseMoved = false;
      tick().then(() => { inputRef?.focus(); scrollToSelected(); });
    }
  });

  function scrollToSelected(): void {
    tick().then(() => {
      const selected = optionsContainerRef?.querySelector(".option-picker-item.selected");
      selected?.scrollIntoView({ block: "nearest" });
    });
  }

  function select(id: string): void {
    config?.onSelect(id);
    dialogStore.closePicker();
  }

  function cancel(): void {
    dialogStore.closePicker();
  }

  function handleKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        cancel();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (filteredOptions.length > 0) {
          selectedIndex = (selectedIndex + 1) % filteredOptions.length;
          mouseMoved = false;
          scrollToSelected();
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (filteredOptions.length > 0) {
          selectedIndex = (selectedIndex - 1 + filteredOptions.length) % filteredOptions.length;
          mouseMoved = false;
          scrollToSelected();
        }
        break;
      case "Enter":
        event.preventDefault();
        if (filteredOptions[selectedIndex]) select(filteredOptions[selectedIndex].id);
        break;
    }
  }

  function handleInput(): void {
    selectedIndex = 0;
  }
</script>

{#if open && config}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="option-picker-overlay" onclick={cancel} onkeydown={handleKeydown} onmousemove={() => { mouseMoved = true; }}>
    <div class="option-picker-dialog" onclick={(e) => e.stopPropagation()}>
      <div class="search-container">
        <span class="search-prefix">&gt;</span>
        <input
          type="text"
          class="search-input"
          placeholder={config.title}
          bind:value={query}
          bind:this={inputRef}
          oninput={handleInput}
        />
      </div>

      <div class="options-container" bind:this={optionsContainerRef}>
        {#if filteredOptions.length > 0}
          <ul class="options-list" role="listbox">
            {#each filteredOptions as option, index (option.id)}
              {@const isSelected = index === selectedIndex}
              <li
                class="option-picker-item"
                class:selected={isSelected}
                role="option"
                aria-selected={isSelected}
                onclick={() => select(option.id)}
                onmouseenter={() => { if (mouseMoved) selectedIndex = index; }}
              >
                <span class="option-label">{option.label}</span>
                {#if option.current}
                  <span class="current-tag">current</span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <div class="no-results">No matching options</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .option-picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 15vh;
    z-index: var(--z-modal-popover);
  }

  .option-picker-dialog {
    width: 450px;
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
    font-size: 14px;
    color: var(--text-primary);
  }

  .search-input::placeholder {
    color: var(--text-tertiary);
  }

  .options-container {
    max-height: 300px;
    overflow-y: auto;
  }

  .options-list {
    list-style: none;
    margin: 0;
    padding: 8px;
  }

  .option-picker-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .option-picker-item.selected {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .option-label {
    flex: 1;
    font-size: 14px;
    font-weight: 500;
  }

  .current-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--subtle-fill-secondary);
    color: var(--text-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .option-picker-item.selected .current-tag {
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

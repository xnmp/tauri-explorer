<!--
  FilterBar — the pane's Ctrl+F filter box, lazy-loaded by NavigationBar so it
  and the AI filter (#1506, Alt+Enter) stay out of the startup bundle.
  The AI request state lives in `state/ai-filter.svelte.ts`; this component
  only routes keys and renders the indicator, hint and status line.
-->
<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { ExplorerInstance } from "$lib/state/explorer.svelte";
  import { aiFilterFor, aiTextAvailability, refreshAiTextAvailability } from "$lib/state/ai-filter.svelte";
  import { aiFilterStatus, isAiFilterKey } from "$lib/domain/ai-filter";

  interface Props {
    explorer: ExplorerInstance;
  }

  let { explorer }: Props = $props();

  const ai = $derived(aiFilterFor(explorer));
  // A box-local key (not a rebindable command), so the hint is fixed text;
  // `formatShortcut` renders Alt as "Alt" on every platform too.
  const AI_SHORTCUT = "Alt+Enter";
  const uid = $props.id();
  const statusId = `${uid}-ai-status`;

  let inputRef = $state<HTMLInputElement | null>(null);
  // The box opens with the pane's current query and owns it from then on.
  // svelte-ignore state_referenced_locally
  let localFilter = $state(explorer.filterQuery);
  let focused = $state(false);

  const aiState = $derived(ai.state);
  const aiActive = $derived(aiState.kind !== "idle");
  const status = $derived(aiFilterStatus(aiState));
  // The reminder appears only for a focused box with a usable language model.
  const showHint = $derived(focused && !aiActive && aiTextAvailability.available);

  $effect(() => {
    if (inputRef) void tick().then(() => inputRef?.focus());
  });

  onDestroy(() => ai.clear());

  function handleInput() {
    ai.clear();
    explorer.setFilter(localFilter);
  }

  function close() {
    ai.clear();
    localFilter = "";
    explorer.closeFilter();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (isAiFilterKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      // The controller reports every outcome, an empty box included (#1522).
      void ai.run(localFilter);
    }
  }

  function handleFocus() {
    focused = true;
    void refreshAiTextAvailability();
  }
</script>

<div
  class="filter-bar"
  class:ai={aiActive}
  class:ai-error={aiState.kind === "error"}
  data-ai-filter={aiState.kind}
>
  {#if aiActive}
    <span class="ai-chip" class:loading={aiState.kind === "loading"} title={aiState.kind === "idle" ? "" : `AI filter: ${aiState.query}`}>
      {#if aiState.kind === "loading"}<span class="ai-spinner" aria-hidden="true"></span>{/if}
      AI{#if aiState.kind === "applied"}<span class="ai-count">{aiState.names.size}</span>{/if}
    </span>
  {:else}
    <svg class="filter-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.5"/>
      <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  {/if}
  <input
    type="text"
    class="filter-input"
    bind:value={localFilter}
    bind:this={inputRef}
    oninput={handleInput}
    onkeydown={handleKeydown}
    onfocus={handleFocus}
    onblur={() => (focused = false)}
    placeholder="Filter..."
    aria-describedby={status || showHint ? statusId : undefined}
    autocomplete="off"
    autocorrect="off"
    autocapitalize="none"
    spellcheck="false"
    name="filter-nofill"
  />
  {#if localFilter}
    <button class="filter-clear" onclick={close} aria-label={aiActive ? "Clear AI filter" : "Clear filter"}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
    </button>
  {/if}
  {#if status && (focused || aiState.kind !== "applied")}
    <div class="filter-ai-status" id={statusId} role="status">{status}</div>
  {:else if showHint}
    <div class="filter-ai-status hint" id={statusId}><kbd>{AI_SHORTCUT}</kbd> AI filter</div>
  {/if}
</div>

<style>
  /* Filter bar — styled to match the address bar (.breadcrumbs-container).
     Fixed width so it does not grow when the clear button appears on type. */
  .filter-bar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
    box-sizing: border-box;
    width: 220px;
    height: 30px;
    padding: 0 10px;
    background: var(--address-bar-bg, rgba(255, 255, 255, 0.12));
    border: 1px solid var(--address-bar-stroke, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-pill);
    box-shadow: inset 0 1px 0 var(--address-bar-highlight, rgba(255, 255, 255, 0.04));
    animation: filterIn 150ms cubic-bezier(0, 0, 0, 1);
  }

  /* A natural-language query is longer than a substring filter. */
  .filter-bar.ai {
    width: 280px;
    padding-left: 4px;
  }

  .filter-bar:focus-within {
    border-color: var(--accent);
    background: var(--control-fill-secondary);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  .filter-bar.ai-error {
    border-color: var(--system-critical, #c42b1c);
  }

  @keyframes filterIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .filter-icon {
    color: var(--text-tertiary);
    flex-shrink: 0;
  }

  .ai-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--radius-pill);
    background: var(--accent);
    color: var(--text-on-accent, #fff);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .ai-count {
    padding-left: 4px;
    border-left: 1px solid color-mix(in srgb, currentColor 40%, transparent);
    font-variant-numeric: tabular-nums;
  }

  .ai-spinner {
    width: 9px;
    height: 9px;
    border: 1.5px solid color-mix(in srgb, currentColor 35%, transparent);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: aiSpin 700ms linear infinite;
  }

  @keyframes aiSpin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ai-spinner { animation-duration: 2s; }
  }

  .filter-input {
    flex: 1;
    min-width: 0;
    padding: 2px 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 13px;
  }

  .filter-input::placeholder {
    color: var(--text-tertiary);
  }

  .filter-clear {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-tertiary);
    cursor: pointer;
  }

  .filter-clear:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  /* Floats below the box so showing it never shifts the toolbar or list. */
  .filter-ai-status {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 30;
    max-width: 320px;
    padding: 4px 8px;
    border: 1px solid var(--layout-hairline, var(--divider));
    border-radius: var(--radius-sm, 4px);
    background: var(--background-flyout, var(--background-card, #202020));
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.35;
    white-space: normal;
    pointer-events: none;
  }

  .ai-error .filter-ai-status {
    color: var(--system-critical-text, var(--system-critical, #c42b1c));
  }

  .filter-ai-status kbd {
    padding: 0 4px;
    border: 1px solid var(--layout-hairline, var(--divider));
    border-radius: 3px;
    font-family: inherit;
    font-size: 11px;
    color: var(--text-primary);
  }
</style>

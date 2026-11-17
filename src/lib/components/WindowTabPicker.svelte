<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { filterOpenTabs, type SearchableTab } from '$lib/domain/tab-strip';
  import { fixedMenuPosition, getZoomFactor, probeSingleScaleFixedOffset } from '$lib/domain/zoom';

  let { items, activeTabId, anchorEl, onSelect, onClose }: {
    items: readonly SearchableTab[];
    activeTabId: string | null;
    anchorEl: HTMLElement;
    onSelect: (id: string) => void;
    onClose: (restoreFocus?: boolean) => void;
  } = $props();
  const uid = $props.id();
  let menu: HTMLDivElement;
  let input: HTMLInputElement;
  let query = $state('');
  let highlighted = $state(0);
  const matches = $derived(filterOpenTabs(items, query));
  const selectedIndex = $derived(Math.min(highlighted, Math.max(0, matches.length - 1)));

  function position(): void {
    if (!menu) return;
    const rect = anchorEl.getBoundingClientRect();
    const zoom = getZoomFactor();
    const point = fixedMenuPosition(
      { x: rect.right - menu.offsetWidth * zoom, y: rect.bottom + 4 * zoom },
      { width: window.innerWidth, height: window.innerHeight },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      zoom, probeSingleScaleFixedOffset(menu),
    );
    menu.style.left = `${point.x}px`;
    menu.style.top = `${point.y}px`;
  }

  onMount(() => { position(); input.focus(); });

  $effect(() => {
    matches.length;
    selectedIndex;
    void tick().then(() => {
      position();
      menu?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    });
  });

  // Activating a tab hands focus to its pane through the existing manager.
  // Only dismissal returns to the trigger; two owners must not race for focus.
  function select(id: string): void { onSelect(id); onClose(); }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      highlighted = matches.length ? (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0;
    } else if (event.key === 'Enter' && event.target === input) {
      event.preventDefault(); event.stopPropagation();
      const match = matches[selectedIndex];
      if (match) select(match.id);
    }
  }

  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && !menu?.contains(event.target) && !anchorEl.contains(event.target)) onClose();
  }
</script>

<svelte:window onpointerdown={outside} onresize={position} />

<!-- Keyboard events are the combobox/listbox's navigation contract. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="window-tab-picker" bind:this={menu} onkeydown={keydown} onfocusout={(event) => {
  if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget) && !anchorEl.contains(event.relatedTarget)) onClose();
}}>
  <div class="tab-search-header">
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3" /><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
    <input autocorrect="off" autocapitalize="none" spellcheck="false" bind:this={input} bind:value={query} oninput={() => { highlighted = 0; }} type="text" role="combobox" aria-label="Search open tabs" aria-autocomplete="list" aria-expanded="true" aria-controls={`${uid}-results`} aria-activedescendant={matches.length ? `${uid}-${selectedIndex}` : undefined} placeholder="Search open tabs…" />
    <button aria-label="Close tab search" onclick={() => onClose(true)}>×</button>
  </div>
  <div class="tab-search-count" aria-live="polite">{matches.length} {matches.length === 1 ? 'tab' : 'tabs'}</div>
  <div class="tab-search-results" id={`${uid}-results`} role="listbox" aria-label="Open tabs">
    {#each matches as item, index (item.id)}
      <button class="tab-search-result" class:current={item.id === activeTabId} id={`${uid}-${index}`} role="option" aria-selected={index === selectedIndex} tabindex="-1" title={item.path} onclick={() => select(item.id)}>
        <span class="tab-search-text"><span class="tab-search-title">{item.title}</span><span class="tab-search-path">{item.path}</span></span>
        {#if item.id === activeTabId}<span class="tab-search-current" aria-label="Current tab">✓</span>{/if}
      </button>
    {/each}
  </div>
  {#if !matches.length}<div class="tab-search-empty" role="status">No matching tabs</div>{/if}
</div>

<style>
  .window-tab-picker {
    position: fixed; z-index: 1000; display: flex; flex-direction: column;
    width: min(360px, calc(100vw / var(--app-zoom, 1) - 16px));
    max-height: min(420px, calc(100vh / var(--app-zoom, 1) - 16px));
    background: var(--background-solid); color: var(--text-primary);
    border: 1px solid var(--surface-stroke); border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout); overflow: hidden; user-select: none;
  }
  .tab-search-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--divider); }
  .tab-search-header svg { flex: none; color: var(--text-secondary); }
  .tab-search-header input { flex: 1; min-width: 0; padding: 6px 0; border: none; background: transparent; font: inherit; font-size: 13px; color: var(--text-primary); }
  .tab-search-header input::placeholder { color: var(--text-secondary); }
  .tab-search-header button { flex: none; width: 26px; height: 26px; padding: 0; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); font-size: 18px; cursor: pointer; }
  .tab-search-header button:hover { background: var(--control-fill-secondary); }
  .tab-search-count { padding: 8px 12px 4px; color: var(--text-secondary); font-size: 11px; }
  .tab-search-results { min-height: 0; overflow-y: auto; padding: 4px; }
  .tab-search-result { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px; border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
  .tab-search-result:hover, .tab-search-result[aria-selected="true"] { background: var(--subtle-fill-secondary); }
  .tab-search-text { flex: 1; min-width: 0; }
  .tab-search-title, .tab-search-path { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab-search-title { font-weight: var(--font-weight-medium); }
  .tab-search-path { margin-top: 3px; color: var(--text-secondary); font-size: 11px; white-space: pre; }
  .tab-search-current { flex: none; color: var(--accent-text, var(--accent)); }
  .tab-search-empty { padding: 20px 12px; color: var(--text-secondary); font-size: 12px; }
</style>

<!--
  WindowTabMenu - a window tab's right-click menu (#1749). Lazy-loaded by
  WindowTabBar; its items come from state/window-tab-actions.ts.
-->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { tabMenuItems, type TabMenuItem } from "$lib/state/window-tab-actions";
  import { windowTabsManager } from "$lib/state/window-tabs.svelte";
  import { openNewWindow } from "$lib/state/commands/shared";
  import { fixedMenuPosition, getZoomFactor, probeSingleScaleFixedOffset } from "$lib/domain/zoom";

  let { tabId, at, onClose }: {
    tabId: string;
    /** The pointer, in client coordinates. */
    at: { x: number; y: number };
    onClose: () => void;
  } = $props();
  let menu: HTMLDivElement;
  // Built once per menu (the strip keys it): it closes before any action runs.
  const items = untrack(() => tabMenuItems(windowTabsManager, tabId, openNewWindow));

  onMount(() => {
    const point = fixedMenuPosition(
      at,
      { width: window.innerWidth, height: window.innerHeight },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      getZoomFactor(), probeSingleScaleFixedOffset(menu),
    );
    menu.style.left = `${point.x}px`;
    menu.style.top = `${point.y}px`;
    menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  });

  function choose(item: TabMenuItem): void {
    onClose();
    item.run();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault(); event.stopPropagation();
      const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(at + step + buttons.length) % buttons.length]?.focus();
    }
  }

  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && !menu?.contains(event.target)) onClose();
  }
</script>

<svelte:window onpointerdown={outside} onresize={onClose} onblur={onClose} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="window-tab-menu" role="menu" aria-label="Tab actions" tabindex="-1" bind:this={menu} onkeydown={keydown} oncontextmenu={(e) => e.preventDefault()}>
  {#each items as item (item.id)}
    {#if item.separatorBefore}<div class="separator" role="separator"></div>{/if}
    <button class="window-tab-menu-item" role="menuitem" data-action={item.id} disabled={item.disabled} onclick={() => choose(item)}>{item.label}</button>
  {/each}
</div>

<style>
  .window-tab-menu {
    position: fixed; z-index: 1000; min-width: 190px; padding: 4px;
    background: var(--background-solid); color: var(--text-primary);
    border: 1px solid var(--surface-stroke); border-radius: var(--radius-md);
    box-shadow: var(--shadow-flyout); user-select: none; outline: none;
  }
  .window-tab-menu-item {
    display: block; width: 100%; padding: 6px 10px; border: none; border-radius: var(--radius-sm);
    background: transparent; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer;
  }
  .window-tab-menu-item:hover:not(:disabled), .window-tab-menu-item:focus-visible { background: var(--control-fill-secondary); outline: none; }
  .window-tab-menu-item:disabled { color: var(--text-tertiary); cursor: default; }
  .separator { height: 1px; margin: 4px 6px; background: var(--divider); }
</style>

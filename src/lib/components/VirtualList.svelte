<!--
  VirtualList component - Renders only visible items for performance
  Optimized for fixed-height items (32px file rows)
-->
<script lang="ts" generics="T">
  import type { Snippet } from "svelte";

  interface Props {
    items: T[];
    itemHeight: number;
    children: Snippet<[T, number]>;
    getKey?: (item: T, index: number) => string | number;
    scrollToIndex?: (index: number) => void;
  }

  let {
    items,
    itemHeight,
    children,
    getKey = (_item: T, index: number) => index,
    scrollToIndex = $bindable(),
  }: Props = $props();

  let viewportRef = $state<HTMLElement | null>(null);
  let viewportHeight = $state(0);
  let scrollTop = $state(0);

  // Buffer: render extra items above/below for smooth scrolling
  const BUFFER = 3;

  function handleScroll(event: Event) {
    scrollTop = (event.target as HTMLElement).scrollTop;
  }

  /** Scroll the viewport so that the item at `index` is visible. */
  scrollToIndex = (index: number) => {
    if (!viewportRef) return;
    const targetTop = index * itemHeight;
    const targetBottom = targetTop + itemHeight;
    if (targetTop < viewportRef.scrollTop) {
      viewportRef.scrollTop = targetTop;
    } else if (targetBottom > viewportRef.scrollTop + viewportRef.clientHeight) {
      viewportRef.scrollTop = targetBottom - viewportRef.clientHeight;
    }
  };

  // Derived chain — Svelte 5 memoizes these, so downstream only
  // recomputes when startIndex/endIndex values actually change
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / itemHeight) - BUFFER));
  const visibleCount = $derived(Math.ceil(viewportHeight / itemHeight) + BUFFER * 2);
  const endIndex = $derived(Math.min(startIndex + visibleCount, items.length));

  const visibleItems = $derived(
    items.slice(startIndex, endIndex).map((item, offset) => ({
      item,
      index: startIndex + offset,
      key: getKey(item, startIndex + offset)
    }))
  );

  const paddingTop = $derived(startIndex * itemHeight);
  const paddingBottom = $derived(Math.max(0, (items.length - endIndex) * itemHeight));
</script>

<div
  class="virtual-viewport"
  bind:this={viewportRef}
  bind:clientHeight={viewportHeight}
  onscroll={handleScroll}
>
  <div class="virtual-spacer-top" style:height="{paddingTop}px"></div>

  {#each visibleItems as { item, index, key } (key)}
    <div class="virtual-item" style:height="{itemHeight}px">
      {@render children(item, index)}
    </div>
  {/each}

  <div class="virtual-spacer-bottom" style:height="{paddingBottom}px"></div>
</div>

<style>
  .virtual-viewport {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .virtual-item {
    overflow: hidden;
  }

  .virtual-spacer-top,
  .virtual-spacer-bottom {
    pointer-events: none;
  }
</style>

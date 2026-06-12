<!--
  VirtualList component - Renders only visible items for performance
  Fixed-height items by default (32px file rows); pass `getItemHeight` for
  variable-height lists (offsets become prefix sums, lookup a binary search).
-->
<script lang="ts" generics="T">
  import type { Snippet } from "svelte";
  import {
    computeOffsets,
    firstVisibleIndex,
    lastVisibleIndexExclusive,
  } from "$lib/domain/virtual-layout";

  interface Props {
    items: T[];
    /** Row height; in variable mode the fallback when getItemHeight is absent for an index. */
    itemHeight: number;
    /** Variable-height mode: per-item height. Must be pure and fast — it runs for every item when `items` changes. */
    getItemHeight?: (item: T, index: number) => number;
    /** ARIA role for the scroll viewport (e.g. "listbox"). Item wrappers
     *  become presentational so snippet content can carry "option" roles. */
    role?: string;
    children: Snippet<[T, number]>;
    getKey?: (item: T, index: number) => string | number;
    scrollToIndex?: (index: number) => void;
  }

  let {
    items,
    itemHeight,
    getItemHeight,
    role,
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

  // Variable-height layout: prefix-sum offsets, recomputed only when the
  // items array changes (memoized by $derived), never on scroll.
  // Layout math lives in domain/virtual-layout.ts (pure, unit-tested).
  const layout = $derived.by(() => {
    if (!getItemHeight) return null;
    return computeOffsets(items, getItemHeight);
  });

  function heightAt(index: number): number {
    return getItemHeight?.(items[index], index) ?? itemHeight;
  }

  /** Scroll the viewport so that the item at `index` is visible. */
  scrollToIndex = (index: number) => {
    if (!viewportRef || index < 0 || index >= items.length) return;
    const targetTop = layout ? layout.offsets[index] : index * itemHeight;
    const targetBottom = targetTop + heightAt(index);
    if (targetTop < viewportRef.scrollTop) {
      viewportRef.scrollTop = targetTop;
    } else if (targetBottom > viewportRef.scrollTop + viewportRef.clientHeight) {
      viewportRef.scrollTop = targetBottom - viewportRef.clientHeight;
    }
  };

  // Derived chain — Svelte 5 memoizes these, so downstream only
  // recomputes when startIndex/endIndex values actually change
  const visibleCount = $derived(Math.ceil(viewportHeight / itemHeight) + BUFFER * 2);
  // Clamp against items.length so a shrinking list (e.g. bulk delete while
  // scrolled deep) never leaves the viewport blank with a stale scrollTop
  const startIndex = $derived.by(() => {
    if (items.length === 0) return 0;
    if (layout) {
      return Math.max(0, firstVisibleIndex(layout.offsets, scrollTop) - BUFFER);
    }
    return Math.max(
      0,
      Math.min(Math.floor(scrollTop / itemHeight) - BUFFER, items.length - visibleCount)
    );
  });
  const endIndex = $derived.by(() => {
    if (layout) {
      const viewBottom = scrollTop + viewportHeight;
      const lastExclusive = lastVisibleIndexExclusive(layout.offsets, startIndex, viewBottom);
      return Math.min(items.length, lastExclusive + BUFFER);
    }
    return Math.min(startIndex + visibleCount, items.length);
  });

  const visibleItems = $derived(
    items.slice(startIndex, endIndex).map((item, offset) => ({
      item,
      index: startIndex + offset,
      key: getKey(item, startIndex + offset)
    }))
  );

  const paddingTop = $derived(
    layout ? (layout.offsets[startIndex] ?? 0) : startIndex * itemHeight
  );
  const paddingBottom = $derived.by(() => {
    if (layout) {
      const endOffset = endIndex < items.length ? layout.offsets[endIndex] : layout.totalHeight;
      return Math.max(0, layout.totalHeight - endOffset);
    }
    return Math.max(0, (items.length - endIndex) * itemHeight);
  });
</script>

<div
  class="virtual-viewport"
  bind:this={viewportRef}
  bind:clientHeight={viewportHeight}
  onscroll={handleScroll}
  {role}
>
  <div class="virtual-spacer-top" style:height="{paddingTop}px" aria-hidden="true"></div>

  {#each visibleItems as { item, index, key } (key)}
    <div
      class="virtual-item"
      style:height="{layout ? heightAt(index) : itemHeight}px"
      role={role ? "presentation" : undefined}
    >
      {@render children(item, index)}
    </div>
  {/each}

  <div class="virtual-spacer-bottom" style:height="{paddingBottom}px" aria-hidden="true"></div>
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

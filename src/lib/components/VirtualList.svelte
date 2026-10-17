<!--
  VirtualList component - Renders only visible items for performance
  Fixed-height items by default (32px file rows); pass `getItemHeight` for
  variable-height lists (offsets become prefix sums, lookup a binary search).
-->
<script lang="ts" generics="T">
  import { getAbortSignal, onDestroy, tick, type Snippet } from "svelte";
  import {
    computeOffsets,
    firstVisibleIndex,
    lastVisibleIndexExclusive,
  } from "$lib/domain/virtual-layout";
  import { createRafCoalescer } from "$lib/domain/raf-coalesce";

  interface Props {
    items: T[];
    /** Row height; in variable mode the fallback when getItemHeight is absent for an index. */
    itemHeight: number;
    /** Variable-height mode: per-item height. Must be pure and fast — it runs for every item when `items` changes. */
    getItemHeight?: (item: T, index: number) => number;
    /** ARIA role for the scroll viewport (e.g. "listbox"). Item wrappers
     *  become presentational so snippet content can carry "option" roles. */
    role?: string;
    tabindex?: number;
    "aria-label"?: string;
    "aria-rowcount"?: number;
    "aria-colcount"?: number;
    "aria-multiselectable"?: boolean;
    /** Query the reactive rendered window without retaining row DOM nodes. */
    containsIndex?: (index: number) => boolean;
    children: Snippet<[T, number]>;
    getKey?: (item: T, index: number) => string | number;
    scrollToIndex?: (index: number) => void;
    /** Scroll to an absolute offset (CSS px); the rendered window follows synchronously. */
    scrollToOffset?: (top: number) => void;
    /** Reports the scrollport's inner width (fractional CSS px, excluding padding
     *  and a scrollbar) and its client height, within ResizeObserver delivery and
     *  so before paint (#1061). Size changes of the content never trigger it. */
    onviewportsize?: (size: { width: number; height: number }) => void;
    /** Extra class(es) for the scroll viewport (e.g. "list-view" so marquee /
     *  keyboard-nav DOM lookups and view-scoped CSS keep resolving). */
    class?: string;
    /** Overflow for each item wrapper. Grids (List/Tiles) need "visible" so an
     *  inline-rename box can float past its row; the default clips (Details). */
    itemOverflow?: "hidden" | "visible";
    /** Padding applied to the scroll viewport (grids inset their content here). */
    viewportPadding?: string;
    /** Called when the rendered window nears the end of `items` — incremental
     *  loaders (git graph paging) append more items in response. */
    onnearend?: () => void;
    /** Called after scrolled rows have reached the DOM, for viewport hit testing. */
    onviewportscroll?: () => void;
    /** Called after viewport/row geometry updates reach the virtual DOM. */
    onlayoutchange?: () => void;
  }

  let {
    items,
    itemHeight,
    getItemHeight,
    role,
    tabindex,
    "aria-label": ariaLabel,
    "aria-rowcount": ariaRowCount,
    "aria-colcount": ariaColCount,
    "aria-multiselectable": ariaMultiselectable,
    containsIndex = $bindable(),
    children,
    getKey = (_item: T, index: number) => index,
    scrollToIndex = $bindable(),
    scrollToOffset = $bindable(),
    onviewportsize,
    class: className = "",
    itemOverflow = "hidden",
    viewportPadding,
    onnearend,
    onviewportscroll,
    onlayoutchange,
  }: Props = $props();

  let viewportRef = $state<HTMLElement | null>(null);
  let viewportHeight = $state(0);
  let scrollTop = $state(0);

  $effect(() => {
    if (!onlayoutchange || viewportHeight <= 0) return;
    // Item changes cover grid reflow; height changes cover pane resizing.
    void items;
    void itemHeight;
    void getItemHeight;
    const signal = getAbortSignal();
    void tick().then(() => {
      if (!signal.aborted && viewportRef?.isConnected) onlayoutchange?.();
    });
  });

  // Buffer: render extra items above/below for smooth scrolling
  const BUFFER = 3;

  // Scroll events outpace the display (multiple per frame on fast wheel /
  // high-Hz mice); writing $state per event re-runs the visible-range
  // derivation for frames that are never painted. Coalesce to one write per
  // animation frame, keeping the latest position (same pattern as the
  // marquee's move batching).
  const scrollCoalescer = createRafCoalescer<number>((top) => {
    scrollTop = top;
    if (onviewportscroll) {
      // Hit testing must see the new virtual rows, rather than the previous
      // window that existed when the browser dispatched the scroll event.
      void tick().then(() => {
        if (viewportRef?.isConnected) onviewportscroll?.();
      });
    }
  });

  function handleScroll(event: Event) {
    scrollCoalescer.push((event.target as HTMLElement).scrollTop);
  }

  onDestroy(() => scrollCoalescer.cancel());

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
    scrollCoalescer.cancel();
    const targetTop = layout ? layout.offsets[index] : index * itemHeight;
    const targetBottom = targetTop + heightAt(index);
    if (targetTop < viewportRef.scrollTop) {
      viewportRef.scrollTop = targetTop;
    } else if (targetBottom > viewportRef.scrollTop + viewportRef.clientHeight) {
      viewportRef.scrollTop = targetBottom - viewportRef.clientHeight;
    }
    scrollTop = viewportRef.scrollTop;
  };

  scrollToOffset = (top: number) => {
    if (!viewportRef || !Number.isFinite(top)) return;
    scrollCoalescer.cancel();
    viewportRef.scrollTop = Math.max(0, top);
    scrollTop = viewportRef.scrollTop;
  };

  // A zero-height, normal-flow probe measures the content width (fractional,
  // without the scrollbar); the viewport's border box gives the height. Neither
  // depends on the items, so reporting cannot feed back into a resize loop.
  let probeRef = $state<HTMLElement | null>(null);
  const reportsSize = $derived(!!onviewportsize);
  $effect(() => {
    const viewport = viewportRef, probe = probeRef;
    if (!viewport || !probe) return;
    const observer = new ResizeObserver(() => {
      const width = parseFloat(getComputedStyle(probe).width);
      // A retained (hidden) tab has no box: keep the last real size.
      if (width > 0 && viewport.clientHeight > 0) onviewportsize?.({ width, height: viewport.clientHeight });
    });
    observer.observe(probe);
    observer.observe(viewport, { box: "border-box" });
    return () => observer.disconnect();
  });

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

  containsIndex = (index) => index >= startIndex && index < endIndex;

  const visibleItems = $derived(
    items.slice(startIndex, endIndex).map((item, offset) => ({
      item,
      index: startIndex + offset,
      key: getKey(item, startIndex + offset)
    }))
  );

  // Near-end notification for incremental loaders. An $effect (not $derived):
  // this is a genuine callback side effect driven by the scroll window.
  const NEAR_END_ROWS = 20;
  $effect(() => {
    if (onnearend && items.length > 0 && endIndex >= items.length - NEAR_END_ROWS) {
      onnearend();
    }
  });

  // A persistent extent prevents native scroll clamping while keyed rows
  // are replaced. Separate spacers can briefly expose a shorter document.
  const totalHeight = $derived(layout ? layout.totalHeight : items.length * itemHeight);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- Callers provide the composite role and use the viewport as a focus fallback for an unmounted cursor. -->
<div
  class="virtual-viewport {className}"
  bind:this={viewportRef}
  bind:clientHeight={viewportHeight}
  onscroll={handleScroll}
  style:padding={viewportPadding}
  {role} {tabindex}
  aria-label={ariaLabel} aria-rowcount={ariaRowCount} aria-colcount={ariaColCount}
  aria-multiselectable={ariaMultiselectable}
>
  {#if reportsSize}<div class="virtual-probe" bind:this={probeRef} aria-hidden="true"></div>{/if}
  <div class="virtual-canvas" style:height="{totalHeight}px">

  {#each visibleItems as { item, index, key } (key)}
    <div
      class="virtual-item"
      style:top="{layout ? layout.offsets[index] : index * itemHeight}px"
      style:height="{layout ? heightAt(index) : itemHeight}px"
      style:overflow={itemOverflow}
      role={role ? "presentation" : undefined}
    >
      {@render children(item, index)}
    </div>
  {/each}

  </div>
</div>

<style>
  .virtual-viewport {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .virtual-canvas {
    position: relative;
    flex-shrink: 0;
  }

  .virtual-probe {
    height: 0;
    pointer-events: none;
  }

  .virtual-item {
    position: absolute;
    left: 0;
    right: 0;
    overflow: hidden;
  }
</style>

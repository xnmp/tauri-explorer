<!--
  The tab-and-page outlines of one Tiles row group (#1241, spec §9.3–§9.4):
  fill, hairline and the accent fading into it, plus each stacked panel's
  ribbon. Paths are pure (tile-panel-outline.ts) and redrawn from whatever
  geometry is on screen, so motion frames redraw them too. Decorative: only a
  ribbon's wide transparent stroke takes the pointer, for hover emphasis, which
  is immediate (#503).
-->
<script lang="ts">
  import { groupOutlines } from "$lib/domain/tile-panel-outline";
  import type { GroupGeometry, RowMetrics } from "$lib/domain/tile-panels";

  interface Props {
    geometry: GroupGeometry;
    metrics: RowMetrics;
    /** Mid-motion: bends shrink into whatever gap exists. */
    compact: boolean;
    /** The emphasized panel's folder. */
    hot: string | null;
    /** Open panels (closing ghosts are not hover targets). */
    live: ReadonlyMap<string, unknown>;
  }
  let { geometry, metrics, compact, hot, live }: Props = $props();
  const uid = $props.id();
  const outlines = $derived(groupOutlines(geometry, metrics, compact));
</script>

<svg class="tile-outlines" width={metrics.width} height={geometry.height} aria-hidden="true" focusable="false">
  <defs>
    {#each outlines as outline, i (outline.path)}
      <linearGradient id="{uid}-{i}" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={outline.accent.y1} y2={outline.accent.y2}>
        {#each outline.accent.stops as stop, s (s)}
          <stop offset={stop.offset} style:stop-color="var(--accent)" style:stop-opacity={stop.opacity} />
        {/each}
      </linearGradient>
    {/each}
  </defs>
  {#each outlines as outline, i (outline.path)}
    <g class="tile-outline" class:hot={hot === outline.path} data-panel-owner={live.has(outline.path) ? outline.path : undefined}
      style:opacity={(hot === outline.path ? 1 : 0.78) * outline.opacity}>
      <path class="outline-fill" d={outline.d} />
      <path class="outline-hair" d={outline.d} />
      <path class="outline-accent" d={outline.d} stroke="url(#{uid}-{i})" />
      {#if outline.ribbon}<path class="outline-ribbon-hit" d={outline.ribbon} />{/if}
    </g>
  {/each}
</svg>

<style>
  .tile-outlines {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }
  .tile-outline { transition: none; }
  .outline-fill { fill: var(--subtle-fill-tertiary); stroke: none; }
  .outline-hair { fill: none; stroke: var(--surface-stroke); stroke-width: 1; }
  .outline-accent { fill: none; stroke-width: 1.5; stroke-linejoin: round; }
  .outline-ribbon-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
</style>

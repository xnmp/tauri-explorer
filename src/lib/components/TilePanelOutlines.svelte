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
    /** Group-local geometry; the SVG's origin is the group's top-left. */
    geometry: GroupGeometry;
    metrics: RowMetrics;
    /** Mid-motion: bends shrink into whatever gap exists. */
    compact: boolean;
    /** The emphasized panel's folder. */
    hot: string | null;
    /** Open panels (closing ghosts are not hover targets). */
    live: ReadonlyMap<string, unknown>;
    /** A drag's temporary panels (#1242): their band gap, or a stacked panel's
     * ribbon and the channel around it, are part of the peek. */
    bridged?: readonly string[];
  }
  let { geometry, metrics, compact, hot, live, bridged = [] }: Props = $props();
  const uid = $props.id();
  const outlines = $derived(groupOutlines(geometry, metrics, compact));
</script>

<!-- The group's own box, behind its row and panels. It must have a real size:
     Chromium paints nothing for an empty SVG root, even with overflow visible
     (the ribbon's last-resort channel lies in the scroller padding beside it). -->
<svg class="tile-outlines" aria-hidden="true" focusable="false">
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
      {#if outline.ribbon && live.has(outline.path) && bridged.includes(outline.path)}
        <!-- A temporary stacked panel's way from its tile: the channel around the
             ribbon, wherever it is not covered by tiles and panels (which sit
             above this box), and the ribbon itself are inside its peek and drop
             into its folder. -->
        <path class="outline-channel-hit" d={outline.ribbon} data-spring-bridge={outline.path} />
        <path class="outline-ribbon-hit" d={outline.ribbon} data-spring-bridge={outline.path} />
      {:else if outline.ribbon}<path class="outline-ribbon-hit" d={outline.ribbon} />{/if}
      {#if outline.bridge && live.has(outline.path) && bridged.includes(outline.path)}
        <!-- Crossing the gap between a temporary panel's tile and panel stays inside its peek. -->
        <rect class="outline-bridge-hit" data-spring-bridge={outline.path}
          x={outline.bridge.x} y={outline.bridge.y} width={outline.bridge.width} height={outline.bridge.height} />
      {/if}
    </g>
  {/each}
</svg>

<style>
  .tile-outlines {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .tile-outline { transition: none; }
  .outline-fill { fill: var(--subtle-fill-tertiary); stroke: none; }
  .outline-hair { fill: none; stroke: var(--surface-stroke); stroke-width: 1; }
  .outline-accent { fill: none; stroke-width: 1.5; stroke-linejoin: round; }
  .outline-ribbon-hit { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
  /* 32px either side of the ribbon: a drag need not follow its 14px stroke. */
  .outline-channel-hit { fill: none; stroke: transparent; stroke-width: 64; stroke-linejoin: round; pointer-events: stroke; }
  .outline-bridge-hit { fill: transparent; stroke: none; pointer-events: fill; }
</style>

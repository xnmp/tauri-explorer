<!--
  GitGraphLanes — the windowed lane SVG beneath the commit rows: branch
  lines (with crossing halos), the traced lineage overlay and commit
  vertices. Geometry comes from domain/git-graph; this only paints it.
  The clip window hides lanes beyond a user-narrowed graph column (#341).
-->
<script lang="ts">
  import type { GraphCommit as CommitInfo } from "$lib/state/git-graph-cache";
  import { UNCOMMITTED_OID } from "$lib/state/git-graph-detail.svelte";
  import {
    branchPath,
    GRAPH_PALETTE,
    type BranchLine,
    type GraphTrace,
    type GraphVertex,
    type RowExpand,
  } from "$lib/domain/git-graph";
  import { GRAPH_LANE_WIDTH as LANE_WIDTH, GRAPH_ROW_HEIGHT as ROW_HEIGHT, splitUncommittedLine } from "$lib/domain/git-graph-view";

  interface Props {
    clipEl?: HTMLElement;
    clipId: string;
    clipWidth: number;
    width: number;
    height: number;
    rows: readonly CommitInfo[];
    headRow: number;
    branches: readonly BranchLine[];
    uncommittedBranch: BranchLine | undefined;
    traceSegments: readonly BranchLine[];
    vertices: readonly { vertex: GraphVertex; vi: number }[];
    trace: GraphTrace | null;
    rowExpand: RowExpand | undefined;
  }

  let {
    clipEl = $bindable(),
    clipId, clipWidth, width, height, rows, headRow, branches, uncommittedBranch,
    traceSegments, vertices, trace, rowExpand,
  }: Props = $props();

  function colorOf(index: number): string {
    return GRAPH_PALETTE[index % GRAPH_PALETTE.length];
  }
</script>

<div bind:this={clipEl} id={clipId} class="graph-clip" style:width="{clipWidth}px">
<svg
  class="graph-underlay"
  {width}
  {height}
  aria-hidden="true"
>
  {#each branches as line, li (li)}
    {#if line === uncommittedBranch}
      {@const parts = splitUncommittedLine(line, headRow)}
      <path class="branch-halo" data-trace={trace ? "dim" : undefined} d={branchPath(parts.dirty, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
      <path
        data-trace={trace ? "dim" : undefined}
        d={branchPath(parts.dirty, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
        stroke="#808080"
        stroke-dasharray="4 3"
        stroke-width="2"
        fill="none"
      />
      {#if parts.rest.points.length > 1}
        <path class="branch-halo" data-trace={trace ? "dim" : undefined} d={branchPath(parts.rest, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
        <path
          data-trace={trace ? "dim" : undefined}
          d={branchPath(parts.rest, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
          stroke={colorOf(line.colorIndex)}
          stroke-width="2"
          fill="none"
        />
      {/if}
    {:else}
      <path class="branch-halo" data-trace={trace ? "dim" : undefined} d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)} />
      <path
        data-trace={trace ? "dim" : undefined}
        d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
        stroke={colorOf(line.colorIndex)}
        stroke-width="2"
        fill="none"
      />
    {/if}
  {/each}
  {#each traceSegments as line, li (`trace-${li}`)}
    <path
      class="branch-halo trace-lit"
      data-trace="lit"
      d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
    />
    <path
      class="trace-lit"
      data-trace="lit"
      d={branchPath(line, LANE_WIDTH, ROW_HEIGHT, rowExpand)}
      stroke={colorOf(line.colorIndex)}
      stroke-width="2"
      fill="none"
    />
  {/each}
  {#each vertices as { vertex, vi } (vi)}
    {@const cx = vertex.lane * LANE_WIDTH + LANE_WIDTH / 2}
    {@const cy = vi * ROW_HEIGHT + ROW_HEIGHT / 2 + (rowExpand && vi > rowExpand.afterRow ? rowExpand.extra : 0)}
    {#if rows[vi]?.oid === UNCOMMITTED_OID}
      <!-- Open circle at the uncommitted-changes row (reference default). -->
      <circle data-trace={trace ? (trace.rows.has(vi) ? "lit" : "dim") : undefined} {cx} {cy} r="4" fill="var(--background-card)" stroke="#808080" stroke-width="2" />
    {:else if rows[vi]?.stash}
      <!-- Stash: ring marker. -->
      <circle data-trace={trace ? (trace.rows.has(vi) ? "lit" : "dim") : undefined} {cx} {cy} r="4.5" fill="none" stroke={colorOf(vertex.colorIndex)} stroke-width="2" />
      <circle data-trace={trace ? (trace.rows.has(vi) ? "lit" : "dim") : undefined} {cx} {cy} r="2" fill={colorOf(vertex.colorIndex)} />
    {:else}
      <circle data-trace={trace ? (trace.rows.has(vi) ? "lit" : "dim") : undefined} {cx} {cy} r="4" fill={colorOf(vertex.colorIndex)} />
    {/if}
  {/each}
</svg>
</div>

<style>
  /* Clip window for the lane SVG (#341): same origin the underlay used to
     have; hides lanes beyond the (possibly user-narrowed) graph column. */
  .graph-clip {
    position: absolute;
    top: 0;
    left: 10px;
    height: 100%;
    overflow: hidden;
    pointer-events: none;
  }

  .graph-underlay {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
  }

  .graph-underlay [data-trace] {
    transition: opacity 100ms ease;
  }

  .graph-underlay [data-trace="dim"] {
    opacity: 0.16;
  }

  .graph-underlay .trace-lit {
    opacity: 1;
  }

  /* Subtle halo under each line so crossings stay legible (reference uses a
     shadow path beneath every line). */
  .branch-halo {
    stroke: var(--background-card);
    stroke-width: 4px;
    fill: none;
  }
</style>

<script lang="ts">
  import { onMount } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { traceForImage, type TraceArtifact, type TraceGraph } from "$lib/api/trace";
  import { layoutTraceGraph, traceOperationLabel } from "$lib/domain/trace-layout";
  import { traceInvalidation } from "./invalidation.svelte";
  import TraceDetails from "./TraceDetails.svelte";

  function artifactCaption(artifact: TraceArtifact, graph: TraceGraph): string {
    if (artifact.pathState === "missing") return "Missing";
    if (artifact.id !== graph.currentArtifactId) return "";
    return graph.selectedRevisionStatus === "matched" ? "Current" : "Last recorded";
  }

  let { entries }: { entries: FileEntry[] } = $props();
  let graph = $state<TraceGraph | null>(null);
  let loading = $state(false);
  let error = $state("");
  let focusedKey = $state("");
  const path = $derived(entries[0]?.path ?? "");
  const layout = $derived(graph ? layoutTraceGraph(graph) : null);
  const selectedKey = $derived(graph && layout?.nodes.some((node) => node.key === focusedKey)
    ? focusedKey : graph ? `a:${graph.currentArtifactId}` : "");

  $effect(() => {
    void path;
    focusedKey = "";
  });

  onMount(() => {
    const refresh = () => traceInvalidation.bump();
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); };
  });

  $effect(() => {
    const selectedPath = path;
    void entries[0]?.modified;
    void entries[0]?.size;
    void traceInvalidation.revision;
    let cancelled = false;
    graph = null;
    error = "";
    loading = true;
    void traceForImage(selectedPath).then((result) => {
      if (cancelled) return;
      loading = false;
      if (result.ok) graph = result.data;
      else error = result.error;
    });
    return () => { cancelled = true; };
  });
</script>

<div class="trace-body">
  {#if loading}
    <p role="status">Loading trace…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if !graph || !layout}
    <p>No recorded edits for this image.</p>
  {:else}
    <div class="summary"><span>IMAGE LINEAGE</span><span>{graph.artifacts.length} artifacts · {graph.runs.length} runs</span></div>
    {#if graph.selectedRevisionStatus === "changed"}
      <p class="changed-notice" role="status">This file changed since it was recorded. Showing its last recorded revision.</p>
    {:else if graph.selectedRevisionStatus === "unverified"}
      <p class="changed-notice" role="status">This file exceeds the 200 MiB verification limit. Showing its last recorded revision; its current bytes were not checked.</p>
    {/if}
    <div class="trace-scroll">
      <div class="trace-canvas" style={`width:${layout.width}px;height:${layout.height}px`} role="list" aria-label="Image provenance">
        <svg class="trace-edges" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true">
          {#each layout.edges as edge (`${edge.from}-${edge.to}`)}
            <path d={edge.path} />
          {/each}
        </svg>
        {#each layout.nodes as node (node.key)}
          {#if node.kind === "artifact"}
            {@const artifact = graph.artifacts.find((item) => item.id === node.id)}
            {#if artifact}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="artifact" class:current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched"}
                  aria-current={artifact.id === graph.currentArtifactId && graph.selectedRevisionStatus === "matched" ? "true" : undefined}
                  aria-pressed={selectedKey === node.key}
                  aria-controls="trace-node-details"
                  onclick={() => focusedKey = node.key}>
                  <span class="artifact-icon" aria-hidden="true">▧</span>
                  <span class="artifact-text"><strong>{artifact.path.split(/[\\/]/).at(-1)}</strong><small>{artifactCaption(artifact, graph) ? `${artifactCaption(artifact, graph)} · ` : ""}{artifact.digest.slice(0, 10)}</small></span>
                </button>
              </div>
            {/if}
          {:else}
            {@const run = graph.runs.find((item) => item.id === node.id)}
            {#if run}
              <div role="listitem" class="node-frame" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}>
                <button type="button" class="operation" aria-pressed={selectedKey === node.key} aria-controls="trace-node-details" onclick={() => focusedKey = node.key}>
                  <strong>{traceOperationLabel(run.operation)}</strong>
                  {#if run.parameters.rect}
                    <small>{run.parameters.rect.right - run.parameters.rect.left} × {run.parameters.rect.bottom - run.parameters.rect.top}</small>
                  {/if}
                  {#if run.status !== "succeeded"}<small class="run-status">{run.status}</small>{/if}
                </button>
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    </div>
    <TraceDetails {graph} nodeKey={selectedKey} />
  {/if}
</div>

<style>
  .trace-body { padding: 12px; color: var(--text-secondary); font-size: 12px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .summary { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin: 1px 0 12px; font-size: 10px; color: var(--text-secondary); }
  .summary span:first-child { font-weight: 700; letter-spacing: .07em; }
  .changed-notice { margin: 0 0 12px; padding: 8px; border: 1px solid var(--surface-stroke); border-radius: 5px; background: var(--background-card-secondary); color: var(--text-primary); }
  .trace-scroll { overflow: auto; max-height: calc(100vh - 150px); border-radius: 6px; }
  .trace-canvas { position: relative; min-width: 100%; }
  .trace-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  .trace-edges path { fill: none; stroke: var(--accent); stroke-opacity: .55; stroke-width: 1.25; }
  .node-frame { position: absolute; }
  .artifact, .operation { box-sizing: border-box; display: flex; align-items: center; width: 100%; height: 100%; min-width: 0; cursor: pointer; font: inherit; text-align: left; }
  .artifact:focus-visible, .operation:focus-visible { outline: 2px solid var(--focus-stroke-outer); outline-offset: 2px; }
  .artifact[aria-pressed="true"], .operation[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--accent); }
  .artifact { gap: 5px; padding: 5px; border: 1px solid var(--surface-stroke); border-radius: 7px; background: var(--background-card); color: var(--text-primary); }
  .artifact.current { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--background-card)); }
  .artifact-icon { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 17%, var(--background-card)); color: var(--accent-text, var(--text-primary)); font-size: 12px; }
  .artifact-text { display: block; min-width: 0; }
  .artifact strong, .artifact small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .artifact strong { font-size: 10px; font-weight: 650; }
  .artifact small { margin-top: 4px; font-size: 9px; color: var(--text-secondary); font-family: monospace; }
  .operation { flex-direction: column; justify-content: center; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--surface-stroke)); border-radius: 5px; background: color-mix(in srgb, var(--accent) 12%, var(--background-card)); color: var(--accent-text, var(--text-primary)); font-size: 10px; }
  .operation strong { font-weight: 700; }
  .operation small { margin-top: 2px; font-size: 9px; }
  .operation .run-status { text-transform: capitalize; }
</style>

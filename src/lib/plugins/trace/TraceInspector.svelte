<script lang="ts">
  import { onMount } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { traceForImage, type TraceGraph } from "$lib/api/trace";
  import { layoutTraceGraph } from "$lib/domain/trace-layout";
  import { parentDir, sameDirectory } from "$lib/domain/path";
  import { subscribeToLocalFileChanges } from "$lib/state/file-events";
  import { traceInvalidation } from "./invalidation.svelte";

  let { entries }: { entries: FileEntry[] } = $props();
  let graph = $state<TraceGraph | null>(null);
  let loading = $state(false);
  let error = $state("");
  const path = $derived(entries[0]?.path ?? "");
  const layout = $derived(graph ? layoutTraceGraph(graph) : null);

  onMount(() => {
    const unsubscribe = subscribeToLocalFileChanges((directories) => {
      if (directories.some((directory) => sameDirectory(directory, parentDir(path)))) traceInvalidation.bump();
    });
    const refresh = () => traceInvalidation.bump();
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("focus", refresh); };
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
    <div class="summary"><span>IMAGE LINEAGE</span><span>{graph.artifacts.length} artifacts · {graph.runs.length} edits</span></div>
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
              <div role="listitem" class="artifact" class:current={artifact.id === graph.currentArtifactId}
                aria-current={artifact.id === graph.currentArtifactId ? "true" : undefined}
                style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}
                title={`${artifact.path}\nSHA-256: ${artifact.digest}`}>
                <span class="artifact-icon" aria-hidden="true">▧</span>
                <span class="artifact-text"><strong>{artifact.path.split(/[\\/]/).at(-1)}</strong><small>{artifact.id === graph.currentArtifactId ? "Current · " : ""}{artifact.digest.slice(0, 10)}</small></span>
              </div>
            {/if}
          {:else}
            {@const run = graph.runs.find((item) => item.id === node.id)}
            {#if run}
              <div role="listitem" class="operation" style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px`}
                title={`${run.operation}\n${JSON.stringify(run.parameters)}`}>
                <strong>{run.operation === "image.crop" ? "Crop" : run.operation.replace(/^image\./, "")}</strong>
                {#if run.parameters.rect}
                  <small>{run.parameters.rect.right - run.parameters.rect.left} × {run.parameters.rect.bottom - run.parameters.rect.top}</small>
                {/if}
              </div>
            {/if}
          {/if}
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .trace-body { padding: 12px; color: var(--text-secondary); font-size: 12px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  .summary { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; margin: 1px 0 12px; font-size: 10px; color: var(--text-secondary); }
  .summary span:first-child { font-weight: 700; letter-spacing: .07em; }
  .trace-scroll { overflow: auto; max-height: calc(100vh - 150px); border-radius: 6px; }
  .trace-canvas { position: relative; min-width: 100%; }
  .trace-edges { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
  .trace-edges path { fill: none; stroke: var(--accent); stroke-opacity: .55; stroke-width: 1.25; }
  .artifact, .operation { box-sizing: border-box; position: absolute; display: flex; align-items: center; min-width: 0; }
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
</style>

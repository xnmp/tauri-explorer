<script lang="ts">
  import { onMount } from "svelte";
  import type { FileEntry } from "$lib/domain/file";
  import { traceForImage, type TraceGraph, type TraceArtifact } from "$lib/api/trace";
  import { parentDir, sameDirectory } from "$lib/domain/path";
  import { subscribeToLocalFileChanges } from "$lib/state/file-events";
  import { traceInvalidation } from "./invalidation.svelte";

  let { entries }: { entries: FileEntry[] } = $props();
  let graph = $state<TraceGraph | null>(null);
  let loading = $state(false);
  let error = $state("");
  const path = $derived(entries[0]?.path ?? "");

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

  function ancestors(current: TraceArtifact, trace: TraceGraph): TraceArtifact[] {
    const byId = new Map(trace.artifacts.map((artifact) => [artifact.id, artifact]));
    const runs = new Map(trace.runs.map((run) => [run.id, run]));
    const path: TraceArtifact[] = [current];
    const visited = new Set([current.id]);
    while (path[path.length - 1].generatingRun !== null) {
      const run = runs.get(path[path.length - 1].generatingRun!);
      const parent = run?.inputIds.length === 1 ? byId.get(run.inputIds[0]) : undefined;
      if (!parent || visited.has(parent.id)) break;
      path.push(parent);
      visited.add(parent.id);
    }
    return path.reverse();
  }

  const lineage = $derived(graph ? ancestors(graph.artifacts.find((artifact) => artifact.id === graph!.currentArtifactId)!, graph) : []);
</script>

<div class="trace-body">
  {#if loading}
    <p role="status">Loading trace…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if !graph}
    <p>No recorded edits for this image.</p>
  {:else}
    <ol aria-label="Image provenance">
      {#each lineage as artifact (artifact.id)}
        <li>
          {#if artifact.generatingRun !== null}
            {@const run = graph.runs.find((item) => item.id === artifact.generatingRun)}
            <div class="operation">↓ {run?.operation === "image.crop" ? "Crop" : run?.operation ?? "Edit"}</div>
            {#if run?.parameters.rect}
              <div class="parameters">{run.parameters.rect.right - run.parameters.rect.left} × {run.parameters.rect.bottom - run.parameters.rect.top} crop</div>
            {/if}
          {/if}
          <div class="artifact" aria-current={artifact.id === graph.currentArtifactId ? "true" : undefined}>
            <span class="name" title={artifact.path}>{artifact.path.split(/[\\/]/).at(-1)}</span>
            <span class="digest" title={artifact.digest}>{artifact.digest.slice(0, 12)}</span>
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .trace-body { padding: 12px 14px; color: var(--text-secondary); font-size: 12px; }
  p { margin: 0; line-height: 1.5; overflow-wrap: anywhere; }
  ol { list-style: none; margin: 0; padding: 0; }
  li + li { margin-top: 8px; }
  .operation { margin: 4px 0 4px 8px; color: var(--text-secondary); }
  .parameters { margin: 0 0 4px 17px; font-size: 11px; }
  .artifact { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 9px; border: 1px solid var(--surface-stroke); border-radius: 5px; color: var(--text-primary); }
  .artifact[aria-current="true"] { border-color: var(--focus-stroke-outer); }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .digest { font-family: monospace; font-size: 10px; color: var(--text-secondary); }
</style>

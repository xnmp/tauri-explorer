<script lang="ts">
  import type { TraceArtifact, TraceGraph } from "$lib/api/trace";

  function describeLocation(artifact: TraceArtifact, graph: TraceGraph): string {
    if (artifact.pathState === "missing") return "Missing from recorded path";
    if (artifact.pathState === "unavailable") return "Recorded path cannot be checked";
    if (artifact.id !== graph.currentArtifactId) return "File present; bytes not checked";
    if (graph.selectedRevisionStatus === "matched") return "Matches recorded bytes";
    if (graph.selectedRevisionStatus === "changed") return "Bytes differ from recorded revision";
    return "File present; bytes not checked";
  }

  let { graph, nodeKey }: { graph: TraceGraph; nodeKey: string } = $props();
  const id = $derived(Number(nodeKey.slice(2)));
  const artifact = $derived(nodeKey.startsWith("a:") ? graph.artifacts.find((item) => item.id === id) : undefined);
  const run = $derived(nodeKey.startsWith("r:") ? graph.runs.find((item) => item.id === id) : undefined);
  const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
  const inputNames = $derived(run?.inputIds.map((inputId) => {
    const input = graph.artifacts.find((item) => item.id === inputId);
    return input ? name(input.path) : `Artifact #${inputId}`;
  }) ?? []);
  const outputNames = $derived(run ? graph.artifacts
    .filter((item) => item.generatingRun === run.id)
    .map((item) => name(item.path)) : []);
  const location = $derived(artifact ? describeLocation(artifact, graph) : "");
</script>

<section id="trace-node-details" class="details" aria-label="Trace details">
  {#if artifact}
    <div class="eyebrow">ARTIFACT REVISION</div>
    <h2 aria-live="polite">{name(artifact.path)}</h2>
    <dl>
      <dt>Origin</dt><dd>{artifact.generatingRun == null ? "Earlier origin unknown" : `Run #${artifact.generatingRun}`}</dd>
      <dt>Location</dt><dd>{location}</dd>
      <dt>Recorded</dt><dd>{artifact.createdAt}</dd>
      <dt>Path</dt><dd class="wrap">{artifact.path}</dd>
      <dt>SHA-256</dt><dd class="digest">{artifact.digest}</dd>
    </dl>
  {:else if run}
    <div class="eyebrow">OPERATION</div>
    <h2 aria-live="polite">{run.operation === "image.crop" ? "Crop" : run.operation}</h2>
    <dl>
      <dt>Run</dt><dd>#{run.id}</dd>
      <dt>Recorded</dt><dd>{run.createdAt}</dd>
      <dt>Inputs</dt><dd>{inputNames.join(", ")}</dd>
      <dt>Output</dt><dd>{outputNames.join(", ") || "No recorded output"}</dd>
    </dl>
    <div class="parameters-label">Recorded parameters</div>
    <pre>{JSON.stringify(run.parameters, null, 2)}</pre>
  {/if}
</section>

<style>
  .details { border-top: 1px solid var(--surface-stroke); padding: 12px 2px 4px; color: var(--text-primary); }
  .eyebrow { color: var(--text-secondary); font-size: 10px; font-weight: 700; letter-spacing: .07em; }
  h2 { margin: 5px 0 12px; font-size: 13px; font-weight: 650; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 7px 8px; margin: 0; font-size: 11px; line-height: 1.4; }
  dt { color: var(--text-secondary); }
  dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
  .digest { font-family: monospace; word-break: break-all; }
  .parameters-label { margin-top: 12px; color: var(--text-secondary); font-size: 11px; }
  pre { box-sizing: border-box; max-height: 180px; overflow: auto; margin: 6px 0 0; padding: 8px; border: 1px solid var(--surface-stroke); border-radius: 5px; background: var(--background-card-secondary); color: var(--text-primary); font-size: 10px; line-height: 1.4; }
</style>

<!-- Contributed acceptance surface for the host fileDropTargets capability. -->
<script lang="ts">
  import type { PluginWorkspace, PluginFileDropSource } from "../api";
  let { register }: { register: NonNullable<PluginWorkspace["registerFileDropTarget"]> } = $props();
  let enabled = $state(true);
  let batches = $state<{ paths: readonly string[]; source: PluginFileDropSource }[]>([]);

  function receiveFiles(element: HTMLElement) {
    const dispose = register(element, (paths, source) => {
      batches = [...batches, { paths: [...paths], source }];
    }, { enabled: () => enabled });
    return { destroy: dispose };
  }
</script>

<section class="file-inputs" aria-label="Demo file inputs" data-testid="demo-file-drop-target" use:receiveFiles>
  <label><input type="checkbox" bind:checked={enabled} /> Accept file drops</label>
  <p>Drop explorer files here</p>
  <div aria-live="polite">
    {#each batches as batch}
      <div data-testid="demo-file-drop-result" data-source={batch.source}>
        <p>Received from {batch.source}</p>
        <ol>{#each batch.paths as path}<li>{path}</li>{/each}</ol>
      </div>
    {/each}
  </div>
</section>

<style>
  .file-inputs { flex-basis: 100%; padding: 12px; color: var(--text-primary); border: 1px dashed var(--control-stroke); border-radius: var(--radius-sm); }
  .file-inputs:global(.drop-target) { border-color: var(--accent-text, var(--accent)); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  p { margin: 8px 0; }
  ol { margin: 0; padding-left: 20px; overflow-wrap: anywhere; }
</style>

<!--
  Demo Preview-info section (SDK 2): shows which subject Preview is displaying.
  Its shape (a heading, a wrapping paragraph and labelled rows) mirrors a real
  provenance section, so e2e layout checks exercise realistic content.
-->
<script lang="ts">
  import type { PreviewSubject } from "$lib/plugins/preview-registry.svelte";
  let { subject }: { subject: PreviewSubject } = $props();
  const rows = [
    ["Operation", "Demo render"],
    ["Resolution", "2K"],
    ["Aspect ratio", "Keep the same"],
  ] as const;
</script>

<div class="demo-section" data-testid="demo-preview-section">
  <h3 class="demo-title">Demo</h3>
  <p class="demo-info" data-testid="demo-preview-info">Demo info: {subject.kind === "file" ? subject.entry.name : subject.target.title}</p>
  <p class="demo-prompt">Replace the settings and the people with a calm lakeside scene at dusk, keeping the original framing.</p>
  <dl class="demo-rows">
    {#each rows as [label, value] (label)}
      <div class="demo-row"><dt>{label}</dt><dd>{value}</dd></div>
    {/each}
  </dl>
</div>

<style>
  .demo-section { padding: 10px var(--preview-info-inset); font-size: 12px; color: var(--text-secondary); }
  .demo-title { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .demo-info, .demo-prompt { margin: 0 0 6px; }
  .demo-rows { margin: 0; display: grid; gap: 4px; }
  .demo-row { display: grid; grid-template-columns: 6rem minmax(0, 1fr); gap: 8px; }
  .demo-row dt { color: var(--text-tertiary); }
  .demo-row dd { margin: 0; }
</style>

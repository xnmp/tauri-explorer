<!-- Demo Preview-info section (SDK 2): shows which subject Preview is displaying. -->
<script lang="ts">
  import type { PreviewSubject } from "$lib/plugins/preview-registry.svelte";
  let { subject }: { subject: PreviewSubject } = $props();
</script>

<p class="demo-info" data-testid="demo-preview-info">
  Demo info: {subject.kind === "file" ? subject.entry.name : subject.target.title}
</p>

<style>
  .demo-info { margin: 8px 0 0; font-size: 12px; color: var(--text-secondary); }
</style>

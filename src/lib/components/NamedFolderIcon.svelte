<!--
  Folder icon for surfaces that know a folder only by name (#1499): the tab
  bar, sidebar rows and history menu. A special folder name
  (domain/special-folders) draws through FileIcon in a span carrying `class`,
  `region` (data-region) and the drag-ghost icon marker, so it takes the active pack's native variant;
  anything else renders the host's own art (children).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import FileIcon from './FileIcon.svelte';
  import { specialFolderIconEntry } from './icons/special-folder-icons.svelte';

  let { name, class: cls, region, children }: { name: string; class: string; region?: string; children: Snippet } = $props();
  const entry = $derived(specialFolderIconEntry(name));
</script>

{#if entry}<span class={cls} data-region={region} data-drag-icon><FileIcon {entry} size="small" /></span>{:else}{@render children()}{/if}

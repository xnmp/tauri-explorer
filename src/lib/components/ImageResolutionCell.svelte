<script lang="ts">
  import type { FileEntry } from "$lib/domain/file";
  import { formatImageResolution, supportsImageResolution, type ImageResolution } from "$lib/domain/image-resolution";
  import { observeImageResolution } from "$lib/state/image-resolution-service";

  let { entry }: { entry: FileEntry } = $props();
  let resolution = $state<ImageResolution | null>(null);
  $effect(() => {
    // Depend on the entry object, not just path/mtime: a new listing is also a
    // freshness boundary for same-size replacements with preserved timestamps.
    const source = entry;
    resolution = null;
    if (source.kind !== "file" || !supportsImageResolution(source.name)) return;
    return observeImageResolution(source.path, value => { resolution = value; });
  });
</script>

{formatImageResolution(resolution)}

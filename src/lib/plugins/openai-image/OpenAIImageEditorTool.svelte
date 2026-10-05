<script lang="ts">
  import { onMount } from "svelte";
  import OpenAIImageForm from "./OpenAIImageForm.svelte";
  import type { PluginJobs, PluginStorage, PluginToast } from "../api";
  import type { ImageEditorSource } from "../image-editor-registry.svelte";
  import { parentDir } from "$lib/domain/path";
  let { source, storage, jobs, toast, onOpenSettings, onClose, onBusyChange }: {
    source: ImageEditorSource; storage: PluginStorage; jobs: PluginJobs; toast: PluginToast;
    onOpenSettings: () => void; onClose: () => void; onBusyChange: (busy: boolean) => void;
  } = $props();
  let settings = $state<Record<string, unknown> | null>(null);
  onMount(() => {
    let active = true;
    void storage.get().then((value) => { if (active) settings = value; });
    return () => { active = false; };
  });
</script>
{#if settings}
  <OpenAIImageForm open={true} sourcePath={source.path} sourceDigest={source.digest} referencePaths={[...source.referencePaths]} outputDir={parentDir(source.path)}
    apiKey={typeof settings.apiKey === "string" ? settings.apiKey : ""} initialBackend={settings.backend === "api_key" ? "api_key" : "codex"}
    codexPath={typeof settings.codexPath === "string" ? settings.codexPath : ""}
    {jobs} {toast} {onOpenSettings} {onClose} {onBusyChange} />
{:else}<p role="status">Loading image connection…</p>{/if}

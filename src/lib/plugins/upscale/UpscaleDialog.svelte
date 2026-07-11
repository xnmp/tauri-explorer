<!--
  Upscale dialog — fal.ai SeedVR2 image upscaling (#276).
  Plugin-owned modal, rendered via the plugin dialog registry. Receives its
  source path, API key and job/toast handles as props from the plugin's
  `activate`, and a close callback injected by the renderer.
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginToast } from "$lib/plugins/api";
  import { startUpscaleJob, checkPathsExist } from "$lib/api/files";
  import { parentDir, basename } from "$lib/domain/path";
  import { findAvailableFilename } from "$lib/domain/available-filename";

  interface Props {
    open: boolean;
    sourcePath: string;
    apiKey: string;
    jobs: PluginJobs;
    toast: PluginToast;
    onOpenSettings: () => void;
    onClose: () => void;
  }

  let { open, sourcePath, apiKey, jobs, toast, onOpenSettings, onClose }: Props = $props();

  const FACTOR_OPTIONS = [
    { value: 2, label: "2× — double resolution" },
    { value: 3, label: "3×" },
    { value: 4, label: "4× — maximum detail" },
  ];

  let factor = $state(2);
  let outputFilename = $state("");
  let submitting = $state(false);

  const fileName = $derived(basename(sourcePath));
  const outputDir = $derived(parentDir(sourcePath));
  const hasApiKey = $derived(!!apiKey);

  $effect(() => {
    if (open) {
      factor = 2;
      outputFilename = "";
      submitting = false;
      findAvailableFilename(outputDir, fileName, "_upscaled", checkPathsExist).then((name) => {
        outputFilename = name;
      });
    }
  });

  async function handleUpscale(): Promise<void> {
    if (!outputFilename.trim() || submitting || !hasApiKey) return;

    submitting = true;
    const result = await startUpscaleJob(
      sourcePath,
      outputDir,
      outputFilename.trim(),
      apiKey,
      factor,
    );

    if (result.ok) {
      jobs.add(result.data, fileName, `Upscale ${factor}×`);
      toast.show(`Upscale started: ${fileName}`, "info");
      onClose();
    } else {
      toast.error(`Failed to start upscale: ${result.error}`);
      submitting = false;
    }
  }

  // Escape is handled by Modal; Enter submits — unless a button has focus,
  // whose own activation must win.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      handleUpscale();
    }
  }
</script>

<Modal
  {open}
  {onClose}
  overlayClass="dialog-overlay"
  labelledby="upscale-title"
  onkeydown={handleKeydown}
>
  <div class="dialog plugin-dialog">
    <header class="dialog-header">
      <div class="header-content">
        <svg class="header-icon" width="20" height="20" viewBox="0 0 16 16" fill="none">
          <path d="M8 3H3V8M3 3L7 7M8 13H13V8M13 13L9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <h2 id="upscale-title">Upscale Image</h2>
      </div>
      <button class="close-btn" onclick={onClose} aria-label="Close">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
    </header>

    <div class="dialog-body">
      <div class="file-info">
        <span class="file-label">File:</span>
        <span class="file-name">{fileName}</span>
      </div>

      {#if !hasApiKey}
        <div class="api-key-warning">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M8 2L1 14h14L8 2zM8 6v4M8 12h.01" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>fal.ai API key not configured.</span>
          <button class="link-btn" onclick={() => { onClose(); onOpenSettings(); }}>
            Open Settings
          </button>
        </div>
      {:else}
        <div class="prompt-field">
          <label for="upscale-factor" class="prompt-label">Scale</label>
          <select id="upscale-factor" class="model-select" bind:value={factor} disabled={submitting}>
            {#each FACTOR_OPTIONS as opt (opt.value)}
              <option value={opt.value}>{opt.label}</option>
            {/each}
          </select>
        </div>

        <div class="prompt-field">
          <label for="upscale-output" class="prompt-label">Output filename</label>
          <input
            id="upscale-output"
            type="text"
            class="prompt-input"
            bind:value={outputFilename}
            disabled={submitting}
          />
        </div>

        <div class="dialog-actions">
          <button class="btn btn-secondary" onclick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            class="btn btn-primary"
            onclick={handleUpscale}
            disabled={!outputFilename.trim() || submitting}
          >
            {submitting ? "Starting..." : "Upscale"}
          </button>
        </div>
      {/if}
    </div>
  </div>
</Modal>

<style>
  /* Shared chrome comes from ../plugin-dialog.css; only the width is ours. */
  .dialog {
    width: 440px;
  }
</style>

<!--
  Nano Banana prompt dialog - AI image editing.
  Plugin-owned modal, rendered via the plugin dialog registry. Receives its
  source path, API key and job/toast handles as props from the plugin's
  `activate`, and a close callback injected by the renderer.
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginToast } from "$lib/plugins/api";
  import { startNanoBananaJob } from "$lib/api/plugin-jobs";
import { checkPathsExist } from "$lib/api/files";
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

  type NanoBananaModel = "nanobanana-pro" | "flash-image";
  const MODEL_OPTIONS: { id: NanoBananaModel; label: string }[] = [
    { id: "nanobanana-pro", label: "Nano Banana Pro" },
    { id: "flash-image", label: "Flash Image" },
  ];

  let prompt = $state("");
  let outputFilename = $state("");
  let model = $state<NanoBananaModel>("nanobanana-pro");
  let submitting = $state(false);
  let inputRef = $state<HTMLInputElement | null>(null);

  const fileName = $derived(basename(sourcePath));
  const outputDir = $derived(parentDir(sourcePath));
  const hasApiKey = $derived(!!apiKey);

  $effect(() => {
    if (open) {
      prompt = "";
      outputFilename = "";
      model = "nanobanana-pro";
      submitting = false;
      // Resolve available filename asynchronously
      findAvailableFilename(outputDir, fileName, "_edit", checkPathsExist).then((name) => {
        outputFilename = name;
      });
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  async function handleGenerate(): Promise<void> {
    if (!prompt.trim() || !outputFilename.trim() || submitting) return;

    if (!hasApiKey) return;

    submitting = true;
    const result = await jobs.accept(
      { kind: "nano-banana", label: fileName, detail: prompt.trim() },
      () => startNanoBananaJob(sourcePath, prompt.trim(), outputDir, outputFilename.trim(), apiKey, model),
    );

    if (result.ok) {
      toast.show(`Nano Banana job started: ${fileName}`, "info");
      onClose();
    } else {
      toast.error(`Failed to start job: ${result.error}`);
      submitting = false;
    }
  }

  // Escape is handled by Modal; Enter (no Shift) submits — unless a button
  // has focus, whose own activation must win.
  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey && !(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      handleGenerate();
    }
  }
</script>

<Modal
  {open}
  {onClose}
  overlayClass="dialog-overlay"
  labelledby="nano-banana-title"
  onkeydown={handleKeydown}
>
    <div class="dialog plugin-dialog">
      <header class="dialog-header">
        <div class="header-content">
          <svg class="header-icon" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M10 2C5.58 2 2 5.58 2 10s3.58 8 8 8 8-3.58 8-8-3.58-8-8-8zm-1 11l-3-3 1.41-1.41L9 10.17l3.59-3.58L14 8l-5 5z" fill="currentColor" fill-opacity="0.7"/>
          </svg>
          <h2 id="nano-banana-title">Edit with Nano Banana</h2>
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
            <span>Gemini API key not configured.</span>
            <button class="link-btn" onclick={() => { onClose(); onOpenSettings(); }}>
              Open Settings
            </button>
          </div>
        {:else}
          <div class="prompt-field">
            <label for="nano-banana-model" class="prompt-label">Model</label>
            <select
              id="nano-banana-model"
              class="model-select"
              bind:value={model}
              disabled={submitting}
            >
              {#each MODEL_OPTIONS as opt (opt.id)}
                <option value={opt.id}>{opt.label}</option>
              {/each}
            </select>
          </div>

          <div class="prompt-field">
            <label for="nano-banana-prompt" class="prompt-label">Edit prompt</label>
            <input
              id="nano-banana-prompt"
              type="text"
              class="prompt-input"
              placeholder="e.g. Make the sky more dramatic..."
              bind:value={prompt}
              bind:this={inputRef}
              disabled={submitting}
            />
          </div>

          <div class="prompt-field">
            <label for="nano-banana-output" class="prompt-label">Output filename</label>
            <input
              id="nano-banana-output"
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
              onclick={handleGenerate}
              disabled={!prompt.trim() || !outputFilename.trim() || submitting}
            >
              {submitting ? "Starting..." : "Generate"}
            </button>
          </div>
        {/if}
      </div>
    </div>
</Modal>

<style>
  /* Shared chrome comes from ../plugin-dialog.css; only the width is ours. */
  .dialog {
    width: 480px;
  }
</style>

<!--
  Upscale dialog — fal.ai SeedVR2 image upscaling (#276).
  Plugin-owned modal, rendered via the plugin dialog registry. Receives its
  source path, API key and job/toast handles as props from the plugin's
  `activate`, and a close callback injected by the renderer.
-->
<script lang="ts">
  import Modal from "$lib/components/Modal.svelte";
  import type { PluginJobs, PluginToast } from "$lib/plugins/api";
  import { startUpscaleJob, checkPathsExist } from "$lib/api/files";
  import { parentDir, basename } from "$lib/domain/path";

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

  /** Find next available output name: photo_upscaled.png, photo_upscaled_2.png, ... */
  async function findAvailableFilename(dir: string, name: string): Promise<string> {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : ".png";
    const upscaledBase = base + "_upscaled";

    const candidates = [upscaledBase + ext];
    for (let i = 2; i <= 20; i++) {
      candidates.push(`${upscaledBase}_${i}${ext}`);
    }
    const paths = candidates.map((c) => `${dir}/${c}`);
    const exists = await checkPathsExist(paths);

    const firstAvailable = candidates.find((_, i) => !exists[i]);
    return firstAvailable ?? `${upscaledBase}_${Date.now()}${ext}`;
  }

  $effect(() => {
    if (open) {
      factor = 2;
      outputFilename = "";
      submitting = false;
      findAvailableFilename(outputDir, fileName).then((name) => {
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
  <div class="dialog">
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
  .dialog {
    width: 440px;
    max-width: 90vw;
    background: var(--background-solid);
    border: 1px solid var(--surface-stroke);
    border-radius: var(--radius-lg);
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    animation: slideUp 150ms cubic-bezier(0, 0, 0, 1);
  }

  @keyframes slideUp {
    from { opacity: 0; transform: translateY(20px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }

  .dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--divider);
  }

  .header-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .header-icon {
    color: var(--accent);
  }

  .dialog-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    border: none;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .close-btn:hover {
    background: var(--subtle-fill-secondary);
    color: var(--text-primary);
  }

  .dialog-body {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .file-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--subtle-fill);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }

  .file-label {
    color: var(--text-tertiary);
  }

  .file-name {
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .api-key-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: color-mix(in srgb, var(--system-caution) 15%, transparent);
    border: 1px solid color-mix(in srgb, var(--system-caution) 30%, transparent);
    border-radius: var(--radius-sm);
    font-size: 13px;
    color: var(--text-primary);
  }

  .api-key-warning svg {
    color: var(--system-caution);
    flex-shrink: 0;
  }

  .link-btn {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-family: inherit;
    font-size: 13px;
    text-decoration: underline;
    padding: 0;
  }

  .prompt-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .prompt-label {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
  }

  .model-select {
    appearance: none;
    -webkit-appearance: none;
    padding: 10px 32px 10px 14px;
    background: var(--control-fill);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M3 5l3 3 3-3' fill='none' stroke='%238a95b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary);
    cursor: pointer;
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .model-select:focus {
    border-color: var(--accent);
  }

  .model-select:disabled {
    opacity: 0.6;
  }

  .model-select option {
    background: var(--background-solid);
    color: var(--text-primary);
  }

  .prompt-input {
    padding: 10px 14px;
    background: var(--control-fill);
    border: 1px solid var(--control-stroke);
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 14px;
    color: var(--text-primary);
    outline: none;
    transition: border-color var(--transition-fast);
  }

  .prompt-input:focus {
    border-color: var(--accent);
  }

  .prompt-input:disabled {
    opacity: 0.6;
  }

  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn {
    padding: 8px 20px;
    border: none;
    border-radius: var(--radius-sm);
    font-family: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--control-fill);
    color: var(--text-primary);
    border: 1px solid var(--control-stroke);
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--control-fill-secondary);
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
  }

  .btn-primary:hover:not(:disabled) {
    filter: brightness(1.1);
  }
</style>

<!--
  Nano Banana prompt dialog - AI image editing
  Issue: feat/nano-banana
-->
<script lang="ts">
  import { settingsStore } from "$lib/state/settings.svelte";
  import Modal from "./Modal.svelte";
  import { jobsStore } from "$lib/state/jobs.svelte";
  import { toastStore } from "$lib/state/toast.svelte";
  import { dialogStore } from "$lib/state/dialogs.svelte";
  import { startNanoBananaJob, checkPathsExist } from "$lib/api/files";
  import { parentDir, basename } from "$lib/domain/path";

  interface Props {
    open: boolean;
    sourcePath: string;
    onClose: () => void;
  }

  let { open, sourcePath, onClose }: Props = $props();

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
  const hasApiKey = $derived(!!settingsStore.geminiApiKey);

  /** Find next available output name: photo_edit.png, photo_edit_2.png, ... */
  async function findAvailableFilename(dir: string, name: string): Promise<string> {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : ".png";
    const editBase = base + "_edit";

    // Check first candidate and a batch of numbered variants
    const candidates = [editBase + ext];
    for (let i = 2; i <= 20; i++) {
      candidates.push(`${editBase}_${i}${ext}`);
    }
    const paths = candidates.map((c) => `${dir}/${c}`);
    const exists = await checkPathsExist(paths);

    const firstAvailable = candidates.find((_, i) => !exists[i]);
    return firstAvailable ?? `${editBase}_${Date.now()}${ext}`;
  }

  $effect(() => {
    if (open) {
      prompt = "";
      outputFilename = "";
      model = "nanobanana-pro";
      submitting = false;
      // Resolve available filename asynchronously
      findAvailableFilename(outputDir, fileName).then((name) => {
        outputFilename = name;
      });
      requestAnimationFrame(() => inputRef?.focus());
    }
  });

  async function handleGenerate(): Promise<void> {
    if (!prompt.trim() || !outputFilename.trim() || submitting) return;

    if (!hasApiKey) return;

    submitting = true;
    const result = await startNanoBananaJob(
      sourcePath,
      prompt.trim(),
      outputDir,
      outputFilename.trim(),
      settingsStore.geminiApiKey,
      model,
    );

    if (result.ok) {
      jobsStore.addJob(result.data, fileName, prompt.trim());
      toastStore.show(`Nano Banana job started: ${fileName}`, "info");
      onClose();
    } else {
      toastStore.error(`Failed to start job: ${result.error}`);
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
    <div class="dialog">
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
            <button class="link-btn" onclick={() => { onClose(); dialogStore.openSettings(); }}>
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
  .dialog {
    width: 480px;
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

  .link-btn:hover {
    color: var(--accent-hover, var(--accent));
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

  .prompt-input::placeholder {
    color: var(--text-tertiary);
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

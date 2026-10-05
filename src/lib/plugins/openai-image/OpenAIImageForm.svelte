<script lang="ts">
  import { tick } from "svelte";
  import "../plugin-dialog.css";
  import type { PluginJobs, PluginToast } from "../api";
  import { startOpenAIImageJob, type OpenAIImageRequest } from "$lib/api/openai-image";
  import { checkPathsExist } from "$lib/api/files";
  import { basename } from "$lib/domain/path";
  import { findAvailableFilename } from "$lib/domain/available-filename";

  interface Props {
    open: boolean;
    sourceDigest?: string;
    onBusyChange?: (busy: boolean) => void;
    sourcePath: string | null;
    referencePaths?: string[];
    outputDir: string;
    apiKey: string;
    codexPath?: string;
    initialBackend?: "codex" | "api_key";
    jobs: PluginJobs;
    toast: PluginToast;
    onOpenSettings: () => void;
    onClose: () => void;
  }
  let { open, sourceDigest, onBusyChange = () => {}, sourcePath, referencePaths = [], outputDir, apiKey, codexPath = "", initialBackend = "codex", jobs, toast, onOpenSettings, onClose }: Props = $props();
  let editTarget = $state<string | null>(null);
  const inputPaths = $derived(sourcePath ? [sourcePath, ...referencePaths] : []);
  const references = $derived(inputPaths.filter((path) => path !== editTarget));
  let backend = $state<"codex" | "api_key">("codex");
  let prompt = $state("");
  let outputFilename = $state("");
  let filenameEdited = false;
  let model = $state<OpenAIImageRequest["model"]>("gpt-image-2");
  let size = $state<OpenAIImageRequest["size"]>("auto");
  let quality = $state<OpenAIImageRequest["quality"]>("auto");
  let background = $state<OpenAIImageRequest["background"]>("auto");
  let submitting = $state(false);
  let promptRef = $state<HTMLTextAreaElement | null>(null);
  $effect(() => { onBusyChange(submitting); });

  $effect(() => {
    if (!open) return;
    let active = true;
    prompt = "";
    outputFilename = "";
    filenameEdited = false;
    submitting = false;
    backend = initialBackend;
    editTarget = sourcePath;
    const name = sourcePath ? basename(sourcePath).replace(/\.[^.]+$/, ".png") : "image.png";
    findAvailableFilename(outputDir, name, sourcePath ? "_edit" : "_generated", checkPathsExist)
      .then((name) => { if (active && !filenameEdited) outputFilename = name; })
      .catch(() => { if (active && !filenameEdited) outputFilename = sourcePath ? "image_edit.png" : "image_generated.png"; });
    void tick().then(() => { if (active) promptRef?.focus(); });
    return () => { active = false; };
  });

  async function submit(): Promise<void> {
    if (submitting || !prompt.trim() || !outputFilename.trim()) return;
    submitting = true;
    const result = await jobs.accept(
      { kind: "openai-image", label: outputFilename, detail: prompt.trim() },
      () => startOpenAIImageJob({ sourcePath: editTarget, expectedSourceDigest: sourceDigest, referencePaths: references, outputDir, prompt: prompt.trim(), outputFilename: outputFilename.trim(), backend, codexPath: backend === "codex" ? codexPath : undefined,
        model: backend === "codex" ? "gpt-image-2" : model,
        size: backend === "codex" ? "auto" : size,
        quality: backend === "codex" ? "auto" : quality,
        background: backend === "codex" ? "auto" : background }, backend === "api_key" ? apiKey : ""),
    );
    if (result.ok) {
      toast.show(`OpenAI image job started: ${outputFilename}`, "info");
      onClose();
    } else {
      toast.error(result.error);
      submitting = false;
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  }
</script>

    <form onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div class="dialog-body">
      <div class="file-info"><span class="file-label">{editTarget ? "Source:" : "Folder:"}</span><span class="file-name" title={editTarget ?? outputDir}>{editTarget ? basename(editTarget) : outputDir}</span></div>
      {#if inputPaths.length > 1}
        <div class="prompt-field">
          {#if !sourceDigest}
          <label for="openai-image-target" class="prompt-label">Edit target</label>
          <select id="openai-image-target" class="model-select" bind:value={editTarget} disabled={submitting}>
            {#each inputPaths as path}<option value={path}>{basename(path)}</option>{/each}
          </select>
          {/if}
          <p class="note">References, in order: {references.map(basename).join(", ")}. All inputs are recorded as parents in Trace.</p>
        </div>
      {/if}
      <div class="prompt-field">
        <label for="openai-image-backend" class="prompt-label">Connection</label>
        <select id="openai-image-backend" class="model-select" bind:value={backend} disabled={submitting}>
          <option value="codex">Codex · existing ChatGPT sign-in</option>
          <option value="api_key">OpenAI API key</option>
        </select>
      </div>
      <div class="prompt-field">
        <label for="openai-image-prompt" class="prompt-label">{sourcePath ? "Edit prompt" : "Image prompt"}</label>
        <textarea id="openai-image-prompt" class="prompt-input" rows="4" maxlength="16000" bind:value={prompt} bind:this={promptRef} onkeydown={keydown} disabled={submitting} required placeholder={sourcePath ? "Describe the changes and what should stay the same…" : "Describe the image you want to create…"}></textarea>
      </div>
      {#if backend === "api_key"}<div class="prompt-field">
        <label for="openai-image-model" class="prompt-label">Model</label>
        <select id="openai-image-model" class="model-select" bind:value={model} disabled={submitting}>
          <option value="gpt-image-2">GPT Image 2 · Codex image model</option>
          <option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option>
          <option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option>
        </select>
      </div>
      <div class="options">
        <div class="prompt-field">
          <label for="openai-image-size" class="prompt-label">Size</label>
          <select id="openai-image-size" class="model-select" bind:value={size} disabled={submitting}>
            <option value="auto">Automatic</option><option value="1024x1024">Square · 1024 × 1024</option><option value="1536x1024">Landscape · 1536 × 1024</option><option value="1024x1536">Portrait · 1024 × 1536</option>
          </select>
        </div>
        <div class="prompt-field">
          <label for="openai-image-quality" class="prompt-label">Quality</label>
          <select id="openai-image-quality" class="model-select" bind:value={quality} disabled={submitting}>
            <option value="auto">Automatic</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </div>
      </div>
      <div class="prompt-field">
        <label for="openai-image-background" class="prompt-label">Background</label>
        <select id="openai-image-background" class="model-select" bind:value={background} disabled={submitting}>
          <option value="auto">Automatic</option><option value="opaque">Opaque</option><option value="transparent">Transparent</option>
        </select>
      </div>
      {:else}<p class="note">Uses Codex's built-in image model and defaults. Describe size, composition, and background in your prompt.</p>{/if}
      <div class="prompt-field">
        <label for="openai-image-output" class="prompt-label">Output filename (.png)</label>
        <input id="openai-image-output" class="prompt-input" bind:value={outputFilename} oninput={() => { filenameEdited = true; }} disabled={submitting} required />
      </div>
      </div>
      <footer>
      <p class="note">{backend === "codex" ? "Uses your saved Codex ChatGPT sign-in and counts toward Codex usage limits. Requires the Codex CLI." : "Uses your OpenAI API key and incurs API charges."} The prompt and output are recorded in Trace.</p>
      <div class="dialog-actions">
        <button class="btn btn-secondary" type="button" onclick={() => { onClose(); onOpenSettings(); }}>Connection settings</button>
        <button class="btn btn-primary" type="submit" disabled={!prompt.trim() || !outputFilename.trim() || submitting}>{submitting ? "Starting…" : sourcePath ? "Generate edit" : "Generate image"}</button>
      </div>
      </footer>
    </form>

<style>
  form { display: flex; flex-direction: column; min-height: 0; }
  .dialog-body { overflow: auto; min-height: 0; }
  footer { padding: 16px 20px; border-top: 1px solid var(--divider); display: flex; flex-direction: column; gap: 12px; }
  .options { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; }
  textarea { resize: vertical; min-height: 88px; box-sizing: border-box; }
  .note { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
  @media (max-width: 400px) { .options { grid-template-columns: 1fr; } }
</style>

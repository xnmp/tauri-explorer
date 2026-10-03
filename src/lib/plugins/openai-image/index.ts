import type { Plugin, PluginContext } from "../api";
import type { FileEntry } from "$lib/domain/file";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { parentDir } from "$lib/domain/path";
import OpenAIImageDialog from "./OpenAIImageDialog.svelte";
import OpenAIImageHistory from "./OpenAIImageHistory.svelte";

const DIALOG_ID = "openai-image.create";
const singleLocal = (entries: FileEntry[]) => entries.length === 1 && !isVirtualPath(entries[0].path) ? entries[0] : null;
const image = (entries: FileEntry[]) => {
  const entry = singleLocal(entries);
  return entry?.kind === "file" && /\.(png|jpe?g|webp)$/i.test(entry.name) ? entry : null;
};

async function open(ctx: PluginContext, sourcePath: string | null, outputDir: string): Promise<void> {
  const settings = await ctx.storage.get();
  ctx.openDialog(DIALOG_ID, {
    sourcePath, outputDir,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey : "",
    jobs: ctx.jobs, toast: ctx.toast,
    onOpenSettings: () => ctx.openSettings(),
  });
}

export const openAIImagePlugin: Plugin = {
  id: "openai-image",
  name: "OpenAI Images",
  description: "Generate and edit images with GPT Image, with durable Trace provenance.",
  enabledByDefault: true,
  activate(ctx) {
    ctx.registerSettingsSection({
      id: "openai-image", title: "AI / OpenAI Images",
      rows: [{ id: "apiKey", label: "OpenAI API Key", type: "password",
        description: "Used for paid image generation and edits. Leave blank to use OPENAI_API_KEY from the app environment." }],
    });
    ctx.registerDialog({ id: DIALOG_ID, component: OpenAIImageDialog });
    ctx.registerDialog({ id: "openai-image.history", component: OpenAIImageHistory });
    ctx.registerCommand({
      id: "plugin.openai-image.history", label: "OpenAI: Image Run History", category: "plugins",
      handler: () => ctx.openDialog("openai-image.history"),
    });
    ctx.registerContextMenuItem({
      id: "openai-image.edit", label: "Edit with OpenAI", group: "ai",
      when: (entries) => image(entries) !== null,
      handler: (entries) => {
        const selected = image(entries);
        if (selected) return open(ctx, selected.path, parentDir(selected.path));
      },
    });
    ctx.registerContextMenuItem({
      id: "openai-image.generate", label: "Generate image with OpenAI…", group: "ai",
      when: (entries) => singleLocal(entries)?.kind === "directory",
      handler: (entries) => {
        const selected = singleLocal(entries);
        if (selected?.kind === "directory") return open(ctx, null, selected.path);
      },
    });
    ctx.registerCommand({
      id: "plugin.openai-image.edit", label: "OpenAI: Edit Image…", category: "plugins",
      handler: () => {
        const selected = image(ctx.workspace.getSelection());
        if (selected) return open(ctx, selected.path, parentDir(selected.path));
        ctx.toast.show("Select a PNG, JPEG, or WebP image first", "info");
      },
    });
    ctx.registerCommand({
      id: "plugin.openai-image.generate", label: "OpenAI: Generate Image…", category: "plugins",
      handler: () => {
        const selected = singleLocal(ctx.workspace.getSelection());
        if (selected) return open(ctx, null, selected.kind === "directory" ? selected.path : parentDir(selected.path));
        ctx.toast.show("Select an output folder or a file in it first", "info");
      },
    });
  },
};

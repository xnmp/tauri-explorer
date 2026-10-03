import { describe, it, expect, vi } from "vitest";
vi.mock("$lib/plugins/openai-image/OpenAIImageDialog.svelte", () => ({ default: {} }));
vi.mock("$lib/plugins/openai-image/OpenAIImageHistory.svelte", () => ({ default: {} }));
import { openAIImagePlugin } from "$lib/plugins/openai-image";
import { createPluginContext } from "$lib/plugins/api";
import { contextMenuItems } from "$lib/state/context-menu-items.svelte";
import { dialogRegistry } from "$lib/plugins/dialog-registry.svelte";
import { getCommand } from "$lib/state/commands.svelte";
import type { FileEntry } from "$lib/domain/file";

const image: FileEntry = { name: "photo.PNG", path: "/media/photo.PNG", kind: "file", size: 20, modified: "2026-10-03T00:00:00Z" };
const folder: FileEntry = { ...image, name: "media", path: "/media", kind: "directory" };

describe("OpenAI image plugin", () => {
  it("opens an edit with the selected image and the current configured key", async () => {
    const { ctx, dispose } = createPluginContext("openai-image");
    await ctx.storage.set({ apiKey: "test-openai-key" });
    await openAIImagePlugin.activate(ctx);
    const edit = contextMenuItems.itemsFor([image]).find((item) => item.id === "openai-image.edit")!;
    await edit.handler([image]);
    expect(dialogRegistry.openDialogs.find((dialog) => dialog.id === "openai-image.create")?.props).toMatchObject({
      sourcePath: "/media/photo.PNG", outputDir: "/media", apiKey: "test-openai-key",
    });
    expect(contextMenuItems.itemsFor([{ ...image, name: "animated.gif" }]).some((item) => item.id === edit.id)).toBe(false);
    expect(contextMenuItems.itemsFor([{ ...image, path: "demo://photo.png" }]).some((item) => item.id === edit.id)).toBe(false);
    expect(contextMenuItems.itemsFor([image, image]).some((item) => item.id === edit.id)).toBe(false);
    dispose();
  });

  it("opens generation in a selected folder without inventing an image input", async () => {
    const { ctx, dispose } = createPluginContext("openai-image");
    await openAIImagePlugin.activate(ctx);
    const generate = contextMenuItems.itemsFor([folder]).find((item) => item.id === "openai-image.generate")!;
    await generate.handler([folder]);
    expect(dialogRegistry.openDialogs.find((dialog) => dialog.id === "openai-image.create")?.props).toMatchObject({ sourcePath: null, outputDir: "/media" });
    dispose();
  });

  it("makes durable run history reachable and releases its dialogs and actions on disable", async () => {
    const { ctx, dispose } = createPluginContext("openai-image");
    await openAIImagePlugin.activate(ctx);
    await getCommand("plugin.openai-image.history")!.handler();
    expect(dialogRegistry.isOpen("openai-image.history")).toBe(true);
    dispose();
    expect(dialogRegistry.isOpen("openai-image.history")).toBe(false);
    expect(getCommand("plugin.openai-image.history")).toBeUndefined();
    expect(contextMenuItems.itemsFor([image]).some((item) => item.id.startsWith("openai-image."))).toBe(false);
  });
});

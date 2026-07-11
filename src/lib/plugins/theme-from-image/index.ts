/**
 * Theme from Image plugin (#203).
 *
 * Right-click any image → "Create Theme from Image": the backend extracts
 * its dominant colors (median-cut), a complete theme is generated, written
 * to the user themes dir, and applied. The "Create Theme from Wallpaper"
 * palette command runs the same pipeline on the configured background image.
 */

import type { Plugin, PluginContext } from "../api";
import { isImageFile } from "$lib/domain/file-types";
import { isVirtualPath } from "$lib/domain/virtual-path";
import { basename } from "$lib/domain/path";
import { buildTheme, themeIdFromName } from "$lib/domain/theme-from-palette";
import { extractPalette } from "$lib/api/thumbnails";
import { writeThemeFile } from "$lib/api/config";
// Direct import justification (#291): this plugin is purpose-built to extend the
// theme engine — generating a theme and applying it (themeStore) and reading the
// configured wallpaper (settingsStore.backgroundImage) are theme-subsystem
// concerns no other plugin touches. Per the PluginContext docstring, a plugin
// that extends one specific core subsystem may import that subsystem's store
// directly rather than grow the shared context with a single-consumer method.
import { themeStore } from "$lib/state/theme.svelte";
import { settingsStore } from "$lib/state/settings.svelte";

async function createThemeFrom(ctx: PluginContext, imagePath: string): Promise<void> {
  const name = basename(imagePath);
  try {
    const colors = await extractPalette(imagePath, 6);
    const id = themeIdFromName(name);
    const theme = buildTheme(colors, id, name.replace(/\.[^.]+$/, ""));
    if (!theme) {
      ctx.toast.error("Could not derive a palette from this image");
      return;
    }
    await writeThemeFile(`${id}.css`, theme.css);
    // Re-inject user theme styles and rediscover, then switch to it.
    await themeStore.initTheme();
    themeStore.setTheme(id);
    ctx.toast.show(`Theme "${theme.name}" created and applied`);
  } catch (err) {
    ctx.toast.error(`Theme generation failed: ${err}`);
  }
}

export const themeFromImagePlugin: Plugin = {
  id: "theme-from-image",
  name: "Theme from Image",
  description: "Generate an app theme from any image's dominant colors",
  enabledByDefault: true,

  activate(ctx: PluginContext) {
    ctx.registerContextMenuItem({
      id: "theme-from-image.create",
      label: "Create Theme from Image",
      when: (entries) =>
        entries.length === 1 && isImageFile(entries[0]) && !isVirtualPath(entries[0].path),
      handler: (entries) => createThemeFrom(ctx, entries[0].path),
    });

    ctx.registerCommand({
      id: "theme-from-image.fromWallpaper",
      label: "Create Theme from Wallpaper",
      category: "plugins",
      handler: async () => {
        const wallpaper = settingsStore.backgroundImage;
        if (!wallpaper) {
          ctx.toast.show("No wallpaper set — choose a background image in Settings first");
          return;
        }
        await createThemeFrom(ctx, wallpaper);
      },
    });
  },
};

/**
 * Demo plugin — exercises every plugin contribution seam.
 *
 * Ships disabled (`enabledByDefault: false`); enabled from Settings. Used by
 * the plugin-system e2e test and as the reference for building a built-in
 * plugin (see docs/architecture/plugins.md). It contributes:
 *   - a command ("Demo: Hello" → toast) and a nav command ("Demo: Open Virtual Folder")
 *   - a context-menu item (when any entry is selected → toast with its name)
 *   - a settings section (one text row)
 *   - a virtual-fs provider for `demo://`
 */

import type { Plugin } from "../api";
import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { windowTabsManager } from "$lib/state/window-tabs.svelte";

const DEMO_ROOT = "demo://";

function entry(name: string, path: string, kind: FileEntry["kind"], size = 0): FileEntry {
  return { name, path, kind, size, modified: "2024-01-01T12:00:00.000Z" };
}

/** Synthetic listing for a `demo://` path. */
function listDemo(path: string): DirectoryListing {
  const entries: FileEntry[] =
    path === `${DEMO_ROOT}subfolder`
      ? [
          entry("nested-note.txt", `${DEMO_ROOT}subfolder/nested-note.txt`, "file", 24),
          entry("nested-data.json", `${DEMO_ROOT}subfolder/nested-data.json`, "file", 48),
        ]
      : [
          entry("subfolder", `${DEMO_ROOT}subfolder`, "directory"),
          entry("hello.txt", `${DEMO_ROOT}hello.txt`, "file", 12),
          entry("readme.md", `${DEMO_ROOT}readme.md`, "file", 128),
        ];
  return { path, entries, listing_id: null };
}

export const demoPlugin: Plugin = {
  id: "demo",
  name: "Demo Plugin",
  description: "Reference plugin exercising commands, context menu, settings, and a demo:// virtual folder.",
  enabledByDefault: false,

  activate(ctx) {
    ctx.registerCommand({
      id: "plugin.demo.hello",
      label: "Demo: Hello",
      category: "plugins",
      handler: () => ctx.toast.show("Hello from the demo plugin!", "success"),
    });

    ctx.registerCommand({
      id: "plugin.demo.open",
      label: "Demo: Open Virtual Folder",
      category: "plugins",
      handler: () => {
        void windowTabsManager.getActiveExplorer()?.navigateTo(DEMO_ROOT);
      },
    });

    ctx.registerContextMenuItem({
      id: "plugin.demo.greet",
      label: "Demo: Greet Selection",
      icon: "M8 1L10 6L15 6L11 9L12 14L8 11L4 14L5 9L1 6L6 6Z",
      when: (entries) => entries.length > 0,
      handler: (entries) => ctx.toast.show(`Demo greets: ${entries[0].name}`, "info"),
    });

    ctx.registerSettingsSection({
      id: "demo",
      title: "Demo Plugin",
      rows: [
        {
          id: "greeting",
          label: "Greeting",
          description: "Custom greeting text used by the demo plugin.",
          type: "text",
          default: "Hello",
        },
      ],
    });

    ctx.registerFsProvider("demo", {
      list: (path) => listDemo(path),
    });
  },
};

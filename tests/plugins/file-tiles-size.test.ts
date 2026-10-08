/**
 * `ui/file-tiles` sizing (SDK capability "tileSize"): an optional `size`
 * preset, and the global tile-size setting without one, as before.
 * Rendered with Svelte's server renderer; the tile geometry is published as
 * CSS variables on the grid's root.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import FileTiles from "$lib/components/FileTiles.svelte";
import PluginFileView from "$lib/components/PluginFileView.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import { folderViewsStore } from "$lib/state/folder-views.svelte";
import type { FileEntry } from "$lib/domain/file";

const initialGlobal = settingsStore.thumbnailSize;
const FOLDER = "/home/user/Pictures";
afterEach(() => {
  settingsStore.update({ thumbnailSize: initialGlobal });
  folderViewsStore.remove(FOLDER);
});

const entries: FileEntry[] = [{ name: "a.png", path: "/p/a.png", kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" }];

function iconSize(size?: unknown): string | undefined {
  const props = { entries, selected: new Set<string>(), onselect() {}, onopen() {}, onmenu() {}, ...(size === undefined ? {} : { size }) };
  const html = render(FileTiles as never, { props } as never).body;
  return /--tile-icon-size: (\d+px)/.exec(html)?.[1];
}

describe("ui/file-tiles size", () => {
  it("keeps the global setting when no size is passed", () => {
    settingsStore.update({ thumbnailSize: "small" });
    expect(iconSize()).toBe("48px");
    settingsStore.update({ thumbnailSize: "large" });
    expect(iconSize()).toBe("96px");
  });

  it("uses the passed preset over the global setting", () => {
    settingsStore.update({ thumbnailSize: "small" });
    expect(iconSize("xlarge")).toBe("128px");
    expect(iconSize("medium")).toBe("64px");
  });

  it("ignores an unknown or malformed size and keeps the global setting", () => {
    settingsStore.update({ thumbnailSize: "large" });
    for (const bad of ["huge", "", "constructor", "__proto__", null, 96, {}]) {
      expect(iconSize(bad), String(bad)).toBe("96px");
    }
  });
});

/** `ui/file-tiles` as a plugin file view's content, rendered by the host's
 *  PluginFileView for a pane showing FOLDER. */
function iconSizeInPluginView(size?: unknown): string | undefined {
  const tileProps = { entries, selected: new Set<string>(), onselect() {}, onopen() {}, onmenu() {}, ...(size === undefined ? {} : { size }) };
  const explorer = { currentPath: FOLDER, clearPreviewTargetsOwnedBy() {} };
  const view = { id: "fixture.view", title: "Fixture", pluginId: "fixture", component: FileTiles, props: tileProps };
  const html = render(PluginFileView as never, { props: { explorer, paneId: "pane-1", view, onopen: async () => {} } } as never).body;
  return /--tile-icon-size: (\d+px)/.exec(html)?.[1];
}

describe("ui/file-tiles inside a plugin file view", () => {
  it("follows the folder's override when the plugin passes no size", () => {
    settingsStore.update({ thumbnailSize: "small" });
    folderViewsStore.set(FOLDER, { thumbnailSize: "xlarge" });
    expect(iconSizeInPluginView()).toBe("128px");
  });

  it("follows the global setting where the folder has no override", () => {
    settingsStore.update({ thumbnailSize: "large" });
    expect(iconSizeInPluginView()).toBe("96px");
  });

  it("still prefers an explicit size to the folder's", () => {
    folderViewsStore.set(FOLDER, { thumbnailSize: "xlarge" });
    expect(iconSizeInPluginView("small")).toBe("48px");
    // A malformed size falls through to the folder's, not the global.
    settingsStore.update({ thumbnailSize: "medium" });
    expect(iconSizeInPluginView("huge")).toBe("128px");
  });
});

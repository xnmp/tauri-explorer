import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import { load } from "cheerio";
import FileTile from "$lib/components/FileTile.svelte";
import FileTiles from "$lib/components/FileTiles.svelte";
import PluginFileView from "$lib/components/PluginFileView.svelte";
import type { FileEntry } from "$lib/domain/file";
import { settingsStore } from "$lib/state/settings.svelte";
import { folderViewsStore } from "$lib/state/folder-views.svelte";
import { manualHiddenStore } from "$lib/state/manual-hidden.svelte";

const clipboard = vi.hoisted(() => ({ pathSet: new Set<string>(), isCut: false }));
vi.mock("$lib/state/clipboard.svelte", () => ({ clipboardStore: clipboard }));
const entry: FileEntry = { name: "photo.png", path: "/pictures/photo.png", kind: "file", size: 1, modified: "2026-01-01T00:00:00Z" };
const callbacks = { onselect() {}, onopen() {}, onmenu() {} };
const initialSize = settingsStore.thumbnailSize;
afterEach(() => {
  clipboard.pathSet.clear();
  clipboard.isCut = false;
  settingsStore.update({ thumbnailSize: initialSize });
  folderViewsStore.remove("/pictures");
  manualHiddenStore.unhide("/pictures", [entry.name]);
});

function single(props: Record<string, unknown> = {}) {
  return load(render(FileTile, { props: { entry, selected: false, ...callbacks, ...props } }).body);
}

describe("ui/file-tile", () => {
  it("renders one cell, with no grid/row, the host thumbnail and displayed name", () => {
    const $ = single({ selected: true, focused: true, column: 3 });
    expect($('[role="gridcell"]')).toHaveLength(1);
    expect($('[role="grid"], [role="row"]')).toHaveLength(0);
    expect($('.tile-item').attr('aria-selected')).toBe('true');
    expect($('.tile-item').attr('tabindex')).toBe('0');
    expect($('.tile-item').attr('aria-colindex')).toBe('3');
    expect($('.tile-item').hasClass('selected')).toBe(true);
    expect($('.name-tiles').text()).toBe(entry.name);
    expect($('.tile-icon .thumbnail-container')).toHaveLength(1);
    expect($('.tile-item').attr('draggable')).toBeUndefined();
  });

  it("reflects host cut and manually-hidden state", () => {
    clipboard.pathSet.add(entry.path);
    clipboard.isCut = true;
    manualHiddenStore.hide("/pictures", [entry.name]);
    const $ = single();
    expect($('.tile-item').hasClass('cut')).toBe(true);
    expect($('.tile-item').hasClass('in-clipboard')).toBe(true);
    expect($('.tile-item').hasClass('hidden-entry')).toBe(true);
  });

  it("reflects dotfile styling independently of clipboard state", () => {
    const $ = single({ entry: { ...entry, name: '.photo.png' } });
    expect($('.tile-item').hasClass('hidden-entry')).toBe(true);
    expect($('.tile-item').hasClass('cut')).toBe(false);
    expect($('.tile-item').attr('aria-selected')).toBe('false');
    expect($('.tile-item').attr('tabindex')).toBe('-1');
  });

  it("is the same cell rendered by file-tiles for every preset", () => {
    clipboard.pathSet.add(entry.path);
    clipboard.isCut = true;
    for (const size of ["small", "medium", "large", "xlarge"] as const) {
      const $ = single({ selected: true, focused: true, column: 1, size });
      const grid = load(render(FileTiles, { props: { entries: [entry], selected: new Set([entry.path]), size, ...callbacks } }).body);
      expect($.html($('.tile-item'))).toBe(grid.html(grid('.tile-item')));
    }
  });

  it("resolves explicit, contextual and global sizes, including malformed presets", () => {
    settingsStore.update({ thumbnailSize: "small" });
    expect(single()('.tile-item').attr('style')).toContain('--tile-icon-size: 48px');
    expect(single({ size: 'xlarge' })('.tile-item').attr('style')).toContain('--tile-icon-size: 128px');
    folderViewsStore.set('/pictures', { thumbnailSize: 'large' });
    for (const size of [undefined, null, 'huge', 'constructor', {}]) {
      const view = { id: 'fixture.view', title: 'Fixture', pluginId: 'fixture', component: FileTile, props: { entry, selected: false, size, ...callbacks } };
      const explorer = { currentPath: '/pictures', clearPreviewTargetsOwnedBy() {} };
      const html = render(PluginFileView as never, { props: { explorer, paneId: 'pane-1', view, onopen: async () => {} } } as never).body;
      expect(html).toContain('--tile-icon-size: 96px');
    }
  });
});

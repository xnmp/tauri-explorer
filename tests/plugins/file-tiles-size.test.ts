/**
 * `ui/file-tiles` sizing (SDK capability "tileSize"): an optional `size`
 * preset, and the global tile-size setting without one, as before.
 * Rendered with Svelte's server renderer; the tile geometry is published as
 * CSS variables on the grid's root.
 */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "svelte/server";
import FileTiles from "$lib/components/FileTiles.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import type { FileEntry } from "$lib/domain/file";

const initialGlobal = settingsStore.thumbnailSize;
afterEach(() => settingsStore.update({ thumbnailSize: initialGlobal }));

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

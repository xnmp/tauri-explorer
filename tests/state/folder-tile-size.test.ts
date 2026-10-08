/**
 * The tile size a folder shows at, as the Tiles view, the context menu and
 * plugin file views (`FileViewPane.tileSize`) all resolve it: the folder's
 * override, else the global setting.
 */
import { afterEach, describe, expect, it } from "vitest";
import { folderPaneTileSize, folderTileSize } from "$lib/state/folder-tile-size";
import { folderViewsStore } from "$lib/state/folder-views.svelte";
import { settingsStore } from "$lib/state/settings.svelte";
import type { ThumbnailSize } from "$lib/domain/tile-layout";

const PHOTOS = "/home/user/Pictures";
const OTHER = "/home/user/Documents";
const initialGlobal = settingsStore.thumbnailSize;

afterEach(() => {
  folderViewsStore.remove(PHOTOS);
  folderViewsStore.remove(OTHER);
  settingsStore.update({ thumbnailSize: initialGlobal });
});

describe("folder tile size", () => {
  it("follows the global setting where the folder has no override", () => {
    settingsStore.update({ thumbnailSize: "large" });
    expect(folderTileSize(PHOTOS)).toBe("large");
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "large", imagePx: 96 });
  });

  it("prefers the folder's override to the global setting, for that folder only", () => {
    settingsStore.update({ thumbnailSize: "small" });
    folderViewsStore.set(PHOTOS, { thumbnailSize: "xlarge" });
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "xlarge", imagePx: 128 });
    expect(folderPaneTileSize(OTHER)).toEqual({ preset: "small", imagePx: 48 });
  });

  it("reads the current value on every access, never a snapshot", () => {
    settingsStore.update({ thumbnailSize: "small" });
    expect(folderPaneTileSize(PHOTOS).preset).toBe("small");
    settingsStore.update({ thumbnailSize: "medium" });
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "medium", imagePx: 64 });
    folderViewsStore.set(PHOTOS, { thumbnailSize: "large" });
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "large", imagePx: 96 });
    // A global change no longer applies while the override stands...
    settingsStore.update({ thumbnailSize: "xlarge" });
    expect(folderPaneTileSize(PHOTOS).preset).toBe("large");
    // ...and applies again once it is removed.
    folderViewsStore.remove(PHOTOS);
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "xlarge", imagePx: 128 });
  });

  it("returns the same value object while the size is unchanged", () => {
    folderViewsStore.set(PHOTOS, { thumbnailSize: "large" });
    expect(folderPaneTileSize(PHOTOS)).toBe(folderPaneTileSize(PHOTOS));
    expect(Object.isFrozen(folderPaneTileSize(PHOTOS))).toBe(true);
  });

  it("falls back to medium for a malformed stored override, as the Tiles view does", () => {
    folderViewsStore.set(PHOTOS, { thumbnailSize: "huge" as ThumbnailSize });
    expect(folderPaneTileSize(PHOTOS)).toEqual({ preset: "medium", imagePx: 64 });
  });
});

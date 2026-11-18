/**
 * Replace the browser mock backend's built-in fixtures with a converted
 * fixture world (`domain/demo-fixture.ts`): listings, text, Recycle Bin,
 * home, drives, git repositories and per-file media. Everything afterwards
 * flows through the ordinary mock commands, so listings, search, previews,
 * Trash restore and the git graph all serve the installed world.
 *
 * Install before the app issues its first command (the site demo does so in
 * `hooks.client.ts`' `init`); a world swapped under a running window would
 * leave its listings, caches and watchers describing the old one.
 * `uninstall()` puts back exactly what the install replaced, and a failed
 * install undoes itself before rethrowing.
 */
import type { DemoMedia, DemoWorld } from "$lib/domain/demo-fixture";
import type { FileEntry } from "$lib/domain/file";
import { getMockControl, type MockControl } from "./mock-control";
import { mockDirEmpty, mockFileContent, mockFiles } from "./mock-fixtures";
import { mockWrittenFiles, seedMockTrash, snapshotMockTrash } from "./mock-files";
import { clearMockRecoveryRecords } from "./mock-file-recovery";
import { onMockFsChange } from "./mock-fs-changes";
import { getMockFixtureRepos, setMockFixtureRepos } from "./mock-git-fixture";
import { getMockDrives, getMockHomeDirectory, setMockDrives, setMockHomeDirectory } from "./mock-system";
import { createMockMediaLoader } from "./mock-world-media";

function replaceRecord<T>(target: Record<string, T>, next: Readonly<Record<string, T>>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

/** Per-file media and type hints by current path. Follows renames, moves and copies made through the mock. */
export interface MockWorldMedia {
  get(path: string): DemoMedia | undefined;
  typeHint(path: string): string | undefined;
}

export interface InstalledMockWorld {
  readonly media: MockWorldMedia;
  /** Restore the fixtures, hooks and state the install replaced. */
  uninstall(): void;
}

const HOOKS = [
  "thumbnail", "microThumbnail", "videoThumbnail", "previewReadImage",
  "imageResolution", "videoPreview", "mediaDuration", "previewReadPdf",
] as const satisfies readonly (keyof MockControl)[];

/** Capture everything an install replaces; the returned function restores it. */
function snapshot(): () => void {
  const listings = Object.fromEntries(Object.entries(mockFiles).map(([dir, entries]) => [dir, [...entries]]));
  const empty = { ...mockDirEmpty };
  const written = { ...mockWrittenFiles };
  const content = { ...mockFileContent };
  const restoreTrash = snapshotMockTrash();
  const home = getMockHomeDirectory();
  const drives = getMockDrives();
  const repos = getMockFixtureRepos();
  const control = getMockControl();
  const hooks = Object.fromEntries(HOOKS.map((name) => [name, control[name]]));
  return () => {
    replaceRecord(mockFiles, listings);
    replaceRecord(mockDirEmpty, empty);
    replaceRecord(mockWrittenFiles, written);
    replaceRecord(mockFileContent, content);
    restoreTrash();
    setMockHomeDirectory(home);
    setMockDrives(drives);
    setMockFixtureRepos(repos);
    Object.assign(control, hooks);
  };
}

/** Install `world`; returns its live media map and the way back. */
export function installMockWorld(world: DemoWorld): InstalledMockWorld {
  const restoreFixtures = snapshot();
  let stopFollowing = () => {};
  let restoreRecovery = () => {};
  const restore = () => { restoreRecovery(); restoreFixtures(); };
  try {
    // The built-in File Recovery records describe the built-in fixtures.
    restoreRecovery = clearMockRecoveryRecords();
    const media = new Map<string, DemoMedia>(Object.entries(world.media));
    const types = new Map<string, string>(Object.entries(world.types));
    const texts: Record<string, string> = { ...world.texts };
    for (const item of world.trash) {
      Object.assign(texts, item.texts);
      for (const [path, value] of Object.entries(item.types)) types.set(path, value);
      for (const [path, value] of Object.entries(item.media)) media.set(path, value);
    }
    const listings: Record<string, FileEntry[]> = {};
    for (const [dir, entries] of Object.entries(world.listings)) listings[dir] = [...entries];
    replaceRecord(mockFiles, listings);
    replaceRecord(mockDirEmpty, {});
    replaceRecord(mockWrittenFiles, {});
    replaceRecord(mockFileContent, texts);
    seedMockTrash(world.trash);
    setMockHomeDirectory(world.user.home);
    setMockDrives(world.drives.map((d) => ({ ...d })));
    setMockFixtureRepos(world.repos);
    installMediaHooks(media);

    // Media follows its file through every rename, move and copy, including
    // undo/redo re-executing one (they all publish to the same feed).
    stopFollowing = onMockFsChange(({ op, path, from }) => {
      if (!from || (op !== "rename" && op !== "move" && op !== "copy")) return;
      for (const map of [media, types] as Map<string, unknown>[]) {
        for (const [key, value] of [...map]) {
          if (key !== from && !key.startsWith(`${from}/`)) continue;
          if (op !== "copy") map.delete(key);
          map.set(path + key.slice(from.length), value);
        }
      }
    });

    let installed = true;
    return {
      media: { get: (path) => media.get(path), typeHint: (path) => types.get(path) },
      uninstall() {
        if (!installed) return;
        installed = false;
        stopFollowing();
        restore();
      },
    };
  } catch (error) {
    stopFollowing();
    restore();
    throw error;
  }
}

function installMediaHooks(media: ReadonlyMap<string, DemoMedia>): void {
  const loader = createMockMediaLoader();
  const control = getMockControl();
  const imageOf = (path: string) => {
    const item = media.get(path);
    if (item?.kind === "image") return item.src;
    if (item?.kind === "video") return item.poster;
    return null;
  };
  const missing = (path: string) => ({ kind: "not_found", message: `No image data for ${path}` });
  control.thumbnail = async (path, size, quality) => {
    const src = imageOf(path);
    if (!src) throw missing(path);
    return loader.thumbnail(src, size, quality);
  };
  control.microThumbnail = async (path, size) => {
    const src = imageOf(path);
    if (!src) throw missing(path);
    return loader.thumbnail(src, size ?? 16, 50);
  };
  control.videoThumbnail = async (path, size) => {
    const src = imageOf(path);
    if (!src) throw missing(path);
    return loader.thumbnail(src, size ?? 256, 85);
  };
  control.previewReadImage = async (path) => {
    const src = imageOf(path);
    if (!src) throw missing(path);
    return loader.dataUrl(src);
  };
  control.imageResolution = (path) => {
    const item = media.get(path);
    return item && item.kind !== "pdf" ? item.pixels : null;
  };
  control.videoPreview = (path) => {
    const item = media.get(path);
    if (item?.kind !== "video" || !item.src) throw { kind: "not_found", message: `No video for ${path}` };
    return item.src;
  };
  control.mediaDuration = (path) => {
    const item = media.get(path);
    return item?.kind === "video" ? item.duration : null;
  };
  control.previewReadPdf = async (path) => {
    const item = media.get(path);
    if (item?.kind !== "pdf") throw { kind: "not_found", message: `No PDF data for ${path}` };
    return loader.bytes(item.src);
  };
}

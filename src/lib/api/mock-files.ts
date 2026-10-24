/**
 * Mock filesystem commands: listings (including the synthetic /perf directories), create/rename/delete,
 * the in-app Trash, archives and file history, plus the ordered copy/move session and
 * the history receipts `mockInvoke` attaches to mutating commands.
 * Split out of mock-invoke.ts (#1372); `mockInvoke` dispatches every family.
 */
import type { CopyDecision, CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import type { FileEntry, FileMutationReceipt } from "$lib/domain/file";
import type { FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import type { HistoryDirection, HistorySummary, UndoAction } from "$lib/domain/file-history";
import { basename, parentDir, sameDirectory } from "$lib/domain/path";
import { broadcastFileChange } from "$lib/state/file-events";
import { type CompactDirectoryListing, encodeDirectoryListing } from "./directory-wire";
import { getMockControl } from "./mock-control";
import { createMockFileHistory } from "./mock-file-history";
import { dir, file, mockDirEmpty, mockFileContent, mockFiles, TIMESTAMP_BASE } from "./mock-fixtures";
import { type CommandHandler, invokeMockCommand, waitForMockLatency } from "./mock-dispatch";


interface MockCopyControl {
  cancelled: boolean;
  pending?: { item: number; nonce: string; resolve: (decision: CopyDecision) => void };
}
const mockCopyControls = new Map<string, MockCopyControl>();

const mutationReceipt = (entry: FileEntry): FileMutationReceipt => ({ path: entry.path, entry });

/** Relocate one entry's mock listing state. Backs the `move_entries` session
 *  mock's per-item relocation, and is injected into `createMockFileHistory`
 *  (as `relocate`) for undo/redo re-execution of a "move" `UndoAction` —
 *  there is no standalone `move_entry` Rust command since #881 routed plugin
 *  moves through the session too, and `tests/api/mock-invoke-parity.test.ts`
 *  enforces that `mockCommands` never grows a command Rust does not have. */
function relocateMockEntry(source: string, destDir: string): FileMutationReceipt {
  const name = basename(source);
  const sourcePath = parentDir(source);
  const sourceEntries = mockFiles[sourcePath] || [];
  const entryIndex = sourceEntries.findIndex((e) => e.path === source);
  if (entryIndex < 0) throw new Error("Source not found");

  const entry = sourceEntries[entryIndex];
  sourceEntries.splice(entryIndex, 1);

  const newPath = `${destDir}/${name}`;
  const newEntry: FileEntry = { ...entry, path: newPath };
  if (!mockFiles[destDir]) mockFiles[destDir] = [];
  mockFiles[destDir].push(newEntry);
  return mutationReceipt(newEntry);
}

interface MockTrashItem { entry: FileEntry; listings: [string, FileEntry[]][]; id: string; deletedAt: string }
const mockTrash = new Map<string, MockTrashItem[]>();
let mockTrashSequence = 0;

function removeMockEntry(path: string, toTrash: boolean): void {
  const parent = parentDir(path);
  const entries = mockFiles[parent] ?? [];
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Path not found: ${path}`);
  const listings = Object.entries(mockFiles).filter(([directory]) => directory === path || directory.startsWith(`${path}/`));
  if (toTrash) {
    const versions = mockTrash.get(path) ?? [];
    versions.push({ entry, listings, id: `mock-trash-${++mockTrashSequence}`, deletedAt: new Date().toISOString() });
    mockTrash.set(path, versions);
  }
  mockFiles[parent] = entries.filter((candidate) => candidate.path !== path);
  for (const [directory] of listings) delete mockFiles[directory];
}

function restoreMockEntry(path: string): void {
  const versions = mockTrash.get(path);
  const item = versions?.at(-1);
  if (!item) throw new Error(`No matching trash item: ${path}`);
  const parent = parentDir(path);
  const entries = mockFiles[parent];
  if (!entries) throw new Error(`Parent not found: ${parent}`);
  if (entries.some((entry) => entry.path === path)) throw new Error(`Path already exists: ${path}`);
  mockFiles[parent] = [...entries, item.entry];
  for (const [directory, listing] of item.listings) mockFiles[directory] = listing;
  versions!.pop();
  if (!versions!.length) mockTrash.delete(path);
}

/** In-app Trash view (#863): the mock trash as `list_trash` reports it. */
function listMockTrash() {
  const entries = [...mockTrash].flatMap(([originalPath, versions]) => versions.map((item) => ({
    id: item.id, name: item.entry.name, originalPath, deletedAt: item.deletedAt,
    kind: item.entry.kind, size: item.entry.kind === "file" ? item.entry.size : 0,
    isSymlink: item.entry.is_symlink === true,
  })));
  return { entries, issues: getMockControl().trashIssues ?? [] };
}

/** Mirrors the native refusals: never overwrite, never invent a parent. */
function restoreMockTrashItems(ids: string[]): FileBatchOutcome {
  const result: FileBatchOutcome = { succeeded: [], failed: [] };
  for (const id of ids) {
    const found = [...mockTrash].find(([, versions]) => versions.some((item) => item.id === id));
    if (!found) {
      result.failed.push({ path: id, error: "This item is no longer in the trash list. Refresh the Trash and try again." });
      continue;
    }
    const [path, versions] = found;
    const parent = parentDir(path);
    const entries = mockFiles[parent];
    if (!entries) {
      result.failed.push({ path, error: `The original folder ${parent} no longer exists or its drive is not mounted. Restore or recreate that folder first.` });
      continue;
    }
    if (entries.some((entry) => entry.path === path)) {
      result.failed.push({ path, error: `${path} already exists. Rename or move it, then restore again.` });
      continue;
    }
    const index = versions.findIndex((item) => item.id === id);
    const [item] = versions.splice(index, 1);
    if (!versions.length) mockTrash.delete(path);
    mockFiles[parent] = [...entries, item.entry];
    for (const [directory, listing] of item.listings) mockFiles[directory] = listing;
    result.succeeded.push(path);
  }
  return result;
}

function deleteMockTrashItems(ids: string[]): FileBatchOutcome {
  const result: FileBatchOutcome = { succeeded: [], failed: [] };
  for (const id of ids) {
    const found = [...mockTrash].find(([, versions]) => versions.some(item => item.id === id));
    if (!found) {
      result.failed.push({ path: id, error: "This item is no longer in the trash list. Refresh the Trash and try again." });
      continue;
    }
    const [path, versions] = found;
    const remaining = versions.filter(item => item.id !== id);
    if (remaining.length) mockTrash.set(path, remaining);
    else mockTrash.delete(path);
    result.succeeded.push(id);
  }
  return result;
}

function mockBatch(paths: string[], operation: (path: string) => void): FileBatchOutcome {
  const result: FileBatchOutcome = { succeeded: [], failed: [] };
  for (const path of new Set(paths)) {
    try {
      operation(path);
      result.succeeded.push(path);
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

// Synthetic large directory for scroll/render profiling (browser-only, mock).
// Reached at `/perf/huge` (default 5000 entries) or `/perf/huge-N`. Deterministic
// mix: ~6% directories, ~12% images (exercise Tiles thumbnails), rest files with
// varied extensions/sizes/dates so sort + column formatting have real work.
const PERF_EXTS = ["ts", "js", "json", "md", "rs", "svelte", "css", "html", "txt", "log", "yaml", "toml"];
const perfHugeCache = new Map<string, FileEntry[]>();
function generateHugeDir(path: string, count: number): FileEntry[] {
  const cached = perfHugeCache.get(path);
  if (cached) return cached;
  const entries: FileEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idx = String(i).padStart(5, "0");
    const bucket = i % 16;
    if (bucket < 1) {
      entries.push({ name: `folder-${idx}`, path: `${path}/folder-${idx}`, kind: "directory", size: 0, modified: new Date(TIMESTAMP_BASE + i * 137 * 1000).toISOString() });
    } else if (bucket < 3) {
      entries.push({ name: `image-${idx}.png`, path: `${path}/image-${idx}.png`, kind: "file", size: 20000 + ((i * 7919) % 500000), modified: new Date(TIMESTAMP_BASE + i * 211 * 1000).toISOString() });
    } else {
      const ext = PERF_EXTS[i % PERF_EXTS.length];
      entries.push({ name: `file-${idx}.${ext}`, path: `${path}/file-${idx}.${ext}`, kind: "file", size: 100 + ((i * 31337) % 900000), modified: new Date(TIMESTAMP_BASE + i * 89 * 1000).toISOString() });
    }
  }
  perfHugeCache.set(path, entries);
  return entries;
}

// Synthetic all-image directory for Tiles scroll-jank regression coverage
// (#593). Reached at `/perf/images` (default 500 entries) or `/perf/images-N`.
// Every entry is an image file so every tile requests a thumbnail — `/perf/huge`
// mixes in non-images and is too sparse to stress the thumbnail decode/paint
// path specifically. Deterministic: realistic names/sizes derived from `i`.
const IMAGE_EXTS = ["jpg", "jpg", "jpg", "png"]; // mostly jpg, some png
const IMAGE_NAME_WORDS = ["sunset", "beach", "mountain", "forest", "city", "portrait", "family", "trip", "event", "wedding", "hike", "camp", "garden", "sky", "river"];
const perfImagesCache = new Map<string, FileEntry[]>();
function generateImagesDir(path: string, count: number): FileEntry[] {
  const cached = perfImagesCache.get(path);
  if (cached) return cached;
  const entries: FileEntry[] = [];
  for (let i = 0; i < count; i++) {
    const idx = String(i).padStart(5, "0");
    const word = IMAGE_NAME_WORDS[i % IMAGE_NAME_WORDS.length];
    const ext = IMAGE_EXTS[i % IMAGE_EXTS.length];
    entries.push({
      name: `${word}-${idx}.${ext}`,
      path: `${path}/${word}-${idx}.${ext}`,
      kind: "file",
      // Realistic photo sizes: ~800KB-4.5MB.
      size: 800_000 + ((i * 104_729) % 3_700_000),
      modified: new Date(TIMESTAMP_BASE + i * 173 * 1000).toISOString(),
    });
  }
  perfImagesCache.set(path, entries);
  return entries;
}

/** True for `/perf/huge` or `/perf/huge-N` (synthetic large-listing dir). */
function isPerfHugePath(path: string): boolean {
  return path === "/perf/huge" || path.startsWith("/perf/huge-");
}

/** True for `/perf/images` or `/perf/images-N` (synthetic all-image dir). */
function isPerfImagesPath(path: string): boolean {
  return path === "/perf/images" || path.startsWith("/perf/images-");
}

// Get directory entries with default empty array for unknown paths
function getDirectoryEntries(path: string): FileEntry[] {
  if (isPerfHugePath(path)) {
    const m = path.match(/^\/perf\/huge-(\d+)$/);
    return generateHugeDir(path, m ? parseInt(m[1], 10) : 5000);
  }
  if (isPerfImagesPath(path)) {
    const m = path.match(/^\/perf\/images-(\d+)$/);
    return generateImagesDir(path, m ? parseInt(m[1], 10) : 500);
  }
  return mockFiles[path] || [];
}

// Mirror the backend listing contract (src-tauri/.../dir_listing.rs sort_entries):
// directories first, then case-insensitively by name. Dotfiles are retained in
// the listing (the frontend filters hidden entries). Returns a sorted copy so
// the stored insertion order (relied on by copy-name generation, fuzzy search)
// is never mutated.
function sortListing(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aIsNotDir = a.kind === "directory" ? 0 : 1;
    const bIsNotDir = b.kind === "directory" ? 0 : 1;
    if (aIsNotDir !== bIsNotDir) return aIsNotDir - bIsNotDir;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Copy one child for the ordered-session mock. Copy is not a standalone IPC. */
function copySessionEntry(source: string, destDir: string, overwrite: boolean): FileMutationReceipt {
  const name = basename(source);
  const sourceEntry = (mockFiles[parentDir(source)] || []).find((entry) => entry.path === source);
  if (!sourceEntry) throw new Error("Source not found");
  if (!mockFiles[destDir]) mockFiles[destDir] = [];
  const dest = mockFiles[destDir];
  let finalName = name;
  if (dest.some((entry) => entry.name === name) && !overwrite) {
    const dot = sourceEntry.kind === "directory" ? -1 : name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    finalName = `${base} - Copy${ext}`;
    for (let n = 2; dest.some((entry) => entry.name === finalName); n++) {
      finalName = `${base} - Copy (${n})${ext}`;
    }
  }
  const newEntry: FileEntry = { ...sourceEntry, name: finalName, path: `${destDir}/${finalName}` };
  const existing = dest.findIndex((entry) => entry.name === finalName);
  if (existing >= 0) dest[existing] = newEntry;
  else dest.push(newEntry);
  return {
    ...mutationReceipt(newEntry),
    ...(existing >= 0 ? { replacement: { id: crypto.randomUUID().replaceAll("-", "").repeat(2) } } : {}),
  };
}

/** Contents of files created via the mocked write_text_file. */
export const mockWrittenFiles: Record<string, string> = {};

const mockFileHistory = createMockFileHistory(
  (command, args) => invokeMockCommand(command, args),
  broadcastFileChange,
  (paths) => mockBatch(paths, restoreMockEntry),
  relocateMockEntry,
);

/** Both listing commands reply in the native compact wire format (#868). */
async function mockDirectoryListing(raw: string): Promise<CompactDirectoryListing> {
  const path = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const override = getMockControl().directoryEntries;
  if (override) return encodeDirectoryListing({ path, entries: await override(path) });
  if (path === "/folder-peek/Error") throw new Error("Permission denied");
  const isSynthetic = isPerfHugePath(path) || isPerfImagesPath(path);
  if (!isSynthetic && !(path in mockFiles)) {
    throw new Error(`Path not found: ${path}`);
  }
  return encodeDirectoryListing({ path, entries: sortListing(getDirectoryEntries(path)) });
}

/** The ordered copy/move session `mockInvoke` runs for `copy_entries` and
 * `move_entries`, which are not ordinary fixture commands. */
export async function runMockCopySession<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const relocating = cmd === "move_entries";
    const request = args!.request as {
      requestId: string; sources: string[]; destDir: string;
    };
    const { requestId, sources, destDir } = request;
    const send = args!.events as (event: CopySessionEvent) => void;
    const control: MockCopyControl = { cancelled: false };
    mockCopyControls.set(requestId, control);
    const items: CopySessionOutcome["items"] = [];
    let applyToAll: CopyDecision | null = null;
    send({ type: "ready" });
    try {
      for (let item = 0; item < sources.length; item += 1) {
        if (control.cancelled) break;
        const source = sources[item];
        const sourceEntry = (mockFiles[parentDir(source)] ?? []).find(({ path }) => path === source);
        if (!sourceEntry) {
          items.push({ status: "failed", error: "Source not found" });
          continue;
        }
        const existing = (mockFiles[destDir] ?? []).find(({ name }) => name === basename(source));
        let decision: CopyDecision | null = null;
        if (existing && !sameDirectory(parentDir(source), destDir)) {
          decision = applyToAll;
        }
        if (existing && !sameDirectory(parentDir(source), destDir) && !decision) {
          const nonce = crypto.randomUUID();
          decision = await new Promise<CopyDecision>((resolve) => {
            control.pending = { item, nonce, resolve };
            send({ type: "conflict", item, nonce, conflict: {
              fileName: basename(source), sourcePath: source, remaining: sources.length - item - 1,
              sourceSize: sourceEntry.size, sourceModified: sourceEntry.modified,
              destSize: existing.size, destModified: existing.modified,
            } });
          });
          control.pending = undefined;
          if (decision.applyToAll) applyToAll = decision;
        }
        if (decision?.choice === "cancel") control.cancelled = true;
        if (control.cancelled) break;
        if (decision?.choice === "skip") { items.push({ status: "skipped" }); continue; }
        send({ type: "started", item, total: sources.length });
        try {
          if (!relocating) {
            await waitForMockLatency("copy_entries");
            if (control.cancelled) break;
          }
          const receipt = relocating
            ? relocateMockEntry(source, destDir)
            : copySessionEntry(source, destDir, decision?.choice === "overwrite");
          items.push({ status: "succeeded", receipt });
          send({ type: "completed", item, total: sources.length, entry: receipt.entry });
        } catch (error) {
          items.push({ status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
      }
      while (items.length < sources.length) items.push({ status: "unstarted" });
      const outcome: CopySessionOutcome = { items, cancelled: control.cancelled, warnings: [] };
      const actions: UndoAction[] = items.flatMap((result, index): UndoAction[] => {
        if (result.status !== "succeeded" || result.receipt.replacement) return [];
        if (!relocating) return [{ type: "copy" as const, copiedPath: result.receipt.path, parentDir: destDir }];
        const source = sources[index];
        if (source === result.receipt.path) return [];
        return [{ type: "move" as const, sourcePath: source, destPath: result.receipt.path, originalDir: parentDir(source) }];
      });
      const verb = relocating ? "Move" : "Copy";
      const action: UndoAction | null = actions.length === 0 ? null : actions.length === 1 ? actions[0]
        : { type: "batch", actions, label: `${verb} ${actions.length} items` };
      const history = items.some(({ status }) => status === "succeeded")
        ? mockFileHistory.push(action).summary
        : mockFileHistory.summary();
      return { result: outcome, history } as T;
    } finally {
      mockCopyControls.delete(requestId);
    }
}

/** Attach the native history receipt to a mutating command's fixture result.
 * Inverse execution calls the raw fixture command, so it never records forward history. */
export function withMockFileHistory<T>(cmd: string, args: Record<string, unknown> | undefined, result: unknown): T {
  if (cmd === "delete_entries") {
    const outcome = result as FileBatchOutcome;
    if (!outcome.succeeded.length) return { result, history: mockFileHistory.summary() } as T;
    const groups = new Map<string, string[]>();
    for (const path of outcome.succeeded) {
      const directory = parentDir(path);
      const paths = groups.get(directory) ?? [];
      paths.push(path);
      groups.set(directory, paths);
    }
    const actions: UndoAction[] = [...groups].map(([parentDir, paths]) => ({ type: "delete", paths, parentDir }));
    const action: UndoAction | null = args!.permanent ? null
      : actions.length === 1 ? actions[0] : { type: "batch", actions, label: "Delete" };
    return { result, history: mockFileHistory.push(action).summary } as T;
  }
  if (cmd === "restore_trash_items" || cmd === "delete_trash_items") {
    // Restoring from the Trash view records no undoable action.
    return { result, history: mockFileHistory.summary() } as T;
  }
  if (["compress_to_zip", "extract_archive"].includes(cmd)) {
    // Archive operations mutate but have no inverse yet, so they advance
    // history with no undoable action (which discards the redo stack).
    return { result, history: mockFileHistory.push(null).summary } as T;
  }
  if (["create_directory", "create_empty_file", "rename_entry", "write_text_file", "create_symlink", "save_image_crop"].includes(cmd)) {
    const receipt = result as FileMutationReceipt;
    if (cmd === "rename_entry" && basename(args!.path as string) === args!.newName) {
      return { result, history: mockFileHistory.summary() } as T;
    }
    const action: UndoAction | null = cmd === "rename_entry"
      ? { type: "rename", path: receipt.path, oldName: basename(args!.path as string), newName: args!.newName as string }
      : null;
    const history = mockFileHistory.push(action);
    return { result, history: history.summary,
      ...(receipt.replacement ? { warning: "Previous destination retained in File Recovery. Overwrite Undo is not available yet." } : {}),
    } as T;
  }
  return result as T;
}

export const fileCommands: Record<string, CommandHandler> = {

  list_directory: (args) => mockDirectoryListing(args.path as string),

  is_directory_empty: (args) => {
    const path = args.path as string;
    const includeHidden = (args.includeHidden ?? args.include_hidden) as boolean;
    // Prefer computing from known children; fall back to the seeded ground truth
    // for folders that have no children keyed in mockFiles.
    if (path in mockFiles) {
      const entries = getDirectoryEntries(path);
      return entries.every((e) => !includeHidden && e.name.startsWith("."));
    }
    return mockDirEmpty[path] ?? false;
  },

  check_paths_exist: (args) => {
    const paths = args.paths as string[];
    const override = getMockControl().checkPathsExist;
    if (override) return override(paths);
    if (typeof args.directory === "boolean") return paths.map(path => {
      const isDirectory = path in mockFiles || perfHugeCache.has(path);
      const entry = [...Object.values(mockFiles), ...perfHugeCache.values()].flat().find(entry => entry.path === path);
      return args.directory ? isDirectory || entry?.kind === "directory" : !isDirectory && entry?.kind === "file";
    });
    return paths.map((p: string) => perfHugeCache.has(p) || [...perfHugeCache.values()].some(entries => entries.some(entry => entry.path === p)) || p in mockFiles || Object.keys(mockFiles).some((k) => {
      const entries = mockFiles[k];
      return Array.isArray(entries) && entries.some((e: { path: string }) => e.path === p);
    }));
  },

  // `.lnk` shortcuts don't exist in the browser fixture; the real command
  // also resolves to null on every non-Windows platform.
  resolve_shortcut: () => null,

  estimate_size: (args) => {
    const paths = args.paths as string[];
    let fileCount = 0;
    let totalBytes = 0;
    for (const p of paths) {
      // Check if it's a directory
      if (p in mockFiles) {
        const entries = mockFiles[p] || [];
        fileCount += entries.filter((e) => e.kind === "file").length;
        totalBytes += entries.filter((e) => e.kind === "file").reduce((sum, e) => sum + e.size, 0);
      } else {
        // Single file — find it in parent
        const parentPath = parentDir(p);
        const entry = (mockFiles[parentPath] || []).find((e) => e.path === p);
        if (entry) {
          fileCount++;
          totalBytes += entry.size;
        }
      }
    }
    return { fileCount, totalBytes };
  },

  list_directory_fresh: (args) => mockDirectoryListing(args.path as string),

  create_directory: (args) => {
    const parentPath = args.parentPath as string;
    const name = args.name as string;
    const newPath = `${parentPath}/${name}`;
    if (mockFiles[newPath] !== undefined) {
      throw new Error(`Directory already exists: ${newPath}`);
    }
    const entry = dir(name, newPath);
    if (!mockFiles[parentPath]) mockFiles[parentPath] = [];
    mockFiles[parentPath].push(entry);
    mockFiles[newPath] = [];
    return mutationReceipt(entry);
  },

  create_empty_file: (args) => {
    const parentPath = args.parentPath as string;
    const name = args.name as string;
    const newPath = `${parentPath}/${name}`;
    if (mockFiles[newPath] !== undefined) {
      throw new Error(`File already exists: ${newPath}`);
    }
    const siblings = mockFiles[parentPath] || [];
    if (siblings.some((e) => e.path === newPath)) {
      throw new Error(`File already exists: ${newPath}`);
    }
    const entry = file(name, newPath, 0);
    if (!mockFiles[parentPath]) mockFiles[parentPath] = [];
    mockFiles[parentPath].push(entry);
    return mutationReceipt(entry);
  },

  rename_entry: (args) => {
    const path = args.path as string;
    const newName = args.newName as string;
    const parentPath = parentDir(path);
    const entries = mockFiles[parentPath] || [];
    const entryIndex = entries.findIndex((e) => e.path === path);
    if (entryIndex >= 0) {
      const oldEntry = entries[entryIndex];
      const newPath = `${parentPath}/${newName}`;
      const newEntry: FileEntry = { ...oldEntry, name: newName, path: newPath };
      entries[entryIndex] = newEntry;
      if (oldEntry.kind === "directory") {
        for (const [directory, children] of Object.entries(mockFiles)) {
          if (directory !== path && !directory.startsWith(`${path}/`)) continue;
          delete mockFiles[directory];
          mockFiles[newPath + directory.slice(path.length)] = children.map(child => ({ ...child, path: newPath + child.path.slice(path.length) }));
        }
        for (const [contentPath, content] of Object.entries(mockFileContent)) {
          if (contentPath.startsWith(`${path}/`)) { delete mockFileContent[contentPath]; mockFileContent[newPath + contentPath.slice(path.length)] = content; }
        }
      }
      return mutationReceipt(newEntry);
    }
    throw new Error("Entry not found");
  },

  delete_entries: (args) => mockBatch(args.paths as string[], (path) => removeMockEntry(path, !args.permanent)),

  write_text_file: (args) => {
    const path = args.path as string;
    const content = (args.content as string) ?? "";
    const parentPath = parentDir(path);
    mockWrittenFiles[path] = content;
    const entries = mockFiles[parentPath] || (mockFiles[parentPath] = []);
    const existingIndex = entries.findIndex((e) => e.path === path);
    const entry = file(basename(path), path, content.length);
    if (existingIndex >= 0) entries[existingIndex] = entry;
    else entries.push(entry);
    return mutationReceipt(entry);
  },

  read_text_file: (args) => {
    const path = args.path as string;
    const hook = getMockControl().previewReadText;
    if (hook) return hook(path);
    if (path in mockWrittenFiles) return mockWrittenFiles[path];
    const content = mockFileContent[path];
    if (content !== undefined) return content;
    throw new Error(`File not found: ${path}`);
  },
  native_resource_session: ({ historyChannel }) => mockFileHistory.register(historyChannel as (summary: HistorySummary) => void),
  resolve_copy_conflict: ({ requestId, item, nonce, decision }) => {
    const pending = mockCopyControls.get(requestId as string)?.pending;
    if (!pending || pending.item !== item || pending.nonce !== nonce) throw new Error("Copy conflict is stale");
    pending.resolve(decision as CopyDecision);
    return null;
  },
  cancel_copy_session: ({ requestId }) => {
    const control = mockCopyControls.get(requestId as string);
    if (!control) throw new Error("Copy session is closed");
    control.cancelled = true;
    control.pending?.resolve({ choice: "cancel", applyToAll: false });
    return null;
  },
  file_history_push: ({ action }) => mockFileHistory.push(action as UndoAction),
  file_history_clear: () => mockFileHistory.clear(),
  file_history_execute: ({ direction, expectedEntryId }) => mockFileHistory.execute(direction as HistoryDirection, expectedEntryId as number),

  // ----- Symlinks -----

  create_symlink: (args) => {
    const targetPath = args.targetPath as string;
    const linkPath = args.linkPath as string;
    const parentPath = parentDir(linkPath);
    const entry: FileEntry = {
      ...file(basename(linkPath), linkPath, 0),
      is_symlink: true,
      symlink_target: targetPath,
    };
    const entries = mockFiles[parentPath] || (mockFiles[parentPath] = []);
    entries.push(entry);
    return mutationReceipt(entry);
  },

  // ----- Archives -----

  list_archive_contents: (args) => {
    const archivePath = args.archivePath as string;
    const name = basename(archivePath);
    // Browser/e2e mode has no real zips — return stable fake listings.
    // A "bundle*.zip" stands in for an archive with a single top-level
    // folder (descended into, with the root-folder indicator); anything
    // else has multiple top-level entries.
    if (name.startsWith("bundle")) {
      const root = name.replace(/\.zip$/i, "");
      return {
        entries: [
          dir("src", `${archivePath}!/${root}/src`),
          file("Cargo.toml", `${archivePath}!/${root}/Cargo.toml`, 320),
          file("main.rs", `${archivePath}!/${root}/main.rs`, 640),
        ],
        rootFolder: root,
      };
    }
    return {
      entries: [
        dir("src", `${archivePath}!/src`),
        file("README.md", `${archivePath}!/README.md`, 512),
        file("data.json", `${archivePath}!/data.json`, 2048),
      ],
      rootFolder: null,
    };
  },

  compress_to_zip: (args) => {
    const paths = args.paths as string[];
    if (!paths?.length) throw new Error("No paths to compress");
    const first = paths[0];
    const parentPath = parentDir(first);
    const zipName = `${basename(first)}.zip`;
    const zipPath = `${parentPath}/${zipName}`;
    const entries = mockFiles[parentPath] || (mockFiles[parentPath] = []);
    if (!entries.some((e) => e.path === zipPath)) {
      entries.push(file(zipName, zipPath, 1024));
    }
    return zipPath;
  },

  extract_archive: (args) => {
    const archivePath = args.archivePath as string;
    const extractHere = (args.extractHere as boolean) ?? false;
    const parentPath = parentDir(archivePath);
    if (extractHere) {
      // Mirror the backend: extract the archive's contents directly into the
      // parent directory so they show up in the listing. Uses the same
      // deterministic contents the read_archive mock reports (README.md,
      // data.json, src/) so E2E can assert the extracted entries appear.
      const entries = mockFiles[parentPath] || (mockFiles[parentPath] = []);
      const extracted: FileEntry[] = [
        file("README.md", `${parentPath}/README.md`, 512),
        file("data.json", `${parentPath}/data.json`, 2048),
        dir("src", `${parentPath}/src`, true),
      ];
      for (const e of extracted) {
        if (!entries.some((x) => x.path === e.path)) entries.push(e);
      }
      mockFiles[`${parentPath}/src`] ||= [];
      return parentPath;
    }
    const folderName = basename(archivePath).replace(/\.zip$/i, "");
    const destPath = `${parentPath}/${folderName}`;
    const entries = mockFiles[parentPath] || (mockFiles[parentPath] = []);
    if (!entries.some((e) => e.path === destPath)) {
      entries.push(dir(folderName, destPath, true));
      mockFiles[destPath] = [];
    }
    return destPath;
  },

  // compress_to_zip/extract_archive resolve synchronously in the mock, so any
  // cancellation always races a job that has already finished — a no-op,
  // matching the real command's "best-effort" cancellation semantics.
  cancel_compress: () => undefined,
  cancel_extract: () => undefined,

  // ----- Filesystem watcher (no-op in mock) -----

  watch_directory: ({ path }) => ({ id: crypto.randomUUID(), path }),

  unwatch_directory: () => {},

  list_trash: () => listMockTrash(),
  delete_trash_items: (args) => deleteMockTrashItems(args.ids as string[]),
  restore_trash_items: (args) => restoreMockTrashItems(args.ids as string[]),
};

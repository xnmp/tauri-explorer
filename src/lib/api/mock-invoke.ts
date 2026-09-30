/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 */

import type { FileBatchOutcome } from "$lib/domain/file-batch-outcome";
import type { HistoryDirection, HistorySummary, UndoAction } from "$lib/domain/file-history";
import { createMockFileHistory } from "./mock-file-history";
import type { DirectoryListing, FileEntry, FileMutationReceipt } from "$lib/domain/file";
import { encodeDirectoryListing, type CompactDirectoryListing } from "./directory-wire";
import { selectPreviewImages } from "$lib/domain/folder-preview";
import { parentDir, basename, sameDirectory } from "$lib/domain/path";
import type { GitNetworkPhaseEvent } from "$lib/domain/git-network-operation";
import { emitWatcherGitChange } from "$lib/state/git-refresh";
import { broadcastFileChange } from "$lib/state/file-events";
import type { GitFileEntry, GitStatusCode, GitStatusSummary } from "$lib/api/git";
import type { CopyDecision, CopySessionEvent, CopySessionOutcome } from "$lib/domain/copy-session";
import { getMockControl, MOCK_LOCAL_KEYS, type MockGitCommit, type MockGitState } from "./mock-control";
import {
  TIMESTAMP_BASE,
  daysAgo,
  dir,
  file,
  fullOid,
  mockDirEmpty,
  mockDrivesFixture,
  mockFileContent,
  mockFiles,
  MOCK_GRAPH_REFS,
  MOCK_GRAPH_SPEC,
  nextTimestamp,
} from "./mock-fixtures";

interface MockCopyControl {
  cancelled: boolean;
  pending?: { item: number; nonce: string; resolve: (decision: CopyDecision) => void };
}
const mockCopyControls = new Map<string, MockCopyControl>();

const mutationReceipt = (entry: FileEntry): FileMutationReceipt => ({ path: entry.path, entry });

interface MockTrashItem { entry: FileEntry; listings: [string, FileEntry[]][] }
const mockTrash = new Map<string, MockTrashItem[]>();

function removeMockEntry(path: string, toTrash: boolean): void {
  const parent = parentDir(path);
  const entries = mockFiles[parent] ?? [];
  const entry = entries.find((candidate) => candidate.path === path);
  if (!entry) throw new Error(`Path not found: ${path}`);
  const listings = Object.entries(mockFiles).filter(([directory]) => directory === path || directory.startsWith(`${path}/`));
  if (toTrash) {
    const versions = mockTrash.get(path) ?? [];
    versions.push({ entry, listings });
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


if (typeof window !== "undefined") {
  const control = getMockControl();
  control.previewRevision = (path) => {
    const parent = parentDir(path);
    const entries = mockFiles[parent];
    const current = entries?.find((entry) => entry.path === path);
    if (!entries || !current) return;
    mockFiles[parent] = entries.map((entry) =>
      entry === current
        ? { ...entry, modified: new Date(Date.parse(entry.modified) + 1000).toISOString(), size: entry.size + 1 }
        : entry,
    );
  };
  control.videoRevision = () => {
    const videos = mockFiles["/home/user/Videos"];
    const recording = videos.find((entry) => entry.path.endsWith("recording.mp4"));
    if (!recording) return;
    mockFiles["/home/user/Videos"] = videos.map((entry) =>
      entry === recording
        ? { ...entry, modified: new Date(Date.parse(entry.modified) + 1000).toISOString(), size: entry.size + 1 }
        : entry,
    );
  };
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

// Realistic per-path mock thumbnails (#593). A single hardcoded JPEG for
// every request let the browser satisfy N tiles from ONE cached decoded
// bitmap — real scroll jank only appears when N tiles each decode a DISTINCT
// image, so that mock was structurally blind to the regression it should
// have caught. Render a small deterministic canvas keyed by (path, size):
// color + shapes derived from a hash of the path, so directories serve
// visibly and byte-wise distinct images. Cached per key so repeated requests
// (micro pre-warm, re-render, remount) don't regenerate. Falls back to the
// static JPEGs at the call sites when canvas is unavailable (e.g. some test
// environments lack a working 2D canvas / toDataURL).
const mockThumbnailCache = new Map<string, string>();
function hashPath(path: string): number {
  let h = 2166136261;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function generateMockThumbnail(path: string, size: number, quality: number): string | null {
  const key = `${path}:${size}`;
  const cached = mockThumbnailCache.get(key);
  if (cached) return cached;
  try {
    if (typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const h = hashPath(path);
    const hue = h % 360;
    const hue2 = (h >>> 8) % 360;
    ctx.fillStyle = `hsl(${hue}, 55%, 45%)`;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = `hsl(${hue2}, 65%, 65%)`;
    const shape = size * 0.4;
    ctx.beginPath();
    ctx.arc(size * 0.3, size * 0.3, shape / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `hsl(${(hue + 180) % 360}, 50%, 30%)`;
    ctx.fillRect(size * 0.5, size * 0.5, shape, shape);
    const dataUri = canvas.toDataURL("image/jpeg", Math.min(1, Math.max(0.1, quality / 100)));
    // A canvas that fails to implement toDataURL (some headless shells)
    // returns "data:," — treat that as unavailable rather than caching junk.
    if (!dataUri || dataUri === "data:,") return null;
    mockThumbnailCache.set(key, dataUri);
    return dataUri;
  } catch {
    return null;
  }
}

// ----- Synthetic load-test repositories (high-load stress suite) -----
//
// A pool of git-repo folders under Documents that the load E2E suite navigates
// into and opens the commit graph for. They must exist in the mock filesystem
// so real UI navigation reaches them; their git history is generated on demand
// by git_log/git_refs below (see the synthetic graph generator). Deterministic:
// nothing here uses Math.random.
const LOAD_REPO_PREFIX = "/home/user/Documents/load-repo-";
const LOAD_REPO_COUNT = 16;
/** Repo index if `path` is inside a synthetic load-repo, else null. */
function loadRepoIndex(path: string | undefined | null): number | null {
  if (!path || !path.startsWith(LOAD_REPO_PREFIX)) return null;
  const rest = path.slice(LOAD_REPO_PREFIX.length);
  const m = /^(\d+)(?:\/|$)/.exec(rest);
  if (!m) return null;
  const i = parseInt(m[1], 10);
  return i >= 0 && i < LOAD_REPO_COUNT ? i : null;
}
// Load-repos exist ONLY when the page opts in via ?mockGitCommits=N (set by
// the e2e-load suite). Injecting them unconditionally changed the baseline
// Documents listing and broke regular E2E in list/tiles view modes (the
// view-switch beforeEach right-clicks "empty space", which no longer existed).
const loadReposEnabled =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("mockGitCommits");
if (loadReposEnabled) {
  for (let i = 0; i < LOAD_REPO_COUNT; i++) {
    const root = `${LOAD_REPO_PREFIX}${i}`;
    // Visible + navigable under Documents, flagged as a git repo (#463 badge).
    mockFiles["/home/user/Documents"].push(dir(`load-repo-${i}`, root, false, true));
    mockFiles[root] = [
      dir("src", `${root}/src`, false),
      file("README.md", `${root}/README.md`, 2048),
      file("package.json", `${root}/package.json`, 512),
    ];
    mockFiles[`${root}/src`] = [file("index.ts", `${root}/src/index.ts`, 256)];
  }
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

// Mock command handlers
type CommandHandler = (args: Record<string, unknown>) => unknown;

/** Tracks paths added to .gitignore via the mocked git_add_to_gitignore so
 *  the SCM panel can hide newly-ignored entries on next git_status. */
const mockGitignored = new Set<string>();
const mockGitArchived = new Set<string>();

// ----- Stateful in-memory git repo (mirrors src-tauri/src/git.rs contract) -----
//
// The SCM E2E tests assert real outcomes (a staged row leaves Changes, commit
// empties the staged section, an external edit shows up on refresh). To make
// those observable, the mock keeps a mutable working-tree/index model and
// moves entries between sections the same way the git2-backed backend would.
const MOCK_REPO_ROOT = "/home/user/Documents/project";

const mockGitCommits: MockGitCommit[] = [];
let pendingGitNetworkOperation:
  | {
      taskId: number;
      cancellable: boolean;
      reject: (reason: Error) => void;
      onPhase?: (phase: GitNetworkPhaseEvent) => void;
    }
  | undefined;

function holdGitNetworkOperation(
  command: "git_fetch" | "git_pull" | "git_delete_remote_branch",
  args: Record<string, unknown>,
): Promise<never> | null {
  if (new URLSearchParams(location.search).get("mockGitNetwork") !== command) return null;
  return new Promise<never>((_resolve, reject) => {
    pendingGitNetworkOperation = { taskId: Number(args.taskId), cancellable: true, reject };
  });
}

function holdGitPullAtFastForwardBoundary(
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> | null {
  const boundary = new URLSearchParams(location.search).get("mockGitPullBoundary");
  if (boundary !== "fast_forward" && boundary !== "late_cancel") {
    return null;
  }

  const taskId = Number(args.taskId);
  const onPhase = args.onPhase as ((phase: GitNetworkPhaseEvent) => void) | undefined;
  const before_oid = mockHeadOid();
  const branch = mockDetached
    ? null
    : ((MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
      null);

  return new Promise((resolve, reject) => {
    pendingGitNetworkOperation = { taskId, cancellable: false, reject, onPhase };
    if (boundary === "fast_forward") onPhase?.({ taskId, cancellable: false });
    window.addEventListener(
      "tauri-explorer:mock-git-pull-finish",
      () => {
        if (pendingGitNetworkOperation?.taskId === taskId) {
          pendingGitNetworkOperation = undefined;
        }
        const after_oid = mockAppendCommit("Pull from upstream");
        resolve({ kind: "head_move", operation: "pull", branch, before_oid, after_oid });
      },
      { once: true },
    );
  });
}

function seedGitState(): MockGitState {
  return {
    branch: "main",
    detached: false,
    staged: [{ path: "src/App.tsx", old_path: null, status: "Modified" }],
    changes: [
      { path: "src/index.css", old_path: null, status: "Modified" },
      { path: "README.md", old_path: null, status: "Modified" },
    ],
    untracked: [
      { path: "src/router.tsx", old_path: null, status: "Untracked" },
      { path: ".env.example", old_path: null, status: "Untracked" },
      { path: "assets/logo.png", old_path: null, status: "Untracked" },
    ],
    // Default seed is a normal dirty tree (no operation in progress). E2E can
    // drive a merge-conflict flow via `window.__mockControl.gitStartMergeConflict()`.
    merge: [],
    op_state: "clean",
  };
}

let mockGit: MockGitState = seedGitState();

// Per-file hunk state lets browser tests exercise the same partial staging
// outcome as the real `git apply` command rather than pretending a hunk is a
// whole-file operation.
const mockHunkState = new Map<string, { staged: Set<number>; discarded: Set<number> }>();
const MOCK_HUNK_STARTS = [1, 10] as const;

function hunkState(path: string): { staged: Set<number>; discarded: Set<number> } {
  let state = mockHunkState.get(path);
  if (!state) {
    // Seeded/whole-file staged entries already live entirely in the index.
    // Their diff must therefore expose every mock hunk on the staged side,
    // even before any hunk-level action has initialized this state.
    const fullyStaged =
      mockGit.staged.some((entry) => entry.path === path) &&
      !mockGit.changes.some((entry) => entry.path === path);
    state = {
      staged: new Set(fullyStaged ? MOCK_HUNK_STARTS : []),
      discarded: new Set(),
    };
    mockHunkState.set(path, state);
  }
  return state;
}

function removeFrom(list: GitFileEntry[], path: string): GitFileEntry | undefined {
  const idx = list.findIndex((e) => e.path === path);
  if (idx < 0) return undefined;
  return list.splice(idx, 1)[0];
}

function upsert(list: GitFileEntry[], entry: GitFileEntry): void {
  if (!list.some((e) => e.path === entry.path)) list.push(entry);
}

/** Stage one path: untracked→staged(Added), changes/merge→staged(Modified). */
function mockStagePath(path: string): void {
  const fromUntracked = removeFrom(mockGit.untracked, path);
  if (fromUntracked) {
    upsert(mockGit.staged, { path, old_path: null, status: "Added" });
    const state = hunkState(path);
    state.staged = new Set(MOCK_HUNK_STARTS);
    state.discarded.clear();
    return;
  }
  const fromMerge = removeFrom(mockGit.merge, path);
  const fromChanges = removeFrom(mockGit.changes, path);
  if (fromChanges || fromMerge) {
    upsert(mockGit.staged, { path, old_path: null, status: "Modified" });
    const state = hunkState(path);
    state.staged = new Set(MOCK_HUNK_STARTS);
    state.discarded.clear();
  }
}

/** Unstage one path: Added→untracked, otherwise→changes. */
function mockUnstagePath(path: string): void {
  const staged = removeFrom(mockGit.staged, path);
  if (!staged) return;
  const state = hunkState(path);
  state.staged.clear();
  state.discarded.clear();
  if (staged.status === "Added") {
    upsert(mockGit.untracked, { path, old_path: null, status: "Untracked" });
  } else {
    upsert(mockGit.changes, { path, old_path: null, status: "Modified" });
  }
}

/** Discard mirrors git.rs: refuses a conflicted (merge) path outright, refuses
 *  a path with staged changes unless forced; otherwise reverts (changes) or
 *  removes (untracked). */
function mockDiscardPath(path: string, force: boolean): void {
  // Conflicted paths have no single obviously-correct resolution, so git.rs
  // refuses to discard them (never force-bypassed) rather than silently
  // deleting — discarding one here would drop the entry and mask data loss.
  if (mockGit.merge.some((e) => e.path === path)) {
    throw new Error(
      `cannot discard '${path}': it has an unresolved merge conflict. ` +
        `Resolve the conflict (stage the file) or abort the operation.`,
    );
  }
  if (!force && mockGit.staged.some((e) => e.path === path)) {
    throw new Error(
      `refusing to discard '${path}' with staged changes; pass force=true to override`,
    );
  }
  removeFrom(mockGit.changes, path);
  removeFrom(mockGit.untracked, path);
  removeFrom(mockGit.merge, path);
  const state = hunkState(path);
  state.discarded = new Set(MOCK_HUNK_STARTS);
}

function mockGitSummary(): GitStatusSummary {
  return {
    is_repo: true,
    repo_root: MOCK_REPO_ROOT,
    branch: mockGit.branch,
    detached: mockGit.detached,
    staged: mockGit.staged.map((e) => ({ ...e })),
    changes: mockGit.changes.map((e) => ({ ...e })),
    untracked: mockGit.untracked
      .filter((e) => !mockGitignored.has(e.path))
      .map((e) => ({ ...e })),
    merge: mockGit.merge.map((e) => ({ ...e })),
    op_state: mockGit.op_state,
  };
}

/** Clear any in-progress operation state (mirrors git's abort commands). */
function mockClearOperation(): void {
  mockGit.merge = [];
  mockGit.op_state = "clean";
}

if (typeof window !== "undefined") {
  const control = getMockControl();
  // Reset the repo to its seed state (mock/browser only).
  control.gitReset = () => {
    mockGit = seedGitState();
    mockHunkState.clear();
    mockGitCommits.length = 0;
    mockGitignored.clear();
    mockGitArchived.clear();
    control.gitArchived = [];
  };
  // Recorded commits, so tests can assert the message that was committed.
  control.gitCommits = mockGitCommits;
  control.gitArchived = [];
  // Simulate an edit made outside the app (e.g. another process): add a
  // modified file to the working tree and fire the watcher change so the
  // SCM store re-fetches, exactly as the real filesystem watcher would.
  control.gitExternalModify = (path: string) => {
    if (
      !mockGit.changes.some((e) => e.path === path) &&
      !mockGit.staged.some((e) => e.path === path)
    ) {
      mockGit.changes.push({ path, old_path: null, status: "Modified" as GitStatusCode });
    }
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  // Simulate the working tree becoming clean (all sections empty) as it would
  // after committing/discarding everything, then fire the watcher change.
  control.gitSetClean = () => {
    mockGit.staged = [];
    mockGit.changes = [];
    mockGit.untracked = [];
    mockGit.merge = [];
    mockGit.op_state = "clean";
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  // Put the mock repo into an in-progress merge with one conflicted file, then
  // fire the watcher change so the SCM panel refreshes into the banner state.
  // Drives the merge-conflict E2E flow.
  control.gitStartMergeConflict = () => {
    mockGit.op_state = "merge";
    if (!mockGit.merge.some((e) => e.path === "src/constants.ts")) {
      mockGit.merge.push({ path: "src/constants.ts", old_path: null, status: "Conflicted" });
    }
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  control.gitState = () => mockGit;
}

/** Contents of files created via the mocked write_text_file. */
const mockWrittenFiles: Record<string, string> = {};

/** In-memory OS clipboard file list, round-tripped by the clipboard_* mocks. */
let mockClipboardFiles: string[] = [];
let mockClipboardEntries: unknown[] | null = null;
let mockClipboardOperation: "copy" | "cut" | null = null;
let mockClipboardRevision = 0;
/** Revision whose Cut a paste has claimed (mirrors the native CutLease). */
let mockClipboardLease: number | null = null;

// ----- Deterministic commit graph for git_log / git_refs mocks (#57) -----

interface MockCommit {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  author_email: string;
  author_time: number;
  summary: string;
  stash?: string;
}

/**
 * A single, unbroken, far-wider-than-the-panel path, used by commit 11's
 * changed-file list (#500). Deliberately has no separator in its final
 * segment, so a fix that only relies on breaking at `/` still overflows.
 */
export const MOCK_LONG_COMMIT_FILE_PATH =
  "src/lib/components/experimental/deeply/nested/generated/" +
  "AnExtremelyLongGeneratedComponentFileNameThatOverflowsThePanel.svelte";

// Newest-first, topologically ordered. 12 commits, a feature branch (#9,#10)
// merged into main at #12, and tags on #1 and #5. Parents reference lower
// numbers, so the array is a valid topological linearization.
const GRAPH_BASE_TIME = Math.floor(Date.UTC(2024, 5, 1, 9, 0, 0) / 1000);

let mockCommitGraphCache: MockCommit[] | null = null;
function mockCommitGraph(): MockCommit[] {
  if (mockCommitGraphCache) return mockCommitGraphCache;
  mockCommitGraphCache = MOCK_GRAPH_SPEC.map((c, i) => ({
    oid: fullOid(c.n),
    short_oid: fullOid(c.n).slice(0, 7),
    parents: c.parents.map(fullOid),
    author_name: c.n % 3 === 0 ? "Bob Dev" : "Alice Coder",
    author_email: c.n % 3 === 0 ? "bob@example.com" : "alice@example.com",
    // The newest three commits are "today" (minutes/hours old) so the
    // graph's relative-time wording is exercised (#389); older commits get
    // fixed historical timestamps.
    author_time:
      i < 3 ? Math.floor(Date.now() / 1000) - [30, 5 * 60, 5 * 3600][i] : GRAPH_BASE_TIME - i * 3600,
    summary: c.summary,
    ...(c.stash ? { stash: c.stash } : {}),
  }));
  // The stash entry sits right before its base commit, like the backend weave.
  const stashIdx = mockCommitGraphCache.findIndex((c) => (c as { stash?: string }).stash);
  if (stashIdx > 0) {
    const [stashRow] = mockCommitGraphCache.splice(stashIdx, 1);
    const basePos = mockCommitGraphCache.findIndex((c) => c.oid === stashRow.parents[0]);
    mockCommitGraphCache.splice(Math.max(0, basePos), 0, stashRow);
  }
  return mockCommitGraphCache;
}

type MockRefKind = "LocalBranch" | "RemoteBranch" | "Tag" | "Head";

/** OID the HEAD ref currently decorates (mock working state). */
function mockHeadOid(): string {
  for (const [oid, list] of Object.entries(MOCK_GRAPH_REFS)) {
    if (list.some((r) => r.kind === "Head")) return oid;
  }
  return fullOid(12);
}

// ----- Synthetic high-load commit graph generator (load stress suite) -----
//
// For synthetic load-repos, git_log/git_refs serve a deterministic history of
// N commits (N from the `mockGitCommits` URL query, default 300). The topology
// is a main spine with periodic 2-commit feature branches that merge back, so
// the graph has real branch/merge edges — not a flat line. Everything is
// derived from index arithmetic (no Math.random), and each repo's tip summary
// embeds its index so tests can assert the correct repo's graph is shown.

/** Commit count for synthetic repos: `?mockGitCommits=`, default 300, capped. */
function loadRepoCommitCount(): number {
  if (typeof location === "undefined") return 300;
  const raw = new URLSearchParams(location.search).get("mockGitCommits");
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 20000) : 300;
}

/** Deterministic unique 40-char hex OID for synthetic commit number i (>= 1).
 *  8 hex digits (up to ~4.29e9) repeated to fill 40 chars. */
function loadOid(i: number): string {
  return i.toString(16).padStart(8, "0").repeat(5);
}

const LOAD_AUTHORS = ["Alice Coder", "Bob Dev", "Carol Maintainer"];
const LOAD_SUBJECTS = [
  "Refactor module boundaries",
  "Fix off-by-one in parser",
  "Add unit tests",
  "Update dependencies",
  "Improve error messages",
  "Tidy up logging",
  "Optimize hot path",
  "Document public API",
];

interface SyntheticGraph {
  /** Newest-first, topologically ordered (parents always have a lower number). */
  commits: MockCommit[];
  refs: Record<string, Array<{ name: string; kind: MockRefKind }>>;
}

const syntheticGraphCache = new Map<string, SyntheticGraph>();

function buildSyntheticGraph(repoIndex: number, n: number): SyntheticGraph {
  // Chronological pass (1..n). `mainTip` tracks the current main-branch head;
  // every 7th step spawns a 2-commit feature branch off it and merges back,
  // producing commits reachable only via a merge's second parent (real edges).
  const nodes: Array<{ i: number; parents: number[] }> = [];
  const featureTips: number[] = [];
  let mainTip = 0;
  let i = 1;
  while (i <= n) {
    if (i === 1) {
      nodes.push({ i, parents: [] });
      mainTip = 1;
      i++;
      continue;
    }
    if (i % 7 === 0 && i + 2 <= n) {
      const base = mainTip;
      nodes.push({ i, parents: [base] }); // feature commit 1
      nodes.push({ i: i + 1, parents: [i] }); // feature commit 2 (branch tip)
      nodes.push({ i: i + 2, parents: [base, i + 1] }); // merge back into main
      featureTips.push(i + 1);
      mainTip = i + 2;
      i += 3;
    } else {
      nodes.push({ i, parents: [mainTip] });
      mainTip = i;
      i++;
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  // Newest-first: sort by number descending. Parents (lower numbers) then sit
  // deeper in the array — the topological order git_log/graph layout expects.
  const commits: MockCommit[] = [...nodes]
    .sort((a, b) => b.i - a.i)
    .map((node) => {
      const isMerge = node.parents.length > 1;
      const summary =
        node.i === mainTip
          ? `Release build ${n} [load-repo-${repoIndex}]`
          : isMerge
            ? `Merge feature branch (#${node.i})`
            : `${LOAD_SUBJECTS[node.i % LOAD_SUBJECTS.length]} (#${node.i})`;
      const a = node.i % LOAD_AUTHORS.length;
      return {
        oid: loadOid(node.i),
        short_oid: loadOid(node.i).slice(0, 7),
        parents: node.parents.map(loadOid),
        author_name: LOAD_AUTHORS[a],
        author_email: `${LOAD_AUTHORS[a].split(" ")[0].toLowerCase()}@example.com`,
        // Newest commit ~now, one minute apart going back — deterministic.
        author_time: nowSec - (n - node.i) * 60,
        summary,
      };
    });

  const refs: SyntheticGraph["refs"] = {};
  refs[loadOid(mainTip)] = [
    { name: "HEAD", kind: "Head" },
    { name: "main", kind: "LocalBranch" },
    { name: "origin/main", kind: "RemoteBranch" },
  ];
  // Decorate the most recent few feature tips so the graph has extra chips.
  featureTips.slice(-3).forEach((tip, k) => {
    (refs[loadOid(tip)] ??= []).push({ name: `feature-${k + 1}`, kind: "LocalBranch" });
  });
  // A couple of tags on older commits.
  if (n >= 4) (refs[loadOid(Math.max(1, Math.floor(n / 4)))] ??= []).push({ name: "v1.0", kind: "Tag" });
  (refs[loadOid(1)] ??= []).push({ name: "v0.1", kind: "Tag" });

  return { commits, refs };
}

function getSyntheticGraph(repoIndex: number, n: number): SyntheticGraph {
  const key = `${repoIndex}|${n}`;
  let g = syntheticGraphCache.get(key);
  if (!g) {
    g = buildSyntheticGraph(repoIndex, n);
    syntheticGraphCache.set(key, g);
  }
  return g;
}

/** git_refs payload for a synthetic repo (mirrors its graph decorations). */
function syntheticRefs(repoIndex: number, n: number) {
  const g = getSyntheticGraph(repoIndex, n);
  const local: Array<{ name: string; target: string }> = [];
  const remote: Array<{ name: string; target: string }> = [];
  const tags: Array<{ name: string; target: string }> = [];
  let head: string | null = null;
  for (const [oid, list] of Object.entries(g.refs)) {
    for (const r of list) {
      if (r.kind === "Head") head = oid;
      else if (r.kind === "LocalBranch") local.push({ name: r.name, target: oid });
      else if (r.kind === "RemoteBranch") remote.push({ name: r.name, target: oid });
      else if (r.kind === "Tag") tags.push({ name: r.name, target: oid });
    }
  }
  return {
    local_branches: local,
    remote_branches: remote,
    tags,
    head,
    head_branch: "main",
    detached: false,
  };
}

/** Resolve a checkout/merge target (branch/tag name or full OID) to an OID. */
function mockResolveTarget(target: string): string | null {
  // A 40-hex OID that exists in the graph.
  if (mockCommitGraph().some((c) => c.oid === target)) return target;
  for (const [oid, list] of Object.entries(MOCK_GRAPH_REFS)) {
    if (list.some((r) => r.name === target && r.kind !== "Head")) return oid;
  }
  return null;
}

/** Move a named ref of a given kind to `oid` (removing its old location). */
function mockMoveRef(name: string, kind: MockRefKind, oid: string): void {
  for (const key of Object.keys(MOCK_GRAPH_REFS)) {
    MOCK_GRAPH_REFS[key] = MOCK_GRAPH_REFS[key].filter(
      (r) => !(r.name === name && r.kind === kind),
    );
    if (MOCK_GRAPH_REFS[key].length === 0) delete MOCK_GRAPH_REFS[key];
  }
  (MOCK_GRAPH_REFS[oid] ??= []).push({ name, kind });
}

/** Add a ref at `oid` (no move — used by create branch/tag). */
function mockAddRef(name: string, kind: MockRefKind, oid: string): void {
  (MOCK_GRAPH_REFS[oid] ??= []).push({ name, kind });
}

function mockFindRef(name: string, kind: MockRefKind): string | null {
  for (const [oid, refs] of Object.entries(MOCK_GRAPH_REFS)) {
    if (refs.some((ref) => ref.name === name && ref.kind === kind)) return oid;
  }
  return null;
}

function mockRemoveRef(name: string, kind: MockRefKind): string | null {
  const oid = mockFindRef(name, kind);
  if (!oid) return null;
  MOCK_GRAPH_REFS[oid] = MOCK_GRAPH_REFS[oid].filter(
    (ref) => ref.name !== name || ref.kind !== kind,
  );
  if (MOCK_GRAPH_REFS[oid].length === 0) delete MOCK_GRAPH_REFS[oid];
  return oid;
}

/** Point HEAD (and, when checking out a branch, follow it) at `oid`. Leaves
 *  the attached/detached mode alone — committing or resetting while detached
 *  keeps HEAD detached, exactly like git. */
function mockMoveHead(oid: string): void {
  mockMoveRef("HEAD", "Head", oid);
}

/** True while the mock repo's HEAD points straight at a commit rather than a
 *  branch (#524). Flipped only by the checkout mocks, mirroring git. */
let mockDetached = false;

/** Check out `oid`. `branch` is the local branch HEAD follows, or null for a
 *  detached checkout (a raw OID, a tag, or a remote-tracking branch). */
function mockCheckout(oid: string, branch: string | null): void {
  mockDetached = branch === null;
  mockMoveHead(oid);
}

/** Is `name` a local branch in the mock graph? */
function mockIsLocalBranch(name: string): boolean {
  return Object.values(MOCK_GRAPH_REFS).some((list) =>
    list.some((r) => r.name === name && r.kind === "LocalBranch"),
  );
}

/** Append a synthetic commit onto the current HEAD and advance main + HEAD to
 *  it. Used by cherry-pick/revert/merge/rebase mocks so E2E sees history move. */
function mockAppendCommit(summary: string): string {
  const graph = mockCommitGraph();
  const head = mockHeadOid();
  const n = 200 + graph.length; // avoid colliding with the 1..12 base OIDs
  const oid = fullOid(n);
  graph.unshift({
    oid,
    short_oid: oid.slice(0, 7),
    parents: [head],
    author_name: "Alice Coder",
    author_email: "alice@example.com",
    author_time: GRAPH_BASE_TIME + graph.length * 3600,
    summary,
  });
  // Advance whatever local branch HEAD was on (default: main), then HEAD.
  // While detached, HEAD moves alone — no branch follows it, like git (#524).
  if (!mockDetached) {
    const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
    mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
  }
  mockMoveHead(oid);
  return oid;
}

// Mutable so manual/E2E testing can simulate ejecting a removable drive: the
// drives store re-polls `list_drives` every ~1.5s, so replacing this list makes
// the change propagate. `window.__mockControl.ejectDrive(path)` (set below)
// removes one. Cloned from the fixture at load so reassigning this local
// binding doesn't try to rebind mock-fixtures.ts's export.
let mockDrives: { name: string; path: string; kind: string; detail?: string; provider?: string }[] =
  [...mockDrivesFixture];

if (typeof window !== "undefined") {
  const control = getMockControl();
  // Test affordance (mock/browser only): drop a drive to mimic an eject.
  control.ejectDrive = (path: string) => {
    mockDrives = mockDrives.filter((d) => d.path !== path);
  };
  // Test affordance (mock/browser only): fire the watcher signal a repo on a
  // UNC path gets every 3s from the poll watcher (#387). Used to prove a diff
  // still lands while those refreshes rain on it (#396).
  control.gitPoll = () => {
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
}

const mockFileHistory = createMockFileHistory(
  (command, args) => invokeMockCommand(command, args),
  broadcastFileChange,
  (paths) => mockBatch(paths, restoreMockEntry),
);

// --- File Recovery fixture (ADR 0023 retention/retirement) -----------------
// The browser build exercises the same commands as the native backend so the
// storage budget, discard control and retained-evidence failure state are
// reachable without Tauri.
interface MockRecoveryRecord {
  id: string;
  generation: bigint;
  originalPath: string;
  retainedPath: string | null;
  retainedBytes: string | null;
  status: "pending" | "busy" | "ready" | "attention" | "retained";
  message: string;
  actions: ("restore" | "discard" | "release")[];
  autoEligible: boolean;
  /** Simulates a cleanup that cannot remove its artifacts (EACCES, missing volume). */
  cleanupFails: boolean;
  /** A move whose committed discard stopped: it can only be retried or forgotten. */
  stranded?: boolean;
}

const MOCK_STRANDED_MESSAGE = "Discard stopped before finishing; its Undo history is gone and the remaining recovery files are preserved. Retry Discard once this is resolved: Read-only file system (os error 30). If it cannot be resolved, Forget releases this record and its locks without deleting anything; its remaining files stay in the listed folder";

const mockRecoveryBudgetBytes = 2 * 1024 * 1024 * 1024;
let mockRecoveryRevision = 4n;
let mockRecoveryRecords: MockRecoveryRecord[] = [
  {
    id: "a".repeat(64),
    generation: 11n,
    originalPath: "/home/user/Documents/quarterly-report.md",
    retainedPath: "/home/user/Documents/.tauri-explorer-recovery-6f2a",
    retainedBytes: "742391808",
    status: "retained",
    message: "Inspect these retained recovery files to restore or discard them",
    actions: [],
    autoEligible: false,
    cleanupFails: false,
  },
  {
    id: "b".repeat(64),
    generation: 7n,
    originalPath: "/run/media/user/Archive/photos/2024-summer",
    retainedPath: "/run/media/user/Archive/photos/.tauri-explorer-recovery-c81d",
    retainedBytes: null,
    status: "retained",
    message: "Inspect these retained recovery files to restore or discard them",
    actions: [],
    autoEligible: false,
    cleanupFails: true,
  },
  {
    id: "c".repeat(64),
    generation: 5n,
    originalPath: "/run/media/user/Backup/site-assets",
    retainedPath: "/run/media/user/Backup/.tauri-explorer-recovery-9e41",
    retainedBytes: "18874368",
    status: "attention",
    message: MOCK_STRANDED_MESSAGE,
    actions: [],
    autoEligible: false,
    cleanupFails: true,
    stranded: true,
  },
];
let mockRecoveryError: string | null = null;
let mockRecoveryReceive: ((snapshot: unknown) => void) | null = null;

function mockRecoverySnapshot(): unknown {
  const used = mockRecoveryRecords.reduce((total, record) => total + Number(record.retainedBytes ?? 0), 0);
  const unmeasured = mockRecoveryRecords.filter((record) => record.retainedBytes === null).length;
  return {
    revision: mockRecoveryRevision.toString(),
    items: mockRecoveryRecords.map(({ autoEligible: _auto, cleanupFails: _fails, stranded: _stranded, generation, ...item }) => ({
      ...item,
      generation: generation.toString(),
      actions: [...item.actions],
    })),
    storage: {
      usedBytes: used.toString(),
      budgetBytes: mockRecoveryBudgetBytes.toString(),
      records: mockRecoveryRecords.length,
      recordBudget: 256,
      unmeasured,
      unavailable: mockRecoveryRecords.filter((record) => record.cleanupFails).length,
      discardable: mockRecoveryRecords.filter((record) => record.status === "retained" || record.status === "ready").length,
      atCapacity: used >= mockRecoveryBudgetBytes,
    },
    error: mockRecoveryError,
  };
}

function mockRecoveryPublish(): unknown {
  const snapshot = mockRecoverySnapshot();
  mockRecoveryReceive?.(snapshot);
  return snapshot;
}

/** Both listing commands reply in the native compact wire format (#868). */
function mockDirectoryListing(raw: string): CompactDirectoryListing {
  const path = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const isSynthetic = isPerfHugePath(path) || isPerfImagesPath(path);
  if (!isSynthetic && !(path in mockFiles)) {
    throw new Error(`Path not found: ${path}`);
  }
  return encodeDirectoryListing({ path, entries: sortListing(getDirectoryEntries(path)) });
}

const mockCommands: Record<string, CommandHandler> = {
  get_home_directory: () => "/home/user",
  get_launch_cwd: () => "/home/user",
  list_drives: () => {
    const control = getMockControl();
    const drives = control.linuxVolumes ?? mockDrives;
    // Model the native mount-table/cloud fallback when the optional service
    // disappears. Only mounted paths survive, without a UDisks identity.
    return control.udisksUnavailable
      ? drives.filter((d) => d.path !== null).map((d) => ({ ...d, deviceId: undefined }))
      : drives;
  },
  mount_drive: (args) => {
    const control = getMockControl();
    if (control.udisksUnavailable) throw new Error("Linux storage service (UDisks2) unavailable");
    if (control.mountError) throw new Error(control.mountError);
    const drive = control.linuxVolumes?.find((d) => d.deviceId === args?.deviceId);
    if (!drive) throw new Error("Linux storage service (UDisks2) unavailable");
    drive.path ??= "/media/user/USB_DRIVE";
    return drive.path;
  },
  // The mock has no UDisks push subscription, so the drive store stays in
  // poll mode; the volume evidence specs assert on that polling.
  drive_updates_live: () => false,
  log_startup_timing: () => undefined,

  // Crash reporting (#184, #302): a Rust crash is simulated when the e2e test
  // sets localStorage.mockCrashReport before load; a frontend crash is
  // simulated by record_frontend_crash writing localStorage.mockFrontendCrash.
  // Either is consumed on first read, mirroring take_crash_report's mark-seen.
  take_crash_report: () => {
    if (localStorage.getItem(MOCK_LOCAL_KEYS.crashReport) === "1") {
      localStorage.removeItem(MOCK_LOCAL_KEYS.crashReport);
      return {
        fileName: "crash-1700000000.txt",
        contents:
          "tauri-explorer 1.0.0 crash report\nos: linux (x86_64)\ntime: 1700000000 (unix)\npanic: mock panic for testing\nlocation: src/lib.rs:1:1\n\nbacktrace:\n<omitted>\n",
      };
    }
    const frontend = localStorage.getItem(MOCK_LOCAL_KEYS.frontendCrash);
    if (frontend) {
      localStorage.removeItem(MOCK_LOCAL_KEYS.frontendCrash);
      return JSON.parse(frontend);
    }
    return null;
  },
  log_frontend_error: () => undefined,
  // Frontend crash capture (#302): persist a crash record the next "launch"
  // (page reload) will offer via take_crash_report. Dedupe lives in crash.ts.
  record_frontend_crash: (args) => {
    const message = String(args.message ?? "");
    const stack = args.stack ? String(args.stack) : "<no stack captured>";
    localStorage.setItem(
      MOCK_LOCAL_KEYS.frontendCrash,
      JSON.stringify({
        fileName: "crash-1700000001.txt",
        contents:
          `tauri-explorer 0.0.0-mock crash report\nos: linux (x86_64)\n` +
          `time: 1700000001 (unix)\nsource: frontend (webview)\n` +
          `panic: ${message}\nlocation: webview\n\nbacktrace:\n${stack}\n`,
      }),
    );
    return undefined;
  },
  open_external_url: (args) => {
    if (localStorage.getItem(MOCK_LOCAL_KEYS.openUrlError) === "1") {
      throw new Error("Mock browser handoff failed");
    }
    const url = args.url as string;
    localStorage.setItem(MOCK_LOCAL_KEYS.openedUrl, url);
    return undefined;
  },
  submit_user_report: (args) => {
    localStorage.setItem(MOCK_LOCAL_KEYS.submittedReport, JSON.stringify(args));
    const error = localStorage.getItem(MOCK_LOCAL_KEYS.reportError);
    if (error) {
      throw {
        kind: error,
        message: error === "daily_cap"
          ? "Reports are temporarily unavailable"
          : "Unable to submit report",
      };
    }
    return {
      url: "https://github.com/xnmp/tauri-explorer/issues/5470",
      number: 5470,
    };
  },

  // Update check (#185): a newer release is simulated when the e2e test
  // sets localStorage.mockUpdateAvailable before load.
  check_for_update: () =>
    localStorage.getItem(MOCK_LOCAL_KEYS.updateAvailable) === "1"
      ? {
          version: "9.9.9",
          url:
            localStorage.getItem(MOCK_LOCAL_KEYS.updateUrl) ??
            "https://github.com/xnmp/tauri-explorer/releases/tag/v9.9.9",
        }
      : null,

  // Pre-warmed window pool: no pool outside Tauri — spawn is always refused
  // and claims always miss, so openNewWindow takes the fresh-window path.
  warm_pool_begin_spawn: () => false,
  warm_pool_activate: () => false,
  warm_pool_cancel_spawn: () => undefined,
  warm_pool_register: () => undefined,
  warm_pool_claim: () => null,
  warm_pool_discard: () => undefined,
  warm_pool_shutdown: () => undefined,

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
    return paths.map((p: string) => p in mockFiles || Object.keys(mockFiles).some((k) => {
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
      return mutationReceipt(newEntry);
    }
    throw new Error("Entry not found");
  },

  delete_entries: (args) => mockBatch(args.paths as string[], (path) => removeMockEntry(path, !args.permanent)),

  move_entry: (args) => {
    const source = args.source as string;
    const destDir = args.destDir as string;
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
  },

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

  open_file: () => {
    // No-op for mock
  },

  open_file_at_line: () => {
    // No-op for mock
  },

  open_image_with_siblings: () => {
    // No-op for mock
  },

  fuzzy_search: (args) => {
    const query = (args.query as string).toLowerCase();
    // Browser mode falls back to this complete-result search when Tauri event
    // streaming is unavailable; record the same Quick Open search boundary as
    // `start_streaming_search` below.
    const calls = JSON.parse(localStorage.getItem(MOCK_LOCAL_KEYS.streamingSearches) ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem(MOCK_LOCAL_KEYS.streamingSearches, JSON.stringify(calls));
    const root = (args.root as string) || "/home/user";
    const limit = args.limit as number || 20;
    const results: Array<{ name: string; path: string; relativePath: string; score: number; kind: "file" | "directory" }> = [];

    // Only search within directories that are under root (recursive)
    for (const [dirPath, entries] of Object.entries(mockFiles)) {
      if (!dirPath.startsWith(root)) continue;
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(query)) {
          const relativePath = entry.path.startsWith(root + "/")
            ? entry.path.slice(root.length + 1)
            : entry.name;
          // Depth bonus: shallower matches score higher
          const depth = relativePath.split("/").length;
          const depthBonus = Math.max(0, 50 - (depth - 1) * 5);
          const dirBonus = entry.kind === "directory" ? 30 : 0;
          results.push({
            name: entry.name,
            path: entry.path,
            relativePath,
            score: 100 + depthBonus + dirBonus,
            kind: entry.kind,
          });
        }
      }
    }

    // Sort by score descending, then limit
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, limit) };
  },

  start_streaming_search: (args) => {
    // Browser Quick Open regressions can assert the real component's IPC
    // boundary without replacing its search API. This stays mock-only: the
    // production backend never reads this diagnostic key.
    const calls = JSON.parse(localStorage.getItem(MOCK_LOCAL_KEYS.streamingSearches) ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem(MOCK_LOCAL_KEYS.streamingSearches, JSON.stringify(calls));
    return 1; // Mock search ID
  },

  cancel_search: () => {},



  // Browser mode has no Tauri event system to stream results through, so the
  // mock searches the virtual filesystem synchronously and returns the
  // complete result set inline (the real backend returns a numeric search id
  // and streams via 'content-search-results' events).
  start_content_search: (args) => {
    const query = args.query as string;
    const root = (args.root as string) || "/home/user";
    const caseSensitive = (args.caseSensitive as boolean) ?? false;
    const regexMode = (args.regexMode as boolean) ?? false;
    const maxResults = (args.maxResults as number) ?? 500;

    if (!query) throw new Error("Search query cannot be empty");
    const pattern = regexMode ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive ? "g" : "gi");
    } catch (e) {
      throw new Error(`Invalid search pattern: ${e}`);
    }

    const rootPrefix = root.endsWith("/") ? root : root + "/";
    const results: Array<{
      path: string;
      relativePath: string;
      matches: Array<{
        lineNumber: number;
        column: number;
        lineContent: string;
        matchStart: number;
        matchEnd: number;
      }>;
    }> = [];
    let filesSearched = 0;
    let totalMatches = 0;

    for (const [dirPath, entries] of Object.entries(mockFiles)) {
      if (dirPath !== root && !dirPath.startsWith(rootPrefix)) continue;
      for (const entry of entries) {
        if (entry.kind !== "file" || totalMatches >= maxResults) continue;
        const content = mockWrittenFiles[entry.path] ?? mockFileContent[entry.path];
        if (content === undefined) continue;
        filesSearched++;

        const matches: (typeof results)[number]["matches"] = [];
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = re.exec(lines[i])) !== null) {
            matches.push({
              lineNumber: i + 1,
              column: m.index + 1,
              lineContent: lines[i],
              matchStart: m.index,
              matchEnd: m.index + m[0].length,
            });
            if (m[0].length === 0) re.lastIndex++;
          }
        }
        if (matches.length > 0) {
          totalMatches += matches.length;
          results.push({
            path: entry.path,
            relativePath: entry.path.startsWith(rootPrefix)
              ? entry.path.slice(rootPrefix.length)
              : entry.name,
            matches,
          });
        }
      }
    }

    return {
      searchId: 0,
      results,
      done: true,
      filesSearched,
      totalMatches,
    };
  },

  cancel_content_search: () => {},

  get_thumbnail: () => {
    throw new Error("Thumbnails not available in mock mode");
  },

  get_thumbnail_data: (args) => {
    // #593 regression guard: a single hardcoded JPEG for every path let the
    // browser satisfy N tiles from ONE cached decoded bitmap, hiding scroll
    // jank that only appears when N distinct images must each be decoded.
    // Render a per-path canvas instead; fall back to the static JPEG below
    // when canvas is unavailable.
    const path = (args.path as string) ?? "";
    const size = (args.size as number) ?? 128;
    const quality = (args.quality as number) ?? 90;
    return (
      generateMockThumbnail(path, size, quality) ??
      // Real 128px thumbnail from beautiful.jpg — fallback when canvas is unavailable.
      "data:image/jpeg;base64,/9j//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgKCgsKCw0NDQ0NDRAPEBAQEBAQEBAQEBASEhIVFRUSEhIQEBISFBQVFRcXFxUVFRUXFxkZGR4eHBwjIyQrKzP/xACaAAABBQEBAQAAAAAAAAAAAAAABAcFBgMCAQgBAAIDAQEAAAAAAAAAAAAAAAAEAwIFAQYQAAEDAgQFAwMCBgIDAQAAAAECAxEABCESMQVRQRNhcSIUgQYykUIj8MGhUmIVsUQzFrJDEQABAwIDBgMHBAMBAAAAAAABAAIRAyExElEEQeGBoRNhcULBFKIyIlIF0ZFiU/CxcvH/wAARCACAAIADASIAAhEAAxEA/9oADAMBAAIRAxEAPwD5/ooooQiiiihCKKKKEIooooQiiiihCKKKKEIooooQiiiihCKKeD2/auvb9qZ7I+7pxUxpEJnaKeX23athZLkSMoiZVgI41bsD7+nFUyOwAJTKUU9XtuEHxjXXtjVxsoPr6cVQy2xCZOint9sa99r2q3un8/h4qspkaKe72p4V77U0e6fz+HijMmQop7/anthW4211SAsJwMx8Vw7KBjUA5cV0ScASmJop8BaEmI01rNVuE60e6D+z4eK5KZOinqSxmMJBNbuWeXFOI50e6j+z4eKJUr7elDdnmOlKIilzZGWAQDqP4mke6VvdsTdIum2y0VpbC1n0o5jMT6SQeMEa61Vrx59zFwlKpHo4BIgKV34CnCLEtLSpCVpcy6QhWdOEomUmeYkY1GI2xKiEKSpKyCpKHfR1ynHI2sEgkjTnrhFcFQzJupGZA03Dfb+yb9t56cnU6eZQBVofM1PpuEh3p9PMjOlCXAcCCkQTxPM161YtXzaX20qQ2r7lFMhJnFCZIUvKfTIGXuaVo2tpsg9dJymQMqcD/ABwPxTjKhNxKWqso73NMg8jrKXBgV17ccK1SuSAMTp5rt1RZMKp7OMJvosEze0gb9yzTbA1uLMGhhwuupbEye3Lj+KkVrZR6FKSNSAVAKMawJk0nW2nt2AzH2JuhQNXGwCyWw0mB00xAJw5+f4mkruVtsIHoBxgc5qF3Le27VKllSjBEIBGY8sB/yap979SreDfQGQkSvMAVDH7eGOs1BTp1HxmwxxPtTlRzGAx5bldlFOOAj/mkClNFQkjXSao53V5Zl12Ixy/aPwKRi5feJUj9R15Vohsb1ludKt6tybn9tB5ySdI8UhuLpVwsJBOUchzPM1Vx1QT6lEVL2qwTlwnvUkAXVJTgqJ5VgXymnJVYMkehpR7AJH5k1XL+2Uz/ANC4XOhQkL/OWSPxXiaW2g4ierzU6mBjzj9VAjc1RGEeI/p8UkubxNy0ppzFJ+CDyUk6hQ5EYiptWx3a/wD8EonESon/AORge1IV7DcDL1C03mVlEqnHvExWlS2vZ3WJE6YlJVabvS9p5hUf324bYwlKVNPstDKYCkOBE88YPc11/wCxWpxUpYJxxSf5TST6n226sspD7brJ1DSsUkf3jUjgdKb3WtGlVz/Jhun/ACVnVqWUDNB8k5KfrF1kkW9s3ljAuFRXn/uMYZf8eXGom5+otwuTOcNCc2VtIEYzqZJ+daq7TKlaSat1v8ATd+/aptf20trkpJWASOGJ1pqKbLugE2k7yoZe4QJgdFGN7jeh9LwuHs4VnkrVie+Oh5jSKV3m4vvKLrvrejBWmTxw44UvW6LZOZWUqAxIPpHDUcqj3bXq5iVFJP2kiAe2kj4q/Vp03RX7zmjkKFW6pa+o8srXhiThhrXSFpKp1PDlSkbcvISv0nHn/AFilfJZME8cR2qUCFAXly1QyhbqlPEIBxgHH8UrNwlpOVGCRz41CLWrNMj50ry5WrMkYacs4XAOVWJSxW4uHDKAJ74VabjvXYCfJN5d2xUWy8gqOUkBXP+feptt0fCFvXLyyhpElMStcaYamm+K0gzlBrQXS9BCRzCcJrzDfxx3gHkvVv2mk8GQ2T6oEq8P8A1W2LAPtr+5QOm1EQAqAVHkSRoNJps1bxut2s+k+o4QFE4+TjNSYdTlyFJKYjHl4qe2zblOONXByoZzKc+71SmYwA/uA+KfpbO3ZWk5QPHU6JF7qThFPGcN4GpUOxs243BbNynKhRGaT6ko5lQGmHGq4dhR1n0NyqF/tgRiDoMeFOjd3UlcH7iZA0qOYWzYA3D60t5hMnE5ePaeQ1qxqPDZJvaAOsqWlTZUeJaC2HAl15MWjxCx2zZre0JuLhlsJS2MVkFKVRBJn0zM60m3rfmUICG1teARAHGBVW3R++3pSQ46npBSuiw2DilRwU5BgqIjjHauUWNnZplxgEJTJKow78MKYo05IdUILosJwHNI7UHnOWsLWTcxYnkor/bvKUcOskajJh5wrs7zmBBtwP8pOHxjWDe4W7TpTbslefAhIKpjkBr5rdxD7xSn2TqAtRQJbUn1DlWhDf/ABZjXvwwHjHtUQ7duO/qgcBgKSrzvYJzKiTxqyf60JCv2lggQc2gPHCvLJVml1SVKAwjmU4cYGNAOYYEIqAMMSHG8xh+6iGLMqSSdeFJ7m1KElZwA8VfHV2oQSlWcJ0hJg+MBVedvkupUAwoyIhUAfMV10ERgqMDycCfJV9FpnSFayJFapaCNOWtR61uNSlCihKv0iYB7TpPmlaLR1fMn81E140gjHRSZHE2k8lekk0oQmaToBUYFWexcYt1pUEZlcjqZjkKtUcKYs3MdFNTaah+bKNSk7NisuIDoWkEicPUBzgHCYpw7pLFpbobCZSlAAE6DueJ1PmkVvcdRYznMeQGMeSaU3hauGyVrSUwRAJEkeOHKsirVdUezMCAMQJi60GUQycpknVUd5ZCFPLWhCQSB8a+Iqvbluts+2lv0uBEEEqCZjERAPP4rXdWnXlKCc+QfoGAx7VXk7WyXm2n1hkH71icrYgnwSQMBxqZ4pzeScYbEpiia1NpIhowzOBj/RSe03ZDToKmlHKkhSk+rjGA01A81xc3i7hxAfDzDGBAynMtPGOJjCdKvVgxs1haICFKffvMpabgqWRmISVRARrzgeasS9i3G7/8gYymDmUgr6czKZCvVU9FrGkuAIJtLseSz9p2qtWaKbnSAc0AReIumyb3W0s0hqxYUf1Z1j1E8cZM8sIpQneN8uG1ZCAmYzdPSdEycJ4c6cBj6MQVJfuXGWshzLykBJSNccABU+9efTW2wyq5s80SpGbOSU6KOTMEnhONNZm+azU0K9nvbxCVOPuqcdWE9MGE/KQYB171LWf0e8xcoS8tKklIXlTr84Vatw3fab23UhO52tqkrSrK2CVEp0PUCJSR2jvXDO4bGwhxmx3IKeyGFulQQT2dUAg5dQNCa5mQuzsKTmyIygDTjUarZW2ZOUEk6V479RC0hk3b14oCV9Mt9IHh1RjPECRVO3P6ouFuICAG8vqUAc08MSOXilNpFQt+kwtf8fVo0yTUE+BURvSEddxtskCftAEJI0/JqLZvXwMpUoKTqomThx8UgeunnHS4pRkqKvzXC3s7meIzYECo6Ya2PC31XtqodorGpVe5pLZO6w8rJzUyhOoBpS0uSJJpnaKlO0T6evBLgxyX0HbOdFspBjMfuOEjhjS8An7jl/n+K+baKgz42xxTArxH04YX4L6Octkn1DWqDu8hDndxP9EqFNfRUGQZ8++3Qyn3fkpo9rtWv6tR/wAp69itgx7Z5tpu6vXUjpoUVdNhqSMzkYkqP2oGOBmnqu13u2bZeXK+hcuNMLcQ222ppGYAnHM4skczzwr4qoqUveSZI8LYdf0WY57DGVkfdeZ6CFfPqHcNzfeDF1fXF0pUS1PTYSScAG0QmJ+3xrVUKAwFNqnqgwRlBSn51nxUdRVGZ2gBzi/U4SfYPBWqVKbnOLKQpg/KAZDRF8Rdx16KRaaUTiDr4g9xSpaSyUwYVqOI4VCUU13oFm31nglYU571wjLmCY55NfxSZQS5KucDtPHGajKKO/OInmiEpUIHxSevKKjc+dy6iiiiol1FFFFCEUUUUIRRRRQhFFFFCEUUUUIRRRRQhFFFFCF//9k="
    );
  },

  get_micro_thumbnail: (args) => {
    const path = (args.path as string) ?? "";
    const size = (args.prewarmSize as number) ?? 16;
    const quality = (args.prewarmQuality as number) ?? 50;
    return (
      generateMockThumbnail(path, size, quality) ??
      // Real 16px micro thumbnail — fallback when canvas is unavailable.
      "data:image/jpeg;base64,/9j//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABiAAEBAQAAAAAAAAAAAAAAAAAGAwUBAQAAAAAAAAAAAAAAAAAAAAQQAAIBAwQCAwEAAAAAAAAAAAECAxESACExIgRxYRNBUTIRAQACAwEBAAAAAAAAAAAAAAEhADFBAoED/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjOYesy3q4rUW2Vq3o4en70YNEis21Ycq+M3WvdI7ecjm0En+PwA/VddsDTjrpGx+UO9RooLbb8mpp4GN4UJZKn6Zjfl//9k="
    );
  },

  read_image_data_url: (args) => {
    const hook = getMockControl().previewReadImage;
    if (hook) return hook((args.path as string) ?? "");
    // Full-size preview in browser/E2E mode: reuse the realistic thumbnail
    // JPEG so the preview pane (and its fullscreen mode) can be exercised.
    return mockInvoke<string>("get_thumbnail_data");
  },

  get_video_thumbnail_data: (args) => {
    const videoThumbnailMock = getMockControl().videoThumbnail;
    if (videoThumbnailMock) {
      return videoThumbnailMock((args.path as string) ?? "", args.size as number | undefined);
    }
    // Same realistic 128px thumbnail as images — stands in for an extracted
    // video frame so the tiles view can be demoed in browser/E2E mode.
    return mockInvoke<string>("get_thumbnail_data");
  },

  get_folder_preview: (args) => {
    // Runs the real domain selection over the mock listing, so browser E2E
    // exercises the actual rules (image filter, hidden skip, sort, cap).
    const path = args.path as string;
    const entries = mockFiles[path];
    if (!entries) throw new Error(`Not a directory: ${path}`);
    const names = entries.filter((e) => e.kind === "file").map((e) => e.name);
    const selected = new Set(selectPreviewImages(names));
    const image_paths = entries.filter((e) => selected.has(e.name)).map((e) => e.path);
    return {
      folder_path: path,
      image_paths,
      fingerprint: `mock:${image_paths.join("|")}`,
    };
  },

  // Embedded terminal: a PTY can't be faked meaningfully in the browser —
  // spawn "succeeds" (so the panel renders and e2e can exercise the toggle)
  // but never emits output. Real terminal behavior is covered by e2e-tauri.
  terminal_reserve_id: () => 1,
  terminal_spawn: () => ({ id: 1, shellKind: "posix", wslDistro: null }),
  terminal_write: () => ({ droppedBytes: 0 }),
  terminal_resize: () => {},
  terminal_kill: () => {},
  terminal_status: () => ({ busy: false, cwd: null }),

  clear_thumbnail_cache: () => 0,

  get_thumbnail_cache_stats: () => ({
    count: 0,
    totalSize: 0,
    path: "/tmp/thumbnails",
  }),

  // Config file persistence (in-memory mock)
  read_config_file: (args) => {
    const filename = args.filename as string;
    return mockConfigFiles[filename] ?? "";
  },

  write_config_file: (args) => {
    const filename = args.filename as string;
    const data = args.data as string;
    mockConfigFiles[filename] = data;
  },

  get_config_dir: () => "/home/user/.config/tauri-explorer",


  get_git_status: (args: Record<string, unknown>) => {
    const path = args.path as string;
    // Mock: treat /home/user/Documents/project as a git repo
    if (path.startsWith("/home/user/Documents/project")) {
      return {
        is_git_repo: true,
        statuses: {
          "App.tsx": "Modified",
          "index.css": "Modified",
          "router.tsx": "Untracked",
          "src": "Modified",
          "CHANGELOG.md": "Modified",
          ".env.example": "Untracked",
        },
      };
    }
    return { is_git_repo: false, statuses: {} };
  },
  cancel_get_git_status: () => {},

  // ----- SCM git backend (#53) mock -----

  git_init: (args: Record<string, unknown>) => {
    return args.path as string;
  },

  git_repo_root: (args: Record<string, unknown>) => {
    const p = args.path as string;
    // No trailing slash — must stay consistent with git_status.repo_root
    if (p?.startsWith("/home/user/Documents/project")) return "/home/user/Documents/project";
    const li = loadRepoIndex(p);
    if (li !== null) return `${LOAD_REPO_PREFIX}${li}`;
    return null;
  },

  git_directory_scope: async (args: Record<string, unknown>) => {
    const root = await mockCommands.git_repo_root(args) as string | null;
    return root ? { repo_root: root, relative_directory: (args.path as string).slice(root.length).replace(/^\/+/, "") } : null;
  },

  git_add_to_gitignore: (args: Record<string, unknown>) => {
    const entry = ((args.entry as string) || "").replace(/^\.\//, "").replace(/^\//, "");
    if (!mockGitignored.has(entry)) {
      mockGitignored.add(entry);
    }
    return entry;
  },

  git_archive_untracked: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !mockGit.untracked.some((entry) => entry.path === path))) {
      throw new Error("refusing to operate on non-untracked path");
    }
    for (const path of paths) {
      removeFrom(mockGit.untracked, path);
      mockGitArchived.add(`.archive/${path}`);
    }
if (typeof window !== "undefined") {
      getMockControl().gitArchived = [...mockGitArchived];
    }
    return null;
  },

  git_trash_untracked: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    if (paths.length === 0 || new Set(paths).size !== paths.length || paths.some((path) => !mockGit.untracked.some((entry) => entry.path === path))) {
      throw new Error("refusing to operate on non-untracked path");
    }
    for (const path of paths) removeFrom(mockGit.untracked, path);
    return null;
  },

  git_status: (args: Record<string, unknown>) => {
    const repoPath = args.repoPath as string;
    const li = loadRepoIndex(repoPath);
    if (li !== null) {
      // Synthetic repos have a clean working tree (no uncommitted row).
      return {
        is_repo: true,
        repo_root: `${LOAD_REPO_PREFIX}${li}`,
        branch: "main",
        detached: false,
        staged: [],
        changes: [],
        untracked: [],
        merge: [],
        op_state: "clean",
      };
    }
    if (!repoPath?.startsWith(MOCK_REPO_ROOT)) {
      return {
        is_repo: false,
        repo_root: null,
        branch: null,
        detached: false,
        staged: [],
        changes: [],
        untracked: [],
        merge: [],
        op_state: "clean",
      };
    }
    return mockGitSummary();
  },
  cancel_git_status: () => {},

  git_commit_files: (args) => {
    const oid = args.oid as string;
    // Deterministic per-commit file list keyed off the mock graph's OIDs.
    const n = parseInt(oid.slice(0, 4), 16);
    if (Number.isNaN(n)) return [];
    if (n === 12) {
      return [
        { path: "src/feature-x.ts", status: "A" },
        { path: "src/index.ts", status: "M" },
      ];
    }
    // Commit 11 carries a deliberately over-long path so the changed-files
    // list's overflow behaviour is exercisable end-to-end (#500). No other
    // spec asserts on this commit's file list.
    if (n === 11) {
      return [{ path: MOCK_LONG_COMMIT_FILE_PATH, status: "M" }];
    }
    // A deliberately long list for the changed-files overflow contract (#510).
    // Keep the paths distinct and ordered so browser tests can scroll to the
    // final row rather than merely asserting an implementation detail.
    if (n === 10) {
      return Array.from({ length: 24 }, (_, index) => ({
        path: `src/generated/many-files/file-${String(index + 1).padStart(2, "0")}.ts`,
        status: index % 2 === 0 ? "M" : "A",
      }));
    }
    return [{ path: `src/file-${n}.ts`, status: n % 2 === 0 ? "M" : "A" }];
  },
  git_compare_commit_files: () => [
    { path: "src/compared.ts", status: "M" },
    { path: "src/introduced-in-comparison.ts", status: "A" },
  ],
  git_commit_file_diff: (args) => {
    // Deterministic tiny patch so E2E can assert the inline diff (#221).
    const filePath = args.filePath as string;
    return [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1,3 +1,3 @@",
      " unchanged line",
      "-old line",
      "+new line",
      "",
    ].join("\n");
  },
  git_compare_commit_file_diff: (args) => {
    const filePath = args.filePath as string;
    const baseOid = args.baseOid as string;
    const targetOid = args.targetOid as string;
    return [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -1 +1 @@",
      `-older ${baseOid.slice(0, 7)}`,
      `+newer ${targetOid.slice(0, 7)}`,
      "",
    ].join("\n");
  },
  git_stage: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    for (const p of paths) mockStagePath(p);
    return null;
  },
  git_unstage: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    for (const p of paths) mockUnstagePath(p);
    return null;
  },
  git_apply_patch: (args: Record<string, unknown>) => {
    const patch = String(args.patch ?? "");
    const action = args.action as "stage" | "unstage" | "discard";
    const path = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!path) throw new Error("patch is missing its target path");
    const hunkMatch = patch.match(/^@@ -(\d+)/m);
    if (!hunkMatch) throw new Error("patch is missing its hunk header");
    const hunk = Number(hunkMatch[1]);
    const state = hunkState(path);
    if (action === "stage") {
      state.staged.add(hunk);
      upsert(mockGit.staged, { path, old_path: null, status: "Modified" });
      // A partially staged file remains in Changes as well as Staged. Once
      // both mock hunks are staged, its worktree side is exhausted.
      if (state.staged.size >= 2) removeFrom(mockGit.changes, path);
    } else if (action === "unstage") {
      state.staged.delete(hunk);
      if (state.staged.size === 0) removeFrom(mockGit.staged, path);
      upsert(mockGit.changes, { path, old_path: null, status: "Modified" });
    } else {
      state.discarded.add(hunk);
    }
    return null;
  },
  git_discard: (args: Record<string, unknown>) => {
    const paths = (args.paths as string[]) ?? [];
    const options = (args.options as { force?: boolean } | null) ?? null;
    const force = options?.force ?? false;
    for (const p of paths) mockDiscardPath(p, force);
    return null;
  },
  git_commit: (args: Record<string, unknown>) => {
    const msg = (args.message as string) ?? "";
    const options = (args.options as { amend?: boolean } | null) ?? null;
    const amend = options?.amend ?? false;
    if (msg.trim().length === 0 && !amend) {
      throw new Error("commit message cannot be empty");
    }
    // Unresolved conflicts block the commit entirely (mirrors the backend
    // `index.has_conflicts()` guard). Resolving = staging moves the entry out
    // of `merge`, at which point committing is allowed.
    if (mockGit.merge.length > 0) {
      throw new Error(`resolve ${mockGit.merge.length} conflicted file(s) before committing`);
    }
    const committed = mockGit.staged.map((e) => e.path);
    if (committed.length === 0 && !amend) {
      throw new Error("nothing to commit");
    }
    // Only staged (resolved) entries become part of the commit; the working
    // tree (changes/untracked) is left untouched, mirroring the real backend.
    // A completed commit also ends any in-progress operation.
    mockGit.staged = [];
    mockGit.op_state = "clean";
    const effectiveMessage =
      msg.trim().length === 0 && amend
        ? mockGitCommits[mockGitCommits.length - 1]?.message ?? ""
        : msg;
    if (amend && mockGitCommits.length > 0) {
      const prev = mockGitCommits[mockGitCommits.length - 1];
      prev.message = effectiveMessage;
      prev.files = Array.from(new Set([...prev.files, ...committed]));
      return { commit_id: prev.commit_id, summary: effectiveMessage.split("\n")[0] };
    }
    // A fresh commit advances HEAD/main and weaves a new row onto the graph so
    // the git-graph view reflects it after its reload (#466) — mirroring the
    // real backend, which `git_log` re-reads. mockAppendCommit returns the OID.
    const commit_id = mockAppendCommit(effectiveMessage.split("\n")[0]);
    mockGitCommits.push({ message: effectiveMessage, amend, files: committed, commit_id });
    return { commit_id, summary: effectiveMessage.split("\n")[0] };
  },
  git_diff: (args: Record<string, unknown>) => {
    const p = args.path as string;
    const staged = !!((args.options as { staged?: boolean } | null)?.staged);
    // Binary files show a marker rather than a textual hunk.
    if (/\.(png|jpg|jpeg|gif|webp|ico|bin|exe|zip|pdf)$/i.test(p)) {
      return [
        `diff --git a/${p} b/${p}`,
        "index 0000000..1111111",
        `Binary files a/${p} and b/${p} differ`,
        "",
      ].join("\n");
    }
    // Two distant hunks make partial stage/unstage/discard observable in the
    // running browser, matching the real patch command's semantics.
    const state = hunkState(p);
    const visible = (hunk: number) => staged ? state.staged.has(hunk) : !state.staged.has(hunk) && !state.discarded.has(hunk);
    const lines = [
      `diff --git a/${p} b/${p}`,
      "index 1111111..2222222 100644",
      `--- a/${p}`,
      `+++ b/${p}`,
    ];
    if (visible(1)) lines.push("@@ -1,3 +1,3 @@", " import { useState } from \"react\";", "-export function App() { return null; }", "+export function App() { return <div>first hunk</div>; }");
    if (visible(10)) lines.push("@@ -10,3 +10,3 @@", " export const VERSION = \"1.0\";", "-export const FLAG = false;", "+export const FLAG = true;");
    return [...lines, ""].join("\n");
  },
  file_recovery_subscribe: ({ updates }) => {
    mockRecoveryReceive = updates as (snapshot: unknown) => void;
    return mockRecoverySnapshot();
  },
  file_recovery_unsubscribe: () => {
    mockRecoveryReceive = null;
    return null;
  },
  file_recovery_list: () => mockRecoverySnapshot(),
  file_recovery_retire_eligible: () => {
    const before = mockRecoveryRecords.length;
    mockRecoveryRecords = mockRecoveryRecords.filter((record) => !record.autoEligible);
    if (mockRecoveryRecords.length !== before) mockRecoveryRevision += 1n;
    mockRecoveryError = null;
    return mockRecoveryPublish();
  },
  file_recovery_inspect: ({ id }) => {
    const record = mockRecoveryRecords.find((candidate) => candidate.id === id);
    if (!record) throw new Error("Recovery operation is no longer available");
    record.generation += 1n;
    mockRecoveryRevision += 1n;
    if (record.stranded) {
      record.status = "attention";
      record.message = MOCK_STRANDED_MESSAGE;
      record.actions = ["discard", "release"];
    } else {
      record.status = "retained";
      record.message = "Retained recovery files can be discarded";
      record.actions = ["discard"];
    }
    record.retainedBytes ??= "1073741824";
    mockRecoveryError = null;
    return mockRecoveryPublish();
  },
  file_recovery_resolve: ({ id, generation, choice }) => {
    const record = mockRecoveryRecords.find((candidate) => candidate.id === id);
    if (!record || record.generation.toString() !== generation) {
      throw new Error("Recovery operation changed; inspect it again before acting");
    }
    record.generation += 1n;
    mockRecoveryRevision += 1n;
    if (choice === "release" && !record.stranded) {
      mockRecoveryError = "Only a move whose discard stopped before finishing can be forgotten";
      return mockRecoveryPublish();
    }
    if (choice === "discard" && record.stranded) {
      // The committed discard stops again; it can still be retried or forgotten.
      record.status = "attention";
      record.actions = ["discard", "release"];
      record.message = MOCK_STRANDED_MESSAGE;
      mockRecoveryError = `Could not remove ${record.retainedPath}: Read-only file system (os error 30)`;
      return mockRecoveryPublish();
    }
    if (choice === "discard" && record.cleanupFails) {
      // Retained-evidence failure: nothing is removed and the record stays.
      record.status = "attention";
      record.actions = [];
      record.message = "Retained recovery files could not be removed; every file is preserved";
      mockRecoveryError = `Could not remove ${record.retainedPath}: the location is unavailable`;
      return mockRecoveryPublish();
    }
    mockRecoveryRecords = mockRecoveryRecords.filter((candidate) => candidate.id !== id);
    mockRecoveryError = null;
    return mockRecoveryPublish();
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
  git_watch_repo: ({ repoPath }) => ({ id: crypto.randomUUID(), repoRoot: repoPath }),
  git_unwatch_repo: () => null,

  // In-progress operation abort / continue (#294): clear the mock operation
  // state so the next git_status reports a clean tree.
  git_merge_abort: () => {
    mockClearOperation();
    return null;
  },
  git_rebase_abort: () => {
    mockClearOperation();
    return null;
  },
  git_rebase_continue: () => {
    // Continue only succeeds once conflicts are resolved (staged).
    if (mockGit.merge.length > 0) {
      throw new Error("resolve conflicts before continuing the rebase");
    }
    mockClearOperation();
    return null;
  },
  git_cherry_pick_abort: () => {
    mockClearOperation();
    return null;
  },
  git_revert_abort: () => {
    mockClearOperation();
    return null;
  },
  git_fetch: (args) => {
    return holdGitNetworkOperation("git_fetch", args);
  },
  cancel_git_network_operation: (args) => {
    if (
      pendingGitNetworkOperation?.taskId === Number(args.taskId) &&
      pendingGitNetworkOperation.cancellable
    ) {
      const operation = pendingGitNetworkOperation;
      pendingGitNetworkOperation = undefined;
      operation.reject(new Error("git network operation cancelled"));
    } else if (pendingGitNetworkOperation?.taskId === Number(args.taskId)) {
      // The local fast-forward has already begun. Model delayed phase-event
      // delivery after a stale Cancel click without rejecting the pull.
      pendingGitNetworkOperation.onPhase?.({
        taskId: pendingGitNetworkOperation.taskId,
        cancellable: false,
      });
    }
    return null;
  },
  git_pull: (args) => {
    const boundary = holdGitPullAtFastForwardBoundary(args);
    if (boundary) return boundary;
    const held = holdGitNetworkOperation("git_pull", args);
    if (held) return held;
    const before_oid = mockHeadOid();
    const branch =
      mockDetached
        ? null
        : (MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
          null;
    const after_oid = mockAppendCommit("Pull from upstream");
    return { kind: "head_move", operation: "pull", branch, before_oid, after_oid };
  },
  // Mock: pretend 'hotfix' is 2 behind its remote so the pull offer shows.
  git_branch_behind_upstream: (args: Record<string, unknown>) =>
    args.name === "hotfix" ? 2 : args.name === "main" ? 0 : null,
  git_branch_authors: () => [
    { name: "main", author: "Alice Coder", remote: false },
    { name: "hotfix", author: "Alice Coder", remote: false },
    { name: "experiment", author: "Bob Dev", remote: false },
    { name: "feature", author: "Alice Coder", remote: false },
    { name: "origin/main", author: "Alice Coder", remote: true },
    { name: "origin/hotfix", author: "Alice Coder", remote: true },
    { name: "origin/legacy-import", author: "Bob Dev", remote: true },
  ],
  git_delete_branch: (args: Record<string, unknown>) => {
    const name = (args.name as string) ?? "";
    const target = mockRemoveRef(name, "LocalBranch");
    if (!target) throw new Error(`branch '${name}' does not exist`);
    return { kind: "branch_delete", name, target };
  },
  git_delete_tag: (args: Record<string, unknown>) => {
    const name = (args.name as string) ?? "";
    const target = mockRemoveRef(name, "Tag");
    if (!target) throw new Error(`tag '${name}' does not exist`);
    return { kind: "tag_delete", name, target };
  },
  git_rename_branch: (args: Record<string, unknown>) => {
    const old_name = (args.oldName as string) ?? "";
    const new_name = (args.newName as string) ?? "";
    const target = mockRemoveRef(old_name, "LocalBranch");
    if (!target) throw new Error(`branch '${old_name}' does not exist`);
    if (mockFindRef(new_name, "LocalBranch")) {
      mockAddRef(old_name, "LocalBranch", target);
      throw new Error(`branch '${new_name}' already exists`);
    }
    mockAddRef(new_name, "LocalBranch", target);
    return { kind: "branch_rename", old_name, new_name, target };
  },
  git_undo: (args: Record<string, unknown>) => {
    const action = args.action as {
      kind: string;
      name?: string;
      target?: string;
      old_name?: string;
      new_name?: string;
      branch?: string | null;
      before_oid?: string;
      after_oid?: string;
    };
    if (action.kind === "branch_delete") {
      if (mockFindRef(action.name!, "LocalBranch")) {
        throw new Error(`branch '${action.name}' already exists; undo is no longer safe`);
      }
      mockAddRef(action.name!, "LocalBranch", action.target!);
      return null;
    }
    if (action.kind === "tag_delete") {
      if (mockFindRef(action.name!, "Tag")) {
        throw new Error(`tag '${action.name}' already exists; undo is no longer safe`);
      }
      mockAddRef(action.name!, "Tag", action.target!);
      return null;
    }
    if (action.kind === "branch_rename") {
      if (
        mockFindRef(action.old_name!, "LocalBranch") ||
        mockFindRef(action.new_name!, "LocalBranch") !== action.target
      ) {
        throw new Error("branch state changed; undo is no longer safe");
      }
      mockRemoveRef(action.new_name!, "LocalBranch");
      mockAddRef(action.old_name!, "LocalBranch", action.target!);
      return null;
    }
    if (action.kind === "head_move") {
      if (mockHeadOid() !== action.after_oid) {
        throw new Error("HEAD moved since the operation; undo is no longer safe");
      }
      if (action.branch) mockMoveRef(action.branch, "LocalBranch", action.before_oid!);
      mockMoveHead(action.before_oid!);
      return null;
    }
    throw new Error("unknown git undo action");
  },
  git_delete_remote_branch: (args) =>
    holdGitNetworkOperation("git_delete_remote_branch", args),

  // Tracking checkout (#432): create a local branch tracking <remote>/<name>
  // at the remote branch's current tip, then move HEAD onto it.
  git_checkout_tracking: (args: Record<string, unknown>) => {
    const remote = (args.remote as string) ?? "";
    const name = ((args.name as string) ?? "").trim();
    if (name.length === 0) throw new Error("branch name must not be empty");
    // Already-existing local branch → plain checkout.
    const existing = mockResolveTarget(name);
    if (existing) {
      mockCheckout(existing, name);
      return null;
    }
    const oid = mockResolveTarget(`${remote}/${name}`);
    if (!oid) throw new Error(`no remote branch '${remote}/${name}'`);
    mockAddRef(name, "LocalBranch", oid);
    mockCheckout(oid, name);
    return null;
  },

  // F5-sync (#432): deterministic result so the divergence toast and the
  // fast-forward path can be exercised in E2E. Pretend `experiment` diverged
  // and `hotfix` fast-forwarded.
  git_sync_local_branches: () => ({
    fast_forwarded: ["hotfix"],
    diverged: ["experiment"],
    skipped: [],
  }),

  // ----- Git history / commit graph (#57) -----

  git_log: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
    // Synthetic load-repo: deterministic N-commit history, paginated by
    // skip/cursor/limit exactly like the real backend.
    const loadIdx = loadRepoIndex(repoPath);
    if (loadIdx !== null) {
      const opts =
        (args.options as { skip?: number; limit?: number; cursor?: string } | null) ?? {};
      const all = getSyntheticGraph(loadIdx, loadRepoCommitCount()).commits;
      const skip = Math.max(0, opts.skip ?? 0);
      const limit = Math.max(1, opts.limit ?? 500);
      let start = skip;
      if (opts.cursor) {
        const idx = all.findIndex((c) => c.oid === opts.cursor);
        start = idx >= 0 ? idx + 1 : all.length; // unknown cursor → empty page
      }
      const page = all.slice(start, start + limit);
      const refs = getSyntheticGraph(loadIdx, loadRepoCommitCount()).refs;
      return {
        commits: page,
        refs,
        has_more: start + limit < all.length,
        next_cursor: page.length > 0 ? page[page.length - 1].oid : null,
        head_branch: "main",
        detached: false,
      };
    }
    if (!repoPath.startsWith("/home/user/Documents/project")) {
      return {
        commits: [],
        refs: {},
        has_more: false,
        next_cursor: null,
        head_branch: null,
        detached: false,
      };
    }
    const options =
      (args.options as {
        skip?: number;
        limit?: number;
        branches?: string[];
        exclude_branches?: string[];
        cursor?: string;
        file_path?: string;
      } | null) ?? {};
    const skip = Math.max(0, options.skip ?? 0);
    const limit = Math.max(1, options.limit ?? 500);

    let all = mockCommitGraph();
    // Branch filter (#342): mirror the backend's seeded revwalk — keep only
    // commits reachable from the selected branch tips; stash rows survive
    // only when their base commit does. An EMPTY selection seeds nothing and
    // yields no commits (#413), exactly like the backend.
    //
    // `exclude_branches` (#515) is subtractive and applies to BOTH seed sets:
    // with no selection the seeds are HEAD + every branch minus the excluded
    // ones, so dropping a remote-only branch never unseeds HEAD.
    const excluded = new Set(options.exclude_branches ?? []);
    if (options.branches || excluded.size > 0) {
      const tips = new Map<string, string>();
      for (const [oid, refList] of Object.entries(MOCK_GRAPH_REFS)) {
        for (const r of refList) {
          if (r.kind === "LocalBranch" || r.kind === "RemoteBranch") tips.set(r.name, oid);
        }
      }
      const seeds = options.branches ?? [...tips.keys()];
      const byOid = new Map(all.filter((c) => !("stash" in c)).map((c) => [c.oid, c]));
      const reachable = new Set<string>();
      const queue = seeds
        .filter((n) => !excluded.has(n))
        .map((n) => tips.get(n))
        .filter((o): o is string => o !== undefined);
      // HEAD is always seeded when there is no explicit selection.
      if (!options.branches) queue.push(mockHeadOid());
      while (queue.length > 0) {
        const oid = queue.pop()!;
        if (reachable.has(oid)) continue;
        reachable.add(oid);
        const c = byOid.get(oid);
        if (c) queue.push(...c.parents);
      }
      all = all.filter((c) =>
        "stash" in c ? reachable.has(c.parents[0]) : reachable.has(c.oid),
      );
    }
    if (options.file_path?.trim()) {
      const path = options.file_path.trim();
      all = all.filter((commit) => {
        if ("stash" in commit) return false;
        const n = parseInt(commit.oid.slice(0, 4), 16);
        if (n === 12) return path === "src/feature-x.ts" || path === "src/index.ts" || path === "src/index.css";
        if (n === 11) return path === MOCK_LONG_COMMIT_FILE_PATH;
        return path === `src/file-${n}.ts`;
      });
    }
    // Cursor resume (#431): mirror the backend — discard up to and including
    // the cursor OID (a real commit), then take `limit`. Falls back to `skip`
    // when no cursor is given (filtered queries).
    let start = skip;
    if (options.cursor) {
      const idx = all.findIndex((c) => !("stash" in c) && c.oid === options.cursor);
      start = idx >= 0 ? idx + 1 : all.length; // unknown cursor → empty page
    }
    const page = all.slice(start, start + limit);
    const hasMore = start + limit < all.length;
    // next_cursor is the last REAL commit (never a woven stash row).
    let nextCursor: string | null = null;
    for (let i = page.length - 1; i >= 0; i--) {
      if (!("stash" in page[i])) {
        nextCursor = page[i].oid;
        break;
      }
    }
    // Checked-out branch: the first local branch decorating HEAD's commit —
    // matches the convention used by the mutating mocks (#433 highlight).
    const headOid = mockHeadOid();
    // Detached HEAD has no symbolic target even when branches decorate the
    // same commit (#524).
    const headBranch = mockDetached
      ? null
      : ((MOCK_GRAPH_REFS[headOid] ?? []).find((r) => r.kind === "LocalBranch")?.name ?? null);
    // Test hook (like `latency`/`failures`): force `has_more` so the infinite-
    // scroll loading row (#433) is reachable/observable with a small history.
    const forceHasMore = getMockControl().graphForceHasMore === true;
    return {
      commits: page,
      refs: MOCK_GRAPH_REFS,
      has_more: hasMore || forceHasMore,
      next_cursor: nextCursor,
      head_branch: headBranch,
      detached: mockDetached,
    };
  },

  git_refs: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
    const loadIdx = loadRepoIndex(repoPath);
    if (loadIdx !== null) {
      return syntheticRefs(loadIdx, loadRepoCommitCount());
    }
    if (!repoPath.startsWith("/home/user/Documents/project")) {
      return {
        local_branches: [],
        remote_branches: [],
        tags: [],
        head: null,
        head_branch: null,
        detached: false,
      };
    }
    // Tips mirror MOCK_GRAPH_REFS (the git_log decorations) so the branch
    // filter's list and the graph's chips can't drift (#342).
    const local_branches: Array<{ name: string; target: string }> = [];
    const remote_branches: Array<{ name: string; target: string }> = [];
    const tags: Array<{ name: string; target: string }> = [];
    for (const [target, refList] of Object.entries(MOCK_GRAPH_REFS)) {
      for (const ref of refList) {
        if (ref.kind === "LocalBranch") local_branches.push({ name: ref.name, target });
        else if (ref.kind === "RemoteBranch") remote_branches.push({ name: ref.name, target });
        else if (ref.kind === "Tag") tags.push({ name: ref.name, target });
      }
    }
    return {
      local_branches,
      remote_branches,
      tags,
      // HEAD tracks the mutating checkout mocks, so the refs payload agrees
      // with git_log's about the detached state (#524).
      head: mockHeadOid(),
      head_branch: mockDetached
        ? null
        : ((MOCK_GRAPH_REFS[mockHeadOid()] ?? []).find((r) => r.kind === "LocalBranch")?.name ??
          null),
      detached: mockDetached,
    };
  },

  // Open GitHub PRs (#448/#459): synthetic PRs on branches that exist in
  // MOCK_GRAPH_REFS so the graph's PR badges have something to render against
  // in e2e. #7 exercises a passing/approved/commented PR, #12 a failing draft
  // (draft styling wins over CI color), #15 the tokenless case (all status
  // fields null → plain purple badge, pending kept for label coverage).
  git_open_prs: (args: Record<string, unknown>) => {
    const repoRoot = (args.repoRoot as string) ?? "";
    if (!repoRoot.startsWith("/home/user/Documents/project")) return [];
    // Isolated graph fixture for #527's browser regression test. It is opt-in
    // by URL so the shared default graph keeps its established PR topology.
    const baseUpdateFixture = new URLSearchParams(window.location.search).has(
      "gitGraphBaseUpdateFixture",
    );
    return [
      ...(baseUpdateFixture
        ? [{
            number: 27,
            title: "Keep release branch current",
            headRef: "release",
            baseRef: "hotfix",
            baseRemote: "origin",
            htmlUrl: "https://github.com/mock/project/pull/27",
            draft: false,
            ciStatus: null,
            reviewDecision: null,
            commentCount: null,
          }]
        : []),
      {
        number: 7,
        title: "Add feature X",
        headRef: "feature",
        htmlUrl: "https://github.com/mock/project/pull/7",
        draft: false,
        ciStatus: "success",
        reviewDecision: "approved",
        commentCount: 3,
        body:
          "Implements feature X end to end.\n\n" +
          "- Adds the domain logic and its unit tests\n" +
          "- Wires the new command through the IPC layer\n" +
          "- Updates the mock backend so the UI can be exercised offline",
        comments: [
          {
            author: "octocat",
            createdAt: daysAgo(150),
            body: "Nice work! Left a couple of small notes on the diff.",
          },
          {
            author: "reviewer-bot",
            createdAt: daysAgo(35),
            body: "CI is green. Approving once the naming nit is addressed.",
          },
          {
            author: null,
            createdAt: daysAgo(5),
            body: "Thanks for the review — pushed a fixup.",
          },
        ],
        reviewThreads: [
          {
            resolved: true,
            comments: [
              {
                author: "octocat",
                createdAt: daysAgo(120),
                body: "Please use the shared parser here.",
                path: "src/lib/parser.ts",
                line: 42,
              },
            ],
          },
          {
            resolved: false,
            comments: [
              {
                author: "reviewer-bot",
                createdAt: daysAgo(2),
                body: "Could this retain the previous error context?",
                path: "src/lib/parser.ts",
                line: 87,
              },
            ],
          },
        ],
      },
      {
        number: 12,
        title: "Experimental parser rewrite",
        headRef: "experiment",
        htmlUrl: "https://github.com/mock/project/pull/12",
        draft: true,
        ciStatus: "failure",
        reviewDecision: "changes_requested",
        commentCount: 0,
        // Draft PR with no description and no comments yet — exercises the
        // empty-body / zero-comment path.
        body: null,
        comments: [],
        reviewThreads: [],
      },
      {
        number: 15,
        title: "Hotfix login redirect",
        headRef: "hotfix",
        htmlUrl: "https://github.com/mock/project/pull/15",
        draft: false,
        ciStatus: "pending",
        reviewDecision: null,
        // Tokenless REST path: description present, comments count unknown.
        commentCount: null,
        body: "Restores the post-login redirect that regressed in 2.3.1.",
        comments: [],
        reviewThreads: null,
      },
    ];
  },

  git_failed_ci_checks: (args: Record<string, unknown>) => {
    if (args.prNumber !== 12) return [];
    return [{ name: "Unit tests", runId: 1201, jobId: 9001 }];
  },

  git_failed_ci_check_log: (args: Record<string, unknown>) => {
    const check = args.check as { name?: string; runId?: number; jobId?: number };
    if (check.runId !== 1201 || check.jobId !== 9001) throw new Error("Unknown CI check");
    return {
      checkName: check.name ?? "Unit tests",
      log: "tests/unit/parser.test.ts > parser rejects invalid input\nAssertionError: expected true to be false",
    };
  },

  // ----- Git graph mutating actions (VSCode Git Graph parity) -----

  git_checkout: (args: Record<string, unknown>) => {
    const target = (args.target as string) ?? "";
    const oid = mockResolveTarget(target);
    if (!oid) throw new Error(`pathspec '${target}' did not match any file(s) known to git`);
    // Only a local branch name reattaches HEAD; an OID, a tag or a remote
    // branch detaches it, like git (#524).
    mockCheckout(oid, mockIsLocalBranch(target) ? target : null);
    return null;
  },
  git_create_branch: (args: Record<string, unknown>) => {
    const name = ((args.name as string) ?? "").trim();
    const oid = (args.oid as string) ?? "";
    const checkout = Boolean(args.checkout);
    if (name.length === 0) throw new Error("branch name must not be empty");
    mockAddRef(name, "LocalBranch", oid);
    if (checkout) mockCheckout(oid, name);
    return null;
  },
  git_create_tag: (args: Record<string, unknown>) => {
    const name = ((args.name as string) ?? "").trim();
    const oid = (args.oid as string) ?? "";
    if (name.length === 0) throw new Error("tag name must not be empty");
    mockAddRef(name, "Tag", oid);
    return null;
  },
  git_cherry_pick: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const src = mockCommitGraph().find((c) => c.oid === oid);
    mockAppendCommit(src ? src.summary : "Cherry-picked commit");
    return null;
  },
  git_revert: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const src = mockCommitGraph().find((c) => c.oid === oid);
    mockAppendCommit(`Revert "${src ? src.summary : oid.slice(0, 7)}"`);
    return null;
  },
  git_merge: (args: Record<string, unknown>) => {
    const target = (args.target as string) ?? "";
    const before_oid = mockHeadOid();
    const branch =
      mockDetached
        ? null
        : (MOCK_GRAPH_REFS[before_oid] ?? []).find((ref) => ref.kind === "LocalBranch")?.name ??
          null;
    const after_oid = mockAppendCommit(`Merge ${target} into current branch`);
    return { kind: "head_move", operation: "merge", branch, before_oid, after_oid };
  },
  git_rebase: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    mockAppendCommit(`Rebased onto ${oid.slice(0, 7)}`);
    return null;
  },
  git_stash_apply: (args: Record<string, unknown>) => {
    const stash = (args.stash as string) ?? "";
    if (!mockCommitGraph().some((commit) => commit.stash === stash)) {
      throw new Error(`stash '${stash}' not found`);
    }
    return null;
  },
  git_stash_pop: (args: Record<string, unknown>) => {
    const stash = (args.stash as string) ?? "";
    const graph = mockCommitGraph();
    const index = graph.findIndex((commit) => commit.stash === stash);
    if (index < 0) throw new Error(`stash '${stash}' not found`);
    graph.splice(index, 1);
    return null;
  },
  git_reset: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const mode = (args.mode as string) ?? "mixed";
    if (!["soft", "mixed", "hard"].includes(mode)) {
      throw new Error(`invalid reset mode: ${mode}`);
    }
    // Move the branch HEAD is on (default main) and HEAD to the target commit.
    // A detached reset moves HEAD only (#524).
    const head = mockHeadOid();
    if (!mockDetached) {
      const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
      mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
    }
    mockMoveHead(oid);
    return null;
  },

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

  // ----- File-picker portal -----

  // Records the response so e2e tests can assert on the actual outcome.
  picker_respond: (args) => {
    localStorage.setItem(MOCK_LOCAL_KEYS.pickerResponse, JSON.stringify(args));
    return null;
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

  // ----- Window theming (no-op in mock) -----

  set_window_theme: () => {},

  // ----- Clipboard file operations (os-clipboard.ts) -----
  // In-memory clipboard so write → has → read round-trips in browser/E2E mode,
  // mirroring the real OS clipboard contract (write paths, then read them back).

  clipboard_publish: (args: Record<string, unknown>) => {
    // Browser tests admit Cut by default, as every native backend does when
    // it proves ownership (#877). Set this flag to exercise Cut refusal.
    if (args.operation === "cut" && localStorage.getItem(MOCK_LOCAL_KEYS.cutOwnershipUnavailable) === "1") {
      throw new Error("Cut requires native clipboard ownership; Copy is available here");
    }
    const entries = args.entries as Array<{ path: string }>;
    mockClipboardFiles = entries.map((entry) => entry.path);
    mockClipboardEntries = entries;
    mockClipboardOperation = args.operation as "copy" | "cut";
    mockClipboardRevision++;
    return { revision: mockClipboardRevision, entries, paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null };
  },
  clipboard_snapshot: () => ({
    revision: mockClipboardRevision, entries: mockClipboardEntries,
    paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null,
  }),
  clipboard_compare_and_clear: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || !mockClipboardEntries) return false;
    mockClipboardRevision++;
    mockClipboardEntries = null;
    mockClipboardOperation = null;
    return true;
  },
  clipboard_claim_cut: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || mockClipboardOperation !== "cut"
      || !mockClipboardEntries || mockClipboardLease === mockClipboardRevision) return false;
    mockClipboardLease = mockClipboardRevision;
    return true;
  },
  clipboard_release_cut: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || mockClipboardLease !== args.revision) return false;
    mockClipboardLease = null;
    return true;
  },
  clipboard_rekey: (args: Record<string, unknown>) => {
    if (args.revision !== mockClipboardRevision || !mockClipboardEntries) return null;
    const entries = mockClipboardEntries as Array<{ path: string }>;
    const index = entries.findIndex((entry) => entry.path === args.oldPath);
    if (index < 0) return null;
    mockClipboardEntries = entries.map((entry, at) => at === index ? args.entry : entry);
    mockClipboardFiles = (mockClipboardEntries as Array<{ path: string }>).map((entry) => entry.path);
    mockClipboardRevision++;
    return { revision: mockClipboardRevision, entries: mockClipboardEntries,
      paths: [...mockClipboardFiles], operation: mockClipboardOperation, mirrorError: null };
  },
  clipboard_read_text: () => localStorage.getItem(MOCK_LOCAL_KEYS.clipboardText) ?? "",

  clipboard_has_image: () =>
    localStorage.getItem(MOCK_LOCAL_KEYS.reportClipboardImage) === "1",

  clipboard_read_report_image: () => ({
    name: "Clipboard screenshot.png",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  }),

  // ----- Commands that launch external processes (no-op in mock) -----

  open_file_with: () => {},

  open_recycle_bin: () => {
    const error = localStorage.getItem(MOCK_LOCAL_KEYS.openRecycleBinError);
    if (error) throw new Error(error);
  },

  open_in_terminal: () => {},
  list_installed_terminals: () => ["ghostty", "kitty", "alacritty", "gnome-terminal", "xterm"],
  set_ffmpeg_path: () => {},

  set_as_wallpaper: () => {},

  // ----- Misc -----

  get_log_dir: () => "/tmp/tauri-explorer/logs",
  // Theme from Image (#203): deterministic palette; theme CSS goes into the
  // in-memory config store and is injected by the mocked list_user_themes.
  extract_palette: () => ["#1a2233", "#5de5d5", "#31425c", "#d98500", "#88a0c8", "#223044"],
  write_theme_file: (args) => {
    mockConfigFiles[`themes/${args.filename as string}`] = args.data as string;
    return undefined;
  },
  list_user_themes: () =>
    Object.entries(mockConfigFiles)
      .filter(([k]) => k.startsWith("themes/"))
      .map(([k, v]) => [k.slice("themes/".length), v]),

  get_app_info: () => ({ version: "0.0.0-mock", os: "linux", arch: "x86_64" }),

  // Mirrors the real backend: writes a PNG into `directory` and returns its
  // full path. Adds the entry to the mock fs so the pasted image shows up in
  // the directory listing. A deterministic filename keeps E2E assertions stable.
  clipboard_paste_image: (args: Record<string, unknown>) => {
    const directory = args.directory as string;
    const filename = "clipboard-image.png";
    const path = `${directory}/${filename}`;
    const entries = mockFiles[directory] || (mockFiles[directory] = []);
    if (!entries.some((e) => e.path === path)) {
      entries.push(file(filename, path, 4096));
    }
    return path;
  },

  start_nano_banana_job: () => 1,

  start_upscale_job: () => 1,

  // Deterministic fake filename suggestions so browser E2E exercises the picker
  // without a real model. Derives names from the original's extension.
  ai_suggest_destination: (args) => {
    const candidates = (args.candidates as string[]) ?? [];
    const count = Math.max(1, Math.min(5, (args.count as number) ?? 3));
    // Deterministic mock: the first N candidates, so E2E can assert exact rows.
    return candidates.slice(0, count);
  },
  ai_suggest_filenames: (args) => {
    const originalName = (args.originalName as string) ?? "file";
    const dot = originalName.lastIndexOf(".");
    const ext = dot > 0 ? originalName.slice(dot) : "";
    const count = Math.max(1, Math.min(5, (args.count as number) ?? 3));
    const bases = ["meeting-notes", "2024-notes", "summary", "draft", "final"];
    return bases.slice(0, count).map((b) => `${b}${ext}`);
  },
};

/**
 * localStorage key an e2e/unit test can set to pre-seed the mock config store
 * with `{ [filename]: contents }` before the app boots. Re-exported here
 * (rather than requiring every caller to import `MOCK_LOCAL_KEYS` just for
 * this one key) since `tests/state/settings-migration.test.ts` already
 * imports it from this module; the value itself lives in
 * `MOCK_LOCAL_KEYS.configSeed` alongside every other mock localStorage key.
 *
 * The mock config store is in-memory and starts empty, so without this there
 * is no way to present the app with an EXISTING settings.json — every mock
 * run looks like a fresh install. That blind spot is exactly what hid #506:
 * a settings migration only runs against the durable store of record, which
 * the mock could never populate.
 */
export const MOCK_CONFIG_SEED_KEY = MOCK_LOCAL_KEYS.configSeed;

/** In-memory config file store for mock mode, optionally test-seeded. */
const mockConfigFiles: Record<string, string> = loadMockConfigSeed();

function loadMockConfigSeed(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(MOCK_CONFIG_SEED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      ) as [string, string][],
    );
  } catch {
    return {};
  }
}

/**
 * Mock invoke function for browser-based testing.
 */
/** Match the native application boundary; inverse execution calls the raw
 * fixture command below so it cannot recursively record forward history. */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (cmd === "copy_entries" || cmd === "move_entries") {
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
            ? await invokeMockCommand<FileMutationReceipt>("move_entry", { source, destDir, overwrite: decision?.choice === "overwrite" })
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
  const result = await invokeMockCommand<unknown>(cmd, args);
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
  if (["compress_to_zip", "extract_archive"].includes(cmd)) {
    // Archive operations mutate but have no inverse yet, so they advance
    // history with no undoable action (which discards the redo stack).
    return { result, history: mockFileHistory.push(null).summary } as T;
  }
  if (["create_directory", "create_empty_file", "rename_entry", "write_text_file", "create_symlink", "move_entry"].includes(cmd)) {
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

async function invokeMockCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (typeof window !== "undefined") {
    const control = getMockControl();
    control.invokeCounts ??= {};
    control.invokeCounts[cmd] = (control.invokeCounts[cmd] ?? 0) + 1;
  }

  await waitForMockLatency(cmd);

  // Reject the way the real backend does: Tauri serializes AppError as
  // { kind, message } (src-tauri/src/error.rs), not as an Error.
  const failure = getMockControl().failures?.[cmd];
  if (failure) throw { kind: "other", message: failure };

  const handler = mockCommands[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler(args || {}) as T;
}

async function waitForMockLatency(cmd: string): Promise<void> {
  // Add small delay to simulate async operation.
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Per-command extra latency, settable from E2E tests / the console
  // (window.__mockControl.latency = { git_status: 2000 }) or via URL for
  // fetches that fire during boot (?mockLatency=git_status:2000,foo:500),
  // to make transient loading states observable and assertable (#271).
  const control = getMockControl();
  if (!control.latency && typeof location !== "undefined") {
    control.latency = {};
    const param = new URLSearchParams(location.search).get("mockLatency");
    for (const pair of param?.split(",") ?? []) {
      const [name, ms] = pair.split(":");
      if (name && Number(ms) > 0) control.latency[name] = Number(ms);
    }
  }
  const extraLatency = control.latency?.[cmd];
  if (extraLatency) await new Promise((resolve) => setTimeout(resolve, extraLatency));
}

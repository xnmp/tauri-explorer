/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { selectPreviewImages } from "$lib/domain/folder-preview";
import { parentDir, basename } from "$lib/domain/path";
import { emitWatcherGitChange } from "$lib/state/git-refresh";
import type { GitFileEntry, GitStatusCode, GitStatusSummary, GitOpState } from "$lib/api/files";

// Check if we're running in Tauri v2
// Note: Tauri v2 uses __TAURI_INTERNALS__, not __TAURI__ (v1)
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Deterministic, varied timestamps: each created entry gets a distinct
// modified time (1h apart from a fixed base) so sort-by-modified is testable.
const TIMESTAMP_BASE = Date.UTC(2024, 0, 1, 12, 0, 0);
const TIMESTAMP_STEP_MS = 60 * 60 * 1000;
let timestampSeq = 0;
function nextTimestamp(): string {
  return new Date(TIMESTAMP_BASE + timestampSeq++ * TIMESTAMP_STEP_MS).toISOString();
}

// Helper to create mock file entry
function file(name: string, path: string, size: number): FileEntry {
  return { name, path, kind: "file", size, modified: nextTimestamp() };
}

// Ground-truth emptiness for mock directories that have no children keyed in
// `mockFiles` (e.g. a seeded-empty folder). Listings deliberately omit is_empty
// to mirror the backend (#129); the frontend resolves it via is_directory_empty,
// which consults this map for such folders.
const mockDirEmpty: Record<string, boolean> = {};

function dir(name: string, path: string, is_empty?: boolean): FileEntry {
  if (is_empty !== undefined) mockDirEmpty[path] = is_empty;
  // is_empty is intentionally absent from the listing contract (#129).
  return { name, path, kind: "directory", size: 0, modified: nextTimestamp() };
}

// Mock file system structure
const mockFiles: Record<string, FileEntry[]> = {
  // Matches get_log_dir so "Open Logs Folder" (#197) is navigable in e2e.
  "/tmp": [dir("tauri-explorer", "/tmp/tauri-explorer")],
  "/tmp/tauri-explorer": [dir("logs", "/tmp/tauri-explorer/logs")],
  "/tmp/tauri-explorer/logs": [file("tauri-explorer.log", "/tmp/tauri-explorer/logs/tauri-explorer.log", 2048)],
  "/home": [
    dir("user", "/home/user"),
  ],
  "/home/user": [
    dir("Documents", "/home/user/Documents", false),
    dir("Downloads", "/home/user/Downloads", false),
    dir("Pictures", "/home/user/Pictures", false),
    dir("Music", "/home/user/Music", false),
    dir("Videos", "/home/user/Videos", false),
    dir("Archive", "/home/user/Archive", true),
    dir(".config", "/home/user/.config", false),
    file("readme.txt", "/home/user/readme.txt", 1024),
    file("notes.md", "/home/user/notes.md", 2048),
  ],
  "/home/user/Archive": [],
  // Removable drive contents — lets the browser mock navigate onto a removable
  // drive so the "removable drive removed" state can be exercised.
  "/media/user/USB_DRIVE": [
    dir("Backups", "/media/user/USB_DRIVE/Backups"),
    file("photo.jpg", "/media/user/USB_DRIVE/photo.jpg", 1048576),
    file("notes.txt", "/media/user/USB_DRIVE/notes.txt", 2048),
  ],
  "/media/user/USB_DRIVE/Backups": [
    file("backup-2024.zip", "/media/user/USB_DRIVE/Backups/backup-2024.zip", 8388608),
  ],
  // Google Drive File Stream mount — browsable so the breadcrumb's Google-mark
  // anchor (which collapses the mount crumb) can be exercised.
  "/media/user/GoogleDrive": [
    dir("My Drive", "/media/user/GoogleDrive/My Drive"),
  ],
  "/media/user/GoogleDrive/My Drive": [
    file("doc.gdoc", "/media/user/GoogleDrive/My Drive/doc.gdoc", 1024),
  ],
  "/home/user/Documents": [
    dir("project", "/home/user/Documents/project"),
    file("report.pdf", "/home/user/Documents/report.pdf", 102400),
    file("budget.xlsx", "/home/user/Documents/budget.xlsx", 51200),
    file("presentation.pptx", "/home/user/Documents/presentation.pptx", 204800),
    file("notes.md", "/home/user/Documents/notes.md", 4096),
  ],
  "/home/user/Downloads": [
    dir("wrapper", "/home/user/Downloads/wrapper", false),
    file("archive.zip", "/home/user/Downloads/archive.zip", 1048576),
    file("bundle.zip", "/home/user/Downloads/bundle.zip", 2097152),
    file("installer.exe", "/home/user/Downloads/installer.exe", 5242880),
    file("image.png", "/home/user/Downloads/image.png", 524288),
    // Hidden by default (#160); visible only with show-hidden on.
    file("desktop.ini", "/home/user/Downloads/desktop.ini", 128),
  ],
  // A chain of single-child folders: wrapper → payload → inner → {real content}.
  // Previewing "wrapper" descends through the chain and shows inner's contents.
  "/home/user/Downloads/wrapper": [
    dir("payload", "/home/user/Downloads/wrapper/payload", false),
  ],
  "/home/user/Downloads/wrapper/payload": [
    dir("inner", "/home/user/Downloads/wrapper/payload/inner", false),
  ],
  "/home/user/Downloads/wrapper/payload/inner": [
    dir("assets", "/home/user/Downloads/wrapper/payload/inner/assets"),
    file("app.js", "/home/user/Downloads/wrapper/payload/inner/app.js", 1024),
    file("style.css", "/home/user/Downloads/wrapper/payload/inner/style.css", 512),
  ],
  "/home/user/Pictures": [
    dir("vacation", "/home/user/Pictures/vacation"),
    file("photo1.jpg", "/home/user/Pictures/photo1.jpg", 2097152),
    file("photo2.jpg", "/home/user/Pictures/photo2.jpg", 1572864),
    file("screenshot.png", "/home/user/Pictures/screenshot.png", 262144),
  ],
  "/home/user/Pictures/vacation": [
    file("beach.jpg", "/home/user/Pictures/vacation/beach.jpg", 3145728),
    file("sunset.png", "/home/user/Pictures/vacation/sunset.png", 2621440),
    file("itinerary.txt", "/home/user/Pictures/vacation/itinerary.txt", 1024),
  ],
  "/home/user/Music": [
    dir("playlist", "/home/user/Music/playlist"),
    file("song1.mp3", "/home/user/Music/song1.mp3", 4194304),
    file("song2.mp3", "/home/user/Music/song2.mp3", 3670016),
  ],
  "/home/user/Videos": [
    file("recording.mp4", "/home/user/Videos/recording.mp4", 52428800),
    file("tutorial.mkv", "/home/user/Videos/tutorial.mkv", 104857600),
  ],
  "/home/user/Documents/project": [
    dir("src", "/home/user/Documents/project/src"),
    dir("tests", "/home/user/Documents/project/tests"),
    dir("docs", "/home/user/Documents/project/docs"),
    dir("scripts", "/home/user/Documents/project/scripts"),
    dir("config", "/home/user/Documents/project/config"),
    dir("assets", "/home/user/Documents/project/assets"),
    dir("lib", "/home/user/Documents/project/lib"),
    file("package.json", "/home/user/Documents/project/package.json", 512),
    file("README.md", "/home/user/Documents/project/README.md", 4096),
    file("tsconfig.json", "/home/user/Documents/project/tsconfig.json", 256),
    file("index.ts", "/home/user/Documents/project/index.ts", 180),
    file("main.py", "/home/user/Documents/project/main.py", 120),
    file(".gitignore", "/home/user/Documents/project/.gitignore", 64),
    file("Makefile", "/home/user/Documents/project/Makefile", 800),
    file("Dockerfile", "/home/user/Documents/project/Dockerfile", 350),
    file("docker-compose.yml", "/home/user/Documents/project/docker-compose.yml", 420),
    file("jest.config.js", "/home/user/Documents/project/jest.config.js", 200),
    file("babel.config.js", "/home/user/Documents/project/babel.config.js", 150),
    file(".env.example", "/home/user/Documents/project/.env.example", 100),
    file("LICENSE", "/home/user/Documents/project/LICENSE", 1100),
    file("CHANGELOG.md", "/home/user/Documents/project/CHANGELOG.md", 6200),
  ],
  "/home/user/Documents/project/src": [
    dir("components", "/home/user/Documents/project/src/components"),
    dir("utils", "/home/user/Documents/project/src/utils"),
    dir("hooks", "/home/user/Documents/project/src/hooks"),
    dir("services", "/home/user/Documents/project/src/services"),
    dir("types", "/home/user/Documents/project/src/types"),
    dir("styles", "/home/user/Documents/project/src/styles"),
    file("App.tsx", "/home/user/Documents/project/src/App.tsx", 2400),
    file("main.tsx", "/home/user/Documents/project/src/main.tsx", 500),
    file("index.css", "/home/user/Documents/project/src/index.css", 1200),
    file("vite-env.d.ts", "/home/user/Documents/project/src/vite-env.d.ts", 80),
    file("router.tsx", "/home/user/Documents/project/src/router.tsx", 1800),
    file("constants.ts", "/home/user/Documents/project/src/constants.ts", 600),
  ],
  "/home/user/Documents/project/src/components": [
    dir("Button", "/home/user/Documents/project/src/components/Button"),
    dir("Modal", "/home/user/Documents/project/src/components/Modal"),
    dir("Sidebar", "/home/user/Documents/project/src/components/Sidebar"),
    file("Header.tsx", "/home/user/Documents/project/src/components/Header.tsx", 1800),
    file("Footer.tsx", "/home/user/Documents/project/src/components/Footer.tsx", 900),
    file("Layout.tsx", "/home/user/Documents/project/src/components/Layout.tsx", 1200),
    file("ErrorBoundary.tsx", "/home/user/Documents/project/src/components/ErrorBoundary.tsx", 700),
    file("Loading.tsx", "/home/user/Documents/project/src/components/Loading.tsx", 400),
    file("Avatar.tsx", "/home/user/Documents/project/src/components/Avatar.tsx", 600),
    file("Badge.tsx", "/home/user/Documents/project/src/components/Badge.tsx", 350),
    file("Card.tsx", "/home/user/Documents/project/src/components/Card.tsx", 550),
    file("Tooltip.tsx", "/home/user/Documents/project/src/components/Tooltip.tsx", 800),
    file("Dropdown.tsx", "/home/user/Documents/project/src/components/Dropdown.tsx", 1100),
    file("index.ts", "/home/user/Documents/project/src/components/index.ts", 300),
  ],
  "/home/user/Documents/project/src/components/Button": [
    file("Button.tsx", "/home/user/Documents/project/src/components/Button/Button.tsx", 900),
    file("Button.test.tsx", "/home/user/Documents/project/src/components/Button/Button.test.tsx", 1200),
    file("Button.module.css", "/home/user/Documents/project/src/components/Button/Button.module.css", 400),
    file("index.ts", "/home/user/Documents/project/src/components/Button/index.ts", 60),
  ],
  "/home/user/Documents/project/src/components/Modal": [
    file("Modal.tsx", "/home/user/Documents/project/src/components/Modal/Modal.tsx", 1400),
    file("Modal.test.tsx", "/home/user/Documents/project/src/components/Modal/Modal.test.tsx", 1600),
    file("Modal.module.css", "/home/user/Documents/project/src/components/Modal/Modal.module.css", 600),
    file("index.ts", "/home/user/Documents/project/src/components/Modal/index.ts", 60),
  ],
  "/home/user/Documents/project/src/components/Sidebar": [
    file("Sidebar.tsx", "/home/user/Documents/project/src/components/Sidebar/Sidebar.tsx", 2200),
    file("Sidebar.test.tsx", "/home/user/Documents/project/src/components/Sidebar/Sidebar.test.tsx", 1800),
    file("Sidebar.module.css", "/home/user/Documents/project/src/components/Sidebar/Sidebar.module.css", 700),
    file("SidebarItem.tsx", "/home/user/Documents/project/src/components/Sidebar/SidebarItem.tsx", 500),
    file("index.ts", "/home/user/Documents/project/src/components/Sidebar/index.ts", 80),
  ],
  "/home/user/Documents/project/src/utils": [
    file("format.ts", "/home/user/Documents/project/src/utils/format.ts", 800),
    file("validate.ts", "/home/user/Documents/project/src/utils/validate.ts", 1200),
    file("helpers.ts", "/home/user/Documents/project/src/utils/helpers.ts", 600),
    file("debounce.ts", "/home/user/Documents/project/src/utils/debounce.ts", 300),
    file("cn.ts", "/home/user/Documents/project/src/utils/cn.ts", 150),
    file("date.ts", "/home/user/Documents/project/src/utils/date.ts", 900),
    file("api-client.ts", "/home/user/Documents/project/src/utils/api-client.ts", 1500),
    file("storage.ts", "/home/user/Documents/project/src/utils/storage.ts", 700),
    file("index.ts", "/home/user/Documents/project/src/utils/index.ts", 200),
  ],
  "/home/user/Documents/project/src/hooks": [
    file("useAuth.ts", "/home/user/Documents/project/src/hooks/useAuth.ts", 1100),
    file("useTheme.ts", "/home/user/Documents/project/src/hooks/useTheme.ts", 500),
    file("useDebounce.ts", "/home/user/Documents/project/src/hooks/useDebounce.ts", 250),
    file("useLocalStorage.ts", "/home/user/Documents/project/src/hooks/useLocalStorage.ts", 400),
    file("useFetch.ts", "/home/user/Documents/project/src/hooks/useFetch.ts", 800),
    file("index.ts", "/home/user/Documents/project/src/hooks/index.ts", 150),
  ],
  "/home/user/Documents/project/src/services": [
    file("auth.service.ts", "/home/user/Documents/project/src/services/auth.service.ts", 2000),
    file("api.service.ts", "/home/user/Documents/project/src/services/api.service.ts", 1500),
    file("user.service.ts", "/home/user/Documents/project/src/services/user.service.ts", 1200),
    file("notification.service.ts", "/home/user/Documents/project/src/services/notification.service.ts", 800),
    file("index.ts", "/home/user/Documents/project/src/services/index.ts", 120),
  ],
  "/home/user/Documents/project/src/types": [
    file("user.ts", "/home/user/Documents/project/src/types/user.ts", 400),
    file("api.ts", "/home/user/Documents/project/src/types/api.ts", 600),
    file("theme.ts", "/home/user/Documents/project/src/types/theme.ts", 200),
    file("index.ts", "/home/user/Documents/project/src/types/index.ts", 100),
  ],
  "/home/user/Documents/project/src/styles": [
    file("globals.css", "/home/user/Documents/project/src/styles/globals.css", 2400),
    file("variables.css", "/home/user/Documents/project/src/styles/variables.css", 800),
    file("reset.css", "/home/user/Documents/project/src/styles/reset.css", 500),
    file("animations.css", "/home/user/Documents/project/src/styles/animations.css", 600),
  ],
  "/home/user/Documents/project/tests": [
    dir("unit", "/home/user/Documents/project/tests/unit"),
    dir("integration", "/home/user/Documents/project/tests/integration"),
    dir("e2e", "/home/user/Documents/project/tests/e2e"),
    file("setup.ts", "/home/user/Documents/project/tests/setup.ts", 500),
    file("fixtures.ts", "/home/user/Documents/project/tests/fixtures.ts", 1200),
  ],
  "/home/user/Documents/project/tests/unit": [
    file("format.test.ts", "/home/user/Documents/project/tests/unit/format.test.ts", 1400),
    file("validate.test.ts", "/home/user/Documents/project/tests/unit/validate.test.ts", 1800),
    file("helpers.test.ts", "/home/user/Documents/project/tests/unit/helpers.test.ts", 900),
    file("date.test.ts", "/home/user/Documents/project/tests/unit/date.test.ts", 1100),
  ],
  "/home/user/Documents/project/tests/integration": [
    file("auth.test.ts", "/home/user/Documents/project/tests/integration/auth.test.ts", 2200),
    file("api.test.ts", "/home/user/Documents/project/tests/integration/api.test.ts", 1900),
    file("user.test.ts", "/home/user/Documents/project/tests/integration/user.test.ts", 1600),
  ],
  "/home/user/Documents/project/tests/e2e": [
    file("login.spec.ts", "/home/user/Documents/project/tests/e2e/login.spec.ts", 2400),
    file("dashboard.spec.ts", "/home/user/Documents/project/tests/e2e/dashboard.spec.ts", 3200),
    file("settings.spec.ts", "/home/user/Documents/project/tests/e2e/settings.spec.ts", 1800),
  ],
  "/home/user/Documents/project/docs": [
    file("architecture.md", "/home/user/Documents/project/docs/architecture.md", 5400),
    file("api-reference.md", "/home/user/Documents/project/docs/api-reference.md", 8200),
    file("contributing.md", "/home/user/Documents/project/docs/contributing.md", 3100),
    file("deployment.md", "/home/user/Documents/project/docs/deployment.md", 2800),
  ],
  "/home/user/Documents/project/scripts": [
    file("build.sh", "/home/user/Documents/project/scripts/build.sh", 400),
    file("deploy.sh", "/home/user/Documents/project/scripts/deploy.sh", 600),
    file("seed-db.ts", "/home/user/Documents/project/scripts/seed-db.ts", 1500),
    file("migrate.ts", "/home/user/Documents/project/scripts/migrate.ts", 900),
  ],
  "/home/user/Documents/project/config": [
    file("default.json", "/home/user/Documents/project/config/default.json", 800),
    file("production.json", "/home/user/Documents/project/config/production.json", 600),
    file("development.json", "/home/user/Documents/project/config/development.json", 700),
    file("test.json", "/home/user/Documents/project/config/test.json", 500),
  ],
  "/home/user/Documents/project/assets": [
    dir("images", "/home/user/Documents/project/assets/images"),
    dir("fonts", "/home/user/Documents/project/assets/fonts"),
    file("logo.svg", "/home/user/Documents/project/assets/logo.svg", 4800),
    file("favicon.ico", "/home/user/Documents/project/assets/favicon.ico", 15000),
  ],
  "/home/user/Documents/project/assets/images": [
    file("hero.png", "/home/user/Documents/project/assets/images/hero.png", 245000),
    file("banner.jpg", "/home/user/Documents/project/assets/images/banner.jpg", 180000),
    file("icon-set.svg", "/home/user/Documents/project/assets/images/icon-set.svg", 12000),
    file("placeholder.png", "/home/user/Documents/project/assets/images/placeholder.png", 3200),
  ],
  "/home/user/Documents/project/assets/fonts": [
    file("Inter-Regular.woff2", "/home/user/Documents/project/assets/fonts/Inter-Regular.woff2", 48000),
    file("Inter-Bold.woff2", "/home/user/Documents/project/assets/fonts/Inter-Bold.woff2", 49000),
    file("FiraCode-Regular.woff2", "/home/user/Documents/project/assets/fonts/FiraCode-Regular.woff2", 52000),
  ],
  "/home/user/Documents/project/lib": [
    dir("core", "/home/user/Documents/project/lib/core"),
    dir("plugins", "/home/user/Documents/project/lib/plugins"),
    file("index.ts", "/home/user/Documents/project/lib/index.ts", 200),
    file("types.d.ts", "/home/user/Documents/project/lib/types.d.ts", 500),
  ],
  "/home/user/Documents/project/lib/core": [
    file("engine.ts", "/home/user/Documents/project/lib/core/engine.ts", 3200),
    file("parser.ts", "/home/user/Documents/project/lib/core/parser.ts", 2800),
    file("compiler.ts", "/home/user/Documents/project/lib/core/compiler.ts", 4100),
    file("runtime.ts", "/home/user/Documents/project/lib/core/runtime.ts", 2200),
    file("index.ts", "/home/user/Documents/project/lib/core/index.ts", 150),
  ],
  "/home/user/Documents/project/lib/plugins": [
    file("logger.ts", "/home/user/Documents/project/lib/plugins/logger.ts", 800),
    file("cache.ts", "/home/user/Documents/project/lib/plugins/cache.ts", 1100),
    file("metrics.ts", "/home/user/Documents/project/lib/plugins/metrics.ts", 950),
    file("index.ts", "/home/user/Documents/project/lib/plugins/index.ts", 120),
  ],
};

// Get directory entries with default empty array for unknown paths
function getDirectoryEntries(path: string): FileEntry[] {
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

// Mock command handlers
type CommandHandler = (args: Record<string, unknown>) => unknown;

/** Tracks paths added to .gitignore via the mocked git_add_to_gitignore so
 *  the SCM panel can hide newly-ignored entries on next git_status. */
const mockGitignored = new Set<string>();

// ----- Stateful in-memory git repo (mirrors src-tauri/src/git.rs contract) -----
//
// The SCM E2E tests assert real outcomes (a staged row leaves Changes, commit
// empties the staged section, an external edit shows up on refresh). To make
// those observable, the mock keeps a mutable working-tree/index model and
// moves entries between sections the same way the git2-backed backend would.
const MOCK_REPO_ROOT = "/home/user/Documents/project";

interface MockGitState {
  branch: string;
  detached: boolean;
  staged: GitFileEntry[];
  changes: GitFileEntry[];
  untracked: GitFileEntry[];
  merge: GitFileEntry[];
  op_state: GitOpState;
}

interface MockGitCommit {
  message: string;
  amend: boolean;
  files: string[];
  commit_id: string;
}

const mockGitCommits: MockGitCommit[] = [];

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
    // drive a merge-conflict flow via `__mockGitStartMergeConflict()`.
    merge: [],
    op_state: "clean",
  };
}

let mockGit: MockGitState = seedGitState();

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
    return;
  }
  const fromMerge = removeFrom(mockGit.merge, path);
  const fromChanges = removeFrom(mockGit.changes, path);
  if (fromChanges || fromMerge) {
    upsert(mockGit.staged, { path, old_path: null, status: "Modified" });
  }
}

/** Unstage one path: Added→untracked, otherwise→changes. */
function mockUnstagePath(path: string): void {
  const staged = removeFrom(mockGit.staged, path);
  if (!staged) return;
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
  const w = window as unknown as {
    __mockGitReset?: () => void;
    __mockGitCommits?: MockGitCommit[];
    __mockGitExternalModify?: (path: string) => void;
    __mockGitSetClean?: () => void;
    __mockGitStartMergeConflict?: () => void;
    __mockGitState?: () => MockGitState;
  };
  // Reset the repo to its seed state (mock/browser only).
  w.__mockGitReset = () => {
    mockGit = seedGitState();
    mockGitCommits.length = 0;
    mockGitignored.clear();
  };
  // Recorded commits, so tests can assert the message that was committed.
  w.__mockGitCommits = mockGitCommits;
  // Simulate an edit made outside the app (e.g. another process): add a
  // modified file to the working tree and fire the watcher change so the
  // SCM store re-fetches, exactly as the real filesystem watcher would.
  w.__mockGitExternalModify = (path: string) => {
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
  w.__mockGitSetClean = () => {
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
  w.__mockGitStartMergeConflict = () => {
    mockGit.op_state = "merge";
    if (!mockGit.merge.some((e) => e.path === "src/constants.ts")) {
      mockGit.merge.push({ path: "src/constants.ts", old_path: null, status: "Conflicted" });
    }
    emitWatcherGitChange(MOCK_REPO_ROOT);
  };
  w.__mockGitState = () => mockGit;
}

/** Contents of files created via the mocked write_text_file. */
const mockWrittenFiles: Record<string, string> = {};

/** In-memory OS clipboard file list, round-tripped by the clipboard_* mocks. */
let mockClipboardFiles: string[] = [];

// ----- Deterministic commit graph for git_log / git_refs mocks (#57) -----

interface MockCommit {
  oid: string;
  short_oid: string;
  parents: string[];
  author_name: string;
  author_email: string;
  author_time: number;
  summary: string;
}

/** Deterministic 40-char hex OID from a small commit number. */
function fullOid(n: number): string {
  return n.toString(16).padStart(4, "0").repeat(10);
}

// Newest-first, topologically ordered. 12 commits, a feature branch (#9,#10)
// merged into main at #12, and tags on #1 and #5. Parents reference lower
// numbers, so the array is a valid topological linearization.
const GRAPH_BASE_TIME = Math.floor(Date.UTC(2024, 5, 1, 9, 0, 0) / 1000);
const MOCK_GRAPH_SPEC: Array<{ n: number; parents: number[]; summary: string; stash?: string }> = [
  { n: 16, parents: [15, 13], summary: "Merge hotfix into main" },
  { n: 15, parents: [12, 14], summary: "Merge experiment" },
  { n: 14, parents: [9], summary: "Try alternative parser" },
  { n: 13, parents: [7], summary: "Hotfix: crash on empty input" },
  { n: 12, parents: [11, 10], summary: "Merge branch 'feature'" },
  { n: 11, parents: [8], summary: "Update README with usage" },
  { n: 10, parents: [9], summary: "Add tests for feature X" },
  { n: 9, parents: [8], summary: "Implement feature X" },
  { n: 8, parents: [7], summary: "Refactor config loader" },
  { n: 7, parents: [6], summary: "Fix bug in argument parser" },
  { n: 6, parents: [5], summary: "Add structured logging" },
  { n: 5, parents: [4], summary: "Bump version to 1.0" },
  { n: 4, parents: [3], summary: "Wire up CLI entry point" },
  { n: 3, parents: [2], summary: "Add core module" },
  { n: 2, parents: [1], summary: "Project scaffolding" },
  { n: 1, parents: [], summary: "Initial commit" },
  // Stash entry woven in by git_log right before its base (16).
  { n: 99, parents: [16], summary: "WIP on main: experimenting", stash: "stash@{0}" },
];

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

/** OID → decorating refs, matching git_refs targets. */
const MOCK_GRAPH_REFS: Record<
  string,
  Array<{ name: string; kind: "LocalBranch" | "RemoteBranch" | "Tag" | "Head" }>
> = {
  [fullOid(16)]: [
    { name: "HEAD", kind: "Head" },
    { name: "main", kind: "LocalBranch" },
    { name: "origin/main", kind: "RemoteBranch" },
  ],
  [fullOid(13)]: [
    { name: "hotfix", kind: "LocalBranch" },
    { name: "origin/hotfix", kind: "RemoteBranch" },
  ],
  [fullOid(14)]: [{ name: "experiment", kind: "LocalBranch" }],
  // Remote-only branch (no local counterpart) — exercises the remote-only
  // chip indicator and the local-only filter (#381).
  [fullOid(8)]: [{ name: "origin/legacy-import", kind: "RemoteBranch" }],
  [fullOid(10)]: [{ name: "feature", kind: "LocalBranch" }],
  [fullOid(5)]: [{ name: "v1.0", kind: "Tag" }],
  [fullOid(1)]: [{ name: "v0.9", kind: "Tag" }],
};

type MockRefKind = "LocalBranch" | "RemoteBranch" | "Tag" | "Head";

/** OID the HEAD ref currently decorates (mock working state). */
function mockHeadOid(): string {
  for (const [oid, list] of Object.entries(MOCK_GRAPH_REFS)) {
    if (list.some((r) => r.kind === "Head")) return oid;
  }
  return fullOid(12);
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

/** Point HEAD (and, when checking out a branch, follow it) at `oid`. */
function mockMoveHead(oid: string): void {
  mockMoveRef("HEAD", "Head", oid);
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
  const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
  mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
  mockMoveHead(oid);
  return oid;
}

/** Static fake file contents, served by read_text_file and searched by
 *  start_content_search (written files take precedence over these). */
const mockFileContent: Record<string, string> = {
  "/home/user/Documents/project/index.ts": 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  "/home/user/Documents/project/main.py": 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
  "/home/user/Documents/project/package.json": '{\n  "name": "project",\n  "version": "1.0.0"\n}\n',
  "/home/user/Documents/project/tsconfig.json": '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  "/home/user/Documents/project/README.md": '# Project\n\nA sample project.\n',
  "/home/user/readme.txt": "This is a readme file.\n",
  "/home/user/notes.md": [
    "# Notes",
    "",
    "Some notes here, with **bold** and *italic* text.",
    "",
    "## Tasks",
    "",
    "- [x] write the spec",
    "- [ ] ship the feature",
    "",
    "## Snippet",
    "",
    "```ts",
    "const answer: number = 42;",
    "```",
    "",
    "| key | value |",
    "|-----|-------|",
    "| a   | 1     |",
    "",
    "> Blockquotes render too. See [the docs](https://example.com).",
    "",
  ].join("\n"),
};

// Mutable so manual/E2E testing can simulate ejecting a removable drive: the
// drives store re-polls `list_drives` every ~1.5s, so replacing this list makes
// the change propagate. `window.__mockEjectDrive(path)` (set below) removes one.
let mockDrives: { name: string; path: string; kind: string; detail?: string; provider?: string }[] = [
  // Removable drive showing a volume label with the drive letter as dimmed detail.
  { name: "USB Backup", path: "/media/user/USB_DRIVE", kind: "removable", detail: "E:" },
  { name: "Memory Stick", path: "/media/user/Memory_Stick", kind: "removable", detail: "F:" },
  // Cloud / remote section: Google Drive File Stream + a WSL home mount.
  { name: "Google Drive", path: "/media/user/GoogleDrive", kind: "cloud", detail: "G:", provider: "googledrive" },
  { name: "Ubuntu", path: "\\\\wsl$\\Ubuntu\\home", kind: "cloud", detail: "WSL", provider: "wsl" },
];

if (typeof window !== "undefined") {
  // Test affordance (mock/browser only): drop a drive to mimic an eject.
  (window as unknown as { __mockEjectDrive?: (path: string) => void }).__mockEjectDrive = (path: string) => {
    mockDrives = mockDrives.filter((d) => d.path !== path);
  };
}

const mockCommands: Record<string, CommandHandler> = {
  get_home_directory: () => "/home/user",
  get_launch_cwd: () => "/home/user",
  list_drives: () => mockDrives,
  log_startup_timing: () => undefined,

  // Crash reporting (#184, #302): a Rust crash is simulated when the e2e test
  // sets localStorage.mockCrashReport before load; a frontend crash is
  // simulated by record_frontend_crash writing localStorage.mockFrontendCrash.
  // Either is consumed on first read, mirroring take_crash_report's mark-seen.
  take_crash_report: () => {
    if (localStorage.getItem("mockCrashReport") === "1") {
      localStorage.removeItem("mockCrashReport");
      return {
        fileName: "crash-1700000000.txt",
        contents:
          "tauri-explorer 1.0.0 crash report\nos: linux (x86_64)\ntime: 1700000000 (unix)\npanic: mock panic for testing\nlocation: src/lib.rs:1:1\n\nbacktrace:\n<omitted>\n",
      };
    }
    const frontend = localStorage.getItem("mockFrontendCrash");
    if (frontend) {
      localStorage.removeItem("mockFrontendCrash");
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
      "mockFrontendCrash",
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
  // Log tail (#302): fake recent log lines so the bug-report URL carries a
  // populated "Recent logs" section in e2e.
  read_log_tail: () =>
    [
      "[2024-01-01][12:00:00][INFO] tauri_explorer: started",
      "[2024-01-01][12:00:01][WARN] tauri_explorer: slow directory listing",
      "[2024-01-01][12:00:02][ERROR] tauri_explorer::files: permission denied",
    ].join("\n"),
  open_external_url: (args) => {
    localStorage.setItem("mock-opened-url", args.url as string);
    return undefined;
  },

  // Update check (#185): a newer release is simulated when the e2e test
  // sets localStorage.mockUpdateAvailable before load.
  check_for_update: () =>
    localStorage.getItem("mockUpdateAvailable") === "1"
      ? { version: "9.9.9", url: "https://github.com/xnmp/tauri-explorer/releases/tag/v9.9.9" }
      : null,

  // Pre-warmed window pool: no pool outside Tauri — spawn is always refused
  // and claims always miss, so openNewWindow takes the fresh-window path.
  warm_pool_begin_spawn: () => false,
  warm_pool_cancel_spawn: () => undefined,
  warm_pool_register: () => undefined,
  warm_pool_claim: () => null,
  warm_pool_discard: () => undefined,
  warm_pool_shutdown: () => undefined,

  list_directory: (args) => {
    const raw = args.path as string;
    const path = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!(path in mockFiles)) {
      throw new Error(`Path not found: ${path}`);
    }
    const entries = sortListing(getDirectoryEntries(path));
    return { path, entries, listing_id: null } as DirectoryListing;
  },

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

  start_streaming_directory: (args) => {
    const raw = args.path as string;
    const path = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!(path in mockFiles)) {
      throw new Error(`Path not found: ${path}`);
    }
    const entries = sortListing(getDirectoryEntries(path));
    return { path, entries, listing_id: null } as DirectoryListing;
  },

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
    return entry;
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
      return newEntry;
    }
    throw new Error("Entry not found");
  },

  move_to_trash: (args) => {
    const path = args.path as string;
    const parentPath = parentDir(path);
    const entries = mockFiles[parentPath] || [];
    const entryIndex = entries.findIndex((e) => e.path === path);
    if (entryIndex >= 0) {
      entries.splice(entryIndex, 1);
    }
    // Remove the directory's own listing so navigating to it after deletion fails
    delete mockFiles[path];
  },

  move_multiple_to_trash: (args) => {
    const paths = args.paths as string[];
    for (const path of paths) {
      const pp = parentDir(path);
      const entries = mockFiles[pp] || [];
      const entryIndex = entries.findIndex((e) => e.path === path);
      if (entryIndex >= 0) {
        entries.splice(entryIndex, 1);
      }
      delete mockFiles[path];
    }
  },

  restore_from_trash: () => {
    // Mock: no-op in tests (trash restore is OS-level)
  },

  copy_entry: (args) => {
    const source = args.source as string;
    const destDir = args.destDir as string;
    const overwrite = (args.overwrite as boolean) ?? false;
    const name = basename(source);
    const sourcePath = parentDir(source);
    const sourceEntries = mockFiles[sourcePath] || [];
    const sourceEntry = sourceEntries.find((e) => e.path === source);
    if (!sourceEntry) throw new Error("Source not found");

    if (!mockFiles[destDir]) mockFiles[destDir] = [];
    const dest = mockFiles[destDir];

    // Mirror the Rust backend: when the target name already exists and we're not
    // overwriting (e.g. pasting into the same folder), generate a "X - Copy"
    // name instead of clobbering. Used by the same-folder paste-copy behavior.
    let finalName = name;
    if (dest.some((e) => e.name === name) && !overwrite) {
      const isDir = sourceEntry.kind === "directory";
      const dot = isDir ? -1 : name.lastIndexOf(".");
      const base = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      finalName = `${base} - Copy${ext}`;
      for (let n = 2; dest.some((e) => e.name === finalName); n++) {
        finalName = `${base} - Copy (${n})${ext}`;
      }
    }

    const newPath = `${destDir}/${finalName}`;
    const newEntry: FileEntry = { ...sourceEntry, name: finalName, path: newPath };
    const existingIdx = dest.findIndex((e) => e.name === finalName);
    if (existingIdx >= 0) dest[existingIdx] = newEntry;
    else dest.push(newEntry);
    return newEntry;
  },

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
    return newEntry;
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
    return entry;
  },

  read_text_file: (args) => {
    const path = args.path as string;
    if (path in mockWrittenFiles) return mockWrittenFiles[path];
    const content = mockFileContent[path];
    if (content !== undefined) return content;
    throw new Error(`File not found: ${path}`);
  },

  delete_entry_permanent: (args) => {
    const path = args.path as string;
    const parentPath = parentDir(path);
    const entries = mockFiles[parentPath] || [];
    const entryIndex = entries.findIndex((e) => e.path === path);
    if (entryIndex >= 0) {
      entries.splice(entryIndex, 1);
    }
    delete mockFiles[path];
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

  start_streaming_search: () => {
    return 1; // Mock search ID
  },

  cancel_search: () => {},

  cancel_directory_listing: () => {},

  cancel_copy: () => {},

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

  get_thumbnail_data: () => {
    // Real 128px thumbnail from beautiful.jpg for realistic mock
    return "data:image/jpeg;base64,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";
  },

  get_micro_thumbnail: () => {
    // Real 16px micro thumbnail for progressive loading preview
    return "data:image/jpeg;base64,/9j//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABiAAEBAQAAAAAAAAAAAAAAAAAGAwUBAQAAAAAAAAAAAAAAAAAAAAQQAAIBAwQCAwEAAAAAAAAAAAECAxESACExIgRxYRNBUTIRAQACAwEBAAAAAAAAAAAAAAEhADFBAoED/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjOYesy3q4rUW2Vq3o4en70YNEis21Ycq+M3WvdI7ecjm0En+PwA/VddsDTjrpGx+UO9RooLbb8mpp4GN4UJZKn6Zjfl//9k=";
  },

  read_image_data_url: () => {
    // Full-size preview in browser/E2E mode: reuse the realistic thumbnail
    // JPEG so the preview pane (and its fullscreen mode) can be exercised.
    return mockInvoke<string>("get_thumbnail_data");
  },

  get_video_thumbnail_data: () => {
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
  terminal_spawn: () => 1,
  terminal_write: () => {},
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

  // ----- SCM git backend (#53) mock -----

  git_init: (args: Record<string, unknown>) => {
    return args.path as string;
  },

  git_repo_root: (args: Record<string, unknown>) => {
    const p = args.path as string;
    // No trailing slash — must stay consistent with git_status.repo_root
    if (p?.startsWith("/home/user/Documents/project")) return "/home/user/Documents/project";
    return null;
  },

  git_add_to_gitignore: (args: Record<string, unknown>) => {
    const entry = ((args.entry as string) || "").replace(/^\.\//, "").replace(/^\//, "");
    if (!mockGitignored.has(entry)) {
      mockGitignored.add(entry);
    }
    return entry;
  },

  git_status: (args: Record<string, unknown>) => {
    const repoPath = args.repoPath as string;
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
    return [{ path: `src/file-${n}.ts`, status: n % 2 === 0 ? "M" : "A" }];
  },
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
    const commit_id = (mockGitCommits.length + 1).toString(16).padStart(40, "0");
    if (amend && mockGitCommits.length > 0) {
      const prev = mockGitCommits[mockGitCommits.length - 1];
      prev.message = effectiveMessage;
      prev.files = Array.from(new Set([...prev.files, ...committed]));
    } else {
      mockGitCommits.push({ message: effectiveMessage, amend, files: committed, commit_id });
    }
    return { commit_id, summary: effectiveMessage.split("\n")[0] };
  },
  git_diff: (args: Record<string, unknown>) => {
    const p = args.path as string;
    // Binary files show a marker rather than a textual hunk.
    if (/\.(png|jpg|jpeg|gif|webp|ico|bin|exe|zip|pdf)$/i.test(p)) {
      return [
        `diff --git a/${p} b/${p}`,
        "index 0000000..1111111",
        `Binary files a/${p} and b/${p} differ`,
        "",
      ].join("\n");
    }
    // Real code lines so diff syntax highlighting is exercised (#246).
    return [
      `diff --git a/${p} b/${p}`,
      "index 1111111..2222222 100644",
      `--- a/${p}`,
      `+++ b/${p}`,
      "@@ -1,4 +1,4 @@",
      ' import { useState } from "react";',
      "-export function App() { return null; }",
      "+export function App() { return <div>hello</div>; }",
      ' const VERSION = "1.0";',
      "",
    ].join("\n");
  },
  git_watch_repo: () => null,
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
  git_fetch: () => null,
  git_pull: () => null,
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
  git_delete_branch: () => null,
  git_delete_remote_branch: () => null,

  // ----- Git history / commit graph (#57) -----

  git_log: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
    if (!repoPath.startsWith("/home/user/Documents/project")) {
      return { commits: [], refs: {}, has_more: false, next_cursor: null };
    }
    const options =
      (args.options as { skip?: number; limit?: number; branches?: string[] } | null) ?? {};
    const skip = Math.max(0, options.skip ?? 0);
    const limit = Math.max(1, options.limit ?? 500);

    let all = mockCommitGraph();
    // Branch filter (#342): mirror the backend's seeded revwalk — keep only
    // commits reachable from the selected branch tips; stash rows survive
    // only when their base commit does.
    if (options.branches && options.branches.length > 0) {
      const tips = new Map<string, string>();
      for (const [oid, refList] of Object.entries(MOCK_GRAPH_REFS)) {
        for (const r of refList) {
          if (r.kind === "LocalBranch" || r.kind === "RemoteBranch") tips.set(r.name, oid);
        }
      }
      const byOid = new Map(all.filter((c) => !("stash" in c)).map((c) => [c.oid, c]));
      const reachable = new Set<string>();
      const queue = options.branches
        .map((n) => tips.get(n))
        .filter((o): o is string => o !== undefined);
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
    const page = all.slice(skip, skip + limit);
    const hasMore = skip + limit < all.length;
    return {
      commits: page,
      refs: MOCK_GRAPH_REFS,
      has_more: hasMore,
      next_cursor: page.length ? page[page.length - 1].oid : null,
    };
  },

  git_refs: (args: Record<string, unknown>) => {
    const repoPath = (args.repoPath as string) ?? "";
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
    const tip = fullOid(16);
    return {
      local_branches: [
        { name: "main", target: tip },
        { name: "hotfix", target: fullOid(13) },
        { name: "experiment", target: fullOid(14) },
        { name: "feature", target: fullOid(10) },
      ],
      remote_branches: [
        { name: "origin/main", target: tip },
        { name: "origin/hotfix", target: fullOid(13) },
      ],
      tags: [
        { name: "v1.0", target: fullOid(5) },
        { name: "v0.9", target: fullOid(1) },
      ],
      head: tip,
      head_branch: "main",
      detached: false,
    };
  },

  // ----- Git graph mutating actions (VSCode Git Graph parity) -----

  git_checkout: (args: Record<string, unknown>) => {
    const target = (args.target as string) ?? "";
    const oid = mockResolveTarget(target);
    if (!oid) throw new Error(`pathspec '${target}' did not match any file(s) known to git`);
    mockMoveHead(oid);
    return null;
  },
  git_create_branch: (args: Record<string, unknown>) => {
    const name = ((args.name as string) ?? "").trim();
    const oid = (args.oid as string) ?? "";
    const checkout = Boolean(args.checkout);
    if (name.length === 0) throw new Error("branch name must not be empty");
    mockAddRef(name, "LocalBranch", oid);
    if (checkout) mockMoveHead(oid);
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
    mockAppendCommit(`Merge ${target} into current branch`);
    return null;
  },
  git_rebase: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    mockAppendCommit(`Rebased onto ${oid.slice(0, 7)}`);
    return null;
  },
  git_reset: (args: Record<string, unknown>) => {
    const oid = (args.oid as string) ?? "";
    const mode = (args.mode as string) ?? "mixed";
    if (!["soft", "mixed", "hard"].includes(mode)) {
      throw new Error(`invalid reset mode: ${mode}`);
    }
    // Move the branch HEAD is on (default main) and HEAD to the target commit.
    const head = mockHeadOid();
    const headBranch = (MOCK_GRAPH_REFS[head] ?? []).find((r) => r.kind === "LocalBranch");
    mockMoveRef(headBranch?.name ?? "main", "LocalBranch", oid);
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
    return entry;
  },

  // ----- File-picker portal -----

  // Records the response so e2e tests can assert on the actual outcome.
  picker_respond: (args) => {
    localStorage.setItem("mock-picker-response", JSON.stringify(args));
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

  // ----- Filesystem watcher (no-op in mock) -----

  watch_directory: () => {},

  unwatch_directory: () => {},

  // ----- Window theming (no-op in mock) -----

  set_window_theme: () => {},

  // ----- Clipboard file operations (os-clipboard.ts) -----
  // In-memory clipboard so write → has → read round-trips in browser/E2E mode,
  // mirroring the real OS clipboard contract (write paths, then read them back).

  clipboard_has_files: () => mockClipboardFiles.length > 0,

  clipboard_read_files: () => [...mockClipboardFiles],

  clipboard_write_files: (args) => {
    const paths = (args.paths as string[]) ?? [];
    mockClipboardFiles = [...paths];
    return true;
  },

  clipboard_has_image: () => false,

  // ----- Commands that launch external processes (no-op in mock) -----

  open_file_with: () => {},

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

// In-memory config file store for mock mode
const mockConfigFiles: Record<string, string> = {};

/**
 * Mock invoke function for browser-based testing.
 */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Add small delay to simulate async operation
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Per-command extra latency, settable from E2E tests / the console
  // (window.__MOCK_LATENCY__ = { git_status: 2000 }) or via URL for
  // fetches that fire during boot (?mockLatency=git_status:2000,foo:500),
  // to make transient loading states observable and assertable (#271).
  const g = globalThis as { __MOCK_LATENCY__?: Record<string, number>; location?: Location };
  if (!g.__MOCK_LATENCY__ && typeof location !== "undefined") {
    g.__MOCK_LATENCY__ = {};
    const param = new URLSearchParams(location.search).get("mockLatency");
    for (const pair of param?.split(",") ?? []) {
      const [name, ms] = pair.split(":");
      if (name && Number(ms) > 0) g.__MOCK_LATENCY__[name] = Number(ms);
    }
  }
  const extraLatency = g.__MOCK_LATENCY__?.[cmd];
  if (extraLatency) await new Promise((resolve) => setTimeout(resolve, extraLatency));

  const handler = mockCommands[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler(args || {}) as T;
}

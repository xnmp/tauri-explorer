/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";
import { selectPreviewImages } from "$lib/domain/folder-preview";
import { parentDir, basename } from "$lib/domain/path";

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

function dir(name: string, path: string, is_empty?: boolean): FileEntry {
  return { name, path, kind: "directory", size: 0, modified: nextTimestamp(), is_empty };
}

// Mock file system structure
const mockFiles: Record<string, FileEntry[]> = {
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

// Mock command handlers
type CommandHandler = (args: Record<string, unknown>) => unknown;

/** Tracks paths added to .gitignore via the mocked git_add_to_gitignore so
 *  the SCM panel can hide newly-ignored entries on next git_status. */
const mockGitignored = new Set<string>();

/** Contents of files created via the mocked write_text_file. */
const mockWrittenFiles: Record<string, string> = {};

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
    const entries = getDirectoryEntries(path);
    return { path, entries, listing_id: null } as DirectoryListing;
  },

  is_directory_empty: (args) => {
    const path = args.path as string;
    const includeHidden = (args.includeHidden ?? args.include_hidden) as boolean;
    if (!(path in mockFiles)) return false;
    const entries = getDirectoryEntries(path);
    return entries.every((e) => !includeHidden && e.name.startsWith("."));
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
    const entries = getDirectoryEntries(path);
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
  terminal_spawn: () => 1,
  terminal_write: () => {},
  terminal_resize: () => {},
  terminal_kill: () => {},

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

  list_user_themes: () => [] as [string, string][],

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
    if (!repoPath?.startsWith("/home/user/Documents/project")) {
      return {
        is_repo: false,
        repo_root: null,
        branch: null,
        detached: false,
        staged: [],
        changes: [],
        untracked: [],
        merge: [],
      };
    }
    return {
      is_repo: true,
      repo_root: "/home/user/Documents/project",
      branch: "main",
      detached: false,
      staged: [
        { path: "src/App.tsx", old_path: null, status: "Modified" },
      ],
      changes: [
        { path: "src/index.css", old_path: null, status: "Modified" },
        { path: "README.md", old_path: null, status: "Modified" },
      ],
      untracked: [
        { path: "src/router.tsx", old_path: null, status: "Untracked" },
        { path: ".env.example", old_path: null, status: "Untracked" },
        { path: "assets/logo.png", old_path: null, status: "Untracked" },
      ].filter((e) => !mockGitignored.has(e.path)),
      merge: [
        { path: "src/constants.ts", old_path: null, status: "Conflict" },
      ],
    };
  },

  git_stage: () => null,
  git_unstage: () => null,
  git_discard: () => null,
  git_commit: (args: Record<string, unknown>) => {
    const msg = (args.message as string) ?? "";
    return { commit_id: "deadbeef".padEnd(40, "0"), summary: msg.split("\n")[0] };
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
    return [
      `diff --git a/${p} b/${p}`,
      "index 1111111..2222222 100644",
      `--- a/${p}`,
      `+++ b/${p}`,
      "@@ -1,3 +1,3 @@",
      " unchanged line",
      "-removed line",
      "+added line",
      " more context",
      "",
    ].join("\n");
  },
  git_watch_repo: () => null,
  git_unwatch_repo: () => null,

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
    if (extractHere) return parentPath;
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

  clipboard_has_files: () => false,

  clipboard_read_files: () => [] as string[],

  clipboard_write_files: () => true,

  clipboard_has_image: () => false,

  // ----- Commands that launch external processes (no-op in mock) -----

  open_file_with: () => {},

  open_in_terminal: () => {},
  list_installed_terminals: () => ["ghostty", "kitty", "alacritty", "gnome-terminal", "xterm"],
  set_ffmpeg_path: () => {},

  set_as_wallpaper: () => {},

  // ----- Misc -----

  get_log_dir: () => "/tmp/tauri-explorer/logs",

  clipboard_paste_image: (args: Record<string, unknown>) => {
    const directory = args.directory as string;
    return `${directory}/clipboard-image.png`;
  },

  start_nano_banana_job: () => 1,
};

// In-memory config file store for mock mode
const mockConfigFiles: Record<string, string> = {};

/**
 * Mock invoke function for browser-based testing.
 */
export async function mockInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Add small delay to simulate async operation
  await new Promise((resolve) => setTimeout(resolve, 10));

  const handler = mockCommands[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler(args || {}) as T;
}

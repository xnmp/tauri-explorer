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

const DAY_MS = 24 * 60 * 60 * 1000;
function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
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

function dir(name: string, path: string, is_empty?: boolean, is_git_repo?: boolean): FileEntry {
  if (is_empty !== undefined) mockDirEmpty[path] = is_empty;
  // is_empty is intentionally absent from the listing contract (#129).
  return {
    name,
    path,
    kind: "directory",
    size: 0,
    modified: nextTimestamp(),
    ...(is_git_repo ? { is_git_repo: true } : {}),
  };
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
    // A git repo root (has a `.git` dir on the real backend) alongside a plain
    // folder, so the folder-with-git icon is visible in every view mode (#463).
    dir("my-project", "/home/user/my-project", false, true),
    dir(".config", "/home/user/.config", false),
    file("readme.txt", "/home/user/readme.txt", 1024),
    file("notes.md", "/home/user/notes.md", 2048),
  ],
  "/home/user/Archive": [],
  "/home/user/my-project": [
    dir("src", "/home/user/my-project/src", false),
    file("README.md", "/home/user/my-project/README.md", 2048),
    file(".gitignore", "/home/user/my-project/.gitignore", 64),
    file("package.json", "/home/user/my-project/package.json", 512),
  ],
  "/home/user/my-project/src": [
    file("index.ts", "/home/user/my-project/src/index.ts", 256),
  ],
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
    { ...dir("project", "/home/user/Documents/project"), modified: daysAgo(150) },
    { ...file("report.pdf", "/home/user/Documents/report.pdf", 102400), modified: daysAgo(35) },
    { ...file("budget.xlsx", "/home/user/Documents/budget.xlsx", 51200), modified: daysAgo(5) },
    { ...file("presentation.pptx", "/home/user/Documents/presentation.pptx", 204800), modified: daysAgo(1) },
    { ...file("notes.md", "/home/user/Documents/notes.md", 4096), modified: daysAgo(0) },
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
  const w = window as unknown as {
    __mockGitReset?: () => void;
    __mockGitCommits?: MockGitCommit[];
    __mockGitExternalModify?: (path: string) => void;
    __mockGitSetClean?: () => void;
    __mockGitStartMergeConflict?: () => void;
    __mockGitState?: () => MockGitState;
    __mockGitArchived?: string[];
  };
  // Reset the repo to its seed state (mock/browser only).
  w.__mockGitReset = () => {
    mockGit = seedGitState();
    mockHunkState.clear();
    mockGitCommits.length = 0;
    mockGitignored.clear();
    mockGitArchived.clear();
    w.__mockGitArchived = [];
  };
  // Recorded commits, so tests can assert the message that was committed.
  w.__mockGitCommits = mockGitCommits;
  w.__mockGitArchived = [];
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
    // A second local branch on the HEAD commit: exercises the #433 rule that
    // only the checked-out branch (main) gets the "current" highlight — this
    // one renders as an ordinary chip.
    { name: "release", kind: "LocalBranch" },
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
  // Test affordance (mock/browser only): fire the watcher signal a repo on a
  // UNC path gets every 3s from the poll watcher (#387). Used to prove a diff
  // still lands while those refreshes rain on it (#396).
  (window as unknown as { __mockGitPoll?: () => void }).__mockGitPoll = () => {
    emitWatcherGitChange(MOCK_REPO_ROOT);
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
  open_external_url: (args) => {
    if (localStorage.getItem("mock-open-url-error") === "1") {
      throw new Error("Mock browser handoff failed");
    }
    localStorage.setItem("mock-opened-url", args.url as string);
    return undefined;
  },
  submit_user_report: (args) => {
    localStorage.setItem("mock-submitted-report", JSON.stringify(args));
    const error = localStorage.getItem("mock-report-error");
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
    const isSynthetic = isPerfHugePath(path) || isPerfImagesPath(path);
    if (!isSynthetic && !(path in mockFiles)) {
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
    const isSynthetic = isPerfHugePath(path) || isPerfImagesPath(path);
    if (!isSynthetic && !(path in mockFiles)) {
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
    // Browser mode falls back to this complete-result search when Tauri event
    // streaming is unavailable; record the same Quick Open search boundary as
    // `start_streaming_search` below.
    const calls = JSON.parse(localStorage.getItem("mock-streaming-searches") ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem("mock-streaming-searches", JSON.stringify(calls));
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
    const calls = JSON.parse(localStorage.getItem("mock-streaming-searches") ?? "[]") as Array<{
      query: string;
    }>;
    calls.push({ query: String(args.query ?? "") });
    localStorage.setItem("mock-streaming-searches", JSON.stringify(calls));
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
  terminal_spawn: () => ({ id: 1, shellKind: "posix", wslDistro: null }),
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
      (window as unknown as { __mockGitArchived?: string[] }).__mockGitArchived = [...mockGitArchived];
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
  git_pull: () => {
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
  git_delete_remote_branch: () => null,

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
    // Test hook (like __MOCK_LATENCY__): force `has_more` so the infinite-
    // scroll loading row (#433) is reachable/observable with a small history.
    const forceHasMore =
      (globalThis as { __mockGraphForceHasMore?: boolean }).__mockGraphForceHasMore === true;
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
    return [
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

  clipboard_has_image: () =>
    localStorage.getItem("mock-report-clipboard-image") === "1",

  clipboard_read_report_image: () => ({
    name: "Clipboard screenshot.png",
    mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  }),

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

/**
 * localStorage key an e2e/unit test can set to pre-seed the mock config store
 * with `{ [filename]: contents }` before the app boots.
 *
 * The mock config store is in-memory and starts empty, so without this there
 * is no way to present the app with an EXISTING settings.json — every mock
 * run looks like a fresh install. That blind spot is exactly what hid #506:
 * a settings migration only runs against the durable store of record, which
 * the mock could never populate.
 */
export const MOCK_CONFIG_SEED_KEY = "mock-config-files";

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

/**
 * Mock Tauri invoke for browser-based E2E testing.
 * Provides realistic fake data when running outside of Tauri webview.
 */

import type { DirectoryListing, FileEntry } from "$lib/domain/file";

// Check if we're running in Tauri v2
// Note: Tauri v2 uses __TAURI_INTERNALS__, not __TAURI__ (v1)
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Helper to create ISO date string
const now = new Date().toISOString();

// Helper to create mock file entry
function file(name: string, path: string, size: number): FileEntry {
  return { name, path, kind: "file", size, modified: now };
}

function dir(name: string, path: string): FileEntry {
  return { name, path, kind: "directory", size: 0, modified: now };
}

// Mock file system structure
const mockFiles: Record<string, FileEntry[]> = {
  "/home": [
    dir("user", "/home/user"),
  ],
  "/home/user": [
    dir("Documents", "/home/user/Documents"),
    dir("Downloads", "/home/user/Downloads"),
    dir("Pictures", "/home/user/Pictures"),
    dir("Music", "/home/user/Music"),
    dir("Videos", "/home/user/Videos"),
    dir(".config", "/home/user/.config"),
    file("readme.txt", "/home/user/readme.txt", 1024),
    file("notes.md", "/home/user/notes.md", 2048),
  ],
  "/home/user/Documents": [
    dir("project", "/home/user/Documents/project"),
    file("report.pdf", "/home/user/Documents/report.pdf", 102400),
    file("budget.xlsx", "/home/user/Documents/budget.xlsx", 51200),
    file("presentation.pptx", "/home/user/Documents/presentation.pptx", 204800),
  ],
  "/home/user/Downloads": [
    file("archive.zip", "/home/user/Downloads/archive.zip", 1048576),
    file("installer.exe", "/home/user/Downloads/installer.exe", 5242880),
    file("image.png", "/home/user/Downloads/image.png", 524288),
  ],
  "/home/user/Pictures": [
    dir("vacation", "/home/user/Pictures/vacation"),
    file("photo1.jpg", "/home/user/Pictures/photo1.jpg", 2097152),
    file("photo2.jpg", "/home/user/Pictures/photo2.jpg", 1572864),
    file("screenshot.png", "/home/user/Pictures/screenshot.png", 262144),
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

const mockCommands: Record<string, CommandHandler> = {
  get_home_directory: () => "/home/user",
  get_launch_cwd: () => "/home/user",

  list_directory: (args) => {
    const raw = args.path as string;
    const path = raw !== "/" && raw.endsWith("/") ? raw.slice(0, -1) : raw;
    if (!(path in mockFiles)) {
      throw new Error(`Path not found: ${path}`);
    }
    const entries = getDirectoryEntries(path);
    return { path, entries, listing_id: null } as DirectoryListing;
  },

  check_paths_exist: (args) => {
    const paths = args.paths as string[];
    return paths.map((p: string) => p in mockFiles || Object.keys(mockFiles).some((k) => {
      const entries = mockFiles[k];
      return Array.isArray(entries) && entries.some((e: { path: string }) => e.path === p);
    }));
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
    const parentPath = path.substring(0, path.lastIndexOf("/"));
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
    const parentPath = path.substring(0, path.lastIndexOf("/"));
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
      const parentPath = path.substring(0, path.lastIndexOf("/"));
      const entries = mockFiles[parentPath] || [];
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
    const name = source.substring(source.lastIndexOf("/") + 1);
    const sourcePath = source.substring(0, source.lastIndexOf("/"));
    const sourceEntries = mockFiles[sourcePath] || [];
    const sourceEntry = sourceEntries.find((e) => e.path === source);
    if (!sourceEntry) throw new Error("Source not found");

    const newPath = `${destDir}/${name}`;
    const newEntry: FileEntry = { ...sourceEntry, path: newPath };
    if (!mockFiles[destDir]) mockFiles[destDir] = [];
    mockFiles[destDir].push(newEntry);
    return newEntry;
  },

  move_entry: (args) => {
    const source = args.source as string;
    const destDir = args.destDir as string;
    const name = source.substring(source.lastIndexOf("/") + 1);
    const sourcePath = source.substring(0, source.lastIndexOf("/"));
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

  read_text_file: (args) => {
    const path = args.path as string;
    // Return mock code content based on file extension
    const mockContent: Record<string, string> = {
      "/home/user/Documents/project/index.ts": 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
      "/home/user/Documents/project/main.py": 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
      "/home/user/Documents/project/package.json": '{\n  "name": "project",\n  "version": "1.0.0"\n}\n',
      "/home/user/Documents/project/tsconfig.json": '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
      "/home/user/Documents/project/README.md": '# Project\n\nA sample project.\n',
      "/home/user/readme.txt": "This is a readme file.\n",
      "/home/user/notes.md": "# Notes\n\nSome notes here.\n",
    };
    const content = mockContent[path];
    if (content !== undefined) return content;
    throw new Error(`File not found: ${path}`);
  },

  delete_entry_permanent: (args) => {
    const path = args.path as string;
    const parentPath = path.substring(0, path.lastIndexOf("/"));
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

  start_content_search: () => {
    return 1; // Mock search ID
  },

  cancel_content_search: () => {},

  get_thumbnail: () => {
    throw new Error("Thumbnails not available in mock mode");
  },

  get_thumbnail_data: () => {
    // Return a 1x1 gray pixel as placeholder
    return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  },

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

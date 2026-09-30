/**
 * Static fixture data for the browser/e2e mock backend (`mock-invoke.ts`):
 * the seeded fake filesystem tree, fake file contents, the fake drives list,
 * and the fake commit graph's shape/refs. Split out of mock-invoke.ts (#869)
 * so the ~700 lines of declarative test data don't sit between the dispatch
 * table's stateful simulation logic (trash, clipboard, git working-tree
 * mutation, recovery records) -- those stay in mock-invoke.ts, which imports
 * this module's exports and, where a fixture is mutable (`mockDrives`), owns
 * its own copy so reassignment doesn't try to rebind another module's export
 * (ES module bindings from an import are read-only in the importing module).
 */
import type { FileEntry } from "$lib/domain/file";

// Deterministic, varied timestamps: each created entry gets a distinct
// modified time (1h apart from a fixed base) so sort-by-modified is testable.
export const TIMESTAMP_BASE = Date.UTC(2024, 0, 1, 12, 0, 0);
export const TIMESTAMP_STEP_MS = 60 * 60 * 1000;
let timestampSeq = 0;
export function nextTimestamp(): string {
  return new Date(TIMESTAMP_BASE + timestampSeq++ * TIMESTAMP_STEP_MS).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

// Helper to create mock file entry
export function file(name: string, path: string, size: number): FileEntry {
  return { name, path, kind: "file", size, modified: nextTimestamp() };
}

// Ground-truth emptiness for mock directories that have no children keyed in
// `mockFiles` (e.g. a seeded-empty folder). Listings deliberately omit is_empty
// to mirror the backend (#129); the frontend resolves it via is_directory_empty,
// which consults this map for such folders.
export const mockDirEmpty: Record<string, boolean> = {};

export function dir(name: string, path: string, is_empty?: boolean, is_git_repo?: boolean): FileEntry {
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
export const mockFiles: Record<string, FileEntry[]> = {
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
  // Keep preview fixtures out of the shared home directory. Many browser
  // tests deliberately search or count that directory's baseline contents.
  "/home/csv-preview": [
    file("people.csv", "/home/csv-preview/people.csv", 256),
    file("broken.csv", "/home/csv-preview/broken.csv", 128),
    file("many-people.csv", "/home/csv-preview/many-people.csv", 8192),
    file("wide.csv", "/home/csv-preview/wide.csv", 1024),
  ],
  // Preview containment (#792): every format with content wider or taller
  // than a narrow preview pane.
  "/home/preview-containment": [
    dir("long-names", "/home/preview-containment/long-names", false),
    file("archive.zip", "/home/preview-containment/archive.zip", 4096),
    file("blob.bin", "/home/preview-containment/blob.bin", 4096),
    file("clip.mp4", "/home/preview-containment/clip.mp4", 1048576),
    file("long-line.ts", "/home/preview-containment/long-line.ts", 4096),
    file("panorama.png", "/home/preview-containment/panorama.png", 65536),
    file("tall.png", "/home/preview-containment/tall.png", 65536),
    file("unbroken.txt", "/home/preview-containment/unbroken.txt", 4096),
    file("wide.csv", "/home/preview-containment/wide.csv", 4096),
    file("wide.md", "/home/preview-containment/wide.md", 4096),
    file("an-exceptionally-long-file-name-that-must-truncate-inside-the-preview-header-instead-of-widening-the-pane.txt", "/home/preview-containment/an-exceptionally-long-file-name-that-must-truncate-inside-the-preview-header-instead-of-widening-the-pane.txt", 64),
  ],
  "/home/preview-containment/long-names": [
    dir("a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated", "/home/preview-containment/long-names/a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated", true),
    file("a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated.log", "/home/preview-containment/long-names/a-folder-child-whose-name-is-long-enough-to-overflow-any-narrow-preview-column-if-it-were-not-truncated.log", 128),
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
    file("soundtrack.mp3", "/home/user/Videos/soundtrack.mp3", 8388608),
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

/** Static fake file contents, served by read_text_file and searched by
 *  start_content_search (written files take precedence over these). */
export const mockFileContent: Record<string, string> = {
  "/home/user/Documents/project/index.ts": 'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n',
  "/home/user/Documents/project/main.py": 'def greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
  "/home/user/Documents/project/package.json": '{\n  "name": "project",\n  "version": "1.0.0"\n}\n',
  "/home/user/Documents/project/tsconfig.json": '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  "/home/user/Documents/project/README.md": '# Project\n\nA sample project.\n',
  "/home/user/readme.txt": "This is a readme file.\n",
  "/home/csv-preview/people.csv": 'name,note\nAda,"first, second"\nGrace,"said ""hello""\nand left"\n',
  "/home/csv-preview/broken.csv": 'name,note\nAda,"unterminated',
  "/home/csv-preview/many-people.csv": ["name,note", ...Array.from({ length: 250 }, (_, index) => `Person ${index + 1},record ${index + 1}`)].join("\n"),
  "/home/csv-preview/wide.csv": "first,description,final\nA,This is a deliberately long value that makes the table scroll horizontally,reachable final value\n",
  "/home/preview-containment/long-line.ts": `export const unbroken = "${"a".repeat(3000)}";\nexport const spaced = "${"word ".repeat(600)}";\n`,
  "/home/preview-containment/unbroken.txt": `${"x".repeat(3000)}\n${"y ".repeat(1500)}\n`,
  "/home/preview-containment/wide.csv": [
    Array.from({ length: 16 }, (_, column) => `column-heading-${column + 1}`).join(","),
    ...Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 16 }, (_, column) => `row ${row + 1} value ${column + 1} with some extra width`).join(",")),
  ].join("\n"),
  "/home/preview-containment/wide.md": [
    "---",
    `title: ${"frontmatter-value-without-any-breaks-".repeat(8)}`,
    "tags: [containment, preview, zoom]",
    "---",
    "",
    `# Heading${"Unbroken".repeat(30)}`,
    "",
    `A link to https://example.com/${"segment/".repeat(60)} and ${"inline".repeat(40)} text.`,
    "",
    "| " + Array.from({ length: 12 }, (_, column) => `Column heading ${column + 1}`).join(" | ") + " |",
    "| " + Array.from({ length: 12 }, () => "---").join(" | ") + " |",
    "| " + Array.from({ length: 12 }, (_, column) => `cell value ${column + 1}`).join(" | ") + " |",
    "",
    "```ts",
    `const wide = "${"b".repeat(1500)}";`,
    "```",
    "",
  ].join("\n"),
  "/home/preview-containment/an-exceptionally-long-file-name-that-must-truncate-inside-the-preview-header-instead-of-widening-the-pane.txt": "short content\n",
  "/home/user/notes.md": [
    "---",
    "title: August notes",
    "status: published",
    "tags: [tauri, explorer]",
    "authors:",
    "  - Alice",
    "  - Bob",
    "---",
    "",
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
// the change propagate. mock-invoke.ts clones this into its own `let mockDrives`
// and mutates that copy (`window.__mockControl.ejectDrive(path)`), since an
// imported binding can't be reassigned from outside the module that owns it.
export const mockDrivesFixture: { name: string; path: string; kind: string; detail?: string; provider?: string }[] = [
  // Removable drive showing a volume label with the drive letter as dimmed detail.
  { name: "USB Backup", path: "/media/user/USB_DRIVE", kind: "removable", detail: "E:" },
  { name: "Memory Stick", path: "/media/user/Memory_Stick", kind: "removable", detail: "F:" },
  // Cloud / remote section: Google Drive File Stream + a WSL home mount.
  { name: "Google Drive", path: "/media/user/GoogleDrive", kind: "cloud", detail: "G:", provider: "googledrive" },
  { name: "Ubuntu", path: "\\\\wsl$\\Ubuntu\\home", kind: "cloud", detail: "WSL", provider: "wsl" },
];

/** Deterministic 40-char hex OID from a small commit number. */
export function fullOid(n: number): string {
  return n.toString(16).padStart(4, "0").repeat(10);
}

// Newest-first, topologically ordered. 12 commits, a feature branch (#9,#10)
// merged into main at #12, and tags on #1 and #5. Parents reference lower
// numbers, so the array is a valid topological linearization.
export const MOCK_GRAPH_SPEC: Array<{ n: number; parents: number[]; summary: string; stash?: string }> = [
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

/** OID -> decorating refs, matching git_refs targets. */
export const MOCK_GRAPH_REFS: Record<
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

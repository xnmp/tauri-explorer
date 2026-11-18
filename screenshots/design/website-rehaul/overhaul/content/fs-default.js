/* The default filesystem: Sam's home, as in peel-mock/index-v3-grow.html, in the TX_FS format (see engine/README.md).
   Images live in peel-mock/assets and are referenced relative to pages in overhaul/. */
(function () {
  "use strict";
  window.TX_FS = window.TX_FS || {};
  const A = "../peel-mock/assets/";
  const T = {
    notes: "# Notes\n\n- Try Folder Peek: click a caret\n- Ctrl+P finds anything by name\n- Back up Photos to the backup drive\n- Theme from Image on sea-cliffs?",
    readme: "# Tauri Explorer\n\nA fast file manager that is only as busy as you want it to be.\n\n## Build\n\n- bun install\n- bun run start",
    recipes: "# Recipes\n\n## Miso soup\n- dashi\n- white miso\n- tofu and wakame\n\n## Congee\n- rice, water, ginger",
    todo: "renew passport\ncall the framer\nreturn library books\nwater the fig",
    budget: "month,rent,food,travel\nJul,1450,398,40\nAug,1450,412,120\nSep,1450,389,640\nOct,1450,401,95",
    playlist: "#EXTM3U\nrain-on-tin.flac\nharbour-dawn.flac",
    restore: "Weekly backup, Sundays 03:00.\nRestore with: rsync -a /media/backup/ ~/",
    main: "fn main() {\n    tauri_explorer::run();\n}",
    cargo: "[package]\nname = \"tauri-explorer\"\nversion = \"0.9.0\"\nedition = \"2021\"",
    pkg: "{\n  \"name\": \"tauri-explorer\",\n  \"private\": true,\n  \"type\": \"module\"\n}",
    peek: "<script lang=\"ts\">\n  let { folder, open } = $props();\n</" + "script>\n\n{#if open}\n  <FileRows parent={folder} />\n{/if}",
    qo: "export function rank(query: string, name: string) {\n  // subsequence match, word starts score higher\n}",
    html: "<!doctype html>\n<title>Tauri Explorer</title>\n<h1>Everything. Or nothing.</h1>",
    css: ":root {\n  --paper: #F0EBE3;\n  --teal: #0E7C72;\n}",
    bashrc: "# ~/.bashrc\nexport EDITOR=hx\nalias ll='ls -l'\nalias gs='git status'",
    gitconfig: "[user]\n  name = Sam\n  email = sam@example.org\n[init]\n  defaultBranch = main",
    settings: "{\n  \"theme\": \"ink-wash\",\n  \"layout\": \"default\",\n  \"folderPeek\": true\n}",
    draft: "# Old draft\n\nThings I meant to say about the trip, before I said them better.",
  };
  const D = (name, date, kids) => ({ name, kind: "dir", date, kids });
  const F = (name, size, date, text) => ({ name, kind: "file", size, date, ...(text != null ? { text } : {}) });
  const P = (name, size, date, img, px) => ({ name, kind: "file", size, date, src: `${A}${img}.webp`, px });

  const tree = D("", "", [
    D("bin", "Sep 2, 10:00", []), D("etc", "Oct 1, 09:12", []),
    D("home", "Mar 3, 12:00", [
      D("sam", "Oct 18, 11:20", [
        D(".config", "Oct 10, 09:00", [D("tauri-explorer", "Oct 10, 09:00", [F("settings.json", "1 KB", "Oct 10, 09:00", T.settings)])]),
        F(".bashrc", "1 KB", "Sep 1, 10:00", T.bashrc),
        F(".gitconfig", "1 KB", "Sep 1, 10:02", T.gitconfig),
        D("Desktop", "Oct 18, 08:02", [F("todo.txt", "1 KB", "Oct 18, 08:02", T.todo), P("screenshot-2026-10-17.webp", "412 KB", "Oct 17, 21:14", "city-blue-hour", "2560x1440")]),
        D("Documents", "Oct 2, 18:40", [D("Taxes", "Apr 12, 10:31", [F("2025-return.pdf", "1.1 MB", "Apr 12, 10:31")]), F("budget.csv", "12 KB", "Sep 29, 19:30", T.budget), F("recipes.md", "9 KB", "Oct 2, 18:40", T.recipes), F("resume.pdf", "88 KB", "Aug 21, 09:15")]),
        D("Downloads", "Oct 18, 11:02", [F("tauri-explorer_0.9.0_amd64.AppImage", "18.2 MB", "Oct 18, 11:02"), F("invoice-2026-10.pdf", "182 KB", "Oct 3, 14:02"), P("wallpaper.webp", "2.0 MB", "Oct 9, 17:12", "river-canyon", "3840x2160")]),
        D("Music", "Sep 1, 20:20", [D("Field recordings", "Jul 4, 05:48", [F("rain-on-tin.flac", "48.1 MB", "Jul 3, 06:12"), F("harbour-dawn.flac", "61.7 MB", "Jul 4, 05:48")]), F("playlist.m3u", "2 KB", "Sep 1, 20:20", T.playlist)]),
        D("Photos", "Oct 12, 09:41", [P("alpine-lake.webp", "2.4 MB", "Oct 12, 09:41", "alpine-lake", "3840x2160"), P("city-blue-hour.webp", "2.7 MB", "Oct 6, 19:02", "city-blue-hour", "4032x3024"), P("dunes.webp", "1.2 MB", "Sep 30, 19:15", "dunes", "3840x2560"), P("foggy-pines.webp", "1.9 MB", "Oct 11, 07:02", "foggy-pines", "3024x4032"), P("river-canyon.webp", "3.6 MB", "Oct 9, 17:12", "river-canyon", "4032x3024"), P("sea-cliffs.webp", "3.1 MB", "Oct 4, 18:47", "sea-cliffs", "4032x3024")]),
        D("Projects", "Oct 17, 18:02", [
          D("tauri-explorer", "Oct 18, 11:20", [D("src", "Oct 18, 11:20", [D("lib", "Oct 18, 11:20", [F("FolderPeek.svelte", "9 KB", "Oct 18, 11:20", T.peek), F("quick-open.ts", "6 KB", "Oct 16, 09:40", T.qo)]), F("main.rs", "3 KB", "Oct 15, 16:44", T.main)]), F("Cargo.toml", "2 KB", "Oct 14, 10:05", T.cargo), F("README.md", "6 KB", "Oct 16, 22:47", T.readme), F("package.json", "4 KB", "Oct 15, 08:31", T.pkg)]),
          D("website", "Oct 16, 22:47", [F("index.html", "14 KB", "Oct 16, 22:47", T.html), F("style.css", "8 KB", "Oct 16, 22:40", T.css)]),
        ]),
        F("notes.md", "4 KB", "Oct 18, 08:15", T.notes),
      ]),
      D("shared", "Jun 1, 10:00", []),
    ]),
    D("media", "Oct 1, 03:00", [D("backup", "Oct 12, 03:00", [D("Photos 2025", "Dec 30, 03:00", []), F("restore-notes.txt", "2 KB", "Oct 12, 03:00", T.restore)])]),
    D("opt", "Aug 2, 10:00", []), D("usr", "Aug 2, 10:00", []), D("var", "Oct 18, 07:00", []),
  ]);

  const diff = (path, hunks) => `--- a/${path}\n+++ b/${path}\n${hunks}`;
  const repos = {
    "/home/sam/Projects/tauri-explorer": {
      branch: "main",
      commits: [
        { hash: "e8622ef6", msg: "feat: Floating Islands active tab owns the window\n\nThe active tab now joins the pane below it, so the window reads as one surface.", author: "sam", date: "2 hours ago", parents: ["b71634a0"], refs: ["main", "origin/main"], files: [
          { path: "src/lib/layouts/floating-islands.css", status: "M", diff: diff("src/lib/layouts/floating-islands.css", "@@ -12,7 +12,9 @@ .island {\n   border-radius: var(--radius);\n-  box-shadow: var(--shadow);\n+  box-shadow: var(--shadow);\n+}\n+.island:has(.tab.active) {\n+  border-top-left-radius: 0;\n }") },
          { path: "src/lib/components/TitleBar.svelte", status: "M", diff: diff("src/lib/components/TitleBar.svelte", "@@ -40,6 +40,7 @@\n   <div class=\"tabs\">\n     {#each tabs as tab}\n-      <Tab {tab} />\n+      <Tab {tab} joined={tab.active} />\n     {/each}") },
          { path: "e2e/islands-active-tab.spec.ts", status: "A", diff: diff("e2e/islands-active-tab.spec.ts", "@@ -0,0 +1,6 @@\n+import { test, expect } from \"@playwright/test\";\n+\n+test(\"active tab joins the pane\", async ({ page }) => {\n+  await page.goto(\"/?layout=floating-islands\");\n+  await expect(page.locator(\".tab.active\")).toHaveCSS(\"border-bottom-width\", \"0px\");\n+});") },
        ] },
        { hash: "b71634a0", msg: "chore: prepare v1.27.0 release", author: "sam", date: "yesterday", parents: ["3cbbbaf4", "a41c9d27"], refs: ["v1.27.0"], files: [
          { path: "package.json", status: "M", diff: diff("package.json", "@@ -1,5 +1,5 @@\n {\n   \"name\": \"tauri-explorer\",\n-  \"version\": \"1.26.3\",\n+  \"version\": \"1.27.0\",\n   \"private\": true,") },
          { path: "src-tauri/Cargo.toml", status: "M" },
        ] },
        { hash: "3cbbbaf4", msg: "fix: anchor PDF zoom on a PDF control", author: "mira", date: "yesterday", parents: ["8aefcc39"], files: [{ path: "src/lib/components/PdfPreview.svelte", status: "M" }, { path: "e2e/pdf-zoom.spec.ts", status: "M" }] },
        { hash: "a41c9d27", msg: "feat: folder peek springs open under a dragged file", author: "jun", date: "2 days ago", parents: ["7d03b6e1"], refs: ["feat/peek-spring"], files: [
          { path: "src/lib/FolderPeek.svelte", status: "M" },
          { path: "src/lib/domain/spring-peek.ts", status: "A", diff: diff("src/lib/domain/spring-peek.ts", "@@ -0,0 +1,5 @@\n+export const SPRING_DELAY_MS = 650;\n+\n+export function shouldSpring(hoverMs: number, isFolder: boolean) {\n+  return isFolder && hoverMs >= SPRING_DELAY_MS;\n+}") },
          { path: "tests/domain/spring-peek.test.ts", status: "A" },
        ] },
        { hash: "7d03b6e1", msg: "test: cover spring peek in List view", author: "jun", date: "3 days ago", parents: ["8aefcc39"], files: [{ path: "e2e/peek-spring-list.spec.ts", status: "A" }] },
        { hash: "8aefcc39", msg: "fix: rename word movement stops at punctuation", author: "mira", date: "3 days ago", parents: ["4b7f0bc7"], files: [
          { path: "src/lib/domain/rename-caret.ts", status: "M", diff: diff("src/lib/domain/rename-caret.ts", "@@ -3,5 +3,5 @@\n export function nextWordStop(text: string, at: number) {\n-  const re = /\\s/g;\n+  const re = /[\\s\\p{P}]/gu;\n   re.lastIndex = at + 1;\n   return re.exec(text)?.index ?? text.length;") },
          { path: "tests/domain/rename-caret.test.ts", status: "M" },
        ] },
        { hash: "4b7f0bc7", msg: "fix: hide custom window controls on macOS", author: "sam", date: "4 days ago", parents: ["19c2e770"], files: [{ path: "src/lib/components/TitleBar.svelte", status: "M" }] },
        { hash: "19c2e770", msg: "feat: Details Length column for audio and video", author: "jun", date: "5 days ago", parents: [], files: [{ path: "src/lib/state/media-length.ts", status: "A" }, { path: "src/lib/components/FileItem.svelte", status: "M" }, { path: "src-tauri/src/files/media.rs", status: "M" }] },
      ],
    },
    "/home/sam/Projects/website": {
      branch: "main",
      commits: [
        { hash: "c0ffee12", msg: "style: teal accents on the download button", author: "sam", date: "2 days ago", parents: ["5eed1e55"], refs: ["main"], files: [{ path: "style.css", status: "M", diff: diff("style.css", "@@ -1,3 +1,4 @@\n :root {\n   --paper: #F0EBE3;\n+  --teal: #0E7C72;\n }") }] },
        { hash: "5eed1e55", msg: "feat: first page", author: "sam", date: "a week ago", parents: [], files: [{ path: "index.html", status: "A" }, { path: "style.css", status: "A" }] },
      ],
    },
  };

  const trash = [
    { node: { name: "old-draft.md", kind: "file", size: "2 KB", date: "Sep 20, 21:40", text: T.draft }, from: "/home/sam/Documents", deleted: "Oct 14, 10:12" },
    { node: { name: "IMG_0042.webp", kind: "file", size: "1.8 MB", date: "Oct 1, 12:00", src: `${A}dunes.webp`, px: "3840x2560" }, from: "/home/sam/Photos", deleted: "Oct 16, 18:30" },
  ];

  window.TX_FS.default = {
    title: "Sam's computer",
    users: [{
      id: "sam", name: "Sam", home: "/home/sam", blurb: "Photos, a couple of projects, and the usual paperwork.",
      setup: { parts: ["tabs", "address", "sidebar", "miller", "status", "views", "preview", "split", "peek", "search", "terminal", "git", "plugin", "palette", "themes", "hotkeys"], theme: "ink-wash", layout: "default", icons: "material", view: "details", path: "/home/sam" },
    }],
    tree, trash, repos,
  };
})();

# CLAUDE.md rehaul (#1784)

The root `CLAUDE.md` (619 lines) was split into a short root plus path-scoped
`CLAUDE.md` files. Claude Code loads a subdirectory `CLAUDE.md`, and those of
its ancestors below the root, when a session reads a file under it. Where a
module sits in a flat directory away from its feature's rules, the layer file
for that directory points to them.

Destinations: **root** = `CLAUDE.md`; **path** = the named scoped file;
**lesson** = `docs/lessons/`; **deleted** = removed as obsolete. "+" marks a
short duplicate or a sentence placed in a second file so that edits there see it.
Original line numbers refer to `CLAUDE.md` at 2cceb911.

## Rule mapping

| # | Line | Rule (first words) | Destination |
| --- | --- | --- | --- |
| 1 | 1 | "This file provides guidance…" | root |
| 2 | 5 | Build & Dev Commands table | root |
| 3 | 31 | "When changing Rust code gated by `cfg(windows)`…" (cargo xwin) | root |
| 4 | — | Disk usage section (new, from the main checkout's uncommitted patch, verbatim) | root |
| 5 | 37 | WSL ↔ Windows: always `git push` | root |
| 6 | 41 | Architecture Overview (stack, layers, async commands, entry point) | root |
| 7 | 49 | "Repository-folder Git badges read `--icon-git-badge`…" | path: `src/lib/components/CLAUDE.md` + `src/lib/themes/CLAUDE.md` |
| 8 | 52 | "Three view modes (Details/List/Tiles)…" | root |
| 9 | 53 | "Details-only columns (e.g. Length, #995)…" | path: `src/lib/components/CLAUDE.md` |
| 10 | 54 | "Keep high-frequency hover feedback…" (#503) | path: `src/lib/components/CLAUDE.md` |
| 11 | 55 | "Refresh policy is split deliberately…" | root |
| 12 | 56 | "Watcher callbacks are delayed work…" | path: `src/lib/state/CLAUDE.md` |
| 13 | 57 | "Pane focus is **state, not DOM focus**…" | path: `src/lib/components/CLAUDE.md` + `e2e/CLAUDE.md` (assertion) |
| 14 | 58 | "Recently active window tabs stay mounted…" (#1173) | path: `src/lib/components/CLAUDE.md` + `e2e/CLAUDE.md` (locators) |
| 15 | 59 | "ExplorerPane owns window-level file-list shortcuts…" (`scrollToEntry`) | path: `src/lib/components/CLAUDE.md` |
| 16 | 60 | "Native window titles have two phases…" | path: `src/lib/state/CLAUDE.md` + `src-tauri/CLAUDE.md` (creation paths) |
| 17 | 61 | "Native qualification must bind resource sampling…" | path: `e2e-tauri/CLAUDE.md` + `src/lib/state/CLAUDE.md` (startup-mark ownership) |
| 18 | 62 | "Per ADR 0022, the native E2E target cache…" | path: `.github/workflows/CLAUDE.md` |
| 19 | 63 | "A native WebDriver command can block…" (#703, #781) | path: `e2e-tauri/CLAUDE.md` |
| 20 | 69 | "macOS and Linux recover a terminated web process…" | path: `src-tauri/src/renderer_owner/CLAUDE.md` + `src/lib/domain/CLAUDE.md` (`launchRequest`) + `e2e-tauri/CLAUDE.md` (no harness reload) |
| 21 | 70 | "Investigation-only scaffolding carries `Retire-when`…" | root |
| 22 | 71 | "New-window address-bar focus likewise…" | path: `src/lib/state/CLAUDE.md` |
| 23 | 72 | "The sidebar Recycle Bin opens the in-app `trash://`…" (#863) | path: `src/lib/state/CLAUDE.md` |
| 24 | 73 | "The external Recycle Bin launch…" (`system::open_recycle_bin`) | path: `src-tauri/src/files/CLAUDE.md` |
| 25 | 74 | "Do not use generic `gio open trash:///`…" | path: `src-tauri/src/files/CLAUDE.md` |
| 26 | 75 | "Keep state machines and caches out of component-local scope…" (#444) | root |
| 27 | 76 | "Preview file-kind precedence lives only in…" (#1206) | path: `src/lib/state/CLAUDE.md` |
| 28 | 82 | "Rust test modules included with `#[path]`…" | path: `src-tauri/CLAUDE.md` |
| 29 | 83 | "The native crate is a desktop application library…" (doctest) | path: `src-tauri/CLAUDE.md` |
| 30 | 84 | "Progress toasts must bypass…" | path: `src/lib/components/CLAUDE.md` |
| 31 | 85 | "Plugin context-menu actions that invoke an AI service…" | path: `src/lib/components/CLAUDE.md` |
| 32 | 86 | "The Theme from Image context-menu action…" | path: `src/lib/components/CLAUDE.md` |
| 33 | 87 | "Miller columns cache ancestor listings…" (#598) | path: `src/lib/state/CLAUDE.md` |
| 34 | 88 | "Quick Open keeps local active-pane/recent/frecency matches…" (#600, #651) | path: frontend sentences → `src/lib/state/CLAUDE.md`; search-cache sentences → `src-tauri/src/files/CLAUDE.md` |
| 35 | 89 | "Terminal focus gives terminal-hosted applications…" | path: `src/lib/domain/CLAUDE.md` (pointer from components) |
| 36 | 90 | "Shortcut hints in command-owned UI…" | path: `src/lib/components/CLAUDE.md` |
| 37 | 91 | "Fixed overlays under root CSS zoom…" (#493) | path: `src/lib/components/CLAUDE.md` |
| 38 | 92 | "Details header column menus use `fixedMenuPosition`…" (#993) | path: `src/lib/components/CLAUDE.md` |
| 39 | 93 | "Zoomed image previews update their `transform`…" (#635) | path: `src/lib/components/CLAUDE.md` |
| 40 | 94 | "The marquee band is five container-sized layers…" (#1051) | path: `src/lib/components/CLAUDE.md` + `e2e/CLAUDE.md` (test sentence) |
| 41 | 95 | "Column visibility tests must assert mounted row cells…" (#993) | path: `e2e/CLAUDE.md` |
| 42 | 96 | "Vertical preview docks retain…" (#699) | path: `src/lib/components/CLAUDE.md` |
| 43 | 97 | "GNOME Wayland native drags consume keyboard events…" (#1100) | path: `src-tauri/src/native_file_drag/CLAUDE.md` |
| 44 | 98 | "Bookmarks have two drop surfaces…" (#675) | path: `src/lib/components/CLAUDE.md` |
| 45 | 99 | "Bookmark feedback must state the action…" (#675) | path: `src/lib/domain/CLAUDE.md` |
| 46 | 100 | "Repository-folder Git badges are rendered directly by `FileIcon.svelte`…" (#601) | path: `src/lib/components/CLAUDE.md` + `src/lib/themes/CLAUDE.md` |
| 47 | 101 | "Git-graph fork-point lookup…" (#1083) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 48 | 102 | "Git graph lineage is first-parent topology…" | path: `src/lib/components/git-graph/CLAUDE.md` |
| 49 | 106 | "Base-update merge muting…" (#527) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 50 | 111 | "Git-graph commit comparison is a tree-to-tree operation…" | path: `src/lib/components/git-graph/CLAUDE.md` |
| 51 | 114 | "Git-graph undo snapshots…" (#513) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 52 | 115 | "Git-graph tabs remount on activation…" (#505) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 53 | 116 | "Git-graph fetch, pull, and remote-branch push…" (#528) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 54 | 117 | "User-report images and videos are hosted as public Vercel Blobs…" | path: `website/api/CLAUDE.md` + `src-tauri/src/clipboard/CLAUDE.md` (routing sentence) |
| 55 | 135 | "The root Vitest suite imports the report relay…" | path: `website/api/CLAUDE.md` + `tests/CLAUDE.md` |
| 56 | 141 | "Architecture passes resume from the ledger's `Covered through`…" (#1219) | path: `docs/CLAUDE.md` |
| 57 | 145 | "Keep architecture recurrence counts separate…" (#1251) | path: `docs/CLAUDE.md` |
| 58 | 149 | "PR bodies are mutable evidence…" (#1262) | path: `docs/CLAUDE.md` |
| 59 | 153 | "Audit feature completion at the tested interaction…" (#1277) | path: `docs/CLAUDE.md` |
| 60 | 157 | "Recheck closed follow-ups for explicit residuals…" (#1288) | path: `docs/CLAUDE.md` |
| 61 | 162 | "A closed destination follow-up can remove…" (#1301) | path: `docs/CLAUDE.md` |
| 62 | 168 | "Closed-tab peek restoration keeps only bounded membership…" (#1319) | path: `docs/CLAUDE.md` |
| 63 | 174 | "**Start at docs/code-map/**…" | root |
| 64 | 175 | "**Keep the maps current or they turn harmful.**" | root |
| 65 | 176 | "docs/lessons/ — gotchas from closed issues…" | root |
| 66 | 180 | "All development happens off `dev`…" | root |
| 67 | 181 | "Branch ↔ issue convention…" | root |
| 68 | 182 | "Relationship tooling…" (`gh issue-ext`) | root |
| 69 | 183 | "Issue bodies need a `## Screenshots` section…" | root |
| 70 | 184 | "Keep `evidence/` available…" | root |
| 71 | 185 | "Browser specs write PNGs… only under `CAPTURE_EVIDENCE=1`" | root (+ pointer in `e2e/CLAUDE.md`) |
| 72 | 186 | "The merge hook does **not** close issues…" | root |
| 73 | 187 | "Before ending a session that merged UI work…" | root |
| 74 | 188 | "Make sure to clean up the worktree after merging." | root |
| 75 | 192 | "CI selection (#1367…)" | root |
| 76 | 203 | "The three test tiers see different things…" | root |
| 77 | 209 | "WebKitWebDriver may evaluate `browser.execute` in an isolated JavaScript world…" | path: `e2e-tauri/CLAUDE.md` + `e2e/CLAUDE.md` (modal-after-Escape and debounce sentences) |
| 78 | 223 | "Playwright `page.clock.install()` still advances with real time…" | path: `e2e/CLAUDE.md` |
| 79 | 227 | "The graph-lineage unit file includes a wall-clock hover budget…" (#1123) | path: `tests/CLAUDE.md` |
| 80 | 232 | "Native crop oracles measure loaded first-frame pixels…" | path: `e2e-tauri/CLAUDE.md` |
| 81 | 237 | "Real-watcher timing tests must also wait…" (#1152) | path: `src-tauri/src/files/CLAUDE.md` (pointer from `e2e-tauri/CLAUDE.md`) |
| 82 | 247 | "Tauri Rust listeners (`app.listen`) are not a lossless test oracle…" (#1215) | path: `src-tauri/CLAUDE.md` |
| 83 | 251 | "Anything whose failure mode involves races…" | root |
| 84 | 253 | "Config autoreload tests must write through the canonical target…" | path: `src-tauri/CLAUDE.md` |
| 85 | 255 | "Config-watch retargets must restore every surviving descendant…" (through line 286, #938, ADR 0004) | path: `src-tauri/CLAUDE.md` |
| 86 | 288 | "The public report relay under `website/api/` uses `GITHUB_ISSUE_TOKEN`…" | path: `website/api/CLAUDE.md` |
| 87 | 290 | "**Repro-first for bug fixes.**" | root |
| 88 | 292 | "**Adversarial verification for high-risk changes.**" | root |
| 89 | 294 | "**E2E tests assert outcomes**…" | root |
| 90 | 296 | "Markdown preview content is inserted with `{@html}`…" | path: `src/lib/components/CLAUDE.md` |
| 91 | 297 | "Fullscreen PDF horizontal arrows…" (#1010) | path: `src/lib/components/CLAUDE.md` |
| 92 | 298 | "Settings browser tests must target named controls…" (#1010) | path: `e2e/CLAUDE.md` |
| 93 | 299 | "Markdown frontmatter is parsed in `domain/markdown.ts`…" | path: `src/lib/domain/CLAUDE.md` |
| 94 | 301 | "The Linux FileChooser portal is selected through…" | path: `packaging/CLAUDE.md` |
| 95 | 305 | "SCM archive actions preserve each repo-relative path…" | path: `src/lib/components/CLAUDE.md` (pointer from `src-tauri/CLAUDE.md` for `archive.rs`) |
| 96 | 310 | "If the main model is Fable…" | root |
| 97 | 311 | "Agent-tool worktrees are created from **main**…" | root |
| 98 | 312 | "Agents work **only inside their worktree cwd**…" | root |
| 99 | 313 | "Port :1420 belongs to the main session…" | root |
| 100 | 314 | "Squash-merge conflicts in `map-feature.md`…" | root |
| 101 | 318 | "External-filter discard tests must check…" (#1637) | path: `src-tauri/CLAUDE.md` |
| 102 | 323 | "Cross-platform batch-worker tests must derive absolute paths from `tempfile`…" | path: `src-tauri/CLAUDE.md` |
| 103 | 328 | "Windows Recycle Bin inventory must read `System.FileName`…" (#1208) | path: `src-tauri/src/files/CLAUDE.md` |
| 104 | 336 | "Gate a platform-only Rust test module as a whole…" (#1179) | path: `src-tauri/CLAUDE.md` (pointer from `tests/CLAUDE.md`) |
| 105 | 343 | "PTY output and exit notifications…" + "Use private XDG config/data/cache directories…" | path: `src-tauri/CLAUDE.md` |
| 106 | 357 | "When a bug resists quick diagnosis…" | root |
| 107 | 359 | "The unit suite defaults to four workers…" | path: `tests/CLAUDE.md` (+ `check:e2e:tauri` sentence in `e2e-tauri/CLAUDE.md`) |
| 108 | 365 | "For Windows native transfer waits…" | path: `e2e-tauri/CLAUDE.md` |
| 109 | 370 | "Native Git-watch readiness probes read `e2eGitWatches`…" (#1254) | path: `e2e-tauri/CLAUDE.md` |
| 110 | 376 | "A peek without its own directory lease…" (#1260) | path: `e2e-tauri/CLAUDE.md` |
| 111 | 382 | "`createWindowTabsManager().dispose()` is asynchronous…" (#611) | path: `tests/CLAUDE.md` |
| 112 | 385 | "Video frames in `PreviewPane.svelte` come from `getVideoThumbnailData`…" (#607, #664) | path: `src/lib/state/CLAUDE.md` |
| 113 | 393 | "CSV previews must parse the complete bounded read…" (#666) | path: `src/lib/components/CLAUDE.md` |
| 114 | 398 | "The floating update notice uses the shared `modal-card`…" | path: `src/lib/components/CLAUDE.md` |
| 115 | 402 | "Linux removable-volume discovery combines…" (#677, #888) | path: `src-tauri/src/files/CLAUDE.md` |
| 116 | 419 | "ADR 0025 governs Linux volume mount authority…" | path: `src-tauri/src/files/CLAUDE.md` |
| 117 | 428 | "Git Graph author avatars keep display preference separate…" | path: `src/lib/components/git-graph/CLAUDE.md` (ADR reference corrected from 0026 to 0027, the avatar-cache ADR); its last sentence ("Native graph fixtures must wait…") also in `e2e-tauri/CLAUDE.md` |
| 118 | 445 | "Never size painted layout from a ResizeObserver measurement…" (#1061) | path: `src/lib/components/CLAUDE.md` |
| 119 | 447 | "Git Graph PR mutations use `git_pr_action`…" (ADR 0005, 0006) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 120 | 460 | "PR CLI subprocess tests must execute the checked-in shell launcher…" (#1626) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 121 | 466 | "GitHub PR mutations (#1082): keep `--repo github.com/owner/name` explicit…" | path: `src/lib/components/git-graph/CLAUDE.md` |
| 122 | 468 | "Graph reference disclosures capture the scroller's actual position…" (#1082) | path: `src/lib/components/git-graph/CLAUDE.md` |
| 123 | 474 | "The native suite's public TypeScript command uses incremental compiler metadata…" | path: `tests/CLAUDE.md` (pointer from `e2e-tauri/CLAUDE.md`) |
| 124 | 479 | "Compiler regression probes resolve TypeScript's CLI…" | path: `tests/CLAUDE.md` |
| 125 | 484 | "### Details image metadata (#994)" (first paragraph) | path: `src/lib/components/CLAUDE.md` (pointer from `src-tauri/src/files/CLAUDE.md`) |
| 126 | 501 | "A virtual cursor jump can unmount the old focused row…" | path: `src/lib/components/CLAUDE.md` |
| 127 | 506 | "Details Length and Resolution are independent keyed columns…" | path: `src/lib/components/CLAUDE.md` |
| 128 | 510 | "### About command (#755)" | path: `src/lib/components/CLAUDE.md` + `e2e/CLAUDE.md` (animations-disabled evidence) |
| 129 | 525 | "File clipboard writes are accepted by the process-wide Rust worker…" | path: `src-tauri/src/clipboard/CLAUDE.md` |
| 130 | 533 | "PR native smoke checks stay Linux-only…" | path: `e2e-tauri/CLAUDE.md` |
| 131 | 537 | "Quick Open cancellation must reach recursive watch admission…" (#1007) | path: `src-tauri/src/files/CLAUDE.md` |
| 132 | 546 | "Recursive recovery must also check live demand…" | path: `src-tauri/src/files/CLAUDE.md` |
| 133 | 551 | "Independent Windows native clipboard probes must await PowerShell…" (#1188) | path: `e2e-tauri/CLAUDE.md` |
| 134 | 559 | "Windows PowerShell 5.1 emits a `ConvertFrom-Json` array…" (#1202) | path: `e2e-tauri/CLAUDE.md` |
| 135 | 563 | "The #1194 smoke artifact reached the PowerShell-ready marker…" | path: `e2e-tauri/CLAUDE.md` |
| 136 | 571 | "Tiles Folder Peek motion probes must control both rAF…" (#1275) | path: `e2e/CLAUDE.md` |
| 137 | 577 | "Spring peek state becomes observable before…" (#1292, #1388) | path: `e2e/CLAUDE.md` |
| 138 | 585 | "List peek stages never move a folder's header…" (#1365) | path: `src/lib/domain/CLAUDE.md` |
| 139 | 591 | "List peek lineage includes the card's outer folder…" (#1330) | path: `e2e/CLAUDE.md` |
| 140 | 596 | "HTML previews use a sandboxed `srcdoc` iframe…" (#1332, #1352, #1361) | path: `src/lib/components/CLAUDE.md`; CSP browser-test sentences → `e2e/CLAUDE.md` |
| 141 | 615 | "Startup bundle accounting is sensitive even to internal refactors…" (#1346, #1357) | root |
| 142 | — | Release flow and versioning rule (new, #1784; renumbering in #1783) | root |

Totals: 142 rows: 36 root (two of them new: Disk usage and the release flow), 106 path-scoped, 0 lesson, 0 deleted.
No rule was deleted: every file, command and identifier the moved rules name
still exists in the tree (`allow-same-origin` is absent by design, since its rule
forbids adding it).

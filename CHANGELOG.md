# Changelog

All notable changes to Tauri Explorer.

## v1.8.0 — 2026-08-09

Live config reload, in-app bug reporting with image attachments, git session undo, and a large git-graph/SCM feature batch.

### Added

- **Config edits apply without a restart** — external changes to `settings.json`, user themes, bookmarks, and folder views hot-reload into the running app, including symlinked config targets; invalid JSON surfaces a toast instead of silently reverting (#599, #613, #626).
- **In-app bug & feature reporting** — Command Palette → "Report Issue" (or Alt+I) pre-fills OS/app info, submits optimistically in the background with a progress toast, supports image and clipboard-screenshot attachments, and saves a retryable draft on failure (#553, #569, #587, #596, #597).
- **Git session undo** — merge, pull, branch/tag delete, and branch rename record an undo snapshot re-verified before the inverse runs; Ctrl+Z from the graph (#574).
- **Compare any two commits** in the git graph as a tree-to-tree diff, with per-file patches in the preview pane (#629).
- **PR conversation/review threads** rendered inline from a PR badge, alongside an inline CI check-log viewer for failed checks (#633, #576).
- **Branch tracing** — hovering or selecting a commit highlights its branch lineage through the graph; Ctrl+Up/Down jumps along the same branch line (#573, #540).
- **Git graph file-path filter** (#551), **bulk-hide remote-only branches** (#541), **mute base-update merges into open PR branches** (#637), and a **persistent detached-HEAD indicator** (#543).
- **Git actions in the command palette** (#575).
- **SCM: hunk-level stage/unstage/discard** in the diff view (#563), **per-file commit history** (#568), **fuzzy filter** in the staging sidebar (#539), and **archive-or-trash for untracked files** (#550).
- **Pane focus hotkeys** — Alt+L/P/;/' move focus between panes (#537).
- **Active directory shown in the OS window title** (#552).
- **Google Drive mounts discovered on Linux**; removable drives enumerated from the mount table (#630).
- **One-command Windows source install** — `windows_install.ps1` (#581).

### Improved

- **Tiles-view thumbnail scrolling no longer janks** — decode gating and pipeline diagnostics eliminate long frames during fast scrolls, with a CI regression guard (#593).
- **Hover feedback on file entries, sidebar, and tabs is immediate** — CSS transition settling no longer reads as input latency (#628).
- **Git status on slow/network mounts** — per-entry probes are skipped, abandoned scans cancelled, and badge status no longer takes git index locks (#556, #565, #566).
- **Git graph stays responsive across tab switches** and pins the checked-out branch lane leftmost (#621, #542).
- **Quick Open debounces recursive backend searches** so large trees don't compete with typing (#615).
- **Watcher refresh cadence adapts to slow listings** (#620).
- **Shorter relative dates** in the file list ("now"/"5m"/"2h") (#549).

### Fixed

- **Duplicate theme ids, dialog mount crashes, and lazy-dialog chunk-load failures no longer soft-lock the app or its hotkeys** (#584, #585).
- **Terminal-hosted apps own their keys** — only the core-navigation allowlist stays with the explorer, chord prefixes included; Alt+M T remains available from terminal focus (#583, #618).
- **Markdown preview headings and links are coloured** per theme (#612); tall images fit the preview pane (#579); zoomed image panning is smooth (#639); fullscreen preview expands correctly from top/bottom docks (#631).
- **Ctrl+Home/End navigate the file list** (#632); **Copy Path works from the context menu** (#617); **Recycle Bin appears in the sidebar** (#616).
- **Miller columns refresh after folder mutations** (#623); **new windows focus the address bar** (#622); **macOS context-menu placement under zoom** (#627).
- **Git repository folder markers are validated** before decorating (#619); the repo icon no longer leaks into tab titles (#534).
- **Tab-state localStorage writes are coalesced off the interaction path** (#535).

## v1.7.0 — 2026-07-19

Inline git commit panel, PR details in the git graph, and a dockable preview pane.

### Added

- **Inline stage/unstage/commit panel** on the uncommitted-changes row in the git graph — stage individual files or groups, edit the commit message, and commit without leaving the graph (#466).
- **PR details dropdown in the git graph** — clicking a PR badge now opens an in-app dropdown with the PR body and recent comments, CI-status colors, and review/comment-count icons, instead of only linking out to GitHub (#468).
- **Dockable preview pane** — dock to the right (default), bottom, or top edge via a palette command or hotkey (Alt+Shift+P), plus an auto-dock mode that picks an orientation based on window size (#460, #467).
- **Git-repo folder icon** in the file list marks directories that are git repositories (#463).
- **"Mute merge commits" toggle** in the git graph header dims merge-commit rows to cut visual noise when skimming history; today's commits also get compact relative dates ("now"/"5m"/"2h").

### Improved

- **Git graph font size follows the explorer pane's font size** setting instead of a fixed size (#465).
- **Git-repo tab-title decoration is on by default** (#471).
- **Details view no longer renders every row on large directories** — a missing `min-height: 0` defeated virtualization, so a 5000-entry directory rendered all 5000 DOM nodes instead of the ~30 visible ones; fling-scrolling now produces zero long tasks instead of over a second of blocked time (#469).

### Fixed

- **Leading blank line trimmed from git graph commit messages** (#464).
- **`mac_install.sh` builds from source** instead of downloading a prebuilt release, fixing a hard failure on Intel Macs (only an arm64 asset ever shipped) (#462).
- **Committing with nothing staged now errors** instead of silently creating an empty commit, matching real git behavior (#466).
- **The commit panel's in-flight guard is un-defeatable** — Escape-and-reopen mid-commit could previously start a second concurrent commit; the "Uncommitted Changes (N)" count no longer goes stale on a partial stage (#466).
- **Mock load-repo fixtures are now opt-in** behind a query param instead of always injected, fixing E2E flakiness in list/tiles view modes (#472).

### Housekeeping

Nix flake for the dev shell and release builds (#470); fsync-safe test wrapper for slow-flush drives; Windows Tauri E2E leg moved to manual-only after chronic CI hangs; several e2e flake fixes (preview-pane bounding-box race, paste-spec baseURL usage, view-switch helper click targets).

## v1.6.0 — 2026-07-18

Pane-island polish, GitHub PR badges in the git graph, and a one-command macOS installer.

### Added

- **Open-PR badges in the git graph** — a branch with an open GitHub pull request gets a purple `⇄ #N` chip beside its ref chips (grey for drafts); clicking it opens the PR in your browser. Works off the repo's GitHub remote with a short-lived cache, respects `GITHUB_TOKEN`/`GH_TOKEN` for higher rate limits, and quietly shows nothing for non-GitHub remotes or offline machines (#449).
- **One-command macOS install** — `curl -fsSL https://raw.githubusercontent.com/xnmp/tauri-explorer/main/mac_install.sh | bash` downloads the latest DMG, installs to /Applications (sudo only if needed), and clears the quarantine flag that made the un-notarized app report as "damaged" (#453).

### Improved

- **Each split pane is its own island in island mode** — the container island steps aside and every pane floats separately with the standard inter-island gap; the active pane keeps its accent border. In normal mode the divider between panes is now clearly visible instead of a near-invisible hairline (#448).

### Fixed

- **Git graph background matches the explorer pane** — the graph no longer paints its own opaque surface over the pane, so it follows the content-opacity setting and island-mode transparency like every other pane view (#450).

## v1.5.0 — 2026-07-18

A git-graph correctness and speed overhaul driven by an adversarial architecture review, per-pane SCM, and a batch of quality-of-life features.

### Fixed

- **Pull (and every graph action) now updates the git graph** — the graph had three competing refresh triggers and silently dropped a refresh that arrived while a load was in flight, so a pull could settle on pre-pull state forever. One generation-counted `reload()` with a dirty-flag re-run replaces them; an action's own change notification no longer double-loads the graph (#432).
- **F5 refreshes the git graph even when the terminal is focused** — function keys now fall through the terminal's key gate to app bindings, and the graph's F5 is a real registered command scoped to the active pane instead of a hidden window listener (#432).
- **Remote branches can be checked out as local tracking branches** — right-clicking a remote chip offers "Checkout `branch` (tracking `origin/branch`)" instead of only a detached checkout; ref identity is preserved through the graph's chip model (#432).
- **Commits are no longer silently skipped when paging past a stash** — paging now keys on a real-commit cursor instead of the returned row count, which over-skipped by the number of woven stash rows (#432, #431).
- **Only the checked-out branch is highlighted when several branches sit on HEAD**; detached HEAD highlights none (#433).
- **No more white focus rings on the selected commit and tab titles after F5** — F5's keyboard interaction promoted the click-focused row to `:focus-visible`; transient focus is dropped on refresh while keyboard-Tab rings remain (#433).
- **Miller columns no longer render twice in island mode without a sidebar** — both render sites now consume one shared `islandMode` derived (#434).
- **The SCM panel docks flat inside the explorer pane** like the miller bar instead of floating as a hover card; island chrome is opt-in per surface, not implied by vibrancy (#434).
- **Memory leaks fixed**: per-pane SCM stores are now disposed when panes close (the map previously grew one entry per pane ever opened), panel-resize document listeners survive mid-drag unmounts, plus a window-tabs focus listener and a breadcrumb debounce timer (#439).
- **Downvoting a Quick Open result no longer kills keyboard input**, and the downvote button stays out of the modal's Tab order (#438).

### Improved

- **Git graph is much faster** (#431): the author filter went from a per-branch 2000-commit revwalk (re-run on every popover open) to a single cached walk over all tips; a shared per-repo status fetch with in-flight dedup replaces 2–3 full working-tree scans per change event; commit file lists are LRU-cached so re-clicking a commit is instant.
- **Git graph shows a loading spinner** when scrolling loads more commits (#433).

### Added

- **New File in the context menu** — create an empty file with inline naming (like New Folder) in all three views, plus a `file.newFile` palette command (#436).
- **Quick Open downvote** — Ctrl+Delete or the hover button demotes a result by halving its recorded accesses; ranking recovers naturally if you open it again (#438).
- **Per-pane SCM panel** — in split layouts each pane toggles its own SCM panel; the global setting is now just the default for new panes (#434).
- **"F5 also syncs local branches" setting** — the graph's refresh can fetch and fast-forward behind local branches, reporting diverged ones in a toast and never touching them (#432).
- **Premium theme effects are now opt-in** — the aurora-style surface treatment added to all themes in v1.4.2 sits behind a "Premium Theme Effects" toggle, restoring the flatter high-contrast look as the default (#437).
- **Terminal panel header shows a terminal icon** instead of a text title (#435).

## v1.4.2 — 2026-07-14

A big WSL/Windows correctness pass, a rebuilt git-graph filter, and a premium surface treatment for every theme.

### Fixed

- **Terminal cd sync speaks the spawned shell's dialect** — a pane inside `\\wsl.localhost` spawns a WSL (POSIX) shell, but cd syncs were sent in cmd.exe syntax with an ESC clear-prefix that zsh read as a meta key, eating the `c` of `cd` (`zsh: command not found: d`). The backend now reports what it actually spawned, paths translate both directions (`/home/…` ↔ `\\wsl.localhost\…`, `/mnt/c` ↔ `C:\`), and resizing the panel can no longer flood the shell with cds.
- **Explorer no longer errors on WSL terminal startup** — the shell's reported cwd (`/home/user/...`) was treated as a Windows path (`unable to find folder: \home\user\...`); it now maps back to the distro's UNC share.
- **Cmd+C/Cmd+V work in the terminal on macOS** — they copied/pasted _files_ in the explorer instead of terminal text.
- **Terminal selection aligns under app zoom** — the panel counter-zooms to net 1.0 and scales the font instead, so xterm's pointer math is exact.
- **Home/End work at the mac prompt** — default bindings (clearable in Settings) map Home/End and Option+←/→ to line-start/end and word moves.
- **Quick Open finds folders in WSL repos** — the walk from Windows crossed the 9P network boundary once per directory, so build-output folders like `target/release/bundle/deb` effectively never arrived; WSL roots now delegate the walk to the distro's native `find`.
- **Windows no longer opens in `C:\Program Files\tauri-explorer`** — a launch cwd equal to the install directory is discarded in favor of home.
- **Shortcuts work immediately after Alt+Tab on Windows** — the app re-asserts webview keyboard focus on window activation (WebView2 quirk).
- **Toasts render in git-graph mode** — the toast overlay was mounted inside the file list, so graph-mode actions (including F5 refresh) gave no feedback at all; it now lives at the app root and F5 shows "Refreshing graph…" → "Fetched from remotes".
- **Clipboard paste error toast** — no more "[object Object]", and a failed file-list probe no longer flashes an error when the paste succeeds another way (e.g. pasting an image on macOS).
- **Active-tab fillet hairline** — the stroke ring now holds a solid 1px core, so the right corner can't render a pixel short at unlucky tab widths.
- **Git graph re-entry is instant** — filtered views are snapshot-cached too (keyed by repo + filter), so going BACK into a large repo paints from cache instead of re-running the whole filtered log.

### Added

- **Git graph filter overhaul** — a select/deselect-all checkbox, themed author checkboxes (ticking an author toggles every branch they created), replacing the unthemed native dropdown.
- **Git graph detail options** — hash/parents/author/date in the commit detail block are hidden by default (toggle "Details metadata" in the header menu); "Parent" is a new optional column.
- **Git graph action modals** — Reset and Delete Branch suboptions open a modal instead of hover-cascading submenus; right-clicking a branch badge scopes Delete Branch to that badge.
- **Terminal shortcut recorder** — bind line-editing shortcuts by pressing keys (Backspace clears, Esc cancels), with new word-left/word-right actions.
- **Premium surface treatment for all themes** — Aurora's accent-tinted hairlines, glow shadows, breadcrumb pills and focus rings ported to every theme as pure CSS variables; dark themes gain a static accent backdrop with gently translucent surfaces. Zero runtime cost (the animated starfield stays Aurora-only).
- **Miller columns as their own island** — in floating-islands mode without a sidebar, on every platform (previously macOS vibrancy only).

### Performance

- **SCM panel is instant on `\\wsl.localhost` repos** — status and diff delegate to the distro's native `git` (warm stat cache) instead of libgit2 re-hashing every tracked file across the 9P network boundary; stage/unstage/commit are unchanged and everything falls back to libgit2 if `wsl.exe` fails.

## v1.4.1 — 2026-07-14

Correctness fixes for Windows and WSL repos, plus a snappier paste.

### Fixed

- **Fullscreen preview no longer shows the app behind it** — in island modes (Windows Mica/Acrylic, macOS vibrancy, floating islands) the fullscreen surface painted nothing, so the sidebar and file list stayed visible behind the image and it read as a second preview.
- **The SCM panel stops inventing modified files on Windows** — two causes, same dead-end row: the POSIX exec bit Windows can't read (a Linux-created repo's `core.filemode = true` marked every executable as modified), and CRLF working trees whose diff is empty once the line-ending filter runs. Entries whose diff has nothing to show are now dropped on Windows, so the panel agrees with `git status`; on Linux a `chmod` is still a real change.
- **Diffs survive background refreshes** — repos on `\\wsl.localhost` are polled every 3s, and each poll used to cancel the diff request in flight; on a slow share the preview flashed a spinner forever and settled on "No changes to display". An open diff now loads once, stays visible while it re-verifies, and never wedges on a spinner.
- **Quick Open can reach build-output folders** — `target`, `node_modules`, `dist`, `build` and `out` were pruned outright, so nothing inside them was findable (Ctrl+P for `nsis` never found `target/release/bundle/nsis`). They are now searched in a deferred second pass, ranked below source files so artifacts can't crowd them out.
- **Quick Open always finds the cwd's own entries** — direct children of the current folder are matched even before the backend walk returns.
- **Sidebar SCM diffs reach the preview pane** — clicking a change in the sidebar's SCM view opened a diff the preview pane never read.
- **SCM panel live updates** — watcher key symmetry plus polling for repos on UNC paths, so the panel refreshes on git changes from outside the app.
- **Git graph merge edges** — stretched merge edges now cross out of the child dot immediately.

### Added

- **Relative times for today's commits in the git graph** — "2h ago" instead of a timestamp for commits from the last day.

### Performance

- **Snappier paste** — the size estimate runs concurrently, entries appear incrementally, and the toast lands earlier.

## v1.4.0 — 2026-07-13

A git-graph feature wave plus theme, terminal, and Windows fixes.

### Added

- **Git graph: live and navigation-aware** — the graph watches its repo and refreshes immediately when git state changes (a pull from the terminal, a commit from another window), and it follows directory changes: navigating within the repo keeps it, into another repo retargets it, out of any repo returns to the file listing.
- **Git graph: F5 fetch + palette command** — F5 refreshes the graph including a `git fetch --all --prune`; "Git: Fetch from Origin" is available from the command palette in any repo folder.
- **Git graph: delete branch** — safe delete, force delete, and delete-plus-tracking-remote from the commit context menu; remote-only branches get their own delete item.
- **Git graph: hideable columns** — right-click the header to toggle Author/Date/Commit (persisted).
- **Git graph: filter branches by author** — the branch popover gains an author dropdown; the author is the branch creator (first commit unique to the branch).
- **Git graph: remote-only branches marked** — dashed outline + cloud glyph on branches with no local counterpart, and a "Local branches only" toggle in the branch filter.
- **Git graph: diffs in the preview pane** — with the preview pane open, clicking a file in a commit's details shows the diff there (with a commit-sha badge) instead of inline.
- **Checkout offers a pull** — checking out a branch whose remote is ahead offers a fast-forward pull.
- **Themes: Catppuccin (Mocha), Nord, Gruvbox** — canonical palettes, auto-discovered by the theme picker.
- **Terminal: configurable line-editing shortcuts** — bind Home/End/Alt+Backspace/Ctrl+U (and more) to shell line-editing actions in Settings → Terminal; unbound keys keep native behavior.

### Fixed

- **Git graph branch colors** — a branch line's tail no longer flips to another branch's color where it merges; branch tips always get their own color.
- **Git graph startup** — the graph paints as soon as the commit log arrives instead of waiting for a full working-tree status scan (seconds on large repos).
- **Repo cache identity** — repo roots are reported without a trailing separator everywhere, so the same repo can't carry two cache identities.
- **Fast tab switching with the terminal** — the injected-cd echo tracker now counts duplicates and normalizes paths, so rapid A→B→A switches can't drag a tab (or its git graph) to a stale directory.
- **Terminal Ctrl+C / Ctrl+V** — Ctrl+C copies the terminal selection when one exists (interrupt otherwise); Ctrl+V pastes reliably through xterm's bracketed-paste path.
- **Tab bar polish** — tightened padding around the close button; the active tab's fillet hairline now joins the vertical and baseline hairlines seamlessly; floating-islands mode renders tab fillets again.
- **Windows: terminal in WSL folders** — panes inside `\\wsl$\…` spawn `wsl.exe` in the equivalent Linux directory instead of a shell that can't use UNC working directories.
- **Windows: fullscreen preview** — no longer clipped to the preview island (the app stayed visible around the image).
- **Windows: git panel** — the changes list no longer comes up empty (path-separator mismatch in the directory filter).
- **Windows: backdrop translucency** — islands are translucent over Mica/Acrylic at the Backdrop Opacity slider's strength instead of fully opaque, so the native material actually shows through.

## v1.3.3 — 2026-07-13

A macOS polish patch.

### Fixed

- **macOS app icon** — macOS 26 (Tahoe) rendered the old padded icon shrunken on a grey system tile. The icon now ships at full frame with its own silhouette (the same artwork the Windows Store logos use), so the dock shows it correctly without manual fixes.
- **Install instructions** — Homebrew removed `--no-quarantine`, and right-click → Open no longer bypasses the "damaged" dialog for un-notarized apps on macOS 15+. The README and cask caveat now give the working command: `xattr -r -d com.apple.quarantine /Applications/tauri-explorer.app` (run right after install). Proper notarization is planned.

## v1.3.2 — 2026-07-13

A distribution + git-workflow release: the app gets a proper bundle identifier and install channels (AUR, winget, Homebrew), and the git tooling grows into a real multi-repo workflow — per-pane panels, a filterable graph, and resizable columns.

### Added

- **Per-pane git panels** — each pane's Source Control panel now follows its own directory, so two panes open on two different repos show independent staging areas, commit boxes, and status. Repo watchers are reference-counted, so panes (or windows) sharing a repo no longer disturb each other's live updates.
- **SCM panel alongside the commit graph** — opening the git graph no longer hides Source Control; working-tree changes and history are visible side by side.
- **Branch filter in the git graph** — a VS Code-style branch popover (text filter, per-branch checkboxes, hover "only", "All branches") shows just the branches you care about; the history walk happens repo-side, and the selection persists per repo.
- **Resizable git graph columns** — a new header row (Message / Author / Date / Commit) with drag handles; the graph lane gutter can be pinned to a fixed width so deep histories can't squeeze out the commit messages. Widths persist.

### Changed

- **New bundle identifier `io.github.xnmp.tauri-explorer`** (was `com.explorer.app`). macOS treats this as a new app identity: window tabs and quick-open history reset once after upgrading (settings are unaffected — they live in a version-independent location).
- **Install channels**: AUR (`tauri-explorer-bin`), winget (`xnmp.TauriExplorer`), and a Homebrew cask (`xnmp/tap/tauri-explorer`) are packaged in-repo; README lists all install options.
- Frontend toolchain moved to vite 8 (Rolldown), vitest 4, and TypeScript 5.9; Rust dependencies refreshed (tokio 1.52, chrono, trash, opener, icns). No user-visible changes expected.

### Fixed

- Website download links now track the released version.

## v1.3.1 — 2026-07-12

A hardening release: two new safety features, a faster feel in git repos and large folders, security fixes, and a very large investment in test coverage and regression guards.

### Added

- **Merge-conflict handling in Source Control** — when a merge, rebase, cherry-pick, or revert leaves conflicts, the panel shows an in-progress banner with the conflict count and one-click **Abort** (plus **Continue** for rebases). Committing is blocked until conflicts are resolved, and discarding a conflicted file no longer risks silently deleting it from disk.
- **Frontend crash capture** — uncaught webview errors are now recorded locally exactly like Rust panics and surface in the next-launch crash notice; **Report a Bug** pre-fills the issue with a recent log excerpt. Everything stays local and opt-in — nothing is ever sent automatically.

### Improved

- **Git feels instant**: entering a repo pre-warms the git graph and Source Control caches in the background, so opening either paints immediately instead of "Loading history…".
- **Large flat folders list faster** — per-file metadata lookups now run in parallel.
- **Faster startup, smaller bundle** — cold-start dialogs (Quick Open, Command Palette, content search, conflict, jobs, file picker) load on demand; main chunk gzip down ~5.7%.
- **Website**: the demo Explorer window now floats with a margin, rounded corners, and shadow instead of filling the page edge-to-edge.

### Fixed

- **Security hardening**: zip extraction now rejects archives whose declared total size would fill the disk (zip-bomb guard), and the asset-protocol scope no longer exposes plugin API-key files or browser profile data to the webview. Side effect by design: remote images in Markdown previews are blocked by CSP and render as links instead.

### Internal

- Test & tooling sweep: outcome-asserting E2E coverage for git-graph actions (reset/cherry-pick/revert/merge/rebase/tag), bulk rename, conflict-dialog branches, jobs panel, clipboard paste, address bar, and the most defect-prone stores (571 E2E tests total); mock↔backend contract tests so the browser mock can't drift from the Rust backend; tiered merge gating (@smoke tags + affected-by-diff selection); Criterion perf benches and a bundle-size budget; a non-blocking architecture linter enforcing layering rules; plugin workspace-API seam and layering refactors; accessibility warnings triaged to zero; weekly Dependabot updates.

## v1.3.0 — 2026-07-11

### Added

- **Upscale plugin** — right-click a JPG/PNG/WebP → "Upscale Image" runs ByteDance SeedVR2 on fal.ai (2-4×) and drops the result next to the original, with jobs-panel progress and toasts. API key lives in plugin settings (or the `FAL_KEY` env var).
- **Floating Islands on every platform** — the island layout (rounded floating panels) is no longer gated behind macOS vibrancy / Windows Mica. A new Appearance toggle enables it anywhere; without native transparency the backdrop gets a themed depth gradient instead. Structural surfaces (sidebar) now read as a heavier material than content islands, and `prefers-reduced-transparency` is honored.

### Improved

- Clipboard failures now tell you why: a missing `wl-clipboard`/`xclip` surfaces as a toast ("copy works in-app, but the system clipboard failed…") instead of a silent no-op copy.
- Architecture sweep (adversarial review, applied): ~600 lines of duplicated plugin-dialog CSS unified; shared Rust plugin-job scaffolding; panel resize/persist logic deduplicated into one composable; tab-title logic extracted from the window-tabs store; `api/open.ts` + `api/system.ts` split out of the IPC grab-bag; dead code removed; +21 new behavior tests for previously untested stores.

## v1.2.0 — 2026-07-11

### Added

- **Per-pane git graph** — Ctrl+Alt+G now toggles the commit graph _inside the active pane_ instead of opening a separate window tab, so a graph can sit right next to a normal explorer pane in a split. Invoking it again from within the graph returns the pane to its file listing. Old saved graph tabs migrate automatically.
- **Drop files on the terminal** — dropping files onto the integrated terminal (or pressing Alt+T with a selection) types their shell-escaped paths at the prompt.
- **Syntax highlighting in diff views** via a shared highlight palette.

### Improved

- **Source Control panel**: summaries are cached per repo (switching panes/tabs no longer refetches and flashes), a loading skeleton shows while the first fetch runs instead of a premature "Not a git repository", row action glyphs are now uniform SVG icons, and hovered actions get a visible highlight (discard tints red).
- **Drag ghosts**: multi-file drags show a fanned stack with a count badge, and every drag ghost (single files included) is translucent so the drop target stays visible.
- **Git graph performance**: windowed rendering for large histories and instant repaint from a per-repo snapshot cache.
- **Active tab polish**: the hairline border traces the fillet curves as one continuous stroke and composites opaquely over the pane surface.

### Fixed

- Terminal: cwd sync no longer races fast tab switches; app shortcuts win over the shell while the terminal is focused; theme switches repaint reliably under WebKitGTK; Alt+M T toggles the terminal instead of only opening it.
- Multi-file drops recover from WebKitGTK's flattened uri-list; Super+Alt pane-split hotkeys work on Linux.
- Thumbnails: cache hits paint full-res immediately and survive layout shifts/remounts.
- Inline new-folder editor renders correctly inside the virtual list; marquee selection tracks the cursor under zoom; folder drop-target highlight no longer blinks; drive letters render as normal breadcrumbs.
- Security hardening: ZIP extraction guards against symlink zip-slip, `open_external_url` is host-pinned, AI job temp dirs are randomized, and vitest/vite were bumped past security advisories.

## v1.1.0 — 2026-07-05

### Added

- **AI rename autocomplete** — start a rename and the AI Rename plugin suggests a better filename right under the box; press Tab (or click the hint) to accept. Same privacy rules as the picker: nothing is sent without your Gemini key, content hint for text files only, and a settings toggle to turn it off.
- **Image preview: click to go front-and-center** — click the image in the preview pane for the fullscreen view (Left/Right step through siblings, +/− and Ctrl+wheel zoom, Esc or another click reverts).
- **Git graph, VSCode-parity pass** — commit details now expand inline below the clicked row (the graph stretches around them); clicking a changed file shows its diff right there; the synthetic _Uncommitted Changes_ row is clickable too (staged files badged). Default shortcut **Ctrl+Alt+G**.
- **Theme from Image plugin** — right-click an image (or "Create Theme from Wallpaper") → median-cut palette → a generated theme in your themes folder, applied immediately.
- **VSCode-style Source Control panel** — compact rows, right-edge colored status letters, inline dimmed paths, pill count badges, primary Commit button.
- Command palette matching is token-based and word-order-agnostic ("git graph" and "graph git" both work), and a "Set Current View Mode as Default" command replaces the old implicit behavior.

### Fixed

- Context menus opened away from the cursor while zoomed (both the file menu's keep-on-screen clamp and the git-graph menu); now regression-guarded by a dedicated zoom E2E suite.
- Changing one pane's view mode no longer silently rewrites the global default.
- Terminal output no longer races listener registration on startup.
- Filesystem-watcher creation failure (e.g. inotify exhaustion) degrades to no live refresh instead of crashing the app at startup.
- Removed the one-time "Everything here is a keystroke away" panel.

### Security (pre-launch audit, all tiers implemented)

- Image decoding is hard-capped (16384px / 256MB / 200MB file) at every decode site — a crafted image header can no longer OOM the app.
- The Nano Banana integration no longer runs gemini with `--yolo`: tool auto-approval is restricted to `edit_image`, and filenames are staged under neutral names so they can never inject into the model command.
- Asset-protocol scope now denies credential directories (`.ssh`, `.gnupg`, `.aws`, …) on every platform; CSP tightened (`object-src 'none'`, `base-uri 'self'`); update-check URLs pinned to github.com; crash reports written `0o600`.

## v1.0.1 — 2026-07-05

### Fixed

- **macOS: app crashed instantly at launch** — Windows-only glob patterns in the asset-protocol scope broke scope parsing on macOS (caught by the new macOS launch-smoke CI). Scopes are now per-platform. If you tried v1.0.0 on a Mac, this is the release that actually opens.
- Marquee selection lost when releasing the mouse before the next animation frame (surfaced by the new WebKit test suite; timing-dependent on all platforms).

### Added

- Fuzzy quick-open (Ctrl+P) inside the system file-picker window (Linux portal mode).
- CI: full e2e suite under WebKit (macOS webview proxy), macOS launch smoke, real-binary Windows/Linux specs for clipboard round-trip and theme switching.

## v1.0.0 — 2026-07-05

First stable release.

### Added

- **Crash reporting (local only)** — panics are saved to `<log dir>/crashes/`; the next launch offers a pre-filled GitHub issue. Nothing is ever sent automatically.
- **Update checker** — once a day, a small notice appears when a newer release exists (notification only, no auto-download).
- **Keyboard shortcut cheatsheet** — `Ctrl+/` (or "Keyboard Shortcuts" in the palette) shows every live binding, including your custom rebinds.
- First-run hint pointing at `Ctrl+P` / `Ctrl+Shift+P`.
- MIT `LICENSE` file, README badges, CHANGELOG.

### Security

- Config files (which can hold plugin API keys) are written with owner-only permissions on Unix.
- AI plugins accept the `GEMINI_API_KEY` environment variable so the key never has to be stored on disk.

### Known limitations

- Binaries are not code-signed yet: macOS Gatekeeper and Windows SmartScreen will warn on first launch.
- Updates are manual (download from Releases); a built-in updater is planned.

## v0.9.0 — 2026-07-04

- Git graph parity polish: continuous branch curves, stash tracking, combined local+remote ref chips with up-to-date indicator, uncommitted-changes row, complex-merge rendering (#179).
- More prominent Chrome-style tab fillets (#157).

## v0.8.0 — 2026-07-04

- Git graph context actions: checkout, merge, rebase, create branch/tag, cherry-pick, revert, reset, copy hash (#173).
- Chrome-style live window detach when dragging tabs out (#176).
- Feature flags for terminal and git graph (#175).
- Streaming, cancellable large copy operations; large zip/unzip hardening (#174).
- Tab fillets curve into the pane like Chrome (#157).

## v0.7.0 — 2026-07-04

- Per-pane tabs with drag-and-drop between panes and windows (#140).
- Git commit graph view (#51/#56/#57/#58).
- Integrated terminal panel (#150).
- Virtualized List and Tiles views for large directories (#128).
- Git panel improvements (#156), adversarial-testing fixes (#167).

## v0.6.0 — 2026-06-25

- Command palette polish, quick open frecency, workspace management.
- Nano Banana and AI rename/organize extracted into plugins (#144/#145).

## v0.5.0 — 2026-06-24

- Plugin system, content search improvements, theme system expansion.

## v0.4.0 — 2026-06-13

- Windows support hardening (paths, clipboard, cross-device moves).
- Linux desktop portal (system file picker) backend.

## v0.3.0 — 2026-04-20

- Dual-pane mode, Miller columns, preview pane.

## v0.2.7 — 2026-03-11

- Details/List/Tiles views, fuzzy quick open, ripgrep content search.

## v0.1.0 — 2026-03-11

- Initial release: Tauri v2 + Svelte 5 file explorer with command palette.

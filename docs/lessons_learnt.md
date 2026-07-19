# Lessons Learnt

Gotchas, non-obvious behaviors, and key takeaways from closed issues.

---

## 2026-07-18 fix/touro-usb-hdd-removable: external USB hard drives report DriveType 3 (fixed), not 2 (#430)
- **`Win32_LogicalDisk.DriveType` is 2 (Removable) only for drives with *removable media* — USB flash sticks, SD cards.** A USB *hard drive* (spinning platter or external SSD, e.g. a TOURO) enumerates as DriveType 3, identical to the internal system disk, so classifying by DriveType alone filed it under Fixed even though Explorer treats it as an ejectable removable device. The "drive needs fixing" prompt Windows showed was an incidental dirty NTFS bit, not the cause — the volume still mounted, got a letter, and passed the `Path::exists()` check.
- **The distinguishing signal is the backing disk's *bus type*, not the logical-disk type.** Fixed via `Get-Partition | Where DriveLetter → Get-Disk -Number → BusType`, folded into the existing single `Win32_LogicalDisk` PowerShell call (one process spawn, still polled every 5s). `classify_windows_drive(drive_type, bus_type, letter)` promotes `DriveType 3 && bus == USB` to Removable; DriveType 2 stays Removable regardless. Extracting the pure classifier made the mapping unit-testable (the enumerator itself shells out and can't be).
- Verified against the real box: the query emitted `F:|TOURO||3|USB` (promoted) alongside `C:|||3|NVMe` (stays Fixed) and `G:|Google Drive||3|` (empty bus → its own Cloud branch). Virtual/network volumes have no backing partition and get an empty bus type, so they're untouched.

## 2026-07-18 fix/wsl-git-badge-delegation: delegate ALL git over `\\wsl.localhost` to native git; never open libgit2 first (#425, #426)
- **The badge path (`files/git_status.rs`) shelled Git-for-Windows over the 9P mount — 26-33s for a SMALL repo under startup contention (rev-parse alone 16-17s).** The SCM panel already delegated status to WSL (`git.rs::wsl_status`, 0.5s) but the badges didn't. Fix: when `parse_wsl_unc` matches, run both `rev-parse --is-inside-work-tree --show-prefix` and `status --porcelain -z -unormal .` via `wsl.exe -d <distro> --exec git -C <linux_path> …`. Measured after: keifu badge 324ms (was 26-33s), open-webui badge 1.54s.
- **`open_repo` on a UNC path is itself a 9P discovery walk, and it ran BEFORE the delegation could kick in.** `git_status`/`git_diff`/`git_repo_root` opened the repo with libgit2 first, then delegated — paying the slow part regardless. Restructured to `parse_wsl_unc(input)` and delegate DIRECTLY, using libgit2 only as fallback. `git_status` op-state (which needed `repo.state()`) is now read by stat-ing `.git` marker files over the UNC mount (cheap: a few single-file stats, not a tree walk). Measured: open-webui SCM status **197ms delegated vs 182.45s libgit2** over 9P.
- **Native Linux git has no "dubious ownership" problem, so a clean non-zero exit that says "not a git repository" is authoritative** — return not-a-repo immediately rather than falling back to a redundant (slow) 9P check. Only a real mechanism failure (spawn error, or wsl.exe failing to launch the distro) should fall back. Distinguish by matching the git message in stderr.
- **For the non-delegated Windows path, add `-c safe.directory=*` per-invocation.** A default git config (no global `safe.directory`) refuses a WSL-owned repo browsed over UNC with "dubious ownership" (exit 128), which the app then silently reported as "not a repo". Safe here because these are read-only status commands.
- **Two consumers raced identical startup fetches** (`gitStatusStore`): a logging-only in-flight Set from #424 detected it but didn't prevent it, spawning duplicate IPC → many "Git for Windows" processes, ~1GB RAM. Real dedup = a `Map<path, Promise>`; a second request for an in-flight path awaits the SAME promise.
- **The UNC PollWatcher (native fs events don't cross 9P) re-stats the whole tree every tick** — a 3s interval reintroduces exactly the 9P load the delegation sheds. Bumped to 15s for UNC roots only (a WSL repo only changes from inside WSL, not via high-frequency edits over the mount).
- The WSL distro cold-boots when idle: the first `wsl.exe` call after a pause can take 5-30s (not the delegation's fault). Warm it (`wsl.exe -d <distro> --exec echo`) before timing, or the first real call eats the boot.

## 2026-07-18 fix/local-tests-navigator-platform: Node/Bun now ship a real-OS `navigator` global
- **Node 22 / Bun 1.3 expose a built-in `navigator` whose `platform` reflects the actual host OS**, so browser-only platform sniffing (`isWindows` in domain/platform.ts) is live inside vitest's Node environment too — and real local Chromium reports `Win32` anyway. Any `isWindows`-gated logic (here: backslash path normalization from aebf309) silently diverges from the POSIX-keyed mock fixtures on a Windows dev machine, failing every mock-based unit and e2e test locally while ubuntu CI stays green. Pin `navigator.platform` in `tests/setup.ts` and via the `e2e/fixtures.ts` wrapper (all specs import `test`/`expect` from there, not `@playwright/test`).
- A green CI + red local (or vice versa) split on identical commits means an environment input differs — find the input (runtime globals, OS, locale) before touching product code or tests.

## 2026-07-18 fix/quickfind-deferred-exact-match: penalties must not apply to exact matches
- **`DEFERRED_PENALTY` subtracted from an exact name match buried `target/release/bundle/deb` below 20 fuzzy `debug*` matches** — the backend emits only the top-`limit` scored results, so the frontend can't rescue anything the backend drops. When a scoring penalty exists to demote noise, exempt exact matches: they are the query's literal target. Same family as the #393 `nsis` divisor bug; a subtraction just buries shallower.

## 2026-07-17 fix/quickfind-wsl-deep-folders: `wsl.exe -- cmd` runs through the distro user's login shell
- **`wsl.exe -d <distro> -- find ...` joins the argv into a login-shell command line**, so an interactive shell like zsh interprets `find`'s metacharacters (`(`, `)`, `-name .*` → "unknown file attribute", exit 1, zero output) and the delegation silently produced nothing — Quick Open fell back to jwalk over 9P and deep entries never surfaced. Use `wsl.exe --exec` for literal argv with no shell. Also treat non-zero-exit-with-zero-output as delegation failure and log the child's stderr — the original bug was invisible because stderr was piped to null.
- Verifying "the fix works" at the function level is not the same as the user running it: the fix sat unmerged on its branch while the installed v1.4.2 binary still had the old code path, so it "didn't work" for reasons that had nothing to do with the code. Check what build the reporter is actually running before re-debugging a fixed bug.

## 2026-07-14 fix/windows-scm-diff-preview-pane: per-pane stores need a story for pane-less surfaces
- **Keying stores by pane context breaks silently for components that live OUTSIDE any pane.** The sidebar SCM view has no pane context so it wrote diffs to the "default" store, while the preview pane read the ACTIVE pane's store — sidebar clicks showed nothing, and the per-pane panel working masked it. When a reader and writer must rendezvous through a keyed store, either share the key derivation or have the reader scan the candidate stores.

## 2026-07-14 fix/copy-paste-snappier: never gate an operation's start on its progress-bar prerequisites
- **`estimateSize` (a full recursive walk) ran BEFORE the first byte copied**, so big pastes felt frozen before the progress dialog even moved. Kick prerequisite scans off concurrently and let progress degrade gracefully (file-count granularity) until they land. Same family: show optimistic entries per-file, not after the whole batch; toast before the confirming re-list.

## 2026-07-13 fix/windows-fullscreen-preview-edges: backdrop-filter creates a fixed-position containing block on Chromium
- **A `backdrop-filter` (or `filter`) on ANY ancestor turns it into the containing block for `position: fixed` descendants on Chromium/WebView2** — the "fullscreen" preview laid out inside `.explorer` and got clipped by the preview island's `overflow: hidden`, so it only looked broken on Windows. When a fixed overlay must cover the window, suspend ancestor filters for its lifetime (a root attribute like `data-preview-fullscreen` makes that a one-line CSS rule).

## 2026-07-13 fix/windows-git-panel-no-changes: never raw-compare pane paths against git2 paths
- **git2 reports paths with forward slashes; Windows pane paths use backslashes (and drive-letter case varies).** Any raw string comparison/prefix check between the two matches nothing on Windows — the SCM panel filtered every entry out and showed "no changes". Route all such comparisons through `directoryKey`/`sameDirectory` (domain/path).

## 2026-07-13 fix/fast-tab-switch-terminal-races: dedup guards for event echoes must COUNT, not set-membership
- **When you inject N copies of an action and swallow their echoes by key, a Set caps the swallow count at 1.** Fast tab switches injected `cd A` twice (A→B→A); the Set deduped them, so the second OSC 7 echo read as a user cd and dragged the active tab to a stale path. Echo trackers need a counted multiset, and keys need path normalization (the shell echoes `/foo/` for an injected `/foo`).

## 2026-07-13 fix/git-graph-path-color-switches-midway: first-parent edges belong to the child's branch
- **In the commit-graph layout, an edge from a commit to its first parent is the TAIL of the child's branch** — coloring it with the parent's branch color flips the visible line's color mid-path. Only non-first-parent (merge) edges take the merged-into branch's color; and a tip whose only edge joins an existing line still needs its own color allocated or its dot silently renders palette slot 0.

## 2026-07-13 fix/git-graph-slow-startup-large-repos: don't gate first paint on a status scan
- **`git status` (full working-tree scan) costs seconds on big repos; the revwalk costs milliseconds** (17.6ms for a 500-commit page over 12.7k history). Any view that combines "history + working changes" must paint history the moment the log lands and fill the working-changes row in later — awaiting both serially made graph startup look like a history problem when it was a status problem.

## 2026-07-05 fix/terminal-output-race: reserve event ids before spawning emitters
- **Anything that emits namespaced events (`foo-{id}`) must let the client register listeners BEFORE the emitter starts.** terminal_spawn returned the id only after the PTY was live, so the shell's first output (the prompt) raced listener registration and was dropped — terminal opened blank. Same class as the content-search listener-before-invoke race. Fix shape: a `*_reserve_id` command, listeners on the reserved id, then spawn with that id. The CI smoke "flake" was this real bug.

## 2026-07-05 fix/terminal-smoke-flake: PTY tests need readiness gates, not tighter timeouts
- **Never type into a PTY that hasn't prompted.** Keystrokes sent during shell init are silently swallowed (conpty on Windows especially); the test then waits on output of a command that never ran. Gate typing on first PTY output, keep one retry for a keystroke lost right at prompt time, and budget 45s for PTY spawn + rc files on loaded shared runners — 15s flaked on ~4 of 5 CI runs.

## 2026-07-05 fix/macos-boot-glob: platform-foreign glob patterns crash Tauri at boot
- **Asset-protocol scope globs are parsed eagerly at startup, and backslash patterns are fatal on POSIX.** The base `tauri.conf.json` carried Windows drive/UNC scope patterns (`*:\**\*`, `\\**\*`); on macOS `\` is not a path separator, so `**` is not "a single path component" and the app dies at boot with `GlobPattern(PatternError)`. Linux never crashed only because `tauri.linux.conf.json` already overrode the scope. Keep the base scope platform-neutral (`$HOME`, `/tmp`) and put platform patterns in `tauri.<platform>.conf.json` (arrays REPLACE on merge — each platform file must carry its full list).
- Found by the macOS launch-smoke CI job (#192) on its very first run — the app had never been booted on macOS before.

## fix/sidebar-ux-polish (#101): Sidebar toggle, activity bar removal, X button styling

**Key takeaways:**
- With SCM as its own panel, the ActivityBar icon strip became redundant (only one sidebar view: "files"). Removing it and its 48px width reclaims horizontal space. The `sidebar-views.svelte.ts` registry still works but the single-view case no longer needs a tab switcher.
- Toggle commands should check the current state before acting — `Alt+M B` was "show only" but users expect it to toggle (hide if already showing the same view).
- CSS variable fallbacks like `var(--surface-primary, #fff)` can look wrong in dark themes. Use theme-aware variables (`var(--background-card-secondary)`) instead of hardcoded fallbacks.

---

## fix/git-scm-behavioral-fixes (#102): SCM badges, commit, diff toggle, race guard

**Key takeaways:**
- The `gitStatusStore` (file-list badges) and `scmStore` (SCM panel summary) are separate stores. After SCM operations (stage/commit/discard), calling `scmStore.refresh()` only updates the panel. Must also call `gitStatusStore.refresh()` to update file-list badges.
- Implicit behavior (empty Enter → amend) is surprising and dangerous. Require an explicit signal (amend checkbox or Ctrl+Enter) before performing destructive operations like amend.
- When toggling a panel off that owns a sub-view (diff view), close the sub-view too — otherwise it persists in the main content area.
- Async `setActivePath` has a race condition: if called twice quickly, the first `detectRepo` result may apply after the second call already set a new path. Guard with `if (activePath !== path) return` after the await.

---

## feat/git-scm-tree-depth-lines (#97): SCM tree view depth guides and folder actions

**Key takeaways:**
- Svelte 5 `{#each { length: depth } as _, i}` is a clean way to render N elements without a helper array — used for depth guide `<span>` elements at each nesting level.
- `collectPaths()` recursively gathers all descendant file paths from a `ScmTreeNode`, enabling folder-level batch stage/unstage without duplicating the traversal logic.
- Absolutely positioned depth guides (`position: absolute; left: calc(i * 12px)`) inside relatively positioned rows give vertical connector lines that align across siblings without extra wrapper elements.
- Folder action buttons use `opacity: 0` / `opacity: 1` on hover (not `display: none`) to avoid layout shift — the buttons occupy space but are invisible until hovered.

---

## feat/git-scm-own-panel (#96): SCM as independent panel instead of sidebar tab

**Key takeaways:**
- The sidebar view registry (`sidebar-views.svelte.ts`) is pluggable — removing SCM just means deleting its entry from `ALL_SIDEBAR_VIEWS`. The `ActivityBar` and `Sidebar` components automatically adapt.
- The SCM panel is rendered between the sidebar and `PaneContainer` in `+page.svelte`, gated by `showGitStatus && showScmPanel`. This gives it its own resize handle and independent lifecycle.
- E2E tests that opened SCM by clicking the activity bar tab now enable the panel via `localStorage` settings (`showGitStatus: true, showScmPanel: true`) and reload.
- `Alt+M G` now toggles the SCM panel visibility. `Alt+M B` still focuses the sidebar (bookmarks/recent).
## fix/zoom-drag-drop-marquee-broken (#88): Zoom breaks drag-drop hit detection, column resize, and marquee

**Key takeaways — WebKitGTK coordinate spaces with CSS zoom:**

Three APIs use three different coordinate spaces in WebKitGTK when CSS `zoom` is set on the document root:

| API | Coordinate space |
|---|---|
| `MouseEvent.clientX/Y` | Raw viewport (physical pixels, NOT zoom-adjusted) |
| `getBoundingClientRect()` | CSS pixels (zoom-adjusted) |
| `elementFromPoint()` | Raw viewport (same as clientX, NOT zoom-adjusted) |
| `position: fixed` CSS | CSS pixels (zoom-adjusted) |

This means:
- **Marquee (container-relative coords):** Divide `clientX` by zoom first, THEN subtract `containerRect.left`. The formula `(clientX - rect.left) / zoom` is wrong because it mixes coordinate spaces — `clientX` is physical but `rect.left` is CSS.
- **`elementFromPoint` hit testing:** Pass raw `clientX/Y` directly — do NOT divide by zoom. The old code divided by zoom which shifted hit detection to the left.
- **Tauri `onDragDropEvent` positions** are physical pixels: divide by DPR only for `elementFromPoint`, divide by DPR AND zoom for `position: fixed` CSS overlays.
- **Ghost elements (`position: fixed`):** Divide `clientX` by zoom for correct visual positioning.
- Column resize deltas (`event.clientX - resizeStartX`) are in viewport pixels but column widths are set in CSS pixels. Divide the delta by `getZoomFactor()`.
- Use `getZoomFactor()` from `$lib/domain/zoom` consistently instead of inline `settingsStore.zoomLevel / 100` to avoid drift.
- On Linux, drag-and-drop goes through Tauri native drag (`startExternalDrag` → `onDragDropEvent`), NOT the pointer-drag composable. The pointer-drag path is macOS-only. Debug the right code path.

---

## fix/git-scm-diff-blinking (#98): Diff view flashes "Loading diff…" on refresh

**Key takeaways:**
- `fetchDiff()` was setting `parsed = null` before re-fetching, which caused the template to briefly render the "Loading diff…" placeholder between every refresh. Fix: only show loading on initial fetch (when `parsed` is truly null). On subsequent refreshes, keep the old diff visible until the new one arrives.
- The `$effect` depends on `scmStore.summary.staged.length` and `scmStore.summary.changes.length` so that stage/unstage operations trigger a re-fetch. This means ANY file's status change triggers a diff refetch, but the blink-free approach makes this invisible to the user.
- When switching to a different file, a separate `$effect` resets `parsed = null` so the loading state appears correctly for the new file.

---

## fix/git-badges-not-updating (#93): Git status badges stale after file changes

**Key takeaways:**
- The `gitStatusStore` cached status per-directory and only fetched on navigation (via `fetchForDirectory`). Once cached, it never re-fetched for the same path. Fix: add a `refresh()` method that bypasses the cache, listen to `git-status-changed` events from the Rust watcher, and also refresh on `directory-changed` events. The watcher listener is initialized at the page level (not tied to the SCM panel).

---

## fix/miller-column-drop-empty-space (#84): Drop onto empty space in miller columns

**Key takeaways:**
- The miller column entries only had drop handlers on individual folder buttons (`col-entry`). Dropping onto empty space (the column background) had no effect. Fix: add `ondragover`, `ondragleave`, `ondrop` handlers on the `.miller-col` div itself, targeting the column's directory path. Use `relatedTarget` in `dragleave` to avoid flickering when moving between child elements.

---

## fix/thumbnails-reload-on-folder-change (#90): Watcher-triggered thumbnail reload

**Key takeaways:**
- Deleting or renaming a file triggers: (1) immediate local state mutation, then (2) filesystem watcher event → `refresh()`. Even with fingerprint comparison, the watcher refresh can replace entry objects and cause thumbnails to flash/reload. Fix: add a 1-second cooldown after local mutations during which silent (watcher-triggered) refreshes are suppressed, since the local state is already correct.

---

## fix/miller-column-contiguous-title (#89): Miller column header styling

**Key takeaways:**
- The Miller column headers had a `border-bottom` divider and separate `background` that visually detached them from the folder entries below. Removing the border and background, and reducing the entry gap from `4px` to `1px`, makes the headers flow contiguously into the folder list — matching the sidebar section header style.

---

## fix/git-scm-files-reflect-cwd (#95): Filter SCM to current directory

**Key takeaways:**
- Git status is repo-wide, but users expect the SCM sidebar to show only files relevant to the current directory. Added `filterToDir()` to the SCM store that filters entries by comparing their full path against `activePath`. The commit button still uses full (unfiltered) counts since commits are repo-wide.

---

## fix/git-scm-layout-shift-hover (#94): SCM row hover shift

**Key takeaways:**
- The action buttons in grid column 3 had `display: none/flex`, causing grid reflow on hover. Fix: position actions absolutely with `right: 4px` so they don't participate in grid layout. Add `position: relative` to `.row`.

---

## fix/git-scm-amend-enter-empty-message (#99): Enter key in commit textarea

**Key takeaways:**
- The commit textarea's `onkeydown` handler was missing `stopPropagation()`, which could allow Enter events to bubble to parent handlers. Both bare Enter and Ctrl+Enter should behave identically for committing.

---

## fix/disable-git-source-control-option (#92): Fully disable git SCM

**Key takeaways:**
- Renamed `SIDEBAR_VIEWS` to `ALL_SIDEBAR_VIEWS` and made `sidebarViewsStore.views` a `$derived` that filters out the SCM view when `showGitStatus` is false. The `effectiveActiveId` derived falls back to "files" when the active view is no longer visible.
- Also gated the diff view in `ExplorerPane.svelte` on `showGitStatus` so disabling git while viewing a diff returns to the explorer.

---

## fix/recent-folders-hover-height (#91): X button overlay on long names

**Key takeaways:**
- The remove button (X) was in the flex flow, causing text wrapping when shown on hover for long folder names. Using `position: absolute` with `right: 8px` makes it overlay the text instead of pushing it.

---

## fix/command-palette-toggle-settings (#87): All toggleable settings in command palette

**Key takeaways:**
- Five boolean settings had toggle methods in the settings store but no corresponding command: `confirmDelete`, `showGitStatus`, `showManuallyHidden`, `scmTreeView`, `quickOpenDebug`. Adding them to `command-definitions.ts` is a one-liner per setting.

---

## fix/rename-layout-shift (#86): Inline rename input shifts layout

**Key takeaways:**
- The rename `<input>` had `padding: 2px 6px` and `border: 1px solid` adding 6px to the height vs the plain text span. Adding `margin: -3px 0` to the `.rename-input` in all three views (Details, List, Tiles) neutralizes the extra height.

---

## fix/recent-folders-stale-entries (#85): Reactive pruning of recent folders

**Key takeaways:**
- `frecencyStore.pruneNonExistent()` was only called on component mount and visibility change, not after file operations. When users deleted/renamed/moved folders via the explorer, stale entries persisted in the recent list until the next page load or tab switch.
- Fix: call `pruneNonExistent()` after every successful file mutation (delete, rename, move, paste). The call is async and fire-and-forget — it doesn't block the operation.

---

## refactor/scm-as-its-own-activity-bar-panel-under-alt-m-g (#74): Two new chorded view-focus commands

**Key takeaways:**
- The activity-bar already had `files` and `scm` as separate `SIDEBAR_VIEWS`, but no keybinding switched between them — `Alt+M B` only toggled sidebar visibility. Splitting that into two new commands (`view.focusFilesSidebar` on Alt+M B, `view.focusScmSidebar` on Alt+M G) preserves toggle behaviour for users who want it (still available as the unbound `view.toggleSidebar`) while giving each view its own chord.
- Both commands ensure the sidebar is visible before flipping the active view, so a single chord reliably surfaces the panel even from a hidden state.

---

## feat/scm-tree-view-group-files-by-folder (#76): Snippet-based recursion

**Key takeaways:**
- Svelte 5 `{#snippet}` recursion is a clean way to render the SCM tree without an extra component file. The `treeNode` snippet recurses on `node.children` and renders folder rows + file rows side-by-side. Indent is computed via inline `padding-left: depth * 12` to keep the grid templates simple.
- Collapse state lives in a single `Set<string>` keyed by full directory path. Toggling clones the set rather than mutating in-place so Svelte's reactivity tracks the change.

---

## feat/scm-ignore-button-add-entry-to-gitignore (#77): Idempotent append in Rust

**Key takeaways:**
- `git_add_to_gitignore` reads `.gitignore` (treating "missing" as empty), checks for an existing exact-line match, and only appends when the entry is new — duplicate clicks are safe. The path is normalised relative to repo root (strips leading `./` and `/`) so the entry lands as expected when the user clicked a nested file.
- The button is only rendered for untracked rows because tracked changes can't be ignored without `git rm --cached` first; that's out of scope here.

---

## feat/scm-commit-button-enabled-with-empty-message (#79): Affordance follow-up

**Key takeaways:**
- The amend-no-edit behaviour landed with #78. The remaining bit was telling the user it's available — the placeholder now reads "leave empty + Enter to amend the previous commit" whenever there are staged files but the message is empty. Surface affordance live near where the user is about to act, not in a separate help panel.

---

## feat/scm-ctrl-enter-on-empty-message-does-amend-commit (and #79): Implicit amend-no-edit

**Key takeaways:**
- The Rust `git_commit` command already supports `amend=true` with an empty message — it falls back to the parent commit's message. The frontend was over-restricting the message-empty case. The fix: derive an `effectiveAmend` flag inside `scmStore.commit()` so any empty-message-with-staged-files invocation routes to amend automatically. Both Ctrl+Enter and the commit button benefit.
- The button label/tooltip needs three modes: `commit`, `amend` (toggle on), `amend-no-edit` (empty msg + staged). Splitting the derivation into `commitMode` keeps the conditional sprawl out of the template.

---

## fix/scm-file-row-expands-to-two-lines-on-hover: Two grid items in the same column collide

**Key takeaways:**
- Both `.file-dir` and `.row-actions` were being placed in the third grid column, but `.file-dir` had no explicit `grid-column` so it auto-flowed to col 3, while `.row-actions` declared `grid-column: 3`. Once `.row-actions` flipped from `display: none` to `flex` on hover, the implicit auto-row added a second row to fit both. Pinning `.file-dir` to the same column and toggling visibility (one in, the other out) keeps the row at a fixed height.

---

## feat/scm-confirmation-for-remove-restore: Same backend, different copy

**Key takeaways:**
- `gitDiscard` already routes untracked entries to filesystem `remove_file` (see `git.rs::git_discard`). The SCM panel only had a Discard button on tracked rows, so the disk-deletion behaviour was reachable but never exposed. Adding the same button to untracked rows surfaces the existing semantics — the only thing that needed to differ is the confirmation copy ("permanently deleted from disk" vs "changes reverted").
- Default-focusing the Cancel button on a destructive confirmation is a small but important accessibility detail; we focus it via `queueMicrotask` after rendering rather than relying on autofocus (which trips a lint rule).

---

## test/update-scm-commit-button-test-for-amend-no-edit (#83): Update tests when behaviour changes

**Key takeaways:**
- The pre-existing SCM E2E asserted `commit button is disabled with empty message`. After #79 the button is enabled and reads "Amend (no edit)" in that state. Test was updated to assert the new behaviour explicitly (button label switches between Commit / Amend (no edit) by message content).
- The merge-time `run_e2e_for_merge.sh` hook would have caught this earlier if it had executed within the 2-minute timeout. Running E2E suite afterwards is the safety net, but updating tests as part of the behaviour change keeps the gate honest.

---

## chore/improve-preview-pane-and-progress-dialog-screenshots (#82): Mock parity unlocks UI verification

**Key takeaways:**
- The SCM Ignore button shipped with no `git_add_to_gitignore` mock in `mock-invoke.ts`, so the agent-browser run that verified the button had to surface a real failure ("Unknown command"). The fix was a one-liner mock plus a `mockGitignored` set that filters subsequent `git_status` responses, so clicking Ignore now actually removes the row in dev/E2E. Treat mock-invoke parity as part of the feature when adding new Tauri commands.
- The Operations Manager's progress dialog can be driven directly from the devtools console (`operationsManager.startOperation(...)` + `updateProgress`) for screenshots/E2E. Worth remembering: not every UI surface needs a real backend trigger — store-level public methods are usable directly.

---

## fix/delete-confirm-reads-cleared-dialog-state (#80): Fire-and-forget needs captured args

**Key takeaways:**
- When you dismiss a dialog before kicking off the async work it represents, any path that reads dialog state inside the work is racing against the close. The right shape is: capture the inputs into local variables before closing, then pass them as arguments to the async callee. Reading from a store after the source modal has been torn down is the same class of bug as the cancellation tracking from issue #61.
- This was caught by an actual screenshot run: the merged #71 fix shipped with a placeholder screenshot, and the bug stayed invisible until the live capture surfaced "Delete failed: No entries selected for delete". Always run the UI for behavioural fixes.

---

## fix/delete-modal-lingers-move-progress-to-toast: Confirm closes the modal, work runs in background

**Key takeaways:**
- The dialog used to await `confirmDelete()` before closing, leaving it on screen for the duration of the actual delete (which can be ~1s for trash even on small files because of the system bus call). Closing the modal first and firing the async work as `void confirmDelete().then(...)` removes the lingering UI without changing the underlying delete logic.
- We surface progress and success/error via the existing `toastStore` (an info toast for ≥multi or directory deletes, success or error toast on settle). This is cleaner than re-opening the modal on error and removes the need for `deleting`/spinner state inside the dialog.

---

## fix/cut-indicator-persists-after-cross-tab-paste: Refresh broadcasts must reach inactive tabs

**Key takeaways:**
- The `directory-changed` and cross-window file-change handlers in `+page.svelte` only walked the active tab's left/right panes (`windowTabsManager.getExplorer(paneId)`). Other tabs in the same window held their own explorer instances watching their own paths but were never refreshed, so a paste in tab B left tab A's listing (and any cut indicator on the source row) stale.
- Adding `windowTabsManager.getAllExplorers()` and iterating it in both handlers fixes the cross-tab refresh path. The clipboard already broadcasts `null` after a cut-take, so once the source listing refreshes, the indicator naturally drops.

---

## investigate/preview-renders-faster-than-thumbnails (issue #69): Different pipelines, not a bug

**Question:** Why does the preview pane sometimes paint before the file-list thumbnail for the same image?

**Findings:**
- `PreviewPane` shows images via `convertFileSrc(path)` — a URL into the Tauri webview's asset protocol. The browser fetches and decodes the raw file natively. No Rust image processing on the hot path.
- `ThumbnailImage` calls `getMicroThumbnail` then `getThumbnailData` in `src-tauri/src/thumbnails.rs`, which decode → resize → re-encode → write a cache file → return the cache path. The browser then fetches that smaller file. On a cold cache, the Rust pipeline is strictly slower than the preview's "decode the original" path.
- Thumbnails are also gated by two semaphores (`microPool` cap 8, `fullPool` cap 4) for back-pressure on large grids. A late-mounted ThumbnailImage can wait behind queued peers; the preview pane has no such queue.

**Decision:** Not a bug. The thumbnail pipeline is deliberately heavier so the cached output is small and crisp at micro sizes (essential for tile grids with many images). The preview pane is the privileged "show one big image fast" path. We are not adding instrumentation or rerouting preview through the thumbnail cache — that would slow the common case. If we ever want preview ↔ thumbnail to share work, the right place is letting `getThumbnailData` short-circuit to `convertFileSrc` for full-size requests on small files.

---

## fix/cached-previews-update-when-file-changes: Bust mtime through both layers

**Key takeaways:**
- Two caches were hiding stale content: a path-keyed early-return inside `PreviewPane`, and the webview's URL-keyed cache for `convertFileSrc` output. Both needed to incorporate the FileEntry's `modified` (and `size`) so an external edit produces a fresh fetch.
- Changing the early-return to a composite `previewKey = path|modified|size` works because the explorer pane already refreshes entries on `directory-changed` events — the entry handed to PreviewPane therefore updates without any extra wiring on this side.

---

## feat/manual-hide-via-right-click-context-menu: Per-folder hide list piggybacks the dotfile dim

**Key takeaways:**
- Manually-hidden state is stored per-folder (`{folderPath: [name, ...]}`) and serialised through the same persisted-write-through pattern as bookmarks. The reveal toggle (`showManuallyHidden`) keeps the list separate from the existing dotfile filter (`showHidden`).
- All three views (`FileItem`, `ListView`, `TilesView`) need parity: hidden-entry styling existed only in `FileItem`. Issue #67 added it to the other two with the same `.hidden-entry { opacity: 0.55 }` rule. Mirroring view-mode behaviour stays a recurring trap (see project memory).

---

## feat/command-palette-sort-modifiers: piggyback existing toggle semantics

**Key takeaways:**
- `explorer.setSorting(field)` already toggles ascending/descending when called repeatedly with the same field. Wiring command palette entries straight to that means a second invocation flips direction without needing dedicated asc/desc commands. Adding "type" required only a new `SortField` branch in `sortEntries` (lex on extension, fall back to name).

---

## fix/recent-folders-list-shows-non-existent-paths: Lazy prune in the consumer

**Key takeaways:**
- The frecency/recent stores already had `pruneNonExistent`, but it was only called from QuickOpen — the sidebar's recents list never triggered it. Pruning belongs to the consumer surface, fired on a deferred `onMount` timer (so it doesn't compete with first-paint stat I/O) and on `visibilitychange` so externally-deleted paths clear up when the user tabs back to the window.

---

## fix/sidebar-removable-drives-update-on-eject: Watch the mount-base, not just poll

**Key takeaways:**
- Polling `list_drives` was the only refresh path and ran every 5s. Eject/insert latency was a function of the poll interval. Subscribing the drives store to the existing `directory-changed` fs-watcher event for the platform's mount-base directories (`/run/media/$USER`, `/media/$USER`, `/Volumes`) drops detection latency to roughly the OS notify granularity.
- We kept polling as a backstop because not every mount-base is guaranteed to exist (refused or absent), but tightened the interval to 1.5s so the watcher and the poll together comfortably hit the ~1s acceptance.

---

## feat/hide-empty-folders-in-miller-view: emptiness probe must respect the visibility rule

**Key takeaways:**
- Whether a folder counts as "empty" for the miller filter depends on `showHidden` — a folder containing only dotfiles is empty if hidden files are off, non-empty if they're on. The Rust `is_directory_empty` command takes `include_hidden` so the answer is computed once on the same rule the UI uses to display children.
- Probes are batched per column load and the `path -> isEmpty` cache is invalidated whenever `showHidden` flips, so toggling either preference produces consistent results without stale data.

---

## fix/rename-input-font-size-larger-than-file-row-font: `font: inherit` does not protect against later overrides

**Key takeaways:**
- ListView/TilesView's inline `.rename-input` started with `font: inherit` (good — picks up the row's 13px) but then explicitly set `font-size: var(--font-size-body)` (14px), reintroducing the mismatch. When mirroring a label's font into an input, hard-pin the size to match the label, not to a global token that may diverge.

---

## fix/multifile-progress-dialog-persists-after-cancel: Cancellation must dismiss UI separately from worker abort

**Key takeaways:**
- Marking an `Operation` as `"cancelled"` only stops the worker loop — the dialog row stays visible until something filters it out. Treat "remove from UI" and "signal cancellation to worker" as two responsibilities. We solved this by tracking `cancelledIds` in a separate `Set` so workers can keep polling `isOperationCancelled` after the row is removed from the visible list.

---

## fix/miller-folders-external-refresh: Cache invalidation needs registered watcher

**Key takeaways:**
- The Rust `fs_watcher` only emits `directory-changed` for paths registered via `watch_directory`. Components that listen to those events but don't register their visible paths will only see updates piggybacked off another consumer.
- Miller column ancestors must call `watchDirectory` when entering the visible window and `unwatchDirectory` when leaving (and on unmount). Refcounted watches make it safe to overlap with the explorer pane's own watch on the current path.

---

## fix/activity-bar-tests-flake-under-all-view-modes-parallelism: Scope role-based queries when multiple widgets share the same ARIA role

**Key takeaways:**
- The app has two independent widgets that both expose `role="tab"`: the window-tab strip (per open folder/pane) and the sidebar activity bar. Under `ALL_VIEW_MODES=1` with parallel workers, a prior test could leave a window-tab labelled "Explorer" in localStorage, which then satisfies `getByRole("tab", { name: /Explorer/i })` alongside the activity-bar tab — strict-mode violation.
- Fix: always scope the locator to its parent tablist (`getByRole("tablist", { name: "Sidebar views" })`), or use a structural selector like `.activity-button[data-view-id="files"]`. Same principle applies anywhere roles are reused at multiple layers of the UI.
- Wait for the structural anchor (the `activity-button`) before asserting visibility on role-based locators — under high parallelism, the sidebar shell is still mounting when `waitForLoadState("domcontentloaded")` resolves.

---

## fix/marquee-zoom-hit-test: CSS zoom breaks coordinate math when mixing viewport and container-relative spaces

**Key takeaways:**
- `clientX` and `getBoundingClientRect().left` are both in viewport pixels. To get a container-relative position in CSS space under zoom, subtract first then divide: `(clientX - rect.left) / zoom`. The wrong order (`clientX / zoom - rect.left`) shifts the result left at zoom > 1.
- Clamp bounds from `getBoundingClientRect()` (`.width`, `.height`) are also in viewport pixels — divide by zoom to get CSS-space bounds.
- When converting CSS-space marquee coordinates back to viewport for DOM hit-testing (`getBoundingClientRect()` rects), multiply by zoom: `marqueeRect.left * zoom + containerRect.left`.
- At zoom = 1 the bug is invisible since all transforms are identity. Always test selection features at a non-default zoom level.

---

## perf/marquee-selection-remaining-lag: Eliminate remaining marquee selection lag sources

**Key takeaways:**
- **Double rAF pipeline**: FileList had its own `requestAnimationFrame` wrapper around the composable's rAF-batched `move()`. Fix: add an `onFlush` callback to the composable's `move()` so the selection update runs inside the same rAF frame — one pipeline instead of two.
- **Forced layout per mousemove**: `getBoundingClientRect()` was called on every `mousemove` during drag. Fix: cache the rect at drag-start and refresh it only on `ResizeObserver` events.
- **Index-level dedup**: `selectByIndices` was called every frame even when the covered items hadn't changed. Fix: cache the last indices array and skip the call when identical.
- **Svelte 5 reactive Set gotcha**: In-place `Set.add()`/`.delete()` on a `$state` Set creates fine-grained `.has()` subscriptions on a specific proxy instance. If you later replace the entire Set (`state = new Set()`), those subscriptions become orphaned — the old proxy's `.has()` stops updating but components still read from it. Stick with full Set replacement + identity checks, not mixed mutation strategies.
- **macOS Ctrl+click**: `Ctrl+click` is intercepted by macOS as right-click (context menu). E2E tests using `{ modifiers: ["Control"] }` for multi-select must use `"Meta"` on macOS. Fix: platform-aware `MULTI_SELECT_MODIFIER` constant in test helpers.

---

## perf/marquee-selection-raf-throttle: Coalesce high-frequency pointer events to display refresh rate

**Key takeaways:**
- High-poll mice fire `mousemove` at 200+ Hz, but the screen only repaints at ~60 Hz. Synchronously updating a `$state` value on every event makes the reactive chain (`$state` → `$derived` → Svelte DOM update) run 3–4× more often than the user can ever see. On slower machines this manifests as rubber-band lag during marquee selection.
- Fix pattern: inside the event handler, stash the latest event on a scratch variable and schedule an rAF only if none is pending; inside the rAF, commit the value to `$state`. That coalesces N events per frame into one reactive flush, preserving the latest coordinates. Remember to `cancelAnimationFrame` on teardown (`end()`) so a pending frame doesn't fire after the drag is over.
- Orthogonal compositor win: position the overlay with `transform: translate(x, y)` instead of `left/top`, keep `will-change: transform`, and only mutate `width/height` inline. `transform` updates stay on the compositor thread; `left/top` on an absolutely-positioned element still triggers paint on the ancestor.
- Verify this kind of perf change with a contract test (see `tests/state/marquee-raf-throttle.test.ts`), not a screenshot — assert that N move() calls schedule exactly 1 rAF and the committed value matches the last event. A screenshot can't distinguish 60 Hz from 240 Hz updates.

---

## fix/reenable-native-drag-drop: External drops need Tauri's native handler

**Key takeaways:**
- `WebviewWindowBuilder::disable_drag_drop_handler()` had been added incidentally in a perf commit about `initialization_script`. With it disabled, Tauri does not intercept OS-level file drops, so `webview.onDragDropEvent` (wired in `use-external-drop.svelte.ts`) never fires. WebKitGTK's default then kicks in: the webview navigates to the `file://` URL and shows the picture full-screen with no way back.
- Removing `.disable_drag_drop_handler()` is safe: internal HTML5 DnD (bookmark reorder, file items, recent→bookmark) doesn't cross the OS boundary and keeps working. `tauri-plugin-drag` handles *outgoing* drags via a separate native API — orthogonal to the incoming handler.
- If the webview ever traps on a file URL again, `Ctrl+R` reloads it back to the app.

---

## fix/address-bar-hides-nav-buttons: Hide the whole navigation bar, not just the address portion

**Key takeaways:**
- Originally "hide address bar" only hid the breadcrumb container, leaving the back/forward/up buttons and the 40px bar around them still occupying vertical space — defeating the purpose. Fix: wrap the entire `.navigation-bar` in `{#if settingsStore.showAddressBar || explorer.showFilter}` so it unmounts completely when hidden. Keep it mounted when the filter is showing (Ctrl+F) so the filter still has somewhere to render, and use `justify-content: flex-end` via an `.address-bar-hidden` modifier to push it to the top-right.

---

## design/saturate-app-icon-colours: Bump chroma from the rendered PNG, not the SVG

**Key takeaways:**
- `icon.svg` in `src-tauri/icons/` is a separate blue-folder mock and is *not* what ships — the shipped icon is `icon.png`. Regenerate all platform sizes by resaturating `icon.png` (Pillow `ImageEnhance.Color(1.7)` + small contrast bump) then re-running the ico/icns/Square*Logo fan-out. If you edit the SVG thinking it's the source you'll waste a cycle.

---

## feat/switch-theme-command: Preview vs. commit on the theme store

**Key takeaways:**
- Live-preview UI needs a separate API from persist. Added `themeStore.previewTheme(id)` which only toggles `document.documentElement.data-theme`, leaving settings alone. The picker uses it on every arrow-key selection; Enter calls `setTheme` to persist, Escape re-applies the saved `originalThemeId` so the live preview is cleanly reverted. Replaces the old N-commands-in-palette approach with a single `view.switchTheme` entry.

---

## fix/spurious-text-highlighting: Default `user-select: none` on UI chrome

**Key takeaways:**
- Several components set `user-select: none` locally, but the body defaulted to `auto`, so shift-click across rows (e.g. miller columns, details view) could kick off a native text selection range spanning them — sticky, hard-to-clear, and visually jarring. Set `user-select: none` on `body` globally and explicitly re-enable `text` for inputs, textareas, `[contenteditable="true"]`, and `.preview-pane` (where users actually want to copy). Root-cause fix rather than a local patch per component.

---

## feat/allow-hiding-address-bar: New setting + command

**Key takeaways:**
- Added `showAddressBar: boolean` (default `true`) to `Settings`, a `toggleAddressBar` store method, a Settings dialog row, and a `view.toggleAddressBar` command so the feature is reachable from the command palette. The breadcrumb container is wrapped in `{#if settingsStore.showAddressBar}` — navigation buttons stay visible regardless, matching how other view toggles work.

---

## feat/drag-recent-bookmarks: Reuse existing Quick-Access drop target

**Key takeaways:**
- The Quick Access (bookmarks) region already had native dragover/drop listeners that bookmark any `dragState.current` where `kind === "directory"`. Making recent-location entries `draggable="true"` and populating `dragState.start({...})` on dragstart makes promotion Just Work — no new drop handler needed. Setting the `application/x-explorer-kind` data attribute keeps the existing dropEffect logic happy.
- Sidebar's document-level `dragend` listener is registered with `{ capture: true }` so it reads `dragState.current` BEFORE any drag source's bubble-phase `ondragend` can clear it. Drag sources then clear synchronously — no `setTimeout` needed. This replaces the earlier workaround pattern (see `fix/drag-to-bookmarks` below, which originally used `setTimeout(() => dragState.clear(), 0)` to work around the same race).

---

## feat/remove-recent-paths: Hover-reveal remove on recent entries

**Key takeaways:**
- The recent-locations list in the sidebar reused the `.folder-item .remove-bookmark` hover-reveal pattern from bookmarks. Swapped the `<button>` row for a `<div role="button" tabindex="0">` + inner close button so the nested interactive element is valid. Removal goes through `frecencyStore.remove(path)` which already handles persistence.

---

## fix/tab-bar-window-controls: Tab bar hosts the window controls

**Key takeaways:**
- `WindowTabBar` used to hide itself whenever `tabs.length <= 1`, which caused a layout jump the moment a second tab opened and meant the window controls (min/max/close) also disappeared when they're enabled. Gate on `tabs.length > 1 || settingsStore.showWindowControls` so the strip stays mounted whenever it's hosting the controls.

---

## fix/normalize-bare-drive-letter: Drive root must carry a separator

**Key takeaways:**
- Typing `e:` in the address bar used to leave the path without a trailing separator, and `parseBreadcrumbs` split on `/\\` treats `E:` as a regular segment — so "up one level" produced a bogus `/E:` POSIX path. Normalize bare drive letters (`/^[A-Za-z]:$/`) to `E:/` at the address-bar boundary so all downstream path logic (breadcrumbs, `getParentPath`) sees a real drive root.

---

## feat/sidebar-removable-drives: Platform-specific volume enumeration

**Key takeaways:**
- Linux user-mounts live under `/run/media/$USER` (systemd) or `/media/$USER` (udisks). Don't hardcode one — scan both and dedupe. Skip the `$USER` entry itself when scanning `/media`.
- macOS exposes every mount under `/Volumes`, including the root volume as a symlink to `/`. Read the symlink target to distinguish boot from removable.
- On Windows, detecting DRIVE_REMOVABLE reliably needs `GetDriveTypeW`. Without a winapi dep we fall back to a heuristic (C: is fixed, others are Unknown and still shown). Upgrade when needed.
- The drives store polls every 5s (no reliable cross-platform mount notifications) — cheap since `read_dir` on a handful of mount points is instant.

---

## fix/quickopen-hover-selection: Don't let initial hover override keyboard selection

**Key takeaways:**
- `onmouseenter` on a row fires the moment the popup renders over the cursor, silently overriding the initial top-result selection before the user can press Enter. Fix with a `mouseMoved` flag gated on `onmousemove` — reset to `false` on open and on arrow-key nav, so hover only wins after the user actually moves the pointer. **Important:** a bare `onmousemove` handler isn't enough — macOS WebKit fires a synthetic `mousemove` event (zero physical delta) when a new element renders under a stationary cursor. Compare `clientX/clientY` against the last recorded position so that only genuine coordinate changes set the flag.

---

## chore/drop-macos-intel-build: Dropped macos-13 Release Matrix Cell

**Key takeaways:**
- GitHub Actions `macos-13` (Intel Mac) hosted runners are routinely queued 2h+ with no pickup, blocking the `release` job (which `needs: build` across the whole matrix). Apple stopped selling Intel Macs in 2023 and macOS Tahoe (2025) is the last macOS supporting them, so the Intel .dmg has a vanishing audience. Dropped the cell; arm64 still ships a signed .dmg. If Intel Mac support becomes important again, reintroduce with a self-hosted or third-party runner rather than hosted `macos-13`.

---

## fix/ci-rollup-optional-deps: CI Rollup Optional Deps Fail on Non-Linux Runners

**Key takeaways:**
- `bun install` will migrate from an existing `package-lock.json` if one exists, and preserves the lockfile's platform-specific optional deps. Rollup ships platform-specific native binaries as optional deps; a lockfile generated on Linux only records `@rollup/rollup-linux-x64-gnu`, so non-Linux CI runners fail with `Cannot find module @rollup/rollup-darwin-arm64` / `@rollup/rollup-win32-x64-msvc`. Deleting `bun.lock` before `bun install` is not enough — `package-lock.json` also has to go. Because this project is bun-only, `package-lock.json` is removed from the repo and gitignored.

---

## fix/test-setup-stub-node25: Node 25 Native localStorage Breaks Test Stub

**Key takeaways:**
- Node 25 exposes a native empty `localStorage` global, so `typeof globalThis.localStorage === "undefined"` is false and `tests/setup.ts` skipped installing the functional stub. Any test that persists state (via `persisted.ts` / `drag.svelte.ts`) without its own `vi.stubGlobal` then crashed with `setItem is not a function`. Check for a functional `setItem` method, not mere existence.

---

## fix/arrow-select-first-v2: Arrow Select First (v2)

**Key takeaways:**
- The "select first item when nothing selected" check must come BEFORE the miller left/right directory navigation, otherwise ArrowLeft always triggers goUp() even with no selection. Also reuse the already-fetched `selected` variable in the miller right-arrow check instead of calling `getSelectedEntries()` again.
## fix/tab-flash-content: Tab Content Flash on New Tab

**Key takeaways:**
- New tabs flash empty because `createTab` creates a fresh explorer and immediately switches to it. The explorer's `navigateTo()` is async so entries arrive after the first render. Fix: seed the new explorer with the source tab's entries/sort/viewMode so it renders instantly. Also skip `loading = true` in `navigateInternal` when the path is already populated (seeded state).
## fix/preview-hidden-reactive: Folder Preview Hidden Files Reactivity

**Key takeaways:**
- Folder preview filtered hidden files inside `loadPreview()` which only runs on selection change. Toggling `showHidden` didn't update the preview. Fix: store raw entries in `previewFolderChildrenRaw` and use `$derived` to filter based on `settingsStore.showHidden`, making it reactive.
## fix/disable-slow-click-rename: Remove Slow-Click-to-Rename

**Key takeaways:**
- FileItem.svelte had Windows Explorer-style slow-click-to-rename: clicking an already-selected file's name after 500ms triggered rename. Removed entirely — rename is only via F2 or context menu now.

---

## fix/breadcrumb-caret-spacing: Tighter Breadcrumb Carets

**Key takeaways:**
- Breadcrumb caret buttons had `padding: 4px 5px` and container `gap: 2px`. Reduced to `padding: 4px 2px` and `gap: 0px` for tighter spacing between chevrons and folder names.
## feat/pageup-down-navigation: PageUp/PageDown Navigation

**Key takeaways:**
- Added PageUp/PageDown support in ExplorerPane alongside existing arrow key handling. Jumps by 8 items, clamped to list bounds. Supports Shift+PageUp/Down for range selection.
## fix/preview-line-limit: Preview Line Limit and Large File Performance

**Key takeaways:**
- Syntax highlighting the full 512KB of a large file (uv.lock, etc.) causes UI lag. Fix: truncate preview to 200 lines and only syntax-highlight content under 50KB. Show a truncation indicator.
## fix/folder-preview-hidden: Folder Preview Respects Hidden Files

**Key takeaways:**
- PreviewPane's folder listing used `result.data.entries` directly without filtering. MillerColumns correctly filtered hidden files but PreviewPane didn't. Filter based on `settingsStore.showHidden`.
## fix/arrow-select-first: Arrow Key Selects First Item

**Key takeaways:**
- When nothing is selected (`currentIndex < 0`), the `step === 0` early return for inapplicable arrows (e.g. left/right in details) prevented selecting the first item. Moved the "nothing selected → select first" check before the step calculation.
## fix/tab-open-flash: Tab Open Flash and Close Animation

**Key takeaways:**
- The slide-in animation on `.tab` replayed for ALL tabs whenever the tab bar re-rendered (e.g. on mount with 2+ tabs). Fix: track known tab IDs and only apply `tab-entering` class to genuinely new tabs. For close animation, use a `closingTabId` state + `setTimeout` to delay actual removal until the CSS animation completes.

---

## feat/miller-arrow-nav: Miller View Arrow Key Navigation

**Key takeaways:**
- In details view, `getArrowStep()` returns 0 for horizontal arrows. When miller columns are visible, left/right arrows should navigate directories (up/into) like yazi. The check must happen before the step=0 early return.

---

## feat/tab-open-animation: Tab Opening Animation

**Key takeaways:**
- CSS `@keyframes` with `max-width: 0 → 220px` + `opacity: 0 → 1` creates a Chrome-like slide-in. Use `animation-fill-mode: both` and `overflow: hidden` on the tab to clip content during expansion.

---

## fix/new-folder-empty-dir: New Folder in Empty Directory

**Key takeaways:**
- FileList's empty-state (`displayEntries.length === 0`) prevents any view component from rendering, so `InlineNewFolder` never mounts. Must check `isCreatingFolder` alongside empty state to render the inline input even in empty directories.
## fix/tiles-delete-lag: Tiles View Delete Lag and Thumbnail Flicker

**Key takeaways:**
- The progressive tile rendering `$effect` was resetting `tileRenderLimit` to `TILE_CHUNK` on every `displayEntries` change, including deletions. This caused all tiles to re-render from scratch (flicker). Fix: only reset on large entry count increases (new directory), not decreases (deletion) or small additions.
- The delete dialog overlay animation at 150ms felt sluggish. Reducing to 80ms makes it feel instant without losing visual smoothness.
## feat/text-file-preview: Text File Preview for Shell Scripts and Dotfiles

**Key takeaways:**
- `isTextFile()` only checked `ICON_CATEGORY_MAP` categories and a handful of hardcoded extensions. Files like `.sh` (in ICON_CATEGORY_MAP as "executable") and `.gitignore` (no extension via `getExtension()`) were missed. Added `KNOWN_TEXT_FILES` set for extensionless files and `EXTRA_TEXT_EXTENSIONS` set for additional extensions.
## fix/chord-key-leak: Chord Suffix Keys Leaking to Type-Ahead

**Key takeaways:**
- Chord shortcuts (e.g. Alt+M E) work in two phases: prefix fires on window keydown, suffix fires on next keydown. But the FileList type-ahead handler fires on element bubble phase before the window listener, so it processes the plain suffix key (e/u/b) as type-ahead navigation. Fix: check `keybindingsStore.isChordActive` in type-ahead to skip processing when a chord is in progress.
## fix/light-theme-preview: Preview Pane Light Theme Support

**Key takeaways:**
- highlight.js CSS themes are global imports that define `.hljs` class colors. Importing `github-dark.css` made code unreadable on light themes. Solution: replace the global import with component-scoped CSS rules (`.hljs-light` / `.hljs-dark` wrappers) and detect the active theme's `color-scheme` property via `getComputedStyle(document.documentElement).colorScheme`.

---

## fix/hyprpaper-fill-mode: Hyprpaper Wallpaper Fit Mode

**Key takeaways:**
- Hyprpaper's `fit_mode` option in `hyprpaper.conf` defaults to `cover` (may crop the image), but `fill` stretches to fill the entire monitor without cropping. Use `fill` for the "Set as Wallpaper" context menu action since users generally expect the image to fill the screen completely.

---

## feat/miller-drag-drop: Miller Columns Drop Targets

**Key takeaways:**
- Miller columns drop-to-move uses the shared `useDropTarget` composable. Default drag = move (blue highlight), Ctrl+drag = copy (green highlight). The `handleFileDrop` utility handles conflict resolution, undo tracking, and toast notifications consistently with the main file list. Always take screenshots with `deviceScaleFactor: 2` and element-level `.screenshot()` for cropped, high-res captures of small UI regions.

---

## fix/scan-metadata-syscalls: Minimize Metadata Syscalls

**Key takeaways:**
- `metadata_to_entry` was calling `fs::metadata` (passed by callers) + `fs::symlink_metadata` internally = 2 syscalls per entry minimum, 3 for symlinks. Refactored to use `symlink_metadata` as the primary call everywhere. For non-symlinks (99% of entries), this is 1 syscall. For symlinks, it's 2 (symlink_metadata + fs::metadata to resolve target). Saves ~10K syscalls for a 10K-entry directory.

---

## fix/miller-double-filter: Don't Filter at Cache Level

**Key takeaways:**
- When a cache layer exists below a reactive derived filter, avoid filtering at the cache level. MillerColumns' `loadColumn` filtered to directories only before caching, then the `$derived` `filterEntries` filtered again. Removing the cache-level filter makes the cache truly raw and ensures all filtering is handled in one place (the reactive layer).

---

## fix/miller-stale-folders: Miller Columns Cache Invalidation

**Key takeaways:**
- Miller columns had an infinite-TTL local cache (`rawCache` Map) that was never invalidated by filesystem events. The main pane's `directory-changed` listener only refreshed `explorer.currentPath`, not ancestor directories displayed in Miller columns. Fix: listen to `directory-changed` in the MillerColumns component itself, delete affected cache entries, and reload visible columns. Also, don't pre-filter hidden files in the cache — store all directory entries and let the reactive `filterEntries` derived state handle visibility, so toggling `showHidden` works correctly.

---

## fix/remaining-sync-commands: Audit All Commands After Async Conversion

**Key takeaways:**
- When converting commands to async, audit the entire module — don't just convert the ones listed in a ticket. `create_directory` and `rename_entry` were missed in the initial pass because they do "small" I/O, but on network filesystems even `fs::create_dir` or `fs::rename` can block for seconds.

---

## fix/streaming-dir-listing: Parallel Directory Scanning with jwalk

**Key takeaways:**
- `fs::read_dir` + sequential `fs::metadata` calls are the bottleneck for large directories (100K+ files). `jwalk::WalkDir` with `max_depth(1)` parallelizes the `stat()` calls across a rayon thread pool, significantly reducing scan time. The sort still requires all entries, but the I/O-bound scan phase benefits most from parallelism. Extracting the scan into a shared `scan_directory_parallel` function also deduplicates the logic between `list_directory` and `start_streaming_directory`.

---

## fix/explorer-facade-god-object: Explorer Facade Cleanup

**Key takeaways:**
- Facade objects accumulate unused thin delegates over time. Audit usage before assuming methods are needed. In this case, `openNewFolderDialog`, `closeNewFolderDialog`, `cancelRename`, `cancelDelete`, `closeContextMenu`, `clearClipboard`, `canUndo`, `canRedo`, and `toggleHidden` were either never called on the facade or already accessed via their underlying stores. Removing dead delegates reduces API surface and makes it clear which operations actually require per-pane coordination.

---

## fix/view-component-duplication: View Interaction Composable

**Key takeaways:**
- DnD, context menu, and clipboard state logic was duplicated across FileItem, ListView, and TilesView (3x ~130 lines). Extract shared logic into a composable (`use-item-interactions.svelte.ts`) that accepts dependencies via a config object. Use a `selectOnContextMenu` flag to handle the difference between views that select on right-click (ListView/TilesView) and those that don't (FileItem/DetailsView where selection is handled upstream). Git status badges should be a shared component (`GitStatusBadge.svelte`) to ensure consistent rendering across views.

---

## fix/blocking-rust-commands: Async Tauri Commands

**Key takeaways:**
- All Tauri 2 commands that do filesystem I/O must be `async fn`. Sync commands run on the main thread and freeze the UI during large operations. Simply adding `async` to the function signature is sufficient — Tauri's macro handles running async commands on a thread pool. Tests calling async commands need `tokio::runtime::Runtime::new().unwrap().block_on(...)`.

---

## fix/extract-error-recursion: extractError Infinite Recursion

**Key takeaways:**
- Error extraction functions must have a safe fallback that doesn't recurse. The `extractError` function's fallback case called itself instead of `String(err)`, causing stack overflow for any non-structured error. Always ensure recursive functions have a base case that terminates.

---

## fix/remove-system-bookmarks: Removable System Folders

**Key takeaways:**
- System folders (Downloads, Documents, etc.) were hardcoded with no way to hide them. Persist hidden names in localStorage (`explorer-hidden-system-folders`) and filter the list. Use a `<div>` wrapper instead of `<button>` when a row needs a nested remove button — HTML doesn't allow `<button>` inside `<button>`.

---

## fix/recent-exclude-root: /home in Recent Locations

**Key takeaways:**
- `homeDir` defaults to `"/home"` before the async `getHomeDirectory()` resolves. The filter `e.path !== homeDir` only excludes the *user's* home dir (e.g. `/home/user`), not `/home` itself. Hardcode exclusions for `/home` and `/` since nobody wants to see these in recent locations.

---

## fix/miller-spacing: Miller Column Spacing

**Key takeaways:**
- New components should match existing components' spacing. Miller entries used 12px font/6px gap/3px padding while list view used 13px/8px/4px. Always reference the established component's CSS when building a similar one.

---

## fix/settings-ctrlf: Ctrl+F in Settings

**Key takeaways:**
- When adding a search filter to a dialog, also wire Ctrl+F to focus it. Users expect Ctrl+F to find things — not doing so feels broken.

---

## fix/recent-frecency-sort: Recent Folders Sorting

**Key takeaways:**
- `frecencyStore.entries` is in insertion order, not score order. Must sort explicitly by `getScoreMap()` when displaying.
- Recent folders should exclude bookmarked paths and system folders to avoid duplication with the Bookmarks section above.

---

## fix/drag-to-bookmarks: Drag to Bookmarks Race Condition

**Key takeaways:**
- Element-level `ondragend` fires before document-level `addEventListener("dragend", ...)`. The file item's `dragState.clear()` ran before the sidebar's document listener could read `dragState.current`. Fix: `setTimeout(() => dragState.clear(), 0)` to defer the clear until after all synchronous dragend listeners have fired.
- This is the same class of bug as tauri-0gre (Svelte 5 event delegation + DnD state machine). The sidebar uses native `addEventListener` because Svelte 5's delegation breaks DnD — but that means it runs after element handlers in the bubbling phase.

---

## fix/quickopen-debug-fuzzy: Fuzzy Scoring for Frecency Results

**Key takeaways:**
- Frecency/recent results used simple `name.includes(query)` matching while backend results used a proper fuzzy scorer. This caused frecency-sourced folders to rank lower than backend files with the same name match. Solution: apply the same fuzzy scoring algorithm (fzy/VS Code style) to frecency entries on the frontend.
- The `fuzzyScorePath` function scores against the basename at 1.5× weight vs full path, so filename matches naturally rank higher.
- Multiplying fuzzy score by 10 (`fuzzy * 10`) puts it in the same numeric range as the backend scores + name bonus.

---

## fix/quickopen-debug-settings: QuickOpen Score Breakdown

**Key takeaways:**
- `result.score` in QuickOpen already has frecency and name bonus baked in from `rankWithFrecency`. To show a proper breakdown, derive the base fuzzy score as `result.score - frecencyPts - nameScore`. Without this, the debug display double-counts or misses the backend search score entirely.
- Debug features should be Settings toggles, not hidden keyboard shortcuts. Users can't discover undocumented shortcuts.

---

## feat/miller-view: Miller Columns

**Key takeaways:**
- Miller columns work better as an optional panel alongside any view mode (details/list/tiles) rather than as a separate view mode. This avoids ViewMode type changes and lets users combine miller navigation with their preferred file display.
- Only show directories in miller columns — files are visible in the main view. Showing files would duplicate content and add clutter.

---

## fix/undo-paste + fix/undo-multi-drag: Paste Undo and Batch Undo

**Key takeaways:**
- Copy-paste operations were not undoable because no undo action was pushed. Added a `"copy"` undo type that trashes the copied file on undo.
- Multi-file operations pushed individual undo actions, requiring N Ctrl+Z presses. Added a `"batch"` undo type that wraps multiple actions and undoes/redoes them all at once.
- Single-file pastes should NOT be batched (push directly) to avoid unnecessary wrapper.

---

## feat/git-indicator-polish: Polished Git Indicators

**Key takeaways:**
- VS Code-style git indicators use colored text without background boxes — just the letter (M/U/A/D) in the appropriate color. This is more subtle and integrated than badge-style indicators with backgrounds.

---

## fix/breadcrumb-drop-move: Breadcrumb Drop Always Moves

**Key takeaways:**
- Breadcrumb segments are navigation targets, not file manager targets. Dropping onto them should always move (never copy), regardless of Ctrl key state. Hardcode `isCopy = false` and `dropEffect = "move"`.

---

## fix/remove-sidebar-buttons: Sidebar Cleanup

**Key takeaways:**
- When removing UI sections (Home/Dual Pane buttons, This PC drives), also remove the associated state variables (`thisPcExpanded`, `drives`) and CSS classes to avoid dead code.
- The "Quick Access" label was renamed to "Bookmarks" and recent locations changed from clock icons to folder icons to match user expectations.

---

## fix/mock-paste-ops: Mock Paste Operations

**Key takeaways:**
- `estimate_size` mock was missing, silently breaking the paste flow in browser dev mode (thrown error caught by `ApiResult` pattern). Every new Tauri command needs a corresponding mock handler.
- `Ctrl+C/V` keyboard shortcuts don't work via `agent-browser press` in headless Chromium. Use `window.dispatchEvent(new KeyboardEvent('keydown', ...))` instead.
- To test conflict dialogs: need two directories with a file of the same name in the mock filesystem.

---

## fix/conflict-dialog-display: Conflict Dialog Details Missing

**Key takeaways:**
- `PasteSource` stripped metadata (size/modified) from `FileEntry` when creating the source array. When extending data interfaces, update ALL callsites that construct them — not just the consumer.
- Dates in `FileEntry.modified` are ISO strings — must format with `formatDate()` before display.
- Directory size is 0 in listings — guard the size display with `> 0` to avoid showing "0 B".

---

## fix/git-status-display: Git Indicators Not Showing

**Key takeaways:**
- View-mode-parity: when adding UI features, wire them into ALL three views (FileItem/details, ListView, TilesView). The git badges were only added to FileItem.
- Mock invoke must handle new commands — `mockCommands` in `mock-invoke.ts` throws on unknown commands, silently swallowing the feature in browser dev mode.
- `$effect` calling a store method that reads `$state` internally creates hidden dependencies. Wrap the call in `untrack()` to prevent infinite loops.

---

## chore/pin-dolt-port: Dolt Port Race Condition

**Key takeaways:**
- When multiple hooks call `bd` in rapid succession (e.g. 17 merges back-to-back), each `bd` invocation may auto-start a new dolt server on a random port if the previous port is unreachable. This creates competing instances that deadlock on the database lock. Fix: pin `dolt.port` in `.beads/config.yaml` so every invocation connects to the same deterministic port.

---

## chore/add-unit-test-hook: Pre-Commit Unit Tests

**Key takeaways:**
- Unit tests run in ~3s, fast enough for a pre-commit hook. This catches broken tests before they reach dev, unlike the previous setup which only checked that test files *exist* but never *ran* them.

---

## fix/undo-window-close: Cross-Window Tab Restore

**Key takeaways:**
- `closedTabStack` loaded from localStorage at module init becomes stale when another window adds entries. Before checking `canRestoreTab` or popping from the stack, always re-read from localStorage to pick up cross-window changes. Without this, Ctrl+Shift+T in window B can't see tabs closed in window A.
- **Never use `localStorage` in unit tests** — not even via `loadPersisted`/`savePersisted`. Node versions differ in whether `globalThis.localStorage` exists, is partial, or is undefined. The `setup.ts` stub only applies when it's fully undefined, so tests break on machines where Node provides a partial `localStorage`. Test the business logic (e.g. "stale array misses external writes, refreshed array doesn't") with plain data structures instead.

---

## fix/multi-file-drag-drop: Multi-File Drag and Drop

**Key takeaways:**
- `DragData` and `dataTransfer` only stored a single path. When dragging from a multi-selection, all selected paths must be serialized (via `application/x-explorer-paths` JSON and `DragData.paths`). Drop handlers must iterate over all paths rather than operating on a single source.

---

## fix/addressbar-responsive-icons: Responsive Nav Icons

**Key takeaways:**
- Use CSS `container-type: inline-size` on the navigation bar and a `@container (max-width: 400px)` query to hide navigation buttons when the content area is too narrow. This is more reliable than media queries because it responds to the actual component width, not the viewport.
- `agent-browser` can't resize the viewport. Use Playwright directly (`chromium.launch()` + `page.setViewportSize()`) to take screenshots at specific widths for responsive features.

---

## fix/terminal-shortcut-garbage + fix/revert-chord-prefix: Alt Chord Shortcuts

**Key takeaways:**
- Alt+M chord shortcuts were temporarily changed to Ctrl+M to avoid compose characters on Linux WebKitGTK, but the user preferred Alt+M. Reverted back. The compose character issue on Linux is accepted as a known limitation.

---

## fix/quickopen-filename-scoring: Filename Match Scoring

**Key takeaways:**
- When scoring search results that include both filename and path matches, filename matches need a dramatically higher weight (150-200) compared to path-only matches (30). Otherwise, frequently accessed subdirectories can outrank the parent that actually matches the query name. The scoring tiers: exact name=200, prefix=150, substring=100, path-only=30.

---

## fix/addressbar-folder-only: Address Bar Folders Only

**Key takeaways:**
- Address bar autocomplete is for navigation, which only targets directories. Filter to `e.kind === "directory"` in `fetchSuggestions()`. No need for sorting directories before files when files are excluded entirely.

---

## fix/new-folder-tile-size: New Folder Sizing in Tiles

**Key takeaways:**
- InlineNewFolder's tiles variant must inherit CSS variables (`--tile-icon-size`, `--tile-icon-scale`, `--tile-padding`) from the parent TilesView rather than hardcoding dimensions. Hardcoded `64px` icon size and `11px` font caused size mismatch in medium/large tile modes.

---

## fix/titlebar-disabled-margin: Top Margin When Title Bar Disabled

**Key takeaways:**
- The `window-top-spacer` div provides a drag region when the toolbar is hidden. But it should also be gated on `showWindowControls` — if the user has disabled window controls, they don't need a drag region and the spacer creates a visible gap above the address bar.

---

## fix/small-tiles-spacing: Reduce Spacing in Small Tiles Mode

**Key takeaways:**
- When tile sizes are controlled by CSS custom properties (`--tile-icon-size`, `--tile-min-col`), spacing (gap, padding) should also be parameterized rather than hardcoded. Use additional CSS custom properties (`--tile-gap`, `--tile-padding`) driven by the thumbnail size tier so that small tiles get a denser layout without affecting medium/large.

---

## tauri-explorer-gmpb: Material Design File Icons

**Key takeaways:**
- When adding new select/dropdown elements that reuse CSS classes (e.g., `.theme-select`), E2E tests using that class as a locator will break with "strict mode violation: resolved to N elements". Always add a distinguishing class (e.g., `.color-theme-select` vs `.icon-theme-select`).
- Nerd Font BMP codepoints (U+E000-U+F8FF) are safe to use with `\uXXXX` JS escapes. SMP codepoints (U+F0000+) require `String.fromCodePoint()` — stick to BMP for simplicity.
- The Symbols Nerd Font "Only" variant (~2.4MB TTF) contains just icon glyphs without text characters, ideal for file explorer icon rendering.

---

## tauri-explorer-rdra / tauri-explorer-za55: OS Clipboard Integration

**Key takeaways:**

- When implementing dual clipboard support (internal app clipboard + OS system clipboard), make sure UI guards check **both** sources. The paste handlers were gated on `clipboardStore.hasContent` which only checked the internal clipboard, silently blocking the OS clipboard fallback path that was already correctly implemented in `paste()`.
- `tauri-plugin-clipboard-x` requires both the Rust crate (`tauri-plugin-clipboard-x = "2"` in Cargo.toml) **and** the JS API bindings package (`tauri-plugin-clipboard-x-api` in package.json). Missing the npm package causes module resolution failures at build time.
- Context menus should always show "Paste" (like native file explorers) rather than conditionally hiding it — the paste handler already returns appropriate error messages when nothing is available.

---

## tauri-ygaq: Content Search Performance Optimization

**Key takeaways:**

- `grep-searcher`'s `Searcher::new()` allocates internal buffers. Creating one per file is wasteful -- create once per worker thread in the `walker.run(|| { ... })` closure (before the `Box::new(move |entry| { ... })` closure).
- `MmapChoice::auto()` is `unsafe` because the caller must ensure the file isn't mutated during search. In a read-only search context this is safe and provides significant speedup. On macOS the crate silently disables mmap regardless.
- `BinaryDetection::quit(b'\x00')` stops searching a file on first NUL byte. Combined with the extension-based `is_binary_file()` pre-filter, this is a two-layer defense against wasting time on binary files.
- `RegexMatcherBuilder` is cleaner than manually prepending `(?i)` and toggling between `RegexMatcher::new` vs `new_line_matcher`. Always set `.line_terminator(Some(b'\n'))` for consistency.
- Svelte 5 `$derived.by()` re-runs on every reactive dependency change. For content search with streaming batches, this caused O(total) work on every batch arrival. Solution: use a non-reactive backing array (`let allFlattened: T[] = []`) and only expose a reactive page slice (`let flattenedResults = $state<T[]>([])`).
- Adaptive batch intervals (50ms then 150ms) give fast first-paint while reducing steady-state event frequency.
- `floor_char_boundary()` (stable in Rust 1.93) is essential for truncating strings at valid UTF-8 boundaries.

---

## tauri-qbx6: PNG Image Previews Not Working

**Key takeaways:**

- The `image` crate's JPEG encoder doesn't handle RGBA (transparency) images. When generating thumbnails from PNG files, you must convert `DynamicImage::ImageRgba8` to `DynamicImage::ImageRgb8` before writing to JPEG format, otherwise the encoder may fail or produce corrupt output.
- Match on `DynamicImage::ImageRgba8(_) | ImageRgba16(_) | ImageRgba32F(_)` to cover all RGBA variants.

---

## tauri-1rzt: Laggy Image Previews

**Key takeaways:**

- In tiles view, every `ThumbnailImage` component fires its `$effect` on mount, causing N concurrent Tauri IPC calls for N images. `IntersectionObserver` with a `rootMargin` of `200px` defers loading until thumbnails are near the viewport, dramatically reducing initial load.
- The observer should be disconnected after first intersection (`observer.disconnect()` inside the callback) to avoid ongoing observation overhead.

---

## tauri-qz5t: Copy/Paste Folder with Files Not Working

**Key takeaways:**

- `fs_extra::dir::copy(src, dest, options)` with default `CopyOptions` copies `src` INTO `dest` as `dest/source_name/`. If `dest/source_name/` already exists, it fails because `overwrite` and `skip_exist` default to false.
- For same-directory copies (where collision handling renames to "name - Copy"), passing `target.parent()` to `fs_extra` still creates the original name, conflicting with the source. Fix: `fs::create_dir_all(target)` + `content_only = true` to copy contents directly into the renamed target.
- Same issue exists in cross-filesystem `move_entry` fallback.

---

## tauri-6yzm / tauri-o5ny: Paste Duplicates 3 Times

**Key takeaways:**

- Keyboard shortcuts can fire through multiple layers: component `onkeydown` → parent `onkeydown` → global `window.addEventListener("keydown")`. `preventDefault()` does NOT prevent bubbling. `stopPropagation()` is a band-aid, not a fix.
- The proper solution: have ONE canonical handler (the global keybinding system via `command-definitions.ts`) and remove all duplicates from component-level keydown handlers. Only keep handlers in components for shortcuts that need local state context (e.g., ArrowUp/Down for list navigation needs current selection index).
- For UI feedback (toasts) that was previously in the inline handler: use reactive state. `paste()` writes to `explorer.pasteResult`, and FileList observes it via `$effect`. This decouples feedback from the shortcut handler entirely.

---

## tauri-n5sr: Tiles View Drag Selection Mismatch

**Key takeaways:**

- Marquee selection using `getSelectedIndices(scrollTop, totalItems)` with `index = floor(marqueeTop / itemHeight)` only works for linear lists with fixed row height. CSS grid layouts (tiles view) need DOM-based hit testing using `getBoundingClientRect()` and AABB intersection.
- `getBoundingClientRect()` returns viewport-relative coordinates, automatically accounting for scroll position.

---

## tauri-phud: Delete Multiple Selected Files

**Key takeaways:**

- The Rust backend already had `move_multiple_to_trash` using `trash::delete_all()` but it was never wired to the frontend. Always check existing backend capabilities before adding new commands.
- When extending a single-entity dialog to support multiple entities, adding a parallel array (`targetEntries`) alongside the existing `targetEntry` maintains backward compatibility while enabling batch operations.
- After batch deletion, remember to also clean up `selectedPaths` to remove references to deleted files.

---

## tauri-fadw: Architecture Improvements Epic (10 tasks)

**Key takeaways:**

- `HashMap::new()` is not a const fn in Rust, so `Mutex::new(HashMap::new())` can't be used in `const fn`. Use `OnceLock` with lazy initialization instead for static registries.
- When consolidating keyboard shortcuts, make the resolver when-aware (pass an `isAvailable` predicate to `findMatchingCommand`) rather than relying on registration order. This allows the same key to have different bindings in different contexts.
- Replacing `window.dispatchEvent(new CustomEvent(...))` with a typed store (dialogStore) catches broken event names at compile time and makes dialog state observable in devtools.
- `explorer.state.X` indirection creates confusion when it mixes per-pane state with global store state. Promoting commonly-used fields to top-level getters (`explorer.currentPath` instead of `explorer.state.currentPath`) reduces coupling.
- When creating a shared error type (`AppError`), implementing `From<String>` and `From<io::Error>` eliminates most `.map_err()` calls, making the migration much less invasive.
- FileItem-level keyboard handlers easily fall out of sync with the global command system. Prefer a single source of truth for keyboard shortcuts.

---

## tauri-pghn / tauri-enf4: Themed Icons via CSS Variables

**Key takeaways:**

- To make inline SVG icons themeable, use `fill="currentColor"` and set the `color` CSS property via CSS custom properties. This allows a cascade: `color: var(--icon-file-tint, var(--file-icon-color, var(--text-secondary)))` where themes can override all icons at once (`--icon-file-tint`) or let per-extension colors shine through.
- CSS variables can control `display` property to toggle between UI variants (e.g., chevron vs powerline breadcrumbs) without JavaScript: `display: var(--breadcrumb-chevron-display, flex)`.
- When adding theme-specific features, use CSS variables with sensible defaults so existing themes continue to work without modification.

---

## tauri-vozb: Symlink Detection in Rust

**Key takeaways:**

- `fs::metadata()` follows symlinks, returning the target's metadata. Use `fs::symlink_metadata()` to detect symlinks themselves without following them.
- On Unix, `std::os::unix::fs::symlink()` creates symlinks. On Windows, need to distinguish between `symlink_file()` and `symlink_dir()`.

---

## tauri-2dgf: External Drop Modifier Keys

**Key takeaways:**

- Tauri's `onDragDropEvent` doesn't expose keyboard modifier state (Ctrl, Shift). To detect modifiers during external drops, track them globally via `keydown`/`keyup` listeners with `capture: true`.
- Use the same modifier convention as internal drags (default=move, Ctrl=copy) for consistency.

---

## tauri-ti0l: File-Based Config Persistence

**Key takeaways:**

- For Tauri apps, `dirs::config_dir()` gives the platform-appropriate config directory (`~/.config` on Linux, `~/Library/Application Support` on macOS, `%APPDATA%` on Windows).
- Write-through persistence (save to both localStorage sync and config file async) provides the best of both: instant state for the UI and durable storage on disk.
- When migrating from localStorage to file-based storage, check the config file first, then fall back to localStorage for migration.

---

## tauri-5hlj / tauri-ksp2: Address Bar "/ >" Prefix and Triangles

**Key takeaways:**

- Breadcrumb separators rendered as literal "/" text before the first segment created a confusing "/ >" prefix. Replacing the root crumb's text content with an inline SVG folder icon is cleaner and matches native explorer conventions.
- When using SVG icons inline in Svelte, use `fill="none"` with `stroke="currentColor"` so they inherit the text color from CSS.

---

## tauri-8ytw / tauri-j9aa: Context Menu Not Appearing on Second Click / Missing for Files

**Key takeaways:**

- The ContextMenu backdrop's `oncontextmenu` re-dispatch logic ran `elementFromPoint()` synchronously after calling `contextMenuStore.close()`. But Svelte's reactive DOM updates are batched — the backdrop element was still in the DOM when `elementFromPoint` ran, so it hit the backdrop again instead of the underlying element. Fix: wrap re-dispatch in `requestAnimationFrame` to let Svelte flush DOM removal first.
- The list and tiles view modes rendered file entries as plain `<button>` elements in `FileList.svelte` without `oncontextmenu` handlers. Only the details view (via `FileItem.svelte`) had context menu support. Always audit all view modes when adding interaction features.

---

## tauri-jmcg: Symlink Double-Click Opens Terminal Instead of Navigating

**Key takeaways:**

- **Critical Rust gotcha:** On Unix, `DirEntry::metadata()` is equivalent to `symlink_metadata()` — it does NOT follow symlinks. So a symlink pointing to a directory returns `kind: "file"` because symlinks themselves aren't directories. Use `fs::metadata(entry.path())` to follow the symlink and get the target's metadata.
- Always provide a fallback to `entry.metadata()` for broken/dangling symlinks where `fs::metadata()` will fail.
- This affected both `list_directory` and `start_streaming_directory` — when fixing metadata-related bugs, audit all code paths that read file metadata.

---

## tauri-gkwz: Can't Drag Folders in Tiles View

**Key takeaways:**

- The `FileItem.svelte` component (used in details view) had full drag-and-drop support (`draggable="true"`, `ondragstart`, `ondragover`, `ondragleave`, `ondrop`), but the list and tiles views in `FileList.svelte` rendered entries inline without any drag attributes or handlers. Feature parity across view modes requires explicit wiring of all interaction handlers.
- Per-entry drop target state (using objects keyed by entry path) avoids the problem of a single boolean flag being shared across all entries, which would cause all items to highlight when dragging over any one of them.

---

## tauri-nweq: Cross-Window Drag Doesn't Refresh Source Window

**Key takeaways:**

- The HTML5 `dragend` event fires on the source element regardless of whether the drop target is in the same window, a different window, or even a native file manager. Use `ondragend` to clean up drag state and trigger a refresh of the source pane's directory listing.
- Both `FileItem.svelte` (details view) and `FileList.svelte` (list/tiles views) need the `ondragend` handler — same view-mode parity issue as context menus and drag-start.

---

## tauri-vmpc: Copy/Cut Freezes Window ($effect Infinite Loop)

**Key takeaways:**

- **Svelte 5 `$effect` + store mutation = infinite loop.** If an `$effect` calls a store method that internally reads `$state` (e.g., `toasts.filter(...)` for deduplication), Svelte tracks that `$state` as a dependency of the effect. When the store writes to the same `$state`, the effect re-runs, calling the store again — infinite loop.
- **Prefer imperative toast calls over reactive watching.** Instead of `$effect(() => { if (clipboardChanged) toastStore.show(...) })`, call `toastStore.show(...)` directly where the state change happens (e.g., inside `copyToClipboard()`). This is simpler, avoids reactive pitfalls, and makes the data flow explicit.
- **If you must call a store from `$effect`, wrap it in `untrack()`.** `untrack(() => toastStore.show(...))` prevents Svelte from tracking the store's internal reads as dependencies of the effect.
- **Synchronous Tauri commands block the main thread.** All Tauri 2 commands that do blocking I/O (subprocess spawning, file reads) should be `async fn` to run on a worker thread instead of the main thread.
- **Playwright + Chromium headless: `keyboard.press("Control+c")` hangs.** Chromium's native clipboard implementation blocks in headless mode. Use `page.evaluate(() => el.dispatchEvent(new KeyboardEvent(...)))` instead to test keyboard shortcuts that involve Ctrl+C/X/V.

---

## Mock `create_directory` Missing Duplicate Check

**Key takeaways:**

- The inline new folder input has both `onkeydown` (Enter) and `onblur` handlers that call `confirmNewFolder()`. When Enter triggers `createFolder()` → sets `isCreatingFolder = false` → removes the input from DOM → `onblur` fires → `confirmNewFolder()` runs a **second time**. In the real Tauri app the OS rejects the duplicate (`EEXIST`), so this is harmless. But the mock had no such guard, silently creating two entries with the same path.
- Duplicate entries with the same `path` break Svelte's `{#each ... (key)}` rendering (VirtualList uses `entry.path` as key). This causes the entire file list to stop responding to clicks — selection, context menus, and navigation all fail.
- Mock API handlers should mirror real backend error semantics (idempotency, conflict detection) to avoid hiding bugs that only manifest in test environments.
- When an `onblur` handler does the same work as an `onkeydown` handler (common pattern for "confirm on Enter or blur"), the blur will always fire redundantly when Enter removes the element from DOM. Either guard against double execution or make the operation idempotent.

---

## Enter Key Leaking Through Modal Dialogs to Global Command Handler

**Key takeaways:**

- The DeleteDialog handles Enter via `onkeydown` to confirm deletion, but doesn't call `stopPropagation()`. The Enter event bubbles up to `+page.svelte`'s global `handleKeydown`, which matches the `file.openSelected` command (shortcut: Enter) and calls `navigateTo()` on the selected entry — the very folder being deleted. This causes "Path not found" because `navigateInternal` tries to list the now-deleted directory.
- The fix is architectural, not per-dialog: the global command handler should skip execution when any modal dialog is open (`dialogStore.hasModalOpen`). This is cleaner than adding `stopPropagation()` to every dialog's keydown handler, and correctly models the semantic that modal dialogs should trap keyboard interaction.
- Hardcoded shortcuts like `Ctrl+,` (settings) and `Ctrl+\` (toggle dual pane) are handled **before** the modal guard, so they remain functional regardless of modal state.
- When debugging event propagation bugs, `console.trace()` in the affected handler immediately reveals the call chain — in this case showing `handleKeydown → executeCommand → file.openSelected → navigateTo` as the unexpected caller.

---

## tauri-lgo0: "Unable to access folder" After Deleting a Folder

**Key takeaways:**

- `refresh()` called `navigateInternal(currentPath)` without handling failure. If the current directory was deleted (by another pane, externally, or via the delete handler), the backend returns `AppError::NotFound` and the UI shows an error instead of recovering. Fix: make `refresh()` async and fall back to the parent directory when `navigateInternal()` returns `false`.
- `navigateAwayIfNeeded()` was a synchronous function that fire-and-forgot an async `navigateTo()` call. This meant the navigation hadn't completed before any subsequent `refresh()` or `refreshAllPanes()` could run, creating a race condition where the stale `currentPath` was used. Fix: make it `async` and `await` it in both callers (`startDelete` and `confirmDelete`).
- In multi-pane setups, deleting a folder from one pane doesn't notify other panes that may be viewing the deleted path. The `refresh()` fallback is the safety net for this scenario.
## tauri-usui: Theme Selector Dropdown Uses Browser-Default Colors

**Key takeaways:**

- Native `<select>` elements inherit CSS custom properties for the closed/collapsed state, but `<option>` elements inside the dropdown render with browser/OS default colors (white bg, black text) unless explicitly styled.
- Fix: add `.theme-select option { background: var(--background-solid); color: var(--text-primary); }` so options match the active theme.
- This is a common issue with Tauri/WebKitGTK — always explicitly style `<option>` elements when using native `<select>` in themed UIs.

---

## WebKitGTK Native Form Controls Ignore CSS Backgrounds on Dark Themes

**Key takeaways:**

- **WebKitGTK renders native `<select>` with its own opaque white background** underneath any CSS `background` you set. Translucent `rgba()` backgrounds (like `--control-fill: rgba(255,255,255,0.08)`) composite over that white base, making the select appear white/light on dark themes. This does NOT reproduce in headless Chromium — always test in the actual Tauri app.
- **Fix 1: `color-scheme: dark`** — Add `color-scheme: dark` (or `light`) to each theme's `[data-theme="..."]` rule. This tells WebKitGTK to use dark native form control colors as a baseline. This is inherited, so setting it on the theme selector cascades to all form elements. Should be standard practice for all themes.
- **Fix 2: `appearance: none`** — For full CSS control over `<select>` styling, use `appearance: none; -webkit-appearance: none;` to disable native widget rendering entirely. This requires adding a custom dropdown arrow (e.g., inline SVG via `background-image`). This gives consistent cross-engine results.
- **Both fixes together are ideal:** `color-scheme` ensures any native controls you missed still look right, while `appearance: none` on specific controls gives pixel-perfect theming.
- **Playwright headless Chromium cannot reproduce WebKitGTK rendering bugs.** When debugging Tauri UI issues, always verify in the actual app. Use Playwright for functional testing only.

---

## backdrop-filter Creates Visible Color Seams on Padding Areas

**Key takeaways:**

- **`backdrop-filter` does NOT apply to an element's padding area** — only the content/child area gets the filter. If a parent has `backdrop-filter: blur()` and `padding-top: 6px`, the padding strip shows raw background without the filter, creating a visible color seam on dark themes.
- **Fix: use a spacer div instead of padding.** A child `<div>` with matching `background` (e.g., `var(--background-card)`) sits inside the parent's content area where `backdrop-filter` applies, eliminating the seam. Only render the spacer when needed (no titlebar + no toolbar).
- **`border` on `<body>` with `border-radius` also creates visible strips.** The border interacts with rounded corners to produce a colored band along the top edge. Fix: replace `border` with `box-shadow: inset 0 0 0 1px var(--surface-stroke)` — same visual frame, no layout impact.
- **Debugging tip: use dramatic debug values** (e.g., `background: red`, `padding: 50px`) to confirm whether CSS changes are actually reaching the Tauri webview. WebKitGTK caches aggressively and `:global()` Svelte styles may not propagate reliably to child components in Tauri — prefer scoping changes to the component file that Tauri IS updating.
- **Tauri's WebKitGTK may not pick up changes to all Svelte component files equally.** During this investigation, `+page.svelte` changes reflected immediately but `SharedToolbar.svelte` changes did not, even after full `rm -rf node_modules && bun install && bun run tauri dev`. When styling cross-component, keep changes in the parent file that's known to update.

---

## tauri-mfjv / tauri-zf0z / tauri-zmjd / tauri-sa5i: List/Tiles View CSS Bugs

**Key takeaways:**

- **Icon shift on selection**: Caused by border-left changing from 1px to 2px. Fix: always use `border-left-width: 2px` with `border-left-color: transparent` by default, switch to colored on select. Same pattern for tiles bottom border.
- **Marquee selection mismatch in list view**: FileList reused details-view constants (32px header/item height) for list view, which has different layout. Fix: use DOM-based hit testing with `getSelectedIndicesFromDOM()` instead of mathematical calculation.
- **View mode parity**: Any change to interaction behavior (borders, selection, drag-drop) must be tested in ALL three view modes (details, list, tiles).

---

## tauri-31co: Transparent Column Headers

**Key takeaway:** `--background-card-secondary` is semi-transparent across all themes. For elements that need an opaque background (like sticky column headers), use `--background-solid` instead.

---

## tauri-zqdp: Paste Conflict Dialog

**Key takeaways:**

- **Promise-based dialog pattern**: `conflictResolver.prompt()` returns a Promise that resolves when the user clicks a button. The dialog component calls `conflictResolver.resolve()` to fulfill the promise. This cleanly separates the async control flow from the UI.
- **"Apply to all" tracking**: Track a `globalChoice` variable alongside the loop. When `applyToAll` is true, set `globalChoice` and skip prompting for subsequent entries.
- **Rust overwrite parameter**: Both `copy_entry` and `move_entry` accept `overwrite: Option<bool>`. When true, existing targets are deleted before the operation.

---

## tauri-vjly: Progress Bar for File Operations

**Key takeaways:**

- **Frontend-driven progress is sufficient** for file-count-level tracking. The paste loop already processes files one-by-one, so tracking `(i + 1) / total` gives meaningful progress without needing Rust-side streaming.
- **Existing infrastructure**: The `operationsManager` + `ProgressDialog` were already built but not wired. When adding progress tracking, check if UI components already exist before building new ones.
- **`estimateSize()` API**: Already existed for pre-calculating total bytes. Use it for byte-level progress display alongside file-count progress.

---

## tauri-nxfi: Path Autocomplete

**Key takeaways:**

- **Debounce is essential**: Without debouncing, every keystroke triggers a full directory listing. 150ms debounce balances responsiveness with performance.
- **Generation counter pattern**: Use an incrementing `fetchGeneration` counter to discard stale async results. Before applying results, check that `gen === fetchGeneration`.
- **`onblur` vs suggestion clicks**: `onblur` fires before `onclick` on suggestion items. Fix: use `onmousedown` on suggestions (fires before blur) and `event.preventDefault()` on the dropdown container to prevent focus loss.

---

## tauri-p09o: Include recent/frecency paths in Ctrl+P search

**Problem:** Ctrl+P QuickOpen only searched under `~` via the Rust backend. Paths outside home (e.g. `/tmp/delete-debug`) never appeared even if recently visited.

**Key takeaways:**

- **Client-side injection for supplementary results**: Rather than modifying the backend to support multiple search roots, inject matching entries from client-side stores (recentFilesStore, frecencyStore) directly into search results. Filter to paths outside the backend's search root to avoid duplicates.
- **Show results immediately, don't wait for streaming**: External matches should be injected at search start, not only inside the streaming event handler. If the backend is slow or unavailable, users still see relevant results instantly.
- **Separate collection from matching**: Split external candidate logic into `getExternalCandidates()` (collect + dedup) and `matchExternalCandidates()` (filter by query). Reusable and testable.

---

## tauri-jsn1.8: True window transparency on Linux (WebKitGTK) — BLOCKED

**Key takeaways:**

- **`WEBKIT_DISABLE_COMPOSITING_MODE=1` kills transparency but prevents ghosting**: Removing it enables alpha rendering but causes wry #1524 — stale frames accumulate on every interaction, making the window progressively opaque. No clean app-side workaround exists.
- **`WEBKIT_DISABLE_DMABUF_RENDERER=1` is safe**: Fixes DMA-BUF protocol errors without affecting rendering.
- **CSS `backdrop-filter: blur()` does NOT blur the desktop**: Only operates within the DOM stacking context.
- **Tauri `windowEffects`/`window-vibrancy` don't support Linux**: Windows/macOS only.
- **`hyprctl dispatch setprop` opacity doesn't persist across focus changes** on Hyprland 0.53.3 despite using `"active inactive"` syntax and `lock`.
- **Hyprland setprop syntax quirks**: `opacity` accepts space-separated `"active inactive"` values. Properties like `activeopacity`/`inactiveopacity` return "prop not found" on real windows despite accepting dummy addresses. Use `dispatch setprop` not `setprop` directly.

---

## tauri-8gpm: New Window Inherits from Last Focused Window

**Key takeaways:**
- All Tauri WebviewWindows share the same `localStorage` (same origin). This means `windowTabsManager.init()` was restoring the **parent's saved tab state** instead of using the child window's URL-provided path. The URL params (`?path=...&viewMode=...`) were completely ignored.
- Fix: child windows (those with `?path=` URL param) pass `skipRestore=true` to `init()`, creating a fresh tab at the intended path instead of restoring saved state.
- General lesson: in multi-window apps with shared localStorage, saved-state restoration logic must distinguish between cold starts (restore) and child windows (use provided params).

---

## tauri-vup6: UI Facelift - Premium Polish

**Key takeaways:**
- CSS `color-mix(in srgb, var(--accent) 8%, transparent)` is an effective way to create accent-tinted selection backgrounds that adapt to any theme's accent color, avoiding hardcoded RGBA values per theme.
- When doing a comprehensive CSS-only facelift (tokens + themes + components), all changes should flow through CSS custom properties. This keeps the blast radius contained — no JS changes needed, and themes just override the variables.
- `--radius-pill: 999px` for pill-shaped elements (search bars, breadcrumbs, scrollbar thumbs) provides a significant premium feel upgrade with minimal code change.
- Uppercase section labels (`text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px`) dramatically improve visual hierarchy in sidebars and column headers.
- Replacing `border-bottom` with `box-shadow` on toolbars/status bars creates softer, more premium edges.
- New theme creation: when adding a theme (Aurora), remember to add the `@import` in `index.css` — the theme auto-discovery reads `[data-theme="..."]` selectors from imported CSS.
- Multi-layer shadows (`--shadow-card`) add depth without being heavy. Each theme should define its own shadow intensity based on its background darkness.

---

## tauri-jsn1 (EPIC): Advanced Theme Engine

**Key takeaways:**
- CSS `color-mix(in srgb, var(--bg) calc(var(--opacity) * 100%), transparent)` is the best pattern for per-section transparency tokens. Each section (sidebar, toolbar, content, titlebar, statusbar) gets its own `--*-opacity` variable defaulting to 1.
- The `--theme-icon-pack` and `--theme-bg-animation` pattern works well: themes declare preferences via CSS variables, the app reads them with `getComputedStyle().getPropertyValue()`. User settings override theme suggestions.
- Canvas-based animated backgrounds must handle: `requestAnimationFrame` pause on `document.hidden`, window resize with `devicePixelRatio`, and `prefers-reduced-motion` media query.
- Tauri asset protocol requires `"assetProtocol": { "scope": { "allow": ["**"] } }` in tauri.conf.json for loading local filesystem images in `<img>` or CSS `background-image`.
- When applying CSS blur to a background layer, extend the element beyond viewport edges (`inset: -20px`) to prevent transparent seams at the border.
- Window transparency on Linux/WebKitGTK is blocked by ghosting artifacts (wry #1524). `WEBKIT_DISABLE_COMPOSITING_MODE=1` prevents ghosting but blocks all transparency. No reliable workaround exists as of 2026-03.

---

### tauri-explorer-kxa9 — Marquee selection lag from tile card surfaces

- **`box-shadow` transitions on many elements are a performance killer.** When dozens of elements toggle state per frame (e.g. during marquee drag selection), animated `box-shadow` can't be GPU-composited and forces expensive CPU repaints on every frame.
- **`color-mix()` in frequently-toggled styles adds cost.** Per-element `color-mix()` on borders/backgrounds during rapid state changes compounds the repaint expense.
- **Git bisect is invaluable for CSS performance regressions.** The bug was not in the DOM hit-testing logic (initial suspicion) but in a styling commit — only bisecting across commits confirmed the real cause.
- **Keep tile/grid item styles minimal.** Avoid transitions on `box-shadow` and `transform` for elements that participate in bulk selection. Instant state changes are visually fine and much cheaper.

---

## tauri-explorer-9djf: Architecture Improvements (Tech Debt)

**Key takeaways:**
- **Tauri `#[tauri::command]` macro generates hidden `__cmd__*` items** at the module where the function is defined. When splitting a monolithic Rust file into submodules, `pub use` re-exports only re-export the function — not these hidden items. The `generate_handler![]` macro in `lib.rs` must reference the full submodule path (e.g., `files::file_ops::rename_entry`), and the submodules must be `pub`.
- **Svelte scoped styles don't affect child components.** When extracting view-specific templates into child components (e.g., ListView.svelte from FileList.svelte), CSS classes like `.cut` and `.in-clipboard` must be added to the new component — they won't inherit from the parent's stylesheet. E2E tests across all view modes caught this.
- **Always run ALL_VIEW_MODES=1 E2E tests** when refactoring view-mode-specific code. The default fast mode only tests details view, so regressions in list/tiles views go undetected.
- **Extracting shared composables pays off.** The `useInlineRename` composable eliminated ~80 lines of duplicated rename logic between FileItem and FileList. The `drop-operations.ts` module eliminated ~120 lines of duplicated drag-and-drop conflict resolution code.
- **Structured error serialization (`{kind, message}`)** is better than flat strings for frontend error handling. When changing serialization format, every `String(err)` in catch blocks becomes `[object Object]` — must update all 37 call sites simultaneously.

---

## tauri-explorer-ryv1: New Todo Batch (March 2026)

**Key takeaways:**
- **Same-dir paste conflict**: The `isSameDir` check in paste-operations.ts was gated on `isCut`, causing copy-to-same-dir to show the conflict dialog. The Rust `copy_entry` already handles this via `generate_copy_name()` — the fix was removing the `isCut &&` gate so same-dir copies skip the dialog.
- **Pruning stale entries**: localStorage stores (frecency, recent-files) never validated path existence. Added `check_paths_exist` Rust command for batch validation. Fire-and-forget pattern: call `pruneNonExistent()` when UI opens without awaiting.
- **Marquee selection performance**: `getBoundingClientRect()` on every tile per mousemove is expensive. Two-fold fix: (1) RAF-throttle the selection update, (2) cache item rects per drag session since items don't move during marquee.
- **highlight.js tree-shaking**: Use `highlight.js/lib/core` with individual language imports to avoid bundling all 190+ languages. Register extension aliases with `registerAliases()` for file-extension-based detection.
- **Space as preview toggle hotkey**: Spacebar conflicts with text input. Must add a `when` guard checking `document.activeElement.tagName !== "INPUT"` etc. to prevent firing during typing.

---

## tauri-explorer-ggbb: Ctrl+P Quick Open typing broken

**Key takeaways:**
- **Svelte 5 `$effect` + store mutation = infinite loop**: Calling `pruneNonExistent()` inside `$effect` reads the store's `$state(entries)` array, making it a reactive dependency. When prune modifies entries, the effect re-runs, resetting `query = ""`. Fix: wrap store calls in `untrack()`. This is a recurring Svelte 5 gotcha — always audit what a called function reads internally.

---

## tauri-explorer-zden: Resizable preview pane

**Key takeaways:**
- **Multiple `.resize-handle` elements**: When both sidebar and preview pane have resize handles with the same class, Playwright's strict mode fails. Scope locators to the parent: `page.locator(".preview-pane").locator(".resize-handle")`.
- **CSS resize pattern**: Use `mousedown`/`mousemove`/`mouseup` with `user-select: none` on the resizing state to prevent text selection during drag. Remove listeners in `mouseup` to avoid leaks.

---

## feat/preview-pane-polish: Preview Pane Visual Polish

**Key takeaways:**
- **`--subtle-fill-tertiary` is nearly invisible**: At `rgba(255, 255, 255, 0.04)`, it provides no meaningful visual differentiation. Use `--background-card-secondary` or `--subtle-fill-secondary` for visible surface distinction.
- **`color-mix()` for tinted badges**: `color-mix(in srgb, var(--accent) 12%, transparent)` creates a theme-aware tinted background that adapts to any accent color — useful for status badges and pills.

---

## User Theme `--font-family` Can Break Input Rendering in WebKitGTK

**Key takeaways:**
- Setting `--font-family: "JetBrains Mono", monospace` in a user theme CSS file caused input text and caret to become invisible in the command palette and address bar. Removing the variable restored normal behavior.
- The root cause: "JetBrains Mono" (plain) was not installed — only the Nerd Font patched variant "JetBrainsMono Nerd Font" (no space, different name). The CSS fell back to generic `monospace`, which triggered a WebKitGTK rendering bug where inputs lose their caret and typed text.
- **Always use the exact `fc-list` font family name** in CSS, not the upstream project name. Nerd Font variants use concatenated names (e.g., `"JetBrainsMono Nerd Font"` not `"JetBrains Mono"`).
- User theme CSS variables (`--font-family`, `--selection-bg`, etc.) defined in `[data-theme="..."]` selectors do cascade correctly to the app — the issue was purely a font resolution failure triggering a WebKitGTK input rendering bug.

---

## tauri-explorer-r5yc: Tilde expansion in QuickOpen and address bar

**Key takeaways:**
- **Async home directory**: `getHomeDirectory()` returns a promise. Cache the result in component state at init time rather than awaiting on each use.
- **QuickOpen path navigation**: If query starts with `/` or `~`, Enter should navigate directly instead of selecting a search result. Add the path-check before the result-selection logic.

---

## tauri-plugin-log `.target()` vs `.targets()` — Stdout Leaks in Release Builds

**Key takeaways:**
- **`tauri-plugin-log` v2 defaults include `Stdout`**: The `Builder::default()` starts with `[Stdout, LogDir]` as default targets.
- **`.target()` (singular) appends; `.targets()` (plural) replaces.** Calling `.target(TargetKind::Webview)` adds Webview to the existing defaults — you end up with Stdout + LogDir + Webview. To suppress stdout, you must use `.targets([...])` to replace the entire list.
- **`cfg!(debug_assertions)` was never the problem.** The guard was correct but irrelevant — stdout was coming from the default target list, not the conditional block.
- Three commits tried to fix this before finding the root cause. When a "simple" fix doesn't work, question the API semantics, not just the conditional logic.

---

## fix/context-menu-close-on-cut-copy: Context menu not closing after Cut/Copy

**Key takeaways:**
- **Consistency check for handlers**: When adding new context menu actions, always include `contextMenuStore.close()`. Most handlers had it, but `handleCut` and `handleCopy` were missed because they were added separately from the pattern established by `withSelectedEntry()`.

---

## 2026-06-11 comprehensive review & fix campaign

**Key takeaways:**

- **Emit-before-listen is a systemic Tauri race.** Any backend thread that emits events immediately after a command is invoked WILL emit before the frontend's `listen()` resolves if the listener is registered after the invoke. QuickOpen had documented and fixed this; directory listing and content search shipped the same bug independently. Pattern: register the listener (buffering until the id is known) BEFORE invoking. Corollary: outside Tauri (browser/mock E2E), `listen()` rejects — every call site needs a try/catch fallback or the whole feature breaks in browser mode.
- **`overwrite=true` file operations must be transactional.** The original copy/move deleted the destination *before* copying, so any mid-copy failure destroyed data — and when source == target (drop onto own parent), it deleted the *source*. Stage to a temp name, swap, then remove. Guard source==target and dir-into-own-descendant before any removal, in both backend and `performFileTransfer`.
- **`git status --porcelain` paths are repo-root-relative, not cwd-relative** (and quoted/octal-escaped for non-ASCII unless `-z` is used). Badge parsing keyed by first path segment only worked at the repo root.
- **Simulation tests are worse than no tests.** ~15 unit test files re-implemented production logic locally (or asserted on literals) and passed regardless of regressions. If a rule lives in a component, extract it to `domain/` and test the real import — see `domain/titlebar.ts`, `domain/autocomplete.ts`, `domain/scm-tree.ts`.
- **`waitForTimeout` before an auto-waiting `expect()` is pure waste; before a snapshot read it's a race.** Replace snapshot reads (`textContent()`, `count()`, `inputValue()`) with auto-waiting assertions (`toHaveText`, `toHaveCount`, `toHaveValue`) or `expect.poll`. Streaming UIs (QuickOpen results) need polls, not first-item-visible checks — early results render before the full set settles.
- **`raw_os_error()` is the Win32 error code on Windows, not the CRT errno** — comparing against `libc::EXDEV` never matches `ERROR_NOT_SAME_DEVICE`.
- **Svelte 5: an `$effect` that reads state it (indirectly) writes re-runs and self-defeats** — TilesView's progressive chunking rendered everything in one frame. Use `untrack()` for the feedback variables, or extract decision logic into a pure function (`use-progressive-render.svelte.ts`).
- **Concurrent edit agents need an ownership map AND consumer awareness**: one agent deleted a "zero consumer" `setContext` while another was adding the consumer. Cross-file contracts (context keys, event names) must stay with one owner.

---

## 2026-06-12 structural refactors (Modal primitive, store decomposition, search perf)

**Key takeaways:**

- **Debug builds make dependency-heavy features look broken.** Ctrl+Shift+F felt 10-50x slower than terminal `rg` solely because `tauri dev` compiled the regex/grep/ignore stack at opt-level 0. `[profile.dev.package."*"] opt-level = 3` fixes every dependency-bound hot path (search, thumbnails) while keeping our own crate fast to rebuild. Check the build profile before optimizing code.
- **Audit reachability before refactoring a component.** RenameDialog and NewFolderDialog looked like 2 of the "11 dialogs to convert" but were unreachable dead code — rename and folder creation had moved to inline flows, and nothing called `dialogStore.openNewFolder()`. Mounted-but-unopenable components pass type checks and silently rot.
- **Svelte scoped CSS shapes how a shared primitive must be split**: a child's scoped styles can't target elements rendered by a parent component. Modal owns the overlay element (and its styles); callers render their own dialog card so their scoped card styles keep working, opting into shared chrome via a global `modal.css` class (`.modal-card`).
- **Per-dialog overrides of shared global rules need one extra selector level** (`.dialog .dialog-actions`, not `.dialog-actions`): a scoped selector compiles to the same (0,2,0) specificity as `.modal-card .dialog-actions` and stylesheet order between component CSS and imported CSS is not guaranteed.
- **`$state.raw` for large result lists**: deep-proxying thousands of streamed match objects costs real time; replacing the array reference re-renders just as well. Pair with full virtualization instead of "load more" pagination — page-append scroll jumps read as jank.
- **New e2e coverage immediately caught two real bugs.** (1) Dual-pane mode rendered the global context menu in *both* panes — clicks hit the topmost (right pane's) menu and actions targeted the wrong explorer; fixed with an owner token on the context-menu store. (2) SettingsDialog's staged Escape (clear filter, then close) was silently defeated by the window-level Escape handler because it didn't `stopPropagation()`. Corollary gotcha: an identity token stored in plain `$state` gets wrapped in a reactive proxy and breaks `===` comparison — use `$state.raw` for anything compared by reference.
- **Component init that touches reactive state belongs in `onMount`, not `$effect`.** FilePicker's initializer built the column chain via helpers that *read* `entriesByPath` synchronously — making it a tracked dependency, so every user navigation re-ran the "init" effect and reset the chain back to the starting folder. The failure is subtle: it looks like clicks randomly not sticking.
- **"Clear all when all done" auto-hide is fragile; clear per-operation.** The progress panel only auto-dismissed when *every* operation was completed/cancelled, so one stuck "running" job (from any feature) pinned completed ones — and the whole panel — on screen indefinitely. `completeOperation` now schedules a per-operation auto-clear; the panel hides once the last op clears, independent of others.
- **`let mut` whose only reassignment is behind `#[cfg(target_os = ...)]` reads as dead `mut` elsewhere.** clippy `-D warnings` on Linux flagged the window `builder`'s `mut` as unused (the reassignment is macOS-only), so it was "simplified" to `let builder` — which then failed to compile on macOS (`E0384`). The macOS build only runs in the release job, so it stayed hidden until release time. Fix: `#[cfg_attr(not(target_os = "macos"), allow(unused_mut))] let mut builder`. A green Linux CI does not prove the macOS/Windows-cfg'd code compiles.
- **Heavy native deps (dav1d for AVIF) belong behind a default-off cargo feature, not a target-cfg.** `cfg(target_os = "linux")` still forced dav1d into *every* Linux build, including the release on ubuntu-22.04 (dav1d 0.9.2 < the required 1.3.0). Gating AVIF behind an `avif` feature (off by default, enabled only by the Arch PKGBUILD where dav1d is current) decouples the cross-platform release from the system library. CI keeps it covered by building/testing `--features avif` on a runner with a modern dav1d.
- **The mutation cooldown that dedupes watcher refreshes also swallowed the explicit post-mutation refresh.** `markLocalMutation()` starts a cooldown during which *silent* refreshes are skipped (so the filesystem watcher's event from our own mutation doesn't double-fetch). But compress/extract call `markLocalMutation()` and then `refreshSilent()` to reveal their result — and that silent refresh was skipped by the very cooldown just started, so the new `.zip` (or extracted folder) didn't appear until a manual F5. Mutations that optimistically update `coreState.entries` (createFolder/rename/delete) were unaffected; only the refresh-reliant archive ops broke. Fix: a `force` flag on `refresh()` that bypasses the cooldown for explicit post-mutation refreshes (still silent — no toast).

---

## 2026-06-14 Windows compatibility pass (deferred issues + marquee zoom)

Closed out `docs/reviews/windows-deferred-issues.md` (issues 1–7) plus a marquee-under-zoom bug.

**Key takeaways:**

- **CSS-`zoom` coordinate behavior splits by webview ENGINE, not OS — and Windows (WebView2) is Chromium, not WebKitGTK.** `zoom.ts` had two branches: macOS (WKWebView) and "everything else" (assumed WebKitGTK). WebView2 is Chromium, whose `zoom` semantics match WKWebView: `getBoundingClientRect()` scales with the zoom AND `clientX`/`elementFromPoint` stay in that same post-zoom space. WebKitGTK is the lone exception (raw `clientX`, pre-zoom rects). Treating Windows like WebKitGTK made the marquee rubber-band drift from the cursor when zoomed. Verified empirically in Chromium: under `zoom:200%`, a div at CSS `(100,200)` reports rect `(200,400)` and `elementFromPoint` hits it only at the post-zoom coords. Fix: key the regime on engine (`isMac || /Chrome|Chromium/.test(UA)`), since the dev server is Chromium-on-Linux and an OS check would misclassify it.
- **Path domain helpers must be separator-agnostic; normalize at the boundary, emit `/`.** `parentDir`/`basename` split only on `/`, so every Windows backslash path collapsed to a bogus root. Making them accept `\` or `/` and emit `/` (forward slashes round-trip through Windows APIs) fixes navigation, breadcrumbs, QuickOpen scoring, undo, and copy-naming at once. Drive roots must yield `C:/` (never bare `C:`, which breaks downstream `..`/join), and UNC share roots are their own parent. An `isInsideDir()` helper replaced the hand-rolled `startsWith(p + "/")` descendant guards in drag/drop — those silently allowed dropping a folder into its own child on Windows.
- **`strip_prefix` yields `\`-separated relative paths on Windows.** Search depth ranking counted `/` and got a constant depth of 1; the frontend `relativePath` convention broke too. Normalize only the platform separator (`std::path::MAIN_SEPARATOR`) to `/` — a blanket `\`→`/` replace would corrupt Unix filenames that legally contain a backslash.
- **`event.key` is keyboard-layout-dependent; `event.code` is physical.** `Ctrl+Shift+1` arrives as `event.key === "!"` on many layouts, so a digit/symbol binding never matched. Add an `event.code` fallback (`Digit1` → `"1"`, `KeyA` → `"a"`) used only after the logical `event.key` comparison fails, so normal matching still wins.
- **Platform-native backends with no Linux toolchain are best done as cfg-gated PowerShell shell-outs.** Windows clipboard (CF_HDROP file lists, bitmap images) and wallpaper (`SystemParametersInfo`) were implemented via short `powershell.exe` scripts rather than `unsafe` winapi or a Windows-only crate. Upside: no new deps, no `unsafe`, and the Rust is just `Command` + strings, so it compiles trivially and the risk is the script text, not API bindings I can't compile-check from WSL. Pass data via env vars, never string-interpolate filenames into the script. Caveat: `cfg(windows)` code is invisible to a Linux `cargo check` — only the Windows CI (`e2e-tauri.yml`) compiles it. Also strip the `\\?\` verbatim prefix that `fs::canonicalize` adds before handing a path to `SystemParametersInfo`.

---

## 2026-06-15 Windows feature batch (filter, preview, drives, paste, thumbnails)

A broad batch of Windows-branch fixes and features. Key takeaways:

- **A utility `.hidden { display:none }` loses to a later same-specificity rule.** The settings dialog's per-row filter applied `class:hidden`, but rows never hid: `.setting-row { display:flex }` is declared *after* `.hidden`, and both compile to one scoped class (equal specificity) so source order wins. Sections hid fine only because `.settings-section` happens to be declared before `.hidden`. Fix: `display:none !important` on the utility class. Lesson: a "hidden" utility that competes with component `display` rules needs `!important` (or higher specificity), and equal-specificity bugs are invisible until you check computed style, not the class list.
- **Svelte 5 reactive DOM updates lag a microtask behind a programmatic input event** — a screenshot taken immediately after `fill()` can show the pre-update frame while a `getComputedStyle` check a beat later shows the truth. When verifying reactive UI via automation, assert on the DOM after a tick, not on an instant screenshot.
- **Same-directory detection for paste/move must normalize, not `===`.** `sourceDir === targetDir` is a raw string compare; on Windows the clipboard source dir and current dir can differ only by `\` vs `/` or by case, so a same-folder paste fell through to a conflict prompt instead of producing a `" - Copy"`. A `sameDirectory()` helper (forward-slash, strip trailing slash, case-insensitive for drive-letter/UNC paths) fixes it in both the paste and drag-drop transfer paths.
- **`assetProtocol.scope` silently blocks `convertFileSrc` previews outside the allowlist.** Image/PDF previews use the asset protocol (`convertFileSrc`), whose scope was `$HOME` + Linux mount points only — so previews failed on Windows removable drives, Google Drive (`G:`), and WSL (`\\wsl$\`). Text preview kept working because it uses a custom IPC command with no scope. Fix: add `*:/**/*`, `*:\**\*`, `//**/*`, `\\**\*` to the scope. Lesson: when an asset-protocol preview "doesn't work" on some paths but IPC reads do, suspect the asset scope, not the read code.
- **Windows system folders aren't dotfiles.** `$RECYCLE.BIN` and `System Volume Information` don't start with `.`, so the dotfile-based `filterHidden` showed them. Added a name-based `SYSTEM_HIDDEN_NAMES` set (case-insensitive) so they hide by default and reveal under "show hidden", without needing the backend to surface the Windows hidden/system attribute.
- **`cargo clippy --features avif` needs `libdav1d` locally** (CI installs it). Run plain `cargo clippy` to lint app code when the AVIF system dep is absent.

---

## 2026-06-16 Windows fixes batch (context menu, history, drives, preview, sort)

- **The context-menu zoom offset was a *double* division — but only Chromium wanted it dropped.** `contextMenuStore.open()` called `adjustForZoom(x,y)` (÷zoom) and `ContextMenu.svelte`'s clamp effect divided by zoom *again*, so the menu landed at `clientX / zoom²`. This was correct on WebKitGTK/WKWebView but drifted up-left on Windows/WebView2 — a `position:fixed` overlay under root CSS `zoom` composes differently per engine, and Chromium needs a SINGLE division to sit at the cursor. Fix: store the raw `clientX/clientY`, then divide once on Chromium and twice otherwise (`isChromiumEngine` = `/Chrome|Chromium/` UA, which — unlike `detectViewportZoomCoords` — excludes mac's WKWebView). Lessons: (1) when a transform looks right in isolation, check whether an upstream store already applied it; (2) the zoom regime that's right for rect-relative math (marquee) isn't necessarily right for absolute `position:fixed` placement, so don't reuse `detectViewportZoomCoords` blindly.
- **Disabled `<button>`s swallow `contextmenu` (and all mouse events) in Chromium — and the event doesn't bubble to ancestors.** The Back/Forward buttons used the `disabled` attribute, so right-clicking Back at the start of history fired nothing and the history popup couldn't open. Fix: drop the attribute, style a `.disabled` class instead, and rely on `goBack()/goForward()` already being no-ops at the ends. Use `aria-disabled` for semantics.
- **A background-right-click handler gated on a class allowlist misses the empty/error placeholders.** `handleBackgroundContextMenu` only opened the menu when the target carried a marquee "background" class (`.content`, `.details-view`, …); the empty-folder and error states are separate `.status` divs, so right-clicking an empty folder did nothing. Fix: open the menu for anything that isn't inside an `.entry-item` (items stop-propagation their own right-click), which is more robust than enumerating background classes.
- **Google Drive image previews fail even with the asset scope fixed — cloud placeholder files don't stream over `asset:`.** The 2026-06-15 scope fix (`*:/**/*` etc.) was necessary but not sufficient: Drive/OneDrive "online-only" files are placeholders the asset server reads as empty/erroring. Fix: on `asset://` decode failure, fall back to a backend `read_image_data_url` command that does a normal `fs` read (which forces the cloud client to hydrate the file) and returns a `data:` URI → blob URL. Keep the asset path as the fast default; only the fallback pays the base64 cost. Remember to `URL.revokeObjectURL` the previous blob on each preview to avoid pinning bytes.
- **List/Tiles have no sort UI, so they shouldn't inherit Details' per-folder sort pref.** `displayEntries` applied `coreState.sortBy/Ascending` for every view; a folder sorted by size/desc in Details then looked "randomly" ordered in List/Tiles with no way to change it. Fix: `displayEntries` uses the stored sort only for `details`, and forces name-ascending otherwise.
- **E2E for drive ejection needs a runtime hook.** Browser mock can't unplug hardware, so `mock-invoke` exposes `window.__mockEjectDrive(path)` (mutates the `list_drives` mock) and serves navigable `/media/user/USB_DRIVE` contents; the drives store's ~1.5s poll then drives the real "drive gone" code path.
- **Time-limited toasts (3s) are hard to screenshot — the MCP screenshot tool's settle delay can exceed the toast's lifetime.** Confirm the toast text by reading `.toast` from the DOM right after the action (deterministic proof of the real code path), then, only to hold it on camera, re-emit the identical message on the store's own `explorer-toasts` BroadcastChannel on a short interval during capture.

---

## 2026-06-23 UI batch (rename box, auto-enter, SVG preview, frecency, history menu)

- **Rename boxes should size to their content, in every view.** Three problems, one root cause (fixed-width inputs): the Tiles box used `width:max(180px, 100%+48px)` so it was too wide for short names; it left the selection accent underline (`border-bottom`) showing as a stray colored line beneath the floating box; and the Details/List `<input>` (`flex:1` set on it but inside a non-flex span, so the flex is ignored and it falls back to the browser default ~`size:20` width) was *shorter than a long filename*. Fix: measure the text with an off-DOM canvas (`ctx.measureText` in the input's own font) and set width to fit, clamped min/max. Tiles stays a centered floating box that grows in width then wraps+grows-height past the cap; Details/List grow rightward over the neighbouring columns (lift `overflow:hidden` on the name cell via `:has(:global(.rename-input))` and raise z-index so the opaque box paints over them). Hide the Tiles selection underline while renaming. Lessons: a rename field that can hold a long name must be content-sized, not column-sized; and a child component's class inside a parent's `:has()` needs `:global()` or Svelte prunes the "unused" selector. Three follow-ups: (1) the Tiles rename must NOT change the tile's height or it pushes later rows down — keep the name in flow as a `visibility:hidden` placeholder and float the absolutely-positioned box over it, so the tile keeps its exact pre-rename height however many lines the box grows to (e2e-guarded by measuring a lower-row tile's `boundingBox().y` before/after). (2) The Details/List box made the text jump right by its border+padding (7px) — pull it back with `margin-left:-7px` so the editable text sits exactly where the displayed name was. (3) Clicking another file didn't close the box on Windows/macOS: the file items `preventDefault()` on mousedown for pointer-drag, which suppresses the input's native blur, so it never committed. Fix: a capture-phase `pointerdown` window listener (added while renaming) that commits when the target is outside the input — runs before the item handlers, works on every engine.
- **Auto-enter "single subfolder" flashed each intermediate folder because it navigated for real at every level.** The descent loop committed `currentPath`/`entries` per level, so the view rendered wrapper→payload→inner in sequence. Fix: resolve the whole descent *before* committing — peek each level read-only via `fetchDirectory` (no pane-state writes), then do ONE `applyNavigation` to the final folder. Still pushes a single history entry, so Back undoes the jump in one press. Lesson: to avoid intermediate-state flicker, separate "look ahead" (pure reads) from "commit" (state writes).
- **`position:fixed` overlays anchored to an *element rect* need a different zoom division than ones anchored to a *cursor*.** The right-click history menu placed itself at raw `getBoundingClientRect().left/bottom`, so it drifted when zoomed (same family of bug as the context menu, which uses `clientX/Y`). Factored both into `zoom.ts`: `clientToFixed` (cursor space) and `rectToFixed` (rect space). They differ only on WebKitGTK, where `clientX/Y` are raw viewport px but `getBoundingClientRect()` is pre-zoom CSS px — already one division ahead — so rect anchoring needs one fewer `/zoom`. Pure inner fns (`fixedFromClient`/`fixedFromRect`) are unit-tested per engine. Lesson: don't reuse the cursor-space zoom transform for element-anchored overlays.
- **SVGs had no preview because they're neither raster-thumbnail images nor text.** `isImageFile` is gated on `THUMBNAIL_EXTENSIONS` (backend turbojpeg can't decode SVG) and `isTextFile` excludes the `image` icon category. Added `isSvgFile` and let the preview's image branch render it via `convertFileSrc` (webview renders SVG natively) — without adding `svg` to the raster thumbnail set. The asset scope is path-based so SVGs under allowed paths load; CSP `img-src` already permits `asset:`.
- **Frecency (the Recent locations list) recorded mere navigation, not real work.** Every `navigateTo` called `frecencyStore.recordAccess(folder)`, so browsing through folders ranked them. Changed to record only when a *file* is acted on — opened (FileList/QuickOpen/Open command), previewed (PreviewPane), or right-click-actioned (cut/copy/rename/delete/extract/compress/symlink/wallpaper/hide) — via `recordFileAction(filePath)` which keys on the file's containing folder. Plain navigation (including QuickOpen→folder) no longer feeds it.

---

## 2026-07-03 perf/warm-window-pool: adversarial re-verification of the warm-window pool

- **A window's label is forever — never use it to classify the window's current role.** Activated warm windows keep their `explorer-warm-` label, and the run-loop's "close parked warm windows when the last real window closes" logic classified real-vs-parked by label prefix alone. Result (reproduced live): open app → Ctrl+N (warm activation) → close the original window → the app destroys the user's freshly opened window and exits. Fix: the Rust registry marks labels as `activated` at claim time (same mutex as the claim), and lifecycle decisions ask the registry (`is_real`), not the label. Regression-guarded by Rust state-machine tests and an `e2e-tauri` spec that closes the original window and asserts the activated one survives.
- **A bare `cargo build --release` produces a DEV-mode Tauri binary.** Tauri decides dev-vs-prod by the `custom-protocol` cargo feature (`dev = !has_feature("custom-protocol")`), which the Tauri CLI passes — cargo alone doesn't. The resulting "release" binary dials `devUrl` (localhost:1420) and shows "Could not connect to localhost: Connection refused" with no vite server up. For a runnable release binary: `bun run build` then `cargo build --release --features tauri/custom-protocol` (or just `bun run tauri build`). This invalidated an earlier "release binary" verification that was actually testing stale Jun-28 assets.
- **A claimed-but-unactivatable warm window must be destroyed, not abandoned.** Once `warm_pool_claim` marks a window activated (real), a failed `emitTo` would leak it as an invisible "real" window that keeps the app alive forever. `consumeWarmWindow` now calls `warm_pool_discard` on activation failure before falling back to a fresh window. Same class of leak: a warm window finishing its boot after the last real window closed (`warm_pool_register` now destroys the registrant when no real window remains), and a parked window surviving the setting being toggled off (`warm_pool_shutdown` on disable).
- **Parked windows go stale: there is no cross-window settings sync.** A warm window parked before a theme/settings change would reveal with the old theme. The activation handler now re-runs `settingsStore.init()` + `themeStore.syncFromSettings()` before showing.
- **Don't write seeds nobody reads.** The warm consume path wrote a `dir-seed:<path>` localStorage entry, but seeds are only consumed by `windowTabsManager.init()` at boot — a warm window booted long ago, so activation renders via plain `navigateTo` and the seed just littered localStorage. Seeds are now written only on the fresh-window path.
- **In a multi-step reveal sequence, the reveal must not share a try/catch with best-effort steps.** `setPosition → setSize → show → setFocus…` sat in one try block, so any pre-`show()` rejection would leave a claimed, permanently invisible window — a silent Ctrl+N no-op with no fallback (the claim was already consumed). Each step is now individually best-effort and `show()` always runs. (Verified per-platform that no call in the chain currently rejects — macOS `setSkipTaskbar` is compiled out server-side, Wayland `setPosition` is a silent no-op — so this was latent, not live.)
- **Headless warm-activation probe for driverless platforms (macOS):** launching with `WARM_MEASURE=1` makes Rust spawn a hidden measure window (flagged via an injected `__WARM_MEASURE__` global; `WebviewUrl::App` can't carry query params) that self-activates and logs `Startup(warm-activate): show=Xms` — no keypress, no WebDriver. Measure windows never register with the pool.
- **WebDriver window handles include hidden webviews** — which makes the warm pool directly observable in `e2e-tauri`: boot = 2 handles (main + parked), Ctrl+N = 3 (main + activated + replenish). The activated window is the *pre-existing* warm handle, so specs can track identity across the claim without inspecting visibility.

---

## 2026-07-04 feat/plugin-api-foundation: plugin system (#142)

- **Svelte 5 `$state` arrays deep-proxy their elements — a disposer can't remove "the object I pushed" by reference.** The contribution registries (context-menu items, plugin settings sections) stored plugins' objects in a `$state<[]>` array; the disposer returned by `register(item)` did `items = items.filter(i => i !== item)`. In vitest this passed, but in the browser the plugin toggle-off left the context-menu item behind while the command (a plain `Map`, no proxy) was correctly removed — the smoking gun. Cause: reading the `$state` array yields **proxy-wrapped** elements that never `===` the raw object captured in the disposer closure. Fix: remove by a stable id field (`items.filter(i => i.id !== item.id)`; sections by `(pluginId, id)`). Lesson: never key `$state`-array removal on object identity — use an id. Also: a node-env unit test won't reproduce this; the browser e2e (toggle plugin off, assert the menu item is gone) is what caught it.
- **Virtual `scheme://` paths need a carve-out at every real-path chokepoint.** Plugin fs providers serve `demo://…`; routing them meant `api/files.ts` dispatching to `providerFor(path).list(path)` *before* the real-fs invoke, plus skipping the pane watcher, git-status trigger, and `toNativeSeparators` (which would turn `demo://a/b` into `demo:\a\b` on Windows) for virtual paths. The scheme is required to be ≥2 chars so it never collides with a Windows drive letter (`C://` is not virtual). Breadcrumb parsing gets a virtual branch mirroring the existing UNC special case.

---

## fix/git-panel-issues (#156): stage-from-diff was lost because the diff moved surfaces

`ScmDiffView.svelte` (with Stage/Unstage/Discard header actions) ended up
orphaned — nothing imports it; the live diff actually renders in
`PreviewPane.svelte`, which had no actions. When a feature's surface is
relocated, grep for imports of the old component before assuming its
capabilities moved with it. The diff actions now live in PreviewPane's
git-diff header and follow the file across the index boundary after
stage/unstage. Mock git handlers are stateful (in-memory model mirroring
git.rs) so E2E can assert real outcomes (rows moving sections, commits
clearing staged, amend folding).

---

## 2026-07-05 fix/security-hardening-tier1: audit Tier 1 (#208)

- **Every image decode needs `image::Limits` — the resize target is irrelevant.** A
  crafted header (IHDR claiming 65500×65500) makes the decoder allocate the full-size
  buffer *before* any thumbnail resize. All decode sites now set limits (16384px max
  dim, 256MB max alloc) plus a 200MB file-size gate; the turbojpeg fast path checks
  header dims itself since it bypasses the image crate. Test crafts a valid-CRC PNG
  header by hand — no pixel data needed, the check fires before scanlines.
- **A store contract ("always a SvelteSet, mutate in place") dies silently at the first
  reassignment.** `pane-mutations.ts` reassigned `coreState.selectedPaths` to a plain
  `Set`, killing granular per-row reactivity until the next `setSelection()`. The
  mutation context now receives `setSelection` so extracted modules physically can't
  bypass the contract. Grep for `selectedPaths =` when touching selection code.
- Leftover merge-conflict markers (`<<<<<<<`/`=======`) were sitting in this very file
  on dev — a reminder that docs merges skip CI and deserve a glance after conflicts.

---

## 2026-07-05 fix/git-graph-polish (#221): zoom clamps and inline graph details

- **Every `position:fixed` overlay needs BOTH its anchor point AND its clamp
  bounds converted into fixed-CSS space.** The context menu converted the
  cursor via `clientToFixed` but clamped against `clientWidth / zoom` — on
  Chromium `clientWidth` is already CSS px, so the bound was double-divided
  and the "keep on screen" clamp fired spuriously. Use
  `clientToFixed(window.innerWidth)` so the same engine-aware division rules
  apply to both. Regression-guarded by `e2e/zoom-positioning.spec.ts`, which
  drives the real Ctrl+= zoom command and asserts overlays land at the cursor.
- **Chromium coordinate spaces under root CSS zoom (measured, zoom 1.3):**
  `clientX` = viewport px; `getBoundingClientRect` = viewport px (a fixed
  `left:100px` element reports 130); `clientWidth`/`offsetWidth` = CSS px;
  `window.innerWidth` = viewport px. A "menu drifted" e2e failure can also be
  the legitimate edge clamp — click near the top of the screen when asserting
  cursor-anchored positions.
- **Expanding content inline below a graph row means the SVG must stretch
  with it.** `branchPath` takes a `RowExpand {afterRow, extra}` — rows after
  the expansion shift down by the measured details height (bound via
  `clientHeight`), so polylines and vertices stay aligned with their rows.

## 2026-07-10 fix/git-graph-crossing (#232): edge crossings smear when commit details are open

- **A geometry constant tuned for one row height breaks when a row stretches.**
  `branchPath` drew every lane change as one cubic between adjacent rows.
  With commit details open, `RowExpand` makes that segment `rowHeight +
  panelHeight` tall and the curve smears into a long diagonal across the
  panel. Fix: when a segment's pixel span exceeds one row height, run
  vertical through the stretch and curve only in the final row-height at the
  destination. Symptom only reproduces with a row selected — screenshot
  graph bugs in both collapsed and expanded states.
- **Greedy leftmost lane claiming makes long edges staircase.** Intermediate
  edge rows re-claimed the leftmost free lane each row, so edges drifted left
  as neighboring branches ended. `claimPoint` now prefers the lane the line
  already occupies while free, collapsing the crossing into the final row.

## 2026-07-10 fix/website-downloads-preview-tour (#230): dead download links

- **Never hardcode a release version inside `releases/latest/download/<asset>`
  URLs.** The `latest` path segment tracks the newest release but the asset
  filename embeds the version, so every release silently 404s all download
  buttons (the site shipped 1.0.1 URLs while the release was 1.1.0). The
  website now resolves asset URLs from the GitHub releases API at runtime
  (`resolveDownloads()` in `website/app.js`), keeping the version-built URLs
  only as an offline/rate-limit fallback, and refreshes baked-in anchor
  `href`s from the live map at click time via a `data-dl` delegate.

## 2026-07-10 fix/shortcut-menu-badges (#240): white kbd badges on dark themes

- **A `var(--foo, light-fallback)` with an undefined variable renders the
  light fallback on every theme.** `ShortcutCheatsheet`, `PickerQuickOpen`,
  and `CrashNotice` styled controls with `--background-secondary` /
  `--border-color` / `--accent-color`, none of which any theme defines, so
  the `#f5f5f5`/`#ccc` fallbacks painted white chips on dark themes. Use the
  real theme tokens (`--subtle-fill-tertiary`, `--control-fill`,
  `--control-stroke`, `--accent`) and avoid hardcoded fallbacks that mask a
  missing token — grep for the var name across `src/lib/themes/` before
  introducing one.

## 2026-07-10 fix/address-bar-flash (#233): raw path flashes before the home icon

- **Per-component async fetches of app-wide constants cause first-paint
  flashes on every mount.** Each NavigationBar fetched the home directory in
  its own `onMount`, so every new tab/pane first rendered the raw
  `/home/user/...` crumbs and only collapsed to the house icon when the IPC
  round-trip landed. App-wide constants belong in a shared cached store
  (`src/lib/state/home.svelte.ts`) read synchronously via `$derived` —
  fetch once, every later mount renders its final form on the first frame.

## 2026-07-10 fix/command-palette-lag (#234): palette felt ~150ms slow to open

- **Entrance animations on keystroke-summoned surfaces read as input lag.**
  The command palette (and QuickOpen / content search) opened with a 150ms
  opacity+slide animation, and the modal overlay layered its own 150ms fade
  on top — actual DOM+paint was ~40ms, but the surface wasn't legible until
  the fades finished. VSCode-style palettes must be fully opaque on their
  first frame: entrance animations removed for palette-style surfaces
  (`animation: none` on `.top-aligned` overlays). Measured keypress→legible:
  ~150ms → ~27ms.

## 2026-07-10 fix/tab-hover-fillet (#235): hover highlight fought the active tab's fillet

- **When the active tab flares into the pane with fillets, neighbors can't
  paint full-height hover rectangles** — the rectangle's square base shows
  through the fillet's transparent notch. Chrome's answer (now ours): the
  hover highlight is an inset rounded pill (`::before` with `inset: 4px 2px
  3px`) that stays clear of the strip base entirely, so it composes with any
  neighbor state.

## 2026-07-10 fix/tab-strip-blend (#238): tab strip shade differed from the tabless bar

- **Never stack a second semi-transparent surface layer inside a bar that
  already paints one.** `.tab-area` painted the same `color-mix` background
  as its parent `.titlebar`, doubling the layer (and covering the titlebar's
  depth gradient) so the tabbed section rendered a different shade than the
  tabless remainder. Child strips should be `background: transparent` — the
  bar owns the surface.
- **`var(--foo)` with no fallback silently paints nothing when the token is
  theme-specific.** Unfocused tabs used `--background`, defined only by the
  tahoe theme — everywhere else tabs were transparent and indistinct. Same
  bug class as #240; grep `src/lib/themes/` for a token before using it.

## 2026-07-10 fix/fullscreen-preview-pan-zoom-center (#236): fullscreen image off-center; no pan/zoom

- **`position: fixed; inset: 0; width: 100vw` does NOT cover the visible
  viewport when the app uses root CSS zoom.** Under `documentElement.style.
  zoom`, viewport units are laid out pre-zoom and render zoom× the screen
  size — the fullscreen preview overflowed the window and its "centered"
  image sat off-center. Fix: the root zoom effect now mirrors the factor
  into `--app-zoom`, and fullscreen overlays cancel it with
  `zoom: calc(1 / var(--app-zoom, 1))`.
- **Svelte batches DOM updates: reading `style.transform` synchronously after
  `dispatchEvent` in a browser eval shows the stale value.** Wrap the read in
  a `setTimeout`/rAF before concluding a handler "didn't fire".
- **Guard `setPointerCapture` with try/catch** — it throws for released or
  synthetic pointerIds, killing the whole handler.

## 2026-07-10 fix/marquee-zoom-offset (#241): marquee drifted at zoom AGAIN

- **When a coordinate model gets standardized, migrate EVERY converter, not
  just the one that reproduced.** #227 moved fixedFromClient/fixedFromRect to
  the standardized CSS-zoom model (client and rect coords are post-zoom
  viewport px on every engine, incl. WebKitGTK ≥2.44), but left
  clientToCSSRelative/rectDimToCSS/cssToRect on the legacy "WebKitGTK
  reports pre-zoom rects" split — so the marquee re-broke on the real Linux
  webview while every Chromium test stayed green.
- **A zoom-coordinate regression is only covered if a test runs the engine
  that diverges.** The marquee e2e never zoomed, and the zoom e2e never
  marqueed; both ran Chromium. Added a marquee-under-zoom spec asserting the
  band's viewport geometry AND the selection outcome, and verified it fails
  on WebKit (WEBKIT=1) against the legacy code. Run `WEBKIT=1 npx playwright
  test e2e/zoom-positioning.spec.ts --project=webkit` when touching
  domain/zoom.ts.

## 2026-07-10 fix/drag-hover-folder-blink (#242): drop-target highlight blinked during hover

- **dragenter/dragleave pair per ELEMENT, not per subtree.** Moving the
  cursor onto a child of a folder row fires dragleave on the row while the
  drag is still over the folder; the next dragover re-highlights it — a
  blink on every small move. Fix in `useDropTarget.handleDragLeave`: ignore
  leaves whose `relatedTarget` is inside the row, falling back to a
  coordinate-in-rect check when relatedTarget is null (WebKit). A (0,0)
  null-relatedTarget leave still clears (window exit).

## 2026-07-10 fix/terminal-shortcut-precedence (#249): app shortcuts died while terminal focused

- **xterm focuses a hidden `<textarea>`, so a blanket `isInputField`
  early-return in the global keydown handler swallows every app shortcut
  while the terminal is focused.** The fix splits key ownership like
  terminal emulators / VS Code do: the shell keeps plain typing and
  single-Ctrl combos (readline binds nearly every Ctrl+<key>), the app gets
  Alt/Meta combos, Ctrl+Shift combos, and pending chord suffixes. The rule
  lives in `domain/terminal-keys.ts` (`isShellReservedKey`) and is applied
  in BOTH places: `+page.svelte` (let terminal-focused events through the
  input-field gate) and `TerminalPanel.svelte`
  (`attachCustomKeyEventHandler` returns false so xterm ignores app combos
  while the event still bubbles to the window handler).
- **E2E toggle tests failed with a stale dev server, not a real bug.** After
  several branch switches, the long-running `bun run dev` (HMR churn) made
  previously-green terminal-panel specs fail deterministically. Restarting
  the dev server fixed all of them. If an e2e failure appears on code the
  suite just passed, restart the 1420 server before debugging.
- **agent-browser can't drive chords with a timeout.** Chord shortcuts
  (Alt+M T) have a 1.5s suffix window (`CHORD_TIMEOUT_MS`); separate
  agent-browser CLI invocations are >1.5s apart, so the chord always
  expires — it looks like the feature is broken when it isn't. Assert chord
  behavior in Playwright, not via the CLI.

## 2026-07-10 fix/theme-switch-consistency (#251, #164): theme commit reverted itself

- **Never mutate global state from an `$effect` teardown.** ThemePicker's
  open-effect returned `() => themeStore.previewTheme(themeStore.currentThemeId)`
  to revert un-committed previews. On commit the teardown fired with a STALE
  `currentThemeId` (the pre-commit theme) and reverted the freshly-committed
  `data-theme` — while `settingsStore.theme` kept the new value. Symptoms:
  themes needed two attempts, and the terminal (keyed on settings) switched
  "independently". Fix: do the revert in the effect BODY on the close branch
  (fresh reads), with `untrack()` around store reads so committing (which
  mutates `currentThemeId`) can't re-trigger the session-init effect.
- **Diagnose DOM-attribute fights by proxying `setAttribute` with a stack
  trace** (`window.__trace` + `new Error().stack`) — one repro run pinpointed
  the exact effect frame (`execute_effect_teardown`) doing the revert.
- **Imperative repaint consumers should key on the PAINTED theme, not the
  persisted setting.** themeStore now exposes `appliedThemeId` (updated by
  applyTheme, i.e. also during picker live-previews); TerminalPanel re-themes
  from it, so xterm follows previews and can never drift from the DOM.

## 2026-07-10 fix/pane-split-hotkeys (#244): Super/Cmd bindings never fired on Linux

- **WebKitGTK never maps the Super/Mod4 modifier into `event.metaKey`** (it
  only translates GDK_META_MASK), so any `Cmd+…` default was dead on the real
  Linux app while every Chromium-based e2e passed. Verified live:
  `hyprctl dispatch sendshortcut "SUPER ALT, semicolon, class:tauri-explorer"`
  delivered `meta=false alt=true`, and every `getModifierState` variant
  (Super/Meta/Hyper/OS/Mod4) was false. The Super KEY itself does arrive
  (`key="Super"`, WebKit code `OSLeft`), so `keybindings.svelte.ts` tracks its
  held state from window keydown/keyup (blur resets) and overlays it as the
  meta modifier via `matchesShortcut(…, { metaHeld })`.
- **Driving held-modifier shortcuts into a real window:** `sendshortcut`
  can't hold a modifier (it's press+release) and `wtype`'s virtual keyboard
  delivers garbage `event.code` and drops mod state. What works:
  `hyprctl dispatch sendkeystate "SUPER, Super_L, down, <win>"` → sendshortcut
  the combo → `sendkeystate … up`. That reproduces a physical hold exactly.
- **Fast real-app debug loop:** run the dev binary (`src-tauri/target/debug/…`,
  dials the 1420 dev server) and persist webview facts with the existing
  `log_frontend_error` command — HMR applies frontend edits to the live
  window, no rebuild needed. Screenshot with `grim -g "<x>,<y> <w>x<h>"`
  using geometry from `hyprctl clients`.

## 2026-07-10 fix/multi-file-dnd (#253): multi-file drag arrived as one concatenated path

- **WebKitGTK flattens a JS-set `text/uri-list` when an in-app HTML5 drag
  drops back onto the webview:** the CRLF separators are stripped, wry strips
  `file://` from the first entry only, and the frontend receives ONE string —
  `/a/x.pngfile:///a/y.jpgfile:///a/z.png`. Internal-drag detection then
  fails (no drag-state path matches the blob), the drop is treated as
  external, and `move_entry` correctly reports "Path not found" for the
  garbage path. Single-file drags need no separator, hence "single works,
  multi doesn't". Fix: `splitFlattenedUriList` in `domain/path.ts`, applied
  to wry-delivered paths in `use-native-drop-handler` before any routing.
- **The diagnosis came from one logged repro, not simulation:** a real GTK
  drag can't be synthesized without a pointer, so the drop handler logged
  wry's paths vs the drag state via the existing `log_frontend_error`
  bridge, and the user's single repro made the mangling obvious. When a bug
  needs physical input, land targeted logging and ask for one repro instead
  of guessing at fixes.

## Round: #255–#266 (2026-07-11)

### WebKitGTK stale paint: computed styles right, pixels wrong (#261)
- On WebKitGTK 2.46+/Wayland, large regions (the terminal panel) can freeze on an old theme's colors while `getComputedStyle` reports the NEW values — the style system is fine, paint invalidation is not. `WEBKIT_DISABLE_COMPOSITING_MODE=1` (set in lib.rs) was REMOVED upstream in 2.46, so the wry#1524 ghosting family is back despite the env var.
- **Inline style writes DO invalidate paint** where var()-recompute and xterm's regenerated theme stylesheet don't. The fix: push resolved colors inline onto every background-owning element + `term.refresh()`.
- The xterm WebGL renderer is NOT a fix here: its canvas doesn't composite at all under this driver (region becomes a hole to the window backdrop).
- Debug technique that cracked it: paint probes (`el.style.backgroundColor = "red"`) + a dev-only file-polling eval channel (fetch `/debug-cmd.json` from `static/`, run code, report via `log_frontend_error`). Beats blind hyprctl keystrokes. CAUTION: HMR leaves the OLD poll interval running — a schema change made stale code call `setTheme(undefined)` and corrupted `data-theme`; restart the binary after editing the channel.
- The app pre-warms a hidden window: file-driven debug channels get answered TWICE (label `main` + `explorer-warm-*`). Tag responses with the webview label.

### Terminal key ownership v2 (#260)
- The #249 "shell keeps all single-Ctrl combos" rule made Ctrl+P/Ctrl+J unusable from the terminal. VS Code's model works better: a Ctrl combo the app has BOUND skips the shell, except a shell-critical whitelist (Ctrl+C/D/V/X/Z/A). Needs a side-effect-free `matchesAnyBinding` — `findMatchingCommand` mutates chord state, so calling it from a gate double-fires chords.
- Shortcuts hardcoded in +page.svelte (Ctrl+J/,/\) are invisible to the registry — any registry-driven gate needs an explicit hardcoded-shortcut predicate or they silently die in gated contexts.

### Virtualized views: inline editors must ride INSIDE the list (#257)
- After DOM-virtualization (#128), anything rendered above the VirtualList (the inline new-folder editor) reads as its own band above the pane. Prepend a sentinel item to the items array and render the editor in the row/cell snippet; offset real-entry indices by the sentinel while it's present.

### Git graph perf (#255/#256)
- `{#key}`-remounted views re-run their IPC on every tab switch; a module-level LRU snapshot (paint from cache, refresh in background) makes switches instant without lifecycle changes.
- Windowing rows over an absolute-positioned canvas: slice SVG branch polylines to the window but KEEP straddling segment endpoints — a straight lane encoded as two distant points must still cross the viewport (`sliceBranchLine`).
- `bind:clientHeight` excludes borders; absolute row math needs `bind:offsetHeight` or rows overlap the measured block by the border width.

### Terminal cwd sync vs fast tab switches (#266)
- Every `await` in a cd-sync pipeline is a tab-switch race: re-validate the target against the ACTIVE explorer after each round-trip, and consume the OSC 7 echoes of self-injected cds so they never drive explorer-follows-terminal navigation onto the wrong tab.

### Round #268–#282 (hairlines, plugins, islands, architecture sweep)

### One stroke per silhouette point (#268)
- When a shape is composed of a body plus corner/fillet pieces, each carrying its own border, the body's straight stroke chords through the fillet curve. Draw side hairlines as background strips sized `calc(100% - var(--fillet))` (not full-height inset box-shadow) so the fillet's ring is the ONLY stroke along the curve. And a rule that redeclares `background` on hover silently drops background-drawn strokes.

### Text glyphs are not icons (#270)
- `↺ ⊘ + −` at the same font-size render at wildly different visual sizes (font metrics). Use stroke SVGs with one shared geometry (see `actionIcon` snippet in ScmSidebarView).

### Loading states need a "pending" gate, not just a flag (#271)
- A store's `loading` flag nobody reads is worse than none. The view must distinguish "nothing to show yet" (skeleton) from "resolved: empty" (not-a-repo message); a per-key cache serves stale-while-revalidate so re-activation never flashes. Mock latency knob: `?mockLatency=cmd:ms` / `window.__MOCK_LATENCY__` makes transient states E2E-assertable.

### fal.ai integration (#276)
- Scoped keys 403 on the documented `api.fal.ai` upload endpoints; use the client flow `POST rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` → PUT bytes. Queue validation errors arrive with status COMPLETED and a `detail` array — check the body, not the status.

### Sweep-applied conventions (#278–#282)
- Plugin dialogs share `plugins/plugin-dialog.css` (root `.plugin-dialog`); plugin jobs share `plugin_job.rs` (ids, output validation, timeout, event emission) and `domain/available-filename.ts`. Panel resize/persist goes through `usePersistedPanelWidth` — never raw localStorage in components. Backend commands must return `Result<_, AppError>`; booleans are only for pure probes (menu enablement).
- Dev-loop gotchas: full-parallel vitest dies in sandboxed shells with `Unknown system error -122` — cap with `--maxWorkers=2`; a still-running Vite server serves stale modules after branch switches — `touch` the files; LSP diagnostics right after a branch switch can be stale — re-run `bun run check` before believing them.

### Mock↔backend drift is a bug class, not an incident (#299)
- The hand-written `mock-invoke.ts` drifts silently: it had no discard-conflict guard (real `git_discard` refuses conflicted paths to prevent data loss), no `op_state` on the non-repo `git_status` response, and returned listings in insertion order while the backend sorts dirs-first/case-insensitive. None of this failed any test until shared-fixture contract suites (`tests/contract/` ↔ mirrored `#[test]`s in `git.rs`/`dir_listing.rs`/`file_ops.rs`) encoded the agreement. When a mock handler mirrors a backend guard, encode the scenario in a shared fixture — a comment claiming "mirrors git.rs" doesn't fail CI.
- Emit-before-listen races only reproduce over real IPC: the browser mock returns results inline from `invoke()`, so Playwright can never lose a first event. Real-binary coverage lives in `e2e-tauri/specs/listener-races.spec.ts`.

### Toolchain majors: vite 8 / vitest 4 / TS 7 (#337, #338)
- vitest 4 constructs mock implementations with real `new` semantics: a `vi.fn().mockImplementation(arrow)` used as a constructor (`new WebviewWindow(...)`) throws "not a constructor" — and if the production code wraps construction in try/catch, the test fails silently downstream (empty capture array) instead of at the throw site. Use a `function` expression for any mock that gets `new`-ed.
- TypeScript 7 (native compiler) does not expose the TS 5 CJS API (`ts.sys`); svelte-check (≤4.7.2) crashes at startup loading it. Stay on latest 5.x until svelte-check ships native-compiler support; `@dependabot ignore this major version` posted on #312.
- vite 6→8 + vite-plugin-svelte 5→7 + vitest 3→4 + kit 2.69 needed zero config changes in this repo; the only casualty was the constructor mock above. Bundle budget unaffected (82.7 KiB gzip, 35% of budget).

### CSS "override an override" ordering in island mode (#391)
- The fullscreen preview lost its background on Windows/macOS island modes because `:global([data-vibrancy]) .preview-pane { background: transparent }` has the *same* specificity as `.preview-pane.fullscreen` and is declared later — so the app kept showing through the "fullscreen" image, reading as two previews. When a mode-wide rule zeroes a surface (`background: transparent` for islands), every state that needs that surface back (fullscreen, overlays) must be re-stated *after* it. Repro without Windows: set `data-vibrancy` + `data-win-backdrop` on `documentElement` in the browser.

### Windows has no exec bit — a Linux repo's `core.filemode=true` manufactures changes (#392)
- Over `\\wsl.localhost` (and on Windows generally) libgit2 reads every `100755` file as `100644`, so a repo created under Linux shows all its executables as Modified with an *empty* content diff ("No changes to display"). Git for Windows defaults `core.filemode=false` for exactly this reason. Both status paths need the policy: libgit2 (`git.rs` — filter mode-only entries + `DiffOptions::ignore_filemode`) and the CLI (`files/git_status.rs` — `git -c core.filemode=false status`). Never write the setting into the user's `.git/config`: the repo is shared with WSL, where a chmod *is* a real change.

### "Don't rank these highly" was implemented as "make these invisible" (#393)
- One `SKIP_DIRS` list did double duty in `search.rs`: repo internals (`.git`) and build output (`target`, `node_modules`, `dist`) were both *pruned*, so Quick Open could never reach `target/release/bundle/nsis` — a real path users look for. Split it: hard-skip repo internals, walk build output in a deferred second pass with penalized scores.
- Tune the penalty against a real tree, not a fixture. A *divisor* (score / 4) looked principled and was wrong: it sank an exact `nsis` folder-name match below ~20 loose subsequence matches on long filenames, i.e. straight back out of the top-20 the backend emits. A flat subtraction (−40) keeps same-name source files ahead (they win on depth anyway) without burying an exact match under fuzzy noise.

### libgit2 status and diff can disagree about the same file (#395)
- On Windows, status lists a CRLF-vs-LF file as modified while the diff (post line-ending filter) has zero hunks — Windows `git` calls the repo clean. A *delta* is not evidence of a displayable change: `Patch::from_diff(...).num_hunks() > 0` (or a binary flag) is. The #392 empty-diff filter originally keyed on deltas and passed its filemode test while silently failing the CRLF case; the CRLF unit test caught it. Write the test for the *symptom class* (empty diff), not the first cause you found (filemode).

### The PTY's shell is not the platform's shell (#409, #418)
- On Windows, a pane inside `\\wsl.localhost\…` spawns `wsl.exe` (#378) — a POSIX shell — but the frontend picked cd syntax and the clear-line byte from `isWindows`. Two corruptions compounded: `cd /d "C:\…"` is cmd-speak fed to zsh, and the ESC clear-prefix is zsh's *meta prefix*, so `ESC c` ate the `c` and the shell saw `d /d "…"` ("command not found: d"). Never key shell dialect off the platform; the backend that spawned the shell must report what it spawned (`TerminalSpawnInfo`), and every PTY write/read translates through that profile (`domain/terminal-shell.ts`).
- The settings store replaces its whole `$state` object on ANY update, so an effect reading one settings flag re-runs on *every* settings change — a terminal panel drag-resize (persisting height per pointermove) re-fired the cwd-sync effect dozens of times. Effects that trigger outward side effects (PTY writes) must dedupe their actual trigger (`path === lastSyncTarget`) instead of trusting effect scheduling granularity.

### An effect keyed on a replaced-wholesale object can starve its own fetch (#396)
- The preview's diff effect depends on the summary OBJECT (deliberately — content can change while the status list stays identical, so identity is the freshness signal; do NOT dedup identical summaries at the store). But UNC repos are polled every 3s (#387), so each inert tick re-ran the effect, and `loadDiff` invalidated the in-flight request each run — over a slow share the diff never landed. Fix at the consumer: drop a reload for a target already in flight, keep the rendered diff visible while re-verifying the same target, and reset the spinner in `finally`. Repro/regression: `__mockGitPoll()` + `?mockLatency=git_diff:1200` (test fails on the old code).

### Delegate SCM status/diff to native `wsl.exe git` for UNC repos (#398)
- libgit2's `status` re-hashes every tracked file, and over `\\wsl.localhost\…` each read crosses 9P — seconds per pass. The distro's own git has a warm stat cache and never leaves Linux, so status/diff (read-only) delegate to `wsl.exe -d <distro> -- git -C <linux-path> …`, keeping stage/unstage/commit on libgit2. `git.rs` parses `status --porcelain=v2 --branch -z -uall`; a spawn/exit failure falls straight back to libgit2, so a missing distro degrades gracefully.
- The opposite of #392 applies: do NOT pass `-c core.filemode=false` on the WSL-delegated path. That override exists because *Windows* can't read the POSIX exec bit; native Linux git reads it correctly, and forcing it off would hide a genuine chmod. The override belongs only on the Windows-side CLI/libgit2 paths, never inside WSL.
- Porcelain v2 `-z` framing gotcha: records are NUL-*terminated*, and a rename/copy ("2") record is immediately followed by an *extra* NUL-separated field holding the original path — you must consume it or it parses as a bogus second entry (same trap as v1 in `files/git_status.rs`). Header lines start with `#`; ordinary "1" entries have 8 space-tokens before the path, "2" have 9, unmerged "u" have 10. XY is `<index><worktree>`, `.`=unchanged, so one entry can populate both the staged and the worktree bucket. The parser is a pure fn (`parse_status_v2`) unit-tested on Linux against both byte fixtures and the real `git` binary; only the `wsl.exe` call is `#[cfg(windows)]`.

### `wsl.exe -- <cmd>` runs through the distro's login shell (#423)
- `wsl.exe -d <distro> -- <cmd>` does NOT exec argv directly: it joins the trailing arguments and feeds them to the distro user's **default login shell**. When that shell is zsh, the unquoted `find` metacharacters (`( -name .* … )`) triggered `zsh:1: unknown file attribute:`, exit 1, zero stdout — so the entire WSL quickfind walk (fast AND deferred pass) silently returned 0 entries and Quick Open found nothing beyond the cwd-children merge. Use `wsl.exe --exec <cmd>` (alias `-e`) to launch the command directly with argv passed verbatim — no shell, no quoting. (git.rs delegates `wsl.exe -- git …` too and happens to work only because git args carry no shell metacharacters; still fragile.)
- A process *spawn* is not success. `stream_find` waited on the child and logged the status but always returned `true`, so a shell-mangled find that exited 1 with no output looked identical to a clean empty tree — no fallback ever fired. Check the exit status: fall back to the jwalk walker on a non-zero exit that produced zero parsed entries. Guard the fallback on `parsed == 0` so a mid-stream `stop()` kill (entries already emitted) doesn't discard results and re-emit duplicates. Fast-pass failure triggers full fallback; the deferred pass is best-effort and its failure must not discard already-streamed fast-pass results.

### Memory-leak sweep: unique-per-creation ids and mid-drag unmount (#439)
- The systemic frontend leak was `getScmStore(paneId)` caching one `ScmStore` per pane in a module `Map` with no delete path. A stale comment claimed "pane ids recur across tab switches, so the map stays small" — false: ids are minted `pane-${Date.now()}-${random}`, unique per creation and never reused, so the map grew one entry per pane *ever* opened. `release()` (panel unmount) dropped the watcher but left the object in the map. Fix: a `disposeScmStore(paneId)` (release + `Map.delete`) wired into every pane-removal site in `window-tabs.svelte.ts` (`closePane`, `destroyTabExplorers`, dual-pane collapse). Lesson: a per-entity cache keyed by a unique-per-creation id needs a disposal call on every teardown path, and "the key recurs so it stays bounded" is a claim to verify against how the id is minted, not to trust in a comment.
- Cleanup that lives *only* in the happy-path terminator event is not cleanup on destroy. `use-panel-resize` removed its `document` mousemove/mouseup listeners and restored the body cursor only inside `onMouseUp`; a component unmounted mid-drag left both listeners and a stuck `cursor: ew-resize` for the rest of the session. Sibling drag composables already guarded this with `onDestroy`. Rule: any listener/override attached on pointerdown must also be torn down in `onDestroy`, not just on pointerup.
- An inline-arrow `addEventListener("focus", () => …)` is unremovable — you cannot `removeEventListener` a handle you didn't keep. Module singletons (one per window/JS-context) that live the whole session are *not* leaks, but a factory that registers such a listener and is also called in tests leaks one retained-closure listener per call. Hoist to a named handler and expose a `dispose()` even when production never calls it, so the factory is test-clean.
- A component that is "mounted fresh each edit, destroyed on cancel" and arms a debounce `setTimeout` needs `onDestroy(() => clearTimeout(t))` — otherwise cancel-before-fire issues a stray post-unmount IPC fetch (`BreadcrumbAutocomplete`). Debounce-cleared-by-next-keystroke is not destroy-safe.
- Audited and found already correct (do not "fix"): thumbnail cache (LRU 500 + blob-URL revoke), frecency (cap 200), closed-tabs/closed-panes (cap 20), recent-files (cap 50), and all Rust maps (task_registry cleanup-on-thread-exit, fs_watcher refcount, terminal PTY reaped on EOF/window-destroy, thumbnails 512-LRU + 500 MiB disk prune). Most Tauri `listen()` and window listeners already had matched unlisten/removeEventListener via `$effect`/`onDestroy` cleanup returns — the leaks were the few that didn't.

### Island-mode layout decisions must key off ONE shared derived (#434)
- The miller-columns double-mount bug: `+page.svelte` hoisted columns to a left island when `islandMode` (macOsVibrancy OR windowsBackdrop OR floatingIslands) && no-sidebar, but `ExplorerPane.svelte` suppressed the inline copy only when `macOsVibrancy && !showSidebar`. Any island mode reached via floatingIslands or a Windows backdrop hoisted AND rendered inline → two `.miller-columns`. Fix: a single `settingsStore.islandMode` derived both sites consume; the pane suppresses only for the ACTIVE pane (the island shows the active explorer, so inactive split panes still render their own columns inline). A local per-component copy of a cross-cutting layout condition is the trap — centralize it.
- "Integrated vs floating" is a layout decision, not a theme attribute. `ScmPanel` looked like a floating hover card under vibrancy because `:global([data-vibrancy]) .scm-panel` applied island chrome (radius/stroke/glow/backdrop-filter) unconditionally. A pane section must render docked/flat (transparent bg, like the miller bar); island chrome is now opt-in via an `island` prop the layout sets, not a blanket `[data-vibrancy]` selector.
- Half-migrated state is a smell: SCM *data* was per-pane (`getScmStore(paneId)`, #334) while *visibility* stayed a global `showScmPanel` setting, so the toggle flipped every pane. Moved visibility onto the pane node (`window-tabs` `getPaneScmVisible`/`toggleScmInActivePane`), keeping the setting as the fallback default — mirrors the per-pane `millerLayers` override (`?? settingsStore.…`), which also preserves existing e2e tests that seed the global flag.

## fix/git-graph-refresh-and-remotes (#432): Graph refresh race, F5 ownership, remote checkout
- A component that builds its own refresh stack alongside the repo's official one WILL race itself. GitGraphView had three uncoordinated reload triggers (repo/filter effect, watcher subscription, and every mutating action's own `loadPage(0)`) and a `!loading` skip guard that silently *dropped* a watcher refresh arriving mid-load. A pull emits watcher bursts that routinely land during the action's own reload, so the graph settled on pre-pull state and nothing re-triggered — "pull completes but the graph doesn't update." Fix: ONE generation-counted `reload()` (mirrors `scm.svelte.ts:112`) where a request arriving while a load is in flight sets a `dirty` flag and re-runs on completion — never dropped. Actions call `reload()` + `notifyLocalGitChange`, and the watcher subscription filters `source:"local"` (like scm.svelte.ts:222) so the action's own notify echo can't double-reload. Drop the skip-while-loading guard once `reload()` can't drop a request.
- A woven synthetic row makes `array.length` the wrong page cursor. `weave_stashes` inserts stash rows into the returned page, but the backend's `skip` counts revwalk steps (real commits only). Paging by `commits.length` over-skips by the number of woven stashes, silently dropping a real commit at every page boundary after a stash. Page by the real-commit count (`commits.filter(c => !c.stash).length`), or use the backend `next_cursor`.
- A raw `<svelte:window onkeydown>` shortcut is a shadow keybinding: invisible to the keybindings registry AND to the terminal's key-ownership gate, and it fires for every mounted instance (active or not). F5 in the terminal never reached the graph because `terminal-keys.ts` classified every modifier-less key (F-keys included) as shell typing before the `appBound` check. Fixes: register `gitGraph.refresh` as a real command (F5, `when: activePaneIsGraph`) dispatching to the active pane via a small refresh bus; let function keys fall through to `appBound` in `terminal-keys.ts` (printable + navigation keys still stay with the shell).
- Domain models that reduce identities to display strings destroy downstream capability. `groupRefChips` collapsed remote branches to bare `"origin/feat/x"` strings, so by context-menu time nothing could offer a tracking checkout — remote checkout could only go detached. Keep `{name, remote, branch}` through `RefChips.remotes` (split at the first slash; the branch part may itself contain slashes) and scope the remote chip's `oncontextmenu`. Backed by `git_checkout_tracking` (`git checkout -b <name> --track <remote>/<name>`, or plain checkout if the local already exists).
- Fast-forwarding local branches safely: advance a non-checked-out branch's ref directly (`update-ref`) only when it's behind AND ahead==0 (upstream strictly descends); the checked-out branch only via `git merge --ff-only` on a CLEAN tree, skipped otherwise; diverged branches (ahead>0 && behind>0) are reported, never touched (`git_sync_local_branches`, gated behind the `f5SyncsLocalBranches` setting).

## fix/git-graph-perf (#431): Author scan, coupled status scans, commit-file cache, cursor paging
- One `git-status-changed` was several full working-tree scans. Every graph reload paired `git_log` with a full `git_status` scan, and `scmStore.refreshSummary` + `gitStatusStore.refresh` fired on the same event — the SCM summary and the graph each scanned independently. Fix: `state/git-summary-cache.ts` — ONE per-repo `git_status` fetch with in-flight dedup (concurrent callers await the SAME promise) + a short (~1.5s) TTL (a caller arriving shortly after a scan reuses it). SCM `refreshSummary` passes `{force:true}` (change-driven → must observe a post-mutation scan, but still joins an in-flight fetch); the graph's `fetchPage0Snapshot` and its uncommitted-row selection are passive (no force) so they share whatever's fresh. Deliberately NOT wired to `subscribeGitChanges` for invalidation: the freshness contract is "forcing callers bypass the TTL," which also survives test mocks that keep only the last subscriber. Share the FETCH, not the stores — per-pane `getScmStore` semantics are untouched.
- A per-branch revwalk with a `find_commit` per step is `O(branches × cap)` commit decodes, re-run on every popover open. `collect_branch_authors` walked up to 2000 commits *per branch* (remotes included). Fix: ONE revwalk seeded from all tips (hiding trunk) decodes each branch-unique commit exactly once into an in-memory `oid → (author, time, parents)` map; per-branch "creator" attribution is then a cheap in-memory traversal of that map. Attribute the creator as the oldest ROOT of the branch-unique set (a unique commit whose parents are all in trunk), NOT min-author-time — test commits created in the same wall-clock second share a timestamp, so min-time picks the wrong commit; the topological root is timestamp-independent. Cache per repo keyed by a tip-OID signature (sorted `name=oid`), invalidated when any tip moves.
- Commit file lists are immutable per OID — cache them. Selecting a commit re-invoked `git_commit_files` every click; a 50-entry LRU keyed by `repo+oid` makes re-selection instant. The uncommitted row is NOT cached here (its contents change) — it reuses the shared summary cache instead.
- `next_cursor` beats a numeric skip for resuming a paged revwalk. libgit2 has no random access, so page N still walks to the offset — but an OID cursor (the previous page's last REAL commit) is immune to the woven-stash off-by-N (#432): it keys on a commit that IS a walk step, not on a returned-row count that includes synthetic stash rows. Backend discards up to and including the cursor OID then collects; the frontend uses the cursor for unfiltered/local-only views and keeps the real-commit-count skip for filtered queries (the cursor is keyed to the unfiltered walk). A cached page-0 snapshot must store the cursor matching ITS slice (last real commit of the first page), not a deeper page's cursor, or a remount resumes with a gap.

## fix/e2e-tauri-real-backend-regressions (#447): tauri-driver specs share one localStorage
- Every tauri-driver session drives the SAME WebView origin (`http://localhost:<devUrl>`), so **localStorage persists across spec files** — one spec's persisted UI state is another spec's startup state. The new `git-graph-pull.spec.ts` (#432) opened the commit graph via the palette and never closed it; the per-pane `gitGraph` field (persisted by `window-tabs` since #272) survived teardown, so every spec that launched afterward restored into graph mode. In graph mode `ExplorerPane` renders `GitGraphView` INSTEAD of `FileList`, so `.file-list` never existed and each spec's `navigateTo` timed out at 15s. Mock-Playwright can't see this: it never persists real tab state. Evidence that nailed it: dumping `document.querySelector('.explorer-pane').innerHTML` on the timeout showed a live `[data-testid="git-graph-view"]`, and the persisted `explorer-tabs` key carried `"gitGraph":"…"`.
- The differing local-vs-CI failure SETS were a red herring pointing at "a race": it's fully deterministic state contamination. Which specs fail is just which ones the glob happens to order AFTER the graph-leaking spec — and that order differs by platform/filesystem. Same cause, different victims.
- Fix (two layers, no timeout padding): (1) a dev-only `e2e-reset-view` window hook in `+page.svelte` closes the active pane's graph (`setPaneGitGraph(id, null)` for every `activePaneId`); `navigateTo` dispatches it in a poll loop before waiting for `.file-list`, so ANY spec self-heals a restored graph regardless of order. (2) `git-graph-pull` cleans up after itself in `after()` (dispatch the reset, await `.file-list`) so graph state never persists past the leaker — covers specs like `terminal` whose first assertion waits for `.file-list` directly without `navigateTo`. Lesson: a WebDriver suite that shares a WebView origin needs every spec to leave persisted UI state at its default, or a shared precondition helper that normalizes it — treat localStorage like any other test fixture that must be reset.

## test/commit-files-lru-nul-escape (#451): literal control bytes make a source file binary
- A LITERAL NUL byte in source (the commit-file cache key separator, written as an actual 0x00 inside a template literal instead of the `\0` escape) flips git and grep into binary mode for the whole file: `git diff`/`git show` collapse to "Bin X -> Y bytes", grep reports "binary file matches", and code review of that file silently degrades. Runtime-identical fix: spell it as the `\0` escape sequence (two source characters). If you need a separator in a compound cache key, the escape gives the same runtime string with none of the tooling damage.
- Source-pinning tests (a test that `readFileSync`s a component to keep a byte-faithful replica honest, per the #431 LRU verification) must pin the SOURCE characters, not the runtime value: `"...\0..."` in the test's own double-quoted string is a runtime NUL and only matches a literal NUL byte in the pinned file; matching the escape requires `"...\\0..."`. When the pinned source changes representation without changing behavior, the pin — not the replica — is what needs updating.

## fix/git-repo-folder-icon (#463): "missing" icon was never built, not a regression
- `git log -S"isGitRepo" -S"is_git_repo" --all` plus history on `FileIcon.svelte`/`dir_listing.rs` turned up zero prior file-list-row git-repo icon logic — the only existing git-aware icon surfaces are the `WindowTabBar.svelte` tab-title decoration (`isGitRoot`) and a sidebar bookmarks "Repos" icon, both unrelated to folder rows. A "regression" report with no code trace of the reported behavior is worth 10 minutes of `git log -S`/history-grep before assuming a bisect is needed — it can turn an investigation into a straightforward net-new feature build instead.
- Implemented as: backend flags `FileEntry.is_git_repo` in `metadata_to_entry` (`src-tauri/src/files/mod.rs`) with one `path.join(".git").exists()` stat per *directory* entry — cheap relative to `is_empty`'s per-subdirectory `read_dir` (which listings deliberately skip, #129) since `exists()` is a single stat, not an enumeration. `.git` checked as either dir (normal repo) or file (worktree/submodule gitlink) via the same `exists()` call. `FileIcon.svelte` is the single shared icon renderer for all 3 view modes (Details/List via `FileItem.svelte`, Tiles via `TilesView.svelte`), so a display feature added there needs no per-view wiring — same pattern as the existing symlinked-folder icon.
- Before assuming `commit.summary()` carries a leading `\n` (the issue's hypothesis — `.detail-message` uses `white-space: pre-wrap`, which would render one as a blank line), read the vendored libgit2 source (`libgit2-sys-*/libgit2/src/libgit2/commit.c`): `git_commit_message()` strips ALL leading `\n` on every read (any origin, not just git2-created commits), and `git_commit_summary()`'s paragraph-detection either produces clean text, collapses stray whitespace to one space, or returns empty — never "blank line then text". `git_stash_foreach`'s message likewise comes from `git_reflog_entry_message` (`stash.c`), which is single-physical-line by construction. Confirmed empirically too: a scratch `#[test]` creating a commit/stash with an injected leading `\n\n` still read back clean via `commit.summary()`/`stash_foreach`. Trimming there anyway is cheap and correct (belt-and-braces for `weave_stashes`, which does hand the field a raw un-prettified string), but a repro-first regression test for the *producer* has to bypass the real git plumbing and call `weave_stashes` directly with a hand-built tuple — going through `stash_save`/`stash_foreach` can't produce the failing input.

## feat/git-graph-inline-commit-panel (#466): mock backend must mirror the graph mutation, not just record it
- An outcome E2E ("commit → the new commit row appears in the graph") is only meaningful if the mock actually moves history. The pre-existing `git_commit` mock recorded into `__mockGitCommits` and emptied `staged`, but never touched the `git_log` graph — so the graph would refresh to the *same* rows and a "new commit appears" assertion would fail (or, worse, a weaker assertion would pass vacuously). Fix: have the mock `git_commit` call the existing `mockAppendCommit(summary)` (already used by cherry-pick/revert/merge/rebase mocks) so it weaves a real row and advances HEAD/main, mirroring what the backend's `git_log` re-read does. Rule: when a mock action has a user-visible consequence in another view, simulate the consequence, not just the bookkeeping.
- Removing display markup ripples into existing outcome tests. Replacing the uncommitted row's per-file `.file-staged-badge` with grouped "Staged Changes"/"Changes" sections broke `git-graph.spec.ts`'s `#221` test, which asserted `.file-staged-badge` count == 1. Grep existing specs for the CSS classes / testids you're deleting before you delete them — the badge assertion was the only place the old marker was pinned, and svelte-check won't catch a removed-selector assertion in a `.spec.ts`.
- Reuse the existing refresh policy verbatim; don't invent a graph-local one. The commit handler routes through the same path the graph's other mutating actions use — `reload()` (regenerates history + working-changes count) + `notifyLocalGitChange(repoPath)` (badges via `gitStatusStore`, which refreshes on *every* change incl. local; the graph's own watcher subscription filters `source:"local"` so this can't double-reload) — plus a guarded `scmStore.refresh()` only when the pane's SCM store is on the same repo (the #102 double-refresh, since `scm.svelte.ts` ignores local notifies). Stage/unstage skip `reload()` entirely: staging doesn't change the synthetic row's count, so only the panel's file list + badges need refreshing.
- The panel's state machine lives in `domain/commit-panel.ts` (pure, immutable transitions: idle→committing→idle, message preserved on `commitFailed`, cleared on `commitSucceeded`), unit-tested through the import; the component holds only a `$state<CommitPanelState>` and calls the transitions. A partially-staged file (staged edits + further working-tree edits) legitimately appears in BOTH the `staged` and `changes` buckets — `buildStageFiles` emits it twice with distinct `staged` flags, and the `{#each}` key must include the section (`section + ":" + path`) or the two rows collide.

## feat/git-graph-inline-commit-panel (#466) — adversarial-review fixes
- `git_commit` (git2) had NO nothing-staged guard: `index.write_tree()` + `repo.commit()` happily fabricate a spurious EMPTY commit when the index matches HEAD's tree (verified empirically — the earlier "commit-panel" work relied only on the frontend `canCommit` to prevent it). git itself refuses this without `--allow-empty`. Fix: after resolving the parent, reject when `tree_oid == parent.tree_id()` (or `tree.is_empty()` on an unborn branch), mirroring the mock's "nothing to commit". Defense-in-depth: the UI already disables the button, but the command is the real contract boundary — guard it there and temp-repo-test it (empty index → error, HEAD unchanged).
- An in-flight guard tied to resettable component state is not a guard. The commit panel's `phase` lived in a component `$state` that `closeDetails()` re-initialised, so Escape → reopen → commit within the async `gitCommit` window could fire a SECOND concurrent commit. Fix per #444: move the live instance into an importable per-pane rune store (`state/commit-panel.svelte.ts`); the transitions stay pure in `domain/`. The store exposes an atomic `begin(): boolean` (false while committing) and `resetIfIdle()` (no-op while committing) so close/reopen can't drop the guard — and it's unit-testable by driving begin()/resetIfIdle() directly.
- `workingChanges` (the "Uncommitted Changes (N)" count) sums all four summary bucket lengths, so a partially-staged file is double-counted (it's in both `staged` and `changes`). Stage/unstage skipped `reload()`, so toggling such a file left the header stale by one until a watcher event. Fix: always `reload()` after stage/unstage (via a shared `afterStageChange`), recomputing the count from the canonical summary through the existing refresh channel — no private refresh machinery.
- Verifying an e2e "flake" claim: don't trust a 3/3 isolated pass. `git-graph.spec.ts:270` (branch filter, untouched by this work) failed under the suite; stashing ALL local changes back to the committed feature and re-running showed 0/6 during vite HMR churn and 4/6 once the dev server warmed — proving it's an environmental/server-warmup flake, identical on the pre-change baseline, not a regression. The stash-to-baseline A/B is the way to separate "my change broke it" from "this test is flaky here".
## fix/tab-title-git-icon (#471): "regression" was an opt-in setting defaulting off since birth
- `git log -S"tabTitleGitRoot" --all` shows exactly one commit touches the setting: `22a0e320` (#281's predecessor), which introduced the whole feature — decoration, cache, and the `tabTitleGitRoot: false` default — in the same diff. There is no earlier state where the icon rendered unconditionally to regress FROM; `git show 22a0e320 -- WindowTabBar.svelte` is a pure `+11` addition, no prior git-icon code existed at all. Same shape as #463's "missing icon" report: a "regression" with no code trace of the claimed prior behavior is a `git log -S` away from being reclassified, in ~10 minutes, before touching any logic.
- Confirmed via the mock e2e suite (`e2e/tab-title-git-root.spec.ts`, all 3 cases green pre-fix) that the `isGitRoot`/git-icon chain (`tab-display.svelte.ts` → `WindowTabBar.svelte`) has never malfunctioned: it correctly showed the icon whenever `settingsStore.tabTitleGitRoot` was on. The bug users hit is that it was never on unless they found and toggled a settings-dialog checkbox — a tab opened on an everyday git repo (no manual opt-in) always showed the plain folder icon, which reads exactly like a regression from the user's chair.
- Fix: flip `DEFAULT_SETTINGS.tabTitleGitRoot` to `true` (`src/lib/state/settings.svelte.ts`) — no changes needed to the decoration logic itself, since it was already correct. The async `git_repo_root` probe this enables is a cheap, per-folder-cached directory-discovery walk (not a full status scan like `showGitStatus`, which stays opt-in for exactly that cost reason — see the WSL 9P comments in `git.rs`), so defaulting it on doesn't reintroduce the perf concerns that justify other git features staying off by default. The setting itself is untouched and still lets a user turn the decoration back off.
- Test-seam note: `tab-display.svelte.ts` reads `settingsStore` as a live singleton (not injected), so the regression test (`tests/state/tab-display.test.ts`) exercises it through `createWindowTabsManager()` + the real `settingsStore`/`gitRepoRoot` mock-invoke path rather than a pure unit of `createTabDisplay` alone — asserting the DEFAULT is on is itself part of the behavior under test, so a fully-injected fake setting would have hidden exactly the bug this issue reports.

## chore/file-list-scroll-jank-investigation (#469): residual scroll jank = Details view rendered EVERY row (virtualization silently defeated)
- Root cause was a **missing flex `min-height: 0`**, not anything in `VirtualList`/scroll-coalescing/derivations (those are all fine). `VirtualList`'s `.virtual-viewport` (`overflow-y:auto`, binds `clientHeight`→`viewportHeight`) is meant to be the vertical scroller. In DetailsView the flex chain `.content(overflow:auto) > .details-view > .virtual-viewport` left `.details-view` at the flex default `min-height:auto`, so it could NOT shrink below its content height → the viewport grew to the full list height (5000 rows × 32px = 160000px `clientHeight`), `overflow-y:auto` never engaged, `.content` became the actual scroller, and `viewportHeight = full list height` → `visibleCount` covered the whole list → **all 5000 `FileItem`s were live in the DOM**. Measured (Chromium, 5000-entry synthetic dir): Details `.virtual-item` count 5000 vs List 33 / Tiles 14; a fast fling produced 21 long tasks / 1255ms blocked in Details vs 0 in List/Tiles. Fix: `.details-view { min-height: 0 }` — one line, matching what `.list-view`/`.tiles-view` already had (that's why only Details janked). Drops Details to ~30 DOM nodes, 0 long tasks; headers stay pinned, horizontal column scroll (`.content`) still works.
- **The whole codebase already assumed `.virtual-viewport` is the scroller** (marquee reads `.virtual-viewport?.scrollTop`, `scrollToIndex` writes `viewportRef.scrollTop`) — the layout just quietly disagreed, so the symptom was "slightly laggy," not "broken." A flex virtualizer that renders everything degrades *gracefully* into ordinary jank, which is exactly why it hid for so long.
- **No test caught it because none asserted windowing.** Unit/jsdom can't: it's pure CSS flexbox with no layout engine. Added `e2e/details-virtualization.spec.ts` (Chromium) asserting the *outcome* — a large dir renders a windowed subset (`.virtual-item` < 200, not 5000) and `.virtual-viewport` (not `.content`) is the scroller. Gold-standard verified: fails with the one-line fix reverted, passes with it. Any flex-wrapped `VirtualList` needs a `min-height:0` chain down to the viewport, or it silently renders the whole list — add a windowing assertion whenever you add a virtualized view.
- Profiling caveat: browser profiling is Chromium; the real app is WebKitGTK. The **cause** (DOM node explosion) is engine-independent CSS flexbox and reproduces identically. Absolute per-frame times from headless Chromium were a uniform ~46ms across ALL view modes even after the fix (and even for List/Tiles that were always correct) → that number is headless rAF/vsync pacing, NOT real fps; only DOM-node and long-task counts are trustworthy signals here. To profile a huge dir outside Tauri, `mock-invoke.ts` now serves a synthetic `/perf/huge` (or `/perf/huge-N`) directory.

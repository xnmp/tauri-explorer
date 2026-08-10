# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

| Task                                  | Command                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev server (frontend only)            | `bun run dev`                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Dev server (full Tauri app)           | `bun run start`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Clean rebuild                         | `bun run clean` (full) or `bun run clean:fast` (skip Rust)                                                                                                                                                                                                                                                                                                                                                                       |
| Type check                            | `bun run check`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Unit tests                            | `bun run test`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Single unit test file                 | `bunx vitest run tests/path/to/file.test.ts`                                                                                                                                                                                                                                                                                                                                                                                     |
| E2E tests (default view)              | `bun run test:e2e`                                                                                                                                                                                                                                                                                                                                                                                                               |
| E2E tests (all view modes)            | `ALL_VIEW_MODES=1 npx playwright test`                                                                                                                                                                                                                                                                                                                                                                                           |
| E2E tests (WebKit ≈ WKWebView proxy)  | `WEBKIT=1 npx playwright test --project=webkit` (on Arch: prepend `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true`; Ubuntu-only libs live in the webkit bundle's `sys/lib`)                                                                                                                                                                                                                                                     |
| Single E2E test                       | `npx playwright test e2e/specific.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| Tauri-binary E2E (Linux/Windows only) | `bun run test:e2e:tauri` (needs `cargo install tauri-driver`, `webkit2gtk-driver` on Linux, and a binary built via `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle` — the Tauri CLI, not `cargo build` (which serves `devUrl` and silently needs a dev server on :1420), and the hooks flag, without which every spec fails at "dev e2e hooks never became ready"; see `docs/lessons/457-windows-tauri-smoke-hang.md`) |
| Performance tests                     | `bun run test:perf`                                                                                                                                                                                                                                                                                                                                                                                                              |
| High-load stress tests                | `bun run test:load` (own Playwright config on :1430; many git-graph tabs, leak churn, CPU throttle, 256MB heap cap; `LOAD_CYCLES=N` scales churn)                                                                                                                                                                                                                                                                                |
| Rust criterion benches                | `bun run bench:rust` (baselines recorded in `src-tauri/benches/*.rs` header comments)                                                                                                                                                                                                                                                                                                                                            |
| Bundle-size budget check              | `bun run check:bundle` (builds frontend, fails if main chunk gzip exceeds budget in `scripts/check-bundle-size.mjs`)                                                                                                                                                                                                                                                                                                             |
| Rust build only                       | `cd src-tauri && cargo build`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Runnable release binary               | `bun run build && cd src-tauri && cargo build --release --features tauri/custom-protocol` — a bare `cargo build --release` yields a DEV-mode binary that dials localhost:1420 (Tauri gates prod on the `custom-protocol` feature, which only the Tauri CLI passes)                                                                                                                                                               |
| Rust tests only                       | `cd src-tauri && cargo test`                                                                                                                                                                                                                                                                                                                                                                                                     |

### WSL ↔ Windows: always `git push` after committing

When developing in WSL (e.g. on the `windows` branch), the Windows side builds/tests by pulling from the remote — it does **not** see your WSL working tree. A commit that isn't pushed never reaches the Windows build, so the fix appears to "not work" when it simply never arrived.

## Architecture Overview

**Stack:** Tauri v2 (Rust backend) + Svelte 5 (runes) + TypeScript + Vite 6. Package manager: `bun`.

Frontend layers (`src/lib/`): `domain/` (pure logic, no framework deps — put business logic here), `state/` (rune stores), `api/` (IPC wrappers; `mock-invoke.ts` fakes the backend outside Tauri, detected via `__TAURI_INTERNALS__`), `composables/`, `components/`, `themes/`. Backend (`src-tauri/src/`): all Tauri commands must be `async fn` (sync blocks the main thread). Entry point `src/routes/+page.svelte` composes the layout and owns global shortcuts.

Rules that bite:
- Repository-folder Git badges read `--icon-git-badge` from each active theme;
  keep it distinct from `--icon-folder` (the Hacker theme deliberately uses its
  darker terminal green) and cover every file-list view mode when changing it.
- Three view modes (Details/List/Tiles) dispatched by `FileList.svelte` — display features must land in all three.
- Keep high-frequency hover feedback on file entries, sidebar navigation, and tabs immediate. Preserve motion for one-shot structural events (such as tab enter/close), but do not add CSS transition settling to pointer highlights; it reads as input latency even when the main thread is idle (#503).
- Refresh policy is split deliberately: WHEN=`refresh-manager`, WHETHER=`pane-watch`, HOW=`pane-refresh`. Don't add a fourth gate, and don't build private refresh stacks inside components — the git graph did, and it produced #431/#432.
- Watcher callbacks are delayed work: capture the explorer path when queuing a refresh and drop the callback if that explorer navigates before it runs. Preserve the backend observation time too: notify delivery can lag behind a trailing listing, and treating an already-covered change as new work creates a third refresh. Otherwise an event attributed to the old directory refreshes the new one and corrupts both directories' cadence.
- Pane focus is **state, not DOM focus**: `ExplorerPane` gates its window-level keydown listener on `windowTabsManager.activePaneId === paneId`, so moving focus between panes is `setActivePane` alone — calling `.focus()` on the pane element is neither necessary nor sufficient. Assert on `.explorer-pane.active`, not on `document.activeElement`.
- ExplorerPane owns window-level file-list shortcuts, but FileList owns each virtualized view's scroller. Selection jumps that can target an unmounted row must use FileList's bound `scrollToEntry` seam so the selected entry is rendered and visible before focus moves to it.
- Native window titles have two phases: every creation path (Rust main, fresh child, parked warm window) must seed the requested title before visibility, then the page's reactive `window-title` sync follows the active explorer path across navigation/tab/pane changes.
- New-window address-bar focus likewise has fresh and warm paths: fresh children request it through their launch URL, while activated warm windows dispatch the request only after the requested navigation and native focus. Wait for the explorer's initial path before mounting `BreadcrumbAutocomplete`, because it captures that path only on mount.
- Recycle Bin is a native shell surface, not a portable directory path: launch it through `system::open_recycle_bin` (Windows uses `shell:RecycleBinFolder`, Linux uses `trash:///`, macOS opens `~/.Trash`) instead of sending it through directory listing.
- Keep state machines and caches out of component-local scope (`<script module>` in a `.svelte` file is not a state layer). If it can't be unit-tested through an import, it will eventually be wrong unobserved (#444).
- Plugin context-menu actions that invoke an AI service carry `group: "ai"`; `ContextMenu.svelte` renders those applicable actions in its shared AI submenu while leaving non-AI plugin actions top-level.
- Miller columns cache ancestor listings independently of the active pane. Publish the affected parent directory after local mutations so their visible source column refreshes immediately (#598).
- Quick Open keeps local active-pane/recent/frecency matches immediate and caps the merged rendered list at 20 rows; rendering thousands of active-directory matches blocks the input even when matching itself is cheap. Its recursive backend walk goes through `domain/quick-open-search.ts`; retain its trailing debounce and invalidate an active stream on new input so large deferred trees do not compete with typing. Completed walks are cached briefly in `search_cache.rs` only while the root has an active filesystem watcher; unwatched roots always walk fresh, cancelled walks are never published, and publication must retain the pre-walk invalidation revision so a watcher event racing a cold walk cannot resurrect stale entries. Detach the captured stream listener before awaiting cancellation IPC, or a late cancellation can remove its replacement (#600, #651).
- Terminal focus gives terminal-hosted applications ownership of every key except the small, availability-aware core-navigation allowlist in `domain/terminal-keys.ts` (Quick Open, Command Palette, previous/next tab, and the configured terminal-toggle chord). Keep the ownership decision shared by `+page.svelte` and `TerminalPanel.svelte`; chord prefixes and suffixes must be checked against the eligible command ID so other chords sharing a prefix stay terminal-owned, and a terminal-owned mismatching suffix must cancel the pending Explorer chord before another key can complete it.
- Fixed overlays under root CSS zoom are engine-specific: `fixedFromClient` and `fixedFromRect` divide once only on Chromium; WKWebView uses two divisions, while WebKitGTK's CSS-space rect offsets its second scale. Keep the live Chromium check wired through the context-menu conversion (#493).
- Zoomed image previews update their `transform` for every pointer move. Keep the compositor hint scoped to `.preview-image.zoomed`, so active panning stays smooth without retaining layers for every ordinary image preview (#635).
- Repository-folder Git badges are rendered directly by `FileIcon.svelte` in every directory view. Keep their compact corner geometry and their `--icon-git-badge` / `--icon-git-badge-glyph` theme overrides together when polishing the SVG (#601).
- Git graph lineage is first-parent topology plus the branch paths from
  `assignLayout`, never a lane number or color: paths can curve between lanes
  and color slots are recycled. Compute trace/jump semantics in the domain
  layer, then pass the classified rows and path segments to the renderer.
- Base-update merge muting follows an open PR's first-parent chain and checks
  each non-first parent against the configured base ref's reachable history.
  Keep both the base ref and selected GitHub remote in the PR IPC shape so a
  current remote-tracking base wins over a stale local base; a merge merely
  adjacent to a PR ref is not enough to classify it as housekeeping (#527).
- Git-graph commit comparison is a tree-to-tree operation, not a first-parent
  diff: normalize the chosen commits to older → newer before requesting both
  the changed-file list and every per-file patch, including preview-pane routes.
- Git-graph undo snapshots come from the Rust mutation command, stay session/repository-scoped in `state/git-graph-undo.ts`, and are re-verified by `git_undo` before the inverse. Merge/pull undo requires unchanged HEAD + a clean tree; tag deletion records the raw tag-object OID so annotated tags restore exactly (#513).
- Git-graph tabs remount on activation; their snapshot cache must retain the supported 12-tab load fan-out so switching back can paint cached history instead of starting a new git-log request. External watcher changes evict the snapshot; valid cached remounts skip the redundant graph reload (#505).
- Git-graph fetch, pull, and remote-branch push share one client-ID network-operation lifecycle in `git-graph-refresh.ts`. Per ADR 0006, fetch enumerates `fetch --all`-eligible remotes (respecting `skipFetchAll`/`skipDefaultUpdate`) and updates each one atomically; ordinary remote errors are aggregated after later remotes run, while cancellation stops immediately between remotes. Only the unbounded network phase is killable: pull receives a per-invocation IPC phase channel before starting, then must deliver the transition from atomic fetch to local fast-forward (or fail closed before moving HEAD) so the banner switches to “Finishing Git pull…” and removes the now-ineffective Cancel control while preserving completed-pull undo; remote-delete cancellation reports that the remote may already have applied it (#528).
- User-report images are hosted as public Vercel Blobs before the relay creates
  the GitHub issue. Production therefore needs `BLOB_READ_WRITE_TOKEN` as well
  as `GITHUB_ISSUE_TOKEN`. Keep the raw attachment total at or below 3 MiB so
  its base64 JSON request stays below Vercel's 4.5 MB function-body limit.

## Documentation

- **Start at [docs/code-map/](docs/code-map/)**: [map-feature.md](docs/code-map/map-feature.md) for cross-layer work and bug hunts, [map-playbook.md](docs/code-map/map-playbook.md) recipes for task-shaped changes (new palette command / context-menu action / Tauri command / setting), [map-folder.md](docs/code-map/map-folder.md) as the exhaustive per-file index. For a small localized change you can already name, skip the maps and grep (measured net loss on cheap tasks; prose architecture docs were deleted for the same reason — see [STUDY.md](docs/code-map/STUDY.md)).
- **Keep the maps current or they turn harmful.** New/moved source file → update `map-folder.md` (+ the `map-feature.md` cluster), then `python3 docs/code-map/validate.py --coverage`. CI runs the same check.
- [docs/lessons/](docs/lessons/) — gotchas from closed issues, **one file per issue**: write `docs/lessons/<issue>-<slug>.md` when you fix a bug (never append to the frozen [docs/lessons_learnt.md](docs/lessons_learnt.md) archive — shared-file appends conflicted every open PR, #544). When hunting a bug, search both: `grep -ri <term> docs/lessons/ docs/lessons_learnt.md`.

## Issues, Branches, Screenshots

- All development happens off `dev`; feature branches merge back to `dev` with a descriptive squash commit. Don't modify files directly on `dev`. At session start, convert tasks in [@new_todo.md](@new_todo.md) into GitHub issues (plan first; the plan can live in the issue body).
- Branch ↔ issue convention: branch `feat/my-feature` must match an **open GitHub issue** whose title contains `my-feature`; a hook validates this at branch creation. Prefixes: `feat/`, `fix/`, `refactor/`, `docs/`, `test/`, `chore/`.
- Relationship tooling (blocking, sub-issues) is the `jwilger/gh-issue-ext` extension (`gh issue-ext …`).
- Issue bodies need a `## Screenshots` section with checkboxes; files go in `screenshots/<branch>/` and the merge hook verifies they exist. "None required" is only for changes with no user-visible effect; behavioral fixes still need one showing the corrected behavior. Verify a screenshot actually demonstrates the feature before counting it.
- Keep `evidence/` available for committed image-only PR acceptance proof: the automated review gate renders those files directly from the PR. It is distinct from issue screenshots, so do not add a blanket `evidence/` ignore rule.
- The merge hook does **not** close issues — close them yourself (`gh issue close N --comment`) when the work lands on dev.
- Before ending a session that merged UI work: `ALL_VIEW_MODES=1 npx playwright test`.

## Verification

The three test tiers see different things; pick by what could actually break:

1. **Vitest (`tests/`)** — domain logic and store behavior. The default home for every fix's regression test.
2. **Browser Playwright (`e2e/`)** — UI behavior against `mock-invoke.ts` on :1420. Good for interaction/focus/layout. **Structurally blind to backend timing** (watchers, git, IPC latency), and **circular for new backend features**: if you wrote the mock, the test proves the UI agrees with your own assumption, not with the backend.
3. **Tauri-binary E2E (`e2e-tauri/`)** — WebdriverIO + tauri-driver against the real binary: real Rust, real fs watchers, real git (see `e2e-tauri/README.md`; keep this suite small and reserve it for what genuinely needs the real backend).

WebKitWebDriver may evaluate `browser.execute` in an isolated JavaScript world.
Use DOM events/state to communicate with dev-only application probes; mutating
application globals such as `window.__TAURI_INTERNALS__` from the injected
script can remain invisible to the app even when later injected scripts read
the mutation back. Publish hook readiness and acknowledge each operation with a
unique DOM token before polling its result; repeatedly dispatching an operation
while waiting can queue duplicate real backend work that outlives the poll.
Real-watcher timing tests must also wait for the backend watch and frontend
listener to be ready, then acknowledge every filesystem write at the
application-side watcher callback before attributing listing counts to it. A
receipt-count increase alone is insufficient: require its backend observation
time to be at or after that specific write began so an older delayed event
cannot advance the protocol.

Anything whose failure mode involves races, watcher timing, git state, or cache staleness needs tier 3 or a Rust temp-repo test in `src-tauri` — a green mock E2E is not evidence for those.

Config autoreload tests must write through the canonical target of any symlinked config file or theme directory; watching the link itself does not prove inotify observes the target.

The public report relay under `website/api/` uses `GITHUB_ISSUE_TOKEN` only for issue creation. Production spam counters must use the shared REST KV variables `KV_REST_API_URL` and `KV_REST_API_TOKEN`; when Vercel is detected without them the endpoint fails closed. The in-memory counter is intentionally limited to local development and unit tests.

**Repro-first for bug fixes.** Before changing logic, write the test that fails for the reported reason (or demonstrate the failure at the pre-fix commit). Gold standard: the test passes on your branch and fails with the fix reverted. If the buggy logic has no importable seam, extracting the seam is part of the fix — don't settle for verifying a transcribed copy.

**Adversarial verification for high-risk changes.** Concurrency, caching, perf claims, and anything self-graded by its implementer gets a separate verifier (a subagent with no stake in the claims) that tries to _falsify_ each claim — staleness attacks on caches, interleaving attacks on async flows, measured numbers for perf claims — and reports CONFIRMED / PLAUSIBLE / REFUTED per claim. This found real bugs both times it was run; budget for it on any structural change.

**E2E tests assert outcomes**, not existence — a QuickOpen test verifies results appear for a query, not that the modal opened.

Markdown preview content is inserted with `{@html}` in `PreviewPane.svelte`, so its element styles require `:global(...)`; keep heading and link colours on the existing theme variables and verify their computed colours in the browser.

The Linux FileChooser portal is selected through the user's
`~/.config/xdg-desktop-portal/portals.conf`; do not add deprecated `UseIn`
desktop matching to `packaging/tauri-explorer.portal`.

SCM archive actions preserve each repo-relative path under `.archive/` and add
`.archive` to `.gitignore`; this keeps archived files out of the Untracked list.

## Delegation & Subagent Worktrees

- If the main model is Fable, tokens are very expensive, so whenever possible delegate work to Opus and Sonnet subagents. Use Fable only for high level synthesis and understanding. Do NOT use Fable subagents unless explicitly instructed to.
- Agent-tool worktrees are created from **main**, not `dev`: a delegated agent must start by branching from `origin/dev` (or the coordinator's integration branch), and the coordinator verifies `git merge-base` before merging.
- Agents work **only inside their worktree cwd with relative paths**. Absolute paths leak edits into the main checkout — it has happened; coordinators should spot-check `git -C <main-repo> status` while agents run.
- Port :1420 belongs to the main session. Agents needing a dev server or E2E run use their own port with a throwaway config.
- Squash-merge conflicts in `map-feature.md` are usually both-append — resolve as a union, checking for line-level supersedes. (`lessons_learnt.md` is frozen; lessons are per-issue files now, which cannot conflict.)

## Debugging

When a bug resists quick diagnosis: search `docs/lessons/` + the frozen `lessons_learnt.md` archive and commit history first, then add targeted logging/instrumentation before another fix attempt. Suite-wide test timeouts (~5 s) under parallel/CPU load are a known flake mode — rerun the failing files in isolation before treating them as regressions.

`createWindowTabsManager().dispose()` is asynchronous: await it in test teardown so
explorer directory-listener cleanup settles before Vitest closes the worker (#611).

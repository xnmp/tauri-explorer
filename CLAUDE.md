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
| Tauri-binary E2E (Linux/Windows only) | `bun run test:e2e:tauri` (needs `cargo install tauri-driver`, `webkit2gtk-driver` on Linux, and a binary built via `VITE_E2E_HOOKS=1 bun run tauri build --debug --no-bundle --features e2e-hooks` — the Tauri CLI, not `cargo build` (which serves `devUrl` and silently needs a dev server on :1420), and both hook gates (frontend flag + Rust feature; `src/lib/api/e2e-hooks.ts`), without which every spec fails at "dev e2e hooks never became ready"; see `docs/lessons/457-windows-tauri-smoke-hang.md`) |
| Native-suite TypeScript check          | `bun run check:e2e:tauri`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Extended native soak (opt-in)         | From a clean worktree run `bun run build:native:qualification`, then `SOAK_DURATION_MS=14400000 SOAK_SEED=<repro-seed> SOAK_EXPECTED_DISPLAY_SCALE=<native-scale> bun run test:e2e:tauri:soak` (`SOAK_MAX_CYCLES=1` gives a bounded real-native check; the runner verifies the generated build manifest, and reports/screenshots land in `qualification-results/`)                                                               |
| Performance tests                     | `bun run test:perf`                                                                                                                                                                                                                                                                                                                                                                                                              |
| High-load stress tests                | `bun run test:load` (own Playwright config on :1430; many git-graph tabs, leak churn, CPU throttle, 256MB heap cap; `LOAD_CYCLES=N` scales churn)                                                                                                                                                                                                                                                                                |
| Interaction perf sweep                | `bun run perf:sweep` (own config on :1440, `PORT` overrides; `PERF_SWEEP_OUT=f.json` writes medians). Copy `e2e-sweep/` + `playwright.sweep.config.ts` into an old release checkout to A/B; compare `taskMs` from concurrent runs (#1174) |
| Rust criterion benches                | `bun run bench:rust` (baselines recorded in `src-tauri/benches/*.rs` header comments)                                                                                                                                                                                                                                                                                                                                            |
| Bundle-size budget check              | `bun run check:bundle` (builds frontend, fails if main chunk gzip exceeds budget in `scripts/check-bundle-size.mjs` or the release build contains E2E hook code)                                                                                                                                                                                                                                                                                                             |
| Rust build only                       | `cd src-tauri && cargo build`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Runnable release binary               | `bun run build && cd src-tauri && cargo build --release --features tauri/custom-protocol` — a bare `cargo build --release` yields a DEV-mode binary that dials localhost:1420 (Tauri gates prod on the `custom-protocol` feature, which only the Tauri CLI passes)                                                                                                                                                               |
| Rust tests only                       | `cd src-tauri && cargo test`                                                                                                                                                                                                                                                                                                                                                                                                     |

When changing Rust code gated by `cfg(windows)`, also run
`cd src-tauri && cargo xwin check --target x86_64-pc-windows-msvc --lib --tests`
to type-check the Windows-only code from a Linux host. This requires
`cargo-xwin` to be installed on the host; without it, Cargo reports `no such
subcommand`. Windows CI remains the authority for Windows builds.

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
- Details-only columns (e.g. Length, #995) are the exception: their values are lazy per-row metadata requested by rendered `FileItem` rows through a cached resolver, never fields on directory listings.
- Keep high-frequency hover feedback on file entries, sidebar navigation, and tabs immediate. Preserve motion for one-shot structural events (such as tab enter/close), but do not add CSS transition settling to pointer highlights; it reads as input latency even when the main thread is idle (#503).
- Refresh policy is split deliberately: WHEN=`refresh-manager`, WHETHER=`pane-watch`, HOW=`pane-refresh`. Don't add a fourth gate, and don't build private refresh stacks inside components — the git graph did, and it produced #431/#432.
- Watcher callbacks are delayed work: capture the explorer path when queuing a refresh and drop the callback if that explorer navigates before it runs. Preserve the backend observation time too: notify delivery can lag behind a trailing listing, and treating an already-covered change as new work creates a third refresh. Otherwise an event attributed to the old directory refreshes the new one and corrupts both directories' cadence.
- Pane focus is **state, not DOM focus**: `ExplorerPane` gates its window-level keydown listener on `windowTabsManager.activePaneId === paneId`, so moving focus between panes is `setActivePane` alone — calling `.focus()` on the pane element is neither necessary nor sufficient. Assert on `.explorer-pane.active`, not on `document.activeElement`.
- Recently active window tabs stay mounted as hidden, inert `.pane-tree.retained` layers (`domain/retained-tabs.ts`, #1173), so a tab switch only toggles visibility. Their rows, panes and per-pane effects are live while hidden: scope DOM queries and E2E locators to the shown tab (`.pane-tree:not(.retained)` or Playwright `:visible`), and gate window-level per-pane handlers on manager state such as `activePaneId`, never on being mounted.
- ExplorerPane owns window-level file-list shortcuts, but FileList owns each virtualized view's scroller. Selection jumps that can target an unmounted row must use FileList's bound `scrollToEntry` seam so the selected entry is rendered and visible before focus moves to it.
- Native window titles have two phases: every creation path (Rust main, fresh child, parked warm window) must seed the requested title before visibility, then the page's reactive `window-title` sync follows the active explorer path across navigation/tab/pane changes.
- Native qualification must bind resource sampling to the verified manifest binary, retain run-specific driver output on failures, and normalize Rust `Duration` units before calculating startup percentiles. macOS cold-start attribution correlates native monotonic readiness with browser wall-clock boundaries: retain the residual as `unattributedMs`, keep foreground and warm samples separate, and never describe two animation-frame callbacks as compositor-presented pixels or a Dock bounce. The pre-`run` interval is its own `processEntryMs` phase (main.rs hands `run_with_process_entry` its entry instant); time before `main()` is outside every in-process clock and comes only from the runbook's launch recording. Startup marks belong to one owner: `window-session` records `mount`/`settings-ready`/`commands-ready`, `+page.svelte` only `bundle-exec`/`list-ready`/`app-ready`. `startup-timing` mirrors each recorded main-window mark (plus a bounded heartbeat) as a `Startup(webview-progress)` line; this adds no marks and changes no ownership, and the attributed parser must never read progress lines — only `startup-progress.ts` does, to describe a timeout (#936). One parser serves both the readiness predicate and the report: an independent readiness regex drifted from the emitted log format and would have failed every Mac sample (#696). A timeout reports that parser's last rejection, the last progress mark, and bounded `stall-evidence.ts` captures taken before the app is stopped; a capture failure only adds a clause to the timeout, never replaces it. Reject a residual below -(5ms + 500 ppm × launch total) — the wall-clock slew bound measured in CI (#936) — and any duplicated webview marker rather than publish a plausible decomposition, and let a `missed` measured half-bounce deadline fail the run while `unqualified` stays non-fatal. Interactive Mac evidence is ingested only from inside the qualification root and must match the verified binary SHA-256, hardware model, normal Launch Services method, sample count, and per-sample recording/trace plus functional-frame/input times. Per ADR 0021, raw replay seeds never become path components; signal exits, rejected force-kills, and children still alive after the force timeout fail the run, with process output preserved. WebdriverIO does not turn ordinary `afterSession` rejection into a failing command, so owned-process cleanup errors cross the worker/launcher boundary through run-scoped state checked by `onComplete`.
- Per ADR 0022, the native E2E target cache is keyed by the exact Rust compiler identity as well as target inputs. Keep its restore and save actions separate: save only after the native contracts and embedded build succeed, but allow a later GUI failure to retain those safe build products. Contract/provenance diagnostics upload before GUI execution so a failed contract remains inspectable while independent native checks run (#694). GitHub's explicit Bash shell enables `-e -o pipefail`; disable errexit only around a piped diagnostic command, capture `PIPESTATUS[0]`, then restore errexit before writing its timing artifact and returning that exact status (#697).
- A native WebDriver command can block until WebKitWebDriver deletes the
  session. Diagnose that interval with the bounded Node-side `/proc` sampler in
  `e2e-tauri/diagnostics/process-timeline.ts` only; do not issue another
  WebDriver command. Identify renderers by PID plus start time (not PID alone),
  retain capture errors rather than treating them as process absence, and
  always stop the sampler without changing the original rejection (#703, #781).
- macOS and Linux recover a terminated web process through one shared path (`renderer_owner::on_renderer_terminated`) by reloading the window's last committed document without `warm` and with `rendererRecovery=1`, under a per-window budget; parked warm windows are retired instead, and a WebKitGTK `terminated-by-api` teardown is never reloaded (`renderer_owner/reload.rs`, #942, #1138). Test harnesses must not reload a crashed WebView themselves; that would race the product's reload. Never read `WKWebView.URL` after termination (Wry unwraps a reset URL), and read every one-shot launch query parameter through `launchRequest` in `domain/window-launch-plan.ts` so a recovered document restores its session instead of replaying the launch. macOS and Linux (all webviews, with WebKitGTK's reason) log every loss as `Renderer(web-content-terminated)`; the startup qualifier never measures a sample containing it, records and replaces a recovered loss (one main document booted after it, by boot epoch rather than log order, reaches native-ready once), and fails an unrecovered loss or more than 3 recovered ones (ADR 0021).
- Investigation-only scaffolding carries `Retire-when: #NNN closed`; when closing an issue, grep for its tag and delete or promote what it marks (CONTRIBUTING.md).
- New-window address-bar focus likewise has fresh and warm paths: fresh children request it through their launch URL, while activated warm windows dispatch the request only after the requested navigation and native focus. Wait for the explorer's initial path before mounting `BreadcrumbAutocomplete`, because it captures that path only on mount.
- The sidebar Recycle Bin opens the in-app `trash://` location (#863), served by the built-in fs provider `state/trash-provider.ts`, which lazily loads `state/trash-location.ts` (listing, restore, menu actions) to keep the startup bundle under its cap. Restore sends only opaque entry IDs; the native registry maps them to artifacts captured by that listing, so the renderer can never name a trash payload (ADR 0019). A trash view has no watcher: anything that changes the trash publishes `trash://` through `broadcastFileChange`, and a failed trash listing is not a history entry.
- The external Recycle Bin launch (Trash view → "Open in System File Manager") is platform-specific and belongs in `system::open_recycle_bin`: Windows uses `shell:RecycleBinFolder`, macOS opens `~/.Trash`, and Linux requests the native `trash:///` view through FileManager1. On definite service unavailability, launch a registered graphical file manager for the absolute Freedesktop `Trash/files` directory (#660, #672, #757).
- Do not use generic `gio open trash:///` or `xdg-open` on `Trash/files` as proof of a graphical Trash view: the former can dispatch to a handler that rejects the URI asynchronously, while the latter can open a terminal as the directory MIME default. Treat uncertain FileManager1 responses as errors rather than launching a second manager (#660, #672, #757).
- Keep state machines and caches out of component-local scope (`<script module>` in a `.svelte` file is not a state layer). If it can't be unit-tested through an import, it will eventually be wrong unobserved (#444).
- Preview file-kind precedence lives only in `domain/preview-kind.ts`. File loaders,
  image holds/cache ownership and rendition upgrades live in `state/preview-content.ts`;
  replace `PreviewContent` as a whole. Keep selection-effect reads of content and
  geometry untracked so publishing a preview cannot start another request (#1206).
  Supply lazy PDF/video viewer factories from the component; even type-only
  component imports in state violate the architecture boundary (`bun run lint:arch`).
- Rust test modules included with `#[path]` from production modules belong in `src-tauri/test_support/`, not Cargo's auto-discovered `src-tauri/tests/`. Keeping source-included modules under `tests/` makes `cargo clippy --all-targets` compile them again as standalone integration crates, where their `super`/`crate` imports are invalid.
- The native crate is a desktop application library with no Rust doctest examples; keep `[lib] doctest = false` so shared qualification target caches cannot feed a zero-test rustdoc harness mixed-feature Tauri artifacts. Unit and integration tests remain under ordinary `cargo test` targets.
- Progress toasts must bypass the generic opacity entrance animation so accepted long-running work is visible immediately. Under load, WebKit can strand an entrance animation on its zero-opacity first frame; keep motion on the progress spinner instead.
- Plugin context-menu actions that invoke an AI service carry `group: "ai"`; `ContextMenu.svelte` renders those applicable actions in its shared AI submenu while leaving non-AI plugin actions top-level.
- The Theme from Image context-menu action also belongs in that shared AI submenu, even though palette extraction runs locally; keep its single, real-image selection predicate intact.
- Miller columns cache ancestor listings independently of the active pane. Publish the affected parent directory after local mutations so their visible source column refreshes immediately (#598).
- Quick Open keeps local active-pane/recent/frecency matches immediate and caps the merged rendered list at 20 rows; rendering thousands of active-directory matches blocks the input even when matching itself is cheap. Its recursive backend walk goes through `domain/quick-open-search.ts`; retain its trailing debounce and invalidate an active stream on new input so large deferred trees do not compete with typing. Completed walks are cached briefly in `search_cache.rs` only while the root has an active filesystem watcher and a separate recursive cache-invalidation watch was established successfully; pane/thumbnail refresh watches stay non-recursive to avoid overlapping subtree fan-out. Because recursive cache roots can overlap, removing one registration must rebuild all surviving registrations and advance their cache epochs; notify's Linux backend can otherwise silently remove descendant OS watches. Coverage transitions advance only the exact root's epoch before advertising cache coverage—filesystem-change invalidation remains ancestor/descendant-aware—so an in-flight walk from an uncovered gap cannot publish after coverage returns without evicting unchanged overlapping listings. All epoch allocation goes through the same bounded revision tracker, including first-time coverage transitions. Ending the final pane watch must remove the recursive coverage and advance that root's cache epoch because files can change before it is watched again. Unwatched or recursively-uncovered roots always walk fresh, cancelled walks are never published, and publication must retain the pre-walk per-root invalidation revision so a watcher event racing a cold walk cannot resurrect stale entries or an unrelated root's event discard valid work. Detach the captured stream listener before awaiting cancellation IPC, or a late cancellation can remove its replacement (#600, #651).
- Terminal focus gives terminal-hosted applications ownership of every key except the small, availability-aware core-navigation allowlist in `domain/terminal-keys.ts` (Quick Open, Command Palette, previous/next tab, and the configured terminal-toggle chord). Keep the ownership decision shared by `+page.svelte` and `TerminalPanel.svelte`; chord prefixes and suffixes must be checked against the eligible command ID so other chords sharing a prefix stay terminal-owned, and a terminal-owned mismatching suffix must cancel the pending Explorer chord before another key can complete it.
- Shortcut hints in command-owned UI must come from `getCommandShortcut(commandId)`, not hardcoded defaults, so persisted overrides and unbound commands remain consistent with window command dispatch.
- Fixed overlays under root CSS zoom are engine-specific: `fixedFromClient` and `fixedFromRect` divide once only on Chromium; WKWebView uses two divisions, while WebKitGTK's CSS-space rect offsets its second scale. Keep the live Chromium check wired through the context-menu conversion (#493).
- Details header column menus use `fixedMenuPosition` to convert pointer, viewport and rendered menu dimensions through `fixedFromClient`; legacy WebKit scales offsets twice but sizes once. Their synchronous mounted geometry probe selects single/double offset scaling relative to size scaling, supporting newer WebKit alongside native WebKit's legacy model without changing other overlays. Stop the header contextmenu event from bubbling into FileList, or its background menu covers the column controls (#993).
- Zoomed image previews update their `transform` for every pointer move. Keep the compositor hint scoped to `.preview-image.zoomed`, so active panning stays smooth without retaining layers for every ordinary image preview (#635).
- The marquee band is five container-sized layers that only ever change `transform` (`domain/marquee-rect.ts`). Writing `width`/`height` on a band element resizes a composited layer every pointer frame, and WebKitGTK repaints it over every image tile beneath, so drag-selecting in a large picture folder trailed the pointer (#1051). Keep the layers container-sized (the client box, so scale stays about ≤ 1): a 1px base rasterises to a whole device pixel under fractional zoom and paints the band too small while DOM measurements still look right. Tests read the band through `getBoundingClientRect()`, which includes the transform, and sample pixels at 130% zoom.
- Column visibility tests must assert mounted row cells as well as headers: they render independently. Require nonempty rows, then check each column before hiding, while hidden, and after restoring (#993).
- Vertical preview docks retain the persisted preferred height, but their rendered wrapper caps it to the center stack's available height minus a usable file region. Keep that allocation in the shared page layout rather than component-local resize state so zoom and window resizing cannot feed back into saved settings (#699).
- GNOME Wayland native drags consume keyboard events in Mutter. In-app copy intent comes from the source connection's first `wl_keyboard` Enter/Modifiers pair after the grab releases (`native_file_drag/wayland_intent.rs`), frozen by focus serial; querying GTK or tracking DOM keys during the grab is stale. Keep this channel independent of OS action negotiation and retain the result through source completion. Missing restoration cancels the in-app drop rather than guessing a destructive move (#1100).
- Bookmarks have two drop surfaces: a specific `.bookmark-drop-target[data-path]` preserves bookmark identity so files transfer into it but folders pin, while empty `.quick-access` space remains a folder-pinning target. Resolve the row before its containing section so Linux native and macOS/Windows pointer drags agree (#675).
- Bookmark feedback must state the action for the source kind: directory drags always say `Drop to pin`, including a targeted bookmark row; only files on a targeted row say `Move to bookmark`. Resolve that kind from in-memory drag state or the persisted cross-window fallback, matching native drop handling (#675).
- Repository-folder Git badges are rendered directly by `FileIcon.svelte` in every directory view. Keep their compact corner geometry and their `--icon-git-badge` / `--icon-git-badge-glyph` theme overrides together when polishing the SVG (#601).
- Git-graph fork-point lookup uses exact `refs/heads/` or `refs/remotes/` identities in `git_merge_base`, never the loaded graph topology. Clear history curation before revealing the result (the ordinary branch filter uses ambiguous shorthands), page through the existing query owner, and retire lookup results on user selection/filter/comparison changes or disposal (#1083). Comparison start, cancel, and exit are navigation choices even though they call the detail session directly.
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
- Git-graph tabs remount on activation once evicted from the retained-tab set; their snapshot cache must retain the supported 12-tab load fan-out so switching back can paint cached history instead of starting a new git-log request. External watcher changes evict the snapshot; valid cached remounts skip the redundant graph reload (#505).
- Git-graph fetch, pull, and remote-branch push share one client-ID network-operation lifecycle in `git-graph-refresh.ts`. Per ADR 0006, fetch enumerates `fetch --all`-eligible remotes (respecting `skipFetchAll`/`skipDefaultUpdate`) and updates each one atomically; ordinary remote errors are aggregated after later remotes run, while cancellation stops immediately between remotes. Only the unbounded network phase is killable: pull receives a per-invocation IPC phase channel before starting, then must deliver the transition from atomic fetch to local fast-forward (or fail closed before moving HEAD) so the banner switches to “Finishing Git pull…” and removes the now-ineffective Cancel control while preserving completed-pull undo; remote-delete cancellation reports that the remote may already have applied it (#528).
- User-report images and videos are hosted as public Vercel Blobs before the relay creates
  the GitHub issue. Production therefore needs `BLOB_READ_WRITE_TOKEN` as well
  as `GITHUB_ISSUE_TOKEN`. Keep the raw attachment total at or below 3 MiB so
  its base64 JSON request stays below Vercel's 4.5 MB function-body limit.
  Video reports support MP4/WebM/MOV within the existing 2 MiB/file cap. Clipboard
  attachments use the ordered file snapshot and require one copied video file;
  retain image-data fallback for non-video paths and failed file-list discovery,
  preserving image validation/read errors. Clipboard routing and availability
  share `clipboard/content.rs`; test mixed image/file clipboard owners. Check container
  signatures in frontend draft admission, native submission and the relay, and
  deploy the relay alongside the app. ADR 0029 governs copied-file authority,
  bounded reads, signature limits, public disclosure and upload cleanup/uncertainty.
  See `docs/lessons/1059-report-video-attachments.md`.
  A deployed image-only relay can still reject videos accepted by the app (#1170).
  Preserve the native/relay error message in attachment-failure feedback; the
  error kind alone hides deployment and size-limit failures. A GET/405 health
  check does not prove video support: use the deliberately invalid second
  attachment probe in `docs/lessons/1170-report-relay-video-deployment.md`.
- The root Vitest suite imports the report relay from `website/`; keep its
  `@vercel/blob` runtime and compatible Undici major in the root test-harness
  dev dependencies as well as the independently deployed website package.

## Documentation

- Architecture passes resume from the ledger's `Covered through` commit, not
  the previous pass's merge date. Read PR review findings and residual limits;
  a landed intervention expires its active entry. Rename-aware per-file churn
  needs `git log --follow -- <file>`; aggregate counts can differ (#1219).
- Keep architecture recurrence counts separate from corrections made inside a
  feature PR. Link existing qualification owners (for example DnD #1225) for
  platform-evidence gaps; those gaps alone do not establish a new ownership
  defect or justify a duplicate debt filing (#1251).
- PR bodies are mutable evidence: attribute post-merge integration results to
  the commit/PR that actually changed the code. A test readiness/locator fix
  is not a production ownership recurrence; inspect the producing boundary
  before counting it against an architecture trigger (#1262).
- Audit feature completion at the tested interaction: a native folder-hover
  spring probe plus a successful folder transfer does not prove a drop inside
  the temporary peek. Check linked follow-up issue state/comments too; a
  test-only coverage PR can leave its promised perf medians pending (#1277).
- Recheck closed follow-ups for explicit residuals: #1269 closed while #1283
  retained late-drop layout changes, and #1272's later comment supplied its
  missing medians. Destination capture by path set does not grant internal
  Move authority; inspect that gate before counting a provenance recurrence
  (#1288).
- A closed destination follow-up can remove its old revision policy entirely:
  #1287 routes every ended drop to its capture and excludes external path-set
  borrowing. Check the source-authority gate separately. Likewise #1296 removes
  mini-tile sizing, so earlier Tiles perf medians do not measure its larger
  panels; shared sizing is an intervention already made, not a new extraction
  to file (#1301).
- Closed-tab peek restoration keeps only bounded membership in memory, not
  listing/watch resources or persisted expansion. Pending lazy sessions must
  apply collapse/prune through the same membership policies before activation.
  Count deployed fixes per the ledger's exact paths: explorer at six fixes is
  below its **more than six** trigger, while Tiles contrast/List chrome changes
  outside those paths remain evidence without altering that count (#1319).
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
- Make sure to clean up the worktree after merging. 

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
Multi-step WebKit interaction tests must also wait for an opened modal to become
hidden after Escape before focusing the next surface; otherwise the following
shortcut can correctly be rejected while `hasModalOpen` is still true. Keep
clock-exact debounce coverage in fake-timer domain tests: an E2E runner may stall
between synthetic keystrokes for longer than the debounce and legitimately
start an intermediate query, so contract-level final-query tests should update
the input atomically.
Playwright `page.clock.install()` still advances with real time. Tests that
assert exact elapsed or remaining labels must install a fixed time and pause
after page readiness, then advance only with `runFor()`; otherwise flooring
can turn an expected 20s remaining into 19s without any application defect.
The graph-lineage unit file includes a wall-clock hover budget. Its ordered
Vitest project must finish before ordinary parallel unit transforms, retaining
the unchanged budget and worker overrides; scheduler contention is not graph
execution time. Qualification tests verify actual worker admission ordering.
Native crop oracles measure loaded first-frame pixels and intrinsic preview
dimensions. Use bounded load/error callbacks rather than an unbounded injected
`Image.decode()` promise, retaining exact pixel assertions. The fake external
CLI's test-only timeout must include cold interpreter startup before reaping;
a deadline that kills it before its PID is written cannot prove child cleanup.
Real-watcher timing tests must also wait for the backend watch and frontend
listener to be ready, then acknowledge every filesystem write at the
application-side watcher callback before attributing listing counts to it. A
receipt-count increase alone is insufficient: require its backend observation
time to be at or after that specific write began so an older delayed event
cannot advance the protocol. Recursive (Quick Open) coverage can be mid-rebuild after an
overlapping root is released while still reporting healthy; arm it with
`arm_search_watch_for_test` before taking the revision a write must advance
(#1152).

Anything whose failure mode involves races, watcher timing, git state, or cache staleness needs tier 3 or a Rust temp-repo test in `src-tauri` — a green mock E2E is not evidence for those.

Config autoreload tests must write through the canonical target of any symlinked config file or theme directory; watching the link itself does not prove inotify observes the target.

Config-watch retargets must restore every surviving descendant after retiring a
recursive ancestor: notify's inotify backend removes descendant native watches
even if they were separately registered. Apply this restoration only to inotify;
exact-root backends such as Windows retain descendants and re-registering them
can leak native callback owners. Keep obsolete descendant cleanup obligations
until each removal succeeds, including after partial ancestor failures.
Include the permanent config-directory
watch when it is nested under that ancestor, and retain failed restorations for
retry. The Linux contracts in `src-tauri/test_support/config_watch_nested_roots_test.rs`
drive the production handover synchronously before writing canonical targets;
a receipt before ancestor removal can otherwise hide lost coverage (#938,
ADR 0004).
The public integration regression in `src-tauri/tests/config_watch_nested_root_test.rs`
also runs against the real refresh worker. It waits for native ancestor retirement
through `/proc/self/fdinfo`, then uses a first-ever bookmarks callback as an
inotify event-loop barrier before probing the canonical nested settings target.
Keep source-included Rust test filenames ending in `_test.rs` so the publication
gate recognizes them, and retain the public integration test when testing with
the entire implementation file reverted.
Run `bun run test:config-watch` from the repository root to execute both the
watcher ownership contracts and public nested-root/symlink integration tests.
The local harness command file is ignored and may disappear between checkouts;
keep the reproducible test entry point in `package.json`, and configure the local
harness to run it alongside `bun run test`. Frontend Vitest alone does not
exercise the Rust watcher acceptance criteria.
Pending config-watch removals are cleanup obligations, not confirmed coverage.
On a return retarget, complete uncertain cleanup before registering the root
again; otherwise an unregister error after native removal can leave that root
permanently unwatched, or an error before removal can duplicate native owners.
If cleaning the returning root removes the previous plan's descendants, restore
their coverage on registration rollback. The return/failure contracts live in
`src-tauri/test_support/config_watch_cleanup_return_test.rs` (#938, ADR 0004).

The public report relay under `website/api/` uses `GITHUB_ISSUE_TOKEN` only for issue creation. Production spam counters must use the shared REST KV variables `KV_REST_API_URL` and `KV_REST_API_TOKEN`; when Vercel is detected without them the endpoint fails closed. The in-memory counter is intentionally limited to local development and unit tests.

**Repro-first for bug fixes.** Before changing logic, write the test that fails for the reported reason (or demonstrate the failure at the pre-fix commit). Gold standard: the test passes on your branch and fails with the fix reverted. If the buggy logic has no importable seam, extracting the seam is part of the fix — don't settle for verifying a transcribed copy.

**Adversarial verification for high-risk changes.** Concurrency, caching, perf claims, and anything self-graded by its implementer gets a separate verifier (a subagent with no stake in the claims) that tries to _falsify_ each claim — staleness attacks on caches, interleaving attacks on async flows, measured numbers for perf claims — and reports CONFIRMED / PLAUSIBLE / REFUTED per claim. This found real bugs both times it was run; budget for it on any structural change.

**E2E tests assert outcomes**, not existence — a QuickOpen test verifies results appear for a query, not that the modal opened.

Markdown preview content is inserted with `{@html}` in `PreviewPane.svelte`, so its element styles require `:global(...)`; keep heading and link colours on the existing theme variables and verify their computed colours in the browser.
Fullscreen PDF horizontal arrows use `PdfPreview`'s page selection before zoomed pan or sibling navigation. Interactive-target guards belong in its shared key handler: excluding links only from window capture still lets their events bubble into the viewport handler (#1010).
Settings browser tests must target named controls (for example `.color-theme-select`), not `select.first()`: async language-model settings insert earlier selects, changing the positional locator's identity between focus and assertion (#1010).
Markdown frontmatter is parsed in `domain/markdown.ts` before Marked renders the document body. Only non-empty YAML maps made of scalar values or scalar arrays become the preview's properties panel; malformed, empty, or nested metadata falls back to ordinary Markdown rendering.

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

Windows Recycle Bin inventory must read `System.FileName` (`PKEY_FileName`)
from the Shell item. `trash::list()` supplies a `SIGDN_PARENTRELATIVE` display
name, which can omit registered extensions; joining it to the original parent
silently changes the restore destination. Query the enumerated Recycle Bin
namespace item: reopening its parsing path gives a filesystem item whose name
is the physical `$R...` payload. Keep the real Recycle Bin regression
covering ordinary, repeated and absent extensions (#1208, ADR 0019).

Gate a platform-only Rust test module as a whole, including its imports and
helpers. Gating only its test functions can leave unused imports under Windows
`cargo clippy --all-targets -- -D warnings`. The child-env compiler regression
imports the production source; `CHILD_ENV_TEST_TARGET=x86_64-pc-windows-msvc bunx
vitest run tests/child-env-compile.test.ts` checks Windows metadata without a
linker when that Rust standard-library target is installed (#1179).

PTY output and exit notifications come from independent threads. Native tests
that inspect the complete transcript must wait for the output channel to close
as well as for the child exit; an exit notification does not mean the last
output callback has run. Keep those waits bounded and retain terminal cleanup
on assertion failures.
When forcing output delivery to follow exit, gate a test-side forwarding
consumer, never the production PTY reader: read backpressure can prevent the
shell from exiting. Include output larger than the PTY buffer to catch this.
For cwd/lifecycle tests, observe initial shell output before writing input;
startup typeahead has separate regression coverage.
Use private XDG config/data/cache directories for the native library suite:
rename completion consults installed provenance plugins, so an inherited host
profile can change its warning result.

When a bug resists quick diagnosis: search `docs/lessons/` + the frozen `lessons_learnt.md` archive and commit history first, then add targeted logging/instrumentation before another fix attempt. Suite-wide test timeouts (~5 s) under parallel/CPU load are a known flake mode — rerun the failing files in isolation before treating them as regressions.

The unit suite defaults to four workers to bound concurrent cold transforms;
explicit Vitest worker overrides remain available, and perf tests stay serial.
Runner setup gives only the compiler-command suite a ten-second compilation
budget; it asserts exit status, not compiler speed. Existing behavioral test
files remain unchanged and keep their five-second deadlines (#993 PR repair).

For Windows native transfer waits, use one renderer-side observer through
`executeAsync` to correlate the requested operation token or listing mutation.
Retain failure JSON and screenshots under `e2e-tauri/logs/`, capturing the
failing window before inspecting unrelated windows.

Native Git-watch readiness probes read `e2eGitWatches` by `directoryKey`, the
same key published by `api/git.ts`, not by a native `path.join` result. Normalize
on the runner side before `browser.execute`: its serialized callback cannot
reference imported helpers. Windows backslashes otherwise reject a successfully
acknowledged lease (#1254).

A peek without its own directory lease can still refresh through a root
notification: Windows reports child-directory metadata changes to its watched
parent. Native overflow tests must assert a causal root receipt and fresh rows,
not an elapsed interval of staleness. Touch the evicted directory's metadata
explicitly to exercise that ancestor-notification path on Linux too (#1260).

`createWindowTabsManager().dispose()` is asynchronous: await it in test teardown so
explorer directory-listener cleanup settles before Vitest closes the worker (#611).

Video frames in `PreviewPane.svelte` come from `getVideoThumbnailData`, not the
tile component. Keep its asynchronous results guarded by the full preview
revision (path, mtime, and size), because a watcher can update a selected video
without changing its path (#607).
The preview pane requests a 1024px video frame because fullscreen reuses that
same source; tile views keep their independently configured 96–256px requests
and cache keys (#664).

CSV previews must parse the complete bounded read before applying their record
limit: splitting physical lines first corrupts valid quoted newlines. Keep the
CSV branch separate from the existing Markdown/text paths and virtualize its
record rows with `VirtualList` (#666).

The floating update notice uses the shared `modal-card` and `btn` control chrome;
import `components/modal.css` in `UpdateNotice.svelte` so the globally scoped
dialog styles accompany the otherwise standalone notice.

Linux removable-volume discovery combines a single mount-table snapshot with
UDisks2 filesystem objects (`files/linux_volumes.rs`), read from one cached
subscription (`files/linux_volume_monitor.rs`) that pushes `drives-changed`;
never reconnect or refetch per `list_drives` poll. Mount-table drives UDisks never
reports (rclone FUSE, bind and manual mounts) are pushed by the POLLPRI watch on `/proc/self/mountinfo`
(`files/linux_mount_watch.rs`), and GVfs Google Drive mounts by session-bus
MountTracker signals (`files/linux_gvfs_watch.rs`; gvfsd-fuse raises no inotify
events), so the 30 s poll stays a backstop. Only the UDisks monitor reports
`live`; the other sources' pushes omit it (#888). UDisks object identity
(`deviceId`) is separate from `Drive.path`: a null path means unmounted and must
never enter navigation or mounted-root tracking. Mount only on explicit opening, through
`state/drive-opening.ts` and `mount_drive`; discovery itself is read-only.
Decode hex escapes only in `/dev/disk/by-label` aliases, once. UDisks `IdLabel`
and returned mount paths are already decoded, and may contain literal `\x20`.
Keep isolated-bus regression tests on the production adapter; browser IPC
fixtures cannot prove native discovery or mount authorization (#677).

ADR 0025 governs Linux volume mount authority, eligible targets, path validation,
and mount timeout/concurrency behavior. For visual drive evidence, show each
claimed label and lifecycle state: an ordinary spaced label does not prove a
literal `\x20`, and removal alone does not prove post-mount deduplication or
service-unavailable fallback. Keep simulated outage screenshots paired with the
native isolated-D-Bus contract tests. Run the full Cargo format check after
registering a new module; formatting only its implementation misses module-order
changes in `files/mod.rs` (#677 / PR #726).

Git Graph author avatars keep display preference separate from third-party
consent: GitHub noreply addresses may resolve while Gravatar remains opt-in.
Their restart-persistent cache is derived, best-effort state: publication uses
sibling temporary files and rename, interrupted/corrupt entries are discarded,
and every storage or network failure must leave the deterministic row fallback.
Pruning must also exhaust its current candidates and return when deletion fails;
retrying an unchanged byte total after the candidate list empties can panic and
poison the process-wide lookup lock.
See ADR 0026.
Mount `GitAuthorAvatar` only while display is enabled so the off state cannot
start lookups; native responses are bounded, validated data URIs backed by the
disk cache, while the row always owns its deterministic local fallback.
Keep the avatar decoration out of Git Graph's table minimum width: at narrow
sizes it should borrow from the message cell, not widen inline commit details.
Native graph fixtures must wait for the reset view's `.file-list` before their
repository is deleted, because reset navigation completes asynchronously.

- Never size painted layout from a ResizeObserver measurement committed in a later frame: the pane canvas fills its scrollport and split children flex by saved ratio, both in CSS with only `paneMinima` from script; measured `paneViewport.geometry` serves reveal/focus/divider input/ARIA. Files grid width updates still render within ResizeObserver delivery (`flushSync`) (#1061). See `docs/lessons/1061-tile-layout-delivery.md`.

Git Graph PR mutations use `git_pr_action` through `gh` with an explicit selected
GitHub repository and user confirmation. Creation requires an already-pushed
branch and revalidates the displayed HEAD branch before spawning the CLI.
Every confirmation carries its displayed repository identity, which the backend
rechecks against the selected remote. A successful merge command means “merge
requested”: GitHub may enqueue it, so only refreshed badges reflect closure. PR
mutations do not delete or update local branches and have no local undo receipt.
Badge-cache revisions reject pre-mutation cache fills, including uncertain CLI
failures; the mounted PR session refreshes badges and keeps duplicate submissions
blocked through that refresh. Browser screenshots simulate GitHub, while isolated
Rust subprocess fixtures cover the production argv/cwd and CLI error boundary.
See ADR 0005 and ADR 0006.

GitHub PR mutations (#1082): keep `--repo github.com/owner/name` explicit. Pending work belongs to `git-pr-mutations.svelte.ts`, not a mounted graph session; Rust admission spans windows/worktrees of the same target. After gh starts, a failure may follow remote acceptance: invalidate badges, retain the uncertain warning, and require an explicit GitHub check before retrying (ADR 0006).

The unchanged 5,001-activation registry churn file runs in the first Vitest
project group, followed by the unchanged native-suite compiler check, then
parallel unit files. Keep the projects exhaustive and
non-overlapping; inherited include arrays concatenate, so define each project's
include explicitly instead of inheriting the unit glob. Keep existing test
assertions, deadlines and CLI worker overrides intact. Use positive group orders:
Vitest puts isolated order-zero projects last with `maxWorkers=1`. Verify actual
worker admission as well as resolved config (#1082).

Graph reference disclosures capture the scroller's actual position when opened.
A native scroll notification can arrive after the click for positioning that
already happened. Compare positions rather than dismissing on every delivery;
inherit the snapshot into scoped actions and focus with preventScroll. Subsequent
vertical or horizontal movement still dismisses the anchored menu (#1082).

The native suite's public TypeScript command uses incremental compiler metadata
under node_modules/.cache. Repeated typechecks must still validate changed imported
contracts and recover after errors; do not alter the existing five-second test
deadline to compensate for host load. Metadata is disposable, not acceptance proof.

The new native cache contract probe also runs before parallel unit transforms, in its own ordered project after the unchanged public compiler check. Preserve exhaustive selection and worker overrides.

Compiler regression probes resolve TypeScript's CLI through Node package
resolution from the test module. Review checkouts may inherit dependencies from
an ancestor; a checkout-relative node_modules/typescript path is not portable.
Keep the real compiler and every cold/warm/error/recovery assertion intact.

### Details image metadata (#994)

Resolution uses `files::image_resolution::get_image_resolution`, a header-only
read for PNG/JPEG/GIF/WebP/BMP (4 shared native slots, at most 1 MiB of input).
Do not derive it from thumbnail dimensions or add it to eager directory scans.
Virtualized cells own cancellable requests through `state/image-resolution.ts`.
Directory reconciliation can retain entry identity when byte count and mtime are
unchanged, so metadata must also invalidate through shared directory-change and
local-mutation events. Header context-menu events must stop propagation to avoid
opening the pane's file menu over the column menu.
Details rows reveal their outer edge only on visible keyboard entry from outside
the row grid. Native Tab focus can scroll clipping ancestors and hide the file
identity at high zoom; aligning the outer edge also preserves its leading ring.
Pointer selection and cursor moves within the grid must retain the user's
horizontal column position and FileList's preventScroll ownership (ADR 0015).
Do not relax the icon viewport, focus-ring or horizontal-scroll assertions.

A virtual cursor jump can unmount the old focused row before FileList focuses
its replacement. A null relatedTarget is not proof of external keyboard entry;
keep its preventScroll behavior and require a known external focus origin for
the native Tab reveal. Cover scrolled Ctrl+End/Home as well as mounted arrows.

Details Length and Resolution are independent keyed columns. Keep header, row,
width projection and saved visibility defaults in the same order; tests compare
the complete defaults and verify that resizing or hiding one preserves the other.

### About command (#755)

The About surface uses the existing `AppInfo` contract and `getAppInfo()` bridge
(`get_app_info` returns the packaged Rust version). Keep this optional dialog
lazy-loaded through `WindowDialogs.svelte`, with modal ownership provided by
`Modal.svelte`; do not read package.json for the running application version.
The store must include About in `hasModalOpen` and `closeAll`, including while
its lazy import is pending. Add the flag to `anyModalOpen` and
`closeUnmountedDialogs` so pane input blocking and mounted close guards share
the same lifecycle. The command declares window scope for destination admission.
Browser evidence for this surface must finish CSS
animations (`page.screenshot({ animations: "disabled", ... })`): a visible DOM
assertion can succeed on the first transparent frame of the shared modal fade.

File clipboard writes are accepted by the process-wide Rust worker. Publish
its revision invalidation from the accepted native job too: the originating
renderer can close before its IPC response and otherwise leave surviving
windows with stale clipboard state. Controlled ordering tests belong around
`spawn_worker`'s backend, not only a serialized frontend mock. Native hook builds
can hold a write with a hidden `.<filename>.clipboard-hold` sidecar (30-second
failure guard); `.queued` and `.started` sidecars acknowledge native progress.

PR native smoke checks stay Linux-only. New native specs are discovered by the
full WDIO glob on dev-push Windows runs; the scoped `clipboard` dispatch selects
only `context-clipboard.spec.ts`, so it does not qualify every clipboard spec.

Quick Open cancellation must reach recursive watch admission, not only the tree
walk. Keep pending recursive demand tied to each search flag; a cancelled waiter
can leave before an uninterruptible native registration returns. The recursive
worker reconciles both cancellation and final pane-release identities before
recovery, and batches obsolete overlapping roots into one removal so they cannot
rebuild one another. Successful cache coverage remains pane-owned. Test this
through the real streaming command as well as the injected native watcher seam
(#1007, ADR 0013 and ADR 0014).

Recursive recovery must also check live demand before each individual root's
native registration: checking only around a multi-root recovery lets a blocked
first root hide cancellation of later roots. Preserve the captured demand
identity so final release/reacquisition cannot revive an obsolete operation.

Independent Windows native clipboard probes must await PowerShell asynchronously.
The first shell/module launch can exhaust a ten-second subprocess budget; include
startup in the bounded probe budget and preserve scalar code/signal/stdout/stderr
on failure. Node synchronous spawn errors can self-reference through `error`,
and WDIO's own-property JSON serialization then hides the original timeout.
Keep these probes independent of application IPC and never retry a failed
clipboard observation (#1188).

Windows PowerShell 5.1 emits a `ConvertFrom-Json` array as one pipeline object.
Assign it directly to `[string[]]`; wrapping it in `@(...)` nests the array and
casts empty/multiple file paths into one invalid clipboard path (#1202).

The #1194 smoke artifact reached the PowerShell-ready marker, then stalled in
`Get-Clipboard -Format FileDropList` for the full 30-second budget. Read eager
Windows file lists through `e2e-tauri/windows-clipboard-read.ps1` instead: it
opens CF_HDROP directly, enumerates UTF-16 paths with DragQueryFileW and closes
the clipboard in finally. Keep the independent native empty/single/multi-path
oracle in `clipboard-cross-window.spec.ts`; mocked subprocess output cannot
qualify the Win32 adapter. Do not extend the timeout or retry an observation.

Tiles Folder Peek motion probes must control both rAF and `performance.now()`
through Playwright's clock. Six wall-clock frames can outlast the entire 150ms
motion on loaded WebKit runners. Install before navigation, pause after initial
layout settles, then advance the clock while the page-side sampler is pending;
retain the intermediate-height, inert-ghost and reduced-motion assertions (#1275).

Spring peek state becomes observable before its List card finishes opening.
Synthetic drag probes that target row edges must await populated rows and the
end of live List motion before reading hit-test coordinates; a bounding box
can include pixels still clipped by the opening card (#1292).

List peek lineage includes the card's outer folder as well as nested groups.
Geometry assertions must select the guide for the intended depth; the first
`.list-guide` now belongs to the card root. Scroll nested children into the card's
viewport before capturing lineage evidence (#1330).

# Session Handover — as of 2026-07-11

Continuing work on tauri-explorer — v1.2.0 is released; ready for the next round of features.

**Previous session summary:** Shipped 5 issues (#268–#272): active-tab hairline now ends at the fillet tangent (one continuous stroke), drag ghosts are translucent (0.6) for ALL drags (single + multi), SCM row actions use uniform SVG icons with a visible hover pill, the SCM panel got a per-repo summary cache + loading skeleton, and the git graph became **per-pane** (toggles inside the active pane; the `GitGraphTab` kind is retired with full persistence migration). Then released **v1.2.0** (PR #274 → main) and added a user-level `seedvr-upscale` skill (fal.ai SeedVR2 image/video upscaling).

**Key context:**
- `dev` and `main` are pushed and in sync at v1.2.0 (`8ecf9f0 Release v1.2.0`). All issues closed; `new_todo.md` empty; no in-progress branches.
- The "Build & Release" workflow was still building at session end — verify it completed and v1.2.0 assets exist: `gh run list --workflow=release.yml`.
- Pre-release gates were green: full E2E `ALL_VIEW_MODES=1` = 520 passed / 1 flaky (startup-perf timing, passed on retry); 960 unit tests; 0 svelte-check errors.
- **Git graph is no longer a tab kind.** `WindowTab = ExplorerTab` only. Per-pane flag `TabPane.gitGraph?: string` (repo root); toggle via `windowTabsManager.toggleGitGraphInActivePane(repoPath|null)`, read via `getPaneGitGraph(paneId)`; `ExplorerPane` renders `GitGraphView` (keyed by repoPath) when set. The palette command is now "Git: Toggle Commit Graph" (Ctrl+Alt+G) and toggles OFF from within the graph. Old persisted git-graph tabs (v2 strips, v3 tabs, closed-tab snapshots) migrate in `window-tabs-persistence.ts` (`normalizePersistedTab` / `migrateGitGraphTab`).
- **SCM store** (`scm.svelte.ts`): `summaryCache` per repo root — cached summary served instantly on re-activation, refreshed in background; watcher events refetch the active repo and EVICT inactive entries. New `pending` getter drives a shimmer skeleton in `ScmSidebarView`; "Not a git repository" renders only after detection resolves.
- **Mock latency knob** for loading-state E2E/screenshots: `window.__MOCK_LATENCY__ = { git_status: 2000 }`, or boot-time `?mockLatency=git_status:2000` (`mock-invoke.ts`).
- `screenshots/_issue-refs/`, `docs/AI-native-ideas.md`, `docs/code-map/` are intentionally untracked — never `git add -A`; stage paths explicitly (an accidental `git add -A docs` had to be unwound this session).
- `main` is PR-protected: releases go PR `dev`→`main` (`gh pr create` + `gh pr merge`), never a direct push.

**Current state:** Everything merged, pushed, and released (pending workflow completion). Working tree clean except the intentionally-untracked files above.

**Next steps:** Confirm the release workflow finished; then take new feature requests → GitHub issues (with `## Screenshots` checkbox section) → one branch per issue per the CLAUDE.md checklist.

---

## Architecture & Learnings

### Frontend layout (`src/lib/`)
- `domain/` — pure logic, no framework deps. Notable: `zoom.ts` (coordinate conversions under CSS zoom), `keybinding-parser.ts`, `path.ts`, `fuzzy-score.ts`, `pane-layout.ts` (split trees).
- `state/` — Svelte 5 rune stores as singletons from `create*Store()` closures with getter APIs. Deep `$state` proxies make nested mutations reactive (`pane.gitGraph = x` / `delete pane.gitGraph` both work). `window-tabs.svelte.ts` owns tabs → pane layout trees → `TabPane { explorerId, path, gitGraph? }`; pure persistence/migrations live in `window-tabs-persistence.ts` (v1→v2→v3 + git-graph-tab migration).
- Render path: `+page.svelte` → `TitleBar` (`WindowTabBar`) → `PaneContainer` (active tab's `PaneLayoutView` tree) → `ExplorerPane` per leaf (`NavigationBar` + `FileList`, or `GitGraphView` when the pane's `gitGraph` is set; `ScmPanel` in the primary pane when enabled).
- Testing singleton stores: `vi.resetModules()` + dynamic `import()` per test for a fresh instance; `vi.mock` `$lib/api/files` and `$lib/state/git-refresh` (see `tests/state/scm-summary-cache.test.ts`).

### CSS zoom coordinate model (IMPORTANT — recurring bug source)
Standardized CSS zoom (Interop 2024; Chromium ≥128, WebKitGTK ≥2.44): `clientX/Y` **and** `getBoundingClientRect()` are both post-zoom viewport px on EVERY engine. All converters in `domain/zoom.ts` are single-division and engine-independent. The legacy "WebKitGTK reports pre-zoom rects" model is DEAD — an engine branch on zoom coordinates is a bug. When touching `domain/zoom.ts`, run `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true WEBKIT=1 npx playwright test e2e/zoom-positioning.spec.ts --project=webkit`.
Also: `position: fixed; width: 100vw` does NOT cover the visible viewport under root zoom — cancel with `zoom: calc(1 / var(--app-zoom, 1))`.

### Theming (recurring bug source)
Tokens live in `src/lib/themes/*.css` (`dark.css` is the reference list). There is NO `--background`, `--background-secondary`, `--border-color`, or `--accent-color` — grep before using a token. Idioms: controls `--control-fill`/`--control-stroke`, subtle chips `--subtle-fill-tertiary`, cards `--background-card`, accents `--accent`/`--text-on-accent`. Never write light-hex fallbacks like `var(--foo, #f5f5f5)` — they silently paint white on dark themes.

### Tab bar (`WindowTabBar.svelte`)
- `.tab-area` is `background: transparent` — the titlebar owns the strip surface.
- Active tab fuses to the pane via `.tab-fillet` spans (concave radial-gradients, z-index 3, `--fillet: 14px` inherited from `.tab.active`). The fillet gradients carry a hairline ring; the tab's side hairlines are **background strips sized `calc(100% - var(--fillet))`** (NOT an inset box-shadow) so exactly one stroke exists at every silhouette point — a full-height stroke chords through the flare. `.tab.active:hover` must not redeclare `background` or the strokes vanish.
- Unfocused hover is an inset pill on `::before` (`inset: 4px 2px 3px`) so it can't collide with fillets.

### Drag & drop
- Linux uses HTML5 DnD (`usesHtml5Drag` in `domain/platform.ts`); mac/windows use pointer-drag + `elementFromPoint` highlighting.
- `createDragGhost` (`use-pointer-drag.svelte.ts`) now backs `setDragImage` for ALL drags (multi = fanned stack + count badge; single = icon + name), container opacity 0.6. Native drag images are compositor-drawn — page screenshots can't capture them; clone the ghost element into the DOM to screenshot it.
- dragleave handling is child-aware (relatedTarget containment; coordinate fallback for WebKit's null relatedTarget). Playwright synthetic DnD does NOT validate real browser DnD.

### Icons & a11y in list rows
- Never use text glyphs (`↺ ⊘ + −`) as icon buttons — font metrics differ wildly at the same font-size. Use stroke SVGs; `ScmSidebarView` has a `{#snippet actionIcon(kind)}` pattern.
- Interactive `<li>` rows: flat lists use `role="listbox"`/`option` (+`aria-selected`), trees use `tree`/`group`/`treeitem` (+`aria-expanded` on folders, with Enter/Space keydown) — this clears the `a11y_no_noninteractive_*` warnings properly instead of svelte-ignoring them.

### Testing & verification workflow
- Unit: `bunx vitest run --maxWorkers=2` — full-parallel runs die in the sandboxed agent shell with `Unknown system error -122` (EDQUOT-style exhaustion); the cap avoids it. Single file: `bunx vitest run tests/path/file.test.ts`.
- E2E: `npx playwright test` (Chromium, dev server on 1420); session gate: `ALL_VIEW_MODES=1 npx playwright test`. WebKit project (`WEBKIT=1 … --project=webkit`) is the only thing exercising the real Linux engine — use for coordinate/zoom/drag work.
- rtk truncates/chokes on long playwright output; use `rtk proxy npx playwright test --reporter=line`.
- agent-browser: set `AGENT_BROWSER_SESSION=<name>`; screenshots MUST be repo-relative `screenshots/<branch>/<descriptive-name>.png` (hook enforces; daemon cwd = repo root so relative paths land correctly). After branch switches the running Vite server can serve stale modules — `touch` the changed source files to force re-transform, verify with `curl localhost:1420/src/...`. DOM reads right after `dispatchEvent` in eval are stale (Svelte batches) — assert on the next tick.
- Loading/transient states: use the `__MOCK_LATENCY__` / `?mockLatency=cmd:ms` knob rather than racing screenshots.

### Workflow reminders (hooks enforce these)
- Branch names need a matching open GitHub issue (`fix/<slug>` ↔ title containing the slug words). Tracked files can't be edited on `dev` directly — even docs refreshes need a chore branch + issue.
- Merge hook: `git merge <branch> --no-ff -m …` — branch name FIRST after `merge`; screenshots must be COMMITTED on the feature branch before merging (and each staged screenshot must have been Read); "None required" in the issue's Screenshots section skips the check. All merges need `--no-ff` (a hook rejects `--ff-only` — use `git reset --hard origin/<branch>` to sync local branches).
- Screenshots get their own commit, separate from code.
- Issues auto-close on merge sometimes but not reliably — verify with `gh issue view <n>`, close manually if needed.
- Release: bump `package.json` + `src-tauri/Cargo.toml` + `src-tauri/Cargo.lock` (tauri-explorer entry) + `src-tauri/tauri.conf.json` + `PKGBUILD` (fallback literal), add CHANGELOG entry, merge to dev, then PR dev→main; the release workflow runs on push to main.
